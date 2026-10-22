/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The app's about: pages. Each maps to a chrome:// document and runs in the
 * parent process with chrome privileges, like Firefox's about:preferences:
 * Settings and the first-run screen change preferences directly. None of
 * them loads anything from the network (each sets a chrome:-only CSP).
 */

const PRIVILEGED = Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI;
// Error pages that web content can be shown: they run in the content process
// under their own about: principal, never with chrome privileges.
const ERROR_PAGE =
  Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT |
  Ci.nsIAboutModule.URI_CAN_LOAD_IN_CHILD |
  Ci.nsIAboutModule.ALLOW_SCRIPT |
  Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT;

const PAGES = {
  newtab: { url: "chrome://browser-wip/content/newtab.html", flags: PRIVILEGED },
  home: { url: "chrome://browser-wip/content/newtab.html", flags: PRIVILEGED },
  welcome: { url: "chrome://browser-wip/content/welcome.html", flags: PRIVILEGED },
  settings: { url: "chrome://browser-wip/content/settings.html", flags: PRIVILEGED },
  passwords: { url: "chrome://browser-wip/content/passwords.html", flags: PRIVILEGED },
  // Gecko shows about:certerror for certificate problems. Firefox registers
  // it in browser/; it is toolkit's shared network-error page.
  certerror: { url: "chrome://global/content/aboutNetError.html", flags: ERROR_PAGE },
};

function pageFor(uri) {
  // "about:settings#privacy" -> "settings"
  let name = uri.pathQueryRef.replace(/[?#].*$/, "").toLowerCase();
  let page = PAGES[name];
  if (!page) {
    throw Components.Exception(`No such page: about:${name}`, Cr.NS_ERROR_ILLEGAL_VALUE);
  }
  return page;
}

export function AboutPages() {}

AboutPages.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),

  newChannel(uri, loadInfo) {
    let page = pageFor(uri);
    let channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(page.url),
      loadInfo
    );
    // Keep about:… in the address bar and as the document URL.
    channel.originalURI = uri;
    if (page.flags & Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT) {
      // Derive the document's principal from the about: URI, not chrome://,
      // so the page has no special privileges (as AboutRedirector.cpp does).
      loadInfo.resultPrincipalURI = uri;
    }
    return channel;
  },

  getURIFlags(uri) {
    return pageFor(uri).flags;
  },

  getChromeURI(uri) {
    return Services.io.newURI(pageFor(uri).url);
  },
};
