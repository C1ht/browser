/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The page side of DRM: Gecko tells it (the "mediakeys-request" topic) when
 * a page asked for a DRM system it can't have right now: off, or Widevine
 * not installed yet. The parent installs Widevine or explains.
 *
 * It also answers Widevine's question whether the screen is being
 * captured, from what the browser publishes while a page shares the screen
 * (EncryptedMediaParent.setScreenSharing), as Firefox does.
 */

const SHARING_KEY = "browserwip:isSharingScreen";

class CaptureState {
  constructor() {
    Services.cpmm.sharedData.addEventListener("change", this);
  }

  handleEvent(event) {
    if (event.changedKeys.includes(SHARING_KEY)) {
      this.notify();
    }
  }

  notify() {
    let sharing = !!Services.cpmm.sharedData.get(SHARING_KEY);
    Services.obs.notifyObservers(null, "mediakeys-response", sharing ? "capture-possible" : "capture-not-possible");
  }
}

let gCaptureState = null;

export class EncryptedMediaChild extends JSWindowActorChild {
  // subject: the asking page's window; data: JSON { keySystem, status }.
  observe(subject, topic, data) {
    let request;
    try {
      request = JSON.parse(data);
    } catch (e) {
      return;
    }
    if (request.status == "is-capture-possible") {
      gCaptureState ??= new CaptureState();
      gCaptureState.notify();
      return;
    }
    this.sendAsyncMessage("EncryptedMedia:Request", {
      keySystem: String(request.keySystem ?? ""),
      status: String(request.status ?? ""),
    });
  }
}
