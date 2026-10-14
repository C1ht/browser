/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Page and window sizes for the Anonymous mode (resistFingerprinting).
 *
 * Letterboxing: pages get a size in fixed steps (mostly 200 x 100 CSS
 * pixels), with margins around them, so a page's size says nothing about the
 * window. Gecko's own letterboxing (RFPHelper.sys.mjs) is written for
 * Firefox's tab browser, so this applies the same steps to ours.
 *
 * Window size: with resistFingerprinting on, Gecko stops restoring the
 * window's size and expects the browser to size it. A new window gets a
 * rounded page area, at most privacy.window.maxInnerWidth x maxInnerHeight
 * (1400 x 900), as in Firefox.
 */

const RFP_PREF = "privacy.resistFingerprinting";
const LETTERBOX_PREF = "privacy.resistFingerprinting.letterboxing";
// Room kept around a letterboxed page on each side, so it never touches the
// tab strip or the window edge.
const GUTTER = 8;

var Letterbox = {
  init(window) {
    this.window = window;
    this.container = window.document.getElementById("browsers");
    this._observer = new window.ResizeObserver(() => this._update());
    Services.prefs.addObserver(LETTERBOX_PREF, this);
    Services.prefs.addObserver(RFP_PREF, this);
    window.addEventListener("unload", () => {
      Services.prefs.removeObserver(LETTERBOX_PREF, this);
      Services.prefs.removeObserver(RFP_PREF, this);
      this._observer.disconnect();
    });
    this._update();
    if (Services.prefs.getBoolPref(RFP_PREF, false)) {
      this._sizeWindow();
    }
  },

  observe() {
    this._update();
  },

  get enabled() {
    return Services.prefs.getBoolPref(LETTERBOX_PREF, false);
  },

  /** Firefox's rounding (RFPHelper.steppedSize). */
  steppedSize(size, isWidth) {
    let step;
    if (size <= 50) {
      return size;
    } else if (size <= 500) {
      step = 50;
    } else if (size <= 1600) {
      step = isWidth ? 200 : 100;
    } else {
      step = 200;
    }
    return size - (size % step);
  },

  _update() {
    let on = this.enabled;
    // On the root, so the tab strip can change its look too (browser.css).
    this.window.document.documentElement.toggleAttribute("letterboxing", on);
    if (!on) {
      this._observer.disconnect();
      this.container.style.removeProperty("--letterbox-width");
      this.container.style.removeProperty("--letterbox-height");
      return;
    }
    this._observer.observe(this.container);
    let width = this.container.clientWidth - 2 * GUTTER;
    let height = this.container.clientHeight - 2 * GUTTER;
    this.container.style.setProperty("--letterbox-width", `${this.steppedSize(width, true)}px`);
    this.container.style.setProperty("--letterbox-height", `${this.steppedSize(height, false)}px`);
  },

  // nsContentUtils::CalcRoundedWindowSizeForResistingFingerprinting, for
  // the window's own size.
  _sizeWindow() {
    let win = this.window;
    if (win.windowState != win.STATE_NORMAL) {
      return;
    }
    win.requestAnimationFrame(() => {
      // Measured from layout: the window can start out smaller than the
      // toolbars, so outer size minus page size would come out short.
      let rect = this.container.getBoundingClientRect();
      let frameWidth = win.outerWidth - win.innerWidth;
      let frameHeight = win.outerHeight - win.innerHeight;
      let chromeWidth = frameWidth + Math.max(0, win.innerWidth - rect.width);
      let chromeHeight = frameHeight + rect.top + Math.max(0, win.innerHeight - rect.bottom);
      // Letterboxing keeps a gutter around the page; make room for it so the
      // page still gets the full rounded size.
      let gutter = this.enabled ? 2 * GUTTER : 0;
      chromeWidth += gutter;
      chromeHeight += gutter;
      let maxWidth = Services.prefs.getIntPref("privacy.window.maxInnerWidth", 1400);
      let maxHeight = Services.prefs.getIntPref("privacy.window.maxInnerHeight", 900);
      let width = Math.min(maxWidth, win.screen.availWidth - chromeWidth);
      let height = Math.min(maxHeight, win.screen.availHeight - chromeHeight);
      width = Math.max(200, width - (width % 200));
      height = Math.max(100, height - (height % 100));
      win.resizeTo(width + chromeWidth, height + chromeHeight);
      this._fitPage(width + gutter, height + gutter, 3);
    });
  },

  // The window frame can still change size while the window first opens
  // (the drawn title bar), so correct by whatever the page area is off.
  _fitPage(width, height, attempts) {
    let win = this.window;
    win.addEventListener(
      "resize",
      () => {
        let dw = width - this.container.clientWidth;
        let dh = height - this.container.clientHeight;
        if ((dw || dh) && attempts > 1) {
          win.resizeBy(dw, dh);
          this._fitPage(width, height, attempts - 1);
          return;
        }
        // Keep a restored position from pushing the window off screen.
        let { availLeft, availTop, availWidth, availHeight } = win.screen;
        let x = Math.max(availLeft, Math.min(win.screenX, availLeft + availWidth - win.outerWidth));
        let y = Math.max(availTop, Math.min(win.screenY, availTop + availHeight - win.outerHeight));
        if (x != win.screenX || y != win.screenY) {
          win.moveTo(x, y);
        }
      },
      { once: true }
    );
  },
};
