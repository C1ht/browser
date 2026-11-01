/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
const { Library } = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");
const { currentEngine } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/SearchEngines.sys.mjs"
);
const { PrivacyModes } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/PrivacyModes.sys.mjs"
);
const { ProtectionStats } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/ProtectionStats.sys.mjs"
);

const TILE_COLORS = ["#3B6EA8", "#4E7A3A", "#B4452F", "#6B4C9A", "#2F7D74", "#8C6A1E", "#A0436E", "#4A6475"];
// At most this many favorites; "Show more" past the first row.
const MAX_TILES = 16;
const SECTIONS = ["search", "favorites", "report"];
const SECTION_PREF = section => `browserwip.newtab.${section}`;
const BACKGROUND_PREF = "browserwip.newtab.background";

// "news.ycombinator.com" -> "ycombinator", for a bookmark without a title.
const hostOf = url => new URL(url).hostname.replace(/^www\./, "");

function siteName(host) {
  try {
    let base = Services.eTLD.getBaseDomainFromHost(host);
    let suffix = Services.eTLD.getPublicSuffixFromHost(host);
    return base.slice(0, -(suffix.length + 1)) || host;
  } catch (e) {
    return host;
  }
}

// The bookmarks on the bookmarks bar (not its folders). There are no
// default tiles: an empty bar shows a hint and "Import bookmarks".
async function favorites() {
  let items = await Library.children(Library.BAR).catch(() => []);
  return items
    .filter(item => item.type == "bookmark" && /^https?:/.test(item.url))
    .slice(0, MAX_TILES)
    .map(item => {
      let url = new URL(item.url);
      return {
        host: hostOf(item.url),
        url: item.url,
        pages: [item.url, url.origin + "/"],
        name: item.title || siteName(url.hostname),
      };
    });
}

// The icon history or the bookmark has: { src, touch }, or null for a
// letter tile. This page never fetches anything.
async function siteIcon(site) {
  for (let page of site.pages) {
    try {
      let icon = await PlacesUtils.favicons.getFaviconForPage(Services.io.newURI(page), 64);
      if (icon?.dataURI) {
        return { src: icon.dataURI.spec, touch: false };
      }
    } catch (e) {}
  }
  return null;
}

// A black logo (GitHub's) would vanish on a dark tile: true when the
// icon's opaque pixels are mostly dark.
function isDarkIcon(img) {
  let canvas = document.createElement("canvas");
  canvas.width = canvas.height = 24;
  let context = canvas.getContext("2d", { willReadFrequently: true });
  try {
    context.drawImage(img, 0, 0, 24, 24);
    let data = context.getImageData(0, 0, 24, 24).data;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 128) {
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        count++;
      }
    }
    return count > 0 && sum / count < 60;
  } catch (e) {
    return false;
  }
}

var NewTab = {
  init() {
    document.getElementById("import-bookmarks").addEventListener("click", () => this._import());
    for (let section of document.querySelectorAll(".tiles-section")) {
      section.querySelector(".more").addEventListener("click", () => {
        section.toggleAttribute("expanded");
        this._fit(section);
      });
    }
    new ResizeObserver(() => document.querySelectorAll(".tiles-section").forEach(s => this._fit(s))).observe(
      document.getElementById("newtab")
    );
    this._initSearch();
    Customize.init(() => this.render());
    this.render();
  },

  // -- Search: the address field's own rules decide between an address and
  // a search, and it loads the result.

  _initSearch() {
    let form = document.getElementById("search");
    let input = document.getElementById("search-input");
    document.l10n.setAttributes(input, "newtab-search", { engine: currentEngine().name });
    form.addEventListener("submit", e => {
      e.preventDefault();
      let urlbar = window.browsingContext.topChromeWindow?.gURLBar;
      let text = input.value.trim();
      if (!urlbar || !text) {
        return;
      }
      urlbar.input.value = text;
      urlbar.go();
    });
  },

  async render() {
    let show = section => Services.prefs.getBoolPref(SECTION_PREF(section), true);
    document.getElementById("search").hidden = !show("search");
    let [favs, stats] = await Promise.all([
      show("favorites") ? favorites() : [],
      show("report") ? ProtectionStats.recent(7) : null,
    ]);
    await this._fill("favorites", favs, show("favorites"));
    document.querySelector("#favorites .favorites-empty").hidden = favs.length > 0;
    this._report(stats);

    let anything = SECTIONS.some(s => !document.getElementById(s).hidden);
    let calm = document.getElementById("calm");
    calm.hidden = anything;
    if (!anything) {
      document.l10n.setAttributes(document.getElementById("calm-text"), "newtab-calm");
    }
    document.body.setAttribute("ready", "true");
  },

  async _fill(id, sites, shown) {
    let section = document.getElementById(id);
    let tiles = shown ? await Promise.all(sites.map(site => this._tile(site))) : [];
    section.querySelector(".tiles").replaceChildren(...tiles);
    section.hidden = !shown;
    this._fit(section);
  },

  // One row unless expanded; "Show more" when there's more than a row.
  _fit(section) {
    let grid = section.querySelector(".tiles");
    let tiles = [...grid.children];
    let columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
    let expanded = section.hasAttribute("expanded");
    tiles.forEach((tile, i) => (tile.hidden = !expanded && i >= columns));
    let more = section.querySelector(".more");
    more.hidden = tiles.length <= columns;
    document.l10n.setAttributes(more, expanded ? "newtab-show-less" : "newtab-show-more");
  },

  async _tile(site) {
    let item = document.createElement("div");
    item.className = "site";
    let link = document.createElement("a");
    link.className = "site-link";
    link.href = site.url;
    link.title = site.url;
    let icon = document.createElement("span");
    icon.className = "site-icon";
    let found = await siteIcon(site);
    if (found) {
      this._showIcon(icon, site, found);
    } else {
      this._showLetter(icon, site);
    }
    let label = document.createElement("span");
    label.className = "site-label";
    label.textContent = site.name;
    link.append(icon, label);
    item.append(link);
    return item;
  },

  _showIcon(icon, site, { src, touch }) {
    let img = document.createElement("img");
    img.alt = "";
    img.addEventListener("error", () => this._showLetter(icon, site), { once: true });
    img.addEventListener("load", () => icon.classList.toggle("dark-icon", !touch && isDarkIcon(img)), { once: true });
    img.src = src;
    icon.className = "site-icon";
    icon.classList.toggle("touch", touch);
    icon.style.removeProperty("--tile");
    icon.replaceChildren(img);
  },

  _showLetter(icon, site) {
    let color = site.color;
    if (!color) {
      let hash = 0;
      for (let c of site.host) {
        hash = (hash * 31 + c.codePointAt(0)) >>> 0;
      }
      color = TILE_COLORS[hash % TILE_COLORS.length];
    }
    icon.className = "site-icon letter";
    icon.textContent = (site.name.trim()[0] ?? site.host[0]).toUpperCase();
    icon.style.setProperty("--tile", color);
  },

  // -- Privacy report ---------------------------------------------------

  _report(stats) {
    let section = document.getElementById("report");
    section.hidden = !stats;
    if (!stats) {
      return;
    }
    let number = document.getElementById("report-number");
    number.textContent = new Intl.NumberFormat(undefined).format(stats.trackers);
    number.hidden = !stats.trackers;
    document.l10n.setAttributes(document.getElementById("report-text"), "newtab-report-summary", {
      trackers: stats.trackers,
      pages: stats.pages,
    });
    let chart = document.getElementById("report-chart");
    let max = Math.max(...stats.perDay, 1);
    chart.replaceChildren(
      ...stats.perDay.map((n, i) => {
        let bar = document.createElement("span");
        bar.className = "bar";
        bar.style.setProperty("--level", String(n / max));
        bar.toggleAttribute("today", i == stats.perDay.length - 1);
        return bar;
      })
    );
    document.l10n.setAttributes(document.getElementById("report-mode"), `newtab-report-mode-${PrivacyModes.mode}`);
  },

  // -- Importing bookmarks (the empty state) -----------------------------

  // The file other browsers export (HTML), as on about:bookmarks. Imported
  // bookmarks are never fetched for: letter tiles until visited.
  async _import() {
    let status = document.getElementById("import-status");
    let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let [title] = await document.l10n.formatValues(["newtab-import-title"]);
    picker.init(window.browsingContext, title, Ci.nsIFilePicker.modeOpen);
    picker.appendFilters(Ci.nsIFilePicker.filterHTML);
    let result = await new Promise(resolve => picker.open(resolve));
    if (result == Ci.nsIFilePicker.returnCancel) {
      return;
    }
    try {
      let count = await Library.importHTML(picker.file.path);
      await this.render();
      let stillEmpty = !document.querySelector("#favorites .favorites-empty").hidden;
      document.l10n.setAttributes(status, stillEmpty ? "newtab-imported-none-on-bar" : "newtab-imported", {
        count: count ?? 0,
      });
    } catch (e) {
      document.l10n.setAttributes(status, "newtab-import-failed");
    }
    status.hidden = false;
  },
};

// The Customize button: which sections show, and the background.
var Customize = {
  init(onChange) {
    this.onChange = onChange;
    this.button = document.getElementById("customize");
    this.panel = document.getElementById("customize-panel");
    this.button.addEventListener("click", () => this.toggle());
    for (let box of this.panel.querySelectorAll("input[data-section]")) {
      box.checked = Services.prefs.getBoolPref(SECTION_PREF(box.dataset.section), true);
      box.addEventListener("change", () => {
        Services.prefs.setBoolPref(SECTION_PREF(box.dataset.section), box.checked);
        this.onChange();
      });
    }
    for (let swatch of this.panel.querySelectorAll("[data-background]")) {
      swatch.addEventListener("click", () => {
        Services.prefs.setStringPref(BACKGROUND_PREF, swatch.dataset.background);
        this._applyBackground();
      });
    }
    this._applyBackground();
    document.addEventListener("click", e => {
      if (!this.panel.hidden && !this.panel.contains(e.target) && !this.button.contains(e.target)) {
        this.toggle(false);
      }
    });
    document.addEventListener("keydown", e => {
      if (e.key == "Escape" && !this.panel.hidden) {
        this.toggle(false);
        this.button.focus();
      }
    });
  },

  toggle(open = this.panel.hidden) {
    this.panel.hidden = !open;
    this.button.setAttribute("aria-expanded", String(open));
    if (open) {
      this.panel.querySelector("input").focus();
    }
  },

  _applyBackground() {
    let current = Services.prefs.getStringPref(BACKGROUND_PREF, "glow");
    document.body.dataset.background = current;
    for (let swatch of this.panel.querySelectorAll("[data-background]")) {
      swatch.setAttribute("aria-checked", String(swatch.dataset.background == current));
    }
  },
};

window.addEventListener("DOMContentLoaded", () => NewTab.init());
