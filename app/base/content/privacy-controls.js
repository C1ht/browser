/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * The Standard / Strict cards and the Advanced switches, shared by the
 * first-run screen and Settings.
 *
 * In "live" mode (Settings) every click is applied at once. In "preview"
 * mode (first run) choices are held until commit(), so leaving the screen
 * any other way keeps Standard.
 */

const { PrivacyModes } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/PrivacyModes.sys.mjs"
);

// How each toggle is presented. `on` is what the switch shows: for features
// that Strict turns off (JIT, full WebRTC) the switch is on when the toggle
// is NOT strict, so the label can name the feature plainly.
const TOGGLE_UI = {
  jit: { l10n: "privacy-toggle-jit", on: strict => !strict },
  webrtc: { l10n: "privacy-toggle-webrtc", on: strict => !strict },
  hideDeviceDetails: { l10n: "privacy-toggle-device", on: strict => strict },
  utcTimezone: { l10n: "privacy-toggle-timezone", on: strict => strict },
  httpsOnly: { l10n: "privacy-toggle-https-only", on: strict => strict },
  noStorageHeuristics: { l10n: "privacy-toggle-storage-heuristics", on: strict => !strict },
  blockSocial: { l10n: "privacy-toggle-social", on: strict => strict },
  webrtcOff: { l10n: "privacy-toggle-webrtc-off", on: strict => !strict },
};

class PrivacyControls {
  /**
   * @param {object} options
   *   cards: element to fill with the two mode cards
   *   toggles: element to fill with switch rows
   *   toggleIds: which toggles to show, in order
   *   live: apply immediately (Settings) or hold until commit() (first run)
   *   onChange: called after any change
   */
  constructor({ cards, toggles, toggleIds, live, onChange = () => {} }) {
    this.live = live;
    this.onChange = onChange;
    this.toggleIds = toggleIds;
    this.state = PrivacyModes.state;
    this.cardsEl = cards;
    this.togglesEl = toggles;
    this._render();
    this._sync();
  }

  get mode() {
    return PrivacyModes.modeFor(this.state);
  }

  /** First run: write the previewed choices. */
  commit() {
    PrivacyModes.applyState(this.state);
  }

  _render() {
    let doc = this.cardsEl.ownerDocument;
    this.cardsEl.setAttribute("role", "radiogroup");
    doc.l10n.setAttributes(this.cardsEl, "privacy-modes-group");
    for (let mode of ["standard", "strict"]) {
      let card = doc.createElement("button");
      card.type = "button";
      card.className = "mode";
      card.id = `mode-${mode}`;
      card.setAttribute("role", "radio");
      card.dataset.mode = mode;
      let head = doc.createElement("span");
      head.className = "mode-head";
      let radio = doc.createElement("span");
      radio.className = "radio";
      let name = doc.createElement("span");
      doc.l10n.setAttributes(name, `privacy-mode-${mode}-name`);
      head.append(radio, name);
      if (mode == "standard") {
        let badge = doc.createElement("span");
        badge.className = "badge";
        doc.l10n.setAttributes(badge, "privacy-mode-recommended");
        head.append(badge);
      }
      let desc = doc.createElement("p");
      doc.l10n.setAttributes(desc, `privacy-mode-${mode}-description`);
      card.append(head, desc);
      card.addEventListener("click", () => this._selectMode(mode));
      this.cardsEl.append(card);
    }
    this.customNote = doc.createElement("p");
    this.customNote.className = "custom-note";
    this.customNote.hidden = true;
    doc.l10n.setAttributes(this.customNote, "privacy-mode-custom");
    this.cardsEl.after(this.customNote);

    this.switches = {};
    for (let id of this.toggleIds) {
      let ui = TOGGLE_UI[id];
      let row = doc.createElement("div");
      row.className = "toggle-row";
      let text = doc.createElement("div");
      let label = doc.createElement("label");
      label.id = `toggle-${id}-label`;
      label.htmlFor = `toggle-${id}`;
      doc.l10n.setAttributes(label, `${ui.l10n}-label`);
      let help = doc.createElement("span");
      help.className = "help";
      doc.l10n.setAttributes(help, `${ui.l10n}-help`);
      text.append(label, help);
      if (PrivacyModes.TOGGLES[id].restart) {
        let note = doc.createElement("span");
        note.className = "note";
        note.hidden = true;
        doc.l10n.setAttributes(note, "privacy-toggle-restart-note");
        text.append(note);
        row.restartNote = note;
      }
      let sw = doc.createElement("button");
      sw.type = "button";
      sw.className = "switch";
      sw.id = `toggle-${id}`;
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-labelledby", label.id);
      sw.addEventListener("click", () => this._flip(id));
      label.addEventListener("click", e => {
        e.preventDefault();
        sw.click();
      });
      row.append(text, sw);
      this.togglesEl.append(row);
      this.switches[id] = { sw, row };
    }
  }

  _selectMode(mode) {
    this.state = PrivacyModes.stateForMode(mode);
    if (this.live) {
      PrivacyModes.setMode(mode);
    }
    this._sync();
  }

  _flip(id) {
    this.state[id] = !this.state[id];
    if (this.live) {
      PrivacyModes.setStrict(id, this.state[id]);
    }
    this._sync();
  }

  _sync() {
    let mode = this.mode;
    for (let card of this.cardsEl.querySelectorAll(".mode")) {
      let checked = card.dataset.mode == mode;
      card.setAttribute("aria-checked", String(checked));
      card.tabIndex = checked || (mode == "custom" && card.dataset.mode == "standard") ? 0 : -1;
    }
    this.customNote.hidden = mode != "custom";
    let pending = this.live ? PrivacyModes.pendingRestart : [];
    for (let [id, { sw, row }] of Object.entries(this.switches)) {
      sw.setAttribute("aria-checked", String(TOGGLE_UI[id].on(this.state[id])));
      if (row.restartNote) {
        row.restartNote.hidden = !pending.includes(id);
      }
    }
    this.onChange(mode, pending);
  }
}
