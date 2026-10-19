/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The browser side of middle-click and Ctrl+click on links
 * (LinkClickChild.sys.mjs): opens the link in a new tab of the window that
 * shows the page.
 *
 * The child runs in web content processes, so the link is checked again
 * here, against the principal from the WindowGlobalParent.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

export class LinkClickParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "LinkClick:Open") {
      return;
    }
    let data = message.data;
    let browser = this.browsingContext.top.embedderElement;
    let win = browser?.ownerDocument.defaultView;
    if (!win?.BrowserWip) {
      return;
    }
    let principal = this.manager.documentPrincipal;
    try {
      Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(principal, data.href);
    } catch (e) {
      return;
    }
    if (Services.io.extractScheme(data.href) == "javascript") {
      return;
    }
    // "tab" or "tabshifted" (Shift held: the other one of background and
    // foreground), or "window" for Shift+click.
    let where = lazy.BrowserUtils.whereToOpenLink(data);
    if (where == "current" || where == "save") {
      return;
    }
    win.BrowserWip.openLink(data.href, where, {
      browser,
      triggeringPrincipal: principal,
      policyContainer: data.policyContainer && lazy.E10SUtils.deserializePolicyContainer(data.policyContainer),
      referrerInfo: lazy.E10SUtils.deserializeReferrerInfo(data.referrerInfo),
    });
  }
}
