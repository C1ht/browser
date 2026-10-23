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
 * "no-columns", "cancelled", "hello-unavailable", "hello-failed",
 * "wrong-recovery-key", "no-recovery-key", "not-confirmed", or the core's
 * status name ("BWV_E_IO", ...).
 *
 * Windows Hello (§5.3) is a second way to unlock, for filling. Showing and
 * copying ask again, with Hello or the master password; exporting, a new
 * recovery key and password changes take the master password only.
 */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  displayHost,
  emptyIndex,
  findLogin,
  isFillableOrigin,
  isWeakPassword,
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
import { suggestPassphrase } from "resource://gre/modules/browserwip/PasswordWords.sys.mjs";

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

  /** The vault's directory in the profile (§10). */
  get directory() {
    return PathUtils.join(PathUtils.profileDir, "passwords");
  },

  /** A 5-word passphrase from the EFF long list, to suggest at setup. */
  suggestPassphrase() {
    return suggestPassphrase();
  },

  /** Opens the vault directory; resolves with the state. Safe to call often. */
  init() {
    this._opening ??= (async () => {
      let info = JSON.parse(await lazy.core.open(this.directory));
      Services.obs.addObserver(this, "sleep_notification");
      Services.obs.addObserver(this, "quit-application-granted");
      Services.obs.addObserver(this, "browserwip:session-locked");
      Services.prefs.addObserver(LOCK_PREF, this);
      await this._refreshHello();
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
    this._generation++;
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
      // Bound to this computer, and its TPM didn't answer.
      throw failure(coreCode(e) == "BWV_E_PROVIDER" && this.device.bound ? "device-failed" : coreCode(e), e);
    }
    this._index = parseIndex(json);
    this._failures = 0;
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
    this._setState("unlocked");
  },

  // ---------------------------------------------------------------------
  // Windows Hello

  // { available: Hello can unlock on this machine, enrolled: the vault has
  // a Hello slot }
  hello: { available: false, enrolled: false },
  // Whether the vault has a recovery key (§6).
  hasRecoveryKey: false,
  // This computer only: { available: a TPM 2.0, bound: this vault is }.
  device: { available: false, bound: false },

  async _refreshHello() {
    let slots = { hello: false, recovery: false, device: false };
    try {
      slots = JSON.parse(await lazy.core.slots());
    } catch (e) {}
    this.hasRecoveryKey = slots.recovery;
    let deviceAvailable = false;
    try {
      deviceAvailable = await lazy.core.deviceBindingAvailable();
    } catch (e) {}
    this.device = { available: deviceAvailable, bound: !!slots.device };
    try {
      this.hello = {
        available: await lazy.core.helloAvailable(),
        enrolled: slots.hello,
      };
    } catch (e) {
      this.hello = { available: false, enrolled: false };
    }
  },

  /** Whether the unlock panel should offer Windows Hello. */
  get canUnlockWithHello() {
    return this.hello.available && this.hello.enrolled;
  },

  _helloFailure(e) {
    let code = coreCode(e);
    return failure(code == "BWV_E_CANCELLED" ? "cancelled" : code == "BWV_E_AUTH" ? "wrong-password" : "hello-failed", e);
  },

  /** Unlocks with Windows Hello: one prompt. Not a master password: no reveal grace. */
  async unlockWithHello() {
    await this.init();
    if (this.state == "unlocked") {
      return;
    }
    if (!this.canUnlockWithHello) {
      throw failure("hello-unavailable");
    }
    let json;
    try {
      json = await lazy.core.unlockWithHello();
    } catch (e) {
      if (coreCode(e) == "BWV_E_NO_SLOT") {
        await this._refreshHello();
      }
      // A slot that won't open (the PIN was reset, the key deleted): the
      // master password still works.
      throw failure(coreCode(e) == "BWV_E_CANCELLED" ? "cancelled" : "hello-failed", e);
    }
    this._index = parseIndex(json);
    this._failures = 0;
    this._setState("unlocked");
  },

  /** Adds Windows Hello; needs the master password (§5.1). Hello asks once or twice. */
  async enableHello(master) {
    await this._waitForReplacement();
    this._requireUnlocked();
    if (!this.hello.available) {
      throw failure("hello-unavailable");
    }
    try {
      await lazy.core.enableHello(master.normalize("NFC"));
    } catch (e) {
      await this._refreshHello();
      this._changed();
      throw this._helloFailure(e);
    }
    this.hello = { ...this.hello, enrolled: true };
    this._changed();
  },

  async disableHello() {
    await this._waitForReplacement();
    this._requireUnlocked();
    try {
      await lazy.core.disableHello();
    } catch (e) {
      throw failure(coreCode(e), e);
    } finally {
      await this._refreshHello();
      this._changed();
    }
  },

  // ---------------------------------------------------------------------
  // Forgotten master password (§6)

  /**
   * A new recovery key, replacing any old one; needs the master password.
   * Resolves with the key, to show once and never again.
   */
  async newRecoveryKey(master) {
    await this._waitForReplacement();
    this._requireUnlocked();
    let code;
    try {
      code = await lazy.core.newRecoveryKey(master.normalize("NFC"));
    } catch (e) {
      throw failure(coreCode(e) == "BWV_E_AUTH" ? "wrong-password" : coreCode(e), e);
    }
    this.hasRecoveryKey = true;
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
    this._changed();
    return code;
  },

  /**
   * Forgot password: the recovery key unlocks and sets `password` as the
   * new master password. The recovery key keeps working.
   */
  async recover(code, password, confirmation) {
    await this.init();
    if (this.state == "none") {
      throw failure("no-vault");
    }
    this._checkNewMaster(password, confirmation);
    if (this._failures >= FREE_TRIES) {
      await new Promise(resolve => lazy.setTimeout(resolve, TRY_DELAY_MS));
    }
    if (this.state == "unlocked") {
      // Unlocked through Hello: the recovery key still has to be typed.
      await this.lock();
    }
    let json;
    try {
      json = await lazy.core.unlockWithRecovery(code.trim(), password.normalize("NFC"));
    } catch (e) {
      let c = coreCode(e);
      if (c == "BWV_E_AUTH" || c == "BWV_E_ARG") {
        this._failures++;
        throw failure("wrong-recovery-key");
      }
      throw failure(c == "BWV_E_NO_SLOT" ? "no-recovery-key" : c, e);
    }
    // Recovering on a computer without the TPM key unbinds it.
    await this._refreshHello();
    this._index = parseIndex(json);
    this._failures = 0;
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
    this._setState("unlocked");
  },

  /**
   * Start over: the vault is kept as vault-forgotten-<date>.bwv and a new
   * one can be set up. `typed` must be "start over". Resolves with the
   * kept file's name.
   */
  async startOver(typed) {
    await this.init();
    if (this.state == "none") {
      throw failure("no-vault");
    }
    if (typed?.trim().toLowerCase() != "start over") {
      throw failure("not-confirmed");
    }
    await this.lock();
    let now = new Date();
    let date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map((n, i) => String(n).padStart(i ? 2 : 4, "0"))
      .join("-");
    let name;
    try {
      name = await lazy.core.startOver(date);
    } catch (e) {
      throw failure(coreCode(e), e);
    }
    this._failures = 0;
    await this._refreshHello();
    this._setState("none");
    return name;
  },

  /** The vaults kept by Start over, newest first (for "Open an older vault…"). */
  async olderVaults() {
    let names = [];
    try {
      for (let path of await IOUtils.getChildren(this.directory)) {
        let name = PathUtils.filename(path);
        if (/^vault-forgotten-[0-9-]+\.bwv$/.test(name) && !name.endsWith("-backup.bwv")) {
          names.push(name);
        }
      }
    } catch (e) {}
    return names.sort().reverse();
  },

  // ---------------------------------------------------------------------
  // Replace encryption key (§4.2)

  // While a replacement waits between prepare and commit, changes to the
  // vault wait too: the replacement was made from a copy, and committing it
  // would drop them.
  _replacing: null,

  async _waitForReplacement() {
    await this._replacing?.promise;
  },

  /** How many Windows Hello prompts a replacement causes (0 or 2). */
  get replacementHelloPrompts() {
    return this.hello.available && this.hello.enrolled ? 2 : 0;
  },

  /**
   * Builds the vault again under a new key, wrapped under `fresh` (the
   * same master password from Settings, a new one from a password change),
   * and checks it from disk. Resolves with the new recovery key to show
   * ("" when the vault has none); then replaceCommit() or replaceAbort().
   */
  async replacePrepare(current, fresh = current, confirmation = fresh) {
    this._requireUnlocked();
    if (fresh !== current) {
      this._checkNewMaster(fresh, confirmation);
    }
    await this._waitForReplacement();
    let done;
    this._replacing = { promise: new Promise(resolve => (done = resolve)), done };
    try {
      return await lazy.core.replacePrepare(current.normalize("NFC"), fresh.normalize("NFC"));
    } catch (e) {
      this._endReplacement();
      let code = coreCode(e);
      throw failure(
        code == "BWV_E_AUTH" ? "wrong-password" : code == "BWV_E_CANCELLED" ? "cancelled" : code,
        e
      );
    }
  },

  /** The new vault takes over. Resolves with "done" or "cleanup" (in use; tidied at the next start). */
  async replaceCommit() {
    try {
      return await lazy.core.replaceCommit();
    } catch (e) {
      throw failure(coreCode(e), e);
    } finally {
      this._endReplacement();
      this._revealUntil = Date.now() + REVEAL_GRACE_MS;
      await this._refreshHello();
      this._changed();
    }
  },

  async replaceAbort() {
    await lazy.core.replaceAbort().catch(() => {});
    this._endReplacement();
  },

  _endReplacement() {
    this._replacing?.done();
    this._replacing = null;
  },

  async lock() {
    if (this.state != "unlocked") {
      return;
    }
    // Locking drops a prepared replacement (the core aborts it).
    this._endReplacement();
    this._index = null;
    this._health = null;
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

  /** Whether show and copy can be confirmed with Windows Hello. */
  get canConfirmWithHello() {
    return this.state == "unlocked" && this.hello.available && this.hello.enrolled;
  },

  /**
   * Windows Hello in place of the master password to show or copy (one
   * prompt; the same 5 minutes). Export, a new recovery key and password
   * changes still ask for the master password.
   */
  async confirmWithHello() {
    this._requireUnlocked();
    if (!this.canConfirmWithHello) {
      throw failure("hello-unavailable");
    }
    let ok;
    try {
      ok = await lazy.core.checkHello();
    } catch (e) {
      if (coreCode(e) == "BWV_E_NO_SLOT") {
        await this._refreshHello();
      }
      throw failure(coreCode(e) == "BWV_E_CANCELLED" ? "cancelled" : "hello-failed", e);
    }
    if (!ok) {
      throw failure("hello-failed");
    }
    this._revealUntil = Date.now() + REVEAL_GRACE_MS;
  },

  // Bumped on every change to the logins: the health cache's key.
  _generation: 0,

  /**
   * Password health, all on this computer: Map of entry id to
   * { reused: how many other logins have the same password, weak }.
   * Worked out inside nsIPasswordVault; cached until the logins change.
   */
  async health() {
    this._requireUnlocked();
    let generation = this._generation;
    if (this._health?.generation == generation) {
      return this._health.result;
    }
    let entries = this._index.entries.map(e => ({ id: e.id, origin: e.origin }));
    let json;
    try {
      json = await lazy.core.health(
        entries.map(e => e.id),
        entries.map(e => e.origin)
      );
    } catch (e) {
      throw failure(coreCode(e), e);
    }
    let result = new Map();
    JSON.parse(json).forEach((h, i) => {
      result.set(entries[i].id, {
        reused: h.reused,
        weak: h.length > 0 && isWeakPassword(h.length, h.classes),
      });
    });
    if (generation == this._generation) {
      this._health = { generation, result };
    }
    return result;
  },

  /**
   * This computer only: the master password works only together with a key
   * in this computer's TPM, so a copy of the vault file doesn't open
   * elsewhere. Needs a recovery key first: it is the way in if the TPM is
   * cleared or the computer replaced. Export still makes a portable copy.
   */
  async enableDeviceBinding(master) {
    this._requireUnlocked();
    await this._waitForReplacement();
    if (!this.hasRecoveryKey) {
      throw failure("needs-recovery-key");
    }
    try {
      await lazy.core.enableDeviceBinding(master.normalize("NFC"));
    } catch (e) {
      let code = coreCode(e);
      throw failure(
        code == "BWV_E_AUTH" ? "wrong-password" : code == "BWV_E_NO_SLOT" ? "needs-recovery-key" : code,
        e
      );
    } finally {
      await this._refreshHello();
      this._changed();
    }
  },

  async disableDeviceBinding(master) {
    this._requireUnlocked();
    await this._waitForReplacement();
    try {
      await lazy.core.disableDeviceBinding(master.normalize("NFC"));
    } catch (e) {
      throw failure(coreCode(e) == "BWV_E_AUTH" ? "wrong-password" : coreCode(e), e);
    } finally {
      await this._refreshHello();
      this._changed();
    }
  },

  async changeMasterPassword(current, fresh, confirmation) {
    await this._waitForReplacement();
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
    await this._waitForReplacement();
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
    await this._waitForReplacement();
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
    await this._waitForReplacement();
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
    await this._waitForReplacement();
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
    await this._waitForReplacement();
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
    await this._waitForReplacement();
    this._requireUnlocked();
    if (!this._index.never.includes(origin)) {
      this._index.never.push(origin);
      await this._save();
    }
  },

  async removeNever(origin) {
    await this._waitForReplacement();
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
      case "browserwip:session-locked":
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
