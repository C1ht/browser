/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Printing, with Gecko's own print preview: toolkit's printUtils.js
 * (PrintUtils) and print.html, unchanged, as Firefox uses them. They open
 * the preview in a dialog over the tab's page, through
 * gBrowser.getTabDialogBox(browser), which is the TabDialogBox below.
 *
 * Ctrl+P and the app menu's Print print the selected tab; a page's
 * window.print() reaches PrintUtils through the tab browser's
 * nsIBrowserDOMWindow (OPEN_PRINT_BROWSER). The preview offers the
 * printers the desktop knows (CUPS) and Save to PDF.
 */

// printUtils.js uses XPCOMUtils as a global, as Firefox's window has it.
var { XPCOMUtils } = ChromeUtils.importESModule("resource://gre/modules/XPCOMUtils.sys.mjs");

ChromeUtils.defineESModuleGetters(this, {
  SubDialogManager: "resource://gre/modules/SubDialog.sys.mjs",
});

// Loaded on first use. print.js, in the dialog, reads PrintUtils from
// this window.
XPCOMUtils.defineLazyScriptGetter(this, "PrintUtils", "chrome://global/content/printUtils.js");

/**
 * Dialogs over one tab's page (Firefox's TabDialogBox, without the content
 * prompts and tab-switch permission this browser doesn't use). They queue,
 * cover only that page, go away with the tab and when its page navigates to
 * another site, and switch with the tab like the page does.
 */
class TabDialogBox {
  constructor(browser) {
    this._weakBrowserRef = Cu.getWeakReference(browser);
    let template = document.getElementById("dialogStackTemplate");
    let dialogStack = template.content.cloneNode(true).firstElementChild;
    dialogStack.classList.add("tab-prompt-dialog");
    // Over the page only, not a docked DevTools toolbox.
    browser.closest(".browserStack").append(dialogStack);
    this._tabDialogManager = new SubDialogManager({
      dialogStack,
      dialogTemplate: dialogStack.firstElementChild,
      orderType: SubDialogManager.ORDER_QUEUE,
      allowDuplicateDialogs: true,
      dialogOptions: { consumeOutsideClicks: false },
    });
  }

  /**
   * Opens aURL in a dialog over the page; aParams go to it as window
   * arguments. Returns { closedPromise, dialog }.
   */
  open(aURL, { features = null, allowDuplicateDialogs = true, sizeTo, keepOpenSameOriginNav } = {}, ...aParams) {
    let resolveClosed;
    let closedPromise = new Promise(resolve => (resolveClosed = resolve));
    let manager = this._tabDialogManager;
    let webProgress = this.browser.webProgress;
    if (!manager.hasDialogs) {
      this._onFirstDialogOpen(webProgress);
    }
    let dialog = manager.open(
      aURL,
      {
        features,
        allowDuplicateDialogs,
        sizeTo,
        closingCallback: () => {
          if (!manager.hasDialogs) {
            this._onLastDialogClose(webProgress);
          }
        },
        closedCallback: resolveClosed,
      },
      ...aParams
    );
    if (dialog) {
      dialog._keepOpenSameOriginNav = keepOpenSameOriginNav;
    }
    return { closedPromise, dialog };
  }

  _onFirstDialogOpen(webProgress) {
    this.browser.setAttribute("tabDialogShowing", "true");
    this._lastPrincipal = this.browser.contentPrincipal;
    webProgress.addProgressListener(this, Ci.nsIWebProgress.NOTIFY_LOCATION);
    this._tab = this.tab;
    this._tab?.addEventListener("TabClose", this);
  }

  _onLastDialogClose(webProgress) {
    this._weakBrowserRef.get()?.removeAttribute("tabDialogShowing");
    try {
      webProgress.removeProgressListener(this);
    } catch (e) {
      // The page's process went away, and its listeners with it.
    }
    this._lastPrincipal = null;
    this._tab?.removeEventListener("TabClose", this);
    this._tab = null;
  }

  // The tab closed, or moved to another window (its page goes on there,
  // its dialogs don't).
  handleEvent(event) {
    if (event.type == "TabClose") {
      this.abortAllDialogs();
    }
  }

  abortAllDialogs() {
    this._tabDialogManager.abortDialogs();
  }

  focus() {
    if (this._tabDialogManager.hasDialogs) {
      this._tabDialogManager.focusTopDialog();
    }
  }

  // Leaving the page (or reloading it) closes its dialogs; a dialog that
  // asked to stays open within the same site.
  onLocationChange(aWebProgress, aRequest, aLocation, aFlags) {
    if (!aWebProgress.isTopLevel || aFlags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
      return;
    }
    let filterFn;
    if (this._lastPrincipal?.isSameOrigin(aLocation, this.browser.browsingContext.usePrivateBrowsing)) {
      filterFn = dialog => !dialog._keepOpenSameOriginNav;
    }
    this._lastPrincipal = this.browser.contentPrincipal;
    this._tabDialogManager.abortDialogs(filterFn);
  }

  get tab() {
    return gBrowser.getTabForBrowser(this.browser);
  }

  get browser() {
    let browser = this._weakBrowserRef.get();
    if (!browser) {
      throw new Error("Stale dialog box: its browser is gone.");
    }
    return browser;
  }

  getTabDialogManager() {
    return this._tabDialogManager;
  }
}
TabDialogBox.prototype.QueryInterface = ChromeUtils.generateQI([
  "nsIWebProgressListener",
  "nsISupportsWeakReference",
]);

var Printing = {
  /** Opens the print preview for the selected tab, or focuses the open one. */
  print(browser = gBrowser.selectedBrowser) {
    if (PrintUtils.getPreviewBrowser(browser)) {
      browser.tabDialogBox.focus();
      return;
    }
    PrintUtils.startPrintWindow(browser.browsingContext);
  },
};
