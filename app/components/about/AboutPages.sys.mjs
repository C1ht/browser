/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The app's about: pages. Each maps to a chrome:// document and runs in the
 * parent process with chrome privileges, like Firefox's about:preferences:
 * Settings and the first-run screen change preferences directly. None of
 * them loads anything from the network (each sets a chrome:-only CSP).
 */

const PAGES = {
  newtab: "chrome://browser-wip/content/newtab.html",
  home: "chrome://browser-wip/content/newtab.html",
  welcome: "chrome://browser-wip/content/welcome.html",
  settings: "chrome://browser-wip/content/settings.html",
};

function pageFor(uri) {
  // "about:settings#privacy" -> "settings"
  let name = uri.pathQueryRef.replace(/[?#].*$/, "").toLowerCase();
  let url = PAGES[name];
  if (!url) {
    throw Components.Exception(`No such page: about:${name}`, Cr.NS_ERROR_ILLEGAL_VALUE);
  }
  return url;
}

export function AboutPages() {}

AboutPages.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),

  newChannel(uri, loadInfo) {
    let channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(pageFor(uri)),
      loadInfo
    );
    // Keep about:… in the address bar and as the document URL.
    channel.originalURI = uri;
    return channel;
  },

  getURIFlags() {
    return Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
  },

  getChromeURI(uri) {
    return Services.io.newURI(pageFor(uri));
  },
};
