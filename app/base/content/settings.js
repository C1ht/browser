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
  let privacyControls = new PrivacyControls({
    cards: document.getElementById("modes"),
    toggles: document.getElementById("toggles"),
    toggleIds: [
      "httpsOnly",
      "blockSocial",
      "noHistory",
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
    syncSuggest();
  });

  // Search suggestions: opt-in, and only where the engine has them.
  let { Library, SUGGEST_PREF, currentEngine } = ChromeUtils.importESModule(
    "resource://gre/modules/browserwip/Library.sys.mjs"
  );
  let suggest = document.getElementById("search-suggest");
  let syncSuggest = () => {
    let current = currentEngine();
    suggest.disabled = !current.suggest;
    suggest.setAttribute("aria-checked", String(!!current.suggest && Services.prefs.getBoolPref(SUGGEST_PREF, false)));
    document.l10n.setAttributes(
      document.getElementById("search-suggest-help"),
      current.suggest ? "settings-search-suggest-help" : "settings-search-suggest-none",
      { engine: current.name }
    );
  };
  suggest.addEventListener("click", () => {
    Services.prefs.setBoolPref(SUGGEST_PREF, suggest.getAttribute("aria-checked") != "true");
    syncSuggest();
  });
  document.getElementById("search-suggest-label").addEventListener("click", e => {
    e.preventDefault();
    suggest.click();
  });
  syncSuggest();

  // History: remembered unless the privacy mode (or this switch) says not.
  let remember = document.getElementById("history-remember");
  let syncHistory = () => {
    remember.setAttribute("aria-checked", String(Library.historyEnabled));
    privacyControls.refresh();
  };
  remember.addEventListener("click", () => {
    Library.setHistoryEnabled(!Library.historyEnabled);
    syncHistory();
  });
  document.getElementById("history-remember-label").addEventListener("click", e => {
    e.preventDefault();
    remember.click();
  });
  let openHistory = hash => {
    let win = window.browsingContext.topChromeWindow;
    let url = "about:history" + hash;
    let existing = win?.gBrowser.tabs.find(t => t.linkedBrowser.currentURI?.spec.startsWith("about:history"));
    if (existing) {
      win.gBrowser.selectTab(existing);
      if (hash) {
        existing.linkedBrowser.loadURI(Services.io.newURI(url), {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        });
      }
    } else {
      win?.gBrowser.addTab(url);
    }
  };
  document.getElementById("history-clear").addEventListener("click", () => openHistory("#clear"));
  document.getElementById("history-open").addEventListener("click", () => openHistory(""));
  Services.prefs.addObserver("places.history.enabled", syncHistory);
  window.addEventListener("unload", () => Services.prefs.removeObserver("places.history.enabled", syncHistory));
  syncHistory();

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
    // This computer only: where there's a TPM; needs a recovery key first.
    let device = PasswordVault.device;
    $("passwords-device-row").hidden = !device.available || state == "none";
    $("passwords-device").setAttribute("aria-checked", String(device.bound));
    $("passwords-device").disabled = !unlocked;
    if (!unlocked) {
      $("passwords-device-form").hidden = true;
    }
    // The recovery key: making one needs the vault unlocked and the master
    // password (§6).
    $("passwords-recovery-row").hidden = state == "none";
    document.l10n.setAttributes(
      $("passwords-recovery-status"),
      PasswordVault.hasRecoveryKey ? "settings-passwords-recovery-set" : "settings-passwords-recovery-none"
    );
    document.l10n.setAttributes(
      $("passwords-recovery"),
      PasswordVault.hasRecoveryKey ? "settings-passwords-recovery-replace" : "settings-passwords-recovery-create"
    );
    $("passwords-recovery").disabled = !unlocked || !$("passwords-recovery-shown").hidden;
    if (!unlocked) {
      $("passwords-recovery-form").hidden = true;
      hideRecoveryKey();
    }
    PasswordVault.olderVaults().then(names => {
      $("passwords-older-row").hidden = !names.length || state == "none";
    });
    $("passwords-offer").setAttribute("aria-checked", String(Services.prefs.getBoolPref(OFFER_PREF, true)));
    let minutes = String(Services.prefs.getIntPref(LOCK_PREF, 15));
    for (let b of document.querySelectorAll("#passwords-lock-after [data-value]")) {
      b.setAttribute("aria-checked", String(b.dataset.value == minutes));
    }
  };
  let deviceResult = l10n => {
    document.l10n.setAttributes($("passwords-device-result"), l10n);
    $("passwords-device-result").hidden = false;
  };
  $("passwords-device").addEventListener("click", () => {
    $("passwords-device-result").hidden = true;
    let bound = PasswordVault.device.bound;
    if (!bound && !PasswordVault.hasRecoveryKey) {
      deviceResult("settings-passwords-device-needs-recovery");
      return;
    }
    document.l10n.setAttributes(
      $("passwords-device-submit"),
      bound ? "settings-passwords-device-off" : "settings-passwords-device-on"
    );
    $("passwords-device-form").hidden = false;
    $("passwords-device-master").focus();
  });
  $("passwords-device-label").addEventListener("click", e => {
    e.preventDefault();
    $("passwords-device").click();
  });
  $("passwords-device-cancel").addEventListener("click", () => {
    $("passwords-device-master").value = "";
    $("passwords-device-form").hidden = true;
  });
  $("passwords-device-form").addEventListener("submit", async e => {
    e.preventDefault();
    let submit = $("passwords-device-submit");
    let bound = PasswordVault.device.bound;
    submit.disabled = true;
    try {
      let master = $("passwords-device-master").value;
      await (bound ? PasswordVault.disableDeviceBinding(master) : PasswordVault.enableDeviceBinding(master));
      $("passwords-device-form").hidden = true;
      deviceResult(bound ? "settings-passwords-device-is-off" : "settings-passwords-device-is-on");
    } catch (err) {
      deviceResult(
        {
          "wrong-password": "passwords-wrong-password",
          "needs-recovery-key": "settings-passwords-device-needs-recovery",
        }[err.code] ?? "settings-passwords-device-error"
      );
    } finally {
      $("passwords-device-master").value = "";
      submit.disabled = false;
      syncPasswords();
    }
  });
  let hideRecoveryKey = () => {
    $("passwords-recovery-code").replaceChildren();
    $("passwords-recovery-shown").hidden = true;
  };
  $("passwords-recovery").addEventListener("click", () => {
    $("passwords-recovery-result").hidden = true;
    $("passwords-recovery-form").hidden = false;
    $("passwords-recovery-master").focus();
  });
  $("passwords-recovery-cancel").addEventListener("click", () => {
    $("passwords-recovery-master").value = "";
    $("passwords-recovery-form").hidden = true;
  });
  $("passwords-recovery-form").addEventListener("submit", async e => {
    e.preventDefault();
    let submit = $("passwords-recovery-submit");
    submit.disabled = true;
    try {
      let code = await PasswordVault.newRecoveryKey($("passwords-recovery-master").value);
      $("passwords-recovery-form").hidden = true;
      $("passwords-recovery-code").replaceChildren(
        ...code.split("-").map(group => {
          let span = document.createElement("span");
          span.textContent = group;
          return span;
        })
      );
      $("passwords-recovery-shown").hidden = false;
      $("passwords-recovery-done").focus();
    } catch (err) {
      document.l10n.setAttributes(
        $("passwords-recovery-result"),
        err.code == "wrong-password" ? "passwords-wrong-password" : "passwords-error"
      );
      $("passwords-recovery-result").hidden = false;
    } finally {
      $("passwords-recovery-master").value = "";
      submit.disabled = false;
      syncPasswords();
    }
  });
  $("passwords-recovery-print").addEventListener("click", () => window.print());
  $("passwords-recovery-done").addEventListener("click", () => {
    hideRecoveryKey();
    syncPasswords();
  });
  $("passwords-older").addEventListener("click", () => {
    window.browsingContext.topChromeWindow?.PasswordsUI?.openManager("open-older");
  });
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
  // Replace encryption key (docs/PASSWORDS.md §4.2): from its own form
  // (the same master password) or from a password change with "my old
  // password may have been exposed" ticked (the new one). Resolves true
  // once the new vault is in use.
  let replaceKey = async (current, fresh, confirmation) => {
    let status = $("passwords-replace-status");
    $("passwords-replace-done").hidden = true;
    document.l10n.setAttributes(
      status,
      PasswordVault.replacementHelloPrompts ? "settings-passwords-replace-working-hello" : "settings-passwords-replace-working"
    );
    status.hidden = false;
    let code;
    try {
      code = await PasswordVault.replacePrepare(current, fresh, confirmation);
    } finally {
      status.hidden = true;
    }
    if (code) {
      // The new recovery key, before anything changes: it works only once
      // the replacement is done, and "I have stored it" is what does it.
      $("passwords-replace-code").replaceChildren(
        ...code.split("-").map(group => {
          let span = document.createElement("span");
          span.textContent = group;
          return span;
        })
      );
      $("passwords-replace-shown").hidden = false;
      $("passwords-replace-stored").focus();
      let stored = await new Promise(resolve => {
        $("passwords-replace-stored").onclick = () => resolve(true);
        $("passwords-replace-cancel").onclick = () => resolve(false);
      });
      $("passwords-replace-code").replaceChildren();
      $("passwords-replace-shown").hidden = true;
      if (!stored) {
        await PasswordVault.replaceAbort();
        return false;
      }
    }
    await PasswordVault.replaceCommit();
    document.l10n.setAttributes(
      $("passwords-replace-done-text"),
      code ? "settings-passwords-replaced-recovery" : "settings-passwords-replaced"
    );
    $("passwords-replace-done").hidden = false;
    return true;
  };
  let replaceError = err =>
    ({
      "wrong-password": "passwords-wrong-password",
      "too-short": "passwords-too-short",
      mismatch: "passwords-mismatch",
      cancelled: "settings-passwords-replace-cancelled",
    })[err.code] ?? "passwords-error";
  $("passwords-replace-print").addEventListener("click", () => window.print());
  $("passwords-replace-form").addEventListener("submit", async e => {
    e.preventDefault();
    let submit = $("passwords-replace-submit");
    let result = $("passwords-change-result");
    let master = $("passwords-replace-master").value;
    $("passwords-replace-master").value = "";
    submit.disabled = true;
    result.hidden = true;
    try {
      if (!(await replaceKey(master, master))) {
        result.removeAttribute("error");
        document.l10n.setAttributes(result, "settings-passwords-replace-aborted");
        result.hidden = false;
      }
    } catch (err) {
      result.setAttribute("error", "true");
      document.l10n.setAttributes(result, replaceError(err));
      result.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  $("passwords-change-form").addEventListener("submit", async e => {
    e.preventDefault();
    let result = $("passwords-change-result");
    let submit = $("passwords-change-submit");
    submit.disabled = true;
    try {
      if ($("passwords-exposed").checked) {
        // The new password wraps a new key: copies of the vault made with
        // the old password don't open the vault from now on.
        result.hidden = true;
        if (!(await replaceKey($("passwords-current").value, $("passwords-new").value, $("passwords-repeat").value))) {
          result.removeAttribute("error");
          document.l10n.setAttributes(result, "settings-passwords-replace-aborted");
          return;
        }
        $("passwords-exposed").checked = false;
      } else {
        await PasswordVault.changeMasterPassword(
          $("passwords-current").value,
          $("passwords-new").value,
          $("passwords-repeat").value
        );
      }
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
      document.l10n.setAttributes(result, ids[err.code] ?? replaceError(err));
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
