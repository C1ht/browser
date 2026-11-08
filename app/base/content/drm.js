/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * DRM notices, under the site information button (EncryptedMediaParent
 * calls these): Widevine being installed for a page, the install failing,
 * or DRM being off when a page wants it, with a button that turns it on.
 *
 * Each tab keeps its latest notice until its page changes; the selected
 * tab's shows. A page asking again (they do, for each video) doesn't bring
 * back a notice that was dismissed. The install notice shows its progress,
 * and when the install ends, every tab's install notice closes, or turns
 * into the failure notice with Try again.
 */

ChromeUtils.defineESModuleGetters(this, {
  Widevine: "resource://gre/modules/browserwip/Widevine.sys.mjs",
});

var DrmNotices = {
  init() {
    this.panel = document.getElementById("drm-panel");
    this.text = document.getElementById("drm-text");
    this.turnOn = document.getElementById("drm-turn-on");
    this.dismiss = document.getElementById("drm-dismiss");
    this.anchor = document.getElementById("identity-button");
    // browser -> { kind, dismissed }
    this.notices = new WeakMap();

    this.turnOn.addEventListener("click", () => {
      let browser = gBrowser.selectedBrowser;
      if (this.notices.get(browser)?.kind == "disabled") {
        PrivacyModes.setStrict("noDrm", false);
      }
      // Turn on DRM, or Try again after a failed install: the page asks anew.
      this._close(browser);
      browser.reload();
    });
    let onProgress = () => {
      if (this.notices.get(gBrowser.selectedBrowser)?.kind == "installing") {
        this._show();
      }
    };
    let onDone = (subject, topic, result) => {
      for (let browser of gBrowser.browsers) {
        if (this.notices.get(browser)?.kind == "installing") {
          if (result == "installed") {
            this._close(browser);
          } else {
            this._set(browser, "failed");
          }
        }
      }
    };
    Services.obs.addObserver(onProgress, Widevine.PROGRESS_TOPIC);
    Services.obs.addObserver(onDone, Widevine.DONE_TOPIC);
    window.addEventListener(
      "unload",
      () => {
        Services.obs.removeObserver(onProgress, Widevine.PROGRESS_TOPIC);
        Services.obs.removeObserver(onDone, Widevine.DONE_TOPIC);
      },
      { once: true }
    );
    this.dismiss.addEventListener("click", () => this._close(gBrowser.selectedBrowser));
    this.panel.addEventListener("popuphidden", () => {
      let notice = this.notices.get(gBrowser.selectedBrowser);
      if (notice && notice.kind != "installing") {
        notice.dismissed = true;
      }
    });
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._show());
    gBrowser.tabContainer.addEventListener("TabLocationChange", e => {
      if (!e.detail?.sameDocument) {
        this.notices.delete(e.target.linkedBrowser);
        this._show();
      }
    });
  },

  installing(browser) {
    this._set(browser, "installing");
  },

  disabled(browser) {
    let notice = this.notices.get(browser);
    if (notice?.kind == "disabled" && notice.dismissed) {
      return;
    }
    this._set(browser, "disabled");
  },

  _set(browser, kind) {
    this.notices.set(browser, { kind, dismissed: false });
    if (browser == gBrowser.selectedBrowser) {
      this._show();
    }
  },

  _close(browser) {
    this.notices.delete(browser);
    if (browser == gBrowser.selectedBrowser) {
      this.panel.hidePopup();
    }
  },

  _show() {
    let notice = this.notices.get(gBrowser.selectedBrowser);
    if (!notice || notice.dismissed) {
      this.panel.hidePopup();
      return;
    }
    this.panel.setAttribute("kind", notice.kind);
    let progress = Widevine.progress;
    if (notice.kind == "installing" && progress?.stage == "downloading" && progress.total) {
      let mb = bytes => Math.round(bytes / (1024 * 1024));
      document.l10n.setAttributes(this.text, "drm-downloading", { received: mb(progress.received), total: mb(progress.total) });
    } else if (notice.kind == "installing" && progress?.stage == "unpacking") {
      document.l10n.setAttributes(this.text, "drm-unpacking");
    } else {
      document.l10n.setAttributes(this.text, `drm-${notice.kind}`);
    }
    this.turnOn.hidden = notice.kind == "installing";
    document.l10n.setAttributes(this.turnOn, notice.kind == "failed" ? "drm-try-again" : "drm-turn-on");
    this.dismiss.hidden = notice.kind == "installing";
    document.l10n.setAttributes(this.dismiss, notice.kind == "disabled" ? "drm-not-now" : "drm-ok");
    if (this.panel.state == "closed" || this.panel.state == "hiding") {
      this.panel.openPopup(this.anchor, "bottomleft topleft", 0, 4);
    }
  },
};
