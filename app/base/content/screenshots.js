/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Screenshots of the selected tab's page, as Firefox takes them: Ctrl+Shift+S,
 * the app menu or the page's context menu. An overlay covers the page:
 *   choosing  drag to select an area, or click the element under the
 *             pointer (it's outlined); or Save visible / Save full page
 *   selected  the area, which can be moved and resized, with Copy and
 *             Download under it
 *   preview   the visible part or the full page, with Copy and Download
 * Escape, or the close button, leaves.
 *
 * The page asks for nothing and sees nothing: the overlay is in the window,
 * over the page, which the ScreenshotsChild actor only measures (its size,
 * scroll position, the element at a point). The pixels come from
 * WindowGlobalParent.drawSnapshot, which renders frames from every process.
 * Downloads go where downloads go (Settings › Downloads) and show in the
 * downloads panel; Copy puts a PNG on the clipboard.
 */

var Screenshots = {
  // drawSnapshot renders at most this many CSS pixels a side at a time.
  TILE: 1024,
  // What a canvas can hold, as Firefox's screenshots limit it.
  MAX_DIMENSION: 32766,
  MAX_AREA: 472907776,
  // Smaller than this, a drag is a click.
  MIN_DRAG: 8,

  lazy: {},

  init() {
    ChromeUtils.defineESModuleGetters(this.lazy, {
      BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
      DownloadPaths: "resource://gre/modules/DownloadPaths.sys.mjs",
      Downloads: "resource://gre/modules/Downloads.sys.mjs",
      FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => this.close());
    gBrowser.tabContainer.addEventListener("TabLocationChange", e => {
      if (e.target == this._tab && !e.detail?.sameDocument) {
        this.close();
      }
    });
    window.addEventListener("resize", () => this.close());
  },

  get isOpen() {
    return !!this.overlay;
  },

  _actor(browser = this._browser) {
    return browser.browsingContext.currentWindowGlobal.getActor("Screenshots");
  },

  /** Opens the overlay over the selected tab's page, or closes it. */
  async toggle() {
    if (this.isOpen) {
      this.close();
      return;
    }
    let browser = gBrowser.selectedBrowser;
    let page;
    try {
      page = await this._actor(browser).sendQuery("Screenshots:Page");
    } catch (e) {
      this.toast("screenshots-unavailable");
      return;
    }
    if (gBrowser.selectedBrowser != browser || this.isOpen) {
      return;
    }
    clearTimeout(this._toastTimer);
    document.getElementById("screenshots-toast").hidden = true;
    this._browser = browser;
    this._tab = gBrowser.selectedTab;
    this._page = page;
    this._build();
    this._choose();
  },

  close() {
    if (!this.overlay) {
      return;
    }
    this.overlay.remove();
    this.overlay = null;
    this._selection = null;
    if (this._preview?.url) {
      URL.revokeObjectURL(this._preview.url);
    }
    this._preview = null;
    this._browser?.focus();
  },

  // ---------------------------------------------------------------------
  // The overlay

  _build() {
    let doc = document;
    let el = (tag, props = {}, l10n) => {
      let node = doc.createElement(tag);
      Object.assign(node, props);
      if (l10n) {
        doc.l10n.setAttributes(node, l10n);
      }
      return node;
    };
    let button = (id, l10n, primary) =>
      el("button", { type: "button", className: "panel-button screenshots-button" + (primary ? " primary" : ""), id }, l10n);

    this.overlay = el("div", { id: "screenshots-overlay", tabIndex: -1 });
    this.overlay.setAttribute("role", "dialog");
    doc.l10n.setAttributes(this.overlay, "screenshots-overlay");
    this.dim = el("div", { className: "screenshots-dim" });
    this.hover = el("div", { className: "screenshots-hover", hidden: true });
    this.box = el("div", { className: "screenshots-box", hidden: true });
    for (let handle of ["n", "e", "s", "w", "ne", "nw", "se", "sw"]) {
      this.box.append(el("div", { className: `screenshots-handle ${handle}` }));
      this.box.lastChild.dataset.handle = handle;
    }
    this.size = el("span", { className: "screenshots-size" });
    this.box.append(this.size);

    let close = button("screenshots-close", "screenshots-close");
    close.append(el("img", { className: "icon", src: "chrome://browser-wip/skin/icons/close.svg", alt: "" }));
    this.bar = el("div", { className: "screenshots-bar" });
    this.bar.append(
      el("span", { className: "screenshots-hint" }, "screenshots-hint"),
      button("screenshots-visible", "screenshots-save-visible"),
      button("screenshots-full", "screenshots-save-full"),
      close
    );
    this.actions = el("div", { className: "screenshots-actions", hidden: true });
    this.actions.append(
      button("screenshots-cancel", "screenshots-cancel"),
      button("screenshots-copy", "screenshots-copy"),
      button("screenshots-download", "screenshots-download", true)
    );
    this.previewCard = el("div", { className: "screenshots-preview", hidden: true });
    this.previewImage = el("img", { className: "screenshots-preview-image", alt: "" });
    this.previewNote = el("p", { className: "screenshots-preview-note", hidden: true });
    let previewButtons = el("div", { className: "screenshots-preview-buttons" });
    previewButtons.append(
      button("screenshots-retry", "screenshots-retry"),
      el("span", { className: "screenshots-spacer" }),
      button("screenshots-preview-copy", "screenshots-copy"),
      button("screenshots-preview-download", "screenshots-download", true)
    );
    this.previewCard.append(this.previewImage, this.previewNote, previewButtons);
    this.overlay.append(this.dim, this.hover, this.box, this.bar, this.actions, this.previewCard);

    let $ = id => this.overlay.querySelector("#" + id);
    $("screenshots-close").addEventListener("click", () => this.close());
    $("screenshots-cancel").addEventListener("click", () => this._choose());
    $("screenshots-retry").addEventListener("click", () => this._choose());
    $("screenshots-visible").addEventListener("click", () => this._showPreview("visible"));
    $("screenshots-full").addEventListener("click", () => this._showPreview("full"));
    $("screenshots-copy").addEventListener("click", () => this._finish("copy"));
    $("screenshots-download").addEventListener("click", () => this._finish("download"));
    $("screenshots-preview-copy").addEventListener("click", () => this._finish("copy"));
    $("screenshots-preview-download").addEventListener("click", () => this._finish("download"));

    this.overlay.addEventListener("pointerdown", this);
    this.overlay.addEventListener("pointermove", this);
    this.overlay.addEventListener("pointerup", this);
    this.overlay.addEventListener("wheel", this, { passive: false });
    this.overlay.addEventListener("keydown", this);
    // Over the selected page only (not a docked toolbox, not the other page
    // of a split view).
    this._browser.closest(".browserStack").append(this.overlay);
    this.overlay.focus();
  },

  // Drag to select, or hover and click an element.
  _choose() {
    this.overlay.setAttribute("state", "choosing");
    this._selection = null;
    this._drag = null;
    this.box.hidden = true;
    this.actions.hidden = true;
    this.previewCard.hidden = true;
    this.bar.hidden = false;
    this.dim.hidden = false;
    this.overlay.focus();
  },

  _select(rect) {
    let bounds = this.overlay.getBoundingClientRect();
    let left = Math.max(0, Math.min(rect.left, bounds.width));
    let top = Math.max(0, Math.min(rect.top, bounds.height));
    let right = Math.max(left, Math.min(rect.left + rect.width, bounds.width));
    let bottom = Math.max(top, Math.min(rect.top + rect.height, bounds.height));
    this._selection = { left, top, width: right - left, height: bottom - top };
    this.overlay.setAttribute("state", "selected");
    this.hover.hidden = true;
    this.bar.hidden = true;
    this.dim.hidden = true;
    this.box.hidden = false;
    this.actions.hidden = false;
    this._layoutSelection();
  },

  _layoutSelection() {
    let { left, top, width, height } = this._selection;
    Object.assign(this.box.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    this.size.textContent = `${Math.round(width)} × ${Math.round(height)}`;
    // Under the area, or over it at the bottom of the page.
    let bounds = this.overlay.getBoundingClientRect();
    let barHeight = this.actions.getBoundingClientRect().height || 40;
    let below = top + height + 8 + barHeight <= bounds.height;
    this.actions.style.top = `${below ? top + height + 8 : Math.max(8, top + height - barHeight - 8)}px`;
    this.actions.style.left = `${Math.max(8, Math.min(left + width, bounds.width - 8))}px`;
  },

  handleEvent(e) {
    let state = this.overlay?.getAttribute("state");
    switch (e.type) {
      case "keydown":
        if (e.key == "Escape") {
          e.preventDefault();
          if (state == "choosing") {
            this.close();
          } else {
            this._choose();
          }
        } else if (e.key == "Enter" && state != "choosing") {
          e.preventDefault();
          this._finish("download");
        } else if ((e.ctrlKey || e.metaKey) && e.key == "c" && state != "choosing") {
          e.preventDefault();
          this._finish("copy");
        }
        break;
      case "wheel":
        // The page scrolls under the overlay while choosing.
        e.preventDefault();
        if (state == "choosing") {
          this._scroll(e.deltaX, e.deltaY, e.deltaMode);
        }
        break;
      case "pointerdown":
        this._onPointerDown(e, state);
        break;
      case "pointermove":
        this._onPointerMove(e, state);
        break;
      case "pointerup":
        this._onPointerUp(e, state);
        break;
    }
  },

  _point(e) {
    let bounds = this.overlay.getBoundingClientRect();
    return { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
  },

  _onPointerDown(e, state) {
    if (e.button != 0 || e.target.closest("button, .screenshots-bar, .screenshots-actions, .screenshots-preview")) {
      return;
    }
    let { x, y } = this._point(e);
    if (state == "choosing") {
      this._drag = { mode: "new", x, y, moved: false };
    } else if (state == "selected") {
      let handle = e.target.dataset?.handle;
      let inside = e.target == this.box || this.box.contains(e.target);
      if (!handle && !inside) {
        // A new area, from here.
        this._drag = { mode: "new", x, y, moved: true };
        this.overlay.setAttribute("state", "choosing");
        this.box.hidden = false;
        this.actions.hidden = true;
      } else {
        this._drag = { mode: handle ?? "move", x, y, start: { ...this._selection }, moved: true };
      }
    } else {
      return;
    }
    this.overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  },

  _onPointerMove(e, state) {
    let { x, y } = this._point(e);
    let drag = this._drag;
    if (!drag) {
      if (state == "choosing") {
        this._hoverAt(x, y);
      }
      return;
    }
    if (drag.mode == "new") {
      if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < this.MIN_DRAG) {
        return;
      }
      drag.moved = true;
      this.hover.hidden = true;
      this.dim.hidden = true;
      this.box.hidden = false;
      this._selection = {
        left: Math.min(x, drag.x),
        top: Math.min(y, drag.y),
        width: Math.abs(x - drag.x),
        height: Math.abs(y - drag.y),
      };
      this._layoutSelection();
      return;
    }
    let bounds = this.overlay.getBoundingClientRect();
    let dx = x - drag.x;
    let dy = y - drag.y;
    let { left, top, width, height } = drag.start;
    let right = left + width;
    let bottom = top + height;
    if (drag.mode == "move") {
      left = Math.max(0, Math.min(left + dx, bounds.width - width));
      top = Math.max(0, Math.min(top + dy, bounds.height - height));
      right = left + width;
      bottom = top + height;
    } else {
      if (drag.mode.includes("w")) {
        left = Math.max(0, Math.min(left + dx, right - this.MIN_DRAG));
      }
      if (drag.mode.includes("e")) {
        right = Math.min(bounds.width, Math.max(right + dx, left + this.MIN_DRAG));
      }
      if (drag.mode.includes("n")) {
        top = Math.max(0, Math.min(top + dy, bottom - this.MIN_DRAG));
      }
      if (drag.mode.includes("s")) {
        bottom = Math.min(bounds.height, Math.max(bottom + dy, top + this.MIN_DRAG));
      }
    }
    this._selection = { left, top, width: right - left, height: bottom - top };
    this._layoutSelection();
  },

  async _onPointerUp(e) {
    let drag = this._drag;
    if (!drag) {
      return;
    }
    this._drag = null;
    if (drag.mode != "new") {
      this._layoutSelection();
      return;
    }
    if (drag.moved && this._selection?.width >= this.MIN_DRAG && this._selection?.height >= this.MIN_DRAG) {
      this._select(this._selection);
      return;
    }
    // A click: the element there, if any.
    let rect = this._hoverRect;
    if (rect) {
      this._select(rect);
    } else {
      this._choose();
    }
  },

  // Outlines what a click would capture. The page answers asynchronously;
  // only the latest answer counts.
  async _hoverAt(x, y) {
    let ask = (this._hoverAsk = (this._hoverAsk ?? 0) + 1);
    let rect = null;
    try {
      rect = await this._actor().sendQuery("Screenshots:ElementAt", { x, y });
    } catch (e) {}
    if (ask != this._hoverAsk || this.overlay?.getAttribute("state") != "choosing" || this._drag?.moved) {
      return;
    }
    this._hoverRect = this._validRect(rect);
    this.hover.hidden = !this._hoverRect;
    if (this._hoverRect) {
      let { left, top, width, height } = this._hoverRect;
      Object.assign(this.hover.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    }
  },

  // A rectangle from the page, if it is one, within the overlay.
  _validRect(rect) {
    let numbers = rect && ["left", "top", "width", "height"].every(k => Number.isFinite(rect[k]));
    if (!numbers || rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    let bounds = this.overlay.getBoundingClientRect();
    let left = Math.max(0, Math.min(rect.left, bounds.width));
    let top = Math.max(0, Math.min(rect.top, bounds.height));
    let width = Math.min(rect.width, bounds.width - left);
    let height = Math.min(rect.height, bounds.height - top);
    return width > 0 && height > 0 ? { left, top, width, height } : null;
  },

  async _scroll(dx, dy, mode) {
    let line = 40;
    let factor = mode == WheelEvent.DOM_DELTA_LINE ? line : mode == WheelEvent.DOM_DELTA_PAGE ? this._page.height : 1;
    try {
      this._page = await this._actor().sendQuery("Screenshots:Scroll", { x: dx * factor, y: dy * factor });
    } catch (e) {}
    this.hover.hidden = true;
    this._hoverRect = null;
  },

  // ---------------------------------------------------------------------
  // Capturing

  // The page's size and scroll position now, in bounded numbers.
  async _measure() {
    let page = await this._actor().sendQuery("Screenshots:Page");
    let n = (value, max) => (Number.isFinite(value) ? Math.max(0, Math.min(value, max)) : 0);
    return {
      scrollX: n(page.scrollX, 1e7),
      scrollY: n(page.scrollY, 1e7),
      width: n(page.width, 1e5) || this.overlay.clientWidth,
      height: n(page.height, 1e5) || this.overlay.clientHeight,
      pageWidth: n(page.pageWidth, 1e7),
      pageHeight: n(page.pageHeight, 1e7),
      title: String(page.title ?? "").slice(0, 200),
    };
  },

  /**
   * The region to capture, in the page's CSS pixels: the selection, the
   * visible part, or the whole page. { left, top, width, height, cropped }.
   */
  async _region(kind) {
    let page = await this._measure();
    this._page = page;
    let region;
    if (kind == "full") {
      region = { left: 0, top: 0, width: page.pageWidth, height: page.pageHeight };
    } else if (kind == "visible") {
      region = { left: page.scrollX, top: page.scrollY, width: page.width, height: page.height };
    } else {
      let s = this._selection;
      region = { left: page.scrollX + s.left, top: page.scrollY + s.top, width: s.width, height: s.height };
    }
    for (let key of ["left", "top", "width", "height"]) {
      region[key] = Math.round(region[key]);
    }
    // What a canvas can hold: a very long page is cut at the bottom.
    let scale = this._scale();
    let cropped = false;
    if (region.width * scale > this.MAX_DIMENSION) {
      region.width = Math.floor(this.MAX_DIMENSION / scale);
      cropped = true;
    }
    let maxHeight = Math.floor(Math.min(this.MAX_DIMENSION, this.MAX_AREA / (region.width * scale)) / scale);
    if (region.height > maxHeight) {
      region.height = maxHeight;
      cropped = true;
    }
    region.cropped = cropped;
    return region;
  },

  _scale() {
    return window.devicePixelRatio || 1;
  },

  /** The region as a PNG Blob, drawn tile by tile, as Firefox does. */
  async _capture(region) {
    let scale = this._scale();
    let canvas = new OffscreenCanvas(Math.max(1, region.width * scale), Math.max(1, region.height * scale));
    let context = canvas.getContext("2d");
    context.fillStyle = "rgb(255,255,255)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    let windowGlobal = this._browser.browsingContext.currentWindowGlobal;
    let tile = this.TILE;
    let tilePixels = Math.floor(tile * scale);
    for (let x = region.left; x < region.left + region.width; x += tile) {
      for (let y = region.top; y < region.top + region.height; y += tile) {
        let width = Math.min(tile, region.left + region.width - x);
        let height = Math.min(tile, region.top + region.height - y);
        let snapshot = await windowGlobal.drawSnapshot(new DOMRect(x, y, width, height), scale, "rgb(255,255,255)");
        // Tiles start on multiples of the tile's pixel size, or a fractional
        // scale leaves lines between them.
        let left = Math.floor((x - region.left) * scale);
        let top = Math.floor((y - region.top) * scale);
        context.drawImage(
          snapshot,
          left - (left % tilePixels),
          top - (top % tilePixels),
          Math.floor(width * scale),
          Math.floor(height * scale)
        );
        snapshot.close();
      }
    }
    return canvas.convertToBlob({ type: "image/png" });
  },

  // Save visible / Save full page: captured now, shown before saving.
  async _showPreview(kind) {
    this.overlay.setAttribute("state", "preview");
    this.bar.hidden = true;
    this.hover.hidden = true;
    this.dim.hidden = false;
    let region, blob;
    try {
      region = await this._region(kind);
      blob = await this._capture(region);
    } catch (e) {
      console.error("browser-wip: screenshot failed", e);
      this.close();
      this.toast("screenshots-failed");
      return;
    }
    if (!this.overlay) {
      return;
    }
    if (this._preview?.url) {
      URL.revokeObjectURL(this._preview.url);
    }
    this._preview = { blob, url: URL.createObjectURL(blob), cropped: region.cropped };
    this.previewImage.src = this._preview.url;
    this.previewNote.hidden = !region.cropped;
    document.l10n.setAttributes(this.previewNote, "screenshots-cropped");
    this.previewCard.hidden = false;
    this.overlay.querySelector("#screenshots-preview-download").focus();
  },

  /** Copy or download what's selected or previewed, then leave. */
  async _finish(action) {
    let state = this.overlay?.getAttribute("state");
    if (state != "selected" && !(state == "preview" && this._preview)) {
      return;
    }
    let blob = this._preview?.blob;
    let cropped = this._preview?.cropped;
    try {
      if (!blob) {
        let region = await this._region("selection");
        blob = await this._capture(region);
        cropped = region.cropped;
      }
    } catch (e) {
      console.error("browser-wip: screenshot failed", e);
      this.close();
      this.toast("screenshots-failed");
      return;
    }
    let title = this._page?.title;
    let browser = this._browser;
    this.close();
    if (action == "copy") {
      this.lazy.BrowserUtils.copyImageToClipboard(await blob.arrayBuffer());
      this.toast(cropped ? "screenshots-copied-cropped" : "screenshots-copied");
    } else {
      let saved = await this._download(blob, title, browser);
      if (saved) {
        this.toast("screenshots-saved", { name: saved });
      }
    }
  },

  // "Screenshot 2026-11-21 at 14-03-22 Page title.png", where downloads go,
  // through the downloads list (so the downloads panel shows it).
  async _download(blob, title, browser) {
    let { Downloads, DownloadPaths, FileUtils } = this.lazy;
    let now = new Date();
    let pad = n => String(n).padStart(2, "0");
    let stamp =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} at ` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    let [prefix] = await document.l10n.formatValues([{ id: "screenshots-file-name", args: { stamp } }]);
    let name = DownloadPaths.sanitize(`${prefix}${title ? " " + title : ""}`).slice(0, 200) + ".png";
    let file;
    if (Services.prefs.getBoolPref("browser.download.useDownloadDir", true)) {
      file = new FileUtils.File(PathUtils.join(await Downloads.getPreferredDownloadsDirectory(), name));
      file = DownloadPaths.createNiceUniqueFile(file);
    } else {
      // Settings › Downloads › Ask where to save each file.
      let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      let [pickerTitle] = await document.l10n.formatValues(["screenshots-picker-title"]);
      picker.init(window.browsingContext, pickerTitle, Ci.nsIFilePicker.modeSave);
      picker.defaultString = name;
      picker.appendFilter("PNG", "*.png");
      let result = await new Promise(resolve => picker.open(resolve));
      if (result == Ci.nsIFilePicker.returnCancel) {
        return null;
      }
      file = picker.file;
    }
    let isPrivate = PrivateBrowsingUtils.isBrowserPrivate(browser);
    let url = URL.createObjectURL(blob);
    try {
      let download = await Downloads.createDownload({ source: { url, isPrivate }, target: file });
      let list = await Downloads.getList(isPrivate ? Downloads.PRIVATE : Downloads.PUBLIC);
      list.add(download);
      await download.start();
      return file.leafName;
    } catch (e) {
      console.error("browser-wip: saving the screenshot failed", e);
      this.toast("screenshots-failed");
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  /** A short message over the page that goes by itself. */
  toast(l10nId, args) {
    let toast = document.getElementById("screenshots-toast");
    document.l10n.setAttributes(toast, l10nId, args);
    toast.hidden = false;
    toast.classList.remove("leaving");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.add("leaving");
      this._toastTimer = setTimeout(() => (toast.hidden = true), 200);
    }, 3000);
  },
};
