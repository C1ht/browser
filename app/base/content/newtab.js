/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const TILE_COLORS = ["#3B6EA8", "#4E7A3A", "#B4452F", "#6B4C9A", "#2F7D74", "#8C6A1E", "#A0436E", "#4A6475"];

// The most visited sites, one entry per host, from this profile's history.
async function topSites(limit = 8) {
  let db = await PlacesUtils.promiseDBConnection();
  let rows = await db.executeCached(
    `SELECT url, title, frecency FROM moz_places
     WHERE hidden = 0 AND last_visit_date NOT NULL AND frecency > 0
       AND (url LIKE 'https://%' OR url LIKE 'http://%')
     ORDER BY frecency DESC LIMIT 100`
  );
  let byHost = new Map();
  for (let row of rows) {
    let url = new URL(row.getResultByName("url"));
    let host = url.hostname.replace(/^www\./, "");
    if (!byHost.has(host)) {
      byHost.set(host, { host, url: url.origin + "/", title: row.getResultByName("title") });
    }
    if (byHost.size == limit) {
      break;
    }
  }
  return [...byHost.values()];
}

function tile(site) {
  let hash = 0;
  for (let c of site.host) {
    hash = (hash * 31 + c.codePointAt(0)) >>> 0;
  }
  let a = document.createElement("a");
  a.className = "site";
  a.href = site.url;
  let icon = document.createElement("span");
  icon.className = "site-icon";
  icon.textContent = site.host[0].toUpperCase();
  icon.style.setProperty("--tile", TILE_COLORS[hash % TILE_COLORS.length]);
  let label = document.createElement("span");
  label.className = "site-label";
  label.textContent = site.host;
  a.append(icon, label);
  return a;
}

window.addEventListener("DOMContentLoaded", async () => {
  let sites = await topSites().catch(() => []);
  if (sites.length) {
    let nav = document.getElementById("top-sites");
    nav.append(...sites.map(tile));
    nav.hidden = false;
  }
});
