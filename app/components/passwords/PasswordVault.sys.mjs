/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The password manager in the browser process (docs/PASSWORDS.md §3, §5).
 *
 * State: "unknown" until init(), then "none" (no vault yet), "locked" or
 * "unlocked". While unlocked this holds the decrypted index: sites,
 * usernames and times, never passwords. Passwords stay sealed in
 * nsIPasswordVault and come out one at a time, to fill, reveal or copy.
 *
 * Every change is announced with the observer topic
 * "browserwip:passwords-state" (data: the new state) or
 * "browserwip:passwords-changed" (the entries or the never list).
 *
 * Errors thrown to callers carry a `code`: "wrong-password",
 * "too-short", "mismatch", "locked", "no-vault", "needs-master-password",
 * "not-fillable", "needs-passphrase", "wrong-passphrase", "bad-file",
 * "no-columns", or the core's status name ("BWV_E_IO", ...).
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  displayHost,
  emptyIndex,
  findLogin,
  isFillableOrigin,
  matchEntries,
  newEntryId,
  normalizeOrigin,
  parseIndex,
  siteOf,
} from "resource://gre/modules/browserwip/PasswordRules.sys.mjs";
import {
  isVaultFile,
  loginsFromCSV,
  planImport,
  toCSV,
} from "resource://gre/modules/browserwip/PasswordTransfer.sys.mjs";

const lazy = {};
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "core",
  "@browser-wip/password-vault;1",
  Ci.nsIPasswordVault
);
XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "idleService",
  "@mozilla.org/widget/useridleservice;1",
  Ci.nsIUserIdleService
);
ChromeUtils.defineESModuleGetters(lazy, {
  CSV: "resource://gre/modules/CSV.sys.mjs",
  PasswordGenerator: "resource://gre/modules/shared/PasswordGenerator.sys.mjs",
  PrivacyModes: "resource://gre/modules/browserwip/PrivacyModes.sys.mjs",
});

export const LOCK_PREF = "browserwip.passwords.lockAfterMinutes";
export const OFFER_PREF = "browserwip.passwords.offerToSave";
XPCOMUtils.defineLazyPreferenceGetter(lazy, "offerToSave", OFFER_PREF, true);

export const STATE_TOPIC = "browserwip:passwords-state";
export const CHANGED_TOPIC = "browserwip:passwords-changed";

// §5.5, §17 Q11.
export const MIN_MASTER_LENGTH = 12;
// After this many wrong master passwords in a row, each try waits.
const FREE_TRIES = 5;
const TRY_DELAY_MS = 3000;
// §17 Q1(b): after typing the master password, revealing and copying
// don't ask again for 5 minutes.
const REVEAL_GRACE_MS = 5 * 60 * 1000;
// §8: a copied password is cleared after 30 s if it's still there.
const CLIPBOARD_CLEAR_MS = 30 * 1000;
// §7.4.
const GENERATED_LENGTH = 20;

function failure(code, cause) {
  let error = new Error(code);
  error.code = code;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

// The core rejects with an OperationError whose message is its status name
// (bwv_status_name: "auth", "not-found", ...). Callers get "BWV_E_AUTH",
// "BWV_E_NOT_FOUND", ...
const CORE_STATUS = new Set([
  "format", "newer", "older", "params", "auth", "no-slot", "not-found", "locked", "state", "arg",
  "nomem", "init", "io", "in-use", "busy", "provider", "cancelled", "verify", "cleanup",
]);

function coreCode(e) {
  let name = e?.message;
  return CORE_STATUS.has(name) ? "BWV_E_" + name.toUpperCase().replace("-", "_") : "BWV_E_STATE";
}

function getBaseDomain(host) {
  return Services.eTLD.getBaseDomainFromHost(host);
}

async function digest(salt, text) {
  let data = new TextEncoder().encode(salt + "\0" + text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data)).join(",");
}

export const PasswordVault = {
  state: "unknown",
  // Set while unlocked.
  _index: null,
  _opening: null,
  _failures: 0,
  _revealUntil: 0,
  _clipboard: null,
  _idleArmed: 0,

  get offerToSave() {
    return lazy.offerToSave;
  },

  /** Opens the vault directory; resolves with the state. Safe to call often. */
  init() {
    this._opening ??= (async () => {
      let dir = PathUtils.join(PathUtils.profileDir, "passwords");
      let info = JSON.parse(await lazy.core.open(dir));
      Services.obs.addObserver(this, "sleep_notification");
      Services.obs.addObserver(this, "quit-application-granted");
      Services.prefs.addObserver(LOCK_PREF, this);
      this._setState(info.exists ? "locked" : "none");
      return this.state;
    })().catch(e => {
      this._opening = null;
      console.error("browser-wip: password vault unavailable", coreCode(e));
      throw failure(coreCode(e), e);
    });
    return this._opening;
  },

  _setState(state) {
    if (this.state == state) {
      return;
    }
    this.state = state;
    if (state == "unlocked") {
      this._armIdle();
    } else {
      this._disarmIdle();
    }
    Services.obs.notifyObservers(null, STATE_TOPIC, state);
  },

  _changed() {
    Services.obs.notifyObservers(null, CHANGED_TOPIC);
  },

  _checkNewMaster(password, confirmation) {
    if ([...password].length < MIN_MASTER_LENGTH) {
      throw failure("too-short");
    }
    if (confirmation !== undefined && confirmation !== password) {
      throw failure("mismatch");
    }
  },

  /** Creates the vault under a new master password and unlocks it. */
  async setup(password, confirmation) {
    await this.init();
    if (this.state != "none") {
      throw failure("BWV_E_STATE");
    }
    this._checkNewMaster(password, confirmation);
    let index = emptyIndex();
    try {
      await lazy.core.create(password.normalize("NFC"), JSON.stringify(index));
    } catch (e) {
      throw failure(coreCode(e), e);
    }
    this._index = index;
    this._failures = 0;
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
    this._setState("unlocked");
  },

  async unlock(password) {
    await this.init();
    if (this.state == "none") {
      throw failure("no-vault");
    }
    if (this.state == "unlocked") {
      return;
    }
    if (this._failures >= FREE_TRIES) {
      await new Promise(resolve => lazy.setTimeout(resolve, TRY_DELAY_MS));
    }
    let json;
    try {
      json = await lazy.core.unlock(password.normalize("NFC"));
    } catch (e) {
      if (coreCode(e) == "BWV_E_AUTH") {
        this._failures++;
        throw failure("wrong-password");
      }
      throw failure(coreCode(e), e);
    }
    this._index = parseIndex(json);
    this._failures = 0;
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
    this._setState("unlocked");
  },

  async lock() {
    if (this.state != "unlocked") {
      return;
    }
    this._index = null;
    this._revealUntil = 0;
    this._setState("locked");
    this._clearClipboardNow();
    await lazy.core.lock().catch(() => {});
  },

  /** Whether the master password was typed in the last 5 minutes. */
  get recentlyAuthenticated() {
    return Date.now() < this._revealUntil;
  },

  /** Checks the master password again (reveal, copy, export). */
  async confirmMaster(password) {
    this._requireUnlocked();
    let ok;
    try {
      ok = await lazy.core.checkPassword(password.normalize("NFC"));
    } catch (e) {
      throw failure(coreCode(e), e);
    }
    if (!ok) {
      throw failure("wrong-password");
    }
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
  },

  async changeMasterPassword(current, fresh, confirmation) {
    this._requireUnlocked();
    this._checkNewMaster(fresh, confirmation);
    try {
      await lazy.core.changePassword(current.normalize("NFC"), fresh.normalize("NFC"));
    } catch (e) {
      throw failure(coreCode(e) == "BWV_E_AUTH" ? "wrong-password" : coreCode(e), e);
    }
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
  },

  _requireUnlocked() {
    if (this.state != "unlocked") {
      throw failure(this.state == "none" ? "no-vault" : "locked");
    }
  },

  // ---------------------------------------------------------------------
  // Entries

  /** Copies of all entries, by host then username. */
  entries() {
    if (this.state != "unlocked") {
      return [];
    }
    return this._index.entries
      .map(e => ({ ...e, also: [...e.also] }))
      .sort((a, b) => displayHost(a.origin).localeCompare(displayHost(b.origin)) || a.username.localeCompare(b.username));
  },

  getEntry(id) {
    let entry = this._index?.entries.find(e => e.id == id);
    return entry ? { ...entry, also: [...entry.also] } : null;
  },

  /**
   * The logins that may be offered on frameOrigin: { exact, sameSite }.
   * Other origins of the same site only in Standard (§17 Q5).
   */
  match(frameOrigin) {
    if (this.state != "unlocked") {
      return { exact: [], sameSite: [] };
    }
    let allowSameSite = lazy.PrivacyModes.mode == "standard";
    return matchEntries(this._index.entries, frameOrigin, { getBaseDomain, allowSameSite });
  },

  /** The entry saved for origin with username, if any. */
  find(origin, username) {
    return this._index ? findLogin(this._index.entries, origin, username) : null;
  },

  hasLoginsFor(frameOrigin) {
    return this.match(frameOrigin).exact.length > 0;
  },

  siteName(origin) {
    return siteOf(origin, getBaseDomain) ?? displayHost(origin);
  },

  async _save() {
    try {
      await lazy.core.save(JSON.stringify(this._index));
    } catch (e) {
      throw failure(coreCode(e), e);
    } finally {
      this._changed();
    }
  },

  /**
   * The username and password of an entry, for filling a frame whose
   * origin the caller took from the frame's principal. The entry must be
   * offered on that origin (saved for it, or listing it under "also").
   */
  async credentialsFor(id, frameOrigin) {
    this._requireUnlocked();
    let entry = this._index.entries.find(e => e.id == id);
    if (!entry || !isFillableOrigin(frameOrigin) ||
        (entry.origin != frameOrigin && !entry.also.includes(frameOrigin))) {
      throw failure("not-fillable");
    }
    // Sealed to the entry's own origin; on the frame's own origin when
    // that is the one (the usual case), so a matching bug can't decrypt
    // another site's password.
    let password = await lazy.core.getSecret(id, entry.origin == frameOrigin ? frameOrigin : entry.origin);
    entry.used = Date.now();
    this._save().catch(() => {});
    return { username: entry.username, password };
  },

  /** Whether the entry's saved password is `password` (an unchanged login isn't offered for saving). */
  async hasPassword(id, password) {
    this._requireUnlocked();
    let entry = this._index.entries.find(e => e.id == id);
    if (!entry) {
      return false;
    }
    try {
      return (await lazy.core.getSecret(id, entry.origin)) === password;
    } catch (e) {
      return false;
    }
  },

  /** "Also use here": entry id fills on origin from now on. */
  async addAlso(id, origin) {
    this._requireUnlocked();
    let entry = this._index.entries.find(e => e.id == id);
    origin = normalizeOrigin(origin);
    if (!entry || !origin) {
      throw failure("BWV_E_ARG");
    }
    if (origin != entry.origin && !entry.also.includes(origin)) {
      entry.also.push(origin);
      entry.changed = Date.now();
      await this._save();
    }
  },

  /**
   * Saves a login, as a new entry or by updating the entry with the same
   * origin and username. The password comes from a capture (captureId) or
   * is given (password). Resolves with the entry id.
   */
  async saveLogin({ origin, username, password, captureId, also = [] }) {
    this._requireUnlocked();
    let normal = normalizeOrigin(origin);
    if (!normal) {
      throw failure("BWV_E_ARG");
    }
    let now = Date.now();
    let entry = findLogin(this._index.entries, normal, username);
    let isNew = !entry;
    if (isNew) {
      entry = {
        id: newEntryId(bytes => crypto.getRandomValues(bytes)),
        origin: normal,
        also: [],
        realm: null,
        username,
        created: now,
        changed: now,
        used: 0,
      };
      this._index.entries.push(entry);
    } else {
      entry.changed = now;
    }
    for (let o of also.map(normalizeOrigin).filter(Boolean)) {
      if (o != normal && !entry.also.includes(o)) {
        entry.also.push(o);
      }
    }
    try {
      if (captureId) {
        await lazy.core.storeCapture(captureId, entry.id, normal);
      } else {
        await lazy.core.setSecret(entry.id, normal, password ?? "");
      }
    } catch (e) {
      if (isNew) {
        this._index.entries = this._index.entries.filter(x => x !== entry);
      }
      throw failure(coreCode(e), e);
    }
    this._unnever(normal);
    await this._save();
    return entry.id;
  },

  /**
   * Edits an entry: { origin, username, password, also }. Moving it to
   * another origin seals its password again for that origin.
   */
  async updateEntry(id, changes) {
    this._requireUnlocked();
    let entry = this._index.entries.find(e => e.id == id);
    if (!entry) {
      throw failure("BWV_E_NOT_FOUND");
    }
    try {
      if (changes.origin !== undefined) {
        let origin = normalizeOrigin(changes.origin);
        if (!origin) {
          throw failure("BWV_E_ARG");
        }
        if (origin != entry.origin) {
          await lazy.core.moveSecret(id, entry.origin, origin);
          entry.origin = origin;
        }
      }
      if (changes.password !== undefined) {
        await lazy.core.setSecret(id, entry.origin, changes.password);
      }
    } catch (e) {
      throw e.code ? e : failure(coreCode(e), e);
    }
    if (changes.username !== undefined) {
      entry.username = changes.username;
    }
    if (changes.also !== undefined) {
      entry.also = [...new Set(changes.also.map(normalizeOrigin).filter(o => o && o != entry.origin))];
    }
    entry.changed = Date.now();
    await this._save();
  },

  async removeEntry(id) {
    this._requireUnlocked();
    if (!this._index.entries.some(e => e.id == id)) {
      return;
    }
    try {
      await lazy.core.removeSecret(id);
    } catch (e) {
      throw failure(coreCode(e), e);
    }
    this._index.entries = this._index.entries.filter(e => e.id != id);
    await this._save();
  },

  /** The password, for showing in the manager: needs the master password (§17 Q1). */
  async revealPassword(id) {
    this._requireUnlocked();
    if (!this.recentlyAuthenticated) {
      throw failure("needs-master-password");
    }
    let entry = this._index.entries.find(e => e.id == id);
    if (!entry) {
      throw failure("BWV_E_NOT_FOUND");
    }
    try {
      return await lazy.core.getSecret(id, entry.origin);
    } catch (e) {
      throw failure(coreCode(e), e);
    }
  },

  /** Copies the password (gated like reveal) and clears it after 30 s. */
  async copyPassword(id) {
    let password = await this.revealPassword(id);
    await this._copySensitive(password);
  },

  async copyText(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(text);
  },

  async _copySensitive(text) {
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(text, null, Ci.nsIClipboardHelper.Sensitive);
    let salt = crypto.randomUUID();
    let hash = await digest(salt, text);
    lazy.clearTimeout(this._clipboard?.timer);
    this._clipboard = {
      salt,
      hash,
      timer: lazy.setTimeout(() => this._clearClipboardNow(), CLIPBOARD_CLEAR_MS),
    };
  },

  // Empties the clipboard if it still holds what we put there.
  async _clearClipboardNow() {
    let pending = this._clipboard;
    if (!pending) {
      return;
    }
    this._clipboard = null;
    lazy.clearTimeout(pending.timer);
    try {
      let trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
      trans.init(null);
      trans.addDataFlavor("text/plain");
      Services.clipboard.getData(trans, Services.clipboard.kGlobalClipboard, null);
      let data = {};
      trans.getTransferData("text/plain", data);
      let text = data.value?.QueryInterface(Ci.nsISupportsString).data ?? "";
      if (text && (await digest(pending.salt, text)) == pending.hash) {
        Services.clipboard.emptyClipboard(Services.clipboard.kGlobalClipboard);
      }
    } catch (e) {
      // Nothing readable on the clipboard: nothing of ours to clear.
    }
  },

  // ---------------------------------------------------------------------
  // Export and import (§9). Exporting needs the master password every
  // time (§8), whatever was typed in the last 5 minutes.

  /**
   * An encrypted copy of every login, as the bytes of a .bwv file: its own
   * vault key under `passphrase` (12 characters or more), and no keyring
   * or Windows Hello. Opens in this browser on any OS.
   */
  async exportEncrypted(master, passphrase, confirmation) {
    this._requireUnlocked();
    await this.confirmMaster(master);
    this._checkNewMaster(passphrase, confirmation);
    let entries = this._index.entries;
    let index = { v: 1, entries: entries.map(e => ({ ...e, also: [...e.also] })), never: [] };
    let file;
    try {
      file = await lazy.core.exportVault(
        passphrase.normalize("NFC"),
        JSON.stringify(index),
        entries.map(e => e.id),
        entries.map(e => e.origin)
      );
    } catch (e) {
      throw failure(coreCode(e), e);
    }
    return new Uint8Array(ChromeUtils.base64URLDecode(file, { padding: "ignore" }));
  },

  /** Every login in plain text (CSV: url, username, password, httpRealm). */
  async exportCSV(master) {
    this._requireUnlocked();
    await this.confirmMaster(master);
    let rows = [];
    for (let entry of this.entries()) {
      try {
        rows.push({ ...entry, password: await lazy.core.getSecret(entry.id, entry.origin) });
      } catch (e) {
        throw failure(coreCode(e), e);
      }
    }
    return toCSV(rows);
  },

  /**
   * Reads a file to import: a .bwv file (opened with `passphrase`, beside
   * the vault) or a CSV file. Resolves with { kind: "vault" | "csv",
   * logins, skipped }. Logins from a .bwv file carry no password: it is
   * copied inside nsIPasswordVault on import.
   */
  async readImport(bytes, passphrase) {
    this._requireUnlocked();
    if (isVaultFile(bytes)) {
      if (!passphrase) {
        throw failure("needs-passphrase");
      }
      let json;
      try {
        json = await lazy.core.openImport(
          ChromeUtils.base64URLEncode(bytes, { pad: false }),
          passphrase.normalize("NFC")
        );
      } catch (e) {
        throw failure(coreCode(e) == "BWV_E_AUTH" ? "wrong-passphrase" : coreCode(e), e);
      }
      let index;
      try {
        index = parseIndex(json);
      } catch (e) {
        throw failure("bad-file", e);
      }
      let logins = [];
      let skipped = 0;
      for (let e of index.entries) {
        let origin = normalizeOrigin(e.origin);
        if (!origin) {
          skipped++;
          continue;
        }
        logins.push({
          sourceId: e.id,
          sourceOrigin: e.origin,
          origin,
          username: e.username,
          also: e.also,
          realm: e.realm,
          created: e.created,
          changed: e.changed,
        });
      }
      return { kind: "vault", logins, skipped };
    }
    let rows;
    try {
      let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
      rows = lazy.CSV.parse(text, ",");
    } catch (e) {
      throw failure("bad-file", e);
    }
    let { logins, skipped } = loginsFromCSV(...rows);
    return { kind: "csv", logins, skipped };
  },

  /** What importing these logins would do: { fresh, duplicates, repeated, insecure }. */
  planImport(logins) {
    this._requireUnlocked();
    return planImport(this._index.entries, logins);
  },

  /**
   * Imports plan.fresh, and of plan.duplicates those in `replace` (their
   * saved password and times are replaced; the rest are left alone).
   * Resolves with how many logins were imported or replaced.
   */
  async applyImport(plan, replace = new Set()) {
    this._requireUnlocked();
    let now = Date.now();
    let copies = { src: [], srcOrigins: [], dst: [], dstOrigins: [] };
    let added = [];
    let changed = [];
    let take = async (login, entry) => {
      if (login.sourceId) {
        copies.src.push(login.sourceId);
        copies.srcOrigins.push(login.sourceOrigin);
        copies.dst.push(entry.id);
        copies.dstOrigins.push(entry.origin);
      } else {
        await lazy.core.setSecret(entry.id, entry.origin, login.password);
      }
    };
    try {
      for (let login of plan.fresh) {
        let entry = {
          id: newEntryId(bytes => crypto.getRandomValues(bytes)),
          origin: login.origin,
          also: [...new Set((login.also ?? []).map(normalizeOrigin).filter(o => o && o != login.origin))],
          realm: login.realm ?? null,
          username: login.username,
          created: login.created || now,
          changed: login.changed || login.created || now,
          used: 0,
        };
        await take(login, entry);
        added.push(entry);
      }
      for (let duplicate of plan.duplicates) {
        let entry = replace.has(duplicate) && this._index.entries.find(e => e.id == duplicate.existing.id);
        if (entry) {
          await take(duplicate.incoming, entry);
          changed.push(entry);
        }
      }
      if (copies.src.length) {
        await lazy.core.importSecrets(copies.src, copies.srcOrigins, copies.dst, copies.dstOrigins);
      }
    } catch (e) {
      for (let entry of added) {
        await lazy.core.removeSecret(entry.id).catch(() => {});
      }
      throw failure(e.code ?? coreCode(e), e);
    } finally {
      lazy.core.closeImport().catch(() => {});
    }
    this._index.entries.push(...added);
    for (let entry of changed) {
      entry.changed = now;
    }
    await this._save();
    return added.length + changed.length;
  },

  /** Forgets a .bwv file opened by readImport (the user cancelled). */
  cancelImport() {
    lazy.core.closeImport().catch(() => {});
  },

  // ---------------------------------------------------------------------
  // Never save for these sites

  isNever(origin) {
    return !!this._index?.never.includes(origin);
  },

  async addNever(origin) {
    this._requireUnlocked();
    if (!this._index.never.includes(origin)) {
      this._index.never.push(origin);
      await this._save();
    }
  },

  async removeNever(origin) {
    this._requireUnlocked();
    if (this._unnever(origin)) {
      await this._save();
    }
  },

  _unnever(origin) {
    let before = this._index.never.length;
    this._index.never = this._index.never.filter(o => o != origin);
    return this._index.never.length != before;
  },

  neverList() {
    return this._index ? [...this._index.never] : [];
  },

  // ---------------------------------------------------------------------
  // Logins waiting to be saved (§7.3)

  /** Seals a submitted password at once; resolves with its capture id. */
  async capture(password) {
    await this.init();
    try {
      return await lazy.core.sealCapture(password);
    } catch (e) {
      throw failure(coreCode(e), e);
    }
  },

  async openCapture(captureId) {
    try {
      return await lazy.core.openCapture(captureId);
    } catch (e) {
      throw failure(coreCode(e), e);
    }
  },

  dropCapture(captureId) {
    lazy.core.dropCapture(captureId).catch(() => {});
  },

  /** A strong password for a new-password field (§7.4). */
  generatePassword({ inputMaxLength } = {}) {
    return lazy.PasswordGenerator.generatePassword({ length: GENERATED_LENGTH, inputMaxLength });
  },

  // ---------------------------------------------------------------------
  // Locking (§5.4)

  get lockAfterMinutes() {
    return Services.prefs.getIntPref(LOCK_PREF, 15);
  },

  _armIdle() {
    this._disarmIdle();
    let minutes = this.lockAfterMinutes;
    if (minutes > 0) {
      this._idleArmed = minutes * 60;
      lazy.idleService.addIdleObserver(this, this._idleArmed);
    }
  },

  _disarmIdle() {
    if (this._idleArmed) {
      lazy.idleService.removeIdleObserver(this, this._idleArmed);
      this._idleArmed = 0;
    }
  },

  observe(subject, topic) {
    switch (topic) {
      case "idle":
      case "sleep_notification":
      case "quit-application-granted":
        this.lock();
        break;
      case "nsPref:changed":
        if (this.state == "unlocked") {
          this._armIdle();
        }
        break;
    }
  },

  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});
