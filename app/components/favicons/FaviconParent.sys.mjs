/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Site icons, the browser side: shows the icon FaviconChild loaded on the
 * page's tab.
 *
 * The child runs in a web process, so only an image data: URL of bounded
 * size is accepted, and only for the document that is still showing.
 */

// Base64 of FaviconChild's 256 KB limit, plus the data: prefix.
const MAX_DATA_URL_LENGTH = 360 * 1024;

export class FaviconParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "Favicon:Set") {
      return;
    }
    let { dataURL } = message.data ?? {};
    if (
      typeof dataURL != "string" ||
      !/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataURL) ||
      dataURL.length > MAX_DATA_URL_LENGTH
    ) {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    // A late answer from a page the tab has left.
    if (!browser || browser.browsingContext?.currentWindowGlobal != this.manager) {
      return;
    }
    browser.ownerDocument.defaultView.gBrowser?.setIcon(browser, dataURL);
  }
}
