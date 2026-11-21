/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The page's side of screenshots (screenshots.js in the window): how big
 * the page is and where it's scrolled to, the element under the pointer for
 * click-to-select, and scrolling while the overlay covers the page. The
 * window captures the pixels itself (WindowGlobalParent.drawSnapshot).
 */

// An element smaller than this, in CSS pixels, is too small to be what
// someone means to capture: its parent is offered instead.
const MIN_SIZE = 40;

export class ScreenshotsChild extends JSWindowActorChild {
  receiveMessage({ name, data }) {
    switch (name) {
      case "Screenshots:Page":
        return this._page();
      case "Screenshots:ElementAt":
        return this._elementAt(data.x, data.y);
      case "Screenshots:Scroll":
        this.contentWindow.scrollBy(data.x, data.y);
        return this._page();
    }
    return null;
  }

  // In CSS pixels: the viewport, where it's scrolled to, and the whole page.
  _page() {
    let win = this.contentWindow;
    let root = this.document.documentElement;
    let body = this.document.body;
    return {
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      // Without the scrollbars.
      width: root?.clientWidth || win.innerWidth,
      height: root?.clientHeight || win.innerHeight,
      pageWidth: Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0, win.innerWidth),
      pageHeight: Math.max(root?.scrollHeight ?? 0, body?.scrollHeight ?? 0, win.innerHeight),
      title: this.document.title,
    };
  }

  /**
   * The rectangle, in the viewport's CSS pixels, of what clicking at x, y
   * would capture: the element there, or the nearest ancestor big enough to
   * mean something. Null over nothing, or over the whole page.
   */
  _elementAt(x, y) {
    let win = this.contentWindow;
    let el = this.document.elementFromPoint(x, y);
    while (el && el != this.document.documentElement && el != this.document.body) {
      let rect = el.getBoundingClientRect();
      let display = win.getComputedStyle(el).display;
      if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE && display != "inline" && display != "contents") {
        // Within the viewport.
        let left = Math.max(rect.left, 0);
        let top = Math.max(rect.top, 0);
        let right = Math.min(rect.right, win.innerWidth);
        let bottom = Math.min(rect.bottom, win.innerHeight);
        if ((right - left) * (bottom - top) > 0.95 * win.innerWidth * win.innerHeight) {
          return null;
        }
        return { left, top, width: right - left, height: bottom - top };
      }
      el = el.parentElement;
    }
    return null;
  }
}
