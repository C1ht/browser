/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global PrivacyControls */

"use strict";

const { ContentBlockingLists } = ChromeUtils.importESModule(
  "resource://gre/modules/browserwip/ContentBlockingLists.sys.mjs"
);

window.addEventListener("DOMContentLoaded", () => {
  let restartRow = document.getElementById("restart-row");
  new PrivacyControls({
    cards: document.getElementById("modes"),
    toggles: document.getElementById("toggles"),
    toggleIds: [
      "httpsOnly",
      "hideDeviceDetails",
      "blockSocial",
      "jit",
      "webrtc",
      "noStorageHeuristics",
      "utcTimezone",
      "webrtcOff",
    ],
    live: true,
    onChange(mode, pendingRestart) {
      restartRow.hidden = !pendingRestart.length;
    },
  });
  document.getElementById("restart").addEventListener("click", () => {
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
  });

  // Search engine.
  let engine = document.getElementById("search-engine");
  engine.value = Services.prefs.getStringPref("browserwip.search.engine", "brave");
  engine.addEventListener("change", () => {
    Services.prefs.setStringPref("browserwip.search.engine", engine.value);
  });

  // Appearance.
  let appearance = document.querySelectorAll("#appearance [data-value]");
  let syncAppearance = () => {
    let current = Services.prefs.getStringPref("browserwip.appearance", "auto");
    for (let b of appearance) {
      b.setAttribute("aria-checked", String(b.dataset.value == current));
    }
  };
  for (let b of appearance) {
    b.addEventListener("click", () => {
      Services.prefs.setStringPref("browserwip.appearance", b.dataset.value);
      syncAppearance();
    });
  }
  syncAppearance();

  // About.
  document.l10n.setAttributes(document.getElementById("version"), "settings-about-version", {
    version: Services.appinfo.version,
    gecko: Services.appinfo.platformVersion,
  });
  try {
    let { snapshot } = ContentBlockingLists.stats;
    document.getElementById("lists-snapshot").textContent = snapshot ?? "";
  } catch (e) {
    // Lists missing from a broken build; the rest of the page still works.
  }

  // Deep links: about:settings#search
  if (location.hash) {
    document.querySelector(location.hash)?.scrollIntoView();
  }
});
