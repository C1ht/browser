/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Permission prompts and the camera/microphone sharing indicators.
 *
 * Requests come from ContentPermissionPrompt (location, notifications,
 * storage, MIDI, VR, storage access) and WebRTCParent (camera, microphone,
 * screen). Each is a { kind, browser, principal, canRemember, respond }
 * object; respond(allow, { remember, devices, dismissed }) carries out the
 * answer. A dismissed request (Escape, or the page went away) is refused
 * without recording anything, so the site may ask again.
 *
 * Requests queue per tab, and the selected tab's first request shows in a
 * panel under the site information button.
 */

var PermissionPrompts = {
  init(window) {
    this.window = window;
    let $ = id => window.document.getElementById(id);
    this.panel = $("permission-panel");
    this.message = $("permission-message");
    this.videoRow = $("permission-video-row");
    this.audioRow = $("permission-audio-row");
    this.videoList = $("permission-video");
    this.audioList = $("permission-audio");
    this.rememberRow = $("permission-remember-row");
    this.remember = $("permission-remember");
    this.anchor = $("identity-button");
    this.sharingButton = $("sharing-button");
    this.sharingPanel = $("sharing-panel");
    this.queue = [];

    $("permission-allow").addEventListener("click", () => this._answer(true));
    $("permission-block").addEventListener("click", () => this._answer(false));
    this.panel.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        this._answer(false, { dismissed: true });
      }
    });
    this.sharingButton.addEventListener("click", () => this._showSharingPanel());
    $("sharing-stop").addEventListener("click", () => this._stopSharing());

    gBrowser.tabContainer.addEventListener("TabSelect", () => {
      this._show();
      this._updateSharingButton();
    });
    gBrowser.tabContainer.addEventListener("TabLocationChange", e => {
      if (!e.detail?.sameDocument) {
        this._drop(e.target.linkedBrowser);
      }
    });
    gBrowser.tabContainer.addEventListener("TabClose", e => this._drop(e.target.linkedBrowser));
  },

  request(request) {
    this.queue.push(request);
    this._show();
  },

  /** A page's WebRTC actor went away: drop its requests and indicators. */
  forgetWebRTC(actor) {
    this._remove(r => r.actor == actor);
    let browser = [...this._sharing.keys()].find(b => this._sharing.get(b).has(actor));
    if (browser) {
      this.updateSharing(browser, actor, { camera: false, microphone: false, screen: false });
    }
  },

  _drop(browser) {
    this._remove(r => r.browser == browser);
  },

  _remove(match) {
    let dropped = this.queue.filter(match);
    this.queue = this.queue.filter(r => !match(r));
    for (let request of dropped) {
      request.respond(false, { dismissed: true });
    }
    if (dropped.includes(this._shown)) {
      this._shown = null;
      this.panel.hidePopup();
    }
    this._show();
  },

  _host(principal) {
    try {
      return principal.hostPort || principal.URI.displaySpec;
    } catch (e) {
      return principal.origin;
    }
  },

  _show() {
    let request = this.queue.find(r => r.browser == gBrowser.selectedBrowser);
    if (!request) {
      this._shown = null;
      this.panel.hidePopup();
      return;
    }
    if (request == this._shown && this.panel.state != "closed") {
      return;
    }
    this._shown = request;
    let doc = this.window.document;
    let args = { host: this._host(request.principal) };
    let id = `permission-${request.kind}`;
    if (request.kind == "webrtc") {
      // Camera, Microphone, Screen, AudioCapture -> e.g. permission-camera-microphone
      let types = request.requestTypes.map(t => (t == "AudioCapture" ? "microphone" : t.toLowerCase()));
      id = `permission-${types.join("-")}`;
    } else if (request.kind == "storage-access") {
      args.site = this._host(request.topLevelPrincipal);
    }
    doc.l10n.setAttributes(this.message, id, args);

    this._fillDevices(this.videoRow, this.videoList, request.videoInputDevices);
    this._fillDevices(this.audioRow, this.audioList, request.audioInputDevices);
    let isScreen = request.requestTypes?.includes("Screen");
    doc.l10n.setAttributes(
      this.videoRow.querySelector("span"),
      isScreen ? "permission-screen-label" : "permission-camera-label"
    );

    this.rememberRow.hidden = !request.canRemember;
    this.remember.checked = false;
    this.panel.openPopup(this.anchor, "bottomleft topleft", 0, 4);
  },

  _fillDevices(row, list, devices) {
    row.hidden = !devices?.length;
    list.removeAllItems();
    for (let device of devices ?? []) {
      list.appendItem(device.name, String(device.deviceIndex));
    }
    list.selectedIndex = devices?.length ? 0 : -1;
  },

  _answer(allow, { dismissed = false } = {}) {
    let request = this._shown;
    if (!request) {
      return;
    }
    this._shown = null;
    this.queue = this.queue.filter(r => r != request);
    this.panel.hidePopup();
    let devices = [this.videoRow, this.audioRow]
      .filter(row => !row.hidden)
      .map(row => Number(row.querySelector("menulist").value));
    request.respond(allow, {
      dismissed,
      remember: !dismissed && request.canRemember && this.remember.checked,
      devices: request.kind == "webrtc" ? devices : undefined,
    });
    this._show();
  },

  // Sharing indicators. Per browser: the WebRTC actor of each window that
  // captures -> what it captures.

  _sharing: new Map(),

  updateSharing(browser, actor, state) {
    if (!browser) {
      return;
    }
    let windows = this._sharing.get(browser) ?? new Map();
    if (state.camera || state.microphone || state.screen) {
      windows.set(actor, state);
    } else {
      windows.delete(actor);
    }
    if (windows.size) {
      this._sharing.set(browser, windows);
    } else {
      this._sharing.delete(browser);
    }
    let tab = gBrowser.getTabForBrowser(browser);
    if (tab) {
      let summary = this._summary(browser);
      tab.toggleAttribute("sharing", !!summary);
      tab.querySelector(".tab-state.sharing").src = this._icon(summary);
    }
    this._updateSharingButton();
  },

  _summary(browser) {
    let windows = this._sharing.get(browser);
    if (!windows) {
      return null;
    }
    let all = [...windows.values()];
    return {
      camera: all.some(s => s.camera),
      microphone: all.some(s => s.microphone),
      screen: all.some(s => s.screen),
    };
  },

  _icon(summary) {
    let name = summary?.camera || summary?.screen || !summary?.microphone ? "camera" : "microphone";
    return `chrome://browser-wip/skin/icons/${name}.svg`;
  },

  _updateSharingButton() {
    let summary = this._summary(gBrowser.selectedBrowser);
    this.sharingButton.hidden = !summary;
    if (summary) {
      this.sharingButton.querySelector("img").src = this._icon(summary);
    } else {
      this.sharingPanel.hidePopup();
    }
  },

  _showSharingPanel() {
    let browser = gBrowser.selectedBrowser;
    let summary = this._summary(browser);
    if (!summary) {
      return;
    }
    let what = ["screen", "camera", "microphone"].filter(k => summary[k]).join("-");
    this.window.document.l10n.setAttributes(
      this.window.document.getElementById("sharing-message"),
      `sharing-${what}`,
      { host: this._host(browser.contentPrincipal) }
    );
    this.sharingPanel.openPopup(this.sharingButton, "bottomright topright", 0, 4);
  },

  _stopSharing() {
    let windows = this._sharing.get(gBrowser.selectedBrowser);
    for (let [actor, state] of windows ?? []) {
      actor.stopSharing(state.windowId);
    }
    this.sharingPanel.hidePopup();
  },
};
