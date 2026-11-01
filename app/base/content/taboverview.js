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
 * Click a card (or Enter) to switch to its tab; × (Delete, or a middle
 * click) to close it; the last card to add a tab (the overview stays open).
 * Typing filters by title and address, from anywhere in the overview.
 * Escape, the close button, a click on empty space or on a tab in the tab
 * strip closes the overview.
 *
 * Snapshots are taken fresh each time it opens, at the cards' size and in
 * the page's own proportions; tabs that have not loaded yet (restored ones)
 * show their site's tile instead. While it is open, cards follow the tabs:
 * they come and go and slide to their new places rather than the grid being
 * redrawn.
 */

// How long cards take to slide, appear and leave (ms).
const OVERVIEW_MOVE_MS = 220;
const OVERVIEW_FADE_MS = 160;
const OVERVIEW_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

var TabOverview = {
  init(window) {
    this.window = window;
    let $ = id => window.document.getElementById(id);
    this.overlay = $("tab-overview");
    this.grid = $("tab-overview-grid");
    this.search = $("tab-overview-search");
    this.count = $("tab-overview-count");
    this.empty = $("tab-overview-empty");
    this.button = $("tab-overview-button");

    this.search.addEventListener("input", () => this._animateLayout(() => this._filter()));
    $("tab-overview-dismiss").addEventListener("click", () => this.close());
    this.overlay.addEventListener("keydown", e => this._onKeyDown(e));
    this.overlay.addEventListener("click", e => {
      if (e.target == this.overlay || e.target == this.grid || e.target == this.empty) {
        this.close();
      }
    });
    // Middle-click closes a tab, as in the tab strip.
    this.grid.addEventListener("auxclick", e => {
      let card = e.target.closest(".overview-card");
      if (e.button == 1 && card?.tab) {
        e.preventDefault();
        gBrowser.removeTab(card.tab);
      }
    });
    this.overlay.addEventListener("animationend", e => {
      if (e.target == this.overlay) {
        this.overlay.removeAttribute("opening");
      }
    });

    // While open, the cards follow this window's tabs.
    let tabs = gBrowser.tabContainer;
    tabs.addEventListener("TabOpen", e => this.isOpen && this._onTabOpen(e.target));
    tabs.addEventListener("TabClose", e => this.isOpen && this._onTabClose(e.target));
    tabs.addEventListener("TabMove", () => this.isOpen && this._animateLayout(() => this._reorder()));
    tabs.addEventListener("TabAttrModified", e => this.isOpen && this._refresh(e.target));
    // Clicking a tab in the strip goes to it: the strip has already selected
    // it, so the overview just gets out of the way.
    tabs.addEventListener("click", e => {
      if (this.isOpen && e.button == 0 && e.target.closest(".tab") && !e.target.closest(".tab-close")) {
        this.close();
      }
    });
    // A tab selected otherwise (closing the current one, from the keyboard)
    // moves the ring; the cards stay as they are.
    tabs.addEventListener("TabSelect", () => {
      for (let card of this.grid.querySelectorAll(".overview-card")) {
        card.toggleAttribute("selected", !!card.tab && card.tab == gBrowser.selectedTab);
      }
    });
    window.addEventListener("resize", () => this.isOpen && this._place());
  },

  get isOpen() {
    return !this.overlay.hidden;
  },

  get _reducedMotion() {
    return this.window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  },

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  open() {
    this._place();
    this.overlay.hidden = false;
    this.overlay.setAttribute("opening", "true");
    this.button.setAttribute("open", "true");
    this.search.value = "";
    this._render();
    this.grid.querySelector(".overview-card[selected]")?.scrollIntoView({ block: "center" });
    this.search.focus();
  },

  close() {
    if (!this.isOpen) {
      return;
    }
    this.overlay.hidden = true;
    this.overlay.removeAttribute("opening");
    this.button.removeAttribute("open");
    this.grid.replaceChildren();
    gBrowser.selectedBrowser.focus();
  },

  // Over the page area, below the toolbar and tab strip; snapshots in the
  // page's proportions, within reason.
  _place() {
    let rect = this.window.document.getElementById("browsers").getBoundingClientRect();
    this.overlay.style.setProperty("--overview-top", `${rect.top}px`);
    let ratio = rect.height > 0 ? Math.min(Math.max(rect.width / rect.height, 1.25), 2.1) : 1.6;
    this.overlay.style.setProperty("--overview-thumb-ratio", String(ratio));
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
    let label = doc.createElement("span");
    doc.l10n.setAttributes(label, "tab-overview-new-label");
    add.append(plus, label);
    // The overview stays open; the new tab shows up as a card.
    add.addEventListener("click", () => {
      gBrowser.addTab(NEW_TAB_URL, { select: false });
      this.grid.querySelector(".overview-new")?.focus();
    });
    this.grid.append(add);
    this._filter();
    // Snapshots once the cards have their size.
    for (let card of this.grid.querySelectorAll(".overview-card")) {
      if (card.tab) {
        this._snapshot(card);
      }
    }
  },

  _card(tab) {
    let doc = this.window.document;
    let card = doc.createElement("div");
    card.className = "overview-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.toggleAttribute("selected", tab == gBrowser.selectedTab);
    card.tab = tab;

    let thumb = doc.createElement("div");
    thumb.className = "overview-thumb";
    let badges = doc.createElement("div");
    badges.className = "overview-badges";
    thumb.append(badges);

    let info = doc.createElement("div");
    info.className = "overview-info";
    let label = doc.createElement("span");
    label.className = "overview-title";
    let close = doc.createElement("button");
    close.className = "overview-close";
    close.tabIndex = -1;
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
    info.append(label, close);

    card.append(thumb, info);
    card.addEventListener("click", () => this._choose(tab));
    this._refresh(tab, card);
    return card;
  },

  _cardFor(tab) {
    return [...this.grid.querySelectorAll(".overview-card")].find(c => c.tab == tab) ?? null;
  },

  // Title, icon, tile and badges, from the tab as it is now.
  _refresh(tab, card = this._cardFor(tab)) {
    if (!card) {
      return;
    }
    let doc = this.window.document;
    let title = tab.querySelector(".tab-label").textContent;
    let url = tab.pendingLoad?.url ?? tab.linkedBrowser.currentURI?.spec ?? "";
    card.dataset.search = `${title} ${url}`.toLowerCase();
    card.setAttribute("aria-label", title);
    card.querySelector(".overview-title").textContent = title;
    let info = card.querySelector(".overview-info");
    info.querySelector(".tab-icon")?.remove();
    info.prepend(tab.querySelector(".tab-icon").cloneNode(true));

    let thumb = card.querySelector(".overview-thumb");
    if (!thumb.querySelector("canvas")) {
      // The tab's own icon tile until (or instead of) the snapshot.
      thumb.querySelector(".overview-tile")?.remove();
      let tile = tab.querySelector(".tab-icon").cloneNode(true);
      tile.classList.add("overview-tile");
      thumb.prepend(tile);
    }

    let badges = card.querySelector(".overview-badges");
    badges.replaceChildren();
    let badge = (icon, l10n, kind) => {
      let el = doc.createElement("span");
      el.className = `overview-badge ${kind}`;
      doc.l10n.setAttributes(el, l10n);
      let img = doc.createElement("img");
      img.className = "icon";
      img.src = icon;
      img.alt = "";
      el.append(img);
      badges.append(el);
    };
    if (tab.hasAttribute("sharing")) {
      badge(tab.querySelector(".tab-state.sharing").src, "tab-overview-badge-sharing", "sharing");
    }
    if (tab.hasAttribute("muted")) {
      badge("chrome://browser-wip/skin/icons/muted.svg", "tab-overview-badge-muted", "audio");
    } else if (tab.hasAttribute("soundplaying")) {
      badge("chrome://browser-wip/skin/icons/audio.svg", "tab-overview-badge-audio", "audio");
    }
  },

  async _snapshot(card) {
    let tab = card.tab;
    let browser = tab.linkedBrowser;
    let thumb = card.querySelector(".overview-thumb");
    let global = browser.browsingContext?.currentWindowGlobal;
    if (tab.pendingLoad || !global || !browser.clientWidth) {
      return;
    }
    thumb.setAttribute("loading", "true");
    try {
      let width = browser.clientWidth;
      let height = browser.clientHeight;
      // As sharp as the card is wide.
      let target = Math.max(thumb.clientWidth, 240) * this.window.devicePixelRatio;
      let bitmap = await global.drawSnapshot(new DOMRect(0, 0, width, height), Math.min(1, target / width), "white");
      if (!thumb.isConnected) {
        bitmap.close();
        return;
      }
      let canvas = this.window.document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close();
      thumb.querySelector(".overview-tile")?.remove();
      thumb.prepend(canvas);
    } catch (e) {
      // A page that is loading or gone keeps its tile.
    } finally {
      thumb.removeAttribute("loading");
    }
  },

  _choose(tab) {
    this.close();
    gBrowser.selectTab(tab);
  },

  // -- Following the tabs while open ---------------------------------------

  _onTabOpen(tab) {
    let card = this._card(tab);
    this._animateLayout(() => {
      this._insertInOrder(card);
      this._filter();
    });
    this._snapshot(card);
  },

  _onTabClose(tab) {
    let card = this._cardFor(tab);
    if (!card) {
      return;
    }
    // Out of the grid's flow at once (and no longer a card), so the others
    // slide into its place while it fades where it was.
    this._animateLayout(() => {
      let { offsetLeft, offsetTop, offsetWidth, offsetHeight } = card;
      card.classList.replace("overview-card", "overview-leaving");
      card.removeAttribute("tabindex");
      Object.assign(card.style, {
        left: `${offsetLeft}px`,
        top: `${offsetTop}px`,
        width: `${offsetWidth}px`,
        height: `${offsetHeight}px`,
      });
      this._filter();
    });
    if (this._reducedMotion) {
      card.remove();
      return;
    }
    card
      .animate([{ opacity: 1 }, { opacity: 0, transform: "scale(0.92)" }], {
        duration: OVERVIEW_FADE_MS,
        easing: "ease-in",
        fill: "forwards",
      })
      .finished.then(
        () => card.remove(),
        () => card.remove()
      );
  },

  _insertInOrder(card) {
    let index = gBrowser.tabs.indexOf(card.tab);
    let next = gBrowser.tabs.slice(index + 1).map(t => this._cardFor(t)).find(Boolean);
    this.grid.insertBefore(card, next ?? this.grid.querySelector(".overview-new"));
  },

  _reorder() {
    let add = this.grid.querySelector(".overview-new");
    for (let tab of gBrowser.tabs) {
      let card = this._cardFor(tab);
      if (card) {
        this.grid.insertBefore(card, add);
      }
    }
  },

  // Runs `change`, then moves every card from where it was to where it is
  // now, and fades in cards that weren't shown before.
  _animateLayout(change) {
    if (this._reducedMotion || !this.isOpen) {
      change();
      return;
    }
    let cards = [...this.grid.querySelectorAll(".overview-card")];
    let before = new Map();
    for (let card of cards) {
      if (!card.hidden) {
        before.set(card, card.getBoundingClientRect());
      }
    }
    change();
    for (let card of this.grid.querySelectorAll(".overview-card:not([hidden])")) {
      let was = before.get(card);
      if (!was) {
        card.animate([{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }], {
          duration: OVERVIEW_FADE_MS,
          easing: OVERVIEW_EASING,
        });
        continue;
      }
      let now = card.getBoundingClientRect();
      let dx = was.left - now.left;
      let dy = was.top - now.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
          duration: OVERVIEW_MOVE_MS,
          easing: OVERVIEW_EASING,
        });
      }
    }
  },

  // -- Search ---------------------------------------------------------------

  _filter() {
    let doc = this.window.document;
    let query = this.search.value.trim();
    let terms = query.toLowerCase();
    let shown = 0;
    for (let card of this.grid.querySelectorAll(".overview-card:not(.overview-new)")) {
      card.hidden = !!terms && !card.dataset.search.includes(terms);
      shown += card.hidden ? 0 : 1;
    }
    // Adding a tab is beside the point while searching.
    let add = this.grid.querySelector(".overview-new");
    if (add) {
      add.hidden = !!terms;
    }
    this.empty.hidden = !terms || shown > 0;
    if (!this.empty.hidden) {
      doc.l10n.setAttributes(this.empty, "tab-overview-no-match", { query });
    }
    doc.l10n.setAttributes(this.count, "tab-overview-count", {
      count: gBrowser.tabs.filter(t => !t.closing).length,
      shown,
      filtered: terms ? "yes" : "no",
    });
  },

  // -- Keyboard -------------------------------------------------------------

  _visibleCards() {
    return [...this.grid.querySelectorAll(".overview-card:not([hidden])")];
  },

  _onKeyDown(e) {
    let cards = this._visibleCards();
    let current = this.window.document.activeElement?.closest(".overview-card");
    switch (e.key) {
      case "Escape":
        // A search is cleared first.
        if (this.search.value && this.window.document.activeElement == this.search) {
          this.search.value = "";
          this._animateLayout(() => this._filter());
        } else {
          this.close();
        }
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
          // Then focus whatever took its place.
          let index = cards.indexOf(current);
          gBrowser.removeTab(current.tab).then(() => {
            let fresh = this._visibleCards();
            fresh[Math.min(index, fresh.length - 1)]?.focus();
          });
        } else {
          return;
        }
        break;
      case "Home":
      case "End":
        if (!current) {
          return;
        }
        (e.key == "Home" ? cards[0] : cards.at(-1))?.focus();
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
        let perRow = cards.filter(c => Math.abs(c.getBoundingClientRect().top - top) < 1).length || 1;
        let rtl = this.window.getComputedStyle(this.grid).direction == "rtl";
        let step = {
          ArrowRight: rtl ? -1 : 1,
          ArrowLeft: rtl ? 1 : -1,
          ArrowDown: perRow,
          ArrowUp: -perRow,
        }[e.key];
        let index = cards.indexOf(current) + step;
        if (index < 0 && e.key == "ArrowUp") {
          this.search.focus();
        } else {
          let next = cards[Math.max(0, Math.min(cards.length - 1, index))];
          next.focus();
          next.scrollIntoView({ block: "nearest" });
        }
        break;
      }
      case "Tab": {
        // Focus stays in the overview while it is open.
        let order = [this.search, this.window.document.getElementById("tab-overview-dismiss"), ...cards];
        let at = order.indexOf(current ?? this.window.document.activeElement);
        let next = order[(at + (e.shiftKey ? -1 : 1) + order.length) % order.length];
        next.focus();
        break;
      }
      default:
        // Typing on a card searches.
        if (current && e.key.length == 1 && !e.ctrlKey && !e.altKey && !e.metaKey && e.key != " ") {
          this.search.focus();
        }
        return;
    }
    e.preventDefault();
  },
};
