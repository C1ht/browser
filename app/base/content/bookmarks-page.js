/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * about:bookmarks (Library.sys.mjs does the work). Runs in the browser
 * process with chrome privileges, like Settings.
 */

const { Library, BAR_PREF } = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");
const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");

const BOOKMARK_EVENTS = [
  "bookmark-added",
  "bookmark-removed",
  "bookmark-moved",
  "bookmark-title-changed",
  "bookmark-url-changed",
];

const $ = id => document.getElementById(id);

const BookmarksPage = {
  folder: Library.BAR,
  folderList: [],
  // The guid being edited in place, if any.
  editing: null,

  init() {
    let searchTimer;
    $("search").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => this.renderItems(), 150);
    });
    $("new-folder").addEventListener("click", () => this.newFolder());
    $("more").addEventListener("click", () => this.toggleHeaderMenu());
    $("menu-import").addEventListener("click", () => this.importFile());
    $("menu-export").addEventListener("click", () => this.exportFile());
    $("menu-bar").addEventListener("click", () => {
      Services.prefs.setBoolPref(BAR_PREF, !Services.prefs.getBoolPref(BAR_PREF, false));
      this.closeMenus();
    });
    $("folders").addEventListener("click", e => {
      let item = e.target.closest(".folder");
      if (item) {
        this.select(item.dataset.guid);
      }
    });
    $("folders").addEventListener("keydown", e => this.folderKey(e));
    $("items").addEventListener("click", e => this.onItemsClick(e));
    document.addEventListener("click", e => {
      if (!e.target.closest(".menu-wrap")) {
        this.closeMenus();
      }
    });
    document.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        this.closeMenus();
      }
    });

    let pending = false;
    let onChange = () => {
      if (!pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          this.render();
        }, 100);
      }
    };
    PlacesUtils.observers.addListener(BOOKMARK_EVENTS, onChange);
    window.addEventListener("unload", () => PlacesUtils.observers.removeListener(BOOKMARK_EVENTS, onChange));
    this.render();
  },

  async render() {
    await this.renderFolders();
    await this.renderItems();
  },

  folderName(folder) {
    return folder.title ?? null;
  },

  async renderFolders() {
    this.folderList = await Library.folders();
    if (!this.folderList.some(f => f.guid == this.folder)) {
      this.folder = Library.BAR;
    }
    $("folders").replaceChildren(
      ...this.folderList.map(folder => {
        let item = document.createElement("div");
        item.className = "folder";
        item.setAttribute("role", "treeitem");
        item.dataset.guid = folder.guid;
        item.style.setProperty("--depth", folder.depth);
        item.tabIndex = folder.guid == this.folder ? 0 : -1;
        item.toggleAttribute("selected", folder.guid == this.folder);
        item.setAttribute("aria-selected", String(folder.guid == this.folder));
        let icon = document.createElement("img");
        icon.className = "button-icon";
        icon.alt = "";
        icon.src =
          folder.guid == Library.BAR
            ? "chrome://browser-wip/skin/icons/star.svg"
            : "chrome://browser-wip/skin/icons/folder.svg";
        let label = document.createElement("span");
        this.setFolderLabel(label, folder);
        item.append(icon, label);
        return item;
      })
    );
  },

  setFolderLabel(element, folder) {
    if (folder.title == null) {
      document.l10n.setAttributes(
        element,
        folder.guid == Library.BAR ? "bookmarks-folder-bar" : "bookmarks-folder-other"
      );
    } else {
      element.textContent = folder.title;
    }
  },

  folderKey(event) {
    let items = [...$("folders").children];
    let at = items.findIndex(i => i.dataset.guid == this.folder);
    let next = { ArrowDown: at + 1, ArrowUp: at - 1 }[event.key];
    if (next != undefined && items[next]) {
      event.preventDefault();
      this.select(items[next].dataset.guid).then(() => $("folders").children[next]?.focus());
    }
  },

  async select(guid) {
    this.folder = guid;
    this.editing = null;
    $("search").value = "";
    await this.renderFolders();
    await this.renderItems();
  },

  async renderItems() {
    let query = $("search").value.trim();
    let heading = $("items-heading");
    let items;
    if (query) {
      items = await Library.searchBookmarks(query);
      document.l10n.setAttributes(heading, "bookmarks-results", { query });
    } else {
      items = await Library.children(this.folder);
      let folder = this.folderList.find(f => f.guid == this.folder);
      if (folder) {
        this.setFolderLabel(heading, folder);
      }
    }
    if (query != $("search").value.trim()) {
      return;
    }
    $("items").replaceChildren(...items.filter(i => i.type != "separator").map(item => this.itemRow(item)));
    let empty = $("items-empty");
    empty.hidden = !!$("items").children.length;
    document.l10n.setAttributes(empty, query ? "bookmarks-no-results" : "bookmarks-folder-is-empty", { query });
  },

  itemRow(item) {
    if (this.editing == item.guid) {
      return this.editRow(item);
    }
    let row = document.createElement("div");
    row.className = "entry";
    row.setAttribute("role", "listitem");
    row.dataset.guid = item.guid;
    row.dataset.type = item.type;
    let icon = document.createElement("img");
    icon.className = "entry-icon";
    icon.alt = "";
    let title;
    if (item.type == "folder") {
      icon.src = "chrome://browser-wip/skin/icons/folder.svg";
      title = document.createElement("button");
      title.type = "button";
      title.className = "entry-title link folder-open";
      title.textContent = item.title;
    } else {
      icon.src = Library.iconURL(item.url);
      icon.addEventListener("error", () => (icon.src = "chrome://browser-wip/skin/icons/globe.svg"), { once: true });
      title = document.createElement("a");
      title.className = "entry-title";
      title.href = item.url;
      title.textContent = item.title || item.url;
    }
    let url = document.createElement("span");
    url.className = "entry-host";
    url.textContent = item.url ? Library.displayURL(item.url) : "";
    let wrap = document.createElement("div");
    wrap.className = "menu-wrap";
    let more = document.createElement("button");
    more.className = "entry-more icon-button";
    more.type = "button";
    more.setAttribute("aria-haspopup", "menu");
    document.l10n.setAttributes(more, "bookmarks-entry-menu", { title: item.title || item.url });
    let dots = document.createElement("img");
    dots.className = "button-icon";
    dots.src = "chrome://browser-wip/skin/icons/more.svg";
    dots.alt = "";
    more.append(dots);
    wrap.append(more);
    row.append(icon, title, url, wrap);
    return row;
  },

  /** The row as a form: name, address (bookmarks) and folder. */
  editRow(item) {
    let form = document.createElement("form");
    form.className = "entry editing inline-form";
    form.dataset.guid = item.guid;
    let field = (l10n, element) => {
      let label = document.createElement("label");
      label.className = "dialog-field";
      let span = document.createElement("span");
      document.l10n.setAttributes(span, l10n);
      label.append(span, element);
      form.append(label);
      return element;
    };
    let name = field("bookmarks-edit-name", Object.assign(document.createElement("input"), { className: "field", value: item.title }));
    let url = null;
    if (item.type == "bookmark") {
      url = field("bookmarks-edit-url", Object.assign(document.createElement("input"), { className: "field", value: item.url, type: "url" }));
    }
    let folder = field("bookmarks-edit-folder", document.createElement("select"));
    folder.className = "field";
    for (let f of this.folderList) {
      // A folder can't go inside itself.
      if (f.guid == item.guid) {
        continue;
      }
      let option = document.createElement("option");
      option.value = f.guid;
      if (f.title == null) {
        this.setFolderLabel(option, f);
      } else {
        option.textContent = " ".repeat(f.depth) + f.title;
      }
      option.selected = f.guid == item.parentGuid;
      folder.append(option);
    }
    let error = document.createElement("p");
    error.className = "error";
    error.hidden = true;
    let buttons = document.createElement("div");
    buttons.className = "dialog-buttons";
    let cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary small";
    document.l10n.setAttributes(cancel, "library-cancel");
    let save = document.createElement("button");
    save.type = "submit";
    save.className = "primary small";
    document.l10n.setAttributes(save, "bookmarks-edit-save");
    buttons.append(cancel, save);
    form.append(error, buttons);
    cancel.addEventListener("click", () => {
      this.editing = null;
      this.renderItems();
    });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      let changes = { title: name.value.trim() };
      if (url) {
        try {
          let parsed = new URL(url.value.trim());
          if (!/^(https?|file|ftp):$/.test(parsed.protocol)) {
            throw new Error("scheme");
          }
          changes.url = parsed.href;
        } catch (err) {
          document.l10n.setAttributes(error, "bookmarks-edit-bad-url");
          error.hidden = false;
          url.focus();
          return;
        }
      }
      await Library.updateBookmark(item.guid, changes);
      if (folder.value != item.parentGuid) {
        await Library.moveBookmark(item.guid, folder.value);
      }
      this.editing = null;
      this.renderItems();
    });
    setTimeout(() => name.focus());
    return form;
  },

  closeMenus() {
    for (let menu of document.querySelectorAll("#items .menu")) {
      menu.remove();
    }
    $("more-menu").hidden = true;
    $("more").setAttribute("aria-expanded", "false");
  },

  toggleHeaderMenu() {
    let open = $("more-menu").hidden;
    this.closeMenus();
    if (open) {
      $("menu-bar").setAttribute("aria-checked", String(Services.prefs.getBoolPref(BAR_PREF, false)));
      document.l10n.setAttributes(
        $("menu-bar"),
        Services.prefs.getBoolPref(BAR_PREF, false) ? "bookmarks-hide-bar" : "bookmarks-show-bar"
      );
      $("more-menu").hidden = false;
      $("more").setAttribute("aria-expanded", "true");
    }
  },

  async onItemsClick(event) {
    let row = event.target.closest(".entry");
    if (!row || row.classList.contains("editing")) {
      return;
    }
    let guid = row.dataset.guid;
    if (event.target.closest(".folder-open")) {
      this.select(guid);
      return;
    }
    if (event.target.closest(".entry-more")) {
      let open = row.querySelector(".menu");
      this.closeMenus();
      if (open) {
        return;
      }
      let menu = document.createElement("div");
      menu.className = "menu";
      menu.setAttribute("role", "menu");
      for (let [l10n, action] of [
        ["bookmarks-edit", "edit"],
        ["bookmarks-delete", "delete"],
      ]) {
        let button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.dataset.action = action;
        document.l10n.setAttributes(button, l10n);
        menu.append(button);
      }
      row.querySelector(".menu-wrap").append(menu);
      menu.querySelector("button").focus();
      return;
    }
    let action = event.target.closest(".menu button")?.dataset.action;
    this.closeMenus();
    if (action == "edit") {
      this.editing = guid;
      this.renderItems();
    } else if (action == "delete") {
      if (row.dataset.type == "folder" && (await Library.children(guid)).length) {
        let [title, text] = await document.l10n.formatValues([
          "bookmarks-delete-folder-title",
          { id: "bookmarks-delete-folder-text", args: { name: row.querySelector(".entry-title").textContent } },
        ]);
        if (!Services.prompt.confirm(window, title, text)) {
          return;
        }
      }
      await Library.removeBookmark(guid);
    }
  },

  async newFolder() {
    let [name] = await document.l10n.formatValues(["bookmarks-new-folder-name"]);
    let parentGuid = $("search").value.trim() ? Library.OTHER : this.folder;
    let folder = await Library.addFolder({ title: name, parentGuid });
    this.folder = parentGuid;
    this.editing = folder.guid;
    $("search").value = "";
    await this.render();
  },

  async pickFile(mode) {
    let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let [title] = await document.l10n.formatValues([
      mode == Ci.nsIFilePicker.modeSave ? "bookmarks-export-title" : "bookmarks-import-title",
    ]);
    picker.init(window.browsingContext, title, mode);
    picker.appendFilters(Ci.nsIFilePicker.filterHTML);
    if (mode == Ci.nsIFilePicker.modeSave) {
      picker.defaultString = `bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
      picker.defaultExtension = "html";
    }
    let result = await new Promise(resolve => picker.open(resolve));
    return result == Ci.nsIFilePicker.returnCancel ? null : picker.file.path;
  },

  status(l10n, args) {
    document.l10n.setAttributes($("status"), l10n, args);
    $("status").hidden = false;
  },

  async importFile() {
    this.closeMenus();
    let path = await this.pickFile(Ci.nsIFilePicker.modeOpen);
    if (!path) {
      return;
    }
    try {
      let count = await Library.importHTML(path);
      this.status("bookmarks-imported", { count: count ?? 0 });
    } catch (e) {
      this.status("bookmarks-import-failed");
    }
  },

  async exportFile() {
    this.closeMenus();
    let path = await this.pickFile(Ci.nsIFilePicker.modeSave);
    if (!path) {
      return;
    }
    try {
      let count = await Library.exportHTML(path);
      this.status("bookmarks-exported", { count: count ?? 0, file: PathUtils.filename(path) });
    } catch (e) {
      this.status("bookmarks-export-failed");
    }
  },
};

window.addEventListener("DOMContentLoaded", () => BookmarksPage.init());
