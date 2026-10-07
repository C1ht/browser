/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Loads the bundled ad and tracker tables into Gecko's URL classifier.
 *
 * The tables are compiled at build time from the vendored filter lists
 * (compile_lists.py) and shipped in the app. They are written into the
 * profile's classifier database once per list version; after that, Gecko's
 * tracking protection reads them like any other table. Nothing is fetched.
 */

import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";

const BASE = "resource://gre/defaults/contentblocking/";
const VERSION_PREF = "browserwip.contentblocking.listsVersion";

export const TABLES = [
  "wip-ads-digest256",
  "wip-track-digest256",
  "wip-social-digest256",
];

function readBinary(url) {
  let channel = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
  let stream = channel.open();
  try {
    // A byte string: one char per byte, which is what updateStream expects.
    return NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
}

function applyUpdate(dbService, table, data) {
  return new Promise((resolve, reject) => {
    let observer = {
      QueryInterface: ChromeUtils.generateQI(["nsIUrlClassifierUpdateObserver"]),
      updateUrlRequested() {},
      streamFinished() {},
      updateError(error) {
        reject(new Error(`Classifier rejected ${table}: 0x${error.toString(16)}`));
      },
      updateSuccess() {
        resolve();
      },
    };
    dbService.beginUpdate(observer, table, "");
    dbService.beginStream(table);
    dbService.updateStream(data);
    dbService.finishStream();
    dbService.finishUpdate();
  });
}

export const COSMETIC_INDEX_KEY = "browserwip:cosmetic-sites";

export const ContentBlockingLists = {
  _loading: null,

  /**
   * Share the per-site element-hiding rules with content processes, which
   * are sandboxed and cannot read them from disk.
   */
  publishCosmeticIndex() {
    let index = JSON.parse(readBinary(BASE + "cosmetic-sites.json"));
    Services.ppmm.sharedData.set(COSMETIC_INDEX_KEY, index);
    Services.ppmm.sharedData.flush();
  },

  get stats() {
    return JSON.parse(readBinary(BASE + "compile-stats.json"));
  },

  // getTables reports one "name;a:chunks" line per table holding data.
  _hasAllTables(dbService) {
    return new Promise(resolve => {
      dbService.getTables(list => {
        let present = new Set(list.split("\n").map(line => line.split(";")[0]));
        resolve(TABLES.every(t => present.has(t)));
      });
    });
  },

  /**
   * Write the bundled tables into the classifier if this profile has an
   * older version (or none). Resolves once the tables are usable.
   */
  ensureLoaded() {
    if (!this._loading) {
      this._loading = this._load().catch(e => {
        this._loading = null;
        console.error("browser-wip: loading content-blocking lists failed", e);
        throw e;
      });
    }
    return this._loading;
  },

  async _load() {
    let { version } = this.stats;
    let dbService = Cc["@mozilla.org/url-classifier/dbservice;1"].getService(
      Ci.nsIUrlClassifierDBService
    );
    if (
      Services.prefs.getStringPref(VERSION_PREF, "") == version &&
      (await this._hasAllTables(dbService))
    ) {
      return false;
    }
    // The database only ever holds our tables, so a version change can start
    // from empty instead of computing deltas.
    dbService.resetDatabase();
    for (let table of TABLES) {
      await applyUpdate(dbService, table, readBinary(`${BASE}${table}.update`));
    }
    Services.prefs.setStringPref(VERSION_PREF, version);
    Services.obs.notifyObservers(null, "browserwip:contentblocking-lists-loaded", version);
    return true;
  },
};
