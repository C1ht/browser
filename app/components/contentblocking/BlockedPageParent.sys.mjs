/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The blocked-page screen's two buttons (about:blocked, blocked.html).
 *
 * "Go back" goes back, or to a new tab page. "Open it anyway" lets the
 * network blocker open pages on that host until quitting, then loads the
 * page in place of the screen. The address comes from the screen's own
 * document URI, which Gecko made from the blocked load; nothing the page
 * sends is trusted.
 */

export class BlockedPageParent extends JSWindowActorParent {
  receiveMessage(message) {
    let spec = this.manager.documentURI?.spec ?? "";
    if (!spec.startsWith("about:blocked?")) {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    switch (message.name) {
      case "BlockedPage:back":
        if (browser?.canGoBack) {
          browser.goBack();
        } else {
          browser?.ownerGlobal.gBrowser?.loadURL(browser, "about:newtab");
        }
        break;
      case "BlockedPage:continue": {
        let target;
        try {
          target = Services.io.newURI(new URLSearchParams(spec.slice(spec.indexOf("?") + 1)).get("u"));
        } catch (e) {
          return;
        }
        if (!target.schemeIs("http") && !target.schemeIs("https")) {
          return;
        }
        Cc["@browser-wip/network-blocker;1"]
          .getService(Ci.nsIBrowserWipBlocker)
          .allowPage(target.asciiHost, this.browsingContext.usePrivateBrowsing);
        this.browsingContext.loadURI(target, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
        });
        break;
      }
    }
  }
}
