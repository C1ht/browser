/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The browser side of PasswordsChild: one per frame. Takes the frame's
 * origin from its own principal (WindowGlobalParent.documentPrincipal),
 * never from the page, checks it is one logins are kept for, and hands the
 * request to the window's PasswordsUI (passwords.js). Sends the page one
 * credential, for the entry picked in the dropdown.
 */

import { isFillableOrigin } from "resource://gre/modules/browserwip/PasswordRules.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PasswordVault: "resource://gre/modules/browserwip/PasswordVault.sys.mjs",
});

const KINDS = ["username", "password", "new-password"];
const KEYS = ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"];

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

export class PasswordsParent extends JSWindowActorParent {
  #ui = null;

  // The frame's origin, from its principal; null for anything that isn't a
  // web page (logins are never kept for those).
  get #origin() {
    let principal = this.manager?.documentPrincipal;
    if (!principal?.isContentPrincipal) {
      return null;
    }
    let origin = principal.originNoSuffix;
    return isFillableOrigin(origin) ? origin : null;
  }

  // The tab's <browser> and its window's PasswordsUI.
  #target() {
    let browser = this.browsingContext?.top?.embedderElement;
    let ui = browser?.ownerDocument?.defaultView?.PasswordsUI;
    if (!browser || !ui) {
      return null;
    }
    this.#ui = ui;
    return { browser, ui };
  }

  #gone() {
    try {
      return !this.manager?.isCurrentGlobal;
    } catch (e) {
      return true;
    }
  }

  receiveMessage(message) {
    let origin = this.#origin;
    let target = this.#target();
    if (!origin || !target) {
      return;
    }
    let { browser, ui } = target;
    let data = message.data ?? {};
    switch (message.name) {
      case "Passwords:FormSeen":
        ui.formSeen(browser);
        break;
      case "Passwords:OpenDropdown": {
        let topOrigin = this.browsingContext.top.currentWindowGlobal?.documentPrincipal?.originNoSuffix ?? "";
        let rect = data.rect ?? {};
        ui.openDropdown(browser, this, {
          rect: {
            left: finite(rect.left),
            top: finite(rect.top),
            width: finite(rect.width),
            height: finite(rect.height),
          },
          kind: KINDS.includes(data.kind) ? data.kind : "password",
          reason: data.reason == "key" ? "key" : "click",
          value: typeof data.value == "string" ? data.value.slice(0, 256) : "",
          hasValue: data.hasValue === true,
          maxLength: finite(data.maxLength),
          origin,
          topOrigin,
          crossOrigin: origin != topOrigin,
        });
        break;
      }
      case "Passwords:Key":
        if (KEYS.includes(data.key)) {
          ui.dropdownKey(this, data.key);
        }
        break;
      case "Passwords:Input":
        ui.dropdownInput(this, typeof data.value == "string" ? data.value.slice(0, 256) : "");
        break;
      case "Passwords:Close":
        ui.closeDropdown(this);
        break;
      case "Passwords:Submitted":
        if (typeof data.password == "string" && data.password) {
          ui.loginSubmitted(browser, this, {
            origin,
            username: typeof data.username == "string" ? data.username : "",
            password: data.password,
            generated: data.generated === true,
          });
        }
        break;
    }
  }

  /** Fills the entry into the field the dropdown was opened from. */
  async fill(entryId) {
    let origin = this.#origin;
    if (!origin || this.#gone()) {
      return false;
    }
    let credentials = await lazy.PasswordVault.credentialsFor(entryId, origin);
    if (this.#gone() || this.#origin != origin) {
      return false;
    }
    return this.sendQuery("Passwords:Fill", credentials);
  }

  fillGenerated(password) {
    if (this.#origin && !this.#gone()) {
      this.sendAsyncMessage("Passwords:FillGenerated", { password });
    }
  }

  dropdownState(open, selected = false) {
    if (!this.#gone()) {
      try {
        this.sendAsyncMessage("Passwords:DropdownState", { open, selected });
      } catch (e) {
        // The frame went away meanwhile.
      }
    }
  }

  didDestroy() {
    this.#ui?.actorGone(this);
  }
}
