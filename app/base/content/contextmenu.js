/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */
/* global searchURL, SEARCH_ENGINES */

"use strict";

/**
 * The right-click menu on pages.
 *
 * ContextMenuChild reports what was clicked; this shows the items that fit
 * it (link, image, video or audio, selection, editable field, or the page
 * itself) and carries them out. Saving goes through toolkit's
 * contentAreaUtils.js, so saved files appear in the downloads panel. Edit
 * commands go to the page through its <browser>'s controller, as in
 * Firefox; Copy image asks the page for the image as PNG.
 */

ChromeUtils.defineESModuleGetters(this, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

// Toolkit's saving and link-checking helpers (saveURL, saveBrowser,
// urlSecurityCheck). Loaded into a scope of their own, which falls back to
// this window, because the script declares globals (AppConstants, Downloads)
// that this window's scripts already define.
ChromeUtils.defineLazyGetter(this, "ContentAreaUtilsScope", () => {
  let scope = Cu.Sandbox(window, { sandboxPrototype: window, wantXrays: false, sameZoneAs: window });
  Services.scriptloader.loadSubScript("chrome://global/content/contentAreaUtils.js", scope);
  return scope;
});

var BrowserContextMenu = {
  init(window) {
    this.window = window;
    this.menu = window.document.getElementById("content-context-menu");
    this.menu.addEventListener("command", e => this._onCommand(e.target.id));
    this.menu.addEventListener("popuphidden", e => {
      if (e.target == this.menu) {
        this.browser = this.data = null;
      }
    });
  },

  open(browser, data) {
    if (browser != gBrowser.selectedBrowser) {
      return;
    }
    this.browser = browser;
    this.data = data;
    let doc = this.window.document;

    let on = {
      link: !!data.linkURL,
      image: !!data.imageURL,
      media: !!data.mediaURL,
      selection: !!data.selection,
      editable: data.editable,
    };
    on.page = !on.link && !on.image && !on.media && !on.selection && !on.editable;
    // Copy and Search for selected text; editable fields have their own Copy.
    on["selection-only"] = on.selection && !on.editable;

    for (let item of this.menu.children) {
      let show = item.dataset.show?.split(" ");
      item.hidden = show ? !show.some(k => on[k]) : false;
    }
    this._tidySeparators();

    // Enabled states.
    let enable = (id, enabled) => doc.getElementById(id).toggleAttribute("disabled", !enabled);
    enable("context-back", browser.canGoBack);
    enable("context-forward", browser.canGoForward);
    for (let [id, command] of [
      ["context-undo", "cmd_undo"],
      ["context-cut", "cmd_cut"],
      ["context-copy-edit", "cmd_copy"],
      ["context-paste", "cmd_paste"],
      ["context-delete", "cmd_delete"],
    ]) {
      enable(id, !data.readOnly && this._commandEnabled(command));
    }

    if (data.mediaType) {
      for (let id of ["context-openmedia", "context-copymedia", "context-savemedia"]) {
        doc.l10n.setArgs(doc.getElementById(id), { type: data.mediaType });
      }
    }
    if (on.selection) {
      let text = data.selection.replace(/\s+/g, " ");
      doc.l10n.setAttributes(doc.getElementById("context-search"), "context-search", {
        engine: SEARCH_ENGINES[Services.prefs.getStringPref("browserwip.search.engine", "brave")]?.name ??
          SEARCH_ENGINES.brave.name,
        text: text.length > 15 ? text.slice(0, 15) + "…" : text,
      });
    }

    let scale = this.window.devicePixelRatio;
    this.menu.openPopupAtScreen(data.screenX / scale, data.screenY / scale, true);
  },

  // Hide separators at the edges and next to each other.
  _tidySeparators() {
    let previous = null;
    for (let item of this.menu.children) {
      if (item.localName == "menuseparator") {
        item.hidden = !previous || previous.localName == "menuseparator";
        if (!item.hidden) {
          previous = item;
        }
      } else if (!item.hidden) {
        previous = item;
      }
    }
    if (previous?.localName == "menuseparator") {
      previous.hidden = true;
    }
  },

  // The <browser>'s controller forwards these to the focused page.
  _controller(command) {
    return this.window.document.commandDispatcher.getControllerForCommand(command);
  },

  _commandEnabled(command) {
    return !!this._controller(command)?.isCommandEnabled(command);
  },

  _doCommand(command) {
    let controller = this._controller(command);
    if (controller?.isCommandEnabled(command)) {
      controller.doCommand(command);
    }
  },

  // Links from a page open with the page's principal, after the same check
  // Firefox makes (no file: or chrome: links from the web).
  _openTab(url, referrerInfo, { select = false } = {}) {
    let { principal } = this.data;
    try {
      ContentAreaUtilsScope.urlSecurityCheck(url, principal);
    } catch (e) {
      return;
    }
    gBrowser.addTab(url, {
      select,
      opener: gBrowser.selectedTab,
      triggeringPrincipal: principal,
      referrerInfo: referrerInfo && E10SUtils.deserializeReferrerInfo(referrerInfo),
    });
  },

  _save(url, titleKey) {
    let { principal, referrerInfo, cookieJarSettings } = this.data;
    try {
      ContentAreaUtilsScope.urlSecurityCheck(url, principal);
    } catch (e) {
      return;
    }
    ContentAreaUtilsScope.saveURL(
      url,
      null, // original URL
      null, // file name: from the response
      titleKey,
      false, // bypass cache
      false, // skip prompt: "Save as" always asks
      E10SUtils.deserializeReferrerInfo(referrerInfo),
      E10SUtils.deserializeCookieJarSettings(cookieJarSettings),
      null, // source document: none in this process
      false, // private window
      principal
    );
  },

  _copy(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
  },

  _onCommand(id) {
    let data = this.data;
    let browser = this.browser;
    if (!data || !browser) {
      return;
    }
    let mediaTitle = data.mediaType == "audio" ? "SaveAudioTitle" : "SaveVideoTitle";
    switch (id) {
      // Links
      case "context-openlink-tab":
        this._openTab(data.linkURL, data.linkReferrerInfo);
        break;
      case "context-openlink-window":
        try {
          ContentAreaUtilsScope.urlSecurityCheck(data.linkURL, data.principal);
          BrowserWip.openNewWindow(data.linkURL);
        } catch (e) {
          // A link the page may not open.
        }
        break;
      case "context-copylink":
        this._copy(data.linkURL);
        break;
      case "context-savelink":
        this._save(data.linkURL, "SaveLinkTitle");
        break;
      // Images
      case "context-openimage":
        this._openTab(data.imageURL, data.referrerInfo);
        break;
      case "context-copyimage":
        data.actor
          .sendQuery("ContextMenu:ImageAsPNG")
          .then(png => png && BrowserUtils.copyImageToClipboard(png))
          .catch(console.error);
        break;
      case "context-copyimage-link":
        this._copy(data.imageURL);
        break;
      case "context-saveimage":
        this._save(data.imageURL, "SaveImageTitle");
        break;
      // Video and audio
      case "context-openmedia":
        this._openTab(data.mediaURL, data.referrerInfo);
        break;
      case "context-copymedia":
        this._copy(data.mediaURL);
        break;
      case "context-savemedia":
        this._save(data.mediaURL, mediaTitle);
        break;
      // Selection
      case "context-copy":
      case "context-copy-edit":
        this._doCommand("cmd_copy");
        break;
      case "context-search":
        gBrowser.addTab(searchURL(data.selection), { opener: gBrowser.selectedTab });
        break;
      // Editable fields
      case "context-undo":
        this._doCommand("cmd_undo");
        break;
      case "context-cut":
        this._doCommand("cmd_cut");
        break;
      case "context-paste":
        this._doCommand("cmd_paste");
        break;
      case "context-delete":
        this._doCommand("cmd_delete");
        break;
      case "context-selectall":
        this._doCommand("cmd_selectAll");
        break;
      // The page
      case "context-back":
        browser.goBack();
        break;
      case "context-forward":
        browser.goForward();
        break;
      case "context-reload":
        BrowserWip.reload();
        break;
      case "context-savepage":
        ContentAreaUtilsScope.saveBrowser(browser);
        break;
      case "context-viewsource":
        gBrowser.addTab("view-source:" + browser.currentURI.spec, { opener: gBrowser.selectedTab });
        break;
    }
  },
};
