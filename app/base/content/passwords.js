/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * The password manager in the browser window (docs/PASSWORDS.md §7, §11).
 *
 * - The key button in the address field shows on pages with a login form,
 *   and with a dot while a login waits to be saved.
 * - The panel under it saves or updates a login, unlocks, sets up the vault
 *   and lists the site's logins. Unlocking only ever happens there, outside
 *   the page, so a page can't draw a look-alike attached to the toolbar.
 * - The dropdown under a login field offers the site's logins and a strong
 *   password. It is a chrome popup a page can't draw or click; a login is
 *   filled only when one is picked there.
 *
 * Pages reach this through PasswordsParent, one per frame, which takes the
 * frame's origin from its principal. Nothing here trusts a page's word.
 */

const PasswordsLazy = {};
ChromeUtils.defineESModuleGetters(PasswordsLazy, {
  PasswordVault: "resource://gre/modules/browserwip/PasswordVault.sys.mjs",
  PrivacyModes: "resource://gre/modules/browserwip/PrivacyModes.sys.mjs",
});

const PASSWORDS_URL = "about:passwords";
// PasswordVault.sys.mjs announces lock state changes under this topic.
const PASSWORDS_STATE_TOPIC = "browserwip:passwords-state";
// A waiting login is dropped after this many top-level page loads (a sign-in
// usually loads one page; a second means the user has moved on).
const PASSWORDS_PENDING_NAVIGATIONS = 2;

var PasswordsUI = {
  init(window) {
    this.window = window;
    let $ = id => window.document.getElementById(id);
    this.button = $("passwords-button");
    this.panel = $("passwords-panel");
    this.title = $("passwords-title");
    this.text = $("passwords-text");
    this.dropdown = $("passwords-dropdown");
    this.dropdownBody = $("passwords-dropdown-body");
    this.moreMenu = $("passwords-more-menu");
    this.$ = $;
    // browser -> { formSeen, pending }
    this._tabs = new WeakMap();
    this._dropdown = null;
    this._view = null;

    this.button.addEventListener("click", () => this.openPanel());
    this.panel.addEventListener("popuphidden", e => {
      if (e.target == this.panel) {
        this._panelHidden();
      }
    });

    // Save / update
    $("passwords-save-confirm").addEventListener("click", () => this._save());
    $("passwords-save-later").addEventListener("click", () => this._dismissPending());
    $("passwords-save-reveal").addEventListener("click", () => this._toggleCapturedPassword());
    $("passwords-save-more").addEventListener("click", e =>
      this.moreMenu.openPopup(e.currentTarget, "after_start", 0, 4)
    );
    $("passwords-never").addEventListener("command", () => this._never());
    $("passwords-more-manage").addEventListener("command", () => this.openManager());
    $("passwords-saved-undo").addEventListener("click", () => this._undoAutosave());

    // Unlock
    $("passwords-unlock-form").addEventListener("submit", e => {
      e.preventDefault();
      this._unlock();
    });
    $("passwords-unlock-password").addEventListener("input", () => {
      $("passwords-unlock-error").hidden = true;
    });
    $("passwords-forgot").addEventListener("click", () => this.openManager("forgot"));

    // Setup
    $("passwords-setup-form").addEventListener("submit", e => {
      e.preventDefault();
      this._setup();
    });
    $("passwords-setup-cancel").addEventListener("click", () => {
      if (this._pendingFor(gBrowser.selectedBrowser)) {
        this._showView("save");
      } else {
        this.panel.hidePopup();
      }
    });
    for (let id of ["passwords-setup-password", "passwords-setup-confirm"]) {
      $(id).addEventListener("input", () => {
        $("passwords-setup-error").hidden = true;
      });
    }

    // Site and intro
    $("passwords-site-manage").addEventListener("click", () => this.openManager());
    $("passwords-site-lock").addEventListener("click", () => {
      this.panel.hidePopup();
      PasswordsLazy.PasswordVault.lock();
    });
    $("passwords-intro-manage").addEventListener("click", () => this.openManager());
    $("passwords-intro-setup").addEventListener("click", () => this._showView("setup"));

    // Dropdown
    this.dropdown.addEventListener("popuphidden", () => this._dropdownHidden());
    this.dropdownBody.addEventListener("mousemove", e => {
      let row = e.target.closest(".passwords-option");
      if (row && this._dropdown) {
        this._select(this._dropdown.rows.findIndex(r => r.element == row));
      }
    });
    this.dropdownBody.addEventListener("click", e => {
      let row = e.target.closest(".passwords-option");
      let index = this._dropdown?.rows.findIndex(r => r.element == row) ?? -1;
      if (index >= 0) {
        this._activate(index);
      }
    });

    gBrowser.tabContainer.addEventListener("TabSelect", () => {
      this.closeDropdown();
      this.panel.hidePopup();
      this._updateButton();
    });
    gBrowser.tabContainer.addEventListener("TabLocationChange", e => {
      if (!e.detail?.sameDocument) {
        this._navigated(e.target.linkedBrowser);
      }
    });
    gBrowser.tabContainer.addEventListener("TabClose", e => this._forget(e.target.linkedBrowser));

    Services.obs.addObserver(this, PASSWORDS_STATE_TOPIC);
    window.addEventListener("unload", () => Services.obs.removeObserver(this, PASSWORDS_STATE_TOPIC));
  },

  observe(subject, topic, state) {
    if (topic != PASSWORDS_STATE_TOPIC) {
      return;
    }
    if (state == "locked") {
      // Locking wipes every login waiting to be saved (§5.4).
      for (let tab of gBrowser.tabs) {
        let info = this._tabs.get(tab.linkedBrowser);
        if (info) {
          info.pending = null;
        }
      }
      this.closeDropdown();
      if (this._view != "unlock") {
        this.panel.hidePopup();
      }
    }
    this._updateButton();
  },

  // -----------------------------------------------------------------------
  // Per-tab state

  _info(browser) {
    let info = this._tabs.get(browser);
    if (!info) {
      info = { formSeen: false, pending: null };
      this._tabs.set(browser, info);
    }
    return info;
  },

  _pendingFor(browser) {
    return this._tabs.get(browser)?.pending ?? null;
  },

  _navigated(browser) {
    let info = this._tabs.get(browser);
    if (!info) {
      return;
    }
    info.formSeen = false;
    if (info.pending && ++info.pending.navigations >= PASSWORDS_PENDING_NAVIGATIONS) {
      this._dropPending(browser);
    }
    if (this._dropdown?.browser == browser) {
      this.closeDropdown();
    }
    if (browser == gBrowser.selectedBrowser) {
      this._updateButton();
    }
  },

  _forget(browser) {
    this._dropPending(browser);
    this._tabs.delete(browser);
  },

  _dropPending(browser) {
    let info = this._tabs.get(browser);
    if (info?.pending) {
      if (info.pending.captureId) {
        PasswordsLazy.PasswordVault.dropCapture(info.pending.captureId);
      }
      info.pending = null;
    }
    if (browser == gBrowser.selectedBrowser) {
      if (this._view == "save" || this._view == "saved") {
        this.panel.hidePopup();
      }
      this._updateButton();
    }
  },

  _updateButton() {
    let info = this._tabs.get(gBrowser.selectedBrowser);
    let pending = !!info?.pending;
    this.button.hidden = !pending && !info?.formSeen;
    this.button.toggleAttribute("pending", pending);
    this.window.document.l10n.setAttributes(
      this.button,
      pending ? "passwords-button-pending" : "passwords-button"
    );
  },

  // -----------------------------------------------------------------------
  // From PasswordsParent

  /** A frame of `browser` has a login form, on an origin logins are kept for. */
  formSeen(browser) {
    let info = this._info(browser);
    if (!info.formSeen) {
      info.formSeen = true;
      if (browser == gBrowser.selectedBrowser) {
        this._updateButton();
      }
    }
  },

  /**
   * A login was submitted: { origin, username, password, generated }. The
   * password is sealed at once (§7.3); then, depending on the vault: an
   * update or save prompt, nothing (unchanged, or never for this site), or
   * only the dot on the key button (locked).
   */
  async loginSubmitted(browser, actor, { origin, username, password, generated }) {
    let vault = PasswordsLazy.PasswordVault;
    if (!password || !vault.offerToSave) {
      return;
    }
    let captureId;
    try {
      captureId = await vault.capture(password);
    } catch (e) {
      return;
    }
    let pending = {
      captureId,
      origin,
      username: username ?? "",
      host: passwordsHostOf(origin),
      site: vault.siteName(origin),
      entryId: null,
      update: false,
      generated: !!generated,
      autosavedId: null,
      navigations: 0,
    };
    if (vault.state == "unlocked") {
      if (vault.isNever(origin)) {
        vault.dropCapture(captureId);
        return;
      }
      let existing = vault.find(origin, pending.username);
      if (!existing && !pending.username) {
        let exact = vault.match(origin).exact;
        existing = exact.length == 1 ? exact[0] : null;
      }
      if (existing) {
        if (await vault.hasPassword(existing.id, password)) {
          vault.dropCapture(captureId);
          return;
        }
        pending.entryId = existing.id;
        pending.username = existing.username;
        pending.update = true;
      }
    }
    password = null;

    // Standard: a password from our generator is saved without asking, so a
    // new account's password is never lost; Strict and Anonymous ask (§17 Q4).
    if (pending.generated && !pending.update && vault.state == "unlocked" &&
        PasswordsLazy.PrivacyModes.mode == "standard") {
      try {
        pending.autosavedId = await vault.saveLogin({
          origin,
          username: pending.username,
          captureId,
        });
        pending.captureId = null;
      } catch (e) {
        console.error("browser-wip: saving a generated password failed", e.code);
      }
    }

    let info = this._info(browser);
    let previous = info.pending;
    if (previous?.captureId) {
      vault.dropCapture(previous.captureId);
    }
    info.pending = pending;
    if (browser == gBrowser.selectedBrowser) {
      this._updateButton();
      // Locked: no popup, only the dot. Opening the panel offers to unlock
      // and save; that way never-list sites never nag (§7.3).
      if (vault.state != "locked") {
        this.openPanel();
      }
    }
  },

  // -----------------------------------------------------------------------
  // The panel under the key button

  /** Opens the panel for the selected tab, in the view its state calls for. */
  async openPanel() {
    let vault = PasswordsLazy.PasswordVault;
    await vault.init().catch(() => {});
    let browser = gBrowser.selectedBrowser;
    let pending = this._pendingFor(browser);
    this._resume = null;
    if (pending?.autosavedId) {
      this._showView("saved");
    } else if (pending) {
      this._showView(vault.state == "locked" ? "unlock" : "save", { purpose: "save" });
    } else if (vault.state == "locked") {
      this._showView("unlock", { purpose: "general" });
    } else if (vault.state == "none") {
      this._showView("intro");
    } else {
      this._showView("site");
    }
    if (this.panel.state == "closed" || this.panel.state == "hiding") {
      if (this.window.document.fullscreen) {
        // The panel hangs from the address field, which fullscreen hides.
        FullScreen.exitDomFullScreen();
      }
      this.button.setAttribute("open", "true");
      this.panel.openPopup(this.button, "bottomright topright", 0, 4);
    }
  },

  _panelHidden() {
    this.button.removeAttribute("open");
    if (this._view == "saved") {
      // "Login saved · Undo" was only a notice; once closed it's done.
      let info = this._tabs.get(gBrowser.selectedBrowser);
      if (info?.pending?.autosavedId) {
        info.pending = null;
        this._updateButton();
      }
    }
    this._view = null;
    this._clearSecrets();
  },

  _clearSecrets() {
    let $ = this.$;
    $("passwords-unlock-password").value = "";
    $("passwords-setup-password").value = "";
    $("passwords-setup-confirm").value = "";
    this._hideCapturedPassword();
  },

  _setBusy(form, busy) {
    for (let element of form.querySelectorAll("input, button")) {
      element.disabled = busy;
    }
  },

  /** Switches the panel's content; `purpose` says why it unlocks. */
  _showView(view, { purpose } = {}) {
    let $ = this.$;
    let doc = this.window.document;
    let vault = PasswordsLazy.PasswordVault;
    let browser = gBrowser.selectedBrowser;
    let pending = this._pendingFor(browser);
    let host = pending?.host ?? this._siteHost(browser);
    this._view = view;
    this.panel.setAttribute("view", view);
    this.text.hidden = false;

    switch (view) {
      case "save": {
        doc.l10n.setAttributes(
          this.title,
          pending.update ? "passwords-update-title" : "passwords-save-title",
          { site: pending.site }
        );
        doc.l10n.setAttributes(this.text, "passwords-save-where", { host: pending.host });
        let username = $("passwords-save-username");
        username.value = pending.username;
        username.readOnly = pending.update;
        doc.l10n.setAttributes(
          $("passwords-save-confirm"),
          pending.update ? "passwords-update" : "passwords-save"
        );
        $("passwords-never").hidden = vault.state != "unlocked" || pending.update;
        this._hideCapturedPassword();
        break;
      }
      case "saved":
        doc.l10n.setAttributes(this.title, "passwords-saved-title");
        doc.l10n.setAttributes(this.text, "passwords-saved-generated", { host: pending.host });
        break;
      case "unlock": {
        this._unlockPurpose = purpose ?? "general";
        doc.l10n.setAttributes(this.title, "passwords-unlock-title");
        let id = {
          save: "passwords-unlock-to-save",
          fill: "passwords-unlock-to-fill",
          general: "passwords-unlock-general",
        }[this._unlockPurpose];
        doc.l10n.setAttributes(this.text, id, { host });
        doc.l10n.setAttributes($("passwords-locks-after"), "passwords-locks-after", {
          minutes: vault.lockAfterMinutes,
        });
        $("passwords-unlock-error").hidden = true;
        this._setBusy($("passwords-unlock-form"), false);
        doc.l10n.setAttributes($("passwords-unlock-submit"), "passwords-unlock");
        this._focusSoon($("passwords-unlock-password"));
        break;
      }
      case "setup":
        doc.l10n.setAttributes(this.title, "passwords-setup-title");
        doc.l10n.setAttributes(this.text, "passwords-setup-intro");
        $("passwords-setup-error").hidden = true;
        this._setBusy($("passwords-setup-form"), false);
        doc.l10n.setAttributes($("passwords-setup-create"), "passwords-setup-create");
        $("passwords-setup-cancel").hidden = false;
        this._focusSoon($("passwords-setup-password"));
        break;
      case "site":
        this._fillSiteView(browser);
        break;
      case "intro":
        doc.l10n.setAttributes(this.title, "passwords-site-intro-title");
        doc.l10n.setAttributes(this.text, "passwords-site-intro");
        break;
    }
  },

  _focusSoon(element) {
    if (this.panel.state == "open") {
      element.focus();
    } else {
      this.panel.addEventListener("popupshown", () => element.focus(), { once: true });
    }
  },

  _siteOrigin(browser) {
    try {
      return browser.contentPrincipal.originNoSuffix;
    } catch (e) {
      return "";
    }
  },

  _siteHost(browser) {
    return passwordsHostOf(this._siteOrigin(browser));
  },

  _fillSiteView(browser) {
    let doc = this.window.document;
    let vault = PasswordsLazy.PasswordVault;
    let origin = this._siteOrigin(browser);
    doc.l10n.setAttributes(this.title, "passwords-site-title", { site: vault.siteName(origin) });
    let entries = vault.match(origin).exact;
    let list = this.$("passwords-site-list");
    list.replaceChildren();
    this.text.hidden = entries.length > 0;
    doc.l10n.setAttributes(this.text, "passwords-site-none");
    for (let entry of entries) {
      let row = doc.createElement("div");
      row.className = "passwords-site-row";
      row.setAttribute("role", "listitem");
      let text = doc.createElement("div");
      text.className = "passwords-option-text";
      let name = doc.createElement("span");
      name.className = "passwords-option-primary";
      if (entry.username) {
        name.textContent = entry.username;
      } else {
        doc.l10n.setAttributes(name, "passwords-dropdown-no-username");
      }
      let where = doc.createElement("span");
      where.className = "passwords-option-secondary";
      where.textContent = passwordsHostOf(entry.origin);
      text.append(name, where);
      row.append(text);
      if (entry.username) {
        let copy = doc.createElement("button");
        copy.className = "passwords-icon-button";
        doc.l10n.setAttributes(copy, "passwords-copy-username");
        let icon = doc.createElement("img");
        icon.className = "icon";
        icon.src = "chrome://browser-wip/skin/icons/copy.svg";
        icon.alt = "";
        copy.append(icon);
        copy.addEventListener("click", () => {
          vault.copyText(entry.username);
          doc.l10n.setAttributes(copy, "passwords-copied");
        });
        row.append(copy);
      }
      list.append(row);
    }
  },

  async _toggleCapturedPassword() {
    let pending = this._pendingFor(gBrowser.selectedBrowser);
    let secret = this.$("passwords-save-secret");
    if (!pending?.captureId) {
      return;
    }
    if (secret.hasAttribute("revealed")) {
      this._hideCapturedPassword();
      return;
    }
    try {
      // What the user just typed, so showing it needs no master password.
      secret.textContent = await PasswordsLazy.PasswordVault.openCapture(pending.captureId);
    } catch (e) {
      return;
    }
    secret.setAttribute("revealed", "true");
    let reveal = this.$("passwords-save-reveal");
    this.window.document.l10n.setAttributes(reveal, "passwords-hide-password");
    reveal.querySelector("img").src = "chrome://browser-wip/skin/icons/eye-off.svg";
  },

  _hideCapturedPassword() {
    let secret = this.$("passwords-save-secret");
    secret.textContent = "•".repeat(12);
    secret.removeAttribute("revealed");
    let reveal = this.$("passwords-save-reveal");
    this.window.document.l10n.setAttributes(reveal, "passwords-show-password");
    reveal.querySelector("img").src = "chrome://browser-wip/skin/icons/eye.svg";
  },

  async _save() {
    let browser = gBrowser.selectedBrowser;
    let pending = this._pendingFor(browser);
    let vault = PasswordsLazy.PasswordVault;
    if (!pending) {
      this.panel.hidePopup();
      return;
    }
    if (!pending.update) {
      pending.username = this.$("passwords-save-username").value;
    }
    if (vault.state == "none") {
      // The first Save sets the vault up; the login stays sealed meanwhile.
      this._showView("setup");
      return;
    }
    if (vault.state == "locked") {
      this._showView("unlock", { purpose: "save" });
      return;
    }
    let button = this.$("passwords-save-confirm");
    button.disabled = true;
    try {
      // Saving under an existing origin and username updates that entry.
      await vault.saveLogin({ origin: pending.origin, username: pending.username, captureId: pending.captureId });
      pending.captureId = null;
      this._info(browser).pending = null;
      this.panel.hidePopup();
    } catch (e) {
      console.error("browser-wip: saving a login failed", e.code);
    } finally {
      button.disabled = false;
      this._updateButton();
    }
  },

  _dismissPending() {
    this.panel.hidePopup();
    this._dropPending(gBrowser.selectedBrowser);
  },

  async _never() {
    let browser = gBrowser.selectedBrowser;
    let pending = this._pendingFor(browser);
    if (!pending) {
      return;
    }
    await PasswordsLazy.PasswordVault.addNever(pending.origin).catch(() => {});
    this._dismissPending();
  },

  async _undoAutosave() {
    let browser = gBrowser.selectedBrowser;
    let pending = this._pendingFor(browser);
    if (pending?.autosavedId) {
      await PasswordsLazy.PasswordVault.removeEntry(pending.autosavedId).catch(() => {});
    }
    this._dismissPending();
  },

  async _unlock() {
    let $ = this.$;
    let doc = this.window.document;
    let form = $("passwords-unlock-form");
    let field = $("passwords-unlock-password");
    let password = field.value;
    if (!password) {
      return;
    }
    this._setBusy(form, true);
    doc.l10n.setAttributes($("passwords-unlock-submit"), "passwords-unlocking");
    try {
      await PasswordsLazy.PasswordVault.unlock(password);
    } catch (e) {
      this._setBusy(form, false);
      doc.l10n.setAttributes($("passwords-unlock-submit"), "passwords-unlock");
      field.value = "";
      let error = $("passwords-unlock-error");
      doc.l10n.setAttributes(error, e.code == "wrong-password" ? "passwords-wrong-password" : "passwords-error");
      error.hidden = false;
      field.focus();
      return;
    }
    field.value = "";
    this._setBusy(form, false);
    let purpose = this._unlockPurpose;
    let resume = this._resume;
    this._resume = null;
    if (purpose == "save" && this._pendingFor(gBrowser.selectedBrowser)) {
      // The login was captured while locked: now it can be compared.
      let browser = gBrowser.selectedBrowser;
      let pending = this._pendingFor(browser);
      let vault = PasswordsLazy.PasswordVault;
      if (vault.isNever(pending.origin)) {
        this._dismissPending();
        return;
      }
      let existing = vault.find(pending.origin, pending.username);
      if (existing) {
        pending.entryId = existing.id;
        pending.update = true;
      }
      this._showView("save");
    } else if (purpose == "fill" && resume) {
      this.panel.hidePopup();
      this.openDropdown(resume.browser, resume.actor, resume.request);
    } else {
      this._showView("site");
    }
  },

  async _setup() {
    let $ = this.$;
    let doc = this.window.document;
    let form = $("passwords-setup-form");
    let error = $("passwords-setup-error");
    let password = $("passwords-setup-password").value;
    let confirmation = $("passwords-setup-confirm").value;
    this._setBusy(form, true);
    doc.l10n.setAttributes($("passwords-setup-create"), "passwords-setup-creating");
    try {
      await PasswordsLazy.PasswordVault.setup(password, confirmation);
    } catch (e) {
      this._setBusy(form, false);
      doc.l10n.setAttributes($("passwords-setup-create"), "passwords-setup-create");
      let id = { "too-short": "passwords-too-short", mismatch: "passwords-mismatch" }[e.code] ?? "passwords-error";
      doc.l10n.setAttributes(error, id);
      error.hidden = false;
      (e.code == "mismatch" ? $("passwords-setup-confirm") : $("passwords-setup-password")).focus();
      return;
    }
    $("passwords-setup-password").value = "";
    $("passwords-setup-confirm").value = "";
    this._setBusy(form, false);
    if (this._pendingFor(gBrowser.selectedBrowser)) {
      this._view = "save";
      await this._save();
    } else {
      this._showView("site");
    }
  },

  openManager(section) {
    this.panel.hidePopup();
    this.closeDropdown();
    let url = section ? `${PASSWORDS_URL}#${section}` : PASSWORDS_URL;
    let existing = gBrowser.tabs.find(t => t.linkedBrowser.currentURI?.spec.startsWith(PASSWORDS_URL));
    if (existing) {
      gBrowser.selectTab(existing);
      if (section) {
        existing.linkedBrowser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
    } else {
      gBrowser.addTab(url);
    }
  },

  // -----------------------------------------------------------------------
  // The dropdown under a login field

  /**
   * request: { rect (screen CSS px), kind: "username" | "password" |
   * "new-password", reason: "click" | "key", value (typed username),
   * maxLength, origin, topOrigin, crossOrigin }.
   */
  async openDropdown(browser, actor, request) {
    if (browser != gBrowser.selectedBrowser || this.window.document.fullscreen) {
      return;
    }
    // In a frame from another site, only a click opens it (§7.1.4).
    if (request.crossOrigin && request.reason != "click") {
      return;
    }
    let vault = PasswordsLazy.PasswordVault;
    await vault.init().catch(() => {});
    let doc = this.window.document;
    let rows = [];
    let body = doc.createDocumentFragment();
    let add = (element, action) => {
      body.append(element);
      if (action) {
        rows.push({ element, action });
      }
    };

    if (request.crossOrigin) {
      let header = doc.createElement("div");
      header.className = "passwords-dropdown-header";
      doc.l10n.setAttributes(header, "passwords-dropdown-iframe", {
        host: passwordsHostOf(request.origin),
        top: passwordsHostOf(request.topOrigin),
      });
      add(header);
    }

    if (vault.state == "locked" && request.kind != "new-password") {
      // One row that says nothing about whether this site has logins (§7.2).
      add(
        this._option("key.svg", { l10n: "passwords-dropdown-locked" }, { l10n: "passwords-dropdown-unlock" }),
        () => this._unlockFromDropdown(browser, actor, request)
      );
    } else if (vault.state == "unlocked") {
      let { exact, sameSite } = vault.match(request.origin);
      let typed = request.kind == "username" ? (request.value ?? "").toLowerCase() : "";
      if (typed) {
        exact = exact.filter(e => e.username.toLowerCase().startsWith(typed));
      }
      if (request.kind != "new-password") {
        for (let entry of exact) {
          add(this._entryOption(entry, passwordsHostOf(entry.origin)), () => this._fill(actor, entry.id));
        }
        // Another origin of the same site: click only, never by keyboard
        // alone in a frame, and filling also adds this origin (§17 Q5).
        if (sameSite.length) {
          let byOrigin = Map.groupBy(sameSite, e => e.origin);
          for (let [origin, entries] of byOrigin) {
            if (body.childElementCount) {
              add(this._separator());
            }
            let group = doc.createElement("div");
            group.className = "passwords-group";
            doc.l10n.setAttributes(group, "passwords-dropdown-saved-for", { host: passwordsHostOf(origin) });
            add(group);
            for (let entry of entries) {
              add(
                this._entryOption(entry, null),
                () => this._fillAlso(actor, entry.id, request.origin)
              );
            }
          }
        }
      }
    }

    // A strong password for an empty new-password field (not again once
    // one is there, e.g. in the confirmation field).
    if (request.kind == "new-password" && !request.hasValue) {
      let password = vault.generatePassword({ inputMaxLength: request.maxLength });
      let option = this._option("dice.svg", { l10n: "passwords-dropdown-generate" }, { text: password, mono: true });
      option.classList.add("generator");
      add(option, () => this._fillGenerated(actor, password));
      let note = doc.createElement("div");
      note.className = "passwords-dropdown-note";
      let standard = PasswordsLazy.PrivacyModes.mode == "standard" && vault.state == "unlocked";
      doc.l10n.setAttributes(
        note,
        standard ? "passwords-dropdown-generate-note-standard" : "passwords-dropdown-generate-note-strict"
      );
      add(note);
    }

    if (!rows.length) {
      this.closeDropdown();
      return;
    }
    if (vault.state == "unlocked") {
      add(this._separator());
      let manage = doc.createElement("div");
      manage.className = "passwords-option link";
      manage.setAttribute("role", "option");
      doc.l10n.setAttributes(manage, "passwords-dropdown-manage");
      add(manage, () => this.openManager());
    }

    this.dropdownBody.replaceChildren(body);
    this._dropdown = { browser, actor, request, rows, selected: -1 };
    this._select(request.reason == "key" ? 0 : -1);
    if (this.dropdown.state == "open" || this.dropdown.state == "showing") {
      // Already open under this field (typing narrowed the list).
      return;
    }
    let { left, top, width, height } = request.rect;
    this.dropdownBody.style.minWidth = `${Math.max(Math.round(width), 260)}px`;
    browser.constrainPopup(this.dropdown);
    this.dropdown.openPopupAtScreenRect("after_start", left, top, width, height, false, false);
    actor.dropdownState(true, this._dropdown.selected >= 0);
  },

  _option(icon, primary, secondary) {
    let doc = this.window.document;
    let option = doc.createElement("div");
    option.className = "passwords-option";
    option.setAttribute("role", "option");
    let img = doc.createElement("img");
    img.className = "icon";
    img.src = `chrome://browser-wip/skin/icons/${icon}`;
    img.alt = "";
    let text = doc.createElement("div");
    text.className = "passwords-option-text";
    for (let [part, cls] of [[primary, "passwords-option-primary"], [secondary, "passwords-option-secondary"]]) {
      if (!part) {
        continue;
      }
      let span = doc.createElement("span");
      span.className = cls;
      if (part.mono) {
        span.classList.add("mono");
      }
      if (part.l10n) {
        doc.l10n.setAttributes(span, part.l10n);
      } else {
        span.textContent = part.text;
      }
      text.append(span);
    }
    option.append(img, text);
    return option;
  },

  _entryOption(entry, host) {
    let primary = entry.username ? { text: entry.username } : { l10n: "passwords-dropdown-no-username" };
    let secondary = host ? { text: host } : { l10n: "passwords-dropdown-also-use" };
    return this._option("key.svg", primary, secondary);
  },

  _separator() {
    let separator = this.window.document.createElement("div");
    separator.className = "passwords-separator";
    return separator;
  },

  _select(index) {
    let dropdown = this._dropdown;
    if (!dropdown) {
      return;
    }
    dropdown.rows.forEach((row, i) => {
      row.element.toggleAttribute("selected", i == index);
      row.element.setAttribute("aria-selected", i == index ? "true" : "false");
    });
    if ((dropdown.selected >= 0) != (index >= 0) && this.dropdown.state != "closed") {
      dropdown.actor.dropdownState(true, index >= 0);
    }
    dropdown.selected = index;
  },

  _activate(index) {
    let row = this._dropdown?.rows[index];
    if (row) {
      row.action();
    }
  },

  /** Keys typed in the field while the dropdown is open. */
  dropdownKey(actor, key) {
    let dropdown = this._dropdown;
    if (!dropdown || dropdown.actor != actor) {
      return;
    }
    let count = dropdown.rows.length;
    switch (key) {
      case "ArrowDown":
        this._select((dropdown.selected + 1) % count);
        break;
      case "ArrowUp":
        this._select(dropdown.selected <= 0 ? count - 1 : dropdown.selected - 1);
        break;
      case "Enter":
        if (dropdown.selected >= 0) {
          this._activate(dropdown.selected);
        } else {
          this.closeDropdown();
        }
        break;
      case "Escape":
      case "Tab":
        this.closeDropdown();
        break;
    }
  },

  /** Typing in the username field narrows the list; elsewhere it closes. */
  dropdownInput(actor, value) {
    let dropdown = this._dropdown;
    if (!dropdown || dropdown.actor != actor) {
      return;
    }
    if (dropdown.request.kind != "username") {
      this.closeDropdown();
      return;
    }
    this.openDropdown(dropdown.browser, actor, { ...dropdown.request, value, reason: "key" });
  },

  closeDropdown(actor) {
    if (actor && this._dropdown?.actor != actor) {
      return;
    }
    if (this.dropdown.state != "closed") {
      this.dropdown.hidePopup();
    } else {
      this._dropdownHidden();
    }
  },

  _dropdownHidden() {
    let dropdown = this._dropdown;
    this._dropdown = null;
    this.dropdownBody.replaceChildren();
    if (dropdown) {
      dropdown.actor.dropdownState(false);
    }
  },

  async _fill(actor, entryId) {
    this.closeDropdown();
    try {
      await actor.fill(entryId);
    } catch (e) {
      console.error("browser-wip: filling a login failed", e.code ?? e.name);
    }
  },

  async _fillAlso(actor, entryId, origin) {
    this.closeDropdown();
    try {
      await PasswordsLazy.PasswordVault.addAlso(entryId, origin);
      await actor.fill(entryId);
    } catch (e) {
      console.error("browser-wip: filling a login failed", e.code ?? e.name);
    }
  },

  _fillGenerated(actor, password) {
    this.closeDropdown();
    actor.fillGenerated(password);
  },

  _unlockFromDropdown(browser, actor, request) {
    this.closeDropdown();
    this._resume = { browser, actor, request: { ...request, reason: "click" } };
    this._showView("unlock", { purpose: "fill" });
    if (this.panel.state == "closed") {
      this.button.hidden = false;
      this.button.setAttribute("open", "true");
      this.panel.openPopup(this.button, "bottomright topright", 0, 4);
    }
  },

  /** A frame's actor went away. */
  actorGone(actor) {
    if (this._dropdown?.actor == actor) {
      this.closeDropdown();
    }
    if (this._resume?.actor == actor) {
      this._resume = null;
    }
  },
};

function passwordsHostOf(origin) {
  try {
    return new URL(origin).host;
  } catch (e) {
    return origin ?? "";
  }
}
