/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Icons for the new tab page's Favorites: the bookmarks on the bookmarks
 * bar. (There are no default tiles.)
 *
 * Where an icon comes from:
 *  - a visit: when a page of a favorite's site loads (not in a private
 *    window), FaviconParent hands over the icon the page loaded itself,
 *    its largest one (apple-touch-icon first). Nothing extra is fetched by
 *    the browser.
 *  - adding a favorite from the page you're on: the icon that page already
 *    loaded for its tab.
 *  - otherwise (a typed address), and only with "Download icons for my
 *    favorites" on, in Standard, outside private windows: one fetch when
 *    the favorite is added. One attempt per favorite, one fetch at a time;
 *    a failure is remembered until the next visit. Imported bookmarks are
 *    never fetched, and favorites on the local network never are: they get
 *    their icon on a visit.
 *
 * The fetch (docs/PLAN.md, "Favorite icons"): the site's home page, then
 * the best icon it names. Requests go through the normal network stack
 * with the site's own origin as their loading principal, so the proxy, DNS
 * and the network blocker apply, with no cookies, no Referer, no Origin,
 * and nothing written to the HTTP cache. HTTPS only; redirects only within
 * the site; never to a local or private address (checked before
 * connecting and again on the response). Limits are in SiteIconRules.
 *
 * Every icon is checked (type from its bytes: PNG, ICO or SVG; size from
 * its header) and re-encoded to a PNG of at most 128px before it's kept,
 * in favorite-icons.json in the profile. PNG and ICO go through imgITools;
 * an SVG is drawn as an image (no scripts, no external loads) on a canvas
 * in a windowless document.
 */

import { PlacesUtils } from "resource://gre/modules/PlacesUtils.sys.mjs";
import { PrivacyModes } from "resource://gre/modules/browserwip/PrivacyModes.sys.mjs";
import {
  FETCH_TIMEOUT_MS,
  MAX_ICON_BYTES,
  MAX_PAGE_BYTES,
  STORED_SIZE,
  checkIcon,
  iconCandidates,
  isIPAddress,
  isLocalHost,
  isPrivateAddress,
  redirectAllowed,
} from "resource://gre/modules/browserwip/SiteIconRules.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const FETCH_PREF = "browserwip.newtab.siteIcons";
// Hosts the runtime checks serve from 127.0.0.1 (comma-separated). Read
// only under automation: BWV_AUTOMATION=1 and Marionette running.
const TEST_HOSTS_PREF = "browserwip.newtab.siteIcons.testHosts";
const TEST_ENV = "BWV_AUTOMATION";
// A bookmark added from the page you're on: how long the star button's
// note (the tab's icon, private or not) waits for Places' event.
const EXPECT_MS = 10000;
const FILE = "favorite-icons.json";
// From the first version, which fetched in the background.
const OLD_FILE = "site-icons.json";
export const CHANGED_TOPIC = "browserwip:favorite-icons-changed";

export function hostOf(url) {
  return new URL(url).hostname.replace(/^www\./, "");
}

function getBaseDomain(host) {
  return Services.eTLD.getBaseDomainFromHost(host);
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function dataURLBytes(dataURL) {
  let match = /^data:[^;,]*;base64,(.*)$/s.exec(dataURL ?? "");
  if (!match) {
    return null;
  }
  try {
    return Uint8Array.from(atob(match[1]), c => c.charCodeAt(0));
  } catch (e) {
    return null;
  }
}

function originOf(url) {
  try {
    let parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
  } catch (e) {
    return null;
  }
}

class FetchError extends Error {}

export const SiteIcons = {
  _cache: null,
  _loading: null,
  _favorites: null,
  _expected: new Map(),
  _queue: Promise.resolve(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    this._listener = events => this._onBookmarkEvents(events);
    PlacesUtils.observers.addListener(["bookmark-added", "bookmark-removed", "bookmark-moved"], this._listener);
    // A visit ends a remembered failure, even when the page has no icon.
    this._visitListener = events => this._onVisits(events);
    PlacesUtils.observers.addListener(["page-visited"], this._visitListener);
    IOUtils.remove(PathUtils.join(PathUtils.profileDir, OLD_FILE), { ignoreAbsent: true }).catch(() => {});
  },

  /**
   * Why fetching is off, or null when it's on: "private" (a private
   * window), "mode" (Strict or Anonymous) or "pref" (switched off, the
   * default).
   */
  blockedReason(isPrivate = false) {
    if (isPrivate) {
      return "private";
    }
    if (PrivacyModes.mode != "standard") {
      return "mode";
    }
    return Services.prefs.getBoolPref(FETCH_PREF, false) ? null : "pref";
  },

  // -- The kept icons ------------------------------------------------------

  get _path() {
    return PathUtils.join(PathUtils.profileDir, FILE);
  },

  async _load() {
    this._loading ??= IOUtils.readJSON(this._path)
      .catch(() => ({}))
      .then(cache => (this._cache = cache && typeof cache == "object" ? cache : {}));
    return this._loading;
  },

  _save() {
    lazy.clearTimeout(this._saveTimer);
    this._saveTimer = lazy.setTimeout(() => {
      this._saved = IOUtils.writeJSON(this._path, this._cache, { tmpPath: this._path + ".tmp" }).catch(e =>
        console.warn("browser-wip: saving favorite icons failed", e)
      );
    }, 500);
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  /** The kept icon for a page's site: { src, touch }, or null. */
  async get(url) {
    await this._load();
    let entry = this._cache[originOf(url)];
    return entry?.src ? { src: entry.src, touch: !!entry.touch } : null;
  },

  /** Clear history -> All: every kept icon goes. */
  async clear() {
    await this._load();
    this._cache = {};
    lazy.clearTimeout(this._saveTimer);
    await IOUtils.remove(this._path, { ignoreAbsent: true });
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  async _store(origin, entry) {
    await this._load();
    this._cache[origin] = { ...entry, at: Date.now() };
    this._save();
  },

  // -- Which sites are favorites ----------------------------------------

  async _favoriteOrigins() {
    if (!this._favorites) {
      let origins = new Set();
      let tree = await PlacesUtils.promiseBookmarksTree(PlacesUtils.bookmarks.toolbarGuid).catch(() => null);
      for (let node of tree?.children ?? []) {
        let origin = node.uri && originOf(node.uri);
        if (origin) {
          origins.add(origin);
        }
      }
      this._favorites = origins;
    }
    return this._favorites;
  },

  async isFavorite(url) {
    let origin = originOf(url);
    return !!origin && (await this._favoriteOrigins()).has(origin);
  },

  /** A favorite went: its icon goes too, unless another is on that site. */
  async forget(url) {
    this._favorites = null;
    let origin = originOf(url);
    if (!origin || (await this.isFavorite(url))) {
      return;
    }
    await this._load();
    if (origin in this._cache) {
      delete this._cache[origin];
      this._save();
    }
  },

  // -- Adding a favorite ----------------------------------------------------

  /**
   * The star button, just before it bookmarks the page: the icon the page
   * already loaded for its tab, and whether the window is private.
   */
  expectAdd(url, { iconURL = null, isPrivate = false } = {}) {
    this._expected.set(url, { iconURL, isPrivate });
    lazy.setTimeout(() => this._expected.delete(url), EXPECT_MS);
  },

  _onBookmarkEvents(events) {
    let bar = PlacesUtils.bookmarks.toolbarGuid;
    for (let event of events) {
      if (event.itemType != PlacesUtils.bookmarks.TYPE_BOOKMARK || !event.url) {
        continue;
      }
      let user = event.source == PlacesUtils.bookmarks.SOURCES.DEFAULT;
      let toBar = event.parentGuid == bar && (event.type == "bookmark-added" || event.oldParentGuid != bar);
      let fromBar =
        (event.type == "bookmark-removed" && event.parentGuid == bar) ||
        (event.type == "bookmark-moved" && event.oldParentGuid == bar && event.parentGuid != bar);
      this._favorites = null;
      if (toBar && event.type != "bookmark-removed" && user) {
        this._added(event.url).catch(e => console.warn("browser-wip: favorite icon", e));
      } else if (fromBar) {
        this.forget(event.url).catch(() => {});
      }
    }
  },

  async _onVisits(events) {
    await this._load();
    for (let event of events) {
      let origin = originOf(event.url);
      if (origin && this._cache[origin]?.failed) {
        delete this._cache[origin];
        this._save();
      }
    }
  },

  _activeWindowPrivate() {
    let win = Services.wm.getMostRecentWindow("navigator:browser");
    return !!win && lazy.PrivateBrowsingUtils.isWindowPrivate(win);
  },

  async _added(url) {
    let expected = this._expected.get(url);
    this._expected.delete(url);
    let origin = originOf(url);
    if (!origin || expected?.isPrivate || this._activeWindowPrivate()) {
      return;
    }
    await this._load();
    // One attempt per favorite: an icon, or a failure until the next visit.
    if (this._cache[origin]) {
      return;
    }
    // The icon the page already loaded, through the normal favicon path.
    let icon = expected?.iconURL ? await this._fromDataURL(expected.iconURL) : null;
    icon ??= await this._fromPlaces(url);
    if (icon) {
      await this._store(origin, icon);
      return;
    }
    if (this.blockedReason(false)) {
      return;
    }
    this._queue = this._queue.then(() => this._fetchFavorite(url)).catch(() => {});
    await this._queue;
  },

  async _fromPlaces(url) {
    for (let page of [url, originOf(url) + "/"]) {
      try {
        let icon = await PlacesUtils.favicons.getFaviconForPage(Services.io.newURI(page), STORED_SIZE);
        let found = icon?.dataURI && (await this._fromDataURL(icon.dataURI.spec));
        if (found) {
          return found;
        }
      } catch (e) {}
    }
    return null;
  },

  // -- A visit ------------------------------------------------------------

  /**
   * The icon a page of a favorite's site loaded itself (FaviconParent; never
   * from a private window). It replaces the kept one and ends a remembered
   * failure.
   */
  async storeFromVisit(url, dataURL, touch) {
    let origin = originOf(url);
    if (!origin || !(await this.isFavorite(url))) {
      return;
    }
    let icon = await this._fromDataURL(dataURL, touch);
    if (icon) {
      await this._store(origin, icon);
    } else {
      await this._load();
      if (this._cache[origin]?.failed) {
        delete this._cache[origin];
        this._save();
      }
    }
  },

  // -- Fetching -----------------------------------------------------------

  async _fetchFavorite(url) {
    let origin = originOf(url);
    await this._load();
    if (this._cache[origin] || this.blockedReason(false) || !(await this.isFavorite(url))) {
      return;
    }
    let icon = null;
    try {
      icon = await this._fetchIcon(url);
    } catch (e) {
      if (!(e instanceof FetchError)) {
        console.warn("browser-wip: fetching a favorite's icon failed", e);
      }
    }
    // Deleted while it was fetched.
    if (!(await this.isFavorite(url))) {
      return;
    }
    await this._store(origin, icon ?? { failed: true });
  },

  _testHosts() {
    if (Services.env.get(TEST_ENV) != "1") {
      return [];
    }
    try {
      if (!Cc["@mozilla.org/remote/marionette;1"].getService(Ci.nsIMarionette).running) {
        return [];
      }
    } catch (e) {
      return [];
    }
    return Services.prefs
      .getStringPref(TEST_HOSTS_PREF, "")
      .split(",")
      .map(h => h.trim().toLowerCase())
      .filter(h => h && h != "localhost" && !isIPAddress(h));
  },

  async _fetchIcon(url) {
    let site = new URL(url);
    // LAN and private-address favorites get their icon on a visit.
    if (site.protocol != "https:" && site.protocol != "http:") {
      return null;
    }
    if (isLocalHost(site.hostname)) {
      return null;
    }
    let home = `https://${site.host}/`;
    let job = { home, testHosts: this._testHosts(), channel: null, timedOut: false };
    let timer = lazy.setTimeout(() => {
      job.timedOut = true;
      job.channel?.cancel(Cr.NS_BINDING_ABORTED);
    }, FETCH_TIMEOUT_MS);
    try {
      let candidates;
      try {
        let page = await this._request(job, home, {
          type: Ci.nsIContentPolicy.TYPE_OTHER,
          accept: "text/html",
          limit: MAX_PAGE_BYTES,
          truncate: true,
        });
        let html = /html/i.test(page.contentType) ? new TextDecoder().decode(page.bytes) : "";
        candidates = iconCandidates(html, page.url, getBaseDomain);
      } catch (e) {
        if (job.timedOut || e.refused) {
          return null;
        }
        candidates = iconCandidates("", home, getBaseDomain);
      }
      for (let candidate of candidates.slice(0, 4)) {
        if (job.timedOut) {
          return null;
        }
        try {
          let { bytes } = await this._request(job, candidate.url, {
            type: Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE_FAVICON,
            accept: "image/png,image/x-icon,image/svg+xml;q=0.9",
            limit: MAX_ICON_BYTES,
            truncate: false,
          });
          let icon = await this._encode(bytes, candidate.touch);
          if (icon) {
            return icon;
          }
        } catch (e) {
          if (e.refused) {
            return null;
          }
        }
      }
      return null;
    } finally {
      lazy.clearTimeout(timer);
    }
  },

  _refuse(reason) {
    let error = new FetchError(reason);
    error.refused = true;
    return error;
  },

  async _isProxied(channel) {
    return new Promise(resolve => {
      try {
        Services.pps.asyncResolve(channel, 0, {
          QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyCallback"]),
          onProxyAvailable(request, ch, info) {
            resolve(!!info && info.type != "direct");
          },
        });
      } catch (e) {
        resolve(false);
      }
    });
  },

  // The host's addresses; refused when any of them is private.
  async _checkAddresses(job, host) {
    if (job.testHosts.includes(host.toLowerCase())) {
      return;
    }
    let addresses = await new Promise((resolve, reject) => {
      Services.dns.asyncResolve(
        host,
        Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
        0,
        null,
        {
          QueryInterface: ChromeUtils.generateQI(["nsIDNSListener"]),
          onLookupComplete(request, record, status) {
            if (!Components.isSuccessCode(status)) {
              reject(new FetchError("dns"));
              return;
            }
            let list = [];
            record.QueryInterface(Ci.nsIDNSAddrRecord);
            while (record.hasMore()) {
              list.push(record.getNextAddrAsString());
            }
            resolve(list);
          },
        },
        Services.tm.mainThread,
        {}
      );
    });
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw this._refuse("private-address");
    }
  },

  /**
   * One GET through the network stack: { bytes, contentType, url } (url
   * after redirects). limit: bytes kept; truncate: stop there and keep
   * what came, else fail.
   */
  async _request(job, url, { type, accept, limit, truncate }) {
    let uri = Services.io.newURI(url);
    if (uri.scheme != "https" || isLocalHost(uri.host)) {
      throw this._refuse("not-https-or-local");
    }
    let site = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(job.home), {});
    let channel = lazy.NetUtil.newChannel({
      uri,
      loadingPrincipal: site,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_OMIT,
      contentPolicyType: type,
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.loadFlags |=
      Ci.nsIRequest.LOAD_ANONYMOUS |
      Ci.nsIRequest.LOAD_BYPASS_CACHE |
      Ci.nsIRequest.INHIBIT_CACHING |
      Ci.nsIRequest.INHIBIT_PERSISTENT_CACHING |
      Ci.nsIRequest.LOAD_BACKGROUND;
    channel.setRequestHeader("Accept", accept, false);
    // Through a proxy, the proxy picks the address; only names are checked.
    let proxied = await this._isProxied(channel);
    if (!proxied) {
      await this._checkAddresses(job, uri.host);
    }
    if (job.timedOut) {
      throw new FetchError("timeout");
    }

    let self = this;
    let redirects = 0;
    return new Promise((resolve, reject) => {
      let chunks = [];
      let total = 0;
      let done = false;
      let finish = (error, value) => {
        if (!done) {
          done = true;
          error ? reject(error) : resolve(value);
        }
      };
      let result = request => ({
        bytes: (() => {
          let bytes = new Uint8Array(Math.min(total, limit));
          let offset = 0;
          for (let chunk of chunks) {
            let part = chunk.subarray(0, bytes.length - offset);
            bytes.set(part, offset);
            offset += part.length;
          }
          return bytes;
        })(),
        contentType: request.QueryInterface(Ci.nsIChannel).contentType ?? "",
        url: request.QueryInterface(Ci.nsIChannel).URI.spec,
      });
      channel.notificationCallbacks = {
        QueryInterface: ChromeUtils.generateQI(["nsIInterfaceRequestor", "nsIChannelEventSink"]),
        getInterface(iid) {
          return this.QueryInterface(iid);
        },
        asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
          redirects++;
          let target = newChannel.URI;
          if (!redirectAllowed(job.home, target.spec, redirects, getBaseDomain)) {
            finish(self._refuse("redirect"));
            callback.onRedirectVerifyCallback(Cr.NS_ERROR_ABORT);
            return;
          }
          (proxied ? Promise.resolve() : self._checkAddresses(job, target.host)).then(
            () => {
              job.channel = newChannel;
              callback.onRedirectVerifyCallback(Cr.NS_OK);
            },
            error => {
              finish(error);
              callback.onRedirectVerifyCallback(Cr.NS_ERROR_ABORT);
            }
          );
        },
      };
      channel.asyncOpen({
        QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
        onStartRequest(request) {
          let http = request.QueryInterface(Ci.nsIHttpChannel);
          let fail = error => {
            finish(error);
            request.cancel(Cr.NS_BINDING_ABORTED);
          };
          try {
            if (!http.requestSucceeded) {
              fail(new FetchError("http-" + http.responseStatus));
              return;
            }
          } catch (e) {
            fail(new FetchError("no-response"));
            return;
          }
          // Again on the connection itself: a name can change its address
          // between the check and the connection.
          if (!proxied && !job.testHosts.includes(http.URI.host.toLowerCase())) {
            let address = "";
            try {
              address = request.QueryInterface(Ci.nsIHttpChannelInternal).remoteAddress;
            } catch (e) {}
            if (isPrivateAddress(address)) {
              fail(self._refuse("private-address"));
              return;
            }
          }
          if (!truncate && http.contentLength > limit) {
            fail(new FetchError("too-large"));
          }
        },
        onDataAvailable(request, stream, offset, count) {
          let input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
          input.setInputStream(stream);
          let buffer = new ArrayBuffer(count);
          input.readArrayBuffer(count, buffer);
          if (done) {
            return;
          }
          chunks.push(new Uint8Array(buffer));
          total += count;
          if (total > limit || (truncate && total == limit)) {
            if (truncate) {
              finish(null, result(request));
            } else {
              finish(new FetchError("too-large"));
            }
            request.cancel(Cr.NS_BINDING_ABORTED);
          }
        },
        onStopRequest(request, status) {
          if (job.timedOut) {
            finish(new FetchError("timeout"));
          } else if (!Components.isSuccessCode(status)) {
            finish(new FetchError("network-" + status.toString(16)));
          } else {
            finish(null, result(request));
          }
        },
      });
      job.channel = channel;
    });
  },

  // -- Decoding -----------------------------------------------------------

  async _fromDataURL(dataURL, touch = false) {
    let bytes = dataURLBytes(dataURL);
    return bytes ? this._encode(bytes, touch) : null;
  },

  /** A checked icon re-encoded as a PNG data: URL: { src, touch }, or null. */
  async _encode(bytes, touch) {
    let checked = checkIcon(bytes);
    if (!checked) {
      return null;
    }
    try {
      let png = checked.type == "image/svg+xml" ? await this._rasterizeSVG(bytes) : this._reencode(bytes, checked);
      return png ? { src: "data:image/png;base64," + bytesToBase64(png), touch: !!touch } : null;
    } catch (e) {
      return null;
    }
  },

  // PNG and ICO: imgITools (nsPNGDecoder; nsICODecoder with nsBMPDecoder or
  // nsPNGDecoder inside), then nsPNGEncoder.
  _reencode(bytes, { type }) {
    let tools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    let copy = bytes.slice().buffer;
    let image = tools.decodeImageFromArrayBuffer(copy, type);
    let scale = Math.min(1, STORED_SIZE / Math.max(image.width, image.height));
    let width = Math.max(1, Math.round(image.width * scale));
    let height = Math.max(1, Math.round(image.height * scale));
    let stream = tools.encodeScaledImage(image, "image/png", width, height, "");
    let out = new Uint8Array(lazy.NetUtil.readInputStream(stream, stream.available()));
    stream.close();
    return out;
  },

  // SVG: loaded as an image (scripts don't run, nothing external loads) in
  // a windowless document, drawn on a canvas, encoded as PNG.
  async _rasterizeSVG(bytes) {
    let browser = Services.appShell.createWindowlessBrowser(true, 0);
    try {
      let doc = browser.document;
      let img = doc.createElementNS("http://www.w3.org/1999/xhtml", "img");
      img.src = "data:image/svg+xml;base64," + bytesToBase64(bytes);
      await Promise.race([
        img.decode(),
        new Promise((resolve, reject) => lazy.setTimeout(() => reject(new FetchError("svg-timeout")), 3000)),
      ]);
      let canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
      canvas.width = canvas.height = STORED_SIZE;
      let ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
      let width = ratio >= 1 ? STORED_SIZE : STORED_SIZE * ratio;
      let height = ratio >= 1 ? STORED_SIZE / ratio : STORED_SIZE;
      canvas.getContext("2d").drawImage(img, (STORED_SIZE - width) / 2, (STORED_SIZE - height) / 2, width, height);
      return dataURLBytes(canvas.toDataURL("image/png"));
    } finally {
      browser.close();
    }
  },
};
