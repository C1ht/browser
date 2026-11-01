/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The blocked-page screen (about:blocked) asks for "back" or "continue"
 * with a page event; this passes the request on, nothing else.
 */
export class BlockedPageChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.detail == "back" || event.detail == "continue") {
      this.sendAsyncMessage(`BlockedPage:${event.detail}`);
    }
  }
}
