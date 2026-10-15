/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Tab overview: every tab of the window as a card with a snapshot of its
 * page, over the page area. Opened from the button at the end of the tab
 * strip or Ctrl+Shift+A.
 *
 * Click a card (or Enter) to switch to its tab, × (or Delete) to close it,
 * the last card to add a tab (the overview stays open).
 * Typing filters by title and address. Escape, or a click on empty space,
 * closes the overview. Snapshots are taken fresh each time it opens; tabs
 * that have not loaded yet (restored ones) show their site's tile instead.
 */

const THUMB_WIDTH = 240;

var TabOverview = {
  init(window) {
    this.window = window;
    let $ = id => window.document.getElementById(id);
    this.overlay = $("tab-overview");
    this.grid = $("tab-overview-grid");
    this.search = $("tab-overview-search");
    this.count = $("tab-overview-count");
    this.button = $("tab-overview-button");

    this.search.addEventListener("input", () => this._filter());
    this.overlay.addEventListener("keydown", e => this._onKeyDown(e));
    this.overlay.addEventListener("click", e => {
      if (e.target == this.overlay || e.target == this.grid) {
        this.close();
      }
    });
    // The overview shows this window's tabs; keep it in step while open.
    for (let type of ["TabOpen", "TabClose", "TabMove"]) {
      gBrowser.tabContainer.addEventListener(type, () => {
        if (this.isOpen) {
          this._render();
        }
      });
    }
  },

  get isOpen() {
    return !this.overlay.hidden;
  },

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  open() {
    // Over the page area, below the toolbar and tab strip.
    let top = this.window.document.getElementById("browsers").getBoundingClientRect().top;
    this.overlay.style.setProperty("--overview-top", `${top}px`);
    this.overlay.hidden = false;
    this.button.setAttribute("open", "true");
    this.search.value = "";
    this._render();
    this.grid.querySelector(".overview-card[selected]")?.scrollIntoView({ block: "nearest" });
    this.search.focus();
  },

  close() {
    if (!this.isOpen) {
      return;
    }
    this.overlay.hidden = true;
    this.button.removeAttribute("open");
    this.grid.replaceChildren();
    gBrowser.selectedBrowser.focus();
  },

  _render() {
    let doc = this.window.document;
    this.grid.replaceChildren();
    for (let tab of gBrowser.tabs) {
      this.grid.append(this._card(tab));
    }
    let add = doc.createElement("button");
    add.className = "overview-card overview-new";
    doc.l10n.setAttributes(add, "tab-overview-new");
    let plus = doc.createElement("img");
    plus.className = "icon";
    plus.src = "chrome://browser-wip/skin/icons/plus.svg";
    plus.alt = "";
    add.append(plus);
    // The overview stays open; the new tab shows up as a card.
    add.addEventListener("click", () => {
      gBrowser.addTab(NEW_TAB_URL, { select: false });
      this.grid.querySelector(".overview-new")?.focus();
    });
    this.grid.append(add);
    this._filter();
  },

  _card(tab) {
    let doc = this.window.document;
    let card = doc.createElement("div");
    card.className = "overview-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.toggleAttribute("selected", tab == gBrowser.selectedTab);
    card.tab = tab;
    let browser = tab.linkedBrowser;
    let title = tab.querySelector(".tab-label").textContent;
    card.dataset.search = `${title} ${tab.pendingLoad?.url ?? browser.currentURI?.spec ?? ""}`.toLowerCase();
    card.setAttribute("aria-label", title);

    let thumb = doc.createElement("div");
    thumb.className = "overview-thumb";
    // The tab's own icon tile until (or instead of) the snapshot.
    let tile = tab.querySelector(".tab-icon").cloneNode(true);
    tile.classList.add("overview-tile");
    thumb.append(tile);
    this._snapshot(browser, thumb, tab);

    let info = doc.createElement("div");
    info.className = "overview-info";
    let icon = tab.querySelector(".tab-icon").cloneNode(true);
    let label = doc.createElement("span");
    label.className = "overview-title";
    label.textContent = title;
    info.append(icon, label);
    if (tab.hasAttribute("sharing") || tab.hasAttribute("soundplaying")) {
      let state = doc.createElement("img");
      state.className = "icon overview-state";
      state.src = tab.hasAttribute("sharing")
        ? tab.querySelector(".tab-state.sharing").src
        : "chrome://browser-wip/skin/icons/audio.svg";
      state.alt = "";
      info.append(state);
    }

    let close = doc.createElement("button");
    close.className = "overview-close";
    doc.l10n.setAttributes(close, "tab-overview-close");
    let x = doc.createElement("img");
    x.className = "icon";
    x.src = "chrome://browser-wip/skin/icons/close.svg";
    x.alt = "";
    close.append(x);
    close.addEventListener("click", e => {
      e.stopPropagation();
      gBrowser.removeTab(tab);
    });

    card.append(thumb, info, close);
    card.addEventListener("click", () => this._choose(tab));
    return card;
  },

  async _snapshot(browser, thumb, tab) {
    let global = browser.browsingContext?.currentWindowGlobal;
    if (tab.pendingLoad || !global || !browser.clientWidth) {
      return;
    }
    try {
      let width = browser.clientWidth;
      let height = browser.clientHeight;
      let scale = (THUMB_WIDTH * this.window.devicePixelRatio) / width;
      let bitmap = await global.drawSnapshot(new DOMRect(0, 0, width, height), scale, "white");
      if (!thumb.isConnected) {
        return;
      }
      let canvas = this.window.document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      thumb.replaceChildren(canvas);
    } catch (e) {
      // A page that is loading or gone keeps its tile.
    }
  },

  _choose(tab) {
    this.close();
    gBrowser.selectTab(tab);
  },

  _filter() {
    let terms = this.search.value.trim().toLowerCase();
    let shown = 0;
    for (let card of this.grid.querySelectorAll(".overview-card:not(.overview-new)")) {
      card.hidden = !!terms && !card.dataset.search.includes(terms);
      shown += card.hidden ? 0 : 1;
    }
    this.window.document.l10n.setAttributes(this.count, "tab-overview-count", {
      count: gBrowser.tabs.length,
      shown,
      filtered: terms ? "yes" : "no",
    });
  },

  _visibleCards() {
    return [...this.grid.querySelectorAll(".overview-card:not([hidden])")];
  },

  _onKeyDown(e) {
    let cards = this._visibleCards();
    let current = this.window.document.activeElement?.closest(".overview-card");
    switch (e.key) {
      case "Escape":
        this.close();
        break;
      case "Enter": {
        // From the search field: the first matching tab, if any.
        let card = current ?? cards.find(c => c.tab);
        if (card?.tab) {
          this._choose(card.tab);
        } else {
          card?.click();
        }
        break;
      }
      case "Delete":
        if (current?.tab) {
          // Closing re-renders the grid; then focus whatever took its place.
          let index = cards.indexOf(current);
          gBrowser.removeTab(current.tab).then(() => {
            let fresh = this._visibleCards();
            fresh[Math.min(index, fresh.length - 1)]?.focus();
          });
        } else {
          return;
        }
        break;
      case "ArrowRight":
      case "ArrowLeft":
      case "ArrowDown":
      case "ArrowUp": {
        if (!current) {
          if (e.key == "ArrowDown") {
            cards[0]?.focus();
            break;
          }
          return;
        }
        // Cards per row, from where the cards actually are.
        let top = cards[0].getBoundingClientRect().top;
        let perRow = cards.filter(c => c.getBoundingClientRect().top == top).length || 1;
        let step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[e.key];
        let index = cards.indexOf(current) + step;
        if (index < 0 && e.key == "ArrowUp") {
          this.search.focus();
        } else {
          cards[Math.max(0, Math.min(cards.length - 1, index))].focus();
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  },
};
