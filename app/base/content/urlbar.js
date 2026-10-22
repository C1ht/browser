/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * The address field. It always describes the selected tab: its URL, whether
 * the connection is secure, how many trackers were blocked, and loading
 * progress. Typing a URL loads it; anything else searches.
 */

// Search engines that need no account or API key. The default is a pref
// (browserwip.search.engine) so Settings can change it.
const SEARCH_ENGINES = {
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  startpage: { name: "Startpage", url: "https://www.startpage.com/do/search?query=" },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q=" },
};

// Pages whose address is not worth showing: the field stays empty so the
// placeholder invites a search.
const BLANK_PAGES = new Set(["about:blank", "about:newtab", "about:home", "about:welcome"]);

function searchURL(terms) {
  let id = Services.prefs.getStringPref("browserwip.search.engine", "brave");
  let engine = SEARCH_ENGINES[id] ?? SEARCH_ENGINES.brave;
  return engine.url + encodeURIComponent(terms);
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

    this.input.addEventListener("focus", this);
    this.input.addEventListener("blur", this);
    this.input.addEventListener("keydown", this);
    this.input.addEventListener("input", this);

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
        if (!this.browser?.userTypedValue) {
          this.update();
        }
        break;
      case "input":
        if (this.browser) {
          this.browser.userTypedValue = this.input.value;
        }
        break;
      case "keydown":
        this._onKeydown(event);
        break;
      case "TabSelect":
      case "TabLocationChange":
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
    if (event.key == "Enter") {
      this.go({ newTab: event.altKey });
      event.preventDefault();
    } else if (event.key == "Escape") {
      if (this.browser) {
        this.browser.userTypedValue = null;
      }
      this.input.value = this._fullURL();
      this.input.select();
      event.preventDefault();
    }
  }

  go({ newTab = false } = {}) {
    let target = interpretInput(this.input.value);
    if (!target) {
      return;
    }
    let url = target.url ?? searchURL(target.search);
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
