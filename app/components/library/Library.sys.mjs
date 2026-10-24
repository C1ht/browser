/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Bookmarks, history and search suggestions, on top of toolkit's Places:
 * the address bar's dropdown, the bookmarks bar, about:bookmarks and
 * about:history all go through here.
 *
 * History is remembered unless the "noHistory" privacy toggle is strict
 * (Strict Privacy and Anonymous turn it on): then Places records no visits
 * (places.history.enabled), and nothing here shows history in the address
 * bar. History already kept stays until it is cleared.
 *
 * Search suggestions send what is typed to the search engine, so they are
 * off unless turned on (browserwip.search.suggest.enabled), are never asked
 * for text that looks like an address, and go without cookies.
 */

import { PlacesUtils } from "resource://gre/modules/PlacesUtils.sys.mjs";
import { PrivacyModes } from "resource://gre/modules/browserwip/PrivacyModes.sys.mjs";
import {
  currentEngine,
  parseSuggestions,
} from "resource://gre/modules/browserwip/SearchEngines.sys.mjs";

export {
  currentEngine,
  ENGINE_PREF,
  SEARCH_ENGINES,
  searchURL,
} from "resource://gre/modules/browserwip/SearchEngines.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const SUGGEST_PREF = "browserwip.search.suggest.enabled";
// Whether the address bar has offered to turn suggestions on.
export const SUGGEST_OFFERED_PREF = "browserwip.search.suggest.offered";
export const BAR_PREF = "browserwip.bookmarks.bar";

const SUGGEST_TIMEOUT_MS = 2000;

/** Turns the "%" and "_" of LIKE patterns into plain characters. */
function likeEscape(text) {
  return text.replace(/[\\%_]/g, c => "\\" + c);
}

export const Library = {
  // ---------------------------------------------------------------------
  // History on or off

  get historyEnabled() {
    return !PrivacyModes.isStrict("noHistory");
  },

  setHistoryEnabled(on) {
    PrivacyModes.setStrict("noHistory", !on);
  },

  // ---------------------------------------------------------------------
  // The address bar

  /**
   * Bookmarks and (while history is remembered) visited pages matching
   * every word of `text` in their address or title. Bookmarks first, then
   * by how often and how recently they were visited (frecency).
   * Resolves with [{ url, title, bookmarked }].
   */
  async matches(text, limit = 6) {
    let words = text.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) {
      return [];
    }
    let params = {};
    let conditions = words.map((word, i) => {
      params[`w${i}`] = "%" + likeEscape(word) + "%";
      return `(lower(h.url) LIKE :w${i} ESCAPE '\\' OR lower(IFNULL(b.title, h.title)) LIKE :w${i} ESCAPE '\\')`;
    });
    let history = this.historyEnabled;
    let db = await PlacesUtils.promiseDBConnection();
    let rows = await db.executeCached(
      `SELECT h.url, IFNULL(b.title, h.title) AS title, b.id IS NOT NULL AS bookmarked
       FROM moz_places h
       LEFT JOIN moz_bookmarks b ON b.fk = h.id AND b.type = 1
       WHERE h.url_hash BETWEEN hash('http', 'prefix_lo') AND hash('http', 'prefix_hi')
         AND (b.id IS NOT NULL OR ${history ? "(h.hidden = 0 AND h.visit_count > 0)" : "0"})
         AND ${conditions.join(" AND ")}
       GROUP BY h.id
       ORDER BY bookmarked DESC, h.frecency DESC
       LIMIT :limit`,
      { ...params, limit }
    );
    return rows.map(row => ({
      url: row.getResultByName("url"),
      title: row.getResultByName("title") || "",
      bookmarked: !!row.getResultByName("bookmarked"),
    }));
  },

  /**
   * Search suggestions for `text` from the selected engine, if they are
   * turned on and it has them. `signal` aborts a request overtaken by more
   * typing. Never throws: no suggestions on any failure.
   */
  async suggestions(text, signal) {
    let engine = currentEngine();
    let query = text.trim();
    if (!Services.prefs.getBoolPref(SUGGEST_PREF, false) || !engine.suggest || !query || query.length > 200) {
      return [];
    }
    // A test profile points this at a local server.
    let base = Services.prefs.getStringPref("browserwip.search.suggest.testURL", "") || engine.suggest;
    // AbortSignal.timeout() needs a window; this module has none.
    let controller = new AbortController();
    let timer = lazy.setTimeout(() => controller.abort(), SUGGEST_TIMEOUT_MS);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      let response = await fetch(base + encodeURIComponent(query), {
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (!response.ok) {
        return [];
      }
      return parseSuggestions(await response.text(), query);
    } catch (e) {
      return [];
    } finally {
      lazy.clearTimeout(timer);
    }
  },

  // ---------------------------------------------------------------------
  // History

  /**
   * Visits, newest first, grouped later by day: [{ url, title, time }] with
   * one row per page per day. `query` narrows by address or title.
   */
  async history({ query = "", limit = 200, before = null } = {}) {
    let params = { limit };
    let filter = "";
    let words = query.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    words.forEach((word, i) => {
      params[`w${i}`] = "%" + likeEscape(word) + "%";
      filter += ` AND (lower(h.url) LIKE :w${i} ESCAPE '\\' OR lower(IFNULL(h.title, '')) LIKE :w${i} ESCAPE '\\')`;
    });
    if (before) {
      params.before = before * 1000;
      filter += " AND v.visit_date < :before";
    }
    let db = await PlacesUtils.promiseDBConnection();
    let rows = await db.executeCached(
      `SELECT h.url, h.title, MAX(v.visit_date) AS time
       FROM moz_historyvisits v JOIN moz_places h ON h.id = v.place_id
       WHERE h.hidden = 0 AND v.visit_type NOT IN (0, 4, 7, 8, 9) ${filter}
       GROUP BY h.id, date(v.visit_date / 1000000, 'unixepoch', 'localtime')
       ORDER BY time DESC
       LIMIT :limit`,
      params
    );
    return rows.map(row => ({
      url: row.getResultByName("url"),
      title: row.getResultByName("title") || "",
      time: Math.floor(row.getResultByName("time") / 1000),
    }));
  },

  async removePage(url) {
    await PlacesUtils.history.remove(url);
  },

  /** Every page of a host (and its subdomains). */
  async removeSite(host) {
    await PlacesUtils.history.removeByFilter({ host: "." + host.replace(/^www\./, "") });
  },

  /**
   * Clears history: "hour", "today" (since midnight) or "all". Bookmarks
   * stay; their pages lose only their visits.
   */
  async clearHistory(range) {
    if (range == "all") {
      await PlacesUtils.history.clear();
      return;
    }
    let beginDate =
      range == "hour" ? new Date(Date.now() - 60 * 60 * 1000) : new Date(new Date().setHours(0, 0, 0, 0));
    await PlacesUtils.history.removeVisitsByFilter({ beginDate, endDate: new Date() });
  },

  // ---------------------------------------------------------------------
  // Bookmarks

  BAR: PlacesUtils.bookmarks.toolbarGuid,
  OTHER: PlacesUtils.bookmarks.unfiledGuid,

  /** The first bookmark of `url`, or null. */
  async bookmarkFor(url) {
    try {
      return await PlacesUtils.bookmarks.fetch({ url });
    } catch (e) {
      return null;
    }
  },

  /** Bookmarks `url` in the bookmarks bar (or `parentGuid`). */
  async addBookmark({ url, title, parentGuid = this.BAR }) {
    return PlacesUtils.bookmarks.insert({ parentGuid, url, title: title || url });
  },

  async updateBookmark(guid, changes) {
    return PlacesUtils.bookmarks.update({ guid, ...changes });
  },

  async removeBookmark(guid) {
    await PlacesUtils.bookmarks.remove(guid);
  },

  async removeBookmarksFor(url) {
    let guids = [];
    await PlacesUtils.bookmarks.fetch({ url }, b => guids.push(b.guid));
    for (let guid of guids) {
      await PlacesUtils.bookmarks.remove(guid);
    }
  },

  async addFolder({ title, parentGuid = this.OTHER }) {
    return PlacesUtils.bookmarks.insert({ parentGuid, type: PlacesUtils.bookmarks.TYPE_FOLDER, title });
  },

  /** A folder's children: [{ guid, type: "bookmark" | "folder" | "separator", title, url }]. */
  async children(parentGuid) {
    let tree = await PlacesUtils.promiseBookmarksTree(parentGuid, { includeItemIds: false });
    return (tree?.children ?? []).map(node => ({
      guid: node.guid,
      type:
        node.type == PlacesUtils.TYPE_X_MOZ_PLACE
          ? "bookmark"
          : node.type == PlacesUtils.TYPE_X_MOZ_PLACE_CONTAINER
            ? "folder"
            : "separator",
      title: node.title || "",
      url: node.uri ?? null,
      parentGuid,
    }));
  },

  /** Every folder under the bar and Other bookmarks, depth first: [{ guid, title, depth }]. */
  async folders() {
    let out = [];
    let walk = async (guid, depth) => {
      for (let child of await this.children(guid)) {
        if (child.type == "folder") {
          out.push({ guid: child.guid, title: child.title, depth });
          await walk(child.guid, depth + 1);
        }
      }
    };
    for (let root of [this.BAR, this.OTHER]) {
      out.push({ guid: root, title: null, depth: 0 });
      await walk(root, 1);
    }
    return out;
  },

  /** Bookmarks matching every word, across all folders. */
  async searchBookmarks(query) {
    let results = await PlacesUtils.bookmarks.search(query);
    return results
      .filter(b => b.type == PlacesUtils.bookmarks.TYPE_BOOKMARK)
      .map(b => ({ guid: b.guid, type: "bookmark", title: b.title || "", url: b.url.href, parentGuid: b.parentGuid }));
  },

  async moveBookmark(guid, parentGuid, index = PlacesUtils.bookmarks.DEFAULT_INDEX) {
    return PlacesUtils.bookmarks.update({ guid, parentGuid, index });
  },

  async importHTML(path) {
    let { BookmarkHTMLUtils } = ChromeUtils.importESModule("resource://gre/modules/BookmarkHTMLUtils.sys.mjs");
    return BookmarkHTMLUtils.importFromFile(path, { replace: false });
  },

  async exportHTML(path) {
    let { BookmarkHTMLUtils } = ChromeUtils.importESModule("resource://gre/modules/BookmarkHTMLUtils.sys.mjs");
    return BookmarkHTMLUtils.exportToFile(path);
  },

  // ---------------------------------------------------------------------
  // Site icons, for the bookmarks bar and the address bar

  /** An address as people read it: no https://, no trailing /, %20 as a space. */
  displayURL(url) {
    let text = url;
    try {
      text = Services.textToSubURI.unEscapeURIForUI(url);
    } catch (e) {}
    return text.replace(/^https:\/\//, "").replace(/\/$/, "");
  },

  /** The page-icon: URL showing `url`'s stored icon. */
  iconURL(url) {
    return "page-icon:" + url;
  },

  /**
   * Keeps a page's icon (a data: URL from FaviconParent) for bookmarked
   * pages, and for visited ones while history is remembered.
   */
  async storeIcon(url, dataURL) {
    if (!/^https?:/.test(url)) {
      return;
    }
    if (!this.historyEnabled && !(await this.bookmarkFor(url))) {
      return;
    }
    let store = () =>
      PlacesUtils.favicons.setFaviconForPage(
        Services.io.newURI(url),
        Services.io.newURI("fake-favicon-uri:" + url),
        Services.io.newURI(dataURL)
      );
    try {
      await store();
    } catch (e) {
      // The icon can come before the visit is written: once more, later.
      // Still not in Places (not visited, not bookmarked): nothing to keep.
      await new Promise(resolve => lazy.setTimeout(resolve, 2000));
      await store().catch(() => {});
    }
  },
};
