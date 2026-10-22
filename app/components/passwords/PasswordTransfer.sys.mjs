/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Import and export, the parts without secrets or Gecko (docs/PASSWORDS.md
 * §9): reading the columns of a CSV file from Firefox, Chrome, Bitwarden or
 * KeePassXC, planning an import against the logins already saved, and
 * writing the plain-text CSV export. Runs in Node too (tests/unit).
 */

import { isFillableOrigin, normalizeOrigin } from "./PasswordRules.sys.mjs";

// Header names, lower-cased, for each field. Firefox: url, username,
// password, httpRealm, timeCreated, timePasswordChanged. Chrome: url,
// username, password. Bitwarden: login_uri, login_username,
// login_password. KeePassXC: URL, Username, Password.
const COLUMNS = {
  url: ["url", "login_uri", "website", "web site", "origin", "hostname"],
  username: ["username", "login_username", "user name", "login"],
  password: ["password", "login_password"],
  realm: ["httprealm"],
  created: ["timecreated"],
  changed: ["timepasswordchanged"],
};

export const CSV_HEADER = ["url", "username", "password", "httpRealm"];

// The magic bytes of an encrypted vault file (bwvault.h).
const VAULT_MAGIC = [0x42, 0x57, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x00];

/** Whether these bytes are an encrypted vault (.bwv), not a CSV file. */
export function isVaultFile(bytes) {
  return bytes.length >= VAULT_MAGIC.length && VAULT_MAGIC.every((b, i) => bytes[i] === b);
}

function timestamp(value) {
  let n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Logins from a parsed CSV file (toolkit's CSV.parse: the header line, and
 * one object per row keyed by the header's names). Rows that aren't a web
 * login (no web address, no password; an android:// or app entry) are
 * counted as skipped. Throws an Error with code "no-columns" when the
 * file has no address or password column.
 */
export function loginsFromCSV(header, rows) {
  let names = new Map(header.map(name => [String(name).trim().toLowerCase(), name]));
  let column = field => COLUMNS[field].map(n => names.get(n)).find(n => n !== undefined);
  let url = column("url");
  let password = column("password");
  if (url === undefined || password === undefined) {
    let error = new Error("no-columns");
    error.code = "no-columns";
    throw error;
  }
  let username = column("username");
  let realm = column("realm");
  let created = column("created");
  let changed = column("changed");
  let logins = [];
  let skipped = 0;
  for (let row of rows) {
    let origin = normalizeOrigin(row[url] ?? "");
    let secret = row[password] ?? "";
    if (!origin || !secret) {
      skipped++;
      continue;
    }
    logins.push({
      origin,
      username: username === undefined ? "" : (row[username] ?? ""),
      password: secret,
      realm: realm === undefined ? null : row[realm] || null,
      created: created === undefined ? 0 : timestamp(row[created]),
      changed: changed === undefined ? 0 : timestamp(row[changed]),
    });
  }
  return { logins, skipped };
}

/**
 * What importing `incoming` would do next to the saved `existing` logins:
 *   fresh       new logins
 *   duplicates  [{ incoming, existing }]: the same site and username is
 *               saved already; the user chooses, nothing is overwritten
 *               silently (§9)
 *   repeated    logins the file itself has twice (the first is kept)
 *   insecure    how many of fresh and duplicates are plain http: imported,
 *               but never filled
 */
export function planImport(existing, incoming) {
  let key = login => `${login.origin}\n${login.username}`;
  let saved = new Map(existing.map(e => [key(e), e]));
  let seen = new Set();
  let plan = { fresh: [], duplicates: [], repeated: 0, insecure: 0 };
  for (let login of incoming) {
    let k = key(login);
    if (seen.has(k)) {
      plan.repeated++;
      continue;
    }
    seen.add(k);
    if (!isFillableOrigin(login.origin)) {
      plan.insecure++;
    }
    let match = saved.get(k);
    if (match) {
      plan.duplicates.push({ incoming: login, existing: match });
    } else {
      plan.fresh.push(login);
    }
  }
  return plan;
}

function csvField(value) {
  let text = String(value ?? "");
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The plain-text export: url, username, password, httpRealm, which
 * Firefox, Chrome and Bitwarden import (RFC 4180, CRLF line ends).
 */
export function toCSV(logins) {
  let lines = [CSV_HEADER.join(",")];
  for (let login of logins) {
    lines.push([login.origin, login.username, login.password, login.realm ?? ""].map(csvField).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
