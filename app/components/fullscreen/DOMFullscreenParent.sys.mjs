/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The browser side of fullscreen for pages; see DOMFullscreenChild.sys.mjs.
 * Adapted from Firefox's browser/actors/DOMFullscreenParent.sys.mjs, without
 * its telemetry and add-on prompt handling. The window's half of the
 * handshake is FullScreen in fullscreen.js, which sets the waiting flags and
 * nextMsgRecipient below.
 *
 * The child runs in web content processes, so nothing it sends is trusted
 * beyond "this page wants fullscreen"; Gecko itself checks that the request
 * came from a user gesture.
 */

export class DOMFullscreenParent extends JSWindowActorParent {
  waitingForChildEnterFullscreen = false;
  waitingForChildExitFullscreen = false;
  // [actor, in-process browsing context]: where the next handshake message
  // goes, so leaving fullscreen takes the same route as entering, even after
  // this actor is gone.
  nextMsgRecipient = null;

  updateFullscreenWindowReference(window) {
    if (window.document.documentElement.hasAttribute("inDOMFullscreen")) {
      this._fullscreenWindow = window;
    } else {
      delete this._fullscreenWindow;
    }
  }

  cleanupDomFullscreen(window) {
    if (!window.FullScreen) {
      return;
    }
    // With no child to wait for and fullscreen already over, no
    // DOMFullscreen:Painted will come, and there may be no more paints.
    if (!window.FullScreen.cleanupDomFullscreen(this) && !window.document.fullscreen) {
      Services.obs.notifyObservers(window, "fullscreen-painted");
    }
  }

  // Leave fullscreen in the window too, if this actor started it.
  _cleanupFullscreenStateAndResumeChromeUI(window) {
    this.cleanupDomFullscreen(window);
    if (this.requestOrigin == this && window.document.fullscreen) {
      window.windowUtils.remoteFrameFullscreenReverted();
    }
  }

  didDestroy() {
    this._didDestroy = true;

    let window = this._fullscreenWindow;
    if (!window) {
      let browser = this.browsingContext.top.embedderElement;
      if (!browser) {
        return;
      }
      if (this.waitingForChildExitFullscreen || this.waitingForChildEnterFullscreen) {
        this.waitingForChildExitFullscreen = false;
        this.waitingForChildEnterFullscreen = false;
        // Destroyed mid-change: finish the cleanup anyway.
        this._cleanupFullscreenStateAndResumeChromeUI(browser.documentGlobal);
      }
      if (this != this.requestOrigin) {
        this.removeListeners(browser.documentGlobal);
      }
      return;
    }

    if (this.waitingForChildEnterFullscreen) {
      this.waitingForChildEnterFullscreen = false;
      if (window.document.fullscreen) {
        // Destroyed while the page was entering: abort the whole change
        // rather than stay half in fullscreen.
        window.document.exitFullscreen().catch(() => {});
        return;
      }
      this.cleanupDomFullscreen(window);
    }

    // Never leave the window stuck in fullscreen.
    if (window.document.documentElement.hasAttribute("inDOMFullscreen")) {
      this.cleanupDomFullscreen(window);
      window.windowUtils?.remoteFrameFullscreenReverted();
    } else if (this.waitingForChildExitFullscreen) {
      this.waitingForChildExitFullscreen = false;
      this._cleanupFullscreenStateAndResumeChromeUI(window);
    }
    this.updateFullscreenWindowReference(window);
  }

  _keyboardLock(requested) {
    let enabled = Services.prefs.getBoolPref("dom.fullscreen.keyboard_lock.enabled", false);
    return enabled && (requested == "none" || requested == "browser") ? requested : "none";
  }

  receiveMessage(message) {
    let topBrowsingContext = this.browsingContext.top;
    let browser = topBrowsingContext.embedderElement;
    if (!browser) {
      // The tab is gone.
      return;
    }
    let window = browser.documentGlobal;
    switch (message.name) {
      case "DOMFullscreen:Request": {
        this.fullscreenKeyboardLock = this._keyboardLock(message.data.fullscreenKeyboardLock);
        this.manager.fullscreen = true;
        this.waitingForChildExitFullscreen = false;
        this.requestOrigin = this;
        this.addListeners(window);
        window.windowUtils.remoteFrameFullscreenChanged(browser, this.fullscreenKeyboardLock == "browser");
        break;
      }
      case "DOMFullscreen:NewOrigin": {
        // A new site in fullscreen: say so, unless fullscreen is already over.
        if (window.document.fullscreen) {
          window.FullScreen.showWarning(topBrowsingContext);
        }
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "DOMFullscreen:Entered": {
        this.manager.fullscreen = true;
        this.nextMsgRecipient = null;
        this.waitingForChildEnterFullscreen = false;
        window.FullScreen.enterDomFullscreen(browser, this);
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "DOMFullscreen:Exit": {
        this.manager.fullscreen = false;
        this.waitingForChildEnterFullscreen = false;
        window.windowUtils.remoteFrameFullscreenReverted();
        break;
      }
      case "DOMFullscreen:Exited": {
        this.manager.fullscreen = false;
        this.waitingForChildExitFullscreen = false;
        this.cleanupDomFullscreen(window);
        this.updateFullscreenWindowReference(window);
        break;
      }
      case "DOMFullscreen:Painted": {
        this.waitingForChildExitFullscreen = false;
        Services.obs.notifyObservers(window, "fullscreen-painted");
        this.sendAsyncMessage("DOMFullscreen:Painted", {});
        break;
      }
      case "DOMFullscreen:UpdateKeyboardLock": {
        let lock = this._keyboardLock(message.data.fullscreenKeyboardLock);
        if (window.document.fullscreenKeyboardLock != lock) {
          this.manager.updateFullscreenKeyboardLockStatus(lock);
          window.FullScreen.showWarning(this.browsingContext);
        }
        break;
      }
    }
  }

  // The window's own fullscreen events, while this actor's page requested it.
  handleEvent(event) {
    let window = event.currentTarget;
    // Taken from the window: this actor may already be destroyed.
    let requestOrigin = window.browsingContext.fullscreenRequestOrigin?.get();
    if (this != requestOrigin) {
      this.removeListeners(window);
      return;
    }
    switch (event.type) {
      case "MozDOMFullscreen:Entered": {
        // The target is the element that went fullscreen: our <browser> for
        // a remote page, or an element inside an in-process one.
        let browser =
          event.target.documentGlobal == window
            ? event.target
            : event.target.documentGlobal.docShell.chromeEventHandler;
        window.FullScreen.enterDomFullscreen(browser, this);
        this.updateFullscreenWindowReference(window);
        if (!this.hasBeenDestroyed() && this.requestOrigin) {
          window.FullScreen.showWarning(this.requestOrigin.browsingContext);
        }
        break;
      }
      case "MozDOMFullscreen:Exited": {
        if (!this.hasBeenDestroyed() && !this.requestOrigin) {
          this.requestOrigin = this;
        }
        this.cleanupDomFullscreen(window);
        this.updateFullscreenWindowReference(window);
        // Still meant to be in fullscreen: keep listening.
        if (!this.manager.fullscreen) {
          this.removeListeners(window);
        }
        break;
      }
      case "MozDOMFullscreen:WarnAboutKeyboardLock": {
        if (!this.hasBeenDestroyed() && this.requestOrigin) {
          window.FullScreen.showWarning(this.requestOrigin.browsingContext);
        }
        break;
      }
    }
  }

  addListeners(window) {
    for (let type of ["MozDOMFullscreen:Entered", "MozDOMFullscreen:Exited", "MozDOMFullscreen:WarnAboutKeyboardLock"]) {
      window.addEventListener(type, this, /* capture */ true, /* wantsUntrusted */ false);
    }
  }

  removeListeners(window) {
    for (let type of ["MozDOMFullscreen:Entered", "MozDOMFullscreen:Exited", "MozDOMFullscreen:WarnAboutKeyboardLock"]) {
      window.removeEventListener(type, this, true);
    }
  }

  /** The actor whose page started the current fullscreen change. */
  get requestOrigin() {
    let chromeBC = this.browsingContext.topChromeWindow?.browsingContext;
    return chromeBC?.fullscreenRequestOrigin?.get();
  }

  // Kept on the window's browsing context, as a weak reference.
  set requestOrigin(actor) {
    let chromeBC = this.browsingContext.topChromeWindow?.browsingContext;
    if (!chromeBC) {
      console.error("DOMFullscreen: no browsing context for the browser window");
      return;
    }
    if (actor) {
      chromeBC.fullscreenRequestOrigin = Cu.getWeakReference(actor);
    } else {
      delete chromeBC.fullscreenRequestOrigin;
    }
  }

  hasBeenDestroyed() {
    if (this._didDestroy) {
      return true;
    }
    try {
      return !this.browsingContext;
    } catch {
      return true;
    }
  }
}
