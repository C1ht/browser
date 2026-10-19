/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Fullscreen for pages: a video's fullscreen button, or any page calling
 * requestFullscreen().
 *
 * DOMFullscreenParent/Child carry the handshake between the window and the
 * page's processes; this is the window's half, adapted from FullScreen in
 * Firefox's browser-fullScreenAndPointerLock.js. Gecko puts the page's
 * <browser> in fullscreen and fills the screen with it; the toolbar and tab
 * strip are hidden while :root has inDOMFullscreen (browser.css).
 *
 * A bar at the top names the site for a few seconds, and again when the
 * pointer touches the top edge, so a page can't pass itself off as the
 * browser. Esc leaves fullscreen (Gecko handles it), and so do switching
 * tabs and the bar's button.
 */

var FullScreen = {
  init(window) {
    this.window = window;
    let doc = window.document;
    this.warning = doc.getElementById("fullscreen-warning");
    this.warningText = doc.getElementById("fullscreen-warning-text");
    doc.getElementById("fullscreen-exit-button").addEventListener("click", () => this.exitDomFullScreen());
    this._onTabSelect = () => this.exitDomFullScreen();
    this._onMouseMove = e => this._onPointerMove(e);
  },

  get inDomFullscreen() {
    return this.window.document.documentElement.hasAttribute("inDOMFullscreen");
  },

  exitDomFullScreen() {
    let doc = FullScreen.window.document;
    if (doc.fullscreen) {
      doc.exitFullscreen().catch(() => {});
    }
  },

  /**
   * The window has entered fullscreen for `browser`; finish the handshake
   * with the page's processes, then hide the browser's own UI.
   */
  enterDomFullscreen(browser, actor) {
    let doc = this.window.document;
    if (!doc.fullscreenElement) {
      actor.requestOrigin = null;
      return;
    }

    // Tell the page's processes to enter fullscreen, starting with the
    // highest frame in another process than the requester (an embedded
    // player's page, before the player). This runs before the checks below:
    // the page checks for itself that the request is still valid.
    if (browser?.isRemoteBrowser) {
      let [target, inProcessBC] = this._getNextMsgRecipientActor(actor, false);
      if (!target) {
        this._abortEnterFullscreen();
        return;
      }
      // If its process dies before answering, the actor aborts.
      target.waitingForChildEnterFullscreen = true;
      target.sendAsyncMessage("DOMFullscreen:Entered", { remoteFrameBC: inProcessBC });
      if (inProcessBC) {
        // More frames to go; this is called again for each.
        return;
      }
    }

    // Only the visible tab, in the window the user is in, may stay in
    // fullscreen.
    if (!browser || browser != gBrowser.selectedBrowser || Services.focus.activeWindow != this.window) {
      this._abortEnterFullscreen();
      return;
    }

    doc.documentElement.setAttribute("inDOMFullscreen", "true");
    let findbar = doc.getElementById("findbar");
    if (!findbar.hidden) {
      findbar.close(true);
    }
    TabOverview.close();
    gBrowser.tabContainer.addEventListener("TabSelect", this._onTabSelect);
  },

  /**
   * Fullscreen is ending: tell the page's processes, from the highest
   * out-of-process frame down; each answers and this runs again. Once they
   * have, bring the browser's UI back.
   *
   * @returns {boolean} whether a reply from the page is awaited
   */
  cleanupDomFullscreen(actor) {
    let waiting = false;
    let [target, inProcessBC] = this._getNextMsgRecipientActor(actor, true);
    if (target) {
      waiting = true;
      target.waitingForChildExitFullscreen = true;
      target.sendAsyncMessage("DOMFullscreen:CleanUp", { remoteFrameBC: inProcessBC });
      if (inProcessBC) {
        return waiting;
      }
    }
    this._hideWarning();
    gBrowser.tabContainer.removeEventListener("TabSelect", this._onTabSelect);
    this.window.document.documentElement.removeAttribute("inDOMFullscreen");
    return waiting;
  },

  _abortEnterFullscreen() {
    // Called while the change is in progress, so not synchronously.
    this.window.setTimeout(() => this.window.document.exitFullscreen().catch(() => {}), 0);
  },

  /**
   * The next actor to message: the first ancestor frame of `actor`'s that
   * lives in another process, with the frame below it that is in that
   * process ([actor, browsingContext]), or else the request's origin
   * ([actor, null]). [null, null] when that actor is gone or in the
   * back-forward cache.
   */
  _getNextMsgRecipientActor(actor, useCache) {
    if (useCache && actor.nextMsgRecipient) {
      let next = actor.nextMsgRecipient;
      while (next) {
        let [candidate] = next;
        if (!candidate.hasBeenDestroyed() && candidate.windowContext && !candidate.windowContext.isInBFCache) {
          return next;
        }
        next = candidate.nextMsgRecipient;
      }
    }
    if (actor.hasBeenDestroyed()) {
      return [null, null];
    }

    let childBC = actor.browsingContext;
    let parentBC = childBC.parent;
    while (parentBC) {
      if (!childBC.currentWindowGlobal || !parentBC.currentWindowGlobal) {
        break;
      }
      if (childBC.currentWindowGlobal.osPid != parentBC.currentWindowGlobal.osPid) {
        break;
      }
      childBC = parentBC;
      parentBC = childBC.parent;
    }

    let target = null;
    let inProcessBC = null;
    if (parentBC?.currentWindowGlobal) {
      target = parentBC.currentWindowGlobal.getActor("DOMFullscreen");
      inProcessBC = childBC;
      actor.nextMsgRecipient = [target, inProcessBC];
    } else {
      target = actor.requestOrigin;
    }
    if (!target || target.hasBeenDestroyed() || target.windowContext?.isInBFCache) {
      return [null, null];
    }
    return [target, inProcessBC];
  },

  // -----------------------------------------------------------------------
  // The "site is full screen" bar

  /** Shows the bar for the site at the top of `browsingContext`. */
  showWarning(browsingContext) {
    let doc = this.window.document;
    let host = "";
    try {
      let origin = browsingContext.top.currentWindowGlobal.documentPrincipal.originNoSuffix;
      host = Services.io.newURI(origin).displayHost;
    } catch (e) {
      // Pages without a host (a local file, PDF viewer) get the plain text.
    }
    if (host) {
      doc.l10n.setAttributes(this.warningText, "fullscreen-warning-host", { host });
    } else {
      doc.l10n.setAttributes(this.warningText, "fullscreen-warning-page");
    }
    this.window.addEventListener("mousemove", this._onMouseMove, true);
    let timeout = Services.prefs.getIntPref("full-screen-api.warning.timeout", 3000);
    if (timeout > 0) {
      this._reveal(timeout);
    }
  },

  _reveal(timeout) {
    if (!this.warning.matches(":popover-open")) {
      this.warning.showPopover();
    }
    this.warning.setAttribute("shown", "true");
    this.window.clearTimeout(this._hideTimer);
    this._hideTimer = this.window.setTimeout(() => this.warning.removeAttribute("shown"), timeout);
  },

  // Touching the top edge brings the bar back; moving well away hides it.
  _onPointerMove(event) {
    if (!this.inDomFullscreen) {
      return;
    }
    if (event.clientY <= 0) {
      this._reveal(Services.prefs.getIntPref("full-screen-api.warning.timeout", 3000));
    } else if (
      this.warning.hasAttribute("shown") &&
      event.clientY > this.warning.getBoundingClientRect().bottom + 50
    ) {
      this.window.clearTimeout(this._hideTimer);
      this.warning.removeAttribute("shown");
    }
  },

  _hideWarning() {
    this.window.removeEventListener("mousemove", this._onMouseMove, true);
    this.window.clearTimeout(this._hideTimer);
    this.warning.removeAttribute("shown");
    if (this.warning.matches(":popover-open")) {
      this.warning.hidePopover();
    }
    // Keys go back to the page, not the (hidden) bar's button.
    gBrowser.selectedBrowser?.focus();
  },
};
