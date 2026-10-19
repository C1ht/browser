/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The page side of fullscreen video and requestFullscreen() (fullscreen.js).
 * Adapted from Firefox's browser/actors/DOMFullscreenChild.sys.mjs.
 *
 * Gecko fullscreen across processes is a handshake: the page asks
 * (MozDOMFullscreen:Request), the browser window makes the page's <browser>
 * fill the screen, then tells each process from the top down to finish the
 * change. Leaving goes the same way. Each frame in between that lives in its
 * own process (Fission) is told in turn, so a video in a cross-site iframe,
 * like an embedded YouTube player, works too.
 */

export class DOMFullscreenChild extends JSWindowActorChild {
  receiveMessage(message) {
    let window = this.contentWindow;
    let windowUtils = window?.windowUtils;

    switch (message.name) {
      case "DOMFullscreen:Entered": {
        if (!windowUtils) {
          // Not able to enter fullscreen: tell the parent to just exit.
          this.sendAsyncMessage("DOMFullscreen:Exit", {});
          break;
        }
        let remoteFrameBC = message.data.remoteFrameBC;
        if (remoteFrameBC) {
          // A frame in the middle: make the frame that embeds the requesting
          // (out-of-process) frame fullscreen here first.
          let remoteFrame = remoteFrameBC.embedderElement;
          if (!remoteFrame) {
            // The page navigated away during the change.
            this.sendAsyncMessage("DOMFullscreen:Exit", {});
            break;
          }
          this._isNotTheRequestSource = true;
          windowUtils.remoteFrameFullscreenChanged(remoteFrame);
        } else {
          this._waitForMozAfterPaint = true;
          this._lastTransactionId = windowUtils.lastTransactionId;
          if (!windowUtils.handleFullscreenRequests() && !this.document.fullscreenElement) {
            // Nothing to handle and not in fullscreen: tell the parent to exit.
            this.sendAsyncMessage("DOMFullscreen:Exit", {});
          }
        }
        break;
      }
      case "DOMFullscreen:CleanUp": {
        let isNotTheRequestSource = !!message.data.remoteFrameBC;
        if (this.document.fullscreenElement) {
          this._isNotTheRequestSource = isNotTheRequestSource;
          // The request source waits for the paint after leaving.
          this._waitForMozAfterPaint = !this._isNotTheRequestSource;
          // windowUtils is null if this window is no longer current, and then
          // its document is already leaving fullscreen.
          if (windowUtils) {
            this._lastTransactionId = windowUtils.lastTransactionId;
            windowUtils.exitFullscreen();
          }
        } else if (isNotTheRequestSource) {
          // Already out; the parent is waiting for this reply.
          this.sendAsyncMessage("DOMFullscreen:Exited", {});
        } else {
          // Already out, so there may be no further paint to wait for.
          this.sendAsyncMessage("DOMFullscreen:Painted", {});
        }
        break;
      }
      case "DOMFullscreen:Painted": {
        Services.obs.notifyObservers(window, "fullscreen-painted");
        break;
      }
    }
  }

  handleEvent(event) {
    if (this.hasBeenDestroyed()) {
      // Sending messages or touching contentWindow would throw.
      return;
    }
    switch (event.type) {
      case "MozDOMFullscreen:Request": {
        this.sendAsyncMessage("DOMFullscreen:Request", {
          fullscreenKeyboardLock: event.detail,
        });
        break;
      }
      case "MozDOMFullscreen:NewOrigin": {
        this.sendAsyncMessage("DOMFullscreen:NewOrigin", {
          originNoSuffix: event.target.nodePrincipal.originNoSuffix,
        });
        break;
      }
      case "MozDOMFullscreen:Exit": {
        this.sendAsyncMessage("DOMFullscreen:Exit", {});
        break;
      }
      case "MozDOMFullscreen:Entered":
      case "MozDOMFullscreen:Exited": {
        if (this._isNotTheRequestSource) {
          // A frame in the middle has finished its part.
          delete this._isNotTheRequestSource;
          this.sendAsyncMessage(event.type.replace("Moz", ""), {});
          break;
        }
        if (this._waitForMozAfterPaint) {
          delete this._waitForMozAfterPaint;
          this._listeningWindow = this.contentWindow.windowRoot;
          this._listeningWindow.addEventListener("MozAfterPaint", this);
        }
        if (!this.document || !this.document.fullscreenElement) {
          // Not actually in fullscreen: make sure the window leaves it too.
          this.sendAsyncMessage("DOMFullscreen:Exit", {});
        }
        break;
      }
      case "MozDOMFullscreen:UpdateKeyboardLock": {
        this.sendAsyncMessage("DOMFullscreen:UpdateKeyboardLock", {
          fullscreenKeyboardLock: event.detail,
        });
        break;
      }
      case "MozAfterPaint": {
        // Report only once the change has actually been painted.
        if (!this._lastTransactionId || event.transactionId > this._lastTransactionId) {
          this._listeningWindow.removeEventListener("MozAfterPaint", this);
          delete this._listeningWindow;
          this.sendAsyncMessage("DOMFullscreen:Painted", {});
        }
        break;
      }
    }
  }

  hasBeenDestroyed() {
    // didDestroy is not always called; a destroyed actor has no browsing
    // context.
    try {
      return !this.browsingContext;
    } catch {
      return true;
    }
  }
}
