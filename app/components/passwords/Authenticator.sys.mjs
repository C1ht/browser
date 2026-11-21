/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Authenticator codes (two-step verification), as authenticator apps make
 * them: time-based one-time passwords (TOTP, RFC 6238) from a setup key a
 * site shows as a QR code or as text. Pure functions, used by
 * PasswordVault.sys.mjs and, in Node, by tests/unit.
 *
 * A setup key is kept as its Base32 text (upper case, no padding or
 * spaces); the settings beside it are { digits, period, algorithm, issuer,
 * account }, with the defaults every authenticator app assumes.
 */

export const DEFAULTS = { digits: 6, period: 30, algorithm: "SHA1" };
const ALGORITHMS = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
// Shorter than 80 bits isn't a real key (RFC 4226 asks for 128 or more).
const MIN_KEY_BYTES = 10;
const MAX_KEY_BYTES = 256;

function invalid(code) {
  let error = new Error(code);
  error.code = code;
  return error;
}

/** Bytes from Base32 text; spaces, dashes and padding are ignored. Null if it isn't Base32. */
export function base32Decode(text) {
  let clean = String(text).toUpperCase().replace(/[\s=-]/g, "");
  if (!clean || /[^A-Z2-7]/.test(clean)) {
    return null;
  }
  let bytes = [];
  let bits = 0;
  let value = 0;
  for (let ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** A setup key in the form it's kept: Base32, upper case, no padding or spaces. */
export function normalizeKey(text) {
  return String(text).toUpperCase().replace(/[\s=-]/g, "");
}

// The settings, made valid: what the vault index keeps beside the key.
export function cleanSettings(settings = {}) {
  let digits = Number(settings.digits);
  let period = Number(settings.period);
  let algorithm = String(settings.algorithm ?? "").toUpperCase().replace("-", "");
  return {
    digits: [6, 7, 8].includes(digits) ? digits : DEFAULTS.digits,
    period: Number.isInteger(period) && period >= 10 && period <= 300 ? period : DEFAULTS.period,
    algorithm: ALGORITHMS[algorithm] ? algorithm : DEFAULTS.algorithm,
    issuer: typeof settings.issuer == "string" ? settings.issuer.slice(0, 100) : "",
    account: typeof settings.account == "string" ? settings.account.slice(0, 200) : "",
  };
}

/**
 * What a user pasted or a QR code held: an otpauth://totp/ link, or a bare
 * setup key. Resolves to { key, settings }; throws with code
 * "otp-counter" (otpauth://hotp/, counter-based codes, not supported),
 * "otp-not-a-key" or "otp-short-key".
 */
export function parseAuthenticator(text) {
  let input = String(text ?? "").trim();
  let key;
  let settings = {};
  if (/^otpauth:/i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch (e) {
      throw invalid("otp-not-a-key");
    }
    let type = (url.host || url.pathname.replace(/^\/\//, "").split("/")[0]).toLowerCase();
    if (type == "hotp") {
      throw invalid("otp-counter");
    }
    if (type != "totp") {
      throw invalid("otp-not-a-key");
    }
    let params = url.searchParams;
    key = params.get("secret") ?? "";
    // The label: "Issuer:account" or "account".
    let label = decodeURIComponent(url.pathname.replace(/^\/+/, "").replace(/^totp\//i, ""));
    let [labelIssuer, account] = label.includes(":") ? label.split(/:(.*)/s) : ["", label];
    settings = {
      digits: params.get("digits"),
      period: params.get("period"),
      algorithm: params.get("algorithm"),
      issuer: params.get("issuer") ?? labelIssuer.trim(),
      account: (account ?? "").trim(),
    };
  } else {
    key = input;
  }
  let bytes = base32Decode(key);
  if (!bytes) {
    throw invalid("otp-not-a-key");
  }
  if (bytes.length < MIN_KEY_BYTES || bytes.length > MAX_KEY_BYTES) {
    throw invalid("otp-short-key");
  }
  return { key: normalizeKey(key), settings: cleanSettings(settings) };
}

/** An otpauth://totp/ link for the key, for moving it to another app. */
export function authenticatorURI(key, settings) {
  let s = cleanSettings(settings);
  let label = encodeURIComponent(s.issuer ? `${s.issuer}:${s.account}` : s.account || "account");
  let params = new URLSearchParams({ secret: normalizeKey(key) });
  if (s.issuer) {
    params.set("issuer", s.issuer);
  }
  if (s.algorithm != DEFAULTS.algorithm) {
    params.set("algorithm", s.algorithm);
  }
  if (s.digits != DEFAULTS.digits) {
    params.set("digits", String(s.digits));
  }
  if (s.period != DEFAULTS.period) {
    params.set("period", String(s.period));
  }
  return `otpauth://totp/${label}?${params}`;
}

/**
 * The code for `key` at `now` (ms): { code, remaining } with the seconds
 * the code has left. RFC 6238, with HMAC from Web Crypto.
 */
export async function totp(key, settings, now = Date.now(), subtle = globalThis.crypto.subtle) {
  let { digits, period, algorithm } = cleanSettings(settings);
  let bytes = base32Decode(key);
  if (!bytes) {
    throw invalid("otp-not-a-key");
  }
  let seconds = Math.floor(now / 1000);
  let counter = Math.floor(seconds / period);
  let message = new Uint8Array(8);
  // 8 bytes, big endian; counters fit in 53 bits.
  let high = Math.floor(counter / 2 ** 32);
  let low = counter >>> 0;
  new DataView(message.buffer).setUint32(0, high);
  new DataView(message.buffer).setUint32(4, low);
  let hmacKey = await subtle.importKey("raw", bytes, { name: "HMAC", hash: ALGORITHMS[algorithm] }, false, ["sign"]);
  let mac = new Uint8Array(await subtle.sign("HMAC", hmacKey, message));
  // Dynamic truncation (RFC 4226 §5.3).
  let offset = mac[mac.length - 1] & 0x0f;
  let binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  let code = String(binary % 10 ** digits).padStart(digits, "0");
  return { code, remaining: period - (seconds % period), period };
}

/** "123456" as "123 456", "12345678" as "1234 5678", for reading. */
export function formatCode(code) {
  let half = Math.ceil(code.length / 2);
  return code.length >= 6 ? `${code.slice(0, half)} ${code.slice(half)}` : code;
}
