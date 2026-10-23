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

  // Startup: a new tab, or the previous session.
  let startup = document.querySelectorAll("#startup [data-value]");
  let syncStartup = () => {
    let restore = Services.prefs.getBoolPref("browserwip.startup.restoreSession", false);
    for (let b of startup) {
      b.setAttribute("aria-checked", String((b.dataset.value == "restore") == restore));
    }
  };
  for (let b of startup) {
    b.addEventListener("click", () => {
      Services.prefs.setBoolPref("browserwip.startup.restoreSession", b.dataset.value == "restore");
      syncStartup();
    });
  }
  syncStartup();

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

  // Passwords (docs/PASSWORDS.md §12).
  let { PasswordVault, LOCK_PREF, OFFER_PREF } = ChromeUtils.importESModule(
    "resource://gre/modules/browserwip/PasswordVault.sys.mjs"
  );
  let $ = id => document.getElementById(id);
  let syncPasswords = () => {
    let state = PasswordVault.state;
    let unlocked = state == "unlocked";
    if (unlocked) {
      document.l10n.setAttributes($("passwords-status"), "settings-passwords-unlocked", {
        count: PasswordVault.entries().length,
      });
    } else {
      document.l10n.setAttributes(
        $("passwords-status"),
        state == "locked" ? "settings-passwords-locked" : "settings-passwords-none"
      );
    }
    $("passwords-lock").hidden = !unlocked;
    // Changing the master password needs the vault unlocked; importing and
    // exporting unlock first, on about:passwords.
    $("passwords-change-box").hidden = !unlocked;
    $("passwords-transfer-row").hidden = state != "unlocked" && state != "locked";
    // Windows Hello: offered where it works; turning it on or off needs the
    // vault unlocked.
    let hello = PasswordVault.hello;
    $("passwords-hello-row").hidden = !hello.available || state == "none";
    $("passwords-hello").setAttribute("aria-checked", String(hello.enrolled));
    $("passwords-hello").disabled = !unlocked;
    if (!unlocked) {
      $("passwords-hello-form").hidden = true;
    }
    $("passwords-offer").setAttribute("aria-checked", String(Services.prefs.getBoolPref(OFFER_PREF, true)));
    let minutes = String(Services.prefs.getIntPref(LOCK_PREF, 15));
    for (let b of document.querySelectorAll("#passwords-lock-after [data-value]")) {
      b.setAttribute("aria-checked", String(b.dataset.value == minutes));
    }
  };
  $("passwords-lock").addEventListener("click", () => PasswordVault.lock());
  $("passwords-manage").addEventListener("click", () => {
    window.browsingContext.topChromeWindow?.PasswordsUI?.openManager();
  });
  for (let which of ["import", "export"]) {
    $(`passwords-${which}`).addEventListener("click", () => {
      window.browsingContext.topChromeWindow?.PasswordsUI?.openManager(which);
    });
  }
  let helloResult = l10n => {
    document.l10n.setAttributes($("passwords-hello-result"), l10n);
    $("passwords-hello-result").hidden = false;
  };
  $("passwords-hello").addEventListener("click", async () => {
    $("passwords-hello-result").hidden = true;
    if (PasswordVault.hello.enrolled) {
      await PasswordVault.disableHello().catch(() => helloResult("settings-passwords-hello-error"));
      syncPasswords();
    } else {
      $("passwords-hello-form").hidden = false;
      $("passwords-hello-master").focus();
    }
  });
  $("passwords-hello-label").addEventListener("click", e => {
    e.preventDefault();
    $("passwords-hello").click();
  });
  $("passwords-hello-cancel").addEventListener("click", () => {
    $("passwords-hello-master").value = "";
    $("passwords-hello-form").hidden = true;
  });
  $("passwords-hello-form").addEventListener("submit", async e => {
    e.preventDefault();
    let submit = $("passwords-hello-submit");
    submit.disabled = true;
    try {
      await PasswordVault.enableHello($("passwords-hello-master").value);
      $("passwords-hello-form").hidden = true;
      helloResult("settings-passwords-hello-on");
    } catch (err) {
      helloResult(
        {
          "wrong-password": "passwords-wrong-password",
          cancelled: "settings-passwords-hello-cancelled",
        }[err.code] ?? "settings-passwords-hello-error"
      );
    } finally {
      $("passwords-hello-master").value = "";
      submit.disabled = false;
      syncPasswords();
    }
  });
  $("passwords-offer").addEventListener("click", () => {
    Services.prefs.setBoolPref(OFFER_PREF, $("passwords-offer").getAttribute("aria-checked") != "true");
    syncPasswords();
  });
  $("passwords-offer-label").addEventListener("click", e => {
    e.preventDefault();
    $("passwords-offer").click();
  });
  for (let b of document.querySelectorAll("#passwords-lock-after [data-value]")) {
    b.addEventListener("click", () => {
      Services.prefs.setIntPref(LOCK_PREF, Number(b.dataset.value));
      syncPasswords();
    });
  }
  $("passwords-change-form").addEventListener("submit", async e => {
    e.preventDefault();
    let result = $("passwords-change-result");
    let submit = $("passwords-change-submit");
    submit.disabled = true;
    try {
      await PasswordVault.changeMasterPassword(
        $("passwords-current").value,
        $("passwords-new").value,
        $("passwords-repeat").value
      );
      result.removeAttribute("error");
      document.l10n.setAttributes(result, "settings-passwords-changed");
      for (let id of ["passwords-current", "passwords-new", "passwords-repeat"]) {
        $(id).value = "";
      }
    } catch (err) {
      result.setAttribute("error", "true");
      let ids = {
        "wrong-password": "passwords-wrong-password",
        "too-short": "passwords-too-short",
        mismatch: "passwords-mismatch",
      };
      document.l10n.setAttributes(result, ids[err.code] ?? "passwords-error");
    } finally {
      result.hidden = false;
      submit.disabled = false;
    }
  });
  let onPasswords = () => syncPasswords();
  Services.obs.addObserver(onPasswords, "browserwip:passwords-state");
  Services.obs.addObserver(onPasswords, "browserwip:passwords-changed");
  window.addEventListener("unload", () => {
    Services.obs.removeObserver(onPasswords, "browserwip:passwords-state");
    Services.obs.removeObserver(onPasswords, "browserwip:passwords-changed");
  });
  syncPasswords();
  PasswordVault.init()
    .catch(() => {})
    .then(syncPasswords);

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
