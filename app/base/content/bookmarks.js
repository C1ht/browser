/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Bookmarks in the window: the star in the address field (Ctrl+D) with its
 * panel, and the bookmarks bar under the toolbar (Ctrl+Shift+B). Both stay
 * in step with Places, whichever window or page changed it. about:bookmarks
 * manages them all.
 */

const BookmarksLib = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");
const BOOKMARK_EVENTS = [
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-title-changed",
  "bookmark-url-changed",
];

var BookmarksUI = {
  init(window) {
    this.window = window;
    let doc = window.document;
    let $ = id => doc.getElementById(id);
    this.$ = $;
    this.star = $("star-button");
    this.panel = $("bookmark-panel");
    this.bar = $("bookmarks-bar");
    this.items = $("bookmarks-bar-items");
    this.overflow = $("bookmarks-bar-overflow");
    this.context = $("bookmarks-context-menu");
    this.Library = BookmarksLib.Library;

    this.star.addEventListener("click", () => this.bookmarkPage());
    $("bookmark-panel-done").addEventListener("click", () => this.panel.hidePopup());
    $("bookmark-panel-remove").addEventListener("click", () => this._removeEdited());
    $("bookmark-panel-form").addEventListener("submit", e => {
      e.preventDefault();
      this.panel.hidePopup();
    });
    this.panel.addEventListener("popuphidden", e => {
      if (e.target == this.panel) {
        this._saveEdited().catch(console.error);
      }
    });

    // The bar: clicks open, a middle click or Ctrl+click opens in a tab.
    this.items.addEventListener("click", e => this._onItemClick(e));
    this.items.addEventListener("auxclick", e => this._onItemClick(e));
    this.items.addEventListener("contextmenu", e => this._onContextMenu(e));
    this.overflow.addEventListener("click", () => this._openOverflow());
    $("bookmarks-bar-manage").addEventListener("click", () => this.openManager("bookmarks"));
    this.context.addEventListener("command", e => this._onContextCommand(e));
    new window.ResizeObserver(() => this._layoutOverflow()).observe(this.items);

    this._observer = events => this._onPlacesEvents(events);
    PlacesUtils.observers.addListener(BOOKMARK_EVENTS, this._observer);
    this._prefObserver = () => this._syncBar();
    Services.prefs.addObserver(BookmarksLib.BAR_PREF, this._prefObserver);
    window.addEventListener(
      "unload",
      () => {
        PlacesUtils.observers.removeListener(BOOKMARK_EVENTS, this._observer);
        Services.prefs.removeObserver(BookmarksLib.BAR_PREF, this._prefObserver);
      },
      { once: true }
    );

    gBrowser.tabContainer.addEventListener("TabSelect", () => this.updateStar());
    gBrowser.tabContainer.addEventListener("TabLocationChange", e => {
      if (e.target == gBrowser.selectedTab) {
        this.updateStar();
      }
    });
    this._syncBar();
  },

  get barVisible() {
    return Services.prefs.getBoolPref(BookmarksLib.BAR_PREF, false);
  },

  toggleBar() {
    Services.prefs.setBoolPref(BookmarksLib.BAR_PREF, !this.barVisible);
  },

  openManager(page) {
    let url = `about:${page}`;
    let existing = gBrowser.tabs.find(t => t.linkedBrowser.currentURI?.spec.startsWith(url));
    if (existing) {
      gBrowser.selectTab(existing);
    } else {
      gBrowser.addTab(url);
    }
  },

  // -----------------------------------------------------------------------
  // The star

  _pageURL() {
    let uri = gBrowser.selectedBrowser?.currentURI;
    return uri && /^https?$/.test(uri.scheme) ? uri.spec : null;
  },

  async updateStar() {
    let url = this._pageURL();
    this.star.hidden = !url;
    if (!url) {
      return;
    }
    let bookmark = await this.Library.bookmarkFor(url);
    if (url != this._pageURL()) {
      return;
    }
    this.star.toggleAttribute("starred", !!bookmark);
    this.star.querySelector("img").src = bookmark
      ? "chrome://browser-wip/skin/icons/star-filled.svg"
      : "chrome://browser-wip/skin/icons/star.svg";
    this.window.document.l10n.setAttributes(this.star, bookmark ? "star-button-edit" : "star-button");
  },

  /** Ctrl+D and the star: bookmarks the page (or opens its bookmark). */
  async bookmarkPage() {
    let url = this._pageURL();
    if (!url) {
      return;
    }
    let bookmark = await this.Library.bookmarkFor(url);
    let added = false;
    if (!bookmark) {
      bookmark = await this.Library.addBookmark({ url, title: gBrowser.selectedBrowser.contentTitle || url });
      added = true;
    }
    await this.editBookmark(bookmark.guid, this.star, { added });
  },

  /** Opens the panel for one bookmark, under `anchor`. */
  async editBookmark(guid, anchor, { added = false } = {}) {
    let bookmark = await PlacesUtils.bookmarks.fetch(guid);
    if (!bookmark) {
      return;
    }
    let doc = this.window.document;
    this._edited = { guid, removed: false };
    doc.l10n.setAttributes(
      this.$("bookmark-panel-title"),
      added ? "bookmark-panel-added" : "bookmark-panel-edit"
    );
    let name = this.$("bookmark-panel-name");
    name.value = bookmark.title || "";
    let select = this.$("bookmark-panel-folder");
    select.replaceChildren();
    for (let folder of await this.Library.folders()) {
      let option = doc.createElement("option");
      option.value = folder.guid;
      if (folder.title == null) {
        doc.l10n.setAttributes(
          option,
          folder.guid == this.Library.BAR ? "bookmarks-folder-bar" : "bookmarks-folder-other"
        );
      } else {
        option.textContent = " ".repeat(folder.depth) + folder.title;
      }
      option.selected = folder.guid == bookmark.parentGuid;
      select.append(option);
    }
    if (this.panel.state == "closed") {
      this.panel.openPopup(anchor, "bottomright topright", 0, 4);
    }
    this.panel.addEventListener(
      "popupshown",
      () => {
        name.focus();
        name.select();
      },
      { once: true }
    );
  },

  async _saveEdited() {
    let edited = this._edited;
    this._edited = null;
    if (!edited || edited.removed) {
      return;
    }
    let bookmark = await PlacesUtils.bookmarks.fetch(edited.guid);
    if (!bookmark) {
      return;
    }
    let title = this.$("bookmark-panel-name").value.trim() || bookmark.url.href;
    let parentGuid = this.$("bookmark-panel-folder").value;
    if (title != bookmark.title) {
      await this.Library.updateBookmark(edited.guid, { title });
    }
    if (parentGuid && parentGuid != bookmark.parentGuid) {
      await this.Library.moveBookmark(edited.guid, parentGuid);
    }
  },

  async _removeEdited() {
    if (this._edited) {
      this._edited.removed = true;
      await this.Library.removeBookmark(this._edited.guid);
    }
    this.panel.hidePopup();
  },

  // -----------------------------------------------------------------------
  // The bar

  _syncBar() {
    this.bar.hidden = !this.barVisible;
    this.window.document
      .getElementById("cmd_toggleBookmarksBar")
      .setAttribute("checked", String(this.barVisible));
    if (this.barVisible) {
      this.renderBar().catch(console.error);
    }
  },

  _onPlacesEvents() {
    // Several events come together (an import, a folder removed): one
    // redraw for all of them.
    if (this._pending) {
      return;
    }
    this._pending = true;
    this.window.requestAnimationFrame(() => {
      this._pending = false;
      this.updateStar();
      if (this.barVisible) {
        this.renderBar().catch(console.error);
      }
    });
  },

  async renderBar() {
    let children = await this.Library.children(this.Library.BAR);
    this.items.replaceChildren(...children.map(child => this._barItem(child)));
    this.$("bookmarks-bar-empty").hidden = !!children.length;
    this._layoutOverflow();
  },

  _barItem(child) {
    let doc = this.window.document;
    if (child.type == "separator") {
      let sep = doc.createElement("span");
      sep.className = "bookmarks-bar-separator";
      sep.dataset.guid = child.guid;
      return sep;
    }
    let button = doc.createElement("button");
    button.className = "bookmark-item";
    button.dataset.guid = child.guid;
    button.dataset.type = child.type;
    let icon = doc.createElement("img");
    icon.className = "icon";
    icon.alt = "";
    if (child.type == "folder") {
      icon.src = "chrome://browser-wip/skin/icons/folder.svg";
    } else {
      button.dataset.url = child.url;
      let shown = this.Library.displayURL(child.url);
      button.title = child.title ? `${child.title}\n${shown}` : shown;
      icon.src = this.Library.iconURL(child.url);
      icon.addEventListener("error", () => (icon.src = "chrome://browser-wip/skin/icons/globe.svg"), {
        once: true,
      });
    }
    let label = doc.createElement("span");
    label.className = "bookmark-label";
    label.textContent = child.title || child.url || "";
    button.append(icon, label);
    return button;
  },

  /** Items that don't fit go into the » menu. */
  _layoutOverflow() {
    let hidden = 0;
    let limit = this.items.getBoundingClientRect().right;
    for (let item of this.items.children) {
      item.hidden = false;
    }
    for (let item of this.items.children) {
      if (item.getBoundingClientRect().right > limit + 0.5) {
        item.hidden = true;
        hidden++;
      }
    }
    this.overflow.hidden = !hidden;
  },

  _onItemClick(event) {
    let item = event.target.closest(".bookmark-item");
    if (!item || event.button > 1) {
      return;
    }
    if (item.dataset.type == "folder") {
      if (event.button == 0) {
        this._openFolderMenu(item.dataset.guid, item);
      }
      return;
    }
    this._open(item.dataset.url, { newTab: event.button == 1 || event.ctrlKey || event.metaKey });
  },

  _open(url, { newTab = false } = {}) {
    if (newTab) {
      gBrowser.addTab(url, { opener: gBrowser.selectedTab });
    } else {
      gBrowser.loadURL(gBrowser.selectedBrowser, url, { userGesture: true });
      gBrowser.selectedBrowser.focus();
    }
  },

  /** A folder (or the » overflow) as a menu of its bookmarks; subfolders as submenus. */
  async _openFolderMenu(guid, anchor, onlyGuids = null) {
    let doc = this.window.document;
    let menu = doc.getElementById("bookmarks-folder-menu");
    menu.replaceChildren();
    let fill = async (popup, folderGuid, only) => {
      let children = await this.Library.children(folderGuid);
      if (only) {
        children = children.filter(c => only.has(c.guid));
      }
      if (!children.length) {
        let empty = doc.createXULElement("menuitem");
        empty.setAttribute("disabled", "true");
        doc.l10n.setAttributes(empty, "bookmarks-folder-empty");
        popup.append(empty);
        return;
      }
      for (let child of children) {
        if (child.type == "separator") {
          popup.append(doc.createXULElement("menuseparator"));
        } else if (child.type == "folder") {
          let sub = doc.createXULElement("menu");
          sub.setAttribute("label", child.title);
          let subPopup = doc.createXULElement("menupopup");
          subPopup.className = "wip-menu";
          sub.append(subPopup);
          popup.append(sub);
          await fill(subPopup, child.guid);
        } else {
          let item = doc.createXULElement("menuitem");
          item.className = "menuitem-iconic";
          item.setAttribute("label", child.title || child.url);
          item.setAttribute("image", this.Library.iconURL(child.url));
          item.dataset.url = child.url;
          item.dataset.guid = child.guid;
          popup.append(item);
        }
      }
    };
    await fill(menu, guid, onlyGuids);
    menu.onclick = e => {
      let url = e.target.dataset?.url;
      if (url && e.button == 1) {
        this._open(url, { newTab: true });
        menu.hidePopup();
      }
    };
    menu.oncommand = e => {
      let url = e.target.dataset?.url;
      if (url) {
        this._open(url, { newTab: e.ctrlKey || e.metaKey });
      }
    };
    menu.openPopup(anchor, "after_start", 0, 2);
  },

  _openOverflow() {
    let hidden = new Set([...this.items.children].filter(i => i.hidden).map(i => i.dataset.guid));
    this._openFolderMenu(this.Library.BAR, this.overflow, hidden);
  },

  _onContextMenu(event) {
    let item = event.target.closest(".bookmark-item");
    if (!item) {
      return;
    }
    event.preventDefault();
    this._contextItem = item;
    let isFolder = item.dataset.type == "folder";
    for (let id of ["bookmarks-context-open", "bookmarks-context-open-tab"]) {
      this.$(id).hidden = isFolder;
    }
    this.context.openPopupAtScreen(event.screenX, event.screenY, true, event);
  },

  async _onContextCommand(event) {
    let item = this._contextItem;
    if (!item) {
      return;
    }
    switch (event.target.id) {
      case "bookmarks-context-open":
        this._open(item.dataset.url);
        break;
      case "bookmarks-context-open-tab":
        this._open(item.dataset.url, { newTab: true });
        break;
      case "bookmarks-context-edit":
        if (item.dataset.type == "folder") {
          this.openManager("bookmarks");
        } else {
          await this.editBookmark(item.dataset.guid, item);
        }
        break;
      case "bookmarks-context-delete": {
        // A folder goes with everything in it: ask first.
        if (item.dataset.type == "folder" && (await this.Library.children(item.dataset.guid)).length) {
          let [title, text] = await this.window.document.l10n.formatValues([
            "bookmarks-delete-folder-title",
            { id: "bookmarks-delete-folder-text", args: { name: item.textContent } },
          ]);
          if (!Services.prompt.confirm(this.window, title, text)) {
            break;
          }
        }
        await this.Library.removeBookmark(item.dataset.guid);
        break;
      }
      case "bookmarks-context-manage":
        this.openManager("bookmarks");
        break;
    }
  },
};
