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
      "blockSocial",
      "jit",
      "webrtc",
      "noStorageHeuristics",
      "webrtcOff",
      "resistFingerprinting",
      "utcTimezone",
      "spoofEnglish",
      "letterboxing",
      "hideReferrer",
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

  // Downloads: the folder files are saved to, or ask each time.
  let { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");
  let folder = document.getElementById("downloads-folder");
  let ask = document.getElementById("downloads-ask");
  let syncDownloads = async () => {
    folder.textContent = await Downloads.getPreferredDownloadsDirectory();
    let asking = !Services.prefs.getBoolPref("browser.download.useDownloadDir", true);
    ask.setAttribute("aria-checked", String(asking));
  };
  ask.addEventListener("click", () => {
    let asking = ask.getAttribute("aria-checked") == "true";
    Services.prefs.setBoolPref("browser.download.useDownloadDir", asking);
    syncDownloads();
  });
  document.getElementById("downloads-ask-label").addEventListener("click", e => {
    e.preventDefault();
    ask.click();
  });
  document.getElementById("downloads-change").addEventListener("click", async () => {
    let picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    let [title] = await document.l10n.formatValues(["settings-downloads-picker-title"]);
    picker.init(window.browsingContext, title, Ci.nsIFilePicker.modeGetFolder);
    let current = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    current.initWithPath(await Downloads.getPreferredDownloadsDirectory());
    picker.displayDirectory = current;
    let result = await new Promise(resolve => picker.open(resolve));
    if (result == Ci.nsIFilePicker.returnOK) {
      // 2: a folder of the user's choosing (browser.download.dir).
      Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, picker.file);
      Services.prefs.setIntPref("browser.download.folderList", 2);
      syncDownloads();
    }
  });
  syncDownloads();

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
