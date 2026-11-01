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

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Library: "resource://gre/modules/browserwip/Library.sys.mjs",
  PrivacyModes: "resource://gre/modules/browserwip/PrivacyModes.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SiteIcons: "resource://gre/modules/browserwip/SiteIcons.sys.mjs",
});

// Base64 of FaviconChild's 256 KB limit, plus the data: prefix.
const MAX_DATA_URL_LENGTH = 360 * 1024;
// And of its 1 MB limit for a favorite's large icon.
const MAX_LARGE_DATA_URL_LENGTH = 1400 * 1024;

function isImageDataURL(dataURL, maxLength) {
  return (
    typeof dataURL == "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(dataURL) && dataURL.length <= maxLength
  );
}

export class FaviconParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "Favicon:Set") {
      return;
    }
    let { dataURL } = message.data ?? {};
    if (!isImageDataURL(dataURL, MAX_DATA_URL_LENGTH)) {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    // A late answer from a page the tab has left.
    if (!browser || browser.browsingContext?.currentWindowGlobal != this.manager) {
      return;
    }
    browser.ownerDocument.defaultView.gBrowser?.setIcon(browser, dataURL);
    // Kept for the bookmarks bar and the address bar's dropdown: for
    // bookmarked pages, and visited ones while history is remembered.
    let url = browser.currentURI?.spec;
    if (url) {
      lazy.Library.storeIcon(url, dataURL).catch(() => {});
      this._favoriteIcon(browser, url, dataURL).catch(() => {});
    }
  }

  // A favorite's site: its largest icon (or this one) for the new tab
  // page's tile. Never kept from a private window; outside Standard, never
  // from another site.
  async _favoriteIcon(browser, url, dataURL) {
    if (lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) || !(await lazy.SiteIcons.isFavorite(url))) {
      return;
    }
    let sameSiteOnly = lazy.PrivacyModes.mode != "standard";
    let large = await this.sendQuery("Favicon:WantLarge", { sameSiteOnly }).catch(() => null);
    if (browser.currentURI?.spec != url) {
      return;
    }
    if (isImageDataURL(large?.dataURL, MAX_LARGE_DATA_URL_LENGTH)) {
      await lazy.SiteIcons.storeFromVisit(url, large.dataURL, !!large.touch);
    } else {
      await lazy.SiteIcons.storeFromVisit(url, dataURL, false);
    }
  }
}
