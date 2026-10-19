/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Middle-click and Ctrl+click (Cmd+click on macOS) on links: open them in a
 * new tab. Adapted from Firefox's browser/actors/ClickHandlerChild.sys.mjs.
 *
 * Gecko follows a plain left click itself, and leaves clicks with a
 * modifier or the middle button to the browser: for those it sends a
 * chrome-only `chromelinkclick` event, wrapping the page's click, which
 * this reports to LinkClickParent. Pages that cancel the click keep it.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

export class LinkClickChild extends JSWindowActorChild {
  handleEvent(wrapperEvent) {
    let event = wrapperEvent.sourceEvent;
    if (!event || event.defaultPrevented || event.button == 2) {
      return;
    }
    // Middle-click in an editable field is paste, not a link.
    let target = event.composedTarget;
    let className = ChromeUtils.getClassName(target);
    if (
      target.isContentEditable ||
      target.ownerDocument?.designMode == "on" ||
      className == "HTMLInputElement" ||
      className == "HTMLTextAreaElement"
    ) {
      return;
    }
    let doc = event.originalTarget.ownerDocument;
    if (!doc) {
      return;
    }
    // A click a script made counts only inside a user gesture.
    if (!event.isTrusted && !doc.hasValidTransientUserGestureActivation) {
      return;
    }
    if (lazy.BrowserUtils.whereToOpenLink(event) == "current") {
      // Gecko follows it.
      return;
    }

    let [href, node, principal] = lazy.BrowserUtils.hrefAndLinkNodeForClickEvent(event) ?? [];
    if (!href || Services.io.extractScheme(href) == "javascript") {
      return;
    }
    try {
      Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(principal, href);
    } catch (e) {
      return;
    }
    if (!event.isTrusted) {
      // One gesture opens one tab.
      doc.consumeTransientUserGestureActivation();
    }

    let referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
    if (node) {
      referrerInfo.initWithElement(node);
    } else {
      referrerInfo.initWithDocument(doc);
    }
    let policyContainer = doc.policyContainer;

    // Nested links would otherwise each open a tab, and a middle-click would
    // also paste on Linux.
    event.preventMultipleActions();

    this.sendAsyncMessage("LinkClick:Open", {
      href,
      button: event.button,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      referrerInfo: lazy.E10SUtils.serializeReferrerInfo(referrerInfo),
      policyContainer: policyContainer && lazy.E10SUtils.serializePolicyContainer(policyContainer),
    });
  }
}
