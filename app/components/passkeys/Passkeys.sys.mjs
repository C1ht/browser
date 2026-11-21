/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Passkeys the browser keeps (docs/PASSWORDS.md §20).
 *
 * PasskeyService (C++) stands in front of Gecko's WebAuthn service and
 * hands each page's request here. The window (passkeys.js) asks where: a
 * passkey kept in the browser, or a security key (then Gecko's service
 * takes the request over, with its own prompts, webauthn.js). Signing in
 * with no passkeys here for the site goes to a security key directly.
 *
 * A passkey here is an ECDSA P-256 key made with Web Crypto. Its private
 * key is sealed in the password vault (PasswordVault.savePasskey), opened
 * only to sign, and never leaves the browser process. Attestation is
 * "none"; the signature counter stays 0, as passkey providers keep it.
 * Using one needs the vault unlocked, and the master password typed in the
 * last 5 minutes unless the site says verification is "discouraged": that
 * is the user verification the site is told of.
 *
 * Requests for passkey autofill (conditional mediation) wait here until the
 * user picks a passkey in a login field's dropdown (passwords.js).
 */

import { PasswordVault } from "resource://gre/modules/browserwip/PasswordVault.sys.mjs";
import {
  ES256,
  FLAGS,
  attestationObject,
  authenticatorData,
  base64url,
  concat,
  coseKey,
  derSignature,
  fromBase64url,
  sha256,
} from "resource://gre/modules/browserwip/PasskeyFormats.sys.mjs";

// Notified when passkey autofill requests start or end.
export const CONDITIONAL_TOPIC = "browserwip:passkeys-conditional";

function log(...args) {
  console.info("browser-wip: passkeys:", ...args);
}

export const Passkeys = {
  QueryInterface: ChromeUtils.generateQI(["nsIBrowserWipPasskeyProvider"]),
  CONDITIONAL_TOPIC,

  // transactionId -> { tid, request, details, browser, browsingContextId }
  _pending: new Map(),

  /** Stands in front of Gecko's WebAuthn service, at startup. */
  init() {
    try {
      Cc["@browser-wip/passkey-service;1"].getService(Ci.nsIBrowserWipPasskeyService).install(this);
    } catch (e) {
      // Without it, security keys work as in Firefox.
      console.error("browser-wip: passkeys unavailable", e);
    }
  },

  // nsIBrowserWipPasskeyProvider

  handle(request) {
    let details = JSON.parse(request.json);
    details.kind = request.kind;
    let browser = BrowsingContext.get(request.browsingContextId)?.top?.embedderElement;
    let prompts = browser?.ownerDocument?.defaultView?.PasskeyPrompts;
    if (!prompts) {
      // Not a tab of a browser window: Gecko's service, as without this.
      throw Components.Exception("no window", Cr.NS_ERROR_NOT_AVAILABLE);
    }
    let entry = {
      tid: request.transactionId,
      request,
      details,
      browser,
      browsingContextId: request.browsingContextId,
    };
    this._pending.set(entry.tid, entry);
    if (details.conditional) {
      Services.obs.notifyObservers(null, CONDITIONAL_TOPIC);
      return;
    }
    // Signing in, with no vault (so no passkeys here): a security key.
    if (details.kind == "get" && PasswordVault.state == "none") {
      this.useSecurityKey(entry);
      return;
    }
    if (details.kind == "get" && PasswordVault.state == "unlocked" && !this.candidates(entry).length) {
      this.useSecurityKey(entry);
      return;
    }
    prompts.show(entry);
  },

  cancel(tid) {
    let entry = this._pending.get(tid);
    this._pending.delete(tid);
    if (entry) {
      entry.browser.ownerDocument?.defaultView?.PasskeyPrompts?.ended(entry);
      if (entry.details.conditional) {
        Services.obs.notifyObservers(null, CONDITIONAL_TOPIC);
      }
    }
  },

  // For the window

  /** The vault's passkeys that can answer a sign-in request. */
  candidates(entry) {
    return PasswordVault.passkeysFor(entry.details.rpId, entry.details.allowList ?? []);
  },

  /**
   * Why a passkey can't be made here for this request, or null:
   * "private" (a private window), "algorithm" (the site doesn't take ES256)
   * or "exists" (this account has one here already; known once unlocked).
   */
  cannotCreate(entry) {
    let { details } = entry;
    if (details.privateBrowsing) {
      return "private";
    }
    if (!details.algs.includes(ES256)) {
      return "algorithm";
    }
    if (PasswordVault.state == "unlocked") {
      let excluded = new Set(details.excludeList);
      if (PasswordVault.passkeysFor(details.rpId).some(p => excluded.has(p.credentialId))) {
        return "exists";
      }
    }
    return null;
  },

  /** Whether the site must be told the user was verified (the master password, now). */
  needsVerification(entry) {
    return entry.details.userVerification != "discouraged" && !PasswordVault.recentlyAuthenticated;
  },

  /** The passkey autofill request a frame has waiting, if any. */
  conditionalFor(browsingContextId) {
    for (let entry of this._pending.values()) {
      if (entry.details.conditional && entry.browsingContextId == browsingContextId && !entry.request.settled) {
        return entry;
      }
    }
    return null;
  },

  _done(entry) {
    this._pending.delete(entry.tid);
    if (entry.details.conditional) {
      Services.obs.notifyObservers(null, CONDITIONAL_TOPIC);
    }
  },

  /** Makes the passkey, keeps it in the vault, and gives the site its public key. */
  async create(entry) {
    let { details, request } = entry;
    if (request.settled) {
      return;
    }
    let reason = this.cannotCreate(entry);
    if (reason) {
      throw Object.assign(new Error(reason), { code: reason });
    }
    let subtle = crypto.subtle;
    let pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    let privateKey = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
    let publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
    let credentialId = crypto.getRandomValues(new Uint8Array(16));
    let flags = FLAGS.UP | FLAGS.AT | (PasswordVault.recentlyAuthenticated ? FLAGS.UV : 0);
    let authData = authenticatorData({
      rpIdHash: await sha256(new TextEncoder().encode(details.rpId)),
      flags,
      credentialId,
      publicKey: coseKey(publicKey),
    });
    await PasswordVault.savePasskey({
      rpId: details.rpId,
      credentialId: base64url(credentialId),
      userHandle: details.user.id,
      userName: details.user.name,
      displayName: details.user.displayName,
      privateKey: base64url(privateKey),
    });
    privateKey.fill(0);
    if (request.settled) {
      return;
    }
    request.resolveCreate(credentialId, attestationObject(authData));
    this._done(entry);
    log(`made a passkey for ${details.rpId}`);
  },

  /** Signs the site's challenge with one of the vault's passkeys. */
  async sign(entry, passkeyId) {
    let { details, request } = entry;
    let passkey = this.candidates(entry).find(p => p.id == passkeyId);
    if (!passkey || request.settled) {
      throw Object.assign(new Error("not-fillable"), { code: "not-fillable" });
    }
    let pkcs8 = fromBase64url(await PasswordVault.passkeyKey(passkey.id));
    let key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    pkcs8.fill(0);
    let authData = authenticatorData({
      rpIdHash: await sha256(new TextEncoder().encode(details.rpId)),
      flags: FLAGS.UP | (PasswordVault.recentlyAuthenticated ? FLAGS.UV : 0),
    });
    let signed = concat(authData, fromBase64url(details.clientDataHash));
    let raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signed));
    if (request.settled) {
      return;
    }
    request.resolveGet(fromBase64url(passkey.credentialId), authData, derSignature(raw), fromBase64url(passkey.userHandle));
    this._done(entry);
    PasswordVault.passkeyUsed(passkey.id);
    log(`signed in to ${details.rpId} with a passkey`);
  },

  /** Gecko's service takes the request over: a security key. */
  useSecurityKey(entry) {
    this._pending.delete(entry.tid);
    if (!entry.request.settled) {
      entry.request.useSecurityKey();
    }
  },

  /** The user said no. */
  refuse(entry) {
    this._done(entry);
    if (!entry.request.settled) {
      entry.request.reject("not-allowed");
    }
  },
};
