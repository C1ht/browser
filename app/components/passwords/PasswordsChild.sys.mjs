/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The page side of the password manager (docs/PASSWORDS.md §7), in every
 * https frame.
 *
 * - Finds login fields (Gecko's DOMFormHasPassword and DOMInputPasswordAdded,
 *   grouped into forms by toolkit's LoginFormFactory) and tells the parent
 *   once per document, so the key button shows.
 * - On a trusted click in a login field, or ArrowDown, asks the parent for
 *   the dropdown, with the field's place on screen. While it is open, the
 *   keys that move through it are forwarded instead of acting on the page.
 * - Fills exactly one credential when the parent sends it, after checking
 *   each field it would touch (§7.1.5). Nothing is ever filled on load.
 * - Reports a submitted login: only values the user typed or we filled.
 * - Recognises fields for an authenticator code when they get focus
 *   (autocomplete="one-time-code", or named like one, or a row of one-digit
 *   boxes): they get the dropdown too, which fills the code (§19).
 *
 * The parent decides everything else, from the frame's own principal.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LoginFormFactory: "resource://gre/modules/shared/LoginFormFactory.sys.mjs",
  Logic: "resource://gre/modules/LoginManager.shared.sys.mjs",
});

const FIELD_EVENTS = ["click", "keydown", "input", "blur"];
// What names, ids, placeholders and labels of a code field say.
const CODE_HINT =
  /one[-_ ]?time|\botp\b|totp|\b2fa\b|\bmfa\b|two[-_ ]?(factor|step)|verification[-_ ]?code|security[-_ ]?code|auth(entication|enticator)?[-_ ]?code|passcode/i;
// A field named only this is a code field if it's sized like one.
const CODE_NAMES = new Set(["code", "token", "pin", "otc"]);
const CODE_TYPES = new Set(["text", "tel", "number", "password"]);
const DROPDOWN_KEYS = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"];
// A field this small, or outside the viewport, isn't one the user can see.
const MIN_FIELD_SIZE = 4;

export class PasswordsChild extends JSWindowActorChild {
  #watched = new WeakSet();
  #reported = false;
  #registered = false;
  // The field the dropdown was asked for, and whether it is open.
  #dropdownField = null;
  #dropdownOpen = false;
  // The field's value when the dropdown was asked for: typing before the
  // parent says it is open would otherwise not narrow or close it.
  #requestedValue = "";
  // Whether a row is selected: only then does Enter pick it instead of
  // reaching the page (and submitting the form).
  #dropdownSelected = false;
  // The last login field typed in: a submission without a <form> (a page
  // that signs in by script, then navigates) is read from its fields.
  #lastField = null;
  // Values we put in fields: they count as the user's own on submission.
  #filled = new WeakMap();
  #generated = new WeakMap();
  // The last password reported, so a form seen twice isn't offered twice.
  #reportedValue = new WeakMap();
  // Fields recognised as fields for an authenticator code.
  #codeFields = new WeakSet();

  handleEvent(event) {
    switch (event.type) {
      case "DOMFormHasPassword":
        this.#watch(lazy.LoginFormFactory.createFromForm(event.target));
        break;
      case "DOMInputPasswordAdded":
      case "DOMPossibleUsernameInputAdded":
        this.#watch(lazy.LoginFormFactory.createFromField(event.target));
        break;
      case "form-submission-detected":
        this.#submitted(event.detail?.form ?? null);
        break;
      case "focusin":
        this.#focusin(event);
        break;
      case "pagehide":
        this.#closeDropdown();
        break;
      case "click":
        if (event.isTrusted && event.button == 0) {
          this.#requestDropdown(event.currentTarget, "click");
        }
        break;
      case "keydown":
        this.#keydown(event);
        break;
      case "input":
        this.#input(event);
        break;
      case "blur":
        if (this.#dropdownOpen && this.#dropdownField?.deref() == event.currentTarget) {
          this.#closeDropdown();
        }
        break;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Passwords:Fill":
        return this.#fill(message.data);
      case "Passwords:FillGenerated":
        return this.#fillGenerated(message.data.password);
      case "Passwords:FillCode":
        return this.#fillCode(message.data.code);
      case "Passwords:DropdownState": {
        this.#dropdownOpen = !!message.data.open;
        this.#dropdownSelected = this.#dropdownOpen && !!message.data.selected;
        let field = this.#dropdownField?.deref();
        if (this.#dropdownOpen && field && field.value != this.#requestedValue) {
          this.#input({ currentTarget: field });
        }
        break;
      }
    }
    return undefined;
  }

  #eligible() {
    let principal = this.document?.nodePrincipal;
    return !!principal?.isContentPrincipal && principal.schemeIs("https");
  }

  // The username field and password fields of a form: the username is the
  // nearest username-type field before the first password field (toolkit's
  // heuristic), or, in a form without one, a field marked as a username.
  #fields(form) {
    let elements = [...form.elements].filter(e => HTMLInputElement.isInstance(e) && e.isConnected);
    let passwords = elements.filter(e => e.hasBeenTypePassword);
    let end = passwords.length ? elements.indexOf(passwords[0]) : elements.length;
    let username = null;
    for (let i = end - 1; i >= 0; i--) {
      if (!elements[i].hasBeenTypePassword && lazy.Logic.isUsernameFieldType(elements[i])) {
        username = elements[i];
        break;
      }
    }
    if (!passwords.length && username) {
      let name = username.getAutocompleteInfo()?.fieldName;
      if (name != "username" && name != "email") {
        username = null;
      }
    }
    return { username, passwords };
  }

  #watch(form) {
    if (!form || !this.#eligible()) {
      return;
    }
    let { username, passwords } = this.#fields(form);
    if (!passwords.length && !username) {
      return;
    }
    for (let field of [username, ...passwords]) {
      if (field && !this.#watched.has(field)) {
        this.#watched.add(field);
        for (let type of FIELD_EVENTS) {
          // The system group: a page stopping propagation can't keep the
          // browser's own handling from seeing its fields.
          field.addEventListener(type, this, { mozSystemGroup: true });
        }
      }
    }
    if (!this.#reported) {
      this.#reported = true;
      this.sendAsyncMessage("Passwords:FormSeen", {});
    }
    if (!this.#registered) {
      this.#registered = true;
      try {
        // Also tells us about sign-ins by script that then navigate.
        this.manager.getActor("FormHandler").registerFormSubmissionInterest(this, {
          includesFormRemoval: false,
          includesPageNavigation: true,
        });
      } catch (e) {
        // Without it, ordinary form submissions are still seen.
      }
    }
  }

  // A field for an authenticator code: by its autocomplete token, by what
  // it's called, or one of a row of one-digit boxes.
  #isCodeField(field) {
    if (!HTMLInputElement.isInstance(field) || !CODE_TYPES.has(field.type)) {
      return false;
    }
    if (field.getAutocompleteInfo()?.fieldName == "one-time-code") {
      return true;
    }
    let form = field.form;
    // A login form's own fields are the login's.
    if (form && [...form.elements].some(e => e != field && e.hasBeenTypePassword)) {
      return false;
    }
    if (field.hasBeenTypePassword) {
      return false;
    }
    let names = [field.name, field.id, field.placeholder, field.getAttribute("aria-label"), field.autocomplete]
      .filter(Boolean)
      .join(" ");
    if (CODE_HINT.test(names)) {
      return true;
    }
    let sized = (field.maxLength >= 6 && field.maxLength <= 8) || field.inputMode == "numeric";
    if (sized && (CODE_NAMES.has(field.name.toLowerCase()) || CODE_NAMES.has(field.id.toLowerCase()))) {
      return true;
    }
    return field.maxLength == 1 && this.#digitBoxes(field).length >= 4;
  }

  // A row of one-digit boxes, from the first: the inputs of length 1 in the
  // field's form, or around it.
  #digitBoxes(field) {
    let scope = field.form ?? field.parentElement?.parentElement ?? field.parentElement;
    if (!scope) {
      return [field];
    }
    return [...scope.querySelectorAll("input")].filter(
      e => e.maxLength == 1 && CODE_TYPES.has(e.type) && !e.hasBeenTypePassword && this.#visible(e)
    );
  }

  #focusin(event) {
    let field = event.target;
    if (!event.isTrusted || !this.#eligible() || this.#codeFields.has(field) || !this.#isCodeField(field)) {
      return;
    }
    this.#codeFields.add(field);
    if (!this.#watched.has(field)) {
      this.#watched.add(field);
      for (let type of FIELD_EVENTS) {
        field.addEventListener(type, this, { mozSystemGroup: true });
      }
    }
    if (!this.#reported) {
      this.#reported = true;
      this.sendAsyncMessage("Passwords:FormSeen", {});
    }
    // Focus the user gave it (a click or a key just now), not a page
    // focusing it on load: offer the code at once.
    if (this.contentWindow.navigator.userActivation.isActive) {
      this.#requestDropdown(field, "click");
    }
  }

  #kind(field) {
    if (this.#codeFields.has(field)) {
      return "one-time-code";
    }
    if (!field.hasBeenTypePassword) {
      return "username";
    }
    return lazy.Logic.isProbablyANewPasswordField(field) ? "new-password" : "password";
  }

  #visible(field) {
    if (!field.isConnected || field.disabled || field.readOnly || field.ownerDocument != this.document) {
      return false;
    }
    if (!field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return false;
    }
    let rect = field.getBoundingClientRect();
    let win = this.contentWindow;
    return (
      rect.width >= MIN_FIELD_SIZE &&
      rect.height >= MIN_FIELD_SIZE &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < win.innerHeight &&
      rect.left < win.innerWidth
    );
  }

  #requestDropdown(field, reason) {
    if (!this.#eligible() || !this.#watched.has(field) || !this.#visible(field)) {
      return;
    }
    let kind = this.#kind(field);
    this.#dropdownField = new WeakRef(field);
    this.#requestedValue = field.value;
    let rect = this.contentWindow.windowUtils.getElementBoundingScreenRect(field);
    this.sendAsyncMessage("Passwords:OpenDropdown", {
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      kind,
      reason,
      // What the user typed in a username field, to narrow the list.
      value: kind == "username" ? field.value : "",
      hasValue: !!field.value,
      maxLength: field.maxLength > 0 ? field.maxLength : 0,
    });
  }

  #keydown(event) {
    if (!event.isTrusted) {
      return;
    }
    if (this.#dropdownOpen && this.#dropdownField?.deref() == event.currentTarget) {
      if (event.key == "Enter" && !this.#dropdownSelected) {
        // Nothing picked: Enter is the page's (it may submit the form).
        this.#closeDropdown();
        return;
      }
      if (DROPDOWN_KEYS.includes(event.key)) {
        if (event.key != "Tab") {
          event.preventDefault();
        }
        // The arrows always select a row: known here at once, so an Enter
        // typed right after can't overtake the parent's reply.
        if (event.key == "ArrowDown" || event.key == "ArrowUp") {
          this.#dropdownSelected = true;
        }
        this.sendAsyncMessage("Passwords:Key", { key: event.key });
      }
      return;
    }
    if (event.key == "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      this.#requestDropdown(event.currentTarget, "key");
    }
  }

  #input(event) {
    let field = event.currentTarget;
    this.#lastField = new WeakRef(field);
    if (this.#dropdownOpen && this.#dropdownField?.deref() == field) {
      this.sendAsyncMessage("Passwords:Input", {
        value: field.hasBeenTypePassword ? "" : field.value,
      });
    }
  }

  #closeDropdown() {
    if (this.#dropdownOpen) {
      this.#dropdownOpen = false;
      this.sendAsyncMessage("Passwords:Close", {});
    }
  }

  #set(field, value) {
    field.setUserInput(value);
    this.#filled.set(field, value);
  }

  /** One credential, for the field the dropdown was opened from. */
  #fill({ username, password }) {
    let field = this.#dropdownField?.deref();
    if (!field || !this.#watched.has(field) || field.ownerDocument != this.document) {
      return false;
    }
    let form = lazy.LoginFormFactory.createFromField(field);
    let fields = this.#fields(form);
    let passwordField = field.hasBeenTypePassword
      ? field
      : fields.passwords.find(p => this.#kind(p) == "password") ?? fields.passwords[0];
    let filled = false;
    // A hidden or read-only username field is skipped; the password is
    // still filled (§7.1.5).
    if (fields.username && username && this.#visible(fields.username)) {
      this.#set(fields.username, username);
      filled = true;
    }
    if (passwordField && this.#visible(passwordField)) {
      this.#set(passwordField, password);
      filled = true;
    }
    return filled;
  }

  /** An authenticator code, into its field, or one digit per box of a row. */
  #fillCode(code) {
    let field = this.#dropdownField?.deref();
    if (!field || !this.#codeFields.has(field) || !this.#visible(field) || !/^\d{6,8}$/.test(code)) {
      return false;
    }
    if (field.maxLength == 1) {
      let boxes = this.#digitBoxes(field);
      if (boxes.length >= code.length) {
        boxes.slice(0, code.length).forEach((box, i) => this.#set(box, code[i]));
        return true;
      }
    }
    this.#set(field, code);
    return true;
  }

  /** A generated password, into the new-password field and its confirmation. */
  #fillGenerated(password) {
    let field = this.#dropdownField?.deref();
    if (!field?.hasBeenTypePassword || !this.#visible(field)) {
      return false;
    }
    let form = lazy.LoginFormFactory.createFromField(field);
    let { passwords } = this.#fields(form);
    let start = passwords.indexOf(field);
    let targets = [field];
    // The confirmation: the next empty password field after it.
    let next = passwords[start + 1];
    if (next && !next.value && this.#visible(next)) {
      targets.push(next);
    }
    for (let target of targets) {
      this.#set(target, password);
      this.#generated.set(target, password);
    }
    return true;
  }

  // A value the user typed, or that we filled: anything else (a value the
  // page set) is not taken (§7.3).
  #ownValue(field) {
    if (!field?.value) {
      return null;
    }
    let value = field.value;
    if (field.lastInteractiveValue === value || this.#filled.get(field) === value) {
      return value;
    }
    return null;
  }

  #submitted(form) {
    if (!this.#eligible()) {
      return;
    }
    let formLike = form
      ? lazy.LoginFormFactory.createFromForm(form)
      : this.#lastField?.deref()?.isConnected
        ? lazy.LoginFormFactory.createFromField(this.#lastField.deref())
        : null;
    if (!formLike) {
      return;
    }
    let { username, passwords } = this.#fields(formLike);
    let typed = passwords.filter(p => this.#ownValue(p));
    if (!typed.length) {
      return;
    }
    // With old, new and confirmation fields, the new password is the last.
    let passwordField = typed.at(-1);
    let password = passwordField.value;
    if (this.#reportedValue.get(passwordField) === password) {
      return;
    }
    this.#reportedValue.set(passwordField, password);
    this.sendAsyncMessage("Passwords:Submitted", {
      username: this.#ownValue(username) ?? "",
      password,
      generated: this.#generated.get(passwordField) === password,
    });
  }

  didDestroy() {
    this.#dropdownField = null;
    this.#lastField = null;
  }
}
