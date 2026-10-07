/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Toolkit modules (downloads, password manager, web navigation, new tab
 * utilities) import resource:///modules/BrowserWindowTracker.sys.mjs and
 * expect the application to provide it, as Firefox and Thunderbird do. This
 * is the part of Firefox's API that toolkit uses.
 */

const WINDOW_TYPE = "navigator:browser";

export const BrowserWindowTracker = {
  /** Browser windows, most recently used first. */
  get orderedWindows() {
    let windows = [...Services.wm.getEnumerator(WINDOW_TYPE)].filter(w => !w.closed);
    let top = Services.wm.getMostRecentWindow(WINDOW_TYPE);
    return top ? [top, ...windows.filter(w => w != top)] : windows;
  },

  /**
   * The most recent browser window.
   *
   * @param {object} [options]
   * @param {boolean} [options.private] Only private (true) or only normal
   *   (false) windows. This browser has no private windows yet.
   */
  getTopWindow(options = {}) {
    if (options.private === true) {
      return null;
    }
    return this.orderedWindows[0] ?? null;
  },

  get windowCount() {
    return this.orderedWindows.length;
  },
};
