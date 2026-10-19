/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Hides the empty frames that blocked ads leave behind, using the
 * element-hiding rules of the bundled filter lists.
 *
 * Network blocking happens in the parent (blocker/NetworkBlocker.cpp); this
 * actor only adds user-agent stylesheets. It runs on DOMDocElementInserted,
 * before the first layout, so ad slots never flash on screen. Rules are
 * applied as agent-level `display: none !important`, which page styles
 * cannot override.
 */

const BASE = "resource://gre/defaults/contentblocking/";
const AGENT_SHEET = Ci.nsIStyleSheetService.AGENT_SHEET;

// Services.stylesheet is not exposed in content processes; the service is.
const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "styleSheetService", () =>
  Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService)
);

// Parsed once per content process and shared by every document in it.
let gGenericSheet = null;
let gIndex = null;
// Per-site sheets keyed by their CSS. Most sites share the same selector set
// (the conditional generic rules), so this stays small and saves a parse
// per page load.
const gSiteSheets = new Map();
const MAX_SITE_SHEETS = 64;

function genericSheet() {
  gGenericSheet ??= lazy.styleSheetService.preloadSheet(
    Services.io.newURI(BASE + "cosmetic-generic.css"),
    AGENT_SHEET
  );
  return gGenericSheet;
}

function siteSheet(css) {
  let sheet = gSiteSheets.get(css);
  if (!sheet) {
    sheet = lazy.styleSheetService.preloadSheet(
      Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(css)),
      AGENT_SHEET
    );
    if (gSiteSheets.size >= MAX_SITE_SHEETS) {
      gSiteSheets.delete(gSiteSheets.keys().next().value);
    }
  } else {
    gSiteSheets.delete(css);
  }
  // Re-insert so the Map's order is least- to most-recently used.
  gSiteSheets.set(css, sheet);
  return sheet;
}

// The per-site rules, published by the parent process (content processes are
// sandboxed and cannot read the file themselves). Shared memory, so every
// process sees one copy.
const INDEX_KEY = "browserwip:cosmetic-sites";

function siteIndex() {
  gIndex ??= Services.cpmm.sharedData.get(INDEX_KEY) ?? null;
  return gIndex;
}

// "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com", "com"]
function hostSuffixes(host) {
  let parts = host.split(".");
  return parts.map((_, i) => parts.slice(i).join("."));
}

export function selectorsForHost(host, index = siteIndex()) {
  if (!index) {
    // Not published yet (only possible in the first moments of startup).
    return { useGeneric: true, selectors: [] };
  }
  let suffixes = hostSuffixes(host);
  let excepted = new Set(suffixes.flatMap(d => index.specificExcept[d] ?? []));
  let selectors = new Set();
  for (let d of suffixes) {
    for (let s of index.specific[d] ?? []) {
      selectors.add(s);
    }
  }
  let useGeneric = !suffixes.some(d => index.noGeneric.includes(d));
  if (useGeneric) {
    let suffixSet = new Set(suffixes);
    for (let [s, domains] of Object.entries(index.conditionalGeneric)) {
      if (!domains.some(d => suffixSet.has(d))) {
        selectors.add(s);
      }
    }
  }
  for (let s of excepted) {
    selectors.delete(s);
  }
  return { useGeneric, selectors: [...selectors] };
}

export class ContentBlockingChild extends JSWindowActorChild {
  handleEvent(event) {
    let doc = event.target;
    if (doc != this.document || !this._shouldFilter(doc)) {
      return;
    }
    try {
      this._apply(doc);
    } catch (e) {
      console.error("browser-wip: element hiding failed", e);
    }
  }

  _shouldFilter(doc) {
    let uri = doc.documentURIObject;
    return (
      Services.prefs.getBoolPref("browserwip.contentblocking.cosmetic.enabled", true) &&
      (uri?.schemeIs("http") || uri?.schemeIs("https")) &&
      // "Turn off protections for this site" puts the top-level site on the
      // content-blocking allow list; it covers element hiding too.
      !doc.cookieJarSettings.isOnContentBlockingAllowList
    );
  }

  _apply(doc) {
    let utils = this.contentWindow.windowUtils;
    let { useGeneric, selectors } = selectorsForHost(doc.documentURIObject.host);
    if (useGeneric) {
      utils.addSheet(genericSheet(), AGENT_SHEET);
    }
    if (selectors.length) {
      // One rule per selector, so an invalid selector only drops itself.
      let css = selectors.map(s => `${s}{display:none!important}`).join("\n");
      utils.addSheet(siteSheet(css), AGENT_SHEET);
    }
  }
}
