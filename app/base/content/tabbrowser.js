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
 *   TabSelect, TabOpen, TabClose, TabAttrModified, TabMove, TabSplit,
 *   TabUnsplit
 *
 * Split view: two neighboring tabs can show their pages side by side
 * (splitTabs). Both tabs then share tab.split, { tabs, ratio }; selecting
 * either shows both, and the selected one is the one the address bar and
 * the keyboard act on. Clicking into the other page selects it.
 */

const BLOCKED_TRACKER_STATES =
  Ci.nsIWebProgressListener.STATE_BLOCKED_TRACKING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_SOCIALTRACKING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_FINGERPRINTING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_CRYPTOMINING_CONTENT |
  Ci.nsIWebProgressListener.STATE_BLOCKED_EMAILTRACKING_CONTENT;

const MAX_CLOSED_TABS = 25;
// The narrowest a page in split view gets, as a share of the window.
const MIN_SPLIT_RATIO = 0.15;
// What a dragged tab carries, so another window of the browser can take it.
const TAB_DROP_TYPE = "application/x-browserwip-tab";

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
    this._selectedTab = null;
    this._panelCount = 0;
    this._closedTabs = [];
    // The last tab opened next to its opener: { opener, tab }.
    this._lastRelatedTab = null;
    this._filters = new WeakMap();
    this._listeners = new WeakMap();

    this.tabContainer.addEventListener("dragstart", this);
    this.tabContainer.addEventListener("dragend", this);
    // A tab may be dropped anywhere in the window: on the strip to place it,
    // elsewhere to take it from another window (and not tear it off).
    for (let type of ["dragover", "dragleave", "drop"]) {
      this.window.addEventListener(type, this, true);
    }
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
    // A page's content process died, or can't start because the browser's
    // files changed on disk since it started.
    this.browserContainer.addEventListener("oop-browser-crashed", this);
    this.browserContainer.addEventListener("oop-browser-buildid-mismatch", this);
    // DevTools closing (or moving) gives the page its space back.
    new this.window.MutationObserver(records => this._onToolboxRemoved(records)).observe(this.browserContainer, {
      childList: true,
      subtree: true,
    });
    // Split view: the bar between the two pages, which resizes them; and
    // clicking into the page that isn't selected selects it.
    this._splitter = this.document.createElement("div");
    this._splitter.id = "split-view-splitter";
    this._splitter.hidden = true;
    this._splitter.addEventListener("pointerdown", e => this._onSplitterPointerDown(e));
    this._splitter.addEventListener("dblclick", () => this._setSplitRatio(this.selectedTab?.split, 0.5));
    this.browserContainer.append(this._splitter);
    this._splitShown = [];
    this.browserContainer.addEventListener("focus", this, true);
    this.window.addEventListener(
      "unload",
      () => this.tabs.forEach(t => this._unregisterAudible(t)),
      { once: true }
    );
    this._initScrolling();
  }

  get selectedTab() {
    return this._selectedTab;
  }

  // Assigning selects, as in Firefox (DevTools does it).
  set selectedTab(tab) {
    this.selectTab(tab);
  }

  get selectedBrowser() {
    return this.selectedTab?.linkedBrowser ?? null;
  }

  get currentURI() {
    return this.selectedBrowser?.currentURI ?? null;
  }

  /**
   * The element around a tab's page that DevTools docks its toolbox into,
   * with Firefox's structure and class names: .browserSidebarContainer >
   * .browserContainer > .browserStack > <browser>.
   */
  getBrowserContainer(browser = this.selectedBrowser) {
    return browser?.closest(".browserContainer") ?? null;
  }

  /** The dialogs over browser's page, such as the print preview (printing.js). */
  getTabDialogBox(browser) {
    if (!browser) {
      throw new Error("getTabDialogBox needs a browser");
    }
    browser.tabDialogBox ??= new TabDialogBox(browser);
    return browser.tabDialogBox;
  }

  /** A tab for one of the browser's own pages (DevTools opens about:debugging). */
  addTrustedTab(url, options = {}) {
    return this.addTab(url, {
      ...options,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
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
   *   title (shown until then), icon (a data: URL for its site icon),
   *   remoteType (the process type, for a browser about to adopt another's
   *   page; null for the parent process)
   */
  addTab(url, options = {}) {
    let { select = true, openWindowInfo = null, opener = null, name = null } = options;

    let tab = this._createTabElement();
    let remoteType;
    if ("remoteType" in options) {
      remoteType = options.remoteType;
    } else if (openWindowInfo) {
      remoteType = openWindowInfo.isRemote ? ChromeUtils.predictRemoteTypeForURI(null, { window: this.window }) : null;
    } else {
      remoteType = ChromeUtils.predictRemoteTypeForURI(url ?? "about:blank", {
        window: this.window,
        preferredRemoteType: opener?.linkedBrowser.remoteType,
      });
    }

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
    if (this._isSplitInterior(this.tabs, index)) {
      index++;
    }
    this.tabs.splice(index, 0, tab);
    this.tabContainer.insertBefore(tab, this.tabContainer.children[index] ?? null);
    if (opener && options.index == null) {
      this._lastRelatedTab = { opener, tab };
    }
    if (options.pinned) {
      tab.setAttribute("pinned", "true");
    }

    // Inserting the browser creates its frame loader and browsing context.
    this.browserContainer.appendChild(this._createBrowserPanel(browser));
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
    } else if (!options.lazy) {
      // A tab opened in the background (a middle-clicked link): the strip
      // scrolls to show where it went, and the current tab stays selected.
      this.scrollTabIntoView(tab);
    }
    return tab;
  }

  _createTabElement() {
    // A <tab> (an unknown element in the XHTML namespace, nothing more), as
    // Firefox's tabs are: DevTools only treats a tab as one by its tag name.
    let tab = this.document.createElement("tab");
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
    tab.draggable = true;
    tab.blockedTrackers = 0;
    tab.securityState = 0;
    return tab;
  }

  _createBrowserPanel(browser) {
    let panel = this.document.createElement("div");
    panel.className = "browserSidebarContainer";
    panel.id = `panel-${++this._panelCount}`;
    let container = this.document.createElement("div");
    container.className = "browserContainer";
    let stack = this.document.createElement("div");
    stack.className = "browserStack";
    stack.append(browser);
    container.append(stack);
    panel.append(container);
    return panel;
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
      // Once only: a tab that moved to another window is closed after this.
      this._filters.delete(tab);
      this._listeners.delete(tab);
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

  /**
   * Closes a tab. adopted: it moved to another window (adoptTab), so it
   * isn't offered by "Reopen closed tab".
   */
  async removeTab(tab, { skipPermitUnload = false, adopted = false, remember = true } = {}) {
    if (!tab || tab.closing) {
      return;
    }
    tab.closing = true;
    let browser = tab.linkedBrowser;
    if (!skipPermitUnload && !tab.hasAttribute("crashed") && !(await this.permitUnload(browser))) {
      tab.closing = false;
      return;
    }

    // Closing the last tab closes the window.
    if (this.tabs.length == 1) {
      this.window.close();
      return;
    }

    // The other half of a split view takes the whole window (selected
    // first, so its page stays active throughout).
    let partner = this.splitPartner(tab);
    if (partner && tab == this.selectedTab) {
      this.selectTab(partner);
    }
    this.unsplitTab(tab);

    let url = tab.pendingLoad?.url ?? browser.currentURI?.spec;
    if (url && url != "about:blank" && !adopted && remember) {
      this._closedTabs.push({ url, index: this.tabs.indexOf(tab) });
      this._closedTabs.splice(0, this._closedTabs.length - MAX_CLOSED_TABS);
    }

    let index = this.tabs.indexOf(tab);
    if (tab == this.selectedTab) {
      // Prefer the tab to the right, as most browsers do.
      let next = this.tabs[index + 1] ?? this.tabs[index - 1];
      this.selectTab(next);
    }
    // A tab adopted by another window announced its TabClose already.
    if (!adopted) {
      this._notify(tab, "TabClose");
    }
    this._removeProgressListener(tab);
    this._unregisterAudible(tab);
    this.tabs.splice(index, 1);
    tab.remove();
    (browser.closest(".browserSidebarContainer") ?? browser).remove();
  }

  /**
   * Whether a page lets itself be closed. As in Firefox, only a page with a
   * beforeunload handler is asked; a page whose process is gone can't
   * answer, and doesn't stop anything.
   */
  async permitUnload(browser) {
    try {
      if (!browser.hasBeforeUnload) {
        return true;
      }
      let { permitUnload } = await browser.asyncPermitUnload();
      return permitUnload;
    } catch (e) {
      return true;
    }
  }

  // When a docked toolbox goes, the page grows back into its space. Its
  // process is told the new size and repaints, as switching tabs does;
  // otherwise the space could stay blank until then.
  _onToolboxRemoved(records) {
    for (let record of records) {
      if (![...record.removedNodes].some(n => n.classList?.contains("devtools-toolbox-iframe"))) {
        continue;
      }
      let browser = record.target.querySelector?.(".browserStack > browser");
      if (!browser?.isRemoteBrowser) {
        continue;
      }
      this.window.requestAnimationFrame(() => {
        browser.frameLoader?.requestUpdatePosition();
        if (this.shownBrowsers.includes(browser) && this.window.windowState != this.window.STATE_MINIMIZED) {
          browser.docShellIsActive = false;
          browser.docShellIsActive = true;
        }
      });
    }
  }

  // ---------------------------------------------------------------------
  // Crashed tabs

  _onBrowserCrashed(event) {
    let browser = event.originalTarget;
    let tab = this.getTabForBrowser(browser);
    // A crashed frame inside a page shows as an empty frame; only a whole
    // page needs this.
    if (!tab || !event.isTopFrame) {
      return;
    }
    let restart = event.type == "oop-browser-buildid-mismatch";
    tab.setAttribute("crashed", restart ? "restart" : "crash");
    tab.removeAttribute("busy");
    tab.removeAttribute("soundplaying");
    let page = this.document.createElement("div");
    page.className = "tab-crashed-page";
    page.setAttribute("role", "alert");
    let heading = this.document.createElement("h1");
    let text = this.document.createElement("p");
    let button = this.document.createElement("button");
    button.className = "tab-crashed-button";
    this.document.l10n.setAttributes(heading, restart ? "tab-restart-title" : "tab-crashed-title");
    this.document.l10n.setAttributes(text, restart ? "tab-restart-text" : "tab-crashed-text");
    this.document.l10n.setAttributes(button, restart ? "tab-restart-button" : "tab-crashed-button");
    button.addEventListener("click", () => (restart ? SessionStore.restart() : this.reviveTab(tab)));
    page.append(heading, text, button);
    browser.closest(".browserStack").querySelector(".tab-crashed-page")?.remove();
    browser.closest(".browserStack").append(page);
    this._notify(tab, "TabAttrModified");
  }

  /** A crashed tab again, in a new process: a fresh tab in its place. */
  reviveTab(tab) {
    let url = tab.linkedBrowser.currentURI?.spec;
    let fresh = this.addTab(url && url != "about:blank" ? url : NEW_TAB_URL, {
      index: this.tabs.indexOf(tab),
      pinned: tab.hasAttribute("pinned"),
      select: tab == this.selectedTab,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    this.removeTab(tab, { skipPermitUnload: true, remember: false });
    return fresh;
  }

  reopenClosedTab() {
    let closed = this._closedTabs.pop();
    if (closed) {
      this.addTab(closed.url, { index: closed.index });
    }
  }

  // ---------------------------------------------------------------------
  // Moving tabs between windows

  /**
   * Moves a tab from another window here, page and all: its docshell is
   * swapped into a new browser in this window, so nothing reloads and the
   * page keeps its state (scroll position, form fields, a playing video).
   * index: where in the strip (the end by default).
   */
  adoptTab(otherTab, { index = null, select = true } = {}) {
    let other = otherTab.ownerDocument.defaultView.gBrowser;
    let pinned = otherTab.hasAttribute("pinned");
    let tab;
    if (otherTab.pendingLoad) {
      // A restored tab that never loaded: nothing to move but its address.
      let { url, title } = otherTab.pendingLoad;
      tab = this.addTab(url, { index, pinned, lazy: true, title, icon: otherTab.favicon, select: false });
    } else {
      tab = this.addTab(null, { index, pinned, select: false, remoteType: otherTab.linkedBrowser.remoteType || null });
    }
    // Before the swap, as Firefox does: an open DevTools toolbox moves along
    // with its tab when it hears this.
    other._notify(otherTab, "TabClose", { adoptedBy: tab });
    if (!otherTab.pendingLoad) {
      this._swapBrowsers(tab, otherTab);
    }
    other.removeTab(otherTab, { skipPermitUnload: true, adopted: true });
    if (select || !this.selectedTab) {
      this.selectTab(tab);
    } else {
      tab.linkedBrowser.docShellIsActive = false;
    }
    return tab;
  }

  _swapBrowsers(tab, otherTab) {
    let other = otherTab.ownerDocument.defaultView.gBrowser;
    let browser = tab.linkedBrowser;
    let otherBrowser = otherTab.linkedBrowser;
    // Both browsers' webProgress objects change hands: detach first.
    other._removeProgressListener(otherTab);
    other._unregisterAudible(otherTab);
    this._removeProgressListener(tab);
    this._unregisterAudible(tab);
    browser.swapDocShells(otherBrowser);
    // The key session restore and others use to recognize a tab's browser.
    [browser.permanentKey, otherBrowser.permanentKey] = [otherBrowser.permanentKey, browser.permanentKey];
    browser.userTypedValue = otherBrowser.userTypedValue ?? null;
    for (let key of ["blockedTrackers", "securityState", "progress"]) {
      tab[key] = otherTab[key];
    }
    for (let attr of ["busy", "soundplaying", "muted", "sharing"]) {
      tab.toggleAttribute(attr, otherTab.hasAttribute(attr));
    }
    this._addProgressListener(tab);
    this._registerAudible(tab);
    this.setTabIcon(tab, otherTab.favicon ?? null);
    this._updateTabIdentity(tab);
  }

  /**
   * Opens a tab in a window of its own: dragged off the strip, or "Move to
   * new window". The new window adopts it (browser.js). screenX/screenY: where
   * it was dropped, where the platform lets windows be placed.
   */
  tearOffTab(tab, { screenX = null, screenY = null } = {}) {
    if (this.tabs.length < 2 || tab.closing) {
      return null;
    }
    let w = this.window;
    let features = ["chrome", "all", "dialog=no"];
    features.push(PrivateBrowsingUtils.isWindowPrivate(w) ? "private" : "non-private");
    if (w.windowState == w.STATE_NORMAL) {
      features.push(`width=${w.innerWidth}`, `height=${w.innerHeight}`);
    }
    if (screenX != null && this._hasScreenCoordinates) {
      features.push(`left=${Math.round(screenX - 80)}`, `top=${Math.round(screenY - 20)}`);
    }
    return w.openDialog(Services.prefs.getStringPref("browser.chromeURL"), "_blank", features.join(","), tab);
  }

  // Wayland gives windows no position on the screen: a window can't be
  // placed, and another window's tab strip can't be found under the pointer.
  get _hasScreenCoordinates() {
    try {
      return Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo).windowProtocol != "wayland";
    } catch (e) {
      return true;
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
      previous.linkedBrowser.closest(".browserSidebarContainer")?.removeAttribute("selected");
      // The other half of the same split view stays on screen.
      if (!previous.split || previous.split != tab.split) {
        previous.linkedBrowser.docShellIsActive = false;
      }
    }
    this._selectedTab = tab;
    tab.setAttribute("selected", "true");
    tab.setAttribute("aria-selected", "true");
    tab.setAttribute("tabindex", "0");
    let browser = tab.linkedBrowser;
    browser.setAttribute("selected", "true");
    browser.closest(".browserSidebarContainer")?.setAttribute("selected", "true");
    browser.docShellIsActive = this.window.windowState != this.window.STATE_MINIMIZED;
    this._loadPending(tab);
    this._updateSplitView();
    this.scrollTabIntoView(tab);
    this._notify(tab, "TabSelect", { previous });
  }

  // A restored tab loads when it is first shown.
  _loadPending(tab) {
    if (tab.pendingLoad) {
      let { url } = tab.pendingLoad;
      delete tab.pendingLoad;
      this.loadURL(tab.linkedBrowser, url);
    }
  }

  /** The pages on screen: the selected tab's, and its split partner's. */
  get shownBrowsers() {
    let tab = this.selectedTab;
    return tab ? (tab.split ? this._splitPair(tab.split) : [tab]).map(t => t.linkedBrowser) : [];
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
    let rest = this.tabs.filter(t => t != tab);
    if (this._isSplitInterior(rest, newIndex)) {
      newIndex += newIndex > oldIndex ? 1 : -1;
    }
    if (newIndex == oldIndex) {
      return;
    }
    this.tabs.splice(oldIndex, 1);
    this.tabs.splice(newIndex, 0, tab);
    this.tabContainer.insertBefore(tab, this.tabs[newIndex + 1] ?? null);
    // Moved away from its other half, a tab leaves split view.
    let partner = this.splitPartner(tab);
    if (partner && Math.abs(this.tabs.indexOf(partner) - newIndex) != 1) {
      this.unsplitTab(tab);
    } else if (partner) {
      this._updateSplitAttributes();
      this._updateSplitView();
    }
    this._notify(tab, "TabMove", { oldIndex, newIndex });
  }

  // Whether index, in tabs, falls between the two halves of a split view.
  _isSplitInterior(tabs, index) {
    let before = tabs[index - 1];
    return !!before?.split && before.split == tabs[index]?.split;
  }

  moveSelectedTab(direction) {
    this.moveTab(this.selectedTab, this.tabs.indexOf(this.selectedTab) + direction);
  }

  setPinned(tab, pinned) {
    if (pinned == tab.hasAttribute("pinned")) {
      return;
    }
    // Pinned tabs don't split.
    this.unsplitTab(tab);
    // Move first so the tab lands at the edge of the pinned group.
    this.moveTab(tab, this._firstUnpinnedIndex() - (pinned ? 0 : 1));
    tab.toggleAttribute("pinned", pinned);
    this._notify(tab, "TabAttrModified");
  }

  // ---------------------------------------------------------------------
  // Split view

  /**
   * Shows two tabs' pages side by side: tab (from this window or another,
   * as dragged onto target) goes next to target, after it. Either may have
   * been in another split view; it leaves that one.
   * ratio: the first page's share of the width. select: select tab.
   */
  splitTabs(target, tab, { ratio = 0.5, select = true } = {}) {
    if (!this.canSplit(target, tab)) {
      return null;
    }
    if (tab.ownerDocument != this.document) {
      tab = this.adoptTab(tab, { index: this.tabs.indexOf(target) + 1, select: false });
    }
    this.unsplitTab(target);
    this.unsplitTab(tab);
    let at = this.tabs.indexOf(target);
    this.moveTab(tab, this.tabs.indexOf(tab) < at ? at : at + 1);
    let split = { tabs: [target, tab], ratio };
    target.split = tab.split = split;
    this._updateSplitAttributes();
    if (select && this.selectedTab != tab) {
      this.selectTab(tab);
    } else {
      this._updateSplitView();
    }
    this._notify(tab, "TabSplit", { partner: target });
    return split;
  }

  // Two different tabs, neither pinned, not already split together.
  canSplit(target, tab) {
    return (
      !!target &&
      !!tab &&
      target != tab &&
      !target.closing &&
      !tab.closing &&
      !target.hasAttribute("pinned") &&
      !tab.hasAttribute("pinned") &&
      (!tab.split || tab.split != target.split)
    );
  }

  /** Ends the split view tab is in; both tabs stay, as ordinary tabs. */
  unsplitTab(tab) {
    let split = tab?.split;
    if (!split) {
      return;
    }
    for (let t of split.tabs) {
      delete t.split;
    }
    this._updateSplitAttributes();
    this._updateSplitView();
    this._notify(tab, "TabUnsplit");
  }

  splitPartner(tab) {
    return tab?.split?.tabs.find(t => t != tab) ?? null;
  }

  // A split view's two tabs in strip order.
  _splitPair(split) {
    return [...split.tabs].sort((a, b) => this.tabs.indexOf(a) - this.tabs.indexOf(b));
  }

  // In the strip, a split view's tabs read as one: split="start"/"end".
  _updateSplitAttributes() {
    for (let t of this.tabs) {
      if (t.split) {
        t.setAttribute("split", this._splitPair(t.split)[0] == t ? "start" : "end");
      } else {
        t.removeAttribute("split");
      }
    }
  }

  // Lays out the pages on screen: the selected tab's alone, or both halves
  // of its split view, which are both active (rendering, at full speed).
  _updateSplitView() {
    let tab = this.selectedTab;
    let shown = tab?.split ? this._splitPair(tab.split) : [];
    let active = this.window.windowState != this.window.STATE_MINIMIZED;
    for (let t of this._splitShown) {
      if (!shown.includes(t)) {
        t.removeAttribute("split-shown");
        t.linkedBrowser.closest(".browserSidebarContainer")?.removeAttribute("split-side");
        if (t != tab && this.tabs.includes(t)) {
          t.linkedBrowser.docShellIsActive = false;
        }
      }
    }
    shown.forEach((t, i) => {
      t.setAttribute("split-shown", "true");
      t.linkedBrowser.closest(".browserSidebarContainer").setAttribute("split-side", i ? "end" : "start");
      if (t != tab) {
        t.linkedBrowser.docShellIsActive = active;
        this._loadPending(t);
      }
    });
    this._splitShown = shown;
    this.browserContainer.toggleAttribute("split", !!shown.length);
    this._splitter.hidden = !shown.length;
    this._applySplitRatio();
  }

  _applySplitRatio() {
    let split = this.selectedTab?.split;
    this.browserContainer.style.gridTemplateColumns = split
      ? `minmax(0, ${split.ratio}fr) auto minmax(0, ${1 - split.ratio}fr)`
      : "";
  }

  _setSplitRatio(split, ratio) {
    if (!split) {
      return;
    }
    split.ratio = Math.min(1 - MIN_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
    this._applySplitRatio();
    // Session restore keeps the sizes.
    this._notify(split.tabs[0], "TabAttrModified");
  }

  // Dragging the bar between the pages resizes them; a double-click evens
  // them out.
  _onSplitterPointerDown(event) {
    let split = this.selectedTab?.split;
    if (event.button != 0 || !split) {
      return;
    }
    event.preventDefault();
    let box = this.browserContainer.getBoundingClientRect();
    let rtl = this.window.getComputedStyle(this.browserContainer).direction == "rtl";
    let splitter = this._splitter;
    try {
      // Over the pages, the pointer would otherwise go to them.
      splitter.setPointerCapture(event.pointerId);
    } catch (e) {}
    splitter.setAttribute("dragging", "true");
    let move = e => {
      let x = rtl ? box.right - e.clientX : e.clientX - box.left;
      this._setSplitRatio(split, x / box.width);
    };
    let up = () => {
      splitter.removeAttribute("dragging");
      this.window.removeEventListener("pointermove", move, true);
      this.window.removeEventListener("pointerup", up, true);
      this.window.removeEventListener("pointercancel", up, true);
    };
    this.window.addEventListener("pointermove", move, true);
    this.window.addEventListener("pointerup", up, true);
    this.window.addEventListener("pointercancel", up, true);
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
      case "dragstart":
        this._onDragStart(event);
        break;
      case "dragend":
        this._onDragEnd(event);
        break;
      case "dragover":
        this._onDragOver(event);
        break;
      case "dragleave":
        this._onDragLeave(event);
        break;
      case "drop":
        this._onDrop(event);
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
      case "focus": {
        // Clicking into the other page of a split view selects its tab.
        let tab = event.target.localName == "browser" ? this.getTabForBrowser(event.target) : null;
        if (tab?.split && tab != this.selectedTab && tab.split == this.selectedTab?.split) {
          this.selectTab(tab);
        }
        break;
      }
      case "oop-browser-crashed":
      case "oop-browser-buildid-mismatch":
        this._onBrowserCrashed(event);
        break;
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
        // DevTools follows the page into its new process.
        this._notify(tab, "TabRemotenessChange");
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
  // Dragging tabs: native drag and drop, as in Firefox, so the desktop
  // carries a tab between windows (Wayland tells a window nothing about the
  // pointer outside it otherwise). Along the strip a tab reorders; on
  // another window's strip it joins that window there, elsewhere in a
  // browser window at the end; let go outside every window, it opens in a
  // window of its own. Other apps get its address. Let go over the middle
  // of another tab, the two tabs split the window (a preview shows them
  // side by side in the tab first).

  _onDragStart(event) {
    let tab = event.target.closest?.(".tab");
    if (!tab || tab.closing || event.target.closest(".tab-close")) {
      return;
    }
    let dt = event.dataTransfer;
    dt.mozSetDataAt(TAB_DROP_TYPE, tab, 0);
    let url = tab.pendingLoad?.url ?? tab.linkedBrowser.currentURI?.spec;
    if (url && url != "about:blank") {
      let title = tab.querySelector(".tab-label").textContent;
      dt.mozSetDataAt("text/x-moz-url", `${url}\n${title}`, 0);
      dt.mozSetDataAt("text/uri-list", url, 0);
      dt.mozSetDataAt("text/plain", url, 0);
    }
    dt.effectAllowed = "copyMove";
    let r = tab.getBoundingClientRect();
    dt.setDragImage(tab, event.clientX - r.left, event.clientY - r.top);
    this.selectTab(tab);
    tab.setAttribute("dragging", "true");
  }

  _onDragEnd(event) {
    let tab = event.target.closest?.(".tab");
    if (!tab) {
      return;
    }
    tab.removeAttribute("dragging");
    this._clearDropGap();
    this._clearSplitPreview();
    let dt = event.dataTransfer;
    // Taken by a strip or a window (dropEffect set), or cancelled (Escape).
    if (dt.dropEffect != "none" || dt.mozUserCancelled || tab.closing || !this.tabs.includes(tab)) {
      return;
    }
    // Let go outside every browser window.
    this.tearOffTab(tab, { screenX: event.screenX, screenY: event.screenY });
  }

  // The tab being dragged, if it is one of this browser's (from any window).
  _draggedTab(event) {
    let dt = event.dataTransfer;
    if (!dt?.types.includes(TAB_DROP_TYPE)) {
      return null;
    }
    let tab = dt.mozGetDataAt(TAB_DROP_TYPE, 0);
    let win = tab?.ownerDocument?.defaultView;
    if (!win?.gBrowser || tab.closing || PrivateBrowsingUtils.isWindowPrivate(win) != PrivateBrowsingUtils.isWindowPrivate(this.window)) {
      return null;
    }
    return tab;
  }

  // Where a tab dropped at clientX goes in this strip, among the tabs of its
  // kind (pinned or not): an index into the strip without that tab. Tabs
  // count by where they are laid out, not where they slid to make room.
  _dropIndex(clientX, tab) {
    let pinned = tab.hasAttribute("pinned");
    let others = this.tabs.filter(t => t != tab);
    let group = others.filter(t => t.hasAttribute("pinned") == pinned);
    let laidOut = t => {
      let r = t.getBoundingClientRect();
      // Where it is right now, sliding included.
      let slid = new this.window.DOMMatrix(this.window.getComputedStyle(t).transform).m41;
      return { left: r.left - slid, width: r.width };
    };
    let before = group.filter(t => {
      let r = laidOut(t);
      return r.left + r.width / 2 < clientX;
    }).length;
    let index = (pinned ? 0 : others.filter(t => t.hasAttribute("pinned")).length) + before;
    // Not between a split view's tabs: beside them, on the nearer side.
    if (this._isSplitInterior(others, index)) {
      index += clientX < laidOut(others[index]).left ? -1 : 1;
    }
    return index;
  }

  // The tab a dragged tab would split the window with: the one whose middle
  // half it is over (the outer quarters reorder).
  _splitTarget(event, tab) {
    let target = event.target.closest?.(".tab");
    if (!target || target.ownerDocument != this.document || !this.canSplit(target, tab)) {
      return null;
    }
    let r = target.getBoundingClientRect();
    let x = event.clientX - r.left;
    return x > r.width / 4 && x < (r.width * 3) / 4 ? target : null;
  }

  // The preview: the target tab shows both tabs side by side, as they would
  // sit once split.
  _showSplitPreview(target, tab) {
    if (this._splitPreview?.target == target) {
      return;
    }
    this._clearSplitPreview();
    let preview = this.document.createElement("span");
    preview.className = "tab-split-preview";
    for (let t of [target, tab]) {
      let half = this.document.createElement("span");
      half.className = "tab-split-preview-half";
      half.append(t.querySelector(".tab-icon").cloneNode(true), t.querySelector(".tab-label").cloneNode(true));
      preview.append(half);
    }
    preview.lastChild.setAttribute("dragged", "true");
    target.append(preview);
    target.setAttribute("split-target", "true");
    this._splitPreview = { target, preview };
  }

  _clearSplitPreview() {
    if (this._splitPreview) {
      this._splitPreview.preview.remove();
      this._splitPreview.target.removeAttribute("split-target");
      this._splitPreview = null;
    }
  }

  // Shows where the tab would land: the tabs slide to make room for it,
  // and a tab of this window slides there itself.
  _showDropGap(tab, index) {
    let own = tab.ownerDocument == this.document;
    let width = tab.getBoundingClientRect().width;
    let shift = (t, px) => {
      t.dropShift = px;
      t.style.transform = px ? `translateX(${px}px)` : "";
    };
    this.tabContainer.setAttribute("reordering", "true");
    let rest = this.tabs.filter(t => t != tab);
    rest.forEach((t, i) => {
      let slot = i < index ? i : i + 1;
      let current = own ? this.tabs.indexOf(t) : i;
      shift(t, (slot - current) * width);
    });
    if (own) {
      shift(tab, (index - this.tabs.indexOf(tab)) * width);
    }
  }

  _clearDropGap() {
    for (let t of this.tabs) {
      t.dropShift = 0;
      t.style.transform = "";
    }
    this.tabContainer.removeAttribute("reordering");
  }

  // Near either end of a strip that scrolls, it scrolls along.
  _autoScrollForDrag(clientX) {
    let strip = this.tabContainer;
    let box = strip.getBoundingClientRect();
    let EDGE = 40;
    if (strip.scrollWidth <= strip.clientWidth) {
      return;
    }
    if (clientX < box.left + EDGE) {
      strip.scrollLeft -= 14;
    } else if (clientX > box.right - EDGE) {
      strip.scrollLeft += 14;
    }
  }

  _onDragOver(event) {
    let tab = this._draggedTab(event);
    if (!tab) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (event.target.closest?.("#tab-strip")) {
      this._autoScrollForDrag(event.clientX);
      let target = this._splitTarget(event, tab);
      if (target) {
        // The other tabs stay where they are meanwhile.
        this._showSplitPreview(target, tab);
      } else {
        this._clearSplitPreview();
        this._showDropGap(tab, this._dropIndex(event.clientX, tab));
      }
    } else {
      this._clearDropGap();
      this._clearSplitPreview();
    }
  }

  _onDragLeave(event) {
    // Off the strip (not just from one tab to the next).
    if (!event.relatedTarget?.closest?.("#tab-strip")) {
      this._clearDropGap();
      this._clearSplitPreview();
    }
  }

  _onDrop(event) {
    let tab = this._draggedTab(event);
    if (!tab) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    let onStrip = !!event.target.closest?.("#tab-strip");
    let target = onStrip ? this._splitTarget(event, tab) : null;
    let index = onStrip ? this._dropIndex(event.clientX, tab) : this.tabs.length;
    this._clearDropGap();
    this._clearSplitPreview();
    if (target) {
      this.splitTabs(target, tab);
      this.window.focus();
      return;
    }
    if (tab.ownerDocument == this.document) {
      // On its own window's page: nothing to do.
      if (onStrip) {
        this.moveTab(tab, index);
        this.scrollTabIntoView(tab);
      }
      return;
    }
    this.adoptTab(tab, { index });
    this.window.focus();
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
        // window.print(): the page has made a copy of itself to print, and
        // the print preview takes it (printing.js).
        return PrintUtils.handleStaticCloneCreatedForPrint(openWindowInfo);
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
