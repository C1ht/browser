/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * How much the blocker stopped, for the new tab page's privacy report:
 * per day, the trackers blocked and the pages they were blocked on. Counts
 * only, never which sites, kept in the profile for 30 days. Private windows
 * aren't counted. The tab browser reports each page's new blocks (add()).
 */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const FILE = "protection-stats.json";
const KEEP_DAYS = 30;
const SAVE_AFTER_MS = 30 * 1000;

// "2026-10-30", in local time.
function dayKey(date = new Date()) {
  let pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const ProtectionStats = {
  // { "2026-10-30": { trackers, pages } }
  _days: null,
  _loading: null,
  _saveTimer: null,

  get _path() {
    return PathUtils.join(PathUtils.profileDir, FILE);
  },

  _load() {
    this._loading ??= IOUtils.readJSON(this._path)
      .then(data => (this._days = data?.days && typeof data.days == "object" ? data.days : {}))
      .catch(() => (this._days = {}))
      .then(() => {
        Services.obs.addObserver(() => this._save(), "quit-application-granted");
      });
    return this._loading;
  },

  /**
   * A page blocked `trackers` more trackers; `firstOnPage` when they are
   * the first blocked on it.
   */
  async add(trackers, firstOnPage) {
    if (trackers <= 0) {
      return;
    }
    await this._load();
    let day = (this._days[dayKey()] ??= { trackers: 0, pages: 0 });
    day.trackers += trackers;
    day.pages += firstOnPage ? 1 : 0;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), SAVE_AFTER_MS);
  },

  /** The last `days` days, oldest first: { trackers, pages, perDay: [n...] }. */
  async recent(days = 7) {
    await this._load();
    let perDay = [];
    let total = { trackers: 0, pages: 0 };
    for (let i = days - 1; i >= 0; i--) {
      let date = new Date();
      date.setDate(date.getDate() - i);
      let day = this._days[dayKey(date)] ?? { trackers: 0, pages: 0 };
      perDay.push(day.trackers);
      total.trackers += day.trackers;
      total.pages += day.pages;
    }
    return { ...total, perDay };
  },

  _save() {
    clearTimeout(this._saveTimer);
    if (!this._days) {
      return Promise.resolve();
    }
    let oldest = new Date();
    oldest.setDate(oldest.getDate() - KEEP_DAYS);
    let cutoff = dayKey(oldest);
    for (let key of Object.keys(this._days)) {
      if (key < cutoff) {
        delete this._days[key];
      }
    }
    return IOUtils.writeJSON(this._path, { days: this._days }, { tmpPath: this._path + ".tmp" }).catch(
      e => console.error("browser-wip: protection stats not saved", e)
    );
  },
};
