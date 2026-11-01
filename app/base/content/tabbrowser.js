/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Tabs and the pages behind them.
 *
 * Each tab owns one remote <browser> (toolkit's browser element). Pages run
 * in content processes; Gecko moves a browser between processes on its own
 * as sites change (Fission), and we re-attach progress listeners around each
 * move. The strip lives below the address bar; see browser.css.
 *
 * Tab events, dispatched on the tab element and bubbling to #tabs:
 *   TabSelect, TabOpen, TabClose, TabAttrModified, TabMove
 */

const BLOCKED_TRACKER_STATES =
  Ci.nsIWebProgressListener.STATE_BLOCKED_TRACKING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_SOCIALTRACKING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_FINGERPRINTING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_CRYPTOMINING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_EMAILTRACKING_CONTENT;

const MAX_CLOSED_TABS = 25;

// Letter tiles for sites without a favicon yet: a stable color per host.
const TILE_COLORS = ["#3B6EA8", "#4E7A3A", "#B4452F", "#6B4C9A", "#2F7D74", "#8C6A1E", "#A0436E", "#4A6475"];
function tileFor(host) {
  let hash = 0;
  for (let c of host) {
    hash = (hash * 31 + c.codePointAt(0)) >>> 0;
  }
  return {
    letter: (host.replace(/^www\./, "")[0] || "").toUpperCase(),
    color: TILE_COLORS[hash % TILE_COLORS.length],
  };
}

/**
 * Per-tab nsIWebProgressListener, attached through a browser-status-filter
 * so that sub-resource noise is folded into one stream per tab.
 */
class TabProgressListener {
  constructor(tabbrowser, tab) {
    this.tabbrowser = tabbrowser;
    this.tab = tab;
    this.QueryInterface = ChromeUtils.generateQI([
      "nsIWebProgressListener",
      "nsISupportsWeakReference",
    ]);
  }

  get browser() {
    return this.tab.linkedBrowser;
  }

  onStateChange(webProgress, request, flags) {
    if (!webProgress.isTopLevel || !(flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK)) {
      return;
    }
    if (flags & Ci.nsIWebProgressListener.STATE_START) {
      this.tabbrowser._setTabState(this.tab, { busy: true, progress: 0.05 });
    } else if (flags & Ci.nsIWebProgressListener.STATE_STOP) {
      this.tabbrowser._setTabState(this.tab, { busy: false, progress: 1 });
      // Gecko reports a content-blocking event only when the page's blocking
      // state changes, not for each further blocked request; recount here.
      this.tabbrowser._updateBlockedCount(this.tab);
    }
  }

  onProgressChange(webProgress, request, curSelf, maxSelf, curTotal, maxTotal) {
    if (maxTotal > 0 && this.tab.hasAttribute("busy")) {
      // Never go backwards, and leave room at the end for the stop event.
      let progress = Math.max(this.tab.progress ?? 0, Math.min(curTotal / maxTotal, 0.95));
      this.tabbrowser._setTabState(this.tab, { progress });
    }
  }

  onLocationChange(webProgress, request, location, flags) {
    if (!webProgress.isTopLevel) {
      return;
    }
    let sameDocument = flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT;
    if (!sameDocument) {
      this.tab.blockedTrackers = 0;
      // The new page sends its own icon (FaviconChild).
      this.tabbrowser.setTabIcon(this.tab, null);
    }
    this.tabbrowser._updateTabIdentity(this.tab, location);
    this.tabbrowser._notify(this.tab, "TabLocationChange", { sameDocument: !!sameDocument });
  }

  onStatusChange() {}

  onSecurityChange(webProgress, request, state) {
    this.tab.securityState = state;
    this.tabbrowser._notify(this.tab, "TabSecurityChange");
  }

  onContentBlockingEvent(webProgress, request, event) {
    if (event & BLOCKED_TRACKER_STATES) {
      this.tabbrowser._updateBlockedCount(this.tab);
    }
  }
}

class TabBrowser {
  constructor(window) {
    this.window = window;
    this.document = window.document;
    this.tabContainer = this.document.getElementById("tabs");
    this.browserContainer = this.document.getElementById("browsers");
    this.tabs = [];
    this.selectedTab = null;
    this._closedTabs = [];
    // The last tab opened next to its opener: { opener, tab }.
    this._lastRelatedTab = null;
    this._filters = new WeakMap();
    this._listeners = new WeakMap();

    this.tabContainer.addEventListener("pointerdown", this);
    this.tabContainer.addEventListener("click", this);
    // On the whole strip: its empty space (beside the tabs, around the
    // new-tab button) opens a tab on double- or middle-click.
    this.tabContainer.parentElement.addEventListener("auxclick", this);
    this.tabContainer.parentElement.addEventListener("dblclick", this);
    this.tabContainer.addEventListener("keydown", this);
    this.browserContainer.addEventListener("WillChangeBrowserRemoteness", this);
    this.browserContainer.addEventListener("pagetitlechanged", this);
    // A page's window.close(), and a tab Gecko opened only for a link that
    // turned out to be a download (toolkit's BrowserElementParent sends it).
    this.browserContainer.addEventListener("DOMWindowClose", this);
    this.window.addEventListener(
      "unload",
      () => this.tabs.forEach(t => this._unregisterAudible(t)),
      { once: true }
    );
    this._initScrolling();
  }

  get selectedBrowser() {
    return this.selectedTab?.linkedBrowser ?? null;
  }

  get browsers() {
    return this.tabs.map(t => t.linkedBrowser);
  }

  getTabForBrowser(browser) {
    return this.tabs.find(t => t.linkedBrowser == browser) ?? null;
  }

  // ---------------------------------------------------------------------
  // Opening and closing

  /**
   * Open a tab.
   *
   * @param {string|null} url  URL to load, or null for none (the caller loads).
   * @param {object} options
   *   select, index, pinned, openWindowInfo, triggeringPrincipal,
   *   policyContainer, referrerInfo, name, opener (a tab),
   *   lazy (a restored tab: load url only when the tab is first selected),
   *   title (shown until then), icon (a data: URL for its site icon)
   */
  addTab(url, options = {}) {
    let { select = true, openWindowInfo = null, opener = null, name = null } = options;

    let tab = this._createTabElement();
    let remoteType = openWindowInfo
      ? openWindowInfo.isRemote
        ? ChromeUtils.predictRemoteTypeForURI(null, { window: this.window })
        : null
      : ChromeUtils.predictRemoteTypeForURI(url ?? "about:blank", {
          window: this.window,
          preferredRemoteType: opener?.linkedBrowser.remoteType,
        });

    let browser = this._createBrowser({ remoteType, openWindowInfo, name });
    tab.linkedBrowser = browser;

    // A tab opened from a page goes next to it. Several opened from the same
    // page in a row (Ctrl+click on one link after another) keep their order,
    // until another tab is selected.
    let related = this._lastRelatedTab;
    let after =
      opener && related?.opener == opener && this.tabs.includes(related.tab) ? related.tab : opener;
    let index = options.index ?? (opener ? this.tabs.indexOf(after) + 1 : this.tabs.length);
    // Pinned tabs go before the unpinned ones, the rest after.
    let boundary = this._firstUnpinnedIndex();
    index = options.pinned
      ? Math.min(index, boundary)
      : Math.max(boundary, Math.min(index, this.tabs.length));
    this.tabs.splice(index, 0, tab);
    this.tabContainer.insertBefore(tab, this.tabContainer.children[index] ?? null);
    if (opener && options.index == null) {
      this._lastRelatedTab = { opener, tab };
    }
    if (options.pinned) {
      tab.setAttribute("pinned", "true");
    }

    // Inserting the browser creates its frame loader and browsing context.
    this.browserContainer.appendChild(browser);
    this._addProgressListener(tab);
    this._registerAudible(tab);
    if (url && options.lazy) {
      tab.pendingLoad = { url, title: options.title };
    }
    if (options.icon) {
      this.setTabIcon(tab, options.icon);
    }
    this._updateTabIdentity(tab, null, url);

    if (url && !openWindowInfo && !options.lazy) {
      this.loadURL(browser, url, options);
    }
    this._notify(tab, "TabOpen");
    // A window's first tab is selected, except a restored one: the restore
    // selects the right tab next, and only that one should load.
    if (select || (!this.selectedTab && !options.lazy)) {
      this.selectTab(tab);
    }
    return tab;
  }

  _createTabElement() {
    let tab = this.document.createElement("div");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("tabindex", "-1");
    tab.setAttribute("aria-selected", "false");
    tab.innerHTML = `
      <i class="tab-shoulder start"></i>
      <span class="tab-icon"></span>
      <span class="tab-label"></span>
      <img class="tab-state sharing icon" src="chrome://browser-wip/skin/icons/camera.svg" alt=""/>
      <img class="tab-state audio icon" src="chrome://browser-wip/skin/icons/audio.svg" alt=""/>
      <i class="tab-shoulder end"></i>`;
    // innerHTML in a chrome document runs Gecko's sanitizer, which drops
    // form controls, so the close button has to be built by hand.
    let close = this.document.createElement("button");
    close.className = "tab-close";
    close.setAttribute("tabindex", "-1");
    close.setAttribute("data-l10n-id", "tab-close-button");
    let closeIcon = this.document.createElement("img");
    closeIcon.className = "icon";
    closeIcon.setAttribute("src", "chrome://browser-wip/skin/icons/close.svg");
    closeIcon.setAttribute("alt", "");
    close.append(closeIcon);
    tab.querySelector(".tab-shoulder.end").before(close);
    tab.blockedTrackers = 0;
    tab.securityState = 0;
    return tab;
  }

  _createBrowser({ remoteType, openWindowInfo, name }) {
    let b = this.document.createXULElement("browser");
    // Created in a module global so a reference held elsewhere after this
    // window closes doesn't keep the window alive.
    b.permanentKey = new (Cu.getGlobalForObject(Services).Object)();
    b.setAttribute("type", "content");
    b.setAttribute("message", "true");
    b.setAttribute("messagemanagergroup", "browsers");
    b.setAttribute("manualactiveness", "true");
    b.setAttribute("nodefaultsrc", "true");
    b.setAttribute("maychangeremoteness", "true");
    if (remoteType) {
      b.setAttribute("remote", "true");
      b.setAttribute("remoteType", remoteType);
    }
    if (openWindowInfo) {
      // Adopt the browsing context Gecko created for window.open, so the
      // opener relationship survives.
      b.openWindowInfo = openWindowInfo;
    }
    if (name) {
      b.setAttribute("name", name);
    }
    return b;
  }

  loadURL(browser, url, options = {}) {
    let params = {
      triggeringPrincipal:
        options.triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(),
      policyContainer: options.policyContainer,
      referrerInfo: options.referrerInfo,
      loadFlags: options.loadFlags ?? Ci.nsIWebNavigation.LOAD_FLAGS_NONE,
      hasValidUserGestureActivation: !!options.userGesture,
    };
    browser.fixupAndLoadURIString(url, params);
  }

  _addProgressListener(tab) {
    let filter = Cc["@mozilla.org/appshell/component/browser-status-filter;1"].createInstance(
      Ci.nsIWebProgress
    );
    let listener = new TabProgressListener(this, tab);
    filter.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_ALL);
    tab.linkedBrowser.webProgress.addProgressListener(filter, Ci.nsIWebProgress.NOTIFY_ALL);
    this._filters.set(tab, filter);
    this._listeners.set(tab, listener);
  }

  _removeProgressListener(tab) {
    let filter = this._filters.get(tab);
    let listener = this._listeners.get(tab);
    if (filter) {
      tab.linkedBrowser.webProgress?.removeProgressListener(filter);
      filter.removeProgressListener(listener);
    }
  }

  // The speaker icon: Gecko reports audibility through the tab's
  // MediaController, which is replaced whenever the tab changes process.
  _registerAudible(tab) {
    this._unregisterAudible(tab);
    let controller = tab.linkedBrowser.browsingContext?.mediaController;
    if (!controller) {
      return;
    }
    let handler = () => {
      tab.toggleAttribute("soundplaying", controller.isAudible);
      this._notify(tab, "TabAttrModified");
    };
    controller.addEventListener("audiblechange", handler);
    tab.audible = { controller, handler };
  }

  _unregisterAudible(tab) {
    tab.audible?.controller.removeEventListener("audiblechange", tab.audible.handler);
    tab.audible = null;
  }

  async removeTab(tab, { skipPermitUnload = false } = {}) {
    if (!tab || tab.closing) {
      return;
    }
    tab.closing = true;
    let browser = tab.linkedBrowser;
    if (!skipPermitUnload) {
      let { permitUnload } = await browser.asyncPermitUnload();
      if (!permitUnload) {
        tab.closing = false;
        return;
      }
    }

    // Closing the last tab closes the window.
    if (this.tabs.length == 1) {
      this.window.close();
      return;
    }

    let url = tab.pendingLoad?.url ?? browser.currentURI?.spec;
    if (url && url != "about:blank") {
      this._closedTabs.push({ url, index: this.tabs.indexOf(tab) });
      this._closedTabs.splice(0, this._closedTabs.length - MAX_CLOSED_TABS);
    }

    let index = this.tabs.indexOf(tab);
    if (tab == this.selectedTab) {
      // Prefer the tab to the right, as most browsers do.
      let next = this.tabs[index + 1] ?? this.tabs[index - 1];
      this.selectTab(next);
    }
    this._notify(tab, "TabClose");
    this._removeProgressListener(tab);
    this._unregisterAudible(tab);
    this.tabs.splice(index, 1);
    tab.remove();
    browser.remove();
  }

  reopenClosedTab() {
    let closed = this._closedTabs.pop();
    if (closed) {
      this.addTab(closed.url, { index: closed.index });
    }
  }

  // ---------------------------------------------------------------------
  // Selection

  selectTab(tab) {
    if (!tab || tab == this.selectedTab) {
      return;
    }
    let previous = this.selectedTab;
    this._lastRelatedTab = null;
    if (previous) {
      previous.removeAttribute("selected");
      previous.setAttribute("aria-selected", "false");
      previous.setAttribute("tabindex", "-1");
      previous.linkedBrowser.removeAttribute("selected");
      previous.linkedBrowser.docShellIsActive = false;
    }
    this.selectedTab = tab;
    tab.setAttribute("selected", "true");
    tab.setAttribute("aria-selected", "true");
    tab.setAttribute("tabindex", "0");
    let browser = tab.linkedBrowser;
    browser.setAttribute("selected", "true");
    browser.docShellIsActive = this.window.windowState != this.window.STATE_MINIMIZED;
    if (tab.pendingLoad) {
      let { url } = tab.pendingLoad;
      delete tab.pendingLoad;
      this.loadURL(browser, url);
    }
    this.scrollTabIntoView(tab);
    this._notify(tab, "TabSelect", { previous });
  }

  advanceSelectedTab(direction) {
    let index = this.tabs.indexOf(this.selectedTab);
    let next = (index + direction + this.tabs.length) % this.tabs.length;
    this.selectTab(this.tabs[next]);
  }

  // ---------------------------------------------------------------------
  // Scrolling: once the tabs are at their narrowest, the strip scrolls. The
  // wheel scrolls it sideways, pinned tabs stay at the start, and each edge
  // fades while there are more tabs beyond it.

  _initScrolling() {
    let strip = this.tabContainer;
    strip.addEventListener("wheel", e => this._onWheel(e), { passive: false });
    strip.addEventListener("scroll", () => this._updateOverflow());
    new this.window.ResizeObserver(() => this._updateOverflow()).observe(strip);
    // Tabs added, closed, moved or (un)pinned change what the strip holds.
    let changed = () => {
      if (!this._layoutPending) {
        this._layoutPending = true;
        this.window.requestAnimationFrame(() => {
          this._layoutPending = false;
          this._updatePinned();
          this._updateOverflow();
        });
      }
    };
    for (let type of ["TabOpen", "TabClose", "TabMove", "TabAttrModified"]) {
      strip.addEventListener(type, changed);
    }
  }

  get _reducedMotion() {
    return this.window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  scrollTabIntoView(tab) {
    tab.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: this._reducedMotion ? "instant" : "smooth",
    });
  }

  _onWheel(event) {
    let strip = this.tabContainer;
    // Sideways wheels and touchpads already scroll the strip; Ctrl+wheel
    // stays the page's.
    if (
      event.ctrlKey ||
      event.metaKey ||
      Math.abs(event.deltaX) >= Math.abs(event.deltaY) ||
      strip.scrollWidth <= strip.clientWidth
    ) {
      return;
    }
    let delta = event.deltaY;
    if (event.deltaMode == event.DOM_DELTA_LINE) {
      delta *= 26;
    } else if (event.deltaMode == event.DOM_DELTA_PAGE) {
      delta *= strip.clientWidth;
    }
    let rtl = this.window.getComputedStyle(strip).direction == "rtl";
    // A touchpad's pixel deltas already arrive smoothly.
    let smooth = event.deltaMode != event.DOM_DELTA_PIXEL && !this._reducedMotion;
    // Notches in quick succession add up, even while the last one is still
    // scrolling there.
    let now = this.window.performance.now();
    let from = smooth && this._wheelTarget != null && now - this._wheelTime < 400 ? this._wheelTarget : strip.scrollLeft;
    let max = strip.scrollWidth - strip.clientWidth;
    let target = from + (rtl ? -delta : delta);
    target = rtl ? Math.min(0, Math.max(-max, target)) : Math.max(0, Math.min(max, target));
    this._wheelTarget = target;
    this._wheelTime = now;
    event.preventDefault();
    strip.scrollTo({ left: target, behavior: smooth ? "smooth" : "instant" });
  }

  _updateOverflow() {
    let strip = this.tabContainer;
    let max = strip.scrollWidth - strip.clientWidth;
    // Negative in right-to-left.
    let position = Math.abs(strip.scrollLeft);
    strip.toggleAttribute("overflowing", max > 1);
    strip.toggleAttribute("more-before", max > 1 && position > 1);
    strip.toggleAttribute("more-after", max > 1 && position < max - 1);
  }

  // Pinned tabs stick at the start of the strip, one after another, and the
  // selected tab scrolls clear of them.
  _updatePinned() {
    // Sticky offsets count from inside the strip's padding.
    let offset = 0;
    let last = null;
    for (let tab of this.tabs) {
      tab.removeAttribute("last-pinned");
      if (tab.hasAttribute("pinned")) {
        tab.style.setProperty("--pinned-start", `${offset}px`);
        offset += tab.offsetWidth;
        last = tab;
      } else {
        tab.style.removeProperty("--pinned-start");
      }
    }
    last?.setAttribute("last-pinned", "true");
    this.tabContainer.style.setProperty("--pinned-width", `${offset}px`);
  }

  // ---------------------------------------------------------------------
  // Ordering

  _firstUnpinnedIndex() {
    let i = this.tabs.findIndex(t => !t.hasAttribute("pinned"));
    return i == -1 ? this.tabs.length : i;
  }

  moveTab(tab, newIndex) {
    let pinned = tab.hasAttribute("pinned");
    let boundary = this._firstUnpinnedIndex() - (pinned ? 1 : 0);
    // Pinned tabs stay before unpinned ones.
    newIndex = pinned
      ? Math.max(0, Math.min(newIndex, boundary))
      : Math.max(boundary, Math.min(newIndex, this.tabs.length - 1));
    let oldIndex = this.tabs.indexOf(tab);
    if (newIndex == oldIndex) {
      return;
    }
    this.tabs.splice(oldIndex, 1);
    this.tabs.splice(newIndex, 0, tab);
    this.tabContainer.insertBefore(tab, this.tabs[newIndex + 1] ?? null);
    this._notify(tab, "TabMove", { oldIndex, newIndex });
  }

  moveSelectedTab(direction) {
    this.moveTab(this.selectedTab, this.tabs.indexOf(this.selectedTab) + direction);
  }

  setPinned(tab, pinned) {
    if (pinned == tab.hasAttribute("pinned")) {
      return;
    }
    // Move first so the tab lands at the edge of the pinned group.
    this.moveTab(tab, this._firstUnpinnedIndex() - (pinned ? 0 : 1));
    tab.toggleAttribute("pinned", pinned);
    this._notify(tab, "TabAttrModified");
  }

  // ---------------------------------------------------------------------
  // Tab state

  _setTabState(tab, { busy, progress }) {
    if (busy !== undefined) {
      tab.toggleAttribute("busy", busy);
    }
    if (progress !== undefined) {
      tab.progress = progress;
    }
    this._notify(tab, "TabAttrModified");
  }

  _updateTabIdentity(tab, location, pendingURL) {
    let browser = tab.linkedBrowser;
    pendingURL ??= tab.pendingLoad?.url;
    let uri = location ?? browser.currentURI;
    let label = browser.contentTitle || tab.pendingLoad?.title;
    let host = "";
    try {
      host = uri?.host || (tab.pendingLoad ? Services.io.newURI(tab.pendingLoad.url).host : "");
    } catch (e) {
      // about:, data: and friends have no host.
    }
    let isBlank = spec => !spec || spec == "about:blank" || spec == "about:newtab";
    if (!label) {
      if (pendingURL && !isBlank(pendingURL) && isBlank(uri?.spec)) {
        label = pendingURL;
      } else if (!isBlank(uri?.spec)) {
        label = host || uri.spec;
      }
    }
    if (!label) {
      this.document.l10n.setAttributes(tab.querySelector(".tab-label"), "tab-new-tab-label");
    } else {
      let el = tab.querySelector(".tab-label");
      el.removeAttribute("data-l10n-id");
      el.textContent = label;
    }
    tab.setAttribute("aria-label", label || "");
    // Web pages get a letter tile until favicons are supported; the
    // browser's own pages show its mark.
    let icon = tab.querySelector(".tab-icon");
    let internal = !host && !(pendingURL && /^https?:/.test(pendingURL));
    icon.toggleAttribute("internal", internal);
    let tile = tileFor(host || label || "");
    icon.textContent = internal ? "" : tile.letter;
    icon.style.setProperty("--tab-tile", tile.color);
    this._notify(tab, "TabAttrModified");
  }

  /** A page's site icon (FaviconParent), as a data: URL; null for none. */
  setIcon(browser, dataURL) {
    let tab = this.getTabForBrowser(browser);
    if (tab) {
      this.setTabIcon(tab, dataURL);
    }
  }

  setTabIcon(tab, dataURL) {
    if ((tab.favicon ?? null) == dataURL) {
      return;
    }
    tab.favicon = dataURL;
    let icon = tab.querySelector(".tab-icon");
    icon.toggleAttribute("favicon", !!dataURL);
    if (dataURL) {
      icon.style.setProperty("--tab-favicon", `url("${dataURL}")`);
    } else {
      icon.style.removeProperty("--tab-favicon");
    }
    this._notify(tab, "TabAttrModified");
  }

  _updateBlockedCount(tab) {
    let log;
    try {
      // A JSON string, or null before the page has a window global.
      log = JSON.parse(tab.linkedBrowser.getContentBlockingLog() ?? "{}");
    } catch (e) {
      return;
    }
    let blockedOrigins = Object.values(log).filter(entries =>
      entries.some(([state, blocked]) => blocked && state & BLOCKED_TRACKER_STATES)
    ).length;
    if (blockedOrigins != tab.blockedTrackers) {
      // The new tab page's privacy report counts what each page blocked
      // (counts only; not in private windows).
      let added = blockedOrigins - (tab.blockedTrackers ?? 0);
      if (added > 0 && !PrivateBrowsingUtils.isBrowserPrivate(tab.linkedBrowser)) {
        ProtectionStats.add(added, !tab.blockedTrackers);
      }
      tab.blockedTrackers = blockedOrigins;
      this._notify(tab, "TabAttrModified");
    }
  }

  _notify(tab, type, detail = {}) {
    tab.dispatchEvent(new this.window.CustomEvent(type, { bubbles: true, detail }));
  }

  // ---------------------------------------------------------------------
  // Events

  handleEvent(event) {
    switch (event.type) {
      case "pointerdown":
        this._onPointerDown(event);
        break;
      case "click": {
        let tab = event.target.closest(".tab");
        if (event.target.closest(".tab-close")) {
          this.removeTab(tab);
        } else if (tab && event.button == 0) {
          this.selectTab(tab);
        }
        break;
      }
      case "auxclick":
        // Middle-click closes a tab, or opens one on empty strip space.
        if (event.button == 1) {
          let tab = event.target.closest(".tab");
          if (tab) {
            this.removeTab(tab);
          } else if (!event.target.closest("button")) {
            BrowserWip.openNewTab();
          }
          event.preventDefault();
        }
        break;
      case "dblclick":
        if (!event.target.closest(".tab, button")) {
          BrowserWip.openNewTab();
        }
        break;
      case "DOMWindowClose": {
        let tab = this.getTabForBrowser(event.target);
        if (tab) {
          event.preventDefault();
          this.removeTab(tab, { skipPermitUnload: true });
        }
        break;
      }
      case "keydown":
        this._onTabKeydown(event);
        break;
      case "pagetitlechanged": {
        let tab = this.getTabForBrowser(event.target);
        if (tab) {
          this._updateTabIdentity(tab);
        }
        break;
      }
      case "WillChangeBrowserRemoteness":
        this._onWillChangeRemoteness(event.target);
        break;
    }
  }

  _onWillChangeRemoteness(browser) {
    let tab = this.getTabForBrowser(browser);
    if (!tab) {
      return;
    }
    // The browser is about to move to another process. Its webProgress is
    // replaced, so detach now and attach a fresh listener afterwards.
    this._removeProgressListener(tab);
    browser.addEventListener(
      "DidChangeBrowserRemoteness",
      () => {
        this._addProgressListener(tab);
        // A process switch creates a new MediaController.
        this._registerAudible(tab);
        // Re-assigning reapplies activeness to the new remote frame.
        // eslint-disable-next-line no-self-assign
        browser.docShellIsActive = browser.docShellIsActive;
        this._updateBlockedCount(tab);
      },
      { once: true }
    );
  }

  // Arrow keys move between tabs; Ctrl+Shift+PageUp/Down reorder (key set).
  _onTabKeydown(event) {
    let tab = event.target.closest(".tab");
    if (!tab) {
      return;
    }
    let rtl = this.window.getComputedStyle(this.tabContainer).direction == "rtl";
    let step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    if (step) {
      this.advanceSelectedTab(step);
      this.selectedTab.focus();
      event.preventDefault();
    } else if (event.key == "Delete") {
      this.removeTab(tab);
    }
  }

  // ---------------------------------------------------------------------
  // Drag to reorder (pointer events: smooth, and works the same with touch)

  _onPointerDown(event) {
    let tab = event.target.closest(".tab");
    if (!tab || event.button != 0 || event.target.closest(".tab-close")) {
      return;
    }
    let strip = this.tabContainer;
    let startX = event.clientX;
    let dragging = false;
    let rects;
    let originIndex;
    // Positions are measured when the drag starts; if the strip scrolls
    // meanwhile, every tab has moved by as much.
    let scrollStart = strip.scrollLeft;
    let pointerX = startX;
    let autoScroll = 0;

    let update = () => {
      let dx = pointerX - startX + (strip.scrollLeft - scrollStart);
      // Keep pinned and unpinned tabs within their own groups.
      let pinned = tab.hasAttribute("pinned");
      let group = this.tabs.map((t, i) => [t, i]).filter(([t]) => t.hasAttribute("pinned") == pinned);
      let first = rects[group[0][1]];
      let last = rects[group[group.length - 1][1]];
      let own = rects[originIndex];
      dx = Math.max(first.left - own.left, Math.min(dx, last.right - own.right));
      tab.style.transform = `translateX(${dx}px)`;

      // Shift the tabs the dragged one has passed over.
      let center = own.left + own.width / 2 + dx;
      for (let [t, i] of group) {
        if (t == tab) {
          continue;
        }
        let r = rects[i];
        let mid = r.left + r.width / 2;
        let shift = 0;
        if (i > originIndex && center > mid) {
          shift = -own.width;
        } else if (i < originIndex && center < mid) {
          shift = own.width;
        }
        t.style.transform = shift ? `translateX(${shift}px)` : "";
      }
      tab.dropCenter = center;
      tab.groupIndices = group;
    };

    // Near an edge of a strip that scrolls, it scrolls along, faster the
    // closer the pointer is. Pinned tabs never scroll out of view.
    let EDGE = 40;
    let scrollStep = () => {
      autoScroll = 0;
      let box = strip.getBoundingClientRect();
      let start = box.left + (parseFloat(strip.style.getPropertyValue("--pinned-width")) || 0);
      let speed = 0;
      if (pointerX < start + EDGE) {
        speed = -Math.min(1, (start + EDGE - pointerX) / EDGE);
      } else if (pointerX > box.right - EDGE) {
        speed = Math.min(1, (pointerX - (box.right - EDGE)) / EDGE);
      }
      if (!speed || tab.hasAttribute("pinned") || strip.scrollWidth <= strip.clientWidth) {
        return;
      }
      let before = strip.scrollLeft;
      strip.scrollLeft += speed * 14;
      if (strip.scrollLeft != before) {
        update();
        autoScroll = this.window.requestAnimationFrame(scrollStep);
      }
    };

    let onMove = e => {
      pointerX = e.clientX;
      if (!dragging) {
        if (Math.abs(pointerX - startX) < 6) {
          return;
        }
        dragging = true;
        this.selectTab(tab);
        try {
          // Keeps the drag when the pointer leaves the strip. Not essential:
          // the move/up listeners are on the window.
          tab.setPointerCapture(event.pointerId);
        } catch (e) {}
        tab.setAttribute("dragging", "true");
        strip.setAttribute("reordering", "true");
        rects = this.tabs.map(t => t.getBoundingClientRect());
        originIndex = this.tabs.indexOf(tab);
        scrollStart = strip.scrollLeft;
        strip.addEventListener("scroll", update);
      }
      update();
      if (!autoScroll) {
        scrollStep();
      }
    };

    let onUp = () => {
      this.window.removeEventListener("pointermove", onMove);
      this.window.removeEventListener("pointerup", onUp);
      this.window.removeEventListener("pointercancel", onUp);
      if (!dragging) {
        return;
      }
      this.window.cancelAnimationFrame(autoScroll);
      strip.removeEventListener("scroll", update);
      let center = tab.dropCenter;
      let target = originIndex;
      for (let [t, i] of tab.groupIndices) {
        let r = rects[i];
        if (t != tab && i > originIndex && center > r.left + r.width / 2) {
          target = Math.max(target, i);
        } else if (t != tab && i < originIndex && center < r.left + r.width / 2) {
          target = Math.min(target, i);
        }
      }
      for (let t of this.tabs) {
        t.style.transform = "";
      }
      tab.removeAttribute("dragging");
      strip.removeAttribute("reordering");
      this.moveTab(tab, target);
      this.scrollTabIntoView(tab);
    };

    this.window.addEventListener("pointermove", onMove);
    this.window.addEventListener("pointerup", onUp);
    this.window.addEventListener("pointercancel", onUp);
  }

  // ---------------------------------------------------------------------
  // nsIBrowserDOMWindow: links with target=_blank, window.open, and loads
  // handed to us by Gecko.

  get browserDOMWindow() {
    let tabbrowser = this;
    let OPEN = Ci.nsIBrowserDOMWindow;
    // `load`: openURI* asks us to load the URI; createContentWindow* only wants
    // the window, and Gecko loads into it itself.
    let open = (uri, openWindowInfo, where, params = {}, load = true) => {
      if (where == OPEN.OPEN_PRINT_BROWSER) {
        // window.print() previews are not supported yet.
        return null;
      }
      if (where == OPEN.OPEN_CURRENTWINDOW && !openWindowInfo) {
        if (uri && load) {
          tabbrowser.loadURL(tabbrowser.selectedBrowser, uri.spec, params);
        }
        return tabbrowser.selectedBrowser;
      }
      // New windows requested by pages open as tabs; background unless the
      // page asked for the foreground or the user is in a gesture.
      let select = where != OPEN.OPEN_NEWTAB_BACKGROUND;
      let tab = tabbrowser.addTab(openWindowInfo || !load ? null : uri?.spec ?? "about:blank", {
        select,
        openWindowInfo,
        opener: tabbrowser.selectedTab,
        name: params.name,
        triggeringPrincipal: params.triggeringPrincipal,
        policyContainer: params.policyContainer,
        referrerInfo: params.referrerInfo,
        userGesture: openWindowInfo?.hasValidUserGestureActivation,
      });
      if (openWindowInfo && uri && load) {
        tabbrowser.loadURL(tab.linkedBrowser, uri.spec, params);
      }
      return tab.linkedBrowser;
    };

    return {
      QueryInterface: ChromeUtils.generateQI(["nsIBrowserDOMWindow"]),
      createContentWindow(uri, openWindowInfo, where, flags, triggeringPrincipal, policyContainer) {
        return open(uri, openWindowInfo, where, { triggeringPrincipal, policyContainer }, false)
          ?.browsingContext;
      },
      createContentWindowInFrame(uri, params, where, flags, name) {
        return open(
          uri,
          params.openWindowInfo,
          where,
          {
            name,
            triggeringPrincipal: params.triggeringPrincipal,
            policyContainer: params.policyContainer,
            referrerInfo: params.referrerInfo,
          },
          false
        );
      },
      openURI(uri, openWindowInfo, where, flags, triggeringPrincipal, policyContainer) {
        return open(uri, openWindowInfo, where, { triggeringPrincipal, policyContainer })
          ?.browsingContext;
      },
      openURIInFrame(uri, params, where, flags, name) {
        return open(uri, params.openWindowInfo, where, {
          name,
          triggeringPrincipal: params.triggeringPrincipal,
          policyContainer: params.policyContainer,
          referrerInfo: params.referrerInfo,
        });
      },
      canClose() {
        return true;
      },
      get tabCount() {
        return tabbrowser.tabs.length;
      },
    };
  }
}
