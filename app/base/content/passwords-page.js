/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * about:passwords (docs/PASSWORDS.md §11.5). Runs in the browser process
 * with chrome privileges, like Settings, and works on PasswordVault
 * directly. Showing or copying a password needs the master password, then
 * not again for 5 minutes (§17 Q1); a copied password is cleared from the
 * clipboard after 30 s.
 */

const { PasswordVault } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/PasswordVault.sys.mjs"
);
const { displayHost, isFillableOrigin, normalizeOrigin } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/PasswordRules.sys.mjs"
);
const { isVaultFile } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/PasswordTransfer.sys.mjs"
);

const STATE_TOPIC = "browserwip:passwords-state";
const CHANGED_TOPIC = "browserwip:passwords-changed";

const $ = id => document.getElementById(id);

const Page = {
  selectedId: null,
  // null, or { id } while editing an entry ({ id: null } for a new one).
  editing: null,
  // A password shown in the detail view, until the selection changes.
  revealed: null,

  init() {
    $("search").addEventListener("input", () => this.renderList({ keepSelection: true }));
    $("lock").addEventListener("click", () => PasswordVault.lock());
    $("add").addEventListener("click", () => this.edit(null));
    $("list").addEventListener("keydown", e => this._listKey(e));
    $("unlock-form").addEventListener("submit", e => {
      e.preventDefault();
      this.unlock();
    });
    $("setup-form").addEventListener("submit", e => {
      e.preventDefault();
      this.setup();
    });
    $("forgot").addEventListener("click", () => {
      location.hash = "forgot";
    });
    $("forgot-back").addEventListener("click", () => {
      history.replaceState(null, "", location.pathname);
      this.render();
    });
    window.addEventListener("hashchange", () => this.render());

    let onState = () => this.render();
    let onChanged = () => {
      if (!this.editing) {
        this.renderList({ keepSelection: true });
      }
    };
    Services.obs.addObserver(onState, STATE_TOPIC);
    Services.obs.addObserver(onChanged, CHANGED_TOPIC);
    window.addEventListener("unload", () => {
      Services.obs.removeObserver(onState, STATE_TOPIC);
      Services.obs.removeObserver(onChanged, CHANGED_TOPIC);
    });

    PasswordVault.init()
      .catch(() => {})
      .then(() => this.render());
  },

  // -----------------------------------------------------------------------
  // Which screen

  render() {
    let state = PasswordVault.state;
    let unlocked = state == "unlocked";
    $("manager").hidden = !unlocked;
    $("gate").hidden = unlocked;
    for (let id of ["search-box", "lock", "add", "more-wrap"]) {
      $(id).hidden = !unlocked;
    }
    $("status").hidden = state != "unlocked" && state != "locked";
    $("status").toggleAttribute("unlocked", unlocked);
    document.l10n.setAttributes(
      $("status-text"),
      unlocked ? "passwords-status-unlocked" : "passwords-status-locked"
    );

    if (unlocked) {
      this.revealed = null;
      this.renderList({ keepSelection: true });
      // about:passwords#import and #export (from Settings) open the dialog.
      if (location.hash == "#import" || location.hash == "#export") {
        let which = location.hash;
        history.replaceState(null, "", location.pathname);
        if (which == "#import") {
          Transfer.openImport();
        } else {
          Transfer.openExport();
        }
      }
      return;
    }
    for (let dialog of document.querySelectorAll("dialog[open]")) {
      dialog.close();
    }
    this.selectedId = null;
    this.editing = null;
    this.revealed = null;
    let card = state == "none" ? "setup" : location.hash == "#forgot" ? "forgot" : "locked";
    for (let name of ["locked", "setup", "forgot"]) {
      $(`card-${name}`).hidden = name != card;
    }
    if (card == "locked") {
      $("unlock-error").hidden = true;
      $("unlock-password").focus();
    } else if (card == "setup") {
      $("setup-password").focus();
    }
  },

  async unlock() {
    let field = $("unlock-password");
    let error = $("unlock-error");
    if (!field.value) {
      return;
    }
    this._busy($("unlock-form"), true);
    try {
      await PasswordVault.unlock(field.value);
      history.replaceState(null, "", location.pathname);
    } catch (e) {
      document.l10n.setAttributes(error, e.code == "wrong-password" ? "passwords-wrong-password" : "passwords-error");
      error.hidden = false;
      field.select();
    } finally {
      field.value = "";
      this._busy($("unlock-form"), false);
    }
  },

  async setup() {
    let error = $("setup-error");
    this._busy($("setup-form"), true);
    try {
      await PasswordVault.setup($("setup-password").value, $("setup-confirm").value);
      $("setup-password").value = "";
      $("setup-confirm").value = "";
    } catch (e) {
      let id = { "too-short": "passwords-too-short", mismatch: "passwords-mismatch" }[e.code] ?? "passwords-error";
      document.l10n.setAttributes(error, id);
      error.hidden = false;
    } finally {
      this._busy($("setup-form"), false);
    }
  },

  _busy(form, busy) {
    for (let element of form.querySelectorAll("input, button")) {
      element.disabled = busy;
    }
  },

  // -----------------------------------------------------------------------
  // The list

  _matches(entry, query) {
    return !query || displayHost(entry.origin).includes(query) || entry.username.toLowerCase().includes(query);
  },

  renderList({ keepSelection = false } = {}) {
    if (PasswordVault.state != "unlocked") {
      return;
    }
    let all = PasswordVault.entries();
    let query = $("search").value.trim().toLowerCase();
    let shown = all.filter(e => this._matches(e, query));
    document.l10n.setAttributes($("count"), "passwords-count", { count: all.length });

    let list = $("list");
    list.replaceChildren(...shown.map(entry => this._row(entry)));
    let noResults = $("no-results");
    noResults.hidden = !(query && !shown.length);
    if (!noResults.hidden) {
      document.l10n.setAttributes(noResults, "passwords-no-results", { query: $("search").value.trim() });
    }

    if (!keepSelection || !shown.some(e => e.id == this.selectedId)) {
      this.selectedId = shown[0]?.id ?? null;
      this.revealed = null;
    }
    this._markSelected();
    if (!this.editing) {
      this.renderDetail();
    }
  },

  _avatar(origin, size) {
    let avatar = document.createElement("span");
    avatar.className = `avatar ${size}`;
    // The site's initial, as on the mockups: F for accounts.fieldguide.org.
    avatar.textContent = (PasswordVault.siteName(origin)[0] ?? "?").toUpperCase();
    avatar.setAttribute("aria-hidden", "true");
    return avatar;
  },

  _row(entry) {
    let row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "option");
    row.dataset.id = entry.id;
    let text = document.createElement("div");
    text.className = "row-text";
    let host = document.createElement("span");
    host.className = "row-host";
    host.textContent = displayHost(entry.origin);
    let user = document.createElement("span");
    user.className = "row-user";
    if (!isFillableOrigin(entry.origin)) {
      let badge = document.createElement("span");
      badge.className = "badge-warn";
      document.l10n.setAttributes(badge, "passwords-not-secure");
      host.append(" ", badge);
      document.l10n.setAttributes(user, "passwords-wont-fill", { username: entry.username || "—" });
    } else if (entry.username) {
      user.textContent = entry.username;
    } else {
      document.l10n.setAttributes(user, "passwords-no-username");
    }
    text.append(host, user);
    row.append(this._avatar(entry.origin, "small"), text);
    row.addEventListener("click", () => this.select(entry.id));
    return row;
  },

  _markSelected() {
    for (let row of $("list").children) {
      let selected = row.dataset.id == this.selectedId;
      row.toggleAttribute("selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) {
        $("list").setAttribute("aria-activedescendant", row.id || (row.id = `row-${row.dataset.id}`));
      }
    }
  },

  select(id) {
    if (this.editing && !this._leaveEdit()) {
      return;
    }
    this.selectedId = id;
    this.revealed = null;
    this._markSelected();
    this.renderDetail();
  },

  _listKey(event) {
    let rows = [...$("list").children];
    let index = rows.findIndex(r => r.dataset.id == this.selectedId);
    let next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: rows.length - 1 }[event.key];
    if (next === undefined || !rows.length) {
      return;
    }
    event.preventDefault();
    next = Math.max(0, Math.min(rows.length - 1, next));
    this.select(rows[next].dataset.id);
    rows[next].scrollIntoView({ block: "nearest" });
  },

  // -----------------------------------------------------------------------
  // The selected login

  _el(tag, className, l10n, args) {
    let element = document.createElement(tag);
    if (className) {
      element.className = className;
    }
    if (l10n) {
      document.l10n.setAttributes(element, l10n, args);
    }
    return element;
  },

  _button(l10n, onClick, className = "secondary small") {
    let button = this._el("button", className, l10n);
    button.type = "button";
    // What it does, independent of its (asynchronously translated) label.
    button.dataset.action = l10n.replace(/^passwords-/, "");
    button.addEventListener("click", onClick);
    return button;
  },

  _date(ms) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
  },

  renderDetail() {
    let detail = $("detail");
    if (this.editing) {
      this._renderEditor();
      return;
    }
    let entry = this.selectedId && PasswordVault.getEntry(this.selectedId);
    if (!entry) {
      let empty = this._el("div", "empty");
      let all = PasswordVault.entries().length;
      if (!all) {
        empty.append(
          this._el("p", "empty-title", "passwords-empty-title"),
          this._el("p", "muted", "passwords-empty-text")
        );
      }
      detail.replaceChildren(empty);
      return;
    }
    let site = PasswordVault.siteName(entry.origin);

    let head = this._el("div", "detail-head");
    let titles = this._el("div", "detail-titles");
    let title = this._el("h2", "detail-title");
    title.textContent = displayHost(entry.origin);
    let open = this._el("a", "detail-open", "passwords-open-site", { origin: entry.origin });
    open.href = entry.origin;
    open.target = "_blank";
    open.rel = "noopener";
    titles.append(title, open);
    head.append(
      this._avatar(entry.origin, "large"),
      titles,
      this._el("span", "spacer"),
      this._button("passwords-edit", () => this.edit(entry.id)),
      this._button("passwords-delete", () => this._confirmDelete(entry.id))
    );

    let fields = this._el("dl", "fields");
    let field = (labelId, ...content) => {
      let row = this._el("div", "field-row");
      let dd = this._el("dd");
      dd.append(...content);
      row.append(this._el("dt", null, labelId), dd);
      fields.append(row);
      return dd;
    };

    let username = this._el("span", "value");
    if (entry.username) {
      username.textContent = entry.username;
    } else {
      document.l10n.setAttributes(username, "passwords-no-username");
      username.classList.add("muted");
    }
    field(
      "passwords-field-username",
      username,
      ...(entry.username ? [this._copyButton(() => PasswordVault.copyText(entry.username))] : [])
    );

    let secret = this._el("span", "value secret");
    secret.textContent = this.revealed?.id == entry.id ? this.revealed.password : "•".repeat(14);
    secret.toggleAttribute("revealed", this.revealed?.id == entry.id);
    let show = this._button(this.revealed?.id == entry.id ? "passwords-hide" : "passwords-show", () =>
      this._withMaster(async () => {
        if (this.revealed?.id == entry.id) {
          this.revealed = null;
        } else {
          this.revealed = { id: entry.id, password: await PasswordVault.revealPassword(entry.id) };
        }
        this.renderDetail();
      })
    );
    let copy = this._copyButton(() => this._withMaster(() => PasswordVault.copyPassword(entry.id)));
    field("passwords-field-password", secret, show, copy);

    let also = this._el("div", "chips");
    for (let origin of entry.also) {
      let chip = this._el("span", "chip");
      chip.textContent = origin;
      let remove = this._el("button", "chip-remove", "passwords-also-remove", { origin });
      remove.type = "button";
      remove.textContent = "×";
      remove.addEventListener("click", () =>
        PasswordVault.updateEntry(entry.id, { also: entry.also.filter(o => o != origin) })
      );
      chip.append(remove);
      also.append(chip);
    }
    let addAlso = this._button("passwords-also-add", () => this._addAlso(entry, site, alsoDD), "link");
    document.l10n.setAttributes(addAlso, "passwords-also-add", { site });
    let alsoDD = field("passwords-field-also", also, addAlso);
    if (!isFillableOrigin(entry.origin)) {
      alsoDD.append(this._el("p", "muted small", "passwords-site-http"));
    }

    let history = this._el(
      "span",
      "value muted",
      entry.used ? "passwords-history" : "passwords-history-unused",
      {
        created: this._date(entry.created || Date.now()),
        changed: this._date(entry.changed || entry.created || Date.now()),
        used: entry.used ? this._date(entry.used) : "",
      }
    );
    field("passwords-field-history", history);

    let note = this._el("p", "reveal-note");
    let lock = this._el("img", "note-icon");
    lock.src = "chrome://browser-wip/skin/icons/lock-page.svg";
    lock.alt = "";
    note.append(lock, this._el("span", null, "passwords-reveal-note"));

    let inline = this._el("div", "inline-slot");
    inline.id = "inline-slot";
    detail.replaceChildren(head, fields, inline, note);
  },

  _copyButton(action) {
    let button = this._button("passwords-copy", async () => {
      try {
        await action();
      } catch (e) {
        return;
      }
      document.l10n.setAttributes(button, "passwords-copied-short");
      setTimeout(() => document.l10n.setAttributes(button, "passwords-copy"), 1500);
    });
    return button;
  },

  /**
   * Runs `action` once the master password was typed in the last 5
   * minutes; otherwise asks for it first, inline under the login.
   */
  async _withMaster(action) {
    if (PasswordVault.recentlyAuthenticated) {
      try {
        await action();
      } catch (e) {
        if (e.code != "needs-master-password") {
          throw e;
        }
      }
      return;
    }
    let slot = $("inline-slot");
    let form = this._el("form", "inline-form");
    let text = this._el("p", "muted", "passwords-confirm-text");
    let input = this._el("input", "field", "passwords-master-password");
    input.type = "password";
    input.autocomplete = "off";
    let error = this._el("p", "error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    let submit = this._el("button", "primary small", "passwords-confirm");
    submit.type = "submit";
    let cancel = this._button("passwords-cancel", () => slot.replaceChildren());
    let row = this._el("div", "card-row");
    row.append(input, submit, cancel);
    form.append(text, row, error);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      submit.disabled = true;
      try {
        await PasswordVault.confirmMaster(input.value);
      } catch (err) {
        input.value = "";
        document.l10n.setAttributes(error, err.code == "wrong-password" ? "passwords-wrong-password" : "passwords-error");
        error.hidden = false;
        submit.disabled = false;
        input.focus();
        return;
      }
      input.value = "";
      slot.replaceChildren();
      await action();
    });
    slot.replaceChildren(form);
    input.focus();
  },

  _addAlso(entry, site, dd) {
    if (dd.querySelector(".also-form")) {
      return;
    }
    let form = this._el("form", "also-form card-row");
    let input = this._el("input", "field", "passwords-also-placeholder", { site });
    input.type = "url";
    let add = this._el("button", "secondary small", "passwords-also-add-button");
    add.type = "submit";
    let error = this._el("p", "error");
    error.hidden = true;
    form.append(input, add);
    dd.append(form, error);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      let origin = normalizeOrigin(input.value);
      // Only another address of the same site (§7.1.3).
      if (!origin || PasswordVault.siteName(origin) != site) {
        document.l10n.setAttributes(error, "passwords-also-wrong-site", { site });
        error.hidden = false;
        return;
      }
      await PasswordVault.updateEntry(entry.id, { also: [...entry.also, origin] });
    });
    input.focus();
  },

  _confirmDelete(id) {
    let slot = $("inline-slot");
    let box = this._el("div", "confirm-box");
    let text = this._el("p", null, "passwords-delete-confirm");
    let yes = this._button("passwords-delete-yes", async () => {
      await PasswordVault.removeEntry(id);
      this.selectedId = null;
      this.renderList();
    }, "danger small");
    let no = this._button("passwords-cancel", () => slot.replaceChildren());
    let row = this._el("div", "card-row");
    row.append(yes, no);
    box.append(text, row);
    slot.replaceChildren(box);
    yes.focus();
  },

  // -----------------------------------------------------------------------
  // Adding and editing

  edit(id) {
    this.editing = { id };
    this.revealed = null;
    this._renderEditor();
  },

  _leaveEdit() {
    this.editing = null;
    return true;
  },

  _renderEditor() {
    let id = this.editing.id;
    let entry = id ? PasswordVault.getEntry(id) : null;
    let form = this._el("form", "editor");
    form.append(this._el("h2", "detail-title", entry ? "passwords-edit-title" : "passwords-new-title"));

    let labelled = (labelId, input) => {
      let label = this._el("label", "editor-field");
      label.append(this._el("span", null, labelId), input);
      form.append(label);
      return input;
    };
    let site = labelled("passwords-field-site", this._el("input", "field", "passwords-site-placeholder"));
    site.type = "url";
    site.value = entry?.origin ?? "";
    let username = labelled("passwords-field-username", this._el("input", "field"));
    username.value = entry?.username ?? "";
    username.autocomplete = "off";

    let passwordRow = this._el("div", "card-row");
    let password = this._el("input", "field", entry ? "passwords-password-unchanged" : "passwords-password-required");
    password.type = "password";
    password.autocomplete = "new-password";
    let toggle = this._button("passwords-show", () => {
      let shown = password.type == "text";
      password.type = shown ? "password" : "text";
      document.l10n.setAttributes(toggle, shown ? "passwords-show" : "passwords-hide");
    });
    let generate = this._button("passwords-generate", () => {
      password.value = PasswordVault.generatePassword();
      password.type = "text";
      document.l10n.setAttributes(toggle, "passwords-hide");
    });
    passwordRow.append(password, toggle, generate);
    let passwordLabel = this._el("div", "editor-field");
    passwordLabel.append(this._el("span", null, "passwords-field-password"), passwordRow);
    form.append(passwordLabel);

    let error = this._el("p", "error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    let note = this._el("p", "muted small");
    note.hidden = true;
    let buttons = this._el("div", "card-row");
    let save = this._el("button", "primary", "passwords-save-changes");
    save.type = "submit";
    let cancel = this._button("passwords-cancel", () => {
      this.editing = null;
      this.renderDetail();
    }, "secondary");
    buttons.append(save, cancel);
    form.append(error, note, buttons);

    site.addEventListener("input", () => {
      let origin = normalizeOrigin(site.value);
      note.hidden = !origin || isFillableOrigin(origin);
      document.l10n.setAttributes(note, "passwords-site-http");
    });

    form.addEventListener("submit", async e => {
      e.preventDefault();
      let origin = normalizeOrigin(site.value);
      let fail = l10n => {
        document.l10n.setAttributes(error, l10n);
        error.hidden = false;
      };
      if (!origin) {
        fail("passwords-site-invalid");
        return;
      }
      if (!entry && !password.value) {
        fail("passwords-password-missing");
        return;
      }
      let duplicate = PasswordVault.find(origin, username.value);
      if (duplicate && duplicate.id != id) {
        fail("passwords-duplicate");
        return;
      }
      save.disabled = true;
      try {
        if (entry) {
          let changes = { origin, username: username.value };
          if (password.value) {
            changes.password = password.value;
          }
          await PasswordVault.updateEntry(id, changes);
          this.selectedId = id;
        } else {
          this.selectedId = await PasswordVault.saveLogin({
            origin,
            username: username.value,
            password: password.value,
          });
        }
      } catch (err) {
        fail("passwords-error");
        save.disabled = false;
        return;
      }
      password.value = "";
      this.editing = null;
      this.renderList({ keepSelection: true });
    });

    $("detail").replaceChildren(form);
    (entry ? username : site).focus();
  },
};

/**
 * Import and export (docs/PASSWORDS.md §9), from the ⋯ menu in the header
 * or about:passwords#import / #export.
 */
const Transfer = {
  exportFormat: "bwv",
  // Import: "choose", "passphrase", "preview" or "done".
  step: "choose",
  bytes: null,
  plan: null,
  replace: new Set(),

  init() {
    $("more").addEventListener("click", () => this._toggleMenu());
    document.addEventListener("click", e => {
      if (!$("more-wrap").contains(e.target)) {
        this._closeMenu();
      }
    });
    $("more-menu").addEventListener("keydown", e => this._menuKey(e));
    $("menu-import").addEventListener("click", () => {
      this._closeMenu();
      this.openImport();
    });
    $("menu-export").addEventListener("click", () => {
      this._closeMenu();
      this.openExport();
    });
    $("menu-settings").addEventListener("click", () => {
      this._closeMenu();
      window.browsingContext.topChromeWindow?.gBrowser?.addTab("about:settings#passwords");
    });

    for (let button of document.querySelectorAll("#export-format [data-format]")) {
      button.addEventListener("click", () => {
        this.exportFormat = button.dataset.format;
        this._syncExport();
      });
    }
    $("export-understand").addEventListener("change", () => this._syncExport());
    $("export-form").addEventListener("submit", e => {
      e.preventDefault();
      this._export();
    });
    $("export-cancel").addEventListener("click", () => $("export-dialog").close());
    $("export-dialog").addEventListener("close", () => this._clearExport());

    $("import-choose").addEventListener("click", () => this._choose());
    $("import-form").addEventListener("submit", e => {
      e.preventDefault();
      this._importNext();
    });
    $("import-cancel").addEventListener("click", () => $("import-dialog").close());
    $("import-dialog").addEventListener("close", () => this._clearImport());
  },

  // ---- The ⋯ menu ----

  _toggleMenu() {
    let menu = $("more-menu");
    if (menu.hidden) {
      menu.hidden = false;
      $("more").setAttribute("aria-expanded", "true");
      menu.querySelector("button").focus();
    } else {
      this._closeMenu();
    }
  },

  _closeMenu() {
    $("more-menu").hidden = true;
    $("more").setAttribute("aria-expanded", "false");
  },

  _menuKey(event) {
    let items = [...$("more-menu").querySelectorAll("button")];
    let index = items.indexOf(document.activeElement);
    if (event.key == "Escape") {
      this._closeMenu();
      $("more").focus();
    } else if (event.key == "ArrowDown" || event.key == "ArrowUp") {
      event.preventDefault();
      let step = event.key == "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    }
  },

  _message(element, l10n, args) {
    document.l10n.setAttributes(element, l10n, args);
    element.hidden = false;
  },

  _errorId(code) {
    return (
      {
        "wrong-password": "passwords-wrong-password",
        "too-short": "passwords-too-short",
        mismatch: "passwords-mismatch",
        "wrong-passphrase": "passwords-import-wrong-passphrase",
        "bad-file": "passwords-import-bad-file",
        BWV_E_FORMAT: "passwords-import-bad-file",
        BWV_E_OLDER: "passwords-import-bad-file",
        "no-columns": "passwords-import-no-columns",
        BWV_E_NEWER: "passwords-import-newer",
      }[code] ?? "passwords-error"
    );
  },

  async _pickFile(mode, title, ext) {
    let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let [label] = await document.l10n.formatValues([title]);
    picker.init(window.browsingContext, label, mode);
    if (mode == Ci.nsIFilePicker.modeSave) {
      let date = new Date().toISOString().slice(0, 10);
      picker.defaultString = `passwords-${date}.${ext}`;
      picker.defaultExtension = ext;
      picker.appendFilter(ext == "csv" ? "CSV" : "Passwords (.bwv)", `*.${ext}`);
    } else {
      picker.appendFilter("Passwords (.csv, .bwv)", "*.csv; *.bwv");
      picker.appendFilters(Ci.nsIFilePicker.filterAll);
    }
    let result = await new Promise(resolve => picker.open(resolve));
    return result == Ci.nsIFilePicker.returnCancel ? null : picker.file.path;
  },

  // ---- Export ----

  openExport() {
    this.exportFormat = "bwv";
    this._clearExport();
    this._syncExport();
    $("export-dialog").showModal();
    $("export-master").focus();
  },

  _syncExport() {
    let csv = this.exportFormat == "csv";
    for (let button of document.querySelectorAll("#export-format [data-format]")) {
      button.setAttribute("aria-checked", String(button.dataset.format == this.exportFormat));
    }
    $("export-form").toggleAttribute("csv", csv);
    let submit = $("export-submit");
    if (csv) {
      document.l10n.setAttributes(submit, "passwords-export-submit-csv");
    } else {
      document.l10n.setAttributes(submit, "passwords-export-submit", { count: PasswordVault.entries().length });
    }
    submit.disabled = csv && !$("export-understand").checked;
    $("export-error").hidden = true;
  },

  _clearExport() {
    for (let id of ["export-master", "export-passphrase", "export-confirm"]) {
      $(id).value = "";
    }
    $("export-understand").checked = false;
    $("export-error").hidden = true;
    $("export-done").hidden = true;
    $("export-form").removeAttribute("done");
    document.l10n.setAttributes($("export-cancel"), "passwords-cancel");
  },

  async _export() {
    let form = $("export-form");
    let csv = this.exportFormat == "csv";
    let count = PasswordVault.entries().length;
    $("export-error").hidden = true;
    form.setAttribute("busy", "true");
    $("export-submit").disabled = true;
    let data;
    try {
      data = csv
        ? await PasswordVault.exportCSV($("export-master").value)
        : await PasswordVault.exportEncrypted(
            $("export-master").value,
            $("export-passphrase").value,
            $("export-confirm").value
          );
    } catch (e) {
      this._message($("export-error"), this._errorId(e.code));
      form.removeAttribute("busy");
      this._syncExport();
      $("export-error").hidden = false;
      return;
    }
    // Typed on purpose for this one export: not kept in the form.
    for (let id of ["export-master", "export-passphrase", "export-confirm"]) {
      $(id).value = "";
    }
    form.removeAttribute("busy");
    let path = await this._pickFile(Ci.nsIFilePicker.modeSave, "passwords-export-file-title", csv ? "csv" : "bwv");
    if (!path) {
      // Nothing was written.
      data = null;
      this._syncExport();
      return;
    }
    try {
      if (csv) {
        await IOUtils.writeUTF8(path, data);
      } else {
        await IOUtils.write(path, data);
      }
    } catch (e) {
      this._message($("export-error"), "passwords-error");
      this._syncExport();
      return;
    } finally {
      data = null;
    }
    form.setAttribute("done", "true");
    this._message($("export-done"), "passwords-export-done", { count, path });
    document.l10n.setAttributes($("export-cancel"), "passwords-close");
    $("export-cancel").focus();
  },

  // ---- Import ----

  openImport() {
    this._clearImport();
    $("import-dialog").showModal();
    $("import-choose").focus();
  },

  _clearImport() {
    if (this.step == "passphrase" || this.step == "preview") {
      PasswordVault.cancelImport();
    }
    this.step = "choose";
    this.bytes = null;
    this.plan = null;
    this.replace = new Set();
    $("import-file-name").textContent = "";
    $("import-passphrase").value = "";
    $("import-passphrase-row").hidden = true;
    $("import-preview").hidden = true;
    $("import-summary").replaceChildren();
    $("import-duplicates").replaceChildren();
    $("import-error").hidden = true;
    $("import-done").hidden = true;
    $("import-choose").hidden = false;
    $("import-form").removeAttribute("done");
    let submit = $("import-submit");
    submit.hidden = false;
    submit.disabled = true;
    document.l10n.setAttributes(submit, "passwords-import-continue");
    document.l10n.setAttributes($("import-cancel"), "passwords-cancel");
  },

  async _choose() {
    let path = await this._pickFile(Ci.nsIFilePicker.modeOpen, "passwords-import-file-title");
    if (!path) {
      return;
    }
    this._clearImport();
    $("import-file-name").textContent = PathUtils.filename(path);
    try {
      let info = await IOUtils.stat(path);
      if (info.size > 64 * 1024 * 1024) {
        throw new Error("too big");
      }
      this.bytes = await IOUtils.read(path);
    } catch (e) {
      this._message($("import-error"), "passwords-import-bad-file");
      return;
    }
    if (isVaultFile(this.bytes)) {
      this.step = "passphrase";
      $("import-passphrase-row").hidden = false;
      document.l10n.setAttributes($("import-submit"), "passwords-import-open");
      $("import-submit").disabled = false;
      $("import-passphrase").focus();
    } else {
      await this._read();
    }
  },

  async _importNext() {
    if (this.step == "passphrase") {
      await this._read();
    } else if (this.step == "preview") {
      await this._apply();
    } else if (this.step == "done") {
      $("import-dialog").close();
    }
  },

  async _read() {
    let submit = $("import-submit");
    submit.disabled = true;
    $("import-error").hidden = true;
    let result;
    try {
      result = await PasswordVault.readImport(this.bytes, $("import-passphrase").value);
    } catch (e) {
      $("import-passphrase").value = "";
      this._message($("import-error"), this._errorId(e.code));
      submit.disabled = this.step != "passphrase";
      if (this.step == "passphrase") {
        $("import-passphrase").focus();
      }
      return;
    }
    $("import-passphrase").value = "";
    $("import-passphrase-row").hidden = true;
    this.bytes = null;
    if (!result.logins.length) {
      this._message($("import-error"), "passwords-import-empty");
      return;
    }
    this.step = "preview";
    this.plan = PasswordVault.planImport(result.logins);
    this.replace = new Set();
    this._renderPreview(result.skipped);
  },

  _renderPreview(skipped) {
    let plan = this.plan;
    let summary = $("import-summary");
    summary.replaceChildren();
    let line = (l10n, count) => {
      if (count) {
        let item = document.createElement("li");
        document.l10n.setAttributes(item, l10n, { count });
        summary.append(item);
      }
    };
    line("passwords-import-fresh", plan.fresh.length);
    line("passwords-import-insecure", plan.insecure);
    line("passwords-import-skipped", skipped);
    line("passwords-import-repeated", plan.repeated);
    // Last, right above the list it asks about.
    line("passwords-import-duplicates", plan.duplicates.length);

    let list = $("import-duplicates");
    list.replaceChildren();
    for (let duplicate of plan.duplicates) {
      let row = document.createElement("div");
      row.className = "duplicate";
      let text = document.createElement("div");
      text.className = "row-text";
      let host = document.createElement("span");
      host.className = "row-host";
      host.textContent = displayHost(duplicate.existing.origin);
      let user = document.createElement("span");
      user.className = "row-user";
      user.textContent = duplicate.existing.username || "—";
      text.append(host, user);
      let choice = document.createElement("div");
      choice.className = "segmented small";
      choice.setAttribute("role", "radiogroup");
      document.l10n.setAttributes(choice, "passwords-import-choice");
      for (let [value, l10n] of [["mine", "passwords-import-keep-mine"], ["imported", "passwords-import-use-imported"]]) {
        let button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "radio");
        button.dataset.value = value;
        document.l10n.setAttributes(button, l10n);
        button.addEventListener("click", () => {
          if (value == "imported") {
            this.replace.add(duplicate);
          } else {
            this.replace.delete(duplicate);
          }
          for (let b of choice.children) {
            b.setAttribute("aria-checked", String(b == button));
          }
          this._syncImportSubmit();
        });
        button.setAttribute("aria-checked", String(value == "mine"));
        choice.append(button);
      }
      row.append(text, choice);
      list.append(row);
    }
    $("import-preview").hidden = false;
    this._syncImportSubmit();
  },

  _syncImportSubmit() {
    let count = this.plan.fresh.length + this.replace.size;
    let submit = $("import-submit");
    document.l10n.setAttributes(submit, "passwords-import-submit", { count });
    submit.disabled = !count;
  },

  async _apply() {
    let submit = $("import-submit");
    submit.disabled = true;
    $("import-error").hidden = true;
    let count;
    try {
      count = await PasswordVault.applyImport(this.plan, this.replace);
    } catch (e) {
      this._message($("import-error"), this._errorId(e.code));
      this.step = "choose";
      return;
    }
    this.step = "done";
    this.plan = null;
    $("import-preview").hidden = true;
    $("import-choose").hidden = true;
    $("import-form").setAttribute("done", "true");
    this._message($("import-done"), "passwords-import-done", { count });
    submit.hidden = true;
    document.l10n.setAttributes($("import-cancel"), "passwords-close");
    $("import-cancel").focus();
  },
};

window.addEventListener(
  "DOMContentLoaded",
  () => {
    Transfer.init();
    Page.init();
  },
  { once: true }
);
