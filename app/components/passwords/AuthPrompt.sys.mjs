/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Sign-in prompts for HTTP authentication (Basic, Digest, NTLM, proxies),
 * without Firefox's password storage.
 *
 * Gecko gets these prompts from @mozilla.org/passwordmanager/authpromptfactory;1.
 * Toolkit's (LoginManagerAuthPrompter) fills them from Firefox's login store
 * and offers to save what is typed, which would start that store even with
 * every signon.* pref off. BrowserWipGlue points the contract here instead:
 * the same dialog, nothing looked up, nothing kept.
 *
 * Adapted from LoginManagerAuthPrompter.sys.mjs: identical requests from one
 * tab (same level, origin and realm) share one prompt, and a site whose
 * prompt was dismissed prompts.authentication_dialog_abuse_limit times in a
 * row in that tab gets no more, so it can't keep a dialog in the user's way.
 */

import { PromptUtils } from "resource://gre/modules/PromptUtils.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "abuseLimit",
  "prompts.authentication_dialog_abuse_limit",
  2
);

// browser (or NO_BROWSER) -> "level|origin|realm" -> pending prompt
const pendingPrompts = new WeakMap();
const NO_BROWSER = {};

// browser -> base domain -> prompts dismissed in a row
const dismissals = new WeakMap();

function baseDomainOf(host) {
  try {
    return Services.eTLD.getBaseDomainFromHost(host);
  } catch (e) {
    return host;
  }
}

function tooManyDismissals(browser, domain) {
  let count = dismissals.get(browser)?.get(domain) ?? 0;
  return lazy.abuseLimit >= 0 && count >= lazy.abuseLimit;
}

function countDismissal(browser, domain, dismissed) {
  if (!browser) {
    return;
  }
  let counts = dismissals.get(browser);
  if (!counts) {
    counts = new Map();
    dismissals.set(browser, counts);
  }
  counts.set(domain, dismissed ? (counts.get(domain) ?? 0) + 1 : 0);
}

export class AuthPromptFactory {
  QueryInterface = ChromeUtils.generateQI(["nsIPromptFactory"]);

  getPrompt(window, iid) {
    // Only nsIAuthPrompt2. For the legacy nsIAuthPrompt this throws, and
    // Prompter falls back to its own plain prompt.
    return new AuthPrompter(window).QueryInterface(iid);
  }
}

class AuthPrompter {
  QueryInterface = ChromeUtils.generateQI(["nsIAuthPrompt2", "nsILoginManagerAuthPrompter"]);

  // The tab's <browser>. Set by Gecko (BrowserParent) for pages; null for
  // prompts that belong to no tab, which then get a window-modal dialog.
  browser = null;

  constructor(window) {
    this.init(window);
  }

  // nsILoginManagerAuthPrompter
  init(window) {
    this.browser = window && !window.isChromeWindow ? (window.docShell?.chromeEventHandler ?? null) : null;
  }

  // nsIAuthPrompt2
  promptAuth(channel, level, authInfo) {
    let done = false;
    let ok = false;
    this.#show(channel, level, authInfo)
      .then(result => (ok = result))
      .finally(() => (done = true));
    Services.tm.spinEventLoopUntilOrQuit("browser-wip AuthPrompt.promptAuth", () => done);
    return ok;
  }

  asyncPromptAuth(channel, callback, context, level, authInfo) {
    let consumer = {
      QueryInterface: ChromeUtils.generateQI(["nsICancelable"]),
      callback,
      context,
      cancel() {
        this.callback?.onAuthCancelled(this.context, false);
        this.callback = null;
        this.context = null;
      },
    };
    let { displayHost, realm } = PromptUtils.getAuthTarget(channel, authInfo);
    let key = `${level}|${displayHost}|${realm}`;
    let owner = this.browser ?? NO_BROWSER;
    let byKey = pendingPrompts.get(owner);
    if (!byKey) {
      byKey = new Map();
      pendingPrompts.set(owner, byKey);
    }
    let pending = byKey.get(key) ?? pendingPrompts.get(NO_BROWSER)?.get(key);
    if (pending) {
      pending.consumers.push(consumer);
      return consumer;
    }
    pending = { consumers: [consumer], authInfo };
    byKey.set(key, pending);
    this.#runQueued(channel, level, pending, byKey, key);
    return consumer;
  }

  async #runQueued(channel, level, pending, byKey, key) {
    let ok = false;
    let aborted = false;
    try {
      ok = await this.#show(channel, level, pending.authInfo);
    } catch (e) {
      // Prompts throw NS_ERROR_NOT_AVAILABLE when there is nowhere to show
      // them, for instance in a tab being closed.
      aborted = e.result == Cr.NS_ERROR_NOT_AVAILABLE;
      if (!aborted) {
        console.error("browser-wip: HTTP authentication prompt failed", e);
      }
    }
    byKey.delete(key);
    for (let { callback, context } of pending.consumers) {
      try {
        if (!callback) {
          continue;
        }
        if (ok) {
          callback.onAuthAvailable(context, pending.authInfo);
        } else {
          callback.onAuthCancelled(context, !aborted);
        }
      } catch (e) {
        // The channel may be gone; nothing to do.
      }
    }
  }

  async #show(channel, level, authInfo) {
    let { displayHost } = PromptUtils.getAuthTarget(channel, authInfo);
    // The tab's site, or the asking host while the tab has none (a new tab
    // is on about:blank, whose .host throws). Both must come out in the same
    // form, or one site's dismissals are counted under two names.
    let host = "";
    try {
      host = this.browser?.currentURI.host ?? "";
    } catch (e) {
      // No host.
    }
    if (!host) {
      try {
        host = Services.io.newURI(displayHost).host;
      } catch (e) {
        host = displayHost;
      }
    }
    let domain = baseDomainOf(host);
    if (tooManyDismissals(this.browser, domain)) {
      return false;
    }
    // Window-modal: this browser has no tab-modal prompts (no "Prompt"
    // actor), so a tab-modal request falls back to the same window dialog,
    // but with text that leaves the site's name to a tab dialog's header,
    // and the dialog would never say which site is asking.
    let ok = await Services.prompt.asyncPromptAuth(
      this.browser?.browsingContext ?? null,
      Ci.nsIPrompt.MODAL_TYPE_WINDOW,
      channel,
      level,
      authInfo
    );
    // Only a reply with something typed in resets the count; any other way
    // out of the dialog counts against the site.
    countDismissal(this.browser, domain, !(ok && (authInfo.username || authInfo.password)));
    return ok;
  }
}
