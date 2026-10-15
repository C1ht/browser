/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Session restore: the open windows and tabs, saved to sessionstore.json in
 * the profile a few seconds after each change and when the browser quits.
 *
 * At startup the previous session comes back when Settings says "Continue
 * where you left off", or after a crash (the file was not marked as a clean
 * exit). Otherwise it stays available from the menu ("Restore previous
 * session") for as long as this run lasts.
 *
 * Saved per tab: address, title, pinned state and site icon (if small); per
 * window, the selected tab. Restored tabs load when first selected.
 * Back/forward history is not kept.
 */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const FILE_NAME = "sessionstore.json";
const SAVE_DELAY_MS = 3000;
const RESTORE_PREF = "browserwip.startup.restoreSession";
// Site icons are kept with the session only when small (most are a few KB).
const MAX_SAVED_ICON_LENGTH = 16 * 1024;
// Passed as the new window's argument when it should take a restored window.
export const RESTORE_WINDOW_ARG = "browserwip:restore-window";

function browserWindows() {
  return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed && w.gBrowser);
}

function windowState(win) {
  let { gBrowser } = win;
  let tabs = gBrowser.tabs.map(tab => {
    let browser = tab.linkedBrowser;
    let url = tab.pendingLoad?.url ?? browser.currentURI?.spec ?? "about:blank";
    let icon = tab.favicon?.length <= MAX_SAVED_ICON_LENGTH ? tab.favicon : undefined;
    return {
      url,
      title: tab.pendingLoad?.title ?? browser.contentTitle ?? "",
      pinned: tab.hasAttribute("pinned"),
      icon,
    };
  });
  return { tabs, selected: gBrowser.tabs.indexOf(gBrowser.selectedTab) };
}

export const SessionStore = {
  _previous: null,
  _startupHandled: false,
  _restoredPrevious: false,
  // After the browser starts quitting, nothing changes the saved session.
  _frozen: false,
  _saveTimer: null,
  _pendingWindows: [],

  get _path() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  },

  /** Called once at startup, before the first window opens. */
  init() {
    this._ready = IOUtils.readJSON(this._path)
      .then(data => {
        this._previous = data?.windows?.length ? data : null;
      })
      .catch(() => {
        // No previous session, or an unreadable one.
      });
    Services.obs.addObserver(this, "quit-application-granted");
  },

  observe(subject, topic) {
    if (topic == "quit-application-granted" && !this._frozen) {
      this._frozen = true;
      this._write(browserWindows().map(windowState), { cleanExit: true });
    }
  },

  /**
   * For a window that is starting: the previous session's windows, if they
   * should come back now. Only the first window to ask gets an answer.
   */
  async startupSession() {
    await this._ready;
    if (this._startupHandled) {
      return null;
    }
    this._startupHandled = true;
    let previous = this._previous;
    if (!previous) {
      return null;
    }
    let crashed = !previous.cleanExit;
    if (!crashed && !Services.prefs.getBoolPref(RESTORE_PREF, false)) {
      return null;
    }
    this._restoredPrevious = true;
    return previous.windows;
  },

  /** Whether "Restore previous session" has something to restore. */
  get canRestorePrevious() {
    return !!this._previous && !this._restoredPrevious;
  },

  /** "Restore previous session": into `win`, and new windows for the rest. */
  restorePrevious(win) {
    if (!this.canRestorePrevious) {
      return;
    }
    this._restoredPrevious = true;
    let [first, ...others] = this._previous.windows;
    win.BrowserWip.restoreWindow(first, { replaceBlank: true });
    this.openWindows(win, others);
  },

  /** Opens a window for each saved window state. */
  openWindows(fromWindow, states) {
    for (let state of states) {
      this._pendingWindows.push(state);
      fromWindow.openDialog(
        Services.prefs.getStringPref("browser.chromeURL"),
        "_blank",
        "chrome,all,dialog=no",
        RESTORE_WINDOW_ARG
      );
    }
  },

  /** For a window opened with RESTORE_WINDOW_ARG: the state to restore. */
  takePendingWindow() {
    return this._pendingWindows.shift() ?? null;
  },

  /** Called by windows on any change to their tabs. */
  saveSoon() {
    if (this._frozen || this._saveTimer) {
      return;
    }
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._frozen) {
        this._write(browserWindows().map(windowState), { cleanExit: false });
      }
    }, SAVE_DELAY_MS);
  },

  /**
   * Called when a window closes. Closing the last window quits the
   * browser, so its tabs are the session to keep.
   */
  windowClosing(win) {
    if (this._frozen) {
      return;
    }
    let others = browserWindows().filter(w => w != win);
    if (others.length) {
      this.saveSoon();
      return;
    }
    this._frozen = true;
    this._write([windowState(win)], { cleanExit: true });
  },

  _write(windows, { cleanExit }) {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    let data = { version: 1, cleanExit, windows: windows.filter(w => w.tabs.length) };
    // IOUtils finishes pending writes before the profile closes.
    return IOUtils.writeJSON(this._path, data, { tmpPath: this._path + ".tmp" }).catch(e =>
      console.error("browser-wip: could not save the session", e)
    );
  },
};
