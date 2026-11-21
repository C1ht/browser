/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What a passkey the browser keeps puts on the wire (WebAuthn Level 3,
 * CTAP 2.1): authenticator data, the attestation object (format "none"),
 * the public key as a COSE key, and signatures in DER. Pure functions,
 * used by Passkeys.sys.mjs and, in Node, by tests/unit.
 *
 * Keys are ECDSA P-256 with SHA-256 (COSE ES256, -7), which every relying
 * party accepts.
 */

export const ES256 = -7;

// Authenticator data flags (WebAuthn §6.1).
export const FLAGS = {
  UP: 0x01, // user present
  UV: 0x04, // user verified
  BE: 0x08, // backup eligible
  BS: 0x10, // backed up
  AT: 0x40, // attested credential data included
  ED: 0x80, // extension data included
};

// The AAGUID of a "none" attestation: all zeros, nothing identifying.
const AAGUID = new Uint8Array(16);

export function concat(...parts) {
  let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (let part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function base64url(bytes) {
  let binary = "";
  for (let b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text) {
  let base64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
  base64 += "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// CBOR (RFC 8949), as much as WebAuthn needs, in CTAP2 canonical form: the
// shortest encodings, and map keys sorted by their encoded bytes (shorter
// first, then bytewise).

function head(major, value) {
  if (value < 24) {
    return Uint8Array.of((major << 5) | value);
  }
  if (value < 0x100) {
    return Uint8Array.of((major << 5) | 24, value);
  }
  if (value < 0x10000) {
    return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  }
  if (value < 0x100000000) {
    return Uint8Array.of((major << 5) | 26, value >>> 24, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
  }
  throw new RangeError("CBOR value too large");
}

function compareBytes(a, b) {
  if (a.length != b.length) {
    return a.length - b.length;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] != b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

/**
 * Encodes integers, byte strings (Uint8Array), text, booleans, arrays,
 * Maps (any keys) and plain objects (text keys).
 */
export function cbor(value) {
  if (value instanceof Uint8Array) {
    return concat(head(2, value.length), value);
  }
  if (typeof value == "string") {
    let bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (typeof value == "number") {
    if (!Number.isInteger(value)) {
      throw new TypeError("CBOR: only integers");
    }
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value == "boolean") {
    return Uint8Array.of(value ? 0xf5 : 0xf4);
  }
  if (Array.isArray(value)) {
    return concat(head(4, value.length), ...value.map(cbor));
  }
  let entries = value instanceof Map ? [...value] : Object.entries(value);
  let encoded = entries
    .map(([k, v]) => [cbor(k), cbor(v)])
    .sort((a, b) => compareBytes(a[0], b[0]));
  return concat(head(5, encoded.length), ...encoded.flat());
}

// ---------------------------------------------------------------------------

/**
 * The public key as a COSE key (RFC 9053): EC2, ES256, P-256, from the 65
 * bytes Web Crypto exports ("raw": 0x04, x, y).
 */
export function coseKey(rawPublicKey) {
  if (rawPublicKey.length != 65 || rawPublicKey[0] != 0x04) {
    throw new Error("not an uncompressed P-256 point");
  }
  return cbor(
    new Map([
      [1, 2], // kty: EC2
      [3, ES256], // alg
      [-1, 1], // crv: P-256
      [-2, rawPublicKey.slice(1, 33)], // x
      [-3, rawPublicKey.slice(33, 65)], // y
    ])
  );
}

/**
 * Authenticator data (WebAuthn §6.1): the SHA-256 of the RP ID, flags, the
 * signature counter, and when registering, the attested credential data.
 */
export function authenticatorData({ rpIdHash, flags, signCount = 0, credentialId, publicKey }) {
  let counter = new Uint8Array(4);
  new DataView(counter.buffer).setUint32(0, signCount);
  let parts = [rpIdHash, Uint8Array.of(flags), counter];
  if (credentialId) {
    let length = Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff);
    parts.push(AAGUID, length, credentialId, publicKey);
  }
  return concat(...parts);
}

/** The attestation object of a "none" attestation. */
export function attestationObject(authData) {
  return cbor({ fmt: "none", attStmt: {}, authData });
}

/**
 * An ECDSA signature as WebAuthn wants it, in DER (SEQUENCE of two
 * INTEGERs), from the 64 bytes Web Crypto makes (r, then s).
 */
export function derSignature(raw) {
  if (raw.length != 64) {
    throw new Error("not a P-256 signature");
  }
  let integer = bytes => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] == 0) {
      start++;
    }
    let value = bytes.slice(start);
    // A leading 1 bit would make it negative.
    if (value[0] & 0x80) {
      value = concat(Uint8Array.of(0), value);
    }
    return concat(Uint8Array.of(0x02, value.length), value);
  };
  let body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export async function sha256(bytes, subtle = globalThis.crypto.subtle) {
  return new Uint8Array(await subtle.digest("SHA-256", bytes));
}
