/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

"use strict";

/**
 * Security key prompts (WebAuthn: passkeys and two-step verification on a
 * USB key), under the site information button. Gecko's WebAuthn service
 * asks for them with the observer topic "webauthn-prompt", as it asks
 * Firefox's window (toolkit's WebAuthnPromptHelper, whose strings these
 * are), and is answered through nsIWebAuthnService:
 *   presence            touch your key, or Cancel
 *   pin-required/-invalid  the key's PIN
 *   select-sign-result  which of the key's accounts to sign in with
 *   attestation-consent the site wants to know which key it is: Allow or
 *                       Block (it then gets an anonymous answer)
 *   the rest            what went wrong, with Cancel
 * A "cancel" from the service closes the prompt; so does the page going
 * away. Escape is Cancel. Each prompt belongs to its tab and shows while
 * its tab does.
 *
 * Passkeys kept in the browser itself (a platform authenticator) aren't
 * available yet: Gecko on Linux offers USB keys only.
 */

var WebAuthnPrompts = {
  // Prompts that only say something, with Cancel.
  INFO: {
    "already-registered": "webauthn-already-registered-prompt",
    "select-device": "webauthn-select-device-prompt",
    "pin-auth-blocked": "webauthn-pin-auth-blocked-prompt",
    "uv-blocked": "webauthn-uv-blocked-prompt",
    "device-blocked": "webauthn-device-blocked-prompt",
    "pin-not-set": "webauthn-pin-not-set-prompt",
  },

  init() {
    let $ = id => document.getElementById(id);
    this.panel = $("webauthn-panel");
    this.text = $("webauthn-text");
    this.hint = $("webauthn-hint");
    this.note = $("webauthn-note");
    this.pinForm = $("webauthn-pin-form");
    this.pin = $("webauthn-pin");
    this.accounts = $("webauthn-accounts");
    this.cancelButton = $("webauthn-cancel");
    this.blockButton = $("webauthn-block");
    this.allowButton = $("webauthn-allow");
    this.anchor = $("identity-button");
    // { tid, browser, type, data }: the one request the service has open.
    this._current = null;

    this.cancelButton.addEventListener("click", () => this._cancel());
    this.allowButton.addEventListener("click", () => this._answer(service => service.setHasAttestationConsent(this._current.tid, true)));
    this.blockButton.addEventListener("click", () => this._answer(service => service.setHasAttestationConsent(this._current.tid, false)));
    this.pinForm.addEventListener("submit", e => {
      e.preventDefault();
      let pin = this.pin.value;
      this.pin.value = "";
      this._answer(service => service.pinCallback(this._current.tid, pin));
    });
    this.panel.addEventListener("keydown", e => {
      if (e.key == "Escape") {
        e.preventDefault();
        this._cancel();
      }
    });
    this.panel.addEventListener("popuphidden", () => (this.pin.value = ""));
    gBrowser.tabContainer.addEventListener("TabSelect", () => this._show());

    Services.obs.addObserver(this, "webauthn-prompt");
    window.addEventListener("unload", () => Services.obs.removeObserver(this, "webauthn-prompt"), { once: true });
  },

  get _service() {
    return Cc["@mozilla.org/webauthn/service;1"].getService(Ci.nsIWebAuthnService);
  },

  observe(subject, topic, json) {
    let data;
    try {
      data = JSON.parse(json);
    } catch (e) {
      return;
    }
    let type = data?.prompt?.type;
    if (type == "cancel") {
      // The request ended (answered, timed out, the page went away), or
      // another one starts.
      if (!this._current || this._current.tid == data.tid) {
        this._clear();
      }
      return;
    }
    let browser = BrowsingContext.get(data.browsingContextId)?.top?.embedderElement;
    if (!browser || browser.ownerDocument != document) {
      return;
    }
    if (type == "uv-invalid" && data.prompt.retries === 0) {
      // Followed by uv-blocked or the PIN prompt.
      return;
    }
    if (type != "presence" && type != "attestation-consent" && type != "pin-required" && type != "pin-invalid" &&
        type != "select-sign-result" && type != "uv-invalid" && !this.INFO[type]) {
      return;
    }
    this._current = { tid: data.tid, browser, type, data, host: this._host(data.origin) };
    this._render();
    this._show();
  },

  _host(origin) {
    try {
      return Services.io.newURI(origin).displayHost;
    } catch (e) {
      // A relying party id that isn't a URL.
      return String(origin ?? "");
    }
  },

  _render() {
    let { type, data, host } = this._current;
    let l10n = document.l10n;
    this.panel.setAttribute("kind", type);
    this.hint.hidden = true;
    this.note.hidden = type != "presence";
    this.pinForm.hidden = type != "pin-required" && type != "pin-invalid";
    this.accounts.hidden = type != "select-sign-result";
    this.allowButton.hidden = this.blockButton.hidden = type != "attestation-consent";
    this.cancelButton.hidden = type == "attestation-consent";

    switch (type) {
      case "presence":
        l10n.setAttributes(this.text, "webauthn-user-presence-prompt", { hostname: host });
        break;
      case "attestation-consent":
        l10n.setAttributes(this.text, "webauthn-register-direct-prompt", { hostname: host });
        l10n.setAttributes(this.hint, "webauthn-register-direct-prompt-hint");
        this.hint.hidden = false;
        break;
      case "pin-required":
        l10n.setAttributes(this.text, "webauthn-pin-required-prompt");
        break;
      case "pin-invalid": {
        // After three wrong PINs in a row the key needs unplugging; the
        // count only matters once it's close to locking for good.
        let retries = data.prompt.retries;
        if (retries == null || retries < 0 || retries > 3) {
          l10n.setAttributes(this.text, "webauthn-pin-invalid-short-prompt");
        } else {
          l10n.setAttributes(this.text, "webauthn-pin-invalid-long-prompt", { retriesLeft: retries });
        }
        break;
      }
      case "uv-invalid": {
        let retries = data.prompt.retries;
        if (retries == null || retries < 0) {
          l10n.setAttributes(this.text, "webauthn-uv-invalid-short-prompt");
        } else {
          l10n.setAttributes(this.text, "webauthn-uv-invalid-long-prompt", { retriesLeft: retries });
        }
        break;
      }
      case "select-sign-result": {
        l10n.setAttributes(this.text, "webauthn-select-sign-result-prompt", { hostname: host });
        let entities = Array.isArray(data.prompt.entities) ? data.prompt.entities : [];
        this.accounts.replaceChildren(
          ...entities.map((entity, index) => {
            let button = document.createElement("button");
            button.className = "panel-button webauthn-account";
            if (typeof entity?.name == "string" && entity.name) {
              button.textContent = entity.name;
            } else {
              l10n.setAttributes(button, "webauthn-select-sign-result-unknown-account");
            }
            button.addEventListener("click", () => this._answer(service => service.selectionCallback(this._current.tid, index)));
            return button;
          })
        );
        break;
      }
      default:
        l10n.setAttributes(this.text, this.INFO[type], { hostname: host });
    }
  },

  // Shown while its tab is selected.
  _show() {
    let current = this._current;
    if (!current || current.browser != gBrowser.selectedBrowser) {
      this.panel.hidePopup();
      return;
    }
    // A page can't keep a prompt from showing by going fullscreen.
    if (document.fullscreenElement) {
      FullScreen.exitDomFullScreen();
    }
    if (this.panel.state == "closed" || this.panel.state == "hiding") {
      this.panel.openPopup(this.anchor, "bottomleft topleft", 0, 4);
    }
    let focus = this.pinForm.hidden ? (this.allowButton.hidden ? this.cancelButton : this.allowButton) : this.pin;
    setTimeout(() => focus.focus(), 0);
  },

  // Answers the service; the prompt closes, and the service sends the next
  // one if the request goes on (a wrong PIN, touch the key now).
  _answer(callback) {
    if (!this._current) {
      return;
    }
    try {
      callback(this._service);
    } catch (e) {
      console.error("browser-wip: answering the security key prompt failed", e);
    }
    this._clear();
  },

  _cancel() {
    let current = this._current;
    this._clear();
    if (current) {
      try {
        this._service.cancel(current.tid);
      } catch (e) {
        // The request already ended.
      }
    }
  },

  _clear() {
    this._current = null;
    this.panel.hidePopup();
  },
};
