/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  ContentBlockingAllowList: "resource://gre/modules/ContentBlockingAllowList.sys.mjs",
  ContentBlockingLists: "resource://gre/modules/browserwip/ContentBlockingLists.sys.mjs",
  PrivacyModes: "resource://gre/modules/browserwip/PrivacyModes.sys.mjs",
  SessionStore: "resource://gre/modules/browserwip/SessionStore.sys.mjs",
});
const RESTORE_WINDOW_ARG = "browserwip:restore-window";

const NEW_TAB_URL = "about:newtab";
const WELCOME_URL = "about:welcome";
const SETTINGS_URL = "about:settings";

var gBrowser;
var gURLBar;

var BrowserWip = {
  startup() {
    this._setUpTitlebar();
    gBrowser = new TabBrowser(window);
    gURLBar = new URLBar(window, gBrowser);
    Letterbox.init(window);
    DownloadsUI.init(window).catch(console.error);
    BrowserContextMenu.init(window);
    PermissionPrompts.init(window);
    TabOverview.init(window);
    FullScreen.init(window);
    // Gecko asks this object where to open links and window.open() calls.
    window.browserDOMWindow = gBrowser.browserDOMWindow;

    this._wireButtons();
    this._wirePanels();
    // The network blocker failing or recovering changes the shield.
    let onBlockerState = () => gURLBar.update();
    Services.obs.addObserver(onBlockerState, "browserwip:blocker-state");
    window.addEventListener("unload", () => Services.obs.removeObserver(onBlockerState, "browserwip:blocker-state"), {
      once: true,
    });
    this._wireTabContextMenu();
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._onTabSelect());
    gBrowser.tabContainer.addEventListener("TabAttrModified", e => {
      if (e.target == gBrowser.selectedTab) {
        this._updateTitle();
      }
    });
    window.addEventListener("sizemodechange", () => {
      // Pages in a minimized window stop rendering and timers slow down.
      if (gBrowser.selectedBrowser) {
        gBrowser.selectedBrowser.docShellIsActive = window.windowState != window.STATE_MINIMIZED;
      }
    });
    window.addEventListener("close", e => {
      // The window manager's close button; tabs get a chance to object.
      e.preventDefault();
      this.closeWindow();
    });

    // Session restore keeps track of the tabs.
    for (let type of ["TabOpen", "TabClose", "TabSelect", "TabMove", "TabLocationChange", "TabAttrModified"]) {
      gBrowser.tabContainer.addEventListener(type, () => SessionStore.saveSoon());
    }
    window.addEventListener("unload", () => SessionStore.windowClosing(window));

    this._openInitialTabs().finally(() => {
      // Toolkit and the remote agent treat this as "the browser window is
      // ready", as Firefox's window sends it.
      Services.tm.idleDispatchToMainThread(() =>
        Services.obs.notifyObservers(window, "browser-delayed-startup-finished")
      );
    });
  },

  /**
   * The first tabs: a restored window, the previous session (at startup,
   * when it should come back), and any addresses from the command line, or
   * else the start page.
   */
  async _openInitialTabs() {
    if (window.arguments?.[0] == RESTORE_WINDOW_ARG) {
      let state = SessionStore.takePendingWindow();
      if (state) {
        this.restoreWindow(state);
        return;
      }
    }
    let session = null;
    try {
      session = await SessionStore.startupSession();
    } catch (e) {
      console.error(e);
    }
    let urls = this._initialURLs();
    if (session) {
      let [first, ...others] = session;
      this.restoreWindow(first);
      SessionStore.openWindows(window, others);
      // The start page is not needed next to restored tabs; addresses from
      // the command line are.
      urls = urls.filter(url => url != NEW_TAB_URL && url != WELCOME_URL);
    }
    for (let url of urls) {
      gBrowser.addTab(url, { select: !gBrowser.selectedTab || !!session });
    }
    if (!session && gURLBar.input.value == "" && urls[0] == NEW_TAB_URL) {
      gURLBar.focusAndSelect();
    }
  },

  /**
   * Opens a saved window's tabs here; they load when first selected.
   * replaceBlank: close this window's tab if it is a lone new-tab page.
   */
  restoreWindow(state, { replaceBlank = false } = {}) {
    let blank =
      replaceBlank &&
      gBrowser.tabs.length == 1 &&
      [NEW_TAB_URL, "about:blank"].includes(gBrowser.selectedBrowser.currentURI.spec)
        ? gBrowser.selectedTab
        : null;
    let tabs = state.tabs.map(saved =>
      gBrowser.addTab(saved.url, {
        lazy: true,
        title: saved.title,
        icon: saved.icon,
        pinned: saved.pinned,
        select: false,
      })
    );
    gBrowser.selectTab(tabs[state.selected] ?? tabs[0]);
    if (blank) {
      gBrowser.removeTab(blank, { skipPermitUnload: true });
    }
  },

  /** URLs for the first tabs: command-line arguments, or the start page. */
  _initialURLs() {
    if (this._urls) {
      return this._urls;
    }
    let urls = [];
    let arg = window.arguments?.[0];
    if (arg instanceof Ci.nsICommandLine) {
      for (let i = 0; i < arg.length; i++) {
        let a = arg.getArgument(i);
        if (a.startsWith("-")) {
          continue;
        }
        try {
          urls.push(arg.resolveURI(a).spec);
        } catch (e) {
          urls.push(a);
        }
      }
    } else if (typeof arg == "string" && arg != RESTORE_WINDOW_ARG) {
      urls.push(arg);
    }
    if (!urls.length) {
      urls.push(
        Services.prefs.getBoolPref("browserwip.firstrun.completed", false) ? NEW_TAB_URL : WELCOME_URL
      );
    }
    this._urls = urls;
    return urls;
  },

  // Handlers for the <command> elements in browser.xhtml. They live here
  // because the window's CSP forbids inline event handlers.
  COMMANDS: {
    cmd_newTab: () => BrowserWip.openNewTab(),
    cmd_closeTab: () => gBrowser.removeTab(gBrowser.selectedTab),
    cmd_reopenTab: () => gBrowser.reopenClosedTab(),
    cmd_focusUrlbar: () => gURLBar.focusAndSelect(),
    cmd_back: () => gBrowser.selectedBrowser.goBack(),
    cmd_forward: () => gBrowser.selectedBrowser.goForward(),
    cmd_reload: () => BrowserWip.reloadOrStop(),
    cmd_reloadSkipCache: () => BrowserWip.reload(true),
    cmd_nextTab: () => gBrowser.advanceSelectedTab(1),
    cmd_prevTab: () => gBrowser.advanceSelectedTab(-1),
    cmd_moveTabNext: () => gBrowser.moveSelectedTab(1),
    cmd_moveTabPrev: () => gBrowser.moveSelectedTab(-1),
    cmd_settings: () => BrowserWip.openSettings(),
    cmd_downloads: () => DownloadsUI.open(),
    cmd_restoreSession: () => SessionStore.restorePrevious(window),
    cmd_tabOverview: () => TabOverview.toggle(),
    cmd_newWindow: () => BrowserWip.openNewWindow(),
    cmd_closeWindow: () => BrowserWip.closeWindow(),
    cmd_quit: () => Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit),
    cmd_find: () => BrowserWip.find(),
    cmd_findAgain: () => BrowserWip.find({ again: true }),
    cmd_findPrevious: () => BrowserWip.find({ again: true, previous: true }),
  },

  // Find in page: one toolkit findbar per window, bound to the selected tab.
  find({ again = false, previous = false } = {}) {
    let findbar = document.getElementById("findbar");
    if (findbar.browser != gBrowser.selectedBrowser) {
      findbar.browser = gBrowser.selectedBrowser;
    }
    if (again && !findbar.hidden) {
      findbar.onFindAgainCommand(previous);
    } else {
      findbar.onFindCommand();
    }
  },

  // Windows: the app draws the title bar (decided in docs/PLAN.md). The
  // toolbar becomes the drag region and gets caption buttons. Linux keeps
  // the desktop's decorations.
  _setUpTitlebar() {
    if (AppConstants.platform != "win") {
      return;
    }
    document.documentElement.setAttribute("customtitlebar", "true");
    document.getElementById("window-controls").hidden = false;
    let on = (id, fn) => document.getElementById(id).addEventListener("click", fn);
    on("window-minimize", () => window.minimize());
    on("window-maximize", () => window.maximize());
    on("window-restore", () => window.restore());
    on("window-close", () => this.closeWindow());
  },

  _wireButtons() {
    for (let [id, handler] of Object.entries(this.COMMANDS)) {
      document.getElementById(id).addEventListener("command", handler);
    }
    document.addEventListener("click", e => {
      let button = e.target.closest("button[data-command]");
      if (button && !button.disabled) {
        document.getElementById(button.dataset.command).doCommand();
      }
    });
    let menuButton = document.getElementById("app-menu-button");
    let menu = document.getElementById("app-menu");
    menu.addEventListener("popupshowing", e => {
      if (e.target == menu) {
        // On the command: its menu item mirrors its state.
        document
          .getElementById("cmd_restoreSession")
          .toggleAttribute("disabled", !SessionStore.canRestorePrevious);
      }
    });
    menuButton.addEventListener("click", () => menu.openPopup(menuButton, "bottomright topright", 0, 4));
    menu.addEventListener("popupshowing", () => menuButton.setAttribute("open", "true"));
    menu.addEventListener("popuphidden", () => menuButton.removeAttribute("open"));
  },

  _onTabSelect() {
    let findbar = document.getElementById("findbar");
    if (!findbar.hidden) {
      findbar.close(true);
    }
    gURLBar.update();
    this._updateTitle();
    let browser = gBrowser.selectedBrowser;
    if (browser.userTypedValue != null || gURLBar.input.value == "") {
      gURLBar.focusAndSelect();
    } else {
      browser.focus();
    }
  },

  _updateTitle() {
    let title = gBrowser.selectedBrowser?.contentTitle;
    document.l10n.setAttributes(
      document.querySelector("title"),
      title ? "browser-main-window-title-page" : "browser-main-window-title",
      { title }
    );
  },

  updateNavButtons() {
    let browser = gBrowser.selectedBrowser;
    document.getElementById("back-button").disabled = !browser?.canGoBack;
    document.getElementById("forward-button").disabled = !browser?.canGoForward;
    let busy = gBrowser.selectedTab?.hasAttribute("busy");
    let reload = document.getElementById("reload-button");
    reload.querySelector("img").src = busy
      ? "chrome://browser-wip/skin/icons/stop.svg"
      : "chrome://browser-wip/skin/icons/reload.svg";
    document.l10n.setAttributes(reload, busy ? "stop-button" : "reload-button");
  },

  // -----------------------------------------------------------------------
  // Commands

  openNewTab() {
    gBrowser.addTab(NEW_TAB_URL);
    gURLBar.focusAndSelect();
  },

  /**
   * A link a page asked to open elsewhere (LinkClickParent): middle-click
   * and Ctrl+click open a background tab, with Shift a foreground one, as in
   * Firefox; Shift+click alone opens a window.
   *
   * @param {string} where  "tab", "tabshifted" or "window"
   * @param {object} params  browser (the page's), triggeringPrincipal,
   *   policyContainer, referrerInfo
   */
  openLink(url, where, { browser, ...params }) {
    if (where == "window") {
      this.openNewWindow(url);
      return;
    }
    let background = Services.prefs.getBoolPref("browser.tabs.loadInBackground", true);
    gBrowser.addTab(url, {
      select: (where == "tabshifted") == background,
      opener: gBrowser.getTabForBrowser(browser) ?? gBrowser.selectedTab,
      userGesture: true,
      ...params,
    });
  },

  openNewWindow(url = NEW_TAB_URL) {
    window.openDialog(
      Services.prefs.getStringPref("browser.chromeURL"),
      "_blank",
      "chrome,all,dialog=no",
      url
    );
  },

  openSettings() {
    let existing = gBrowser.tabs.find(t => t.linkedBrowser.currentURI?.spec.startsWith(SETTINGS_URL));
    if (existing) {
      gBrowser.selectTab(existing);
    } else {
      gBrowser.addTab(SETTINGS_URL);
    }
  },

  reloadOrStop() {
    if (gBrowser.selectedTab.hasAttribute("busy")) {
      gBrowser.selectedBrowser.stop();
    } else {
      this.reload(false);
    }
  },

  reload(skipCache) {
    let flags = skipCache
      ? Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE
      : Ci.nsIWebNavigation.LOAD_FLAGS_NONE;
    gBrowser.selectedBrowser.reloadWithFlags(flags);
  },

  async closeWindow() {
    for (let tab of gBrowser.tabs) {
      let { permitUnload } = await tab.linkedBrowser.asyncPermitUnload();
      if (!permitUnload) {
        gBrowser.selectTab(tab);
        return;
      }
    }
    window.close();
  },

  // -----------------------------------------------------------------------
  // Tab context menu

  _wireTabContextMenu() {
    let menu = document.getElementById("tab-context-menu");
    let target = null;
    gBrowser.tabContainer.addEventListener("contextmenu", e => {
      target = e.target.closest(".tab");
      if (!target) {
        return;
      }
      e.preventDefault();
      let pinned = target.hasAttribute("pinned");
      let muted = !!target.linkedBrowser.browsingContext?.mediaController?.muted;
      document.l10n.setAttributes(
        document.getElementById("tab-ctx-pin"),
        pinned ? "tab-context-unpin" : "tab-context-pin"
      );
      document.l10n.setAttributes(
        document.getElementById("tab-ctx-mute"),
        muted ? "tab-context-unmute" : "tab-context-mute"
      );
      document.getElementById("tab-ctx-mute").hidden = !target.hasAttribute("soundplaying") && !muted;
      document.getElementById("tab-ctx-close-others").disabled = gBrowser.tabs.length < 2;
      document.getElementById("tab-ctx-reopen").disabled = !gBrowser._closedTabs.length;
      menu.openPopupAtScreen(e.screenX, e.screenY, true, e);
    });
    let on = (id, fn) => document.getElementById(id).addEventListener("command", () => target && fn(target));
    on("tab-ctx-reload", tab => tab.linkedBrowser.reload());
    on("tab-ctx-duplicate", tab =>
      gBrowser.addTab(tab.linkedBrowser.currentURI.spec, { index: gBrowser.tabs.indexOf(tab) + 1 })
    );
    on("tab-ctx-pin", tab => gBrowser.setPinned(tab, !tab.hasAttribute("pinned")));
    on("tab-ctx-mute", tab => {
      let controller = tab.linkedBrowser.browsingContext?.mediaController;
      if (controller?.muted) {
        controller.unmute();
      } else {
        controller?.mute();
      }
      tab.toggleAttribute("muted", !!controller?.muted);
    });
    on("tab-ctx-close", tab => gBrowser.removeTab(tab));
    on("tab-ctx-close-others", tab => {
      for (let other of [...gBrowser.tabs]) {
        if (other != tab && !other.hasAttribute("pinned")) {
          gBrowser.removeTab(other);
        }
      }
    });
    on("tab-ctx-reopen", () => gBrowser.reopenClosedTab());
  },

  // -----------------------------------------------------------------------
  // Protections and site information panels

  // The network blocker isn't working (its engine failed to build or took
  // too long); nothing is blocked anywhere.
  protectionsUnavailable() {
    return ContentBlockingLists.unavailable;
  },

  protectionsDisabledFor(browser) {
    try {
      return ContentBlockingAllowList.canHandle(browser) && ContentBlockingAllowList.includes(browser);
    } catch (e) {
      return false;
    }
  },

  _wirePanels() {
    let protButton = document.getElementById("protections-button");
    let protPanel = document.getElementById("protections-panel");
    let toggle = document.getElementById("protections-toggle");
    protButton.addEventListener("click", () => {
      this._fillProtectionsPanel();
      protPanel.openPopup(protButton, "bottomright topright", 0, 4);
    });
    toggle.addEventListener("click", () => {
      let browser = gBrowser.selectedBrowser;
      if (this.protectionsDisabledFor(browser)) {
        ContentBlockingAllowList.remove(browser);
      } else {
        ContentBlockingAllowList.add(browser);
      }
      protPanel.hidePopup();
      browser.reload();
    });

    let idButton = document.getElementById("identity-button");
    let idPanel = document.getElementById("identity-panel");
    idButton.addEventListener("click", () => {
      if (gURLBar.input.value == "") {
        gURLBar.focusAndSelect();
        return;
      }
      this._fillIdentityPanel();
      idPanel.openPopup(idButton, "bottomleft topleft", 0, 4);
    });
  },

  _host() {
    try {
      return gBrowser.selectedBrowser.currentURI.displayHost;
    } catch (e) {
      return "";
    }
  },

  _fillProtectionsPanel() {
    let browser = gBrowser.selectedBrowser;
    let disabled = this.protectionsDisabledFor(browser);
    let count = gBrowser.selectedTab.blockedTrackers;
    let l10n = document.l10n;
    l10n.setAttributes(document.getElementById("protections-title"), "protections-title", {
      host: this._host(),
    });
    let summary = disabled
      ? "protections-summary-off"
      : this.protectionsUnavailable()
        ? "protections-summary-unavailable"
        : "protections-summary-on";
    l10n.setAttributes(document.getElementById("protections-summary"), summary, {
      count,
      mode: PrivacyModes.mode,
    });
    document.getElementById("protections-toggle").setAttribute("aria-checked", String(!disabled));
  },

  _fillIdentityPanel() {
    let state = document.getElementById("identity-button").getAttribute("state");
    document.l10n.setAttributes(document.getElementById("identity-title"), "identity-title", {
      host: this._host(),
    });
    document.l10n.setAttributes(
      document.getElementById("identity-summary"),
      state == "insecure" ? "identity-summary-insecure" : "identity-summary-secure"
    );
  },
};

window.addEventListener("DOMContentLoaded", () => BrowserWip.startup(), { once: true });
