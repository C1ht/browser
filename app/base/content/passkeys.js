/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Where a passkey goes, or comes from (components/passkeys/Passkeys.sys.mjs
 * hands requests here): a panel under the site information button.
 *   choose   saving: in the browser, or on a security key; signing in: one
 *            of the browser's passkeys for the site, or a security key
 *   unlock   the vault, to use the browser's passkeys (the system keyring
 *            first, where it's set up)
 *   setup    a master password, to keep the first passkey
 *   verify   the master password again, when the site wants the user
 *            verified and it wasn't typed in the last 5 minutes
 * A security key hands the request to Gecko, whose prompts are webauthn.js.
 * Escape or Cancel refuses. One request at a time, shown with its tab.
 */

ChromeUtils.defineESModuleGetters(this, {
  Passkeys: "resource://gre/modules/browserwip/Passkeys.sys.mjs",
});

var PasskeyPrompts = {
  init() {
    let $ = id => document.getElementById(id);
    this.panel = $("passkey-panel");
    this.title = $("passkey-title");
    this.text = $("passkey-text");
    this.choices = $("passkey-choices");
    this.form = $("passkey-form");
    this.password = $("passkey-password");
    this.confirm = $("passkey-confirm");
    this.submit = $("passkey-submit");
    this.error = $("passkey-error");
    this.cancelButton = $("passkey-cancel");
    this.anchor = $("identity-button");
    // { entry, view, then }: the request shown, and what follows the form.
    this._current = null;

    this.cancelButton.addEventListener("click", () => this._refuse());
    this.panel.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        e.preventDefault();
        this._refuse();
      }
    });
    this.form.addEventListener("submit", e => {
      e.preventDefault();
      this._submit();
    });
    this.panel.addEventListener("popuphidden", () => {
      this.password.value = "";
      this.confirm.value = "";
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._show());
  },

  get _vault() {
    return PasswordsLazy.PasswordVault;
  },

  _host(entry) {
    return entry.details.rpId;
  },

  /** A request to make or use a passkey, from Passkeys.sys.mjs. */
  show(entry) {
    if (this._current && this._current.entry != entry) {
      // The service ends the last one before sending a new one.
      this._current = null;
    }
    this._current = { entry, view: "choose" };
    this._render();
    this._show();
  },

  /** The request ended elsewhere (the page went away, it timed out). */
  ended(entry) {
    if (this._current?.entry == entry) {
      this._current = null;
      this.panel.hidePopup();
    }
  },

  _show() {
    let current = this._current;
    if (!current || current.entry.browser != gBrowser.selectedBrowser) {
      this.panel.hidePopup();
      return;
    }
    if (document.fullscreenElement) {
      FullScreen.exitDomFullScreen();
    }
    if (this.panel.state == "closed" || this.panel.state == "hiding") {
      this.panel.openPopup(this.anchor, "bottomleft topleft", 0, 4);
    }
    setTimeout(() => {
      let first = this.form.hidden ? this.choices.querySelector("button:not([disabled])") : this.password;
      (first ?? this.cancelButton).focus();
    }, 0);
  },

  _render() {
    let { entry, view } = this._current;
    let l10n = document.l10n;
    let host = this._host(entry);
    let create = entry.details.kind == "create";
    this.panel.setAttribute("view", view);
    this.error.hidden = true;
    this.form.hidden = view == "choose";
    this.choices.hidden = view != "choose";
    this.confirm.hidden = view != "setup";
    this.password.value = "";
    this.confirm.value = "";

    if (view == "unlock") {
      l10n.setAttributes(this.title, "passkey-unlock-title");
      l10n.setAttributes(this.text, "passkey-unlock-text", { host });
      l10n.setAttributes(this.submit, "passkey-unlock");
      return;
    }
    if (view == "verify") {
      l10n.setAttributes(this.title, "passkey-verify-title");
      l10n.setAttributes(this.text, "passkey-verify-text", { host });
      l10n.setAttributes(this.submit, "passkey-continue");
      return;
    }
    if (view == "setup") {
      l10n.setAttributes(this.title, "passkey-setup-title");
      l10n.setAttributes(this.text, "passkey-setup-text");
      l10n.setAttributes(this.submit, "passkey-setup-create");
      return;
    }

    // Choosing.
    let account = entry.details.user?.name || entry.details.user?.displayName || "";
    if (create) {
      l10n.setAttributes(this.title, "passkey-create-title", { host });
      l10n.setAttributes(this.text, account ? "passkey-create-account" : "passkey-create-text", { account });
    } else {
      l10n.setAttributes(this.title, "passkey-get-title", { host });
      l10n.setAttributes(this.text, "passkey-get-text");
    }
    let buttons = [];
    if (create) {
      let reason = Passkeys.cannotCreate(entry);
      buttons.push(
        this._choice(
          "passkey.svg",
          { l10n: "passkey-save-here" },
          { l10n: reason ? `passkey-cannot-${reason}` : "passkey-save-here-note", args: { host } },
          () => this._useBrowser(),
          !!reason
        )
      );
    } else if (this._vault.state == "unlocked") {
      let passkeys = Passkeys.candidates(entry);
      for (let passkey of passkeys) {
        buttons.push(
          this._choice(
            "passkey.svg",
            passkey.userName ? { text: passkey.userName } : { l10n: "passkey-no-name" },
            { l10n: "passkey-saved-here" },
            () => this._signWith(passkey.id)
          )
        );
      }
      if (!passkeys.length) {
        l10n.setAttributes(this.text, "passkey-get-none", { host });
      }
    } else {
      buttons.push(
        this._choice("passkey.svg", { l10n: "passkey-use-here" }, { l10n: "passkey-use-here-locked" }, () => this._unlockFirst())
      );
    }
    buttons.push(
      this._choice("key.svg", { l10n: "passkey-security-key" }, { l10n: "passkey-security-key-note" }, () =>
        this._securityKey()
      )
    );
    this.choices.replaceChildren(...buttons);
  },

  _choice(icon, primary, secondary, action, disabled = false) {
    let button = document.createElement("button");
    button.className = "passkey-choice";
    button.disabled = disabled;
    let img = document.createElement("img");
    img.className = "icon";
    img.src = `chrome://browser-wip/skin/icons/${icon}`;
    img.alt = "";
    let text = document.createElement("span");
    text.className = "passkey-choice-text";
    for (let [part, cls] of [[primary, "passkey-choice-primary"], [secondary, "passkey-choice-secondary"]]) {
      let span = document.createElement("span");
      span.className = cls;
      if (part.l10n) {
        document.l10n.setAttributes(span, part.l10n, part.args);
      } else {
        span.textContent = part.text;
      }
      text.append(span);
    }
    button.append(img, text);
    button.addEventListener("click", action);
    return button;
  },

  // To the form view, then `then` once the vault is open (and verified).
  _form(view, then) {
    this._current.view = view;
    this._current.then = then;
    this._render();
    this._show();
  },

  // The vault open, and the user verified if the site wants it; then `then`.
  async _ready(then) {
    let vault = this._vault;
    await vault.init().catch(() => {});
    if (vault.state == "none") {
      this._form("setup", then);
      return;
    }
    if (vault.state == "locked") {
      if (vault.canUnlockWithKeyring) {
        try {
          await vault.unlockWithKeyring();
        } catch (e) {
          // The master password, then.
        }
      }
      if (vault.state == "locked") {
        this._form("unlock", then);
        return;
      }
    }
    if (Passkeys.needsVerification(this._current.entry)) {
      this._form("verify", then);
      return;
    }
    await then();
  },

  async _submit() {
    let current = this._current;
    if (!current) {
      return;
    }
    let vault = this._vault;
    let password = this.password.value;
    this.submit.disabled = true;
    try {
      if (current.view == "setup") {
        await vault.setup(password, this.confirm.value);
      } else if (current.view == "unlock") {
        await vault.unlock(password);
      } else {
        await vault.confirmMaster(password);
      }
    } catch (e) {
      this.submit.disabled = false;
      this.password.value = "";
      let id =
        {
          "wrong-password": "passkey-wrong-password",
          "too-short": "passkey-too-short",
          mismatch: "passkey-mismatch",
        }[e.code] ?? "passkey-error";
      document.l10n.setAttributes(this.error, id);
      this.error.hidden = false;
      this.password.focus();
      return;
    }
    this.submit.disabled = false;
    this.password.value = "";
    this.confirm.value = "";
    if (this._current != current) {
      return;
    }
    // Unlocked: a sign-in shows the passkeys there are now.
    if (current.view == "unlock" && current.entry.details.kind == "get" && current.then == null) {
      current.view = "choose";
      this._render();
      this._show();
      return;
    }
    let then = current.then;
    await (Passkeys.needsVerification(current.entry) ? this._form("verify", then) : then());
  },

  _useBrowser() {
    let current = this._current;
    this._ready(async () => {
      if (Passkeys.cannotCreate(current.entry)) {
        // Only known once unlocked: this account has one here already.
        current.view = "choose";
        this._render();
        return;
      }
      try {
        await Passkeys.create(current.entry);
      } catch (e) {
        console.error("browser-wip: making the passkey failed", e);
        this._failed();
        return;
      }
      this._close(current);
    });
  },

  // Signing in with the vault locked: unlock, then the list of passkeys
  // (the form's then: null).
  async _unlockFirst() {
    let vault = this._vault;
    let current = this._current;
    if (vault.state == "locked" && vault.canUnlockWithKeyring) {
      try {
        await vault.unlockWithKeyring();
      } catch (e) {
        // The master password, then.
      }
    }
    if (this._current != current) {
      return;
    }
    if (vault.state == "unlocked") {
      current.view = "choose";
      this._render();
      this._show();
      return;
    }
    this._form("unlock", null);
  },

  _signWith(passkeyId) {
    let current = this._current;
    this._ready(async () => {
      try {
        await Passkeys.sign(current.entry, passkeyId);
      } catch (e) {
        console.error("browser-wip: signing in with the passkey failed", e);
        this._failed();
        return;
      }
      this._close(current);
    });
  },

  /** A passkey picked in a login field's dropdown (passkey autofill). */
  useFromDropdown(entry, passkeyId) {
    this._current = { entry, view: "choose" };
    this._signWith(passkeyId);
  },

  _securityKey() {
    let current = this._current;
    this._close(current);
    Passkeys.useSecurityKey(current.entry);
  },

  _refuse() {
    let current = this._current;
    if (current) {
      this._close(current);
      Passkeys.refuse(current.entry);
    }
  },

  _failed() {
    document.l10n.setAttributes(this.error, "passkey-error");
    this.error.hidden = false;
  },

  _close(current) {
    if (this._current == current) {
      this._current = null;
      this.panel.hidePopup();
    }
  },
};
