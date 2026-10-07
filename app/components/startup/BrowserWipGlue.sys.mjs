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
  PrivacyModes: "resource://gre/modules/browserwip/PrivacyModes.sys.mjs",
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
  },
};

export function BrowserWipGlue() {}

BrowserWipGlue.prototype = {
  QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),

  observe(subject, topic) {
    switch (topic) {
      case "app-startup":
        Services.obs.addObserver(this, "final-ui-startup", true);
        break;
      case "final-ui-startup":
        this._onFinalUIStartup();
        break;
    }
  },

  _onFinalUIStartup() {
    // Importing ActorManagerParent registers toolkit's actors (select
    // dropdowns, find bar, form autofill, printing, ...). Apps must do this.
    lazy.ActorManagerParent.addJSWindowActors(JSWINDOWACTORS);
    lazy.PrivacyModes.init();
    lazy.ContentBlockingLists.ensureLoaded().catch(() => {
      // Already reported; pages still load, just without blocking.
    });
  },
};
