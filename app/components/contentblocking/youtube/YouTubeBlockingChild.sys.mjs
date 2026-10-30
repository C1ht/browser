/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Applies the opt-in YouTube ad blocker's rules to a YouTube page
 * (docs/CONTENT-BLOCKING.md, "YouTube ads").
 *
 * Runs on DOMDocElementInserted, which fires synchronously when the root
 * element is inserted, before any of the page's scripts. The rules come from
 * the parent through shared memory (YouTubeBlocking.sys.mjs); this actor
 * never messages it.
 *
 * - Element hiding: one agent stylesheet.
 * - Scriptlets that change inline scripts (replace-node-text,
 *   remove-node-text): a MutationObserver of our own. Gecko runs microtasks
 *   right before each parser-inserted script, so the text is changed before
 *   it runs; and since the browser changed it, not the page, Trusted Types
 *   doesn't count it against the script.
 * - The other scriptlets: youtube/scriptlets.js, run in the page's realm
 *   with PrecompiledScript.executeInGlobal, so the page's CSP doesn't apply.
 *   If it isn't compiled yet in this process, the parser waits for it.
 */

import {
  patternToRegExp,
  rulesForHost,
  YOUTUBE_RULES_KEY,
} from "resource://gre/modules/browserwip/YouTubeRules.sys.mjs";

const ENABLED_PREF = "browserwip.youtubeblocking.enabled";
const SCRIPTLETS_URL = "resource://gre/modules/browserwip/youtube/scriptlets.js";
const AGENT_SHEET = Ci.nsIStyleSheetService.AGENT_SHEET;

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "styleSheetService", () =>
  Cc["@mozilla.org/content/style-sheet-service;1"].getService(Ci.nsIStyleSheetService)
);

// Compiled once per content process.
let gCompiled = null;
function compiledScriptlets() {
  if (!gCompiled) {
    gCompiled = ChromeUtils.compileScript(SCRIPTLETS_URL, { hasReturnValue: true }).then(
      script => (gCompiled.script = script)
    );
  }
  return gCompiled;
}

// The last stylesheet, reused while the rules stay the same.
let gSheet = null;
let gSheetCSS = "";
function sheetFor(css) {
  if (css != gSheetCSS) {
    gSheet = lazy.styleSheetService.preloadSheet(
      Services.io.newURI("data:text/css;charset=utf-8," + encodeURIComponent(css)),
      AGENT_SHEET
    );
    gSheetCSS = css;
  }
  return gSheet;
}

function namedArgs(list) {
  let named = {};
  for (let i = 0; i + 1 < list.length; i += 2) {
    named[list[i]] = list[i + 1];
  }
  return named;
}

function test(regex, text) {
  regex.lastIndex = 0;
  return regex.test(text);
}

/**
 * replace-node-text(nodeName, pattern, replacement, ...) and
 * remove-node-text(nodeName, pattern, ...): the text of `nodeName` elements
 * (in practice: inline scripts) matching `pattern` is replaced, or emptied.
 * Named arguments: condition (the text must also match it), excludes (it
 * must not), sedCount (how many nodes to change at most).
 */
function nodeTextRules(scriptlets) {
  let rules = [];
  for (let { name, args } of scriptlets) {
    let [nodeName = "", pattern = "", ...rest] = args;
    let remove = name == "remove-node-text";
    let replacement = remove ? "" : (rest.shift() ?? "");
    let named = namedArgs(rest);
    let regex = pattern ? patternToRegExp(pattern) : null;
    if (!nodeName || !regex) {
      continue;
    }
    let count = Number(named.sedCount);
    rules.push({
      nodeName: nodeName.toLowerCase(),
      regex,
      replacement,
      remove,
      condition: named.condition ? patternToRegExp(named.condition) : null,
      excludes: named.excludes ? patternToRegExp(named.excludes) : null,
      remaining: count > 0 ? count : Infinity,
      changed: new WeakSet(),
    });
  }
  return rules;
}

function watchNodeText(win, doc, rules) {
  let handleText = node => {
    let parent = node.parentNode;
    for (let rule of rules) {
      if (rule.remaining <= 0 || rule.changed.has(node) || parent?.localName != rule.nodeName) {
        continue;
      }
      let text = node.data;
      if (
        (rule.condition && !test(rule.condition, text)) ||
        (rule.excludes && test(rule.excludes, text)) ||
        !test(rule.regex, text)
      ) {
        continue;
      }
      rule.regex.lastIndex = 0;
      node.data = rule.remove ? "" : text.replace(rule.regex, rule.replacement);
      rule.changed.add(node);
      rule.remaining--;
    }
  };
  let handleElement = element => {
    let elements = rules.some(r => r.nodeName == element.localName) ? [element] : [];
    for (let rule of rules) {
      elements.push(...element.getElementsByTagName(rule.nodeName));
    }
    for (let el of elements) {
      for (let child of el.childNodes) {
        if (child.nodeType == child.TEXT_NODE) {
          handleText(child);
        }
      }
    }
  };
  let observer = new win.MutationObserver(records => {
    for (let record of records) {
      if (record.type == "characterData") {
        // The parser appends a long script's text in more than one go.
        handleText(record.target);
        continue;
      }
      for (let node of record.addedNodes) {
        if (node.nodeType == node.TEXT_NODE) {
          handleText(node);
        } else if (node.nodeType == node.ELEMENT_NODE) {
          handleElement(node);
        }
      }
    }
    if (rules.every(r => r.remaining <= 0)) {
      observer.disconnect();
    }
  });
  observer.observe(doc, { childList: true, subtree: true, characterData: true });
  // The rules are for the scripts in the page's HTML.
  win.addEventListener("load", () => observer.disconnect(), { once: true });
}

export class YouTubeBlockingChild extends JSWindowActorChild {
  handleEvent(event) {
    let doc = event.target;
    if (doc != this.document || !Services.prefs.getBoolPref(ENABLED_PREF, false)) {
      return;
    }
    let uri = doc.documentURIObject;
    if (
      !(uri?.schemeIs("http") || uri?.schemeIs("https")) ||
      // "Turn off protections for this site" covers this too.
      doc.cookieJarSettings.isOnContentBlockingAllowList
    ) {
      return;
    }
    let compiled = Services.cpmm.sharedData.get(YOUTUBE_RULES_KEY);
    let rules = rulesForHost(compiled, uri.host);
    let win = this.contentWindow;
    try {
      if (rules.css.length) {
        win.windowUtils.addSheet(sheetFor(rules.css.join("\n")), AGENT_SHEET);
      }
      let textRules = nodeTextRules(rules.node);
      if (textRules.length) {
        watchNodeText(win, doc, textRules);
      }
    } catch (e) {
      console.error("browser-wip: YouTube element hiding or node rules failed", e);
    }
    if (rules.page.length) {
      this._runInPage(doc, win, JSON.stringify(rules.page));
    }
  }

  _runInPage(doc, win, json) {
    let run = script => {
      try {
        let fn = script.executeInGlobal(win, { reportExceptions: false });
        fn(json);
      } catch (e) {
        console.error("browser-wip: YouTube scriptlets failed", e);
      }
    };
    let compiled = compiledScriptlets();
    if (compiled.script) {
      run(compiled.script);
      return;
    }
    // First YouTube page in this process: hold the page's scripts until the
    // scriptlets are ready.
    doc.blockParsing(
      compiled
        .then(script => {
          if (!win.closed && win.document == doc) {
            run(script);
          }
        })
        .catch(e => console.error("browser-wip: YouTube scriptlets unavailable", e)),
      { blockScriptCreated: true }
    );
  }
}
