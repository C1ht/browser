/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Scriptlets for the opt-in YouTube ad blocker: small changes to a page's
 * own JavaScript, named and parameterised by uBlock Origin's YouTube rules
 * (YouTubeRules.sys.mjs). Our own implementations of what those names mean;
 * a rule naming one we don't have is skipped.
 *
 * YouTubeBlockingChild runs this file in the page's realm, before the page's
 * scripts, with PrecompiledScript.executeInGlobal. Its value is a function
 * taking the scriptlets as JSON ([{ name, args }]). Nothing is left on the
 * page's global. Wrapped functions are Proxies of the originals, so
 * Function.prototype.toString still reports native code.
 *
 * tests/unit/youtube-scriptlets.test.mjs runs it in Node.
 */

// eslint-disable-next-line no-unused-expressions
(function browserWipScriptlets(scriptletsJSON) {
  "use strict";

  const win = globalThis;
  // The page's own built-ins, saved before its scripts run.
  const { Reflect, Proxy, Object: ObjectCtor, Array: ArrayCtor, RegExp: RegExpCtor } = win;
  const JSONparse = win.JSON.parse;
  const JSONstringify = win.JSON.stringify;
  const defineProperty = ObjectCtor.defineProperty;
  const getOwnPropertyDescriptor = ObjectCtor.getOwnPropertyDescriptor;
  const objectKeys = ObjectCtor.keys;
  const objectAssign = ObjectCtor.assign;
  const hasOwn = ObjectCtor.hasOwn;
  const isArray = ArrayCtor.isArray;
  const splice = ArrayCtor.prototype.splice;
  const fnToString = win.Function.prototype.toString;
  const now = win.Date.now;
  const WeakMapCtor = win.WeakMap;
  const SetCtor = win.Set;
  const weakMapGet = WeakMapCtor.prototype.get;
  const weakMapSet = WeakMapCtor.prototype.set;

  const parse = text => Reflect.apply(JSONparse, win.JSON, [text]);
  const stringify = value => Reflect.apply(JSONstringify, win.JSON, [value]);
  const isObjectLike = v => v !== null && (typeof v == "object" || typeof v == "function");
  const call = (fn, thisArg, ...args) => Reflect.apply(fn, thisArg, args);

  function toRegExp(pattern, flags = "") {
    if (pattern === "" || pattern === undefined) {
      return null;
    }
    let match = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
    try {
      if (match) {
        return new RegExpCtor(match[1], match[2]);
      }
      return new RegExpCtor(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    } catch (e) {
      return null;
    }
  }

  // Arguments given as name/value pairs after the positional ones.
  function namedArgs(list) {
    let named = {};
    for (let i = 0; i + 1 < list.length; i += 2) {
      named[list[i]] = list[i + 1];
    }
    return named;
  }

  // Replaces owner[prop], a function, with a Proxy calling handler(original,
  // thisArg, args).
  function wrap(owner, prop, handler) {
    let original = owner?.[prop];
    if (typeof original != "function") {
      return false;
    }
    owner[prop] = new Proxy(original, {
      apply: (target, thisArg, args) => handler(target, thisArg, args),
    });
    return true;
  }

  // "JSON.stringify" -> { owner: JSON, prop: "stringify" }
  function resolveChain(chain) {
    let parts = chain.split(".");
    let owner = win;
    for (let part of parts.slice(0, -1)) {
      owner = owner?.[part];
      if (!isObjectLike(owner)) {
        return null;
      }
    }
    return { owner, prop: parts.at(-1) };
  }

  // -- Request matching ("propsToMatch") --------------------------------

  const REQUEST_PROPS = ["url", "method", "body", "mode", "credentials", "cache", "redirect", "referrer"];

  // Space-separated `prop:pattern` tokens, all of which must match; a token
  // without a known prop name is matched against the URL.
  function propsMatcher(spec = "") {
    let tests = [];
    for (let token of spec.split(/\s+/)) {
      if (!token) {
        continue;
      }
      let colon = token.indexOf(":");
      let prop = colon > 0 ? token.slice(0, colon) : "";
      if (!REQUEST_PROPS.includes(prop)) {
        prop = "url";
        colon = -1;
      }
      let regex = toRegExp(token.slice(colon + 1));
      if (regex) {
        tests.push(props => regex.test(String(props[prop] ?? "")));
      }
    }
    return props => tests.every(test => test(props));
  }

  function absoluteURL(url) {
    try {
      return new win.URL(String(url), win.location.href).href;
    } catch (e) {
      return String(url);
    }
  }

  function fetchProps(args) {
    let [resource, init] = args;
    let props = {};
    if (resource instanceof win.Request) {
      for (let prop of REQUEST_PROPS) {
        props[prop] = resource[prop];
      }
    } else {
      props.url = absoluteURL(resource);
    }
    if (isObjectLike(init)) {
      for (let prop of REQUEST_PROPS) {
        if (prop != "url" && init[prop] !== undefined) {
          props[prop] = init[prop];
        }
      }
    }
    props.method = String(props.method ?? "GET").toUpperCase();
    return props;
  }

  // -- fetch() and XMLHttpRequest responses --------------------------------

  const fetchRewrites = [];
  function onFetchResponse(matches, transform) {
    if (!fetchRewrites.length) {
      wrap(win, "fetch", (target, thisArg, args) => {
        let promise = Reflect.apply(target, thisArg, args);
        let props;
        try {
          props = fetchProps(args);
        } catch (e) {
          return promise;
        }
        let active = fetchRewrites.filter(r => r.matches(props));
        if (!active.length) {
          return promise;
        }
        return promise.then(response =>
          response
            .clone()
            .text()
            .then(text => {
              let out = active.reduce((t, r) => r.transform(t), text);
              if (out === text) {
                return response;
              }
              let replaced = new win.Response(out, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
              for (let prop of ["ok", "redirected", "type", "url"]) {
                defineProperty(replaced, prop, { value: response[prop] });
              }
              return replaced;
            })
            .catch(() => response)
        );
      });
    }
    fetchRewrites.push({ matches, transform });
  }

  const xhrRewrites = [];
  const xhrState = new WeakMapCtor();
  function onXhrResponse(matches, transform) {
    if (!xhrRewrites.length) {
      let proto = win.XMLHttpRequest?.prototype;
      if (!proto) {
        return;
      }
      wrap(proto, "open", (target, xhr, args) => {
        call(weakMapSet, xhrState, xhr, {
          props: { method: String(args[0] ?? "GET").toUpperCase(), url: absoluteURL(args[1]) },
          done: false,
        });
        return Reflect.apply(target, xhr, args);
      });
      for (let prop of ["response", "responseText"]) {
        let desc = getOwnPropertyDescriptor(proto, prop);
        if (!desc?.get) {
          continue;
        }
        let getter = new Proxy(desc.get, {
          apply(target, xhr, args) {
            let value = Reflect.apply(target, xhr, args);
            let state = call(weakMapGet, xhrState, xhr);
            if (!state || xhr.readyState != 4) {
              return value;
            }
            if (!state.done) {
              state.done = true;
              let active = xhrRewrites.filter(r => r.matches(state.props));
              let type = xhr.responseType;
              if (active.length && (type == "" || type == "text" || type == "json")) {
                try {
                  let text = type == "json" ? stringify(value) : value;
                  let out = active.reduce((t, r) => r.transform(t), text);
                  if (out !== text) {
                    state.value = type == "json" ? parse(out) : out;
                  }
                } catch (e) {
                  // Leave the response as it came.
                }
              }
            }
            return hasOwn(state, "value") ? state.value : value;
          },
        });
        defineProperty(proto, prop, { ...desc, get: getter });
      }
    }
    xhrRewrites.push({ matches, transform });
  }

  // A transform of JSON text through edit(object).
  const jsonTransform = edit => text => {
    let obj;
    try {
      obj = parse(text);
    } catch (e) {
      return text;
    }
    return edit(obj) ? stringify(obj) : text;
  };

  // -- json-prune paths -------------------------------------------------
  // Dot-separated keys; `[]` or `*` is every element or key; `[-]` removes
  // the array elements in which the rest of the path exists.

  function pathExists(node, segs, i) {
    if (i == segs.length) {
      return true;
    }
    if (!isObjectLike(node)) {
      return false;
    }
    let seg = segs[i];
    if (seg == "[]" || seg == "*" || seg == "[-]") {
      return objectKeys(node).some(key => pathExists(node[key], segs, i + 1));
    }
    return hasOwn(node, seg) && pathExists(node[seg], segs, i + 1);
  }

  function prunePath(node, segs, i) {
    if (!isObjectLike(node)) {
      return false;
    }
    let seg = segs[i];
    let last = i == segs.length - 1;
    if (seg == "[-]") {
      if (!isArray(node)) {
        return false;
      }
      let changed = false;
      for (let k = node.length - 1; k >= 0; k--) {
        if (last || pathExists(node[k], segs, i + 1)) {
          call(splice, node, k, 1);
          changed = true;
        }
      }
      return changed;
    }
    let keys = seg == "[]" || seg == "*" ? objectKeys(node) : [seg];
    let changed = false;
    for (let key of keys) {
      if (!hasOwn(node, key)) {
        continue;
      }
      if (last) {
        delete node[key];
        changed = true;
      } else if (prunePath(node[key], segs, i + 1)) {
        changed = true;
      }
    }
    return changed;
  }

  // An edit(object) that prunes; true when something was removed.
  function pruner(rawPrunePaths = "", rawNeedlePaths = "") {
    let paths = rawPrunePaths.split(/\s+/).filter(Boolean).map(p => p.split("."));
    let needles = rawNeedlePaths.split(/\s+/).filter(Boolean).map(p => p.split("."));
    if (!paths.length) {
      return null;
    }
    return obj => {
      if (!isObjectLike(obj) || !needles.every(n => pathExists(obj, n, 0))) {
        return false;
      }
      let changed = false;
      for (let path of paths) {
        changed = prunePath(obj, path, 0) || changed;
      }
      return changed;
    };
  }

  // -- JSON queries (json-edit, edit-inbound-object) ------------------------
  // Steps: `.key`, `..key` (at any depth), `*` or `[*]`, `[n]`, `["key"]`,
  // and `[?.path]` / `[?!.path]` / `[?.path OP value]`, which keep the
  // current nodes for which the condition holds (OP: == != *= ^= $= =, where
  // `=/regex/` tests). Then optionally `=value` or `+=value` (merge into an
  // object); without one, the matched nodes are removed. A value is JSON,
  // may contain ${now}, or is repl({"regex":..., "replacement":...}).

  function scanBracket(q, start) {
    let depth = 0;
    let quote = null;
    for (let i = start; i < q.length; i++) {
      let c = q[i];
      if (quote) {
        if (c == "\\") {
          i++;
        } else if (c == quote) {
          quote = null;
        }
      } else if (c == '"' || c == "'") {
        quote = c;
      } else if (c == "[") {
        depth++;
      } else if (c == "]" && --depth == 0) {
        return i;
      }
    }
    return -1;
  }

  function parsePath(text) {
    let steps = [];
    let re = /(\.\.|\.)?([^.[\]]+)/y;
    let match;
    while (re.lastIndex < text.length && (match = re.exec(text))) {
      steps.push(match[2] == "*" ? { all: true } : { key: match[2], deep: match[1] == ".." });
    }
    return steps;
  }

  function parseLiteral(text) {
    let repl = /^repl\((.*)\)$/s.exec(text);
    if (repl) {
      let spec = parse(repl[1]);
      let regex = new RegExpCtor(spec.regex, spec.flags ?? "");
      return old => (typeof old == "string" ? old.replace(regex, spec.replacement ?? "") : old);
    }
    let value = parse(text);
    return () => {
      // A fresh copy for every node it is put in.
      let copy = parse(stringify(value));
      return typeof copy == "string" ? copy.replaceAll("${now}", String(now())) : copy;
    };
  }

  function parseCondition(text) {
    let negate = text.startsWith("!");
    if (negate) {
      text = text.slice(1);
    }
    let op = /(==|!=|\*=|\^=|\$=|=)(.*)$/s.exec(text);
    let path = parsePath(op ? text.slice(0, op.index) : text);
    let test = () => true;
    if (op) {
      let raw = op[2];
      let regex = op[1] == "=" ? /^\/(.+)\/([dgimsuvy]*)$/.exec(raw) : null;
      if (regex) {
        let re = new RegExpCtor(regex[1], regex[2]);
        test = v => typeof v == "string" && re.test(v);
      } else {
        let expected = parse(raw);
        test = {
          "==": v => v === expected,
          "=": v => v === expected,
          "!=": v => v !== expected,
          "*=": v => typeof v == "string" && v.includes(expected),
          "^=": v => typeof v == "string" && v.startsWith(expected),
          "$=": v => typeof v == "string" && v.endsWith(expected),
        }[op[1]];
      }
    }
    return node => {
      let values = select([{ value: node }], path).map(n => n.value);
      let holds = values.some(v => test(v));
      return negate ? !holds : holds;
    };
  }

  function parseQuery(q) {
    let steps = [];
    let i = 0;
    while (i < q.length) {
      if (q.startsWith("+=", i) || q[i] == "=") {
        let merge = q[i] == "+";
        return { steps, op: { merge, value: parseLiteral(q.slice(i + (merge ? 2 : 1))) } };
      }
      if (q[i] == "[") {
        let end = scanBracket(q, i);
        if (end == -1) {
          throw new Error("unclosed [");
        }
        let inner = q.slice(i + 1, end);
        if (inner == "*") {
          steps.push({ all: true });
        } else if (inner.startsWith("?")) {
          steps.push({ filter: parseCondition(inner.slice(1)) });
        } else if (/^-?\d+$/.test(inner)) {
          steps.push({ key: inner, deep: false });
        } else {
          steps.push({ key: String(parse(inner)), deep: false });
        }
        i = end + 1;
        continue;
      }
      let match = /(\.\.|\.)?([^.[\]=+]+|\*)/y;
      match.lastIndex = i;
      let m = match.exec(q);
      if (!m) {
        throw new Error("bad query");
      }
      steps.push(m[2] == "*" ? { all: true } : { key: m[2], deep: m[1] == ".." });
      i = match.lastIndex;
    }
    return { steps, op: null };
  }

  function descendants(value, out, seen, depth = 0) {
    if (!isObjectLike(value) || seen.has(value) || depth > 64) {
      return;
    }
    seen.add(value);
    out.push(value);
    for (let key of objectKeys(value)) {
      descendants(value[key], out, seen, depth + 1);
    }
  }

  // Nodes are { parent, key, value }.
  function select(nodes, steps) {
    for (let step of steps) {
      let next = [];
      for (let node of nodes) {
        let value = node.value;
        if (step.filter) {
          if (step.filter(value)) {
            next.push(node);
          }
        } else if (step.all) {
          if (isObjectLike(value)) {
            for (let key of objectKeys(value)) {
              next.push({ parent: value, key, value: value[key] });
            }
          }
        } else if (step.deep) {
          let all = [];
          descendants(value, all, new SetCtor());
          for (let obj of all) {
            if (hasOwn(obj, step.key)) {
              next.push({ parent: obj, key: step.key, value: obj[step.key] });
            }
          }
        } else if (isObjectLike(value) && hasOwn(value, step.key)) {
          next.push({ parent: value, key: step.key, value: value[step.key] });
        }
      }
      nodes = next;
    }
    return nodes;
  }

  // An edit(object) applying a query; true when something changed.
  function editor(query) {
    let parsed;
    try {
      parsed = parseQuery(query);
    } catch (e) {
      return null;
    }
    let { steps, op } = parsed;
    let matches = obj => select([{ parent: null, key: null, value: obj }], steps);
    let edit = obj => {
      let nodes = matches(obj).filter(n => n.parent);
      if (!nodes.length && !(op && matches(obj).length)) {
        return false;
      }
      if (!op) {
        // Remove, last array index first so earlier indices stay valid.
        nodes.sort((a, b) => Number(b.key) - Number(a.key));
        for (let { parent, key } of nodes) {
          if (isArray(parent)) {
            call(splice, parent, Number(key), 1);
          } else {
            delete parent[key];
          }
        }
        return true;
      }
      for (let node of matches(obj)) {
        if (op.merge) {
          let value = op.value(node.value);
          if (isObjectLike(node.value) && isObjectLike(value)) {
            objectAssign(node.value, value);
          }
        } else if (node.parent) {
          node.parent[node.key] = op.value(node.value);
        }
      }
      return true;
    };
    edit.matches = obj => matches(obj).length > 0;
    return edit;
  }

  // -- The scriptlets -----------------------------------------------------

  const CONSTANTS = {
    undefined: () => undefined,
    null: () => null,
    true: () => true,
    false: () => false,
    "": () => "",
    "''": () => "",
    emptyStr: () => "",
    noopFunc: () => function () {},
    trueFunc: () => () => true,
    falseFunc: () => () => false,
    emptyArr: () => [],
    "[]": () => [],
    emptyObj: () => ({}),
    "{}": () => ({}),
  };

  function makeConstant(owner, prop, value) {
    let desc = getOwnPropertyDescriptor(owner, prop);
    if (desc && !desc.configurable) {
      return;
    }
    defineProperty(owner, prop, {
      configurable: true,
      enumerable: desc ? desc.enumerable : true,
      get: () => value,
      set: () => {},
    });
  }

  // Makes chain ("a.b.c") read `value`, including on objects assigned later.
  function trapChain(owner, chain, value) {
    let dot = chain.indexOf(".");
    if (dot == -1) {
      makeConstant(owner, chain, value);
      return;
    }
    let prop = chain.slice(0, dot);
    let rest = chain.slice(dot + 1);
    let current;
    try {
      current = owner[prop];
    } catch (e) {
      return;
    }
    if (isObjectLike(current)) {
      trapChain(current, rest, value);
    }
    let desc = getOwnPropertyDescriptor(owner, prop);
    if (desc && !desc.configurable) {
      return;
    }
    let { get: prevGet, set: prevSet } = desc ?? {};
    defineProperty(owner, prop, {
      configurable: true,
      enumerable: desc ? desc.enumerable : true,
      get() {
        return prevGet ? call(prevGet, this) : current;
      },
      set(v) {
        if (prevSet) {
          call(prevSet, this, v);
        } else {
          current = v;
        }
        if (isObjectLike(v)) {
          trapChain(v, rest, value);
        }
      },
    });
  }

  function timerBooster(name, needle = "", delay = "", boost = "") {
    let pattern = needle == "" || needle == "*" ? null : toRegExp(needle);
    let wanted = delay == "" ? 1000 : Number(delay);
    let factor = boost == "" ? 0.05 : Math.min(Math.max(Number(boost), 0.001), 50);
    if (!Number.isFinite(wanted) || !Number.isFinite(factor)) {
      return;
    }
    wrap(win, name, (target, thisArg, args) => {
      let [callback, ms] = args;
      let text = typeof callback == "function" ? call(fnToString, callback) : String(callback);
      if ((wanted == -1 || Number(ms) == wanted) && (!pattern || pattern.test(text))) {
        args[1] = Number(ms) * factor;
      }
      return Reflect.apply(target, thisArg, args);
    });
  }

  const SCRIPTLETS = {
    "set-constant"(chain = "", raw = "") {
      let make = CONSTANTS[raw] ?? (/^-?\d+(\.\d+)?$/.test(raw) ? () => Number(raw) : null);
      if (chain && make) {
        trapChain(win, chain, make());
      }
    },

    "json-prune"(prunePaths, needlePaths) {
      let prune = pruner(prunePaths, needlePaths);
      if (!prune) {
        return;
      }
      wrap(win.JSON, "parse", (target, thisArg, args) => {
        let result = Reflect.apply(target, thisArg, args);
        prune(result);
        return result;
      });
      wrap(win.Response?.prototype, "json", (target, thisArg, args) =>
        Reflect.apply(target, thisArg, args).then(obj => {
          prune(obj);
          return obj;
        })
      );
    },

    "json-prune-fetch-response"(prunePaths, needlePaths, ...rest) {
      let prune = pruner(prunePaths, needlePaths);
      if (prune) {
        onFetchResponse(propsMatcher(namedArgs(rest).propsToMatch), jsonTransform(prune));
      }
    },

    "json-prune-xhr-response"(prunePaths, needlePaths, ...rest) {
      let prune = pruner(prunePaths, needlePaths);
      if (prune) {
        onXhrResponse(propsMatcher(namedArgs(rest).propsToMatch), jsonTransform(prune));
      }
    },

    "json-edit"(query = "") {
      let edit = editor(query);
      if (edit) {
        wrap(win.JSON, "parse", (target, thisArg, args) => {
          let result = Reflect.apply(target, thisArg, args);
          if (isObjectLike(result)) {
            edit(result);
          }
          return result;
        });
      }
    },

    "json-edit-fetch-response"(query = "", ...rest) {
      let edit = editor(query);
      if (edit) {
        onFetchResponse(propsMatcher(namedArgs(rest).propsToMatch), jsonTransform(edit));
      }
    },

    "json-edit-xhr-response"(query = "", ...rest) {
      let edit = editor(query);
      if (edit) {
        onXhrResponse(propsMatcher(namedArgs(rest).propsToMatch), jsonTransform(edit));
      }
    },

    "trusted-replace-fetch-response"(pattern = "", replacement = "", propsToMatch = "") {
      let regex = toRegExp(pattern, "g");
      if (regex) {
        onFetchResponse(propsMatcher(propsToMatch), text => text.replace(regex, replacement));
      }
    },

    "trusted-replace-xhr-response"(pattern = "", replacement = "", propsToMatch = "") {
      let regex = toRegExp(pattern, "g");
      if (regex) {
        onXhrResponse(propsMatcher(propsToMatch), text => text.replace(regex, replacement));
      }
    },

    // Edits argument number argPos of the function at chain before it runs,
    // in a copy, so the caller's object is unchanged.
    "trusted-edit-inbound-object"(chain = "", argPos = "", query = "") {
      let target = resolveChain(chain);
      let pos = Number(argPos);
      let edit = editor(query);
      if (!target || !edit || !Number.isInteger(pos)) {
        return;
      }
      wrap(target.owner, target.prop, (original, thisArg, args) => {
        let i = pos < 0 ? args.length + pos : pos;
        let arg = args[i];
        if (isObjectLike(arg)) {
          try {
            if (edit.matches(arg)) {
              let copy = parse(stringify(arg));
              edit(copy);
              args[i] = copy;
            }
          } catch (e) {
            // Leave the argument as it was.
          }
        }
        return Reflect.apply(original, thisArg, args);
      });
    },

    // Edits what the function at chain returns.
    "trusted-edit-outbound-object"(chain = "", query = "") {
      let target = resolveChain(chain);
      let edit = editor(query);
      if (!target || !edit) {
        return;
      }
      wrap(target.owner, target.prop, (original, thisArg, args) => {
        let result = Reflect.apply(original, thisArg, args);
        if (isObjectLike(result)) {
          try {
            edit(result);
          } catch (e) {
            // Return it unchanged.
          }
        }
        return result;
      });
    },

    // A page can take a pristine fetch() and the like from a frame it just
    // added; give such frames ours instead.
    "trusted-prevent-dom-bypass"(methodChain = "", targetChain = "") {
      let method = resolveChain(methodChain);
      if (!method || !targetChain) {
        return;
      }
      let ownValue = () => resolveChain(targetChain)?.owner?.[targetChain.split(".").at(-1)];
      wrap(method.owner, method.prop, (original, thisArg, args) => {
        let result = Reflect.apply(original, thisArg, args);
        try {
          let node = args[0];
          let frames = [];
          if (node?.nodeName == "IFRAME" || node?.nodeName == "FRAME") {
            frames.push(node);
          } else if (typeof node?.querySelectorAll == "function") {
            frames.push(...node.querySelectorAll("iframe,frame"));
          }
          for (let frame of frames) {
            let frameWin = frame.contentWindow;
            if (!frameWin) {
              continue;
            }
            let owner = frameWin;
            let parts = targetChain.split(".");
            for (let part of parts.slice(0, -1)) {
              owner = owner[part];
            }
            owner[parts.at(-1)] = ownValue();
          }
        } catch (e) {
          // A frame from another site: nothing to take from it.
        }
        return result;
      });
    },

    "nano-setTimeout-booster"(needle, delay, boost) {
      timerBooster("setTimeout", needle, delay, boost);
    },

    "nano-setInterval-booster"(needle, delay, boost) {
      timerBooster("setInterval", needle, delay, boost);
    },

    "no-setTimeout-if"(needle = "", delay = "") {
      let negate = needle.startsWith("!");
      let pattern = toRegExp(negate ? needle.slice(1) : needle);
      let wanted = delay.replace(/^!/, "");
      wrap(win, "setTimeout", (target, thisArg, args) => {
        let [callback, ms] = args;
        let text = typeof callback == "function" ? call(fnToString, callback) : String(callback);
        let textHit = !pattern || pattern.test(text) != negate;
        let delayHit = !wanted || (Number(ms) == Number(wanted)) != delay.startsWith("!");
        if (textHit && delayHit) {
          args[0] = function () {};
        }
        return Reflect.apply(target, thisArg, args);
      });
    },
  };

  let list;
  try {
    list = parse(scriptletsJSON);
  } catch (e) {
    return 0;
  }
  let ran = 0;
  for (let { name, args } of list) {
    let scriptlet = SCRIPTLETS[name];
    if (!scriptlet) {
      continue;
    }
    try {
      scriptlet(...args);
      ran++;
    } catch (e) {
      // One broken rule doesn't stop the others.
    }
  }
  return ran;
});
