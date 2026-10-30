/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The opt-in YouTube ad blocker's rules (docs/CONTENT-BLOCKING.md,
 * "YouTube ads"). Off by default; Settings turns it on after saying what it
 * downloads.
 *
 * While it is on, uBlock Origin's lists are downloaded when they are more
 * than 8 hours old: without cookies or a referrer, from the addresses in
 * browserwip.youtubeblocking.lists. Their YouTube rules are compiled
 * (YouTubeRules.sys.mjs), cached in the profile and shared with content
 * processes, where YouTubeBlockingChild applies them. A failed download
 * keeps the rules already there and is retried an hour later. Turning it off
 * stops the downloads and deletes the cache.
 *
 * Nothing here runs, and nothing is downloaded, while it is off.
 */

import { compileLists, YOUTUBE_RULES_KEY } from "resource://gre/modules/browserwip/YouTubeRules.sys.mjs";
import { clearInterval, setInterval, setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

export const ENABLED_PREF = "browserwip.youtubeblocking.enabled";
const LISTS_PREF = "browserwip.youtubeblocking.lists";
export const YOUTUBE_BLOCKING_TOPIC = "browserwip:youtube-blocking";

const CACHE_FILE = "youtube-blocking.json";
const UPDATE_AFTER_MS = 8 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 60 * 60 * 1000;
const CHECK_EVERY_MS = 15 * 60 * 1000;
// With rules already cached, the first check waits until startup is over.
const STARTUP_DELAY_MS = 20 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 1000;
const MAX_LIST_LENGTH = 8 * 1024 * 1024;

class UpdateError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// HTTPS only; plain HTTP on this machine, for the runtime checks.
function allowedListURL(spec) {
  try {
    let url = new URL(spec);
    return (
      url.protocol == "https:" ||
      (url.protocol == "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    );
  } catch (e) {
    return false;
  }
}

export const YouTubeBlocking = {
  // "off", "updating", "ready" or "error".
  _state: "off",
  // When the rules in use were downloaded (ms), or 0.
  _updated: 0,
  _stats: null,
  // Why the last update failed, if it did.
  _error: null,
  _lastAttempt: 0,
  _timer: null,
  _startTimer: null,
  _pending: null,
  _initialized: false,

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, false);
  },

  /** For Settings: { state, updated, error, stats }. */
  get status() {
    return { state: this._state, updated: this._updated, error: this._error, stats: this._stats };
  },

  get _cachePath() {
    return PathUtils.join(PathUtils.profileDir, CACHE_FILE);
  },

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    Services.prefs.addObserver(ENABLED_PREF, this);
    if (this.enabled) {
      this._start();
    } else {
      // Left by a session that ended while turning it off.
      IOUtils.remove(this._cachePath, { ignoreAbsent: true }).catch(() => {});
    }
  },

  observe(subject, topic) {
    if (topic == "nsPref:changed") {
      if (this.enabled) {
        this._start();
      } else {
        this._stop();
      }
    }
  },

  async _start() {
    if (this._timer) {
      return;
    }
    this._timer = setInterval(() => this._maybeUpdate(), CHECK_EVERY_MS);
    let cache = null;
    try {
      cache = await IOUtils.readJSON(this._cachePath);
    } catch (e) {
      // None yet, or unreadable: download.
    }
    if (!this.enabled) {
      return;
    }
    if (cache?.version == 1 && cache.compiled?.scriptlets) {
      this._publish(cache.compiled);
      this._updated = cache.updated;
      this._stats = cache.compiled.stats;
      this._setState("ready");
      this._startTimer = setTimeout(() => this._maybeUpdate(), STARTUP_DELAY_MS);
    } else {
      this.update();
    }
  },

  _stop() {
    clearInterval(this._timer);
    clearTimeout(this._startTimer);
    this._timer = this._startTimer = null;
    Services.ppmm.sharedData.delete(YOUTUBE_RULES_KEY);
    Services.ppmm.sharedData.flush();
    IOUtils.remove(this._cachePath, { ignoreAbsent: true }).catch(() => {});
    this._updated = 0;
    this._stats = null;
    this._error = null;
    this._lastAttempt = 0;
    this._setState("off");
  },

  _maybeUpdate() {
    if (!this.enabled) {
      return;
    }
    let now = Date.now();
    if (this._error && now - this._lastAttempt < RETRY_AFTER_MS) {
      return;
    }
    if (!this._updated || now - this._updated >= UPDATE_AFTER_MS) {
      this.update();
    }
  },

  /** Downloads the lists now. Resolves when done, whether or not it worked. */
  update() {
    if (!this.enabled) {
      return Promise.resolve();
    }
    this._pending ??= this._update().finally(() => (this._pending = null));
    return this._pending;
  },

  async _update() {
    this._lastAttempt = Date.now();
    this._setState("updating");
    try {
      let urls = Services.prefs.getStringPref(LISTS_PREF, "").split(/\s+/).filter(Boolean);
      if (!urls.length || !urls.every(allowedListURL)) {
        throw new UpdateError("bad-address");
      }
      let texts = [];
      for (let url of urls) {
        texts.push(await this._download(url));
      }
      let compiled = compileLists(texts);
      if (!compiled.stats.scriptlets) {
        throw new UpdateError("no-rules");
      }
      if (!this.enabled) {
        return;
      }
      let updated = Date.now();
      await IOUtils.writeJSON(
        this._cachePath,
        { version: 1, updated, compiled },
        { tmpPath: this._cachePath + ".tmp" }
      );
      if (!this.enabled) {
        await IOUtils.remove(this._cachePath, { ignoreAbsent: true });
        return;
      }
      this._publish(compiled);
      this._updated = updated;
      this._stats = compiled.stats;
      this._error = null;
      this._setState("ready");
    } catch (e) {
      if (!this.enabled) {
        return;
      }
      this._error = e.code ?? "download-failed";
      console.warn("browser-wip: YouTube rules not updated:", e.code ?? e);
      this._setState("error");
    }
  },

  async _download(url) {
    let controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      let response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-cache",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new UpdateError("http-error");
      }
      let text = await response.text();
      if (text.length > MAX_LIST_LENGTH) {
        throw new UpdateError("too-large");
      }
      // Filter lists start with a comment or an [Adblock] header.
      if (!/^\s*[![]/.test(text)) {
        throw new UpdateError("not-a-list");
      }
      return text;
    } catch (e) {
      throw e instanceof UpdateError ? e : new UpdateError("download-failed");
    } finally {
      clearTimeout(timer);
    }
  },

  _publish(compiled) {
    Services.ppmm.sharedData.set(YOUTUBE_RULES_KEY, compiled);
    Services.ppmm.sharedData.flush();
  },

  _setState(state) {
    this._state = state;
    Services.obs.notifyObservers(null, YOUTUBE_BLOCKING_TOPIC, state);
  },
};
