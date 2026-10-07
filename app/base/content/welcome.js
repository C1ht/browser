/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global PrivacyControls, PrivacyModes */

"use strict";

const COMPLETED_PREF = "browserwip.firstrun.completed";

let controls;

function finish({ apply }) {
  if (apply) {
    controls.commit();
  }
  Services.prefs.setBoolPref(COMPLETED_PREF, true);
  // JIT settings are read when the browser starts. Nothing is open yet, so
  // restart now rather than run with the old setting.
  if (apply && PrivacyModes.pendingRestart.length) {
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    return;
  }
  location.replace("about:newtab");
}

window.addEventListener("DOMContentLoaded", () => {
  let button = document.getElementById("continue");
  controls = new PrivacyControls({
    cards: document.getElementById("modes"),
    toggles: document.getElementById("toggles"),
    toggleIds: ["jit", "webrtc", "hideDeviceDetails", "utcTimezone"],
    live: false,
    onChange() {
      // Turning off fast JavaScript needs a restart, so say so on the button.
      let restart = controls && controls.state.jit != PrivacyModes.isStrict("jit");
      document.l10n.setAttributes(button, restart ? "welcome-continue-restart" : "welcome-continue");
    },
  });
  button.addEventListener("click", () => finish({ apply: true }));

  document.addEventListener("keydown", e => {
    if (e.key == "Escape") {
      // Leave without applying anything: Standard.
      finish({ apply: false });
    }
  });
  document.getElementById("mode-standard").focus();
});

// Any other way out (typing an address, closing the tab) also counts as done,
// and keeps Standard, which is already in effect.
window.addEventListener("pagehide", () => {
  Services.prefs.setBoolPref(COMPLETED_PREF, true);
});
