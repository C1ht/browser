/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The search engines and their suggestions' answers. No Gecko imports, so
 * Node tests it (tests/unit/search-suggestions.test.mjs).
 */

export const ENGINE_PREF = "browserwip.search.engine";

// Search engines that need no account or API key. Suggestions answer in the
// OpenSearch JSON form, [query, [suggestion, ...]]. Mojeek has none.
export const SEARCH_ENGINES = {
  brave: {
    name: "Brave Search",
    url: "https://search.brave.com/search?q=",
    suggest: "https://search.brave.com/api/suggest?q=",
  },
  duckduckgo: {
    name: "DuckDuckGo",
    url: "https://duckduckgo.com/?q=",
    suggest: "https://duckduckgo.com/ac/?type=list&q=",
  },
  startpage: {
    name: "Startpage",
    url: "https://www.startpage.com/do/search?query=",
    suggest: "https://www.startpage.com/osuggestions?q=",
  },
  mojeek: { name: "Mojeek", url: "https://www.mojeek.com/search?q=", suggest: null },
};

const MAX_SUGGESTIONS = 5;

/** The selected search engine: { id, name, url, suggest }. */
export function currentEngine() {
  let id = Services.prefs.getStringPref(ENGINE_PREF, "brave");
  let engine = SEARCH_ENGINES[id] ? id : "brave";
  return { id: engine, ...SEARCH_ENGINES[engine] };
}

export function searchURL(terms) {
  return currentEngine().url + encodeURIComponent(terms);
}

/**
 * The suggestions in an engine's answer: at most 5 strings, without the
 * query itself, duplicates or anything that isn't a short line of text.
 */
export function parseSuggestions(text, query) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(data) || !Array.isArray(data[1])) {
    return [];
  }
  let seen = new Set([query.trim().toLowerCase()]);
  let out = [];
  for (let s of data[1]) {
    if (typeof s != "string") {
      continue;
    }
    s = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
    let key = s.toLowerCase();
    if (!s || s.length > 200 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(s);
    if (out.length == MAX_SUGGESTIONS) {
      break;
    }
  }
  return out;
}
