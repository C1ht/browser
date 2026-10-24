/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * about:history (Library.sys.mjs does the work). Runs in the browser
 * process with chrome privileges, like Settings.
 */

const { Library } = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const PAGE_SIZE = 200;
const HISTORY_EVENTS = ["page-visited", "page-removed", "history-cleared", "page-title-changed"];

const $ = id => document.getElementById(id);

const HistoryPage = {
  entries: [],
  limit: PAGE_SIZE,

  init() {
    let searchTimer;
    $("search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.limit = PAGE_SIZE;
        this.load();
      }, 150);
    });
    $("history-more").addEventListener("click", () => {
      this.limit += PAGE_SIZE;
      this.load();
    });
    $("clear").addEventListener("click", () => this.openClear());
    $("clear-cancel").addEventListener("click", () => $("clear-dialog").close());
    $("clear-form").addEventListener("submit", e => {
      e.preventDefault();
      this.clear();
    });
    for (let button of document.querySelectorAll("#clear-range button")) {
      button.addEventListener("click", () => {
        for (let b of document.querySelectorAll("#clear-range button")) {
          b.setAttribute("aria-checked", String(b == button));
        }
      });
    }
    $("history-turn-on").addEventListener("click", () => {
      Library.setHistoryEnabled(true);
      this.syncBanner();
    });
    $("history-list").addEventListener("click", e => this.onListClick(e));
    document.addEventListener("click", e => {
      if (!e.target.closest(".menu-wrap")) {
        this.closeMenus();
      }
    });
    document.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        this.closeMenus();
      }
    });

    let pending = false;
    let onChange = () => {
      if (!pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          this.load();
        }, 250);
      }
    };
    PlacesUtils.observers.addListener(HISTORY_EVENTS, onChange);
    let onPref = () => this.syncBanner();
    Services.prefs.addObserver("places.history.enabled", onPref);
    window.addEventListener("unload", () => {
      PlacesUtils.observers.removeListener(HISTORY_EVENTS, onChange);
      Services.prefs.removeObserver("places.history.enabled", onPref);
    });

    // about:history#clear (from Settings) opens the dialog.
    if (location.hash == "#clear") {
      history.replaceState(null, "", location.href.split("#")[0]);
      this.openClear();
    }
    this.syncBanner();
    this.load();
    $("search").focus();
  },

  syncBanner() {
    $("history-off").hidden = Library.historyEnabled;
  },

  async load() {
    let query = $("search").value;
    let entries = await Library.history({ query, limit: this.limit + 1 });
    if (query != $("search").value) {
      return;
    }
    $("history-more").hidden = entries.length <= this.limit;
    this.entries = entries.slice(0, this.limit);
    this.render();
  },

  dayLabel(time) {
    let day = new Date(time);
    day.setHours(0, 0, 0, 0);
    let today = new Date();
    today.setHours(0, 0, 0, 0);
    let days = Math.round((today - day) / 86400000);
    if (days == 0) {
      return { id: "history-today" };
    }
    if (days == 1) {
      return { id: "history-yesterday" };
    }
    let options = { weekday: "long", month: "long", day: "numeric" };
    if (day.getFullYear() != today.getFullYear()) {
      options.year = "numeric";
    }
    return { text: new Intl.DateTimeFormat(undefined, options).format(day) };
  },

  render() {
    let list = $("history-list");
    let groups = [];
    let current = null;
    for (let entry of this.entries) {
      let key = new Date(entry.time).toDateString();
      if (current?.key != key) {
        current = { key, time: entry.time, entries: [] };
        groups.push(current);
      }
      current.entries.push(entry);
    }
    let time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    list.replaceChildren(
      ...groups.map(group => {
        let section = document.createElement("section");
        section.className = "day";
        let heading = document.createElement("h2");
        heading.className = "day-heading";
        let label = this.dayLabel(group.time);
        if (label.id) {
          document.l10n.setAttributes(heading, label.id);
        } else {
          heading.textContent = label.text;
        }
        section.append(heading, ...group.entries.map(entry => this.row(entry, time)));
        return section;
      })
    );
    let empty = $("history-empty");
    empty.hidden = !!this.entries.length;
    if (!this.entries.length) {
      let query = $("search").value.trim();
      document.l10n.setAttributes(empty, query ? "history-no-results" : "history-empty", { query });
    }
  },

  row(entry, time) {
    let row = document.createElement("div");
    row.className = "entry";
    row.dataset.url = entry.url;
    let icon = document.createElement("img");
    icon.className = "entry-icon";
    icon.alt = "";
    icon.src = Library.iconURL(entry.url);
    icon.addEventListener("error", () => (icon.src = "chrome://browser-wip/skin/icons/globe.svg"), { once: true });
    let link = document.createElement("a");
    link.className = "entry-title";
    link.href = entry.url;
    link.textContent = entry.title || entry.url;
    let host = document.createElement("span");
    host.className = "entry-host";
    host.textContent = this.host(entry.url);
    let when = document.createElement("span");
    when.className = "entry-time";
    when.textContent = time.format(new Date(entry.time));
    let wrap = document.createElement("div");
    wrap.className = "menu-wrap";
    let more = document.createElement("button");
    more.className = "entry-more icon-button";
    more.type = "button";
    more.setAttribute("aria-haspopup", "menu");
    document.l10n.setAttributes(more, "history-entry-menu", { title: entry.title || entry.url });
    let dots = document.createElement("img");
    dots.className = "button-icon";
    dots.src = "chrome://browser-wip/skin/icons/more.svg";
    dots.alt = "";
    more.append(dots);
    wrap.append(more);
    row.append(icon, link, host, when, wrap);
    return row;
  },

  host(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  },

  closeMenus() {
    for (let menu of document.querySelectorAll("#history-list .menu")) {
      menu.remove();
    }
  },

  onListClick(event) {
    let row = event.target.closest(".entry");
    if (!row) {
      return;
    }
    let url = row.dataset.url;
    let host = this.host(url);
    if (event.target.closest(".entry-more")) {
      let open = row.querySelector(".menu");
      this.closeMenus();
      if (open) {
        return;
      }
      let menu = document.createElement("div");
      menu.className = "menu";
      menu.setAttribute("role", "menu");
      let item = (l10n, args, action) => {
        let button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.dataset.action = action;
        document.l10n.setAttributes(button, l10n, args);
        menu.append(button);
      };
      item("history-delete-page", null, "page");
      if (host) {
        item("history-delete-site", { host }, "site");
        item("history-more-from-site", { host }, "search");
      }
      row.querySelector(".menu-wrap").append(menu);
      menu.querySelector("button").focus();
      return;
    }
    let action = event.target.closest(".menu button")?.dataset.action;
    if (!action) {
      return;
    }
    this.closeMenus();
    if (action == "page") {
      Library.removePage(url);
    } else if (action == "site") {
      Library.removeSite(host);
    } else if (action == "search") {
      $("search").value = host;
      this.limit = PAGE_SIZE;
      this.load();
    }
  },

  openClear() {
    $("clear-dialog").showModal();
    document.querySelector("#clear-range [aria-checked='true']").focus();
  },

  async clear() {
    let range = document.querySelector("#clear-range [aria-checked='true']").dataset.range;
    $("clear-submit").disabled = true;
    try {
      await Library.clearHistory(range);
    } finally {
      $("clear-submit").disabled = false;
      $("clear-dialog").close();
    }
    this.load();
  },
};

window.addEventListener("DOMContentLoaded", () => HistoryPage.init());
