/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where a saved login may be offered (docs/PASSWORDS.md §7.1). Pure: no
 * Gecko services. The public suffix list is passed in as getBaseDomain(host),
 * so the same code runs in the browser and in Node (tests/unit).
 *
 * Origins are compared as strings in one normal form: scheme, lower-case
 * ASCII (punycode) host, and the port only when it isn't the scheme's
 * default. That is what a frame principal's originNoSuffix looks like, so
 * the frame's own origin can be compared directly.
 */

// The one scheme logins are filled, offered and saved on (§17 Q8: no
// exception for localhost or LAN devices).
const FILL_SCHEME = "https:";

/**
 * The normal form of an origin, or null. Accepts a full URL, an origin, or
 * a bare host (taken as https).
 */
export function normalizeOrigin(input) {
  if (typeof input != "string") {
    return null;
  }
  let text = input.trim();
  if (!text) {
    return null;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    text = "https://" + text;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // URL already lower-cases, converts IDN to punycode and drops a default
  // port; origin is scheme://host[:port].
  return url.origin;
}

/** Whether logins may be filled, offered or saved on this origin. */
export function isFillableOrigin(origin) {
  return (
    typeof origin == "string" &&
    origin.startsWith(FILL_SCHEME + "//") &&
    normalizeOrigin(origin) === origin
  );
}

/** "accounts.example.com" or "example.com:8443", for the UI. */
export function displayHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function isIPAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

/**
 * The registrable domain of an origin ("example.co.uk"), or its host when
 * it has none (an IP address, a bare public suffix, localhost).
 */
export function siteOf(origin, getBaseDomain) {
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  if (isIPAddress(host)) {
    return host;
  }
  try {
    return getBaseDomain(host) || host;
  } catch {
    return host;
  }
}

/**
 * The entries that may be offered on frameOrigin:
 *  - exact: saved for this origin, or listing it under "also"
 *  - sameSite: saved for another origin of the same site (another
 *    subdomain, same scheme), offered only as "Saved for …" with "Also use
 *    here", and only when allowSameSite (Standard mode, §17 Q5)
 * Nothing for an origin logins aren't filled on.
 */
export function matchEntries(entries, frameOrigin, { getBaseDomain, allowSameSite = false } = {}) {
  let result = { exact: [], sameSite: [] };
  if (!isFillableOrigin(frameOrigin)) {
    return result;
  }
  let site = allowSameSite ? siteOf(frameOrigin, getBaseDomain) : null;
  let frameHost = new URL(frameOrigin).hostname;
  for (let entry of entries) {
    if (entry.origin === frameOrigin || entry.also?.includes(frameOrigin)) {
      result.exact.push(entry);
    } else if (
      site &&
      !isIPAddress(frameHost) &&
      isFillableOrigin(entry.origin) &&
      siteOf(entry.origin, getBaseDomain) === site
    ) {
      result.sameSite.push(entry);
    }
  }
  let byUse = (a, b) => (b.used || 0) - (a.used || 0) || a.username.localeCompare(b.username);
  result.exact.sort(byUse);
  result.sameSite.sort(byUse);
  return result;
}

/** The entry for origin and username, if there is one (for "Update password?"). */
export function findLogin(entries, origin, username) {
  return entries.find(e => e.origin === origin && e.username === username) ?? null;
}

/** A new entry id: 16 random bytes, base64url without padding. */
export function newEntryId(getRandomValues) {
  let bytes = new Uint8Array(16);
  getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** An empty index, as written at setup (§4.1). */
export function emptyIndex() {
  return { v: 1, entries: [], never: [] };
}

/**
 * The index from JSON, checked enough that the rest of the code can trust
 * its shape. Throws on anything else.
 */
export function parseIndex(json) {
  let index = JSON.parse(json);
  if (!index || index.v !== 1 || !Array.isArray(index.entries)) {
    throw new Error("Unsupported index");
  }
  index.never = Array.isArray(index.never) ? index.never.filter(o => typeof o == "string") : [];
  index.entries = index.entries.filter(
    e => e && typeof e.id == "string" && typeof e.origin == "string" && typeof e.username == "string"
  );
  for (let e of index.entries) {
    e.also = Array.isArray(e.also) ? e.also.filter(o => typeof o == "string") : [];
    e.realm ??= null;
    for (let key of ["created", "changed", "used"]) {
      e[key] = Number.isFinite(e[key]) ? e[key] : 0;
    }
  }
  return index;
}
