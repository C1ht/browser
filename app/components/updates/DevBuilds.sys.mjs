/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The opt-in check for new dev builds.
 *
 * A published dev build (tools/release/dev-release.sh) carries
 * dev-build.json next to the browser: its release tag, commit, the commit's
 * time and the GitHub repository. With "Check for new dev builds" on, once a
 * day the browser asks GitHub's API for that repository's releases and
 * looks for a newer dev build. If there is one, the app menu offers it
 * (BrowserWip, browser.js) and links to its release page; nothing is
 * downloaded or installed.
 *
 * Off by default, and in any privacy mode but Standard (as SiteIcons). The
 * request goes through the normal network stack (proxy settings apply),
 * without cookies or a Referer, and nothing about the browser is sent but
 * what any request carries (address, User-Agent). A build without
 * dev-build.json (a local build) has nothing to compare and never checks.
 * "Check now" in Settings is a request of the user's own, so it works with
 * the switch off too.
 */

import { PrivacyModes } from "resource://gre/modules/browserwip/PrivacyModes.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const CHECK_PREF = "browserwip.devBuilds.check";
// When the last check ran, in seconds since the epoch.
const LAST_CHECK_PREF = "browserwip.devBuilds.lastCheck";
// The newer build found, as JSON { tag, name, url, date }; "" for none.
const NEWER_PREF = "browserwip.devBuilds.newer";
// The newer build whose page the user has opened: the menu button's dot goes.
const SEEN_PREF = "browserwip.devBuilds.seen";
// Under automation only (BWV_AUTOMATION=1 and Marionette running): the
// API's address instead of GitHub's, and a dev-build.json for a local build.
const TEST_API_PREF = "browserwip.devBuilds.testApi";
const TEST_BUILD_PREF = "browserwip.devBuilds.testBuild";
const TEST_ENV = "BWV_AUTOMATION";

const CHANGED_TOPIC = "browserwip-dev-builds-changed";
const DAY_S = 24 * 60 * 60;
// After startup, before the first check of the day: not while the session
// restores.
const STARTUP_DELAY_MS = 60 * 1000;
const TIMEOUT_MS = 15 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const DevBuilds = {
  CHANGED_TOPIC,

  // This build's dev-build.json, null when it has none, undefined until read.
  build: undefined,
  _timer: null,
  _checking: null,

  async init() {
    await this._readBuild();
    Services.prefs.addObserver(CHECK_PREF, () => this._schedule(true));
    // Leaving Standard stops the checks; coming back resumes them.
    Services.obs.addObserver(() => this._schedule(true), "browserwip:privacy-mode-changed");
    this._schedule(false);
  },

  async _readBuild() {
    try {
      let path = PathUtils.join(Services.dirsvc.get("GreD", Ci.nsIFile).path, "dev-build.json");
      let test = this._underAutomation() && Services.prefs.getStringPref(TEST_BUILD_PREF, "");
      let build = test ? JSON.parse(test) : await IOUtils.readJSON(path);
      this.build =
        typeof build.tag == "string" && typeof build.repo == "string" && Number.isFinite(build.date) ? build : null;
    } catch (e) {
      this.build = null;
    }
    return this.build;
  },

  /**
   * Why the daily check doesn't run, or null when it does: "unpublished"
   * (not a published dev build), "mode" (a privacy mode other than
   * Standard) or "pref" (switched off, the default).
   */
  blockedReason() {
    if (!this.build) {
      return "unpublished";
    }
    if (PrivacyModes.mode != "standard") {
      return "mode";
    }
    return Services.prefs.getBoolPref(CHECK_PREF, false) ? null : "pref";
  },

  /** The newer dev build found by the last check: { tag, name, url, date }, or null. */
  get newer() {
    try {
      let newer = JSON.parse(Services.prefs.getStringPref(NEWER_PREF, "") || "null");
      // A build found before this one was installed isn't newer any more.
      if (newer && this.build && newer.tag != this.build.tag && Date.parse(newer.date) / 1000 > this.build.date) {
        return newer;
      }
    } catch (e) {}
    return null;
  },

  /** Whether the newer build is one the user hasn't looked at yet. */
  get unseen() {
    let newer = this.newer;
    return !!newer && Services.prefs.getStringPref(SEEN_PREF, "") != newer.tag;
  },

  get lastCheck() {
    let seconds = Services.prefs.getIntPref(LAST_CHECK_PREF, 0);
    return seconds ? new Date(seconds * 1000) : null;
  },

  /** Opens the newer build's release page in a tab of win. */
  openNewer(win) {
    let newer = this.newer;
    if (!newer) {
      return;
    }
    Services.prefs.setStringPref(SEEN_PREF, newer.tag);
    win.BrowserWip.openTab(newer.url);
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  // The next daily check: a day after the last one, and not sooner than a
  // minute after startup. changed: the switch was just turned on or off.
  _schedule(changed) {
    if (this._timer) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    if (changed) {
      Services.obs.notifyObservers(null, CHANGED_TOPIC);
    }
    if (this.blockedReason()) {
      return;
    }
    let due = (Services.prefs.getIntPref(LAST_CHECK_PREF, 0) + DAY_S) * 1000 - Date.now();
    this._timer = lazy.setTimeout(
      () => {
        this._timer = null;
        this.check()
          .catch(() => {})
          .finally(() => this._schedule(false));
      },
      Math.max(due, STARTUP_DELAY_MS)
    );
  },

  /**
   * Asks GitHub for the repository's releases now, and remembers the newest
   * dev build if it's newer than this one. Resolves to { newer } (null when
   * this build is the newest); rejects when the check couldn't run.
   * manual: "Check now", which works with the switch off.
   */
  check({ manual = false } = {}) {
    let reason = this.blockedReason();
    if (reason == "unpublished" || (!manual && reason)) {
      return Promise.reject(new Error(reason));
    }
    this._checking ??= this._check().finally(() => (this._checking = null));
    return this._checking;
  },

  async _check() {
    let releases = await this._fetchReleases();
    let newest = releases
      .filter(r => typeof r?.tag_name == "string" && r.tag_name.startsWith("dev-") && !r.draft)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    let newer =
      newest && newest.tag_name != this.build.tag && Date.parse(newest.created_at) / 1000 > this.build.date
        ? { tag: newest.tag_name, name: String(newest.name ?? newest.tag_name), url: newest.html_url, date: newest.created_at }
        : null;
    // Only GitHub's own release pages are opened from the menu.
    if (newer && !String(newer.url).startsWith(`https://github.com/${this.build.repo}/releases/`)) {
      newer = null;
    }
    Services.prefs.setStringPref(NEWER_PREF, newer ? JSON.stringify(newer) : "");
    Services.prefs.setIntPref(LAST_CHECK_PREF, Math.floor(Date.now() / 1000));
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
    return { newer };
  },

  get _apiURL() {
    let test = this._testAPI();
    return `${test || "https://api.github.com"}/repos/${this.build.repo}/releases?per_page=20`;
  },

  _testAPI() {
    return this._underAutomation() ? Services.prefs.getStringPref(TEST_API_PREF, "") : "";
  },

  _underAutomation() {
    if (Services.env.get(TEST_ENV) != "1") {
      return false;
    }
    try {
      return Cc["@mozilla.org/remote/marionette;1"].getService(Ci.nsIMarionette).running;
    } catch (e) {
      return false;
    }
  },

  // One anonymous GET: no cookies, no Referer, nothing cached.
  async _fetchReleases() {
    let controller = new AbortController();
    let timer = lazy.setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let response = await fetch(this._apiURL, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        headers: { Accept: "application/vnd.github+json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      let text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new Error("response too large");
      }
      let releases = JSON.parse(text);
      if (!Array.isArray(releases)) {
        throw new Error("not a list of releases");
      }
      return releases;
    } finally {
      lazy.clearTimeout(timer);
    }
  },
};
