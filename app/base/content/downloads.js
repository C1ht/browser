/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * The downloads button and panel.
 *
 * Gecko's own download manager (toolkit's Downloads.sys.mjs) does the
 * downloading and keeps the list across restarts (downloads.json in the
 * profile); this is only its view. Files go to the Downloads folder without
 * asking, unless Settings says to ask each time.
 *
 * The button appears once there is something in the list. It shows overall
 * progress while downloads run, and a dot when one finishes while the panel
 * is closed. A download that starts opens the panel in the active window.
 */

ChromeUtils.defineESModuleGetters(this, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
});

// Units Intl.NumberFormat can name in every locale.
const SIZE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte"];

function formatSize(bytes) {
  let unit = 0;
  while (bytes >= 1000 && unit < SIZE_UNITS.length - 1) {
    bytes /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(undefined, {
    style: "unit",
    unit: SIZE_UNITS[unit],
    unitDisplay: "short",
    maximumFractionDigits: unit < 2 ? 0 : 1,
  }).format(bytes);
}

var DownloadsUI = {
  async init(window) {
    this.window = window;
    let $ = id => window.document.getElementById(id);
    this.button = $("downloads-button");
    this.panel = $("downloads-panel");
    this.listEl = $("downloads-list");
    this.emptyEl = $("downloads-empty");
    this.items = new Map();

    this.button.addEventListener("click", () => this.open());
    this.panel.addEventListener("popupshowing", () => {
      this.button.removeAttribute("attention");
      this.button.setAttribute("open", "true");
      // Notices files deleted or moved since they finished.
      for (let download of this.items.keys()) {
        if (download.succeeded) {
          download.refresh().catch(() => {});
        }
      }
    });
    this.panel.addEventListener("popuphidden", () => {
      this.button.removeAttribute("open");
      this._updateButton();
    });
    $("downloads-clear").addEventListener("click", () => this.list.removeFinished());
    $("downloads-open-folder").addEventListener("click", () => this.openFolder());

    this.list = await Downloads.getList(Downloads.ALL);
    // Reports the downloads already in the list, oldest first, before
    // resolving; only downloads added after that open the panel.
    await this.list.addView(this);
    this._ready = true;
    window.addEventListener("unload", () => this.list.removeView(this));
  },

  open() {
    // With nothing in the list the button is hidden; show it while the
    // panel says so.
    this.button.hidden = false;
    this.panel.openPopup(this.button, "bottomright topright", 0, 4);
  },

  async openFolder() {
    let path = await Downloads.getPreferredDownloadsDirectory();
    let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    dir.initWithPath(path);
    dir.launch();
    this.panel.hidePopup();
  },

  // Download list views (toolkit DownloadList.addView).

  onDownloadAdded(download) {
    let item = this._createItem(download);
    this.items.set(download, item);
    this.listEl.prepend(item);
    this._updateItem(download);
    this._updateButton();
    if (this._ready && Services.focus.activeWindow == this.window) {
      this.open();
    }
  },

  onDownloadChanged(download) {
    let wasRunning = this.items.get(download)?.running;
    this._updateItem(download);
    this._updateButton();
    if (wasRunning && download.succeeded && this.panel.state != "open") {
      this.button.setAttribute("attention", "true");
    }
  },

  onDownloadRemoved(download) {
    this.items.get(download)?.remove();
    this.items.delete(download);
    this._updateButton();
  },

  _createItem(download) {
    let doc = this.window.document;
    let item = doc.createElement("div");
    item.className = "download";
    item.setAttribute("role", "listitem");
    item.tabIndex = 0;

    let icon = doc.createElement("img");
    icon.className = "download-icon";
    icon.setAttribute("alt", "");
    icon.src = `moz-icon://${download.target.path}?size=32`;

    let text = doc.createElement("div");
    text.className = "download-text";
    let name = doc.createElement("span");
    name.className = "download-name";
    name.textContent = PathUtils.filename(download.target.path);
    let status = doc.createElement("span");
    status.className = "download-status";
    let progress = doc.createElement("div");
    progress.className = "download-progress";
    progress.append(doc.createElement("div"));
    text.append(name, status, progress);

    let action = doc.createElement("button");
    action.className = "download-action toolbar-button";
    let actionIcon = doc.createElement("img");
    actionIcon.className = "icon";
    actionIcon.setAttribute("alt", "");
    action.append(actionIcon);
    action.addEventListener("click", e => {
      e.stopPropagation();
      this._act(download, item.action);
    });

    item.append(icon, text, action);
    item.addEventListener("click", () => this._openFile(download));
    item.addEventListener("keydown", e => {
      if (e.key == "Enter") {
        this._openFile(download);
      } else if (e.key == "Delete") {
        this._remove(download);
      }
    });
    return item;
  },

  _openFile(download) {
    if (download.succeeded && download.target.exists !== false) {
      download.launch().catch(console.error);
      this.panel.hidePopup();
    }
  },

  async _remove(download) {
    if (!download.stopped) {
      await download.cancel();
    }
    await this.list.remove(download);
    await download.finalize(true);
  },

  _act(download, action) {
    switch (action) {
      case "cancel":
        download.cancel().catch(console.error);
        break;
      case "retry":
        download.start().catch(() => {});
        break;
      case "show":
        download.showContainingDirectory().catch(console.error);
        this.panel.hidePopup();
        break;
    }
  },

  _updateItem(download) {
    let item = this.items.get(download);
    if (!item) {
      return;
    }
    let l10n = this.window.document.l10n;
    let status = item.querySelector(".download-status");
    let running = !download.stopped;
    let state;
    if (running) {
      state = "running";
      let speed = download.speed > 0 ? formatSize(download.speed) : "";
      if (download.hasProgress) {
        l10n.setAttributes(status, speed ? "download-status-progress-speed" : "download-status-progress", {
          current: formatSize(download.currentBytes),
          total: formatSize(download.totalBytes),
          speed,
        });
      } else {
        l10n.setAttributes(status, "download-status-unknown", { current: formatSize(download.currentBytes) });
      }
    } else if (download.succeeded) {
      state = download.target.exists === false ? "missing" : "done";
      if (state == "missing") {
        l10n.setAttributes(status, "download-status-missing");
      } else {
        let host = "";
        try {
          host = Services.io.newURI(download.source.url).host;
        } catch (e) {
          // data:, blob: and friends have no host.
        }
        let size = download.target.size ?? download.currentBytes;
        l10n.setAttributes(status, host ? "download-status-done-host" : "download-status-done", {
          size: formatSize(size),
          host,
        });
      }
    } else if (download.error) {
      state = "failed";
      l10n.setAttributes(status, "download-status-failed");
    } else {
      state = "canceled";
      l10n.setAttributes(status, "download-status-canceled");
    }
    item.running = running;
    item.dataset.state = state;
    item.style.setProperty("--progress", `${download.hasProgress ? download.progress : 0}%`);
    item.toggleAttribute("indeterminate", running && !download.hasProgress);

    item.action = { running: "cancel", done: "show", missing: null, failed: "retry", canceled: "retry" }[state];
    let action = item.querySelector(".download-action");
    action.hidden = !item.action;
    if (item.action) {
      action.querySelector("img").src = `chrome://browser-wip/skin/icons/${
        { cancel: "close", retry: "reload", show: "folder" }[item.action]
      }.svg`;
      l10n.setAttributes(action, `download-action-${item.action}`);
    }
  },

  _updateButton() {
    this.button.hidden = !this.items.size && this.panel.state == "closed";
    this.emptyEl.hidden = !!this.items.size;
    let running = [...this.items.keys()].filter(d => !d.stopped);
    this.button.toggleAttribute("active", !!running.length);
    let total = running.reduce((n, d) => n + (d.hasProgress ? d.totalBytes : 0), 0);
    let done = running.reduce((n, d) => n + (d.hasProgress ? d.currentBytes : 0), 0);
    this.button.style.setProperty("--progress", `${total ? (100 * done) / total : 0}%`);
  },
};
