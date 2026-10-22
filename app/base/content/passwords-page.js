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
    for (let id of ["search-box", "lock", "add"]) {
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
      return;
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

window.addEventListener("DOMContentLoaded", () => Page.init(), { once: true });
