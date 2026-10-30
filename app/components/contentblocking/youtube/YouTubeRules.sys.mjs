/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The YouTube rules of uBlock Origin's filter lists, for the opt-in YouTube
 * ad blocker (docs/CONTENT-BLOCKING.md, "YouTube ads").
 *
 * compileLists() keeps the scriptlet (`##+js(...)`) and element-hiding
 * rules that name a YouTube domain, and drops everything else. The result is
 * plain JSON: the parent caches it and shares it with content processes,
 * where rulesForHost() picks what applies to a page.
 *
 * No Gecko APIs: the unit tests run this in Node.
 */

// Where the parent shares the compiled rules with content processes.
export const YOUTUBE_RULES_KEY = "browserwip:youtube-rules";

// Sites the rules may apply to, with their subdomains.
export const YOUTUBE_SITES = ["youtube.com", "youtubekids.com", "youtube-nocookie.com"];

// uBlock Origin lists say which rules fit which build with `!#if` blocks. We
// run the rules the way uBlock Origin does on Firefox, except that responses
// are not rewritten in the parent ("HTML filtering"): the lists then use
// scriptlets that do the same in the page.
export const LIST_ENV = {
  env_firefox: true,
  env_mv3: false,
  ext_ubol: false,
  cap_html_filtering: false,
  cap_user_stylesheet: true,
};

// Canonical names, and the short names the lists may use instead.
const ALIASES = {
  set: "set-constant",
  "trusted-rpfr": "trusted-replace-fetch-response",
  rpnt: "replace-node-text",
  "trusted-rpnt": "replace-node-text",
  "trusted-replace-node-text": "replace-node-text",
  rmnt: "remove-node-text",
  "nano-stb": "nano-setTimeout-booster",
  "nano-sib": "nano-setInterval-booster",
  nostif: "no-setTimeout-if",
  "edit-inbound-object": "trusted-edit-inbound-object",
  "edit-outbound-object": "trusted-edit-outbound-object",
};

// Scriptlets that run in the page (youtube/scriptlets.js).
export const PAGE_SCRIPTLETS = [
  "set-constant",
  "json-prune",
  "json-prune-fetch-response",
  "json-prune-xhr-response",
  "json-edit",
  "json-edit-fetch-response",
  "json-edit-xhr-response",
  "trusted-replace-fetch-response",
  "trusted-replace-xhr-response",
  "trusted-edit-inbound-object",
  "trusted-edit-outbound-object",
  "trusted-prevent-dom-bypass",
  "nano-setTimeout-booster",
  "nano-setInterval-booster",
  "no-setTimeout-if",
];

// Scriptlets that change inline scripts before they run. They run in the
// browser's own code (YouTubeBlockingChild): Trusted Types can block an
// inline script that a page script changed, and Gecko exempts changes the
// browser makes.
export const NODE_SCRIPTLETS = ["replace-node-text", "remove-node-text"];

// Procedural element-hiding operators that a stylesheet can't express.
const PROCEDURAL = [
  ":has-text(",
  ":upward(",
  ":remove(",
  ":remove-attr(",
  ":remove-class(",
  ":xpath(",
  ":matches-css",
  ":matches-path(",
  ":matches-attr(",
  ":matches-prop(",
  ":matches-media(",
  ":min-text-length(",
  ":watch-attr(",
  ":others(",
  ":if(",
  ":if-not(",
  ":shadow(",
  ":spath(",
  ":-abp-",
];

function evalCondition(expr, env) {
  let tokens = expr.match(/!|&&|\|\||\(|\)|[\w-]+/g) ?? [];
  let i = 0;
  let primary = () => {
    let token = tokens[i++];
    if (token == "!") {
      return !primary();
    }
    if (token == "(") {
      let value = or();
      i++;
      return value;
    }
    return !!env[token];
  };
  let and = () => {
    let value = primary();
    while (tokens[i] == "&&") {
      i++;
      value = primary() && value;
    }
    return value;
  };
  let or = () => {
    let value = and();
    while (tokens[i] == "||") {
      i++;
      value = and() || value;
    }
    return value;
  };
  return or();
}

/** The lines of a list that apply in `env`, without its `!#if` blocks. */
export function preprocess(text, env = LIST_ENV) {
  let out = [];
  // One entry per open block: whether its lines are kept.
  let stack = [];
  for (let line of text.split(/\r?\n/)) {
    let directive = line.match(/^!#(if|else|endif)\b\s*(.*)$/);
    if (directive) {
      let [, kind, expr] = directive;
      if (kind == "if") {
        stack.push({ parent: stack.at(-1)?.keep ?? true, keep: false, cond: evalCondition(expr, env) });
        stack.at(-1).keep = stack.at(-1).parent && stack.at(-1).cond;
      } else if (kind == "else" && stack.length) {
        stack.at(-1).keep = stack.at(-1).parent && !stack.at(-1).cond;
      } else if (kind == "endif") {
        stack.pop();
      }
      continue;
    }
    if (stack.at(-1)?.keep ?? true) {
      out.push(line);
    }
  }
  return out;
}

/**
 * The arguments of a scriptlet rule, as uBlock Origin splits them: commas
 * separate them unless escaped (`\,`); an argument in quotes keeps its
 * commas and loses the quotes.
 */
export function splitScriptletArgs(text) {
  let args = [];
  let i = 0;
  while (i <= text.length) {
    while (text[i] == " ") {
      i++;
    }
    let quote = text[i];
    if (quote == '"' || quote == "'" || quote == "`") {
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] == "\\") {
          j++;
          continue;
        }
        if (text[j] == quote) {
          let k = j + 1;
          while (text[k] == " ") {
            k++;
          }
          if (k >= text.length || text[k] == ",") {
            end = j;
            break;
          }
        }
      }
      if (end != -1) {
        args.push(text.slice(i + 1, end).replaceAll("\\" + quote, quote));
        i = end + 1;
        while (text[i] == " ") {
          i++;
        }
        i++;
        continue;
      }
    }
    let arg = "";
    let j = i;
    for (; j < text.length && text[j] != ","; j++) {
      if (text[j] == "\\" && text[j + 1] == ",") {
        j++;
      }
      arg += text[j];
    }
    args.push(arg.trim());
    i = j + 1;
  }
  return args;
}

export function canonicalName(name) {
  name = name.replace(/\.js$/, "");
  return ALIASES[name] ?? name;
}

function entryMatches(entry, host) {
  if (entry.endsWith(".*")) {
    // An entity: the name under any public suffix.
    let name = entry.slice(0, -2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|\\.)${name}\\.[a-z0-9-]+(\\.[a-z]{2,3})?$`).test(host);
  }
  return host == entry || host.endsWith("." + entry);
}

/** Whether a rule with these domain entries applies on `host`. */
export function domainsMatch(domains, host) {
  let positive = false;
  for (let entry of domains) {
    if (entry.startsWith("~")) {
      if (entryMatches(entry.slice(1), host)) {
        return false;
      }
    } else if (entryMatches(entry, host)) {
      positive = true;
    }
  }
  return positive;
}

export function isYouTubeHost(host) {
  return YOUTUBE_SITES.some(site => host == site || host.endsWith("." + site));
}

// Whether a domain entry can name a YouTube host.
function namesYouTube(entry) {
  if (entry.startsWith("~")) {
    return false;
  }
  if (entry.endsWith(".*")) {
    return YOUTUBE_SITES.some(site => entryMatches(entry, site));
  }
  return isYouTubeHost(entry);
}

function cosmeticCSS(selector) {
  let style = selector.match(/^(.*):style\((.*)\)$/);
  if (style) {
    return `${style[1]}{${style[2]}}`;
  }
  return `${selector}{display:none!important}`;
}

/**
 * The YouTube rules of some uBlock Origin lists.
 * @param {string[]} texts the lists' text
 * @returns {object} JSON: { scriptlets: [{ domains, name, args, exception }],
 *   cosmetic: [{ domains, selector, css, exception }], stats }
 */
export function compileLists(texts) {
  let scriptlets = [];
  let cosmetic = [];
  let stats = { scriptlets: 0, cosmetic: 0, unsupported: 0 };
  let seen = new Set();
  let known = new Set([...PAGE_SCRIPTLETS, ...NODE_SCRIPTLETS]);
  for (let text of texts) {
    for (let raw of preprocess(text)) {
      let line = raw.trim();
      if (!line || line.startsWith("!") || line.startsWith("[")) {
        continue;
      }
      let marker = line.match(/^([^#]*)#(@?)([?$%]?)#(.*)$/);
      if (!marker) {
        // Network rules stay with the network blocker's lists.
        continue;
      }
      let [, domainText, at, kind, body] = marker;
      let domains = domainText ? domainText.split(",").map(d => d.trim().toLowerCase()) : [];
      if (!domains.some(namesYouTube)) {
        continue;
      }
      if (seen.has(line)) {
        continue;
      }
      seen.add(line);
      let exception = at == "@";
      if (kind || body.startsWith("^")) {
        // Procedural (#?#), AdGuard (#$#, #%#) and HTML filtering (##^).
        stats.unsupported++;
        continue;
      }
      if (body.startsWith("+js(") && body.endsWith(")")) {
        let [name = "", ...args] = splitScriptletArgs(body.slice(4, -1));
        name = canonicalName(name);
        if (name ? !known.has(name) : !exception) {
          stats.unsupported++;
          continue;
        }
        scriptlets.push({ domains, name, args, exception });
        stats.scriptlets++;
        continue;
      }
      if (PROCEDURAL.some(op => body.includes(op))) {
        stats.unsupported++;
        continue;
      }
      cosmetic.push({ domains, selector: body, css: cosmeticCSS(body), exception });
      stats.cosmetic++;
    }
  }
  return { version: 1, scriptlets, cosmetic, stats };
}

function scriptletKey(name, args) {
  return JSON.stringify([name, ...args]);
}

/**
 * What applies on a YouTube page.
 * @returns {object} { page: [{ name, args }], node: [{ name, args }],
 *   css: string[] }
 */
export function rulesForHost(compiled, host) {
  let result = { page: [], node: [], css: [] };
  if (!compiled || !isYouTubeHost(host)) {
    return result;
  }
  let excepted = new Set();
  let exceptAll = false;
  for (let rule of compiled.scriptlets) {
    if (rule.exception && domainsMatch(rule.domains, host)) {
      if (!rule.name) {
        exceptAll = true;
      }
      excepted.add(scriptletKey(rule.name, rule.args));
    }
  }
  let added = new Set();
  for (let rule of compiled.scriptlets) {
    if (exceptAll || rule.exception || !domainsMatch(rule.domains, host)) {
      continue;
    }
    let key = scriptletKey(rule.name, rule.args);
    if (excepted.has(key) || added.has(key)) {
      continue;
    }
    added.add(key);
    let target = NODE_SCRIPTLETS.includes(rule.name) ? result.node : result.page;
    target.push({ name: rule.name, args: rule.args });
  }
  let hidden = new Set();
  for (let rule of compiled.cosmetic) {
    if (rule.exception && domainsMatch(rule.domains, host)) {
      hidden.add(rule.selector);
    }
  }
  for (let rule of compiled.cosmetic) {
    if (!rule.exception && !hidden.has(rule.selector) && domainsMatch(rule.domains, host)) {
      hidden.add(rule.selector);
      result.css.push(rule.css);
    }
  }
  return result;
}

/**
 * A pattern argument as a RegExp: `/source/flags`, or literal text.
 * Literal text matches everywhere it occurs when `global`.
 */
export function patternToRegExp(pattern, global = false) {
  let regex = pattern.match(/^\/(.+)\/([dgimsuvy]*)$/);
  if (regex) {
    try {
      return new RegExp(regex[1], regex[2]);
    } catch (e) {
      return null;
    }
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), global ? "g" : "");
}
