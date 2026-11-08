/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Google's Widevine component, which plays DRM-controlled video and music.
 *
 * It isn't bundled. The first time a page asks for it (EncryptedMedia
 * actors) while "Play DRM-controlled content" is on, install() downloads it
 * from Google: the release toolkit lists in gmp-sources/widevinecdm.json,
 * which names Google's address and the file's SHA-512. Firefox asks
 * Mozilla's update server first; this browser doesn't (Gecko's updater
 * stays off). The download carries no cookies and no Referer, and the file
 * is installed only if its hash matches.
 *
 * It's installed as Firefox installs it: toolkit's GMPExtractor unpacks it
 * into the profile (gmp-widevinecdm/<version>), the media.gmp-widevinecdm.*
 * prefs record it, and Gecko's media plugin service is told where it is (at
 * every startup too, as Firefox's add-on manager does). The waiting page
 * then gets it ("gmp-changed").
 *
 * Updates: when a newer browser names a newer Widevine than the installed
 * one, and DRM is on, the new one is downloaded a little after startup and
 * replaces the old. Streaming services stop accepting old versions. A
 * profile that never needed Widevine downloads nothing.
 */

import { GMPExtractor } from "resource://gre/modules/GMPInstallManager.sys.mjs";
import { GMPPrefs, GMPUtils, WIDEVINE_L3_ID } from "resource://gre/modules/GMPUtils.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  UpdateUtils: "resource://gre/modules/UpdateUtils.sys.mjs",
});
ChromeUtils.defineLazyGetter(lazy, "gmpService", () =>
  Cc["@mozilla.org/gecko-media-plugin-service;1"].getService(Ci.mozIGeckoMediaPluginChromeService)
);

const SOURCES = "chrome://global/content/gmp-sources/widevinecdm.json";
// Under automation only (BWV_AUTOMATION=1 and Marionette running): another
// sources file, for a stand-in download.
const TEST_SOURCES_PREF = "browserwip.drm.testSources";
const TEST_ENV = "BWV_AUTOMATION";
// A download that receives nothing for this long has stalled; Gecko gives a
// waiting page a minute, and a slow but moving download plays on the page's
// next try.
const STALL_MS = 30 * 1000;
const UNPACK_TIMEOUT_MS = 60 * 1000;
// Progress for the notices (drm.js): { stage: "downloading", received,
// total } or { stage: "unpacking" }; and the end, "installed" or "failed".
export const PROGRESS_TOPIC = "browserwip-widevine-progress";
export const DONE_TOPIC = "browserwip-widevine-done";
// An update waits until startup is well over.
const UPDATE_DELAY_MS = 2 * 60 * 1000;
const MAX_BYTES = 100 * 1024 * 1024;

function log(message) {
  console.info(`browser-wip: Widevine: ${message}`);
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => (timer = lazy.setTimeout(() => reject(new Error(message)), ms))),
  ]).finally(() => lazy.clearTimeout(timer));
}

export const Widevine = {
  ID: WIDEVINE_L3_ID,
  PROGRESS_TOPIC,
  DONE_TOPIC,
  _installing: null,

  /** At startup: an installed Widevine is made available to pages. */
  init() {
    let path = this.installedPath;
    if (path) {
      this._register(path).catch(e => console.warn("browser-wip: Widevine not available", e));
      lazy.setTimeout(() => this.update().catch(e => console.warn("browser-wip: updating Widevine failed", e)), UPDATE_DELAY_MS);
    }
  },

  /**
   * Replaces the installed Widevine if this browser names a newer one and
   * DRM is on. Resolves to whether it did.
   */
  async update() {
    let installed = this.installedVersion;
    if (!installed || !this.enabled || this._installing) {
      return false;
    }
    let release = await this._release();
    if (Services.vc.compare(release.version, installed) <= 0) {
      return false;
    }
    await this.install();
    let old = PathUtils.join(PathUtils.profileDir, this.ID, installed);
    try {
      lazy.gmpService.removePluginDirectory(old);
    } catch (e) {}
    await IOUtils.remove(old, { recursive: true, ignoreAbsent: true });
    return true;
  },

  /** Whether "Play DRM-controlled content" is on. */
  get enabled() {
    return (
      Services.prefs.getBoolPref("media.eme.enabled", false) &&
      Services.prefs.getBoolPref("media.gmp-widevinecdm.enabled", false)
    );
  },

  get installedVersion() {
    return GMPPrefs.getString(GMPPrefs.KEY_PLUGIN_VERSION, "", this.ID);
  },

  // The installed copy's folder, if one is installed for this platform.
  get installedPath() {
    let version = this.installedVersion;
    if (!version || GMPPrefs.getString(GMPPrefs.KEY_PLUGIN_ABI, "", this.ID) != GMPUtils._expectedABI({ id: this.ID })) {
      return null;
    }
    return PathUtils.join(PathUtils.profileDir, this.ID, version);
  },

  get installing() {
    return !!this._installing;
  },

  async _register(path) {
    if (await IOUtils.exists(path)) {
      lazy.gmpService.addPluginDirectory(path);
      return true;
    }
    return false;
  },

  /**
   * Downloads and installs Widevine, once however many pages ask. Resolves
   * when pages can use it; rejects if it couldn't be installed.
   */
  install() {
    if (!this.enabled) {
      return Promise.reject(new Error("DRM is off"));
    }
    this._installing ??= this._install().then(
      path => {
        this._installing = null;
        log(`installed, in ${path}`);
        Services.obs.notifyObservers(null, DONE_TOPIC, "installed");
        return path;
      },
      error => {
        this._installing = null;
        console.warn("browser-wip: Widevine: installing failed:", error);
        Services.obs.notifyObservers(null, DONE_TOPIC, "failed");
        throw error;
      }
    );
    return this._installing;
  },

  /** The latest progress of the install under way, or null. */
  progress: null,

  _progress(progress) {
    this.progress = progress;
    Services.obs.notifyObservers(null, PROGRESS_TOPIC, JSON.stringify(progress));
  },

  async _install() {
    this.progress = null;
    let release = await this._release();
    log(`release ${release.version}`);
    let path = PathUtils.join(PathUtils.profileDir, this.ID, release.version);
    if (this.installedVersion == release.version && (await this._register(path))) {
      return path;
    }
    let file = await this._download(release);
    this._progress({ stage: "unpacking" });
    log("unpacking");
    try {
      await withTimeout(new GMPExtractor(file, [this.ID, release.version]).install(), UNPACK_TIMEOUT_MS, "unpacking timed out");
    } finally {
      Services.obs.notifyObservers(null, "flush-cache-entry", file);
      await IOUtils.remove(file, { ignoreAbsent: true });
    }
    // Recorded as Firefox records it; the version last, as it marks the
    // install complete.
    GMPPrefs.setString(GMPPrefs.KEY_PLUGIN_ABI, GMPUtils._expectedABI({ id: this.ID }), this.ID);
    GMPPrefs.setString(GMPPrefs.KEY_PLUGIN_HASHVALUE, release.hashValue, this.ID);
    GMPPrefs.setString(GMPPrefs.KEY_PLUGIN_VERSION, release.version, this.ID);
    if (!(await this._register(path))) {
      throw new Error("Widevine wasn't unpacked");
    }
    return path;
  },

  // This platform's release in the sources file: { version, urls,
  // hashFunction, hashValue, size }.
  async _release() {
    let response = await withTimeout(fetch(this._testSources() || SOURCES), 10 * 1000, "reading the sources timed out");
    let sources = await response.json();
    let vendor = sources.vendors[this.ID];
    let target = Services.appinfo.OS + "_" + lazy.UpdateUtils.ABI;
    let details = vendor.platforms[target];
    while (details?.alias) {
      details = vendor.platforms[details.alias];
    }
    if (!details?.fileUrl || !details.hashValue) {
      throw new Error(`Widevine isn't available for ${target}`);
    }
    return {
      version: vendor.version,
      urls: [details.fileUrl, ...(details.mirrorUrls ?? [])],
      hashFunction: sources.hashFunction,
      hashValue: details.hashValue,
      size: details.filesize,
    };
  },

  // Into a temporary file, from the first address that gives the right
  // file. Anonymous: no cookies, no Referer, nothing cached.
  async _download(release) {
    let lastError;
    for (let url of release.urls) {
      let controller = new AbortController();
      let stalled = () => controller.abort(new Error(`nothing received for ${STALL_MS / 1000} s`));
      let timer = lazy.setTimeout(stalled, STALL_MS);
      try {
        if (!url.startsWith("https://") && !this._testSources()) {
          throw new Error("not https");
        }
        log(`downloading ${url}`);
        this._progress({ stage: "downloading", received: 0, total: release.size ?? 0 });
        let response = await fetch(url, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        let chunks = [];
        let received = 0;
        let reader = response.body.getReader();
        for (;;) {
          let { done, value } = await reader.read();
          if (done) {
            break;
          }
          chunks.push(value);
          received += value.length;
          if (received > MAX_BYTES) {
            throw new Error("too large");
          }
          lazy.clearTimeout(timer);
          timer = lazy.setTimeout(stalled, STALL_MS);
          this._progress({ stage: "downloading", received, total: release.size ?? 0 });
        }
        if (release.size && received != release.size) {
          throw new Error(`unexpected size ${received}`);
        }
        let bytes = new Uint8Array(received);
        let offset = 0;
        for (let chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        let file = await IOUtils.createUniqueFile(PathUtils.tempDir, "widevine.crx");
        await IOUtils.write(file, bytes);
        let digest = await IOUtils.computeHexDigest(file, release.hashFunction);
        if (digest.toLowerCase() != release.hashValue.toLowerCase()) {
          await IOUtils.remove(file);
          throw new Error("hash mismatch");
        }
        log(`downloaded ${received} bytes, hash verified`);
        return file;
      } catch (e) {
        lastError = controller.signal.aborted ? controller.signal.reason : e;
        console.warn(`browser-wip: Widevine: downloading ${url} failed:`, lastError);
      } finally {
        lazy.clearTimeout(timer);
      }
    }
    throw lastError ?? new Error("no download address");
  },

  _testSources() {
    if (Services.env.get(TEST_ENV) != "1") {
      return "";
    }
    try {
      if (!Cc["@mozilla.org/remote/marionette;1"].getService(Ci.nsIMarionette).running) {
        return "";
      }
    } catch (e) {
      return "";
    }
    return Services.prefs.getStringPref(TEST_SOURCES_PREF, "");
  },
};
