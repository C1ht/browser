/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Page translation, on this device, with Firefox's translation engine
 * (toolkit/components/translations: Bergamot, run in the inference process).
 * The browser window's part is translations.js.
 *
 * The engine gets its files from Remote Settings, which this browser turns
 * off by policy. Instead it gets them from here: the list of files is a
 * snapshot in the build (models.json, tools/update-translation-models.py),
 * and each file is downloaded from Mozilla's attachment server only when a
 * translation needs it, anonymously (no cookies, no Referer), checked
 * against the snapshot's size and SHA-256, and kept in the profile
 * ("translations" folder) for next time. The engine's own code is unchanged;
 * this hands it the two sources through TranslationsParent.applyTestingMocks,
 * the one way it takes other sources without changing mozilla-central.
 *
 * What gets translated never leaves the device. Mozilla's server sees only
 * which language files are downloaded, once each.
 *
 * Off (browser.translations.enable false, a switch in setup and Settings),
 * nothing of it runs: toolkit registers its actors only while the pref is
 * on, and this module installs nothing.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  TranslationsParent: "resource://gre/actors/TranslationsParent.sys.mjs",
});

export const ENABLED_PREF = "browser.translations.enable";
// Notified while files download, with { received, total } in bytes as JSON
// (both 0 when nothing is downloading).
export const PROGRESS_TOPIC = "browserwip:translations-progress";
// Notified when the downloaded files change (downloaded or deleted).
export const FILES_TOPIC = "browserwip:translations-files";

const LIST_URL = "resource://gre/defaults/translations/models.json";
const FOLDER = "translations";
// Under automation only (BWV_AUTOMATION=1 and Marionette running): where
// the files are downloaded from instead of Mozilla's server.
const TEST_FILES_PREF = "browserwip.translations.testFilesURL";
const TEST_ENV = "BWV_AUTOMATION";
// A download that receives nothing for this long fails.
const STALL_MS = 30 * 1000;
const PIVOT = "en";

function log(...args) {
  console.info("browser-wip: translations:", ...args);
}

/**
 * Stands in for a RemoteSettingsClient: what TranslationsParent calls on
 * one (get, attachments, on/off, sync).
 */
class FileSource {
  constructor(kind) {
    this.kind = kind;
    this.attachments = {
      download: record => PageTranslations._file(record),
      isDownloaded: record => PageTranslations._isDownloaded(record),
      deleteDownloaded: record => PageTranslations._delete(record),
    };
  }

  async get({ filters = {} } = {}) {
    let records = (await PageTranslations._list())[this.kind];
    return records.filter(r => Object.entries(filters).every(([key, value]) => r[key] === value));
  }

  // The snapshot only changes with the browser: no syncs, no sync events.
  async sync() {}
  on() {}
  off() {}
}

export const PageTranslations = {
  ENABLED_PREF,
  PROGRESS_TOPIC,
  FILES_TOPIC,

  _installed: false,
  _listPromise: null,
  // Downloads in progress: hash -> { promise, received, total }.
  _downloads: new Map(),
  // The downloads since the last time none were in progress, finished ones
  // included, for the progress shown: one total for a translation's files.
  _batch: new Set(),

  init() {
    Services.prefs.addObserver(ENABLED_PREF, () => this._install());
    this._install();
  },

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, false);
  },

  // Before the engine first looks for files: at startup, or when the pref
  // turns on. Toolkit's actors start only while the pref is on.
  _install() {
    if (this._installed || !this.enabled) {
      return;
    }
    this._installed = true;
    lazy.TranslationsParent.applyTestingMocks({
      useMockedTranslator: false,
      translationModelsRemoteClient: new FileSource("models"),
      translationsWasmRemoteClient: new FileSource("wasm"),
    });
  },

  _list() {
    this._listPromise ??= fetch(LIST_URL)
      .then(response => response.json())
      .catch(e => {
        this._listPromise = null;
        throw e;
      });
    return this._listPromise;
  },

  get _folder() {
    return PathUtils.join(PathUtils.profileDir, FOLDER);
  },

  _path(record) {
    // The hash names the file: a new version is a new file.
    return PathUtils.join(this._folder, record.attachment.hash);
  },

  _isDownloaded(record) {
    return IOUtils.exists(this._path(record));
  },

  async _delete(record) {
    await IOUtils.remove(this._path(record), { ignoreAbsent: true });
    Services.obs.notifyObservers(null, FILES_TOPIC);
  },

  /**
   * A file's contents, as the engine asks for them ({ buffer }): from the
   * profile, or downloaded first. Rejects when it can't be had, or doesn't
   * match the snapshot.
   */
  async _file(record) {
    let path = this._path(record);
    if (await IOUtils.exists(path)) {
      if (await this._matches(path, record)) {
        return { buffer: (await IOUtils.read(path)).buffer, record };
      }
      // Changed on disk since it was checked: download it again.
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
    let hash = record.attachment.hash;
    let download = this._downloads.get(hash);
    if (!download) {
      download = { received: 0, total: record.attachment.size };
      download.promise = this._download(record, download).finally(() => {
        this._downloads.delete(hash);
        if (!this._downloads.size) {
          this._batch.clear();
        }
        this._progress();
      });
      this._downloads.set(hash, download);
      this._batch.add(download);
    }
    // A copy each: the engine may hand the buffer on (transfer it).
    return { buffer: (await download.promise).slice().buffer, record };
  },

  async _matches(path, record) {
    let { size } = await IOUtils.stat(path);
    return size == record.attachment.size && (await IOUtils.computeHexDigest(path, "sha256")) == record.attachment.hash;
  },

  async _download(record, download) {
    let base = this._testFilesURL() || (await this._list()).attachmentsURL;
    let url = base + record.attachment.location;
    let controller = new AbortController();
    let stalled = () => controller.abort(new Error(`nothing received for ${STALL_MS / 1000} s`));
    let timer = lazy.setTimeout(stalled, STALL_MS);
    let part = this._path(record) + ".part";
    try {
      log(`downloading ${record.name} ${record.version}`);
      let response = await fetch(url, {
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      let bytes = new Uint8Array(record.attachment.size);
      let reader = response.body.getReader();
      for (;;) {
        let { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (download.received + value.length > bytes.length) {
          throw new Error("larger than listed");
        }
        bytes.set(value, download.received);
        download.received += value.length;
        lazy.clearTimeout(timer);
        timer = lazy.setTimeout(stalled, STALL_MS);
        this._progress();
      }
      if (download.received != bytes.length) {
        throw new Error(`${download.received} of ${bytes.length} bytes`);
      }
      await IOUtils.makeDirectory(this._folder);
      await IOUtils.write(part, bytes);
      if ((await IOUtils.computeHexDigest(part, "sha256")) != record.attachment.hash) {
        throw new Error("hash mismatch");
      }
      await IOUtils.move(part, this._path(record));
      log(`downloaded ${record.name}, hash verified`);
      Services.obs.notifyObservers(null, FILES_TOPIC);
      return bytes;
    } catch (e) {
      let error = controller.signal.aborted ? controller.signal.reason : e;
      console.warn(`browser-wip: translations: downloading ${record.name} failed:`, error);
      await IOUtils.remove(part, { ignoreAbsent: true });
      throw error;
    } finally {
      lazy.clearTimeout(timer);
    }
  },

  _progress() {
    Services.obs.notifyObservers(null, PROGRESS_TOPIC, JSON.stringify(this.progress));
  },

  /** What's downloading now: { received, total } bytes, both 0 for nothing. */
  get progress() {
    let received = 0;
    let total = 0;
    for (let download of this._batch) {
      received += download.received;
      total += download.total;
    }
    return { received, total };
  },

  /**
   * The files translating from one language to another takes (through
   * English when neither is English), with the engine:
   * { total, missing } bytes, missing being what isn't downloaded yet.
   */
  async pairSize(sourceLanguage, targetLanguage) {
    let list = await this._list();
    let pairs =
      sourceLanguage == PIVOT || targetLanguage == PIVOT
        ? [[sourceLanguage, targetLanguage]]
        : [
            [sourceLanguage, PIVOT],
            [PIVOT, targetLanguage],
          ];
    let records = [
      ...list.wasm,
      ...list.models.filter(r => pairs.some(([s, t]) => r.sourceLanguage == s && r.targetLanguage == t)),
    ];
    let total = 0;
    let missing = 0;
    for (let record of records) {
      total += record.attachment.size;
      if (!(await this._isDownloaded(record))) {
        missing += record.attachment.size;
      }
    }
    return { total, missing };
  },

  /** How much the downloaded files take, in bytes. */
  async downloadedSize() {
    let size = 0;
    try {
      for (let path of await IOUtils.getChildren(this._folder)) {
        size += (await IOUtils.stat(path)).size;
      }
    } catch (e) {
      // No folder: nothing downloaded.
    }
    return size;
  },

  /** Deletes every downloaded file; they download again when needed. */
  async deleteAll() {
    await IOUtils.remove(this._folder, { recursive: true, ignoreAbsent: true });
    Services.obs.notifyObservers(null, FILES_TOPIC);
  },

  _testFilesURL() {
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
    return Services.prefs.getStringPref(TEST_FILES_PREF, "");
  },
};
