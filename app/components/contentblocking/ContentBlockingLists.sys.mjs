/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Starts the network blocker (blocker/NetworkBlocker.cpp) with the bundled
 * filter lists, and shares the element-hiding rules with content processes.
 *
 * The lists ship in the app as text. The blocker compiles them in the
 * background at every startup and holds requests until it is done. Nothing
 * is fetched.
 */

import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";

const BASE = "resource://gre/defaults/contentblocking/";
const MAIN_LISTS = ["easylist.txt", "easyprivacy.txt"];
const SOCIAL_LISTS = ["fanboy-social.txt"];
export const BLOCKER_STATE_TOPIC = "browserwip:blocker-state";

// Left in profiles by builds that loaded the lists into the URL classifier.
const OLD_VERSION_PREF = "browserwip.contentblocking.listsVersion";

function readBinary(url) {
  let channel = NetUtil.newChannel({ uri: url, loadUsingSystemPrincipal: true });
  let stream = channel.open();
  try {
    // A byte string: one char per byte, which is what an ACString takes.
    return NetUtil.readInputStreamToString(stream, stream.available());
  } finally {
    stream.close();
  }
}

function readLists(names) {
  return names.map(name => readBinary(BASE + name)).join("\n");
}

export const COSMETIC_INDEX_KEY = "browserwip:cosmetic-sites";

export const ContentBlockingLists = {
  _blocker: null,

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

  /**
   * Start blocking. Call before anything loads pages: requests made before
   * the blocker has its lists are not held.
   */
  start() {
    if (this._blocker) {
      return;
    }
    this._blocker = Cc["@browser-wip/network-blocker;1"].getService(Ci.nsIBrowserWipBlocker);
    let main = "";
    let social = "";
    try {
      main = readLists(MAIN_LISTS);
      social = readLists(SOCIAL_LISTS);
    } catch (e) {
      // The blocker reports missing lists as a failed build, which the
      // shield shows.
      console.error("browser-wip: filter lists unreadable", e);
    }
    this._blocker.start(main, social);
    this._forgetClassifierTables();
  },

  /**
   * "idle", "building", "ready", "failed" or "timeout"; changes are
   * announced with BLOCKER_STATE_TOPIC.
   */
  get state() {
    return this._blocker?.state ?? "idle";
  },

  /** True when blocking should be on but isn't working. */
  get unavailable() {
    return this.state == "failed" || this.state == "timeout";
  },

  // Earlier builds wrote the lists into the URL classifier's database. No
  // pref names those tables any more; drop the data once.
  _forgetClassifierTables() {
    if (!Services.prefs.prefHasUserValue(OLD_VERSION_PREF)) {
      return;
    }
    try {
      Cc["@mozilla.org/url-classifier/dbservice;1"]
        .getService(Ci.nsIUrlClassifierDBService)
        .resetDatabase();
    } catch (e) {
      console.error("browser-wip: could not clear old classifier tables", e);
    }
    Services.prefs.clearUserPref(OLD_VERSION_PREF);
  },
};
