/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The browser side of the right-click menu: hands what ContextMenuChild
 * reported to the window that shows the page (contextmenu.js).
 *
 * The child runs in web content processes, so its data is not trusted for
 * security decisions: the page's principal comes from the WindowGlobalParent.
 */

export class ContextMenuParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name != "ContextMenu:Open") {
      return;
    }
    let browser = this.browsingContext.top.embedderElement;
    let win = browser?.ownerDocument.defaultView;
    if (!win?.BrowserContextMenu) {
      return;
    }
    win.BrowserContextMenu.open(browser, {
      ...message.data,
      principal: this.manager.documentPrincipal,
      // For requests back to the frame that was clicked (Copy image).
      actor: this,
    });
  }
}
