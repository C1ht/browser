/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * App startup, the counterpart of Firefox's BrowserGlue. Instantiated through
 * the app-startup category, before any window opens.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ActorManagerParent: "resource://gre/modules/ActorManagerParent.sys.mjs",
  ContentBlockingLists: "resource://gre/modules/browserwip/ContentBlockingLists.sys.mjs",
  ContentPermissionPrompt: "resource://gre/modules/browserwip/ContentPermissionPrompt.sys.mjs",
  PrivacyModes: "resource://gre/modules/browserwip/PrivacyModes.sys.mjs",
  SessionStore: "resource://gre/modules/browserwip/SessionStore.sys.mjs",
});

const JSWINDOWACTORS = {
  ContentBlocking: {
    child: {
      esModuleURI: "resource://gre/modules/browserwip/ContentBlockingChild.sys.mjs",
      events: {
        // Fired when the root element is inserted, before the first layout.
        DOMDocElementInserted: { capture: true },
      },
    },
    matches: ["http://*/*", "https://*/*"],
    allFrames: true,
    // Runs in ordinary web processes. Safe there: the child only adds
    // stylesheets and never messages the parent.
    safeForUntrustedWebProcess: true,
  },
  // The right-click menu on pages (contextmenu.js). As Firefox's: safe in
  // web processes because the parent trusts nothing it sends.
  ContextMenu: {
    parent: {
      esModuleURI: "resource://gre/modules/browserwip/ContextMenuParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/browserwip/ContextMenuChild.sys.mjs",
      events: {
        contextmenu: { mozSystemGroup: true },
      },
    },
    allFrames: true,
    safeForUntrustedWebProcess: true,
  },
  // Middle-click and Ctrl+click on links open a new tab (LinkClickChild).
  LinkClick: {
    parent: {
      esModuleURI: "resource://gre/modules/browserwip/LinkClickParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/browserwip/LinkClickChild.sys.mjs",
      events: {
        chromelinkclick: { capture: true, mozSystemGroup: true },
      },
    },
    messageManagerGroups: ["browsers"],
    allFrames: true,
    safeForUntrustedWebProcess: true,
  },
  // Site icons on tabs (FaviconChild.sys.mjs).
  Favicon: {
    parent: {
      esModuleURI: "resource://gre/modules/browserwip/FaviconParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/browserwip/FaviconChild.sys.mjs",
      events: {
        DOMLinkAdded: {},
        DOMLinkChanged: {},
        pageshow: {},
      },
    },
    matches: ["http://*/*", "https://*/*"],
    safeForUntrustedWebProcess: true,
  },
  // Camera, microphone and screen sharing (WebRTCChild.sys.mjs).
  WebRTC: {
    parent: {
      esModuleURI: "resource://gre/modules/browserwip/WebRTCParent.sys.mjs",
    },
    child: {
      esModuleURI: "resource://gre/modules/browserwip/WebRTCChild.sys.mjs",
    },
    allFrames: true,
    safeForUntrustedWebProcess: true,
  },
};

// Gecko asks for camera and microphone access, and for permission to make a
// WebRTC connection, through observer notifications in each content process.
const JSPROCESSACTORS = {
  WebRTCProcess: {
    child: {
      esModuleURI: "resource://gre/modules/browserwip/WebRTCChild.sys.mjs",
      observers: [
        "getUserMedia:request",
        "PeerConnection:request",
        "recording-device-events",
        "recording-window-ended",
      ],
    },
    safeForUntrustedWebProcess: true,
  },
};

// The permission prompt Gecko asks for location, notifications and other
// site permissions. Registered here rather than in components.conf so it
// stays with the rest of the app's front end.
const CONTENT_PERMISSION_PROMPT_CID = Components.ID("{5d0b7e8c-3f41-4b6e-9a2d-7c1e8f4a6b93}");

function registerPermissionPrompt() {
  Components.manager
    .QueryInterface(Ci.nsIComponentRegistrar)
    .registerFactory(
      CONTENT_PERMISSION_PROMPT_CID,
      "browser-wip content permission prompt",
      "@mozilla.org/content-permission/prompt;1",
      {
        createInstance(iid) {
          return new lazy.ContentPermissionPrompt().QueryInterface(iid);
        },
      }
    );
}

/**
 * Appearance: Light, Dark or Auto, applied to the browser and to web pages
 * together and live. Gecko's values: 0 dark, 1 light, 2 follow the system.
 */
const APPEARANCE_PREF = "browserwip.appearance";
const APPEARANCE_VALUES = { dark: 0, light: 1, auto: 2 };

function applyAppearance() {
  let value = APPEARANCE_VALUES[Services.prefs.getStringPref(APPEARANCE_PREF, "auto")] ?? 2;
  Services.prefs.setIntPref("browser.theme.toolbar-theme", value);
  Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", value);
}

export function BrowserWipGlue() {}

BrowserWipGlue.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),

  observe(subject, topic) {
    switch (topic) {
      case "app-startup":
        Services.obs.addObserver(this, "final-ui-startup", true);
        Services.obs.addObserver(this, "browser-delayed-startup-finished", true);
        break;
      case "browser-delayed-startup-finished":
        // After the first window is up and idle, startup is done. Firefox
        // sends this topic too; Marionette and others wait for it.
        Services.obs.removeObserver(this, "browser-delayed-startup-finished");
        Services.tm.idleDispatchToMainThread(() =>
          Services.obs.notifyObservers(null, "browser-idle-startup-tasks-finished")
        );
        break;
      case "final-ui-startup":
        this._onFinalUIStartup();
        break;
    }
  },

  _onFinalUIStartup() {
    // Importing ActorManagerParent registers toolkit's actors (select
    // dropdowns, find bar, form autofill, printing, ...). Apps must do this.
    try {
      lazy.ContentBlockingLists.publishCosmeticIndex();
    } catch (e) {
      console.error("browser-wip: element-hiding rules unavailable", e);
    }
    lazy.ActorManagerParent.addJSWindowActors(JSWINDOWACTORS);
    lazy.ActorManagerParent.addJSProcessActors(JSPROCESSACTORS);
    registerPermissionPrompt();
    applyAppearance();
    Services.prefs.addObserver(APPEARANCE_PREF, applyAppearance);
    lazy.PrivacyModes.init();
    lazy.SessionStore.init();
    lazy.ContentBlockingLists.ensureLoaded().catch(() => {
      // Already reported; pages still load, just without blocking.
    });
  },
};
