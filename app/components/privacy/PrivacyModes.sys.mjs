/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The privacy modes (Standard, Strict Privacy, Anonymous) and the Advanced
 * toggles behind them.
 *
 * Standard is not stored anywhere: it is the default prefs file, which
 * already hides device details from pages. Each toggle is a set of prefs
 * with a Standard value (the default) and a strict value (written as a user
 * pref). Strict Privacy and Anonymous each turn a set of toggles strict. The
 * mode shown to the user is derived from the prefs themselves, so it can
 * never disagree with them: any other mix is "custom".
 */

const FPP_OVERRIDES = "privacy.fingerprintingProtection.overrides";

/**
 * Each toggle: `strict` lists the prefs it writes when strict, or `fpp` the
 * Fingerprinting Protection targets it adds. The Standard value is whatever
 * the default branch holds, so it is never duplicated here.
 * `modes` lists the modes that turn it strict.
 * `restart` marks toggles that only take effect after a restart.
 */
export const TOGGLES = {
  // Fast JavaScript off for web pages; the browser's own UI keeps its JIT
  // through javascript.options.jit_trustedprincipals.
  jit: {
    modes: ["strict", "anonymous"],
    restart: true,
    strict: {
      "javascript.options.baselinejit": false,
      "javascript.options.ion": false,
      "javascript.options.native_regexp": false,
      "javascript.options.wasm_optimizingjit": false,
    },
  },
  // Only the default route's public address in calls: no LAN addresses, and
  // no path around a VPN.
  webrtc: {
    modes: ["strict", "anonymous"],
    strict: {
      "media.peerconnection.ice.default_address_only": true,
      "media.peerconnection.ice.no_host": true,
    },
  },
  // Turns WebRTC off entirely, as Tor Browser does. Not part of Strict, so
  // calls keep working there.
  webrtcOff: {
    modes: ["anonymous"],
    strict: { "media.peerconnection.enabled": false },
  },
  // Breaks clocks and calendars on websites; off even in Strict.
  utcTimezone: {
    modes: ["anonymous"],
    fpp: ["JSDateTimeUTC"],
  },
  httpsOnly: {
    modes: ["strict", "anonymous"],
    strict: {
      "dom.security.https_only_mode": true,
      "dom.security.https_only_mode_pbm": true,
    },
  },
  // Sign-in flows that rely on storage-access heuristics ask for permission
  // instead of being let through automatically.
  noStorageHeuristics: {
    modes: ["strict", "anonymous"],
    strict: {
      "privacy.restrict3rdpartystorage.heuristic.opened_window_after_interaction": false,
      "privacy.restrict3rdpartystorage.heuristic.redirect": false,
      "privacy.restrict3rdpartystorage.heuristic.recently_visited": false,
      "privacy.restrict3rdpartystorage.heuristic.window_open": false,
    },
  },
  // No browsing history: Places records no visits, and the address bar
  // suggests only bookmarks. History already kept stays until cleared
  // (Settings › History, about:history).
  noHistory: {
    modes: ["strict", "anonymous"],
    strict: { "places.history.enabled": false },
  },
  // Social-network widgets (like buttons, embedded feeds) from other sites.
  blockSocial: {
    modes: ["strict", "anonymous"],
    strict: {
      "privacy.trackingprotection.socialtracking.enabled": true,
    },
  },
  // No referrer at all to other sites. Advanced only: no mode turns it on,
  // since Tor Browser and Mullvad Browser send the origin, and some
  // payment and sign-in pages check it.
  hideReferrer: {
    modes: [],
    strict: { "network.http.referer.XOriginPolicy": 1 },
  },
  // Gecko's resistFingerprinting: pages see the same values as every other
  // Tor Browser, Mullvad Browser and Firefox user with it on (screen, fonts,
  // time zone UTC, light color scheme, user agent, timers and more).
  resistFingerprinting: {
    modes: ["anonymous"],
    strict: {
      "privacy.resistFingerprinting": true,
      "privacy.resistFingerprinting.pbmode": true,
    },
  },
  // Pages and requests ask for English, whatever the desktop language is.
  // Gecko only applies it while resistFingerprinting is on.
  spoofEnglish: {
    modes: ["anonymous"],
    strict: { "privacy.spoof_english": 2 },
  },
  // Margins around pages, so the page size reveals nothing about the window
  // (letterbox.js).
  letterboxing: {
    modes: ["anonymous"],
    strict: { "privacy.resistFingerprinting.letterboxing": true },
  },
};

export const MODES = ["standard", "strict", "anonymous"];

function defaultValue(name) {
  let branch = Services.prefs.getDefaultBranch("");
  switch (branch.getPrefType(name)) {
    case branch.PREF_BOOL:
      return branch.getBoolPref(name);
    case branch.PREF_INT:
      return branch.getIntPref(name);
    case branch.PREF_STRING:
      return branch.getStringPref(name);
  }
  return undefined;
}

function currentValue(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(name);
    case Services.prefs.PREF_STRING:
      return Services.prefs.getStringPref(name);
  }
  return undefined;
}

function setValue(name, value) {
  // Writing the default back as a user pref would pin it; clear instead so
  // future default changes still apply.
  if (value === defaultValue(name)) {
    Services.prefs.clearUserPref(name);
  } else if (typeof value == "boolean") {
    Services.prefs.setBoolPref(name, value);
  } else if (typeof value == "number") {
    Services.prefs.setIntPref(name, value);
  } else {
    Services.prefs.setStringPref(name, value);
  }
}

function fppTargets() {
  return new Set(
    Services.prefs
      .getStringPref(FPP_OVERRIDES, "")
      .split(",")
      .map(s => s.trim())
      .filter(s => s.startsWith("+"))
      .map(s => s.slice(1))
  );
}

function defaultFppTargets() {
  return defaultValue(FPP_OVERRIDES)
    .split(",")
    .map(s => s.trim())
    .filter(s => s.startsWith("+"))
    .map(s => s.slice(1));
}

function setFppTargets(targets) {
  // Keep any overrides this module doesn't own (for example "-Target"
  // entries added by hand in about:config).
  let foreign = Services.prefs
    .getStringPref(FPP_OVERRIDES, "")
    .split(",")
    .map(s => s.trim())
    .filter(s => s && !s.startsWith("+"));
  let value = [...[...targets].sort().map(t => "+" + t), ...foreign].join(",");
  setValue(FPP_OVERRIDES, value);
}

export const PrivacyModes = {
  TOGGLES,

  /** True if the toggle is currently in its strict state. */
  isStrict(id) {
    let toggle = TOGGLES[id];
    if (toggle.fpp) {
      let targets = fppTargets();
      return toggle.fpp.every(t => targets.has(t));
    }
    return Object.entries(toggle.strict).every(
      ([name, value]) => currentValue(name) === value
    );
  },

  setStrict(id, strict) {
    let toggle = TOGGLES[id];
    if (toggle.fpp) {
      let targets = fppTargets();
      for (let t of toggle.fpp) {
        if (strict) {
          targets.add(t);
        } else {
          targets.delete(t);
        }
      }
      // Removing one toggle's targets must not remove another toggle's.
      for (let [otherId, other] of Object.entries(TOGGLES)) {
        if (otherId != id && other.fpp && this.isStrict(otherId)) {
          other.fpp.forEach(t => targets.add(t));
        }
      }
      setFppTargets(targets);
    } else {
      for (let [name, value] of Object.entries(toggle.strict)) {
        setValue(name, strict ? value : defaultValue(name));
      }
    }
    this._recordMode();
  },

  /** Current state of every toggle: { id: strict }. */
  get state() {
    return Object.fromEntries(Object.keys(TOGGLES).map(id => [id, this.isStrict(id)]));
  },

  /** The toggle states a mode stands for. */
  stateForMode(mode) {
    return Object.fromEntries(
      Object.entries(TOGGLES).map(([id, t]) => [id, t.modes.includes(mode)])
    );
  },

  /** A mode from MODES, or "custom", for a { id: strict } state. */
  modeFor(state) {
    for (let mode of MODES) {
      let expected = this.stateForMode(mode);
      if (Object.keys(TOGGLES).every(id => !!state[id] == expected[id])) {
        return mode;
      }
    }
    return "custom";
  },

  /** A mode from MODES, or "custom", from the current prefs. */
  get mode() {
    return this.modeFor(this.state);
  },

  /** Write a whole { id: strict } state, e.g. one previewed on first run. */
  applyState(state) {
    for (let id of Object.keys(TOGGLES)) {
      if (this.isStrict(id) != !!state[id]) {
        this.setStrict(id, !!state[id]);
      }
    }
  },

  setMode(mode) {
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown privacy mode: ${mode}`);
    }
    this.applyState(this.stateForMode(mode));
  },

  /** Toggles whose current value differs from what the running process uses. */
  get pendingRestart() {
    return Object.entries(TOGGLES)
      .filter(([id, t]) => t.restart && this.isStrict(id) != this._startupState[id])
      .map(([id]) => id);
  },

  init() {
    // Device details used to be a Strict toggle; Standard now hides them.
    // A profile that wrote its own target list keeps it, with the new
    // defaults added, and one that matches the defaults goes back to them.
    if (Services.prefs.prefHasUserValue(FPP_OVERRIDES)) {
      setFppTargets(new Set([...fppTargets(), ...defaultFppTargets()]));
    }
    this._startupState = Object.fromEntries(
      Object.keys(TOGGLES).map(id => [id, this.isStrict(id)])
    );
  },

  _startupState: {},

  _recordMode() {
    setValue("browserwip.privacy.mode", this.mode);
    Services.obs.notifyObservers(null, "browserwip:privacy-mode-changed", this.mode);
  },
};
