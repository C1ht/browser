/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * The address field. It always describes the selected tab: its URL, whether
 * the connection is secure, how many trackers were blocked, and loading
 * progress. Typing a URL loads it; anything else searches.
 *
 * While typing, a dropdown under it offers: going there or searching (what
 * Enter does), search suggestions (only when turned on), and matching
 * bookmarks and history (Library.sys.mjs).
 */

const UrlbarLibrary = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");

// Search engines that need no account or API key (SearchEngines.sys.mjs).
// The default is a pref (browserwip.search.engine) so Settings can change it.
const SEARCH_ENGINES = UrlbarLibrary.SEARCH_ENGINES;

// Pages whose address is not worth showing: the field stays empty so the
// placeholder invites a search.
const BLANK_PAGES = new Set(["about:blank", "about:newtab", "about:home", "about:welcome"]);

// Typing waits this long before asking for suggestions.
const URLBAR_SUGGEST_DELAY_MS = 120;

function searchURL(terms) {
  return UrlbarLibrary.searchURL(terms);
}

/**
 * Decide whether typed text is an address or a search.
 * Returns { url } or { search }.
 */
function interpretInput(text) {
  text = text.trim();
  if (!text) {
    return null;
  }
  if (/\s/.test(text)) {
    return { search: text };
  }
  // Explicit scheme: "https://…", "about:config", "file:///…".
  let scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  if (scheme == "javascript") {
    // Pasted javascript: URLs are a social-engineering attack (self-XSS);
    // they would run in the page with the browser's authority.
    return null;
  }
  if (scheme && Services.io.getProtocolHandler(scheme).scheme != "default") {
    // "localhost:8080" parses as scheme "localhost"; the default handler
    // means no such protocol, so it falls through to the host check below.
    return { url: text };
  }
  // Host-like: has a dot, a port, a path, or is localhost / an IP literal.
  let hostPart = text.split(/[/?#]/)[0];
  if (
    /^localhost(:\d+)?$/i.test(hostPart) ||
    /^\[[0-9a-f:]+\](:\d+)?$/i.test(hostPart) ||
    (/^[^.:\s]+(\.[^.:\s]+)+\.?(:\d+)?$/.test(hostPart) && !/^\d+(\.\d+)?$/.test(hostPart)) ||
    /^[^:\s]+:\d+$/.test(hostPart) ||
    text.includes("/")
  ) {
    return { url: text };
  }
  return { search: text };
}

class URLBar {
  constructor(window, tabbrowser) {
    this.window = window;
    this.document = window.document;
    this.gBrowser = tabbrowser;
    this.box = this.document.getElementById("urlbar");
    this.input = this.document.getElementById("urlbar-input");
    this.display = this.document.getElementById("urlbar-display");
    this.identityButton = this.document.getElementById("identity-button");
    this.identityIcon = this.document.getElementById("identity-icon");
    this.protectionsButton = this.document.getElementById("protections-button");
    this.protectionsCount = this.document.getElementById("protections-count");
    this.progress = this.document.getElementById("urlbar-progress");

    this.popup = this.document.getElementById("urlbar-popup");
    this.results = this.document.getElementById("urlbar-results");
    this.rows = [];
    this.selectedIndex = -1;
    this._query = 0;

    this.input.addEventListener("focus", this);
    this.input.addEventListener("blur", this);
    this.input.addEventListener("keydown", this);
    this.input.addEventListener("input", this);
    // A click on a row mustn't take focus from the field.
    this.results.addEventListener("mousedown", e => e.preventDefault());
    this.results.addEventListener("click", e => this._onRowClick(e));
    this.results.addEventListener("auxclick", e => this._onRowClick(e));
    this.popup.addEventListener("popuphidden", () => this._clearRows());

    let tabs = this.gBrowser.tabContainer;
    for (let type of ["TabSelect", "TabLocationChange", "TabSecurityChange", "TabAttrModified"]) {
      tabs.addEventListener(type, this);
    }
  }

  get browser() {
    return this.gBrowser.selectedBrowser;
  }

  focusAndSelect() {
    this.input.focus();
    this.input.select();
  }

  // -----------------------------------------------------------------------

  handleEvent(event) {
    switch (event.type) {
      case "focus":
        this.box.setAttribute("focused", "true");
        if (!this.browser?.userTypedValue) {
          // Edit the full URL, not the trimmed display form.
          this.input.value = this._fullURL();
        }
        this.input.select();
        break;
      case "blur":
        this.box.removeAttribute("focused");
        this.closePopup();
        if (!this.browser?.userTypedValue) {
          this.update();
        }
        break;
      case "input":
        if (this.browser) {
          this.browser.userTypedValue = this.input.value;
        }
        this._startQuery();
        break;
      case "keydown":
        this._onKeydown(event);
        break;
      case "TabSelect":
      case "TabLocationChange":
        if (event.type == "TabSelect") {
          this.closePopup();
        }
        if (event.target == this.gBrowser.selectedTab) {
          if (event.type == "TabLocationChange" && !event.detail.sameDocument) {
            this.browser.userTypedValue = null;
          }
          this.update();
        }
        break;
      case "TabSecurityChange":
      case "TabAttrModified":
        if (event.target == this.gBrowser.selectedTab) {
          this.updateState();
        }
        break;
    }
  }

  _onKeydown(event) {
    let open = this.popup.state == "open" || this.popup.state == "showing";
    if (event.key == "Enter") {
      let row = open ? this.rows[this.selectedIndex] : null;
      if (row && row.kind != "heuristic") {
        this._openRow(row, { newTab: event.altKey });
      } else {
        this.go({ newTab: event.altKey });
      }
      event.preventDefault();
    } else if (event.key == "Escape") {
      if (open) {
        // First the dropdown, then what was typed.
        this.closePopup();
      } else {
        if (this.browser) {
          this.browser.userTypedValue = null;
        }
        this.input.value = this._fullURL();
        this.input.select();
      }
      event.preventDefault();
    } else if ((event.key == "ArrowDown" || event.key == "ArrowUp") && !event.altKey && open) {
      this._moveSelection(event.key == "ArrowDown" ? 1 : -1);
      event.preventDefault();
    } else if (event.key == "Delete" && event.shiftKey && open) {
      // Shift+Delete forgets the selected page from history.
      let row = this.rows[this.selectedIndex];
      if (row?.kind == "page" && !row.bookmarked) {
        event.preventDefault();
        UrlbarLibrary.Library.removePage(row.url).then(() => this._startQuery({ now: true }));
      }
    }
  }

  go({ newTab = false } = {}) {
    let target = interpretInput(this.input.value);
    if (!target) {
      return;
    }
    this._load(target.url ?? searchURL(target.search), { newTab });
  }

  _load(url, { newTab = false } = {}) {
    this.closePopup();
    if (newTab) {
      this.gBrowser.addTab(url);
    } else {
      this.browser.userTypedValue = null;
      // Typed navigations count as user-initiated (for HTTPS-First and
      // popup rules).
      this.gBrowser.loadURL(this.browser, url, { userGesture: true });
    }
    this.gBrowser.selectedBrowser.focus();
  }

  // -----------------------------------------------------------------------
  // The dropdown

  closePopup() {
    this._query++;
    this._abort?.abort();
    clearTimeout(this._suggestTimer);
    if (this.popup.state != "closed") {
      this.popup.hidePopup();
    }
  }

  _clearRows() {
    this.rows = [];
    this.selectedIndex = -1;
    this.results.replaceChildren();
    this.input.removeAttribute("aria-activedescendant");
    this.input.setAttribute("aria-expanded", "false");
  }

  /** Recomputes the rows for what is typed now. */
  _startQuery({ now = false } = {}) {
    let text = this.input.value;
    let query = ++this._query;
    this._abort?.abort();
    clearTimeout(this._suggestTimer);
    let target = interpretInput(text);
    if (!target) {
      this.closePopup();
      return;
    }
    let state = { text, target, suggestions: [], matches: [] };
    this._render(state);
    UrlbarLibrary.Library.matches(text)
      .then(matches => {
        if (query == this._query) {
          state.matches = matches;
          this._render(state);
        }
      })
      .catch(console.error);
    // Suggestions only for searches: an address is never sent anywhere.
    if (target.search && this._suggestionsOn()) {
      let abort = (this._abort = new AbortController());
      this._suggestTimer = setTimeout(
        () =>
          UrlbarLibrary.Library.suggestions(text, abort.signal).then(suggestions => {
            if (query == this._query) {
              state.suggestions = suggestions;
              this._render(state);
            }
          }),
        now ? 0 : URLBAR_SUGGEST_DELAY_MS
      );
    }
  }

  _suggestionsOn() {
    return Services.prefs.getBoolPref(UrlbarLibrary.SUGGEST_PREF, false) && !!UrlbarLibrary.currentEngine().suggest;
  }

  /** Whether to offer turning suggestions on: once, for a search, where the engine has them. */
  _offerSuggestions(target) {
    return (
      target.search &&
      !Services.prefs.getBoolPref(UrlbarLibrary.SUGGEST_PREF, false) &&
      !Services.prefs.getBoolPref(UrlbarLibrary.SUGGEST_OFFERED_PREF, false) &&
      !!UrlbarLibrary.currentEngine().suggest
    );
  }

  _render({ text, target, suggestions, matches }) {
    // Keep the selection on the same row (by key) as rows arrive.
    let selectedKey = this.rows[this.selectedIndex]?.key;
    let engine = UrlbarLibrary.currentEngine();
    let rows = [];
    if (target.url) {
      rows.push({ kind: "heuristic", key: "go", url: target.url, l10n: ["urlbar-go", { url: target.url }] });
    } else {
      rows.push({
        kind: "heuristic",
        key: "search",
        search: target.search,
        l10n: ["urlbar-search", { terms: target.search, engine: engine.name }],
      });
    }
    for (let s of suggestions) {
      rows.push({ kind: "suggestion", key: "s:" + s, search: s });
    }
    let typed = target.url?.toLowerCase();
    for (let m of matches) {
      if (typed && m.url.toLowerCase().replace(/\/$/, "").endsWith(typed.replace(/\/$/, ""))) {
        // The page the first row goes to anyway.
        continue;
      }
      rows.push({ kind: "page", key: "p:" + m.url, ...m });
    }
    if (this._offerSuggestions(target)) {
      rows.push({ kind: "offer", key: "offer", engine: engine.name });
    }
    this.rows = rows;
    let index = rows.findIndex(r => r.key == selectedKey);
    this.selectedIndex = index >= 0 ? index : 0;
    // Rows that didn't change keep their element, so their (asynchronously
    // translated) text doesn't blink as suggestions and matches arrive.
    let previous = new Map([...this.results.children].map(el => [el.dataset.signature, el]));
    this.results.replaceChildren(
      ...rows.map((row, i) => {
        let signature = JSON.stringify([row.kind, row.key, row.l10n ?? null, row.title ?? null, row.bookmarked ?? null]);
        let el = previous.get(signature) ?? this._rowElement(row, i);
        previous.delete(signature);
        el.dataset.signature = signature;
        el.dataset.index = i;
        el.id = `urlbar-row-${i}`;
        return el;
      })
    );
    this._markSelected();
    if (this.popup.state == "closed" || this.popup.state == "hiding") {
      let rect = this.box.getBoundingClientRect();
      this.results.style.width = rect.width + "px";
      this.popup.openPopup(this.box, "after_start", 0, 4);
      this.input.setAttribute("aria-expanded", "true");
    }
  }

  _rowElement(row, index) {
    let doc = this.document;
    let el = doc.createElement("div");
    el.className = `urlbar-row ${row.kind}`;
    el.id = `urlbar-row-${index}`;
    el.dataset.index = index;
    el.setAttribute("role", row.kind == "offer" ? "presentation" : "option");
    let icon = doc.createElement("img");
    icon.className = "urlbar-row-icon";
    icon.alt = "";
    let text = doc.createElement("span");
    text.className = "urlbar-row-text";
    let primary = doc.createElement("span");
    primary.className = "urlbar-row-primary";
    let secondary = doc.createElement("span");
    secondary.className = "urlbar-row-secondary";
    text.append(primary, secondary);
    el.append(icon, text);
    switch (row.kind) {
      case "heuristic":
        icon.src = row.url
          ? "chrome://browser-wip/skin/icons/globe.svg"
          : "chrome://browser-wip/skin/icons/search.svg";
        doc.l10n.setAttributes(primary, ...row.l10n);
        break;
      case "suggestion":
        icon.src = "chrome://browser-wip/skin/icons/search.svg";
        primary.textContent = row.search;
        break;
      case "page": {
        icon.src = UrlbarLibrary.Library.iconURL(row.url);
        icon.addEventListener("error", () => (icon.src = "chrome://browser-wip/skin/icons/globe.svg"), { once: true });
        primary.textContent = row.title || row.url;
        secondary.textContent = UrlbarLibrary.Library.displayURL(row.url);
        if (row.bookmarked) {
          let star = doc.createElement("img");
          star.className = "urlbar-row-star";
          star.src = "chrome://browser-wip/skin/icons/star-filled.svg";
          star.alt = "";
          doc.l10n.setAttributes(star, "urlbar-bookmarked");
          el.append(star);
        }
        break;
      }
      case "offer": {
        icon.src = "chrome://browser-wip/skin/icons/search.svg";
        doc.l10n.setAttributes(primary, "urlbar-suggest-offer", { engine: row.engine });
        doc.l10n.setAttributes(secondary, "urlbar-suggest-offer-note", { engine: row.engine });
        let on = doc.createElement("button");
        on.className = "panel-button primary urlbar-offer-on";
        doc.l10n.setAttributes(on, "urlbar-suggest-turn-on");
        let no = doc.createElement("button");
        no.className = "panel-button urlbar-offer-no";
        doc.l10n.setAttributes(no, "urlbar-suggest-no-thanks");
        el.append(on, no);
        break;
      }
    }
    return el;
  }

  _markSelected() {
    for (let el of this.results.children) {
      let selected = +el.dataset.index == this.selectedIndex;
      el.toggleAttribute("selected", selected);
      el.setAttribute("aria-selected", String(selected));
    }
    if (this.selectedIndex >= 0) {
      this.input.setAttribute("aria-activedescendant", `urlbar-row-${this.selectedIndex}`);
    }
  }

  _moveSelection(delta) {
    let selectable = this.rows.map((r, i) => (r.kind == "offer" ? -1 : i)).filter(i => i >= 0);
    let at = selectable.indexOf(this.selectedIndex);
    let next = selectable[(at + delta + selectable.length) % selectable.length];
    this.selectedIndex = next ?? 0;
    this._markSelected();
  }

  _onRowClick(event) {
    if (event.button > 1) {
      return;
    }
    let el = event.target.closest(".urlbar-row");
    let row = el && this.rows[+el.dataset.index];
    if (!row) {
      return;
    }
    if (row.kind == "offer") {
      if (event.target.closest(".urlbar-offer-on")) {
        Services.prefs.setBoolPref(UrlbarLibrary.SUGGEST_PREF, true);
      }
      if (event.target.closest("button")) {
        Services.prefs.setBoolPref(UrlbarLibrary.SUGGEST_OFFERED_PREF, true);
        this._startQuery({ now: true });
      }
      return;
    }
    this._openRow(row, { newTab: event.button == 1 || event.ctrlKey });
  }

  _openRow(row, { newTab = false } = {}) {
    if (row.kind == "heuristic") {
      this.go({ newTab });
    } else if (row.kind == "suggestion") {
      this._load(searchURL(row.search), { newTab });
    } else if (row.kind == "page") {
      this._load(row.url, { newTab });
    }
  }

  // -----------------------------------------------------------------------
  // Display

  _currentURI() {
    return this.browser?.currentURI ?? null;
  }

  _fullURL() {
    let uri = this._currentURI();
    if (!uri || BLANK_PAGES.has(uri.spec)) {
      return "";
    }
    // Never show credentials embedded in a URL.
    try {
      uri = uri.mutate().setUserPass("").finalize();
    } catch (e) {}
    return uri.displaySpec;
  }

  /** Refresh the field from the selected tab. */
  update() {
    let browser = this.browser;
    if (!browser) {
      return;
    }
    let typed = browser.userTypedValue;
    if (typed != null && typed !== "") {
      this.input.value = typed;
      this.box.removeAttribute("has-display");
    } else if (this.box.hasAttribute("focused")) {
      this.input.value = this._fullURL();
    } else {
      this._renderDisplay();
    }
    this.updateState();
  }

  _renderDisplay() {
    let full = this._fullURL();
    this.input.value = full;
    this.display.textContent = "";
    if (!full) {
      this.box.removeAttribute("has-display");
      return;
    }
    let uri = this._currentURI();
    let host = "";
    try {
      host = uri.displayHost;
    } catch (e) {}
    if (!host || !/^https?$/.test(uri.scheme)) {
      this.display.textContent = full;
    } else {
      // https is the normal case and is not shown; http stays visible.
      let prefix = uri.scheme == "http" ? "http://" : "";
      let rest = full.slice(full.indexOf(host) + host.length);
      if (rest == "/") {
        rest = "";
      }
      let hostEl = this.document.createElement("span");
      hostEl.className = "host";
      hostEl.textContent = host;
      this.display.append(prefix, hostEl, rest);
    }
    this.box.setAttribute("has-display", "true");
  }

  /** Security chip, protections count, progress, nav button state. */
  updateState() {
    let tab = this.gBrowser.selectedTab;
    let browser = this.browser;
    if (!tab || !browser) {
      return;
    }
    let uri = this._currentURI();
    let scheme = uri?.scheme ?? "about";
    let isWeb = scheme == "http" || scheme == "https";

    // Identity: HTTPS is normal and unlabeled. Exceptions get a chip.
    let wpl = Ci.nsIWebProgressListener;
    let state = "internal";
    if (isWeb) {
      if (tab.securityState & wpl.STATE_IS_SECURE && !(tab.securityState & wpl.STATE_LOADED_MIXED_ACTIVE_CONTENT)) {
        state = "secure";
      } else {
        state = "insecure";
      }
    }
    this.identityButton.setAttribute("state", state);
    this.identityButton.hidden = !isWeb && !BLANK_PAGES.has(uri?.spec);
    this.identityIcon.src =
      state == "insecure"
        ? "chrome://browser-wip/skin/icons/warning.svg"
        : isWeb
          ? "chrome://browser-wip/skin/icons/site-info.svg"
          : "chrome://browser-wip/skin/icons/search.svg";
    this.document.l10n.setAttributes(
      this.identityButton,
      state == "insecure" ? "identity-button-insecure" : "identity-button-secure"
    );

    // Protections.
    this.protectionsButton.hidden = !isWeb;
    let allowListed = isWeb && BrowserWip.protectionsDisabledFor(browser);
    let unavailable = isWeb && !allowListed && BrowserWip.protectionsUnavailable();
    this.protectionsButton.toggleAttribute("disabled-for-site", allowListed);
    this.protectionsButton.toggleAttribute("unavailable", unavailable);
    this.protectionsButton.querySelector("img").src =
      allowListed || unavailable
        ? "chrome://browser-wip/skin/icons/shield-off.svg"
        : "chrome://browser-wip/skin/icons/shield.svg";
    this.protectionsButton.setAttribute("count", tab.blockedTrackers);
    this.protectionsCount.textContent = tab.blockedTrackers || "";
    this.document.l10n.setAttributes(
      this.protectionsButton,
      unavailable ? "protections-button-unavailable" : "protections-button",
      { count: tab.blockedTrackers }
    );

    // Loading progress.
    this.box.toggleAttribute("loading", tab.hasAttribute("busy"));
    this.progress.style.setProperty("--progress", tab.hasAttribute("busy") ? tab.progress ?? 0 : 1);

    BrowserWip.updateNavButtons();
  }
}
