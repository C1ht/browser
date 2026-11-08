/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The browser side of DRM. A page asked for Widevine and:
 *   - it isn't installed ("cdm-not-installed"): it's installed now
 *     (Widevine.sys.mjs), and the page, which waits a minute for it, plays;
 *   - DRM is off ("api-disabled", "cdm-disabled"): the window says so, and
 *     offers to turn it on (DrmNotices, drm.js).
 * Requests for other DRM systems, which this browser doesn't have, are
 * ignored. Nothing a page sends is trusted beyond picking one of these.
 */

import { Widevine } from "resource://gre/modules/browserwip/Widevine.sys.mjs";

const SHARING_KEY = "browserwip:isSharingScreen";
const sharingWindows = new Set();

/**
 * A window started or stopped sharing a screen with a page (permissions.js):
 * Widevine is told capture is possible while any window does.
 */
export function setScreenSharing(window, sharing) {
  let before = sharingWindows.size > 0;
  sharingWindows[sharing ? "add" : "delete"](window);
  let after = sharingWindows.size > 0;
  if (before != after) {
    Services.ppmm.sharedData.set(SHARING_KEY, after);
    Services.ppmm.sharedData.flush();
  }
}

export class EncryptedMediaParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    if (name != "EncryptedMedia:Request" || !data?.keySystem?.startsWith("com.widevine.alpha")) {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    let notices = browser?.ownerDocument?.defaultView?.DrmNotices;
    if (!notices) {
      return;
    }
    switch (data.status) {
      case "cdm-not-installed":
        // The notices follow the install, in every window (drm.js), and
        // Widevine.sys.mjs logs its failure.
        notices.installing(browser);
        Widevine.install().catch(() => {});
        break;
      case "api-disabled":
      case "cdm-disabled":
        notices.disabled(browser);
        break;
    }
  }
}
