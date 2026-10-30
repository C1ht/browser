// The YouTube ad blocker's page scriptlets (contentblocking/youtube/scriptlets.js),
// each run in a fresh realm standing in for a page.
const fs = await import("node:fs");
const vm = await import("node:vm");
const source = fs.readFileSync(new URL("../../app/components/contentblocking/youtube/scriptlets.js", import.meta.url), "utf8");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

// A page: its own realm, with fetch(), XMLHttpRequest, timers and frames
// faked well enough for the scriptlets.
function page() {
  const ctx = vm.createContext({
    URL, Headers,
    location: { href: "https://www.youtube.com/watch?v=x" },
    responses: {},
  });
  // Node has one Response for every realm; a page has its own.
  ctx.Response = class Response extends globalThis.Response {};
  ctx.Request = class Request extends globalThis.Request {};
  vm.runInContext(`
    globalThis.fetch = async (resource, init) => {
      let url = typeof resource == "string" ? new URL(resource, location.href).href : resource.url;
      let body = responses[url] ?? "{}";
      let response = new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    class XMLHttpRequest {
      open(method, url) { this._url = new URL(url, location.href).href; }
      send() {}
      get readyState() { return 4; }
      get responseType() { return this._type ?? ""; }
      set responseType(t) { this._type = t; }
      get responseText() { return responses[this._url] ?? ""; }
      get response() { let t = responses[this._url] ?? ""; return this._type == "json" ? JSON.parse(t) : t; }
    }
    globalThis.XMLHttpRequest = XMLHttpRequest;
    globalThis.delays = [];
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); return 1; };
    globalThis.Node = function Node() {};
    Node.prototype.appendChild = function (child) { child.contentWindow = { fetch: "pristine", JSON: { parse: "pristine" } }; return child; };
  `, ctx);
  const run = list => vm.runInContext(source, ctx)(JSON.stringify(list));
  return { ctx, run, eval: code => vm.runInContext(code, ctx) };
}

// -- set-constant
{
  const p = page();
  const ran = p.run([
    { name: "set-constant", args: ["ytInitialPlayerResponse.adPlacements", "undefined"] },
    { name: "set-constant", args: ["ytInitialPlayerResponse.playerAds", "undefined"] },
    { name: "set-constant", args: ["already.there", "false"] },
    { name: "set-constant", args: ["x", "notAValue"] },
  ]);
  p.eval(`var ytInitialPlayerResponse = { adPlacements: [1], playerAds: [2], videoDetails: { id: "x" } };`);
  const r = p.eval("ytInitialPlayerResponse");
  assert(r.adPlacements === undefined && r.playerAds === undefined && r.videoDetails.id == "x",
         "set-constant: properties of an object assigned later, two on one chain, the rest kept");
  assert(!JSON.stringify(r).includes("adPlacements"), "and they drop out of JSON");
  p.eval(`ytInitialPlayerResponse = { adPlacements: [3] };`);
  assert(p.eval("ytInitialPlayerResponse.adPlacements") === undefined, "also when the object is replaced");
  assert(ran == 4 && p.eval("typeof x") == "undefined", "an unknown value is ignored");
}
{
  const p = page();
  p.eval(`globalThis.already = { there: true };`);
  p.run([{ name: "set-constant", args: ["already.there", "false"] }]);
  p.eval(`already.there = true;`);
  assert(p.eval("already.there") === false, "set-constant: an existing object, and it stays constant");
}

// -- json-prune
{
  const p = page();
  p.run([
    { name: "json-prune", args: ["playerResponse.adPlacements adPlacements playerAds"] },
    { name: "json-prune", args: ["entries.[-].command.adClientParams.isAd"] },
    { name: "json-prune", args: ["onlyWith", "needle.here"] },
  ]);
  const out = p.eval(`JSON.parse('{"adPlacements":[1],"playerAds":[2],"playerResponse":{"adPlacements":[3],"streamingData":{}},"keep":1}')`);
  assert(!("adPlacements" in out) && !("playerAds" in out) && !("adPlacements" in out.playerResponse) && out.keep == 1 && out.playerResponse.streamingData,
         "json-prune: JSON.parse results lose the paths, nothing else");
  const reels = p.eval(`JSON.parse('{"entries":[{"command":{"adClientParams":{"isAd":true}}},{"command":{"v":1}},{"command":{"adClientParams":{"isAd":true}}}]}')`);
  assert(reels.entries.length == 1 && reels.entries[0].command.v == 1, "json-prune: [-] removes the array elements that have the rest of the path");
  assert("onlyWith" in p.eval(`JSON.parse('{"onlyWith":1}')`) && !("onlyWith" in p.eval(`JSON.parse('{"onlyWith":1,"needle":{"here":0}}')`)),
         "json-prune: needle paths must all exist first");
  assert(p.eval("Function.prototype.toString.call(JSON.parse)").includes("[native code]"), "wrapped functions still look native");
  const viaJson = await p.eval(`new Response('{"adPlacements":[1],"a":2}').json()`);
  assert(!("adPlacements" in viaJson) && viaJson.a == 2, "json-prune: Response.json() too");
}

// -- fetch() responses
{
  const p = page();
  p.ctx.responses["https://www.youtube.com/youtubei/v1/player?key=1"] = '{"adPlacements":[1],"adSlots":[2],"videoDetails":{"title":"t"}}';
  p.ctx.responses["https://www.youtube.com/youtubei/v1/next"] = '{"adPlacements":[1]}';
  p.ctx.responses["https://www.youtube.com/youtubei/v1/get_watch?x"] = '{"a":"\\"adSlots\\"","b":"adSlots"}';
  p.run([
    { name: "json-prune-fetch-response", args: ["adPlacements adSlots", "", "propsToMatch", "/\\/player(\\?|$)/"] },
    { name: "trusted-replace-fetch-response", args: ['"adSlots"', '"no_ads"', "/get_watch?"] },
  ]);
  const player = await p.eval(`fetch("/youtubei/v1/player?key=1")`);
  const json = await player.json();
  assert(!("adPlacements" in json) && !("adSlots" in json) && json.videoDetails.title == "t", "json-prune-fetch-response: a matching request is pruned");
  assert(player.url == "https://www.youtube.com/youtubei/v1/player?key=1" && player.ok, "the new response keeps url and ok");
  const next = await (await p.eval(`fetch(new Request("https://www.youtube.com/youtubei/v1/next"))`)).json();
  assert("adPlacements" in next, "a request that doesn't match is left alone (Request objects too)");
  const watch = await (await p.eval(`fetch("https://www.youtube.com/youtubei/v1/get_watch?x")`)).text();
  assert(watch == '{"a":"\\"adSlots\\"","b":"no_ads"}', "trusted-replace-fetch-response: literal text, in matching requests");
}

// -- json-edit-fetch-response
{
  const p = page();
  p.ctx.responses["https://m.youtube.com/youtubei/v1/get_watch?a"] = JSON.stringify({
    x: { itemSectionRenderer: { contents: [{ adSlotRenderer: {} }, { videoRenderer: { id: 1 } }, { adSlotRenderer: {} }] } },
  });
  p.run([{ name: "json-edit-fetch-response", args: ["..itemSectionRenderer.contents.*[?.adSlotRenderer]", "propsToMatch", "/get_watch"] }]);
  const out = await (await p.eval(`fetch("https://m.youtube.com/youtubei/v1/get_watch?a")`)).json();
  const contents = out.x.itemSectionRenderer.contents;
  assert(contents.length == 1 && contents[0].videoRenderer.id == 1, "json-edit-fetch-response: ..deep, *, [?.cond] and removal");
}

// -- XMLHttpRequest responses
{
  const p = page();
  p.ctx.responses["https://www.youtube.com/youtubei/v1/player"] = '{"adPlacements":[{"x":"Ab"}],"playerConfig":{}}';
  p.ctx.responses["https://tv.youtube.com/watch?v=1"] = '{"adPlacements":1,"k":"adPlacements"}';
  p.run([
    { name: "json-prune-xhr-response", args: ["adPlacements", "", "propsToMatch", "/\\/player(?:\\?.+)?$/"] },
    { name: "trusted-replace-xhr-response", args: ['"adPlacements"', '"no_ads"', "/playlist\\?list=|watch\\?[tv]=/"] },
  ]);
  const text = p.eval(`let a = new XMLHttpRequest(); a.open("GET", "/youtubei/v1/player"); a.send(); a.responseText`);
  assert(text == '{"playerConfig":{}}', "json-prune-xhr-response: responseText of a matching request");
  const asJson = p.eval(`let b = new XMLHttpRequest(); b.open("GET", "/youtubei/v1/player"); b.responseType = "json"; b.response`);
  assert(!("adPlacements" in asJson) && "playerConfig" in asJson, "and response, with responseType json");
  const replaced = p.eval(`let c = new XMLHttpRequest(); c.open("GET", "https://tv.youtube.com/watch?v=1"); c.response`);
  assert(replaced == '{"no_ads":1,"k":"no_ads"}', "trusted-replace-xhr-response");
  const other = p.eval(`let d = new XMLHttpRequest(); d.open("GET", "https://tv.youtube.com/other"); d.responseText`);
  assert(other == "", "an unmatched request is left alone");
}

// -- trusted-edit-inbound-object, with the queries uBlock Origin uses on YouTube
{
  const p = page();
  p.run([
    { name: "trusted-edit-inbound-object", args: ["JSON.stringify", "0", '[?.attestationRequest][?.context.client.userAgent*="channel"].context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"}'] },
    { name: "trusted-edit-inbound-object", args: ["JSON.stringify", "0", '[?.attestationRequest][?.context.client.userAgent=/channel|lactmilli/].playbackContext.contentPlaybackContext.lactMilliseconds="${now}"'] },
    { name: "trusted-edit-inbound-object", args: ["JSON.stringify", "0", '[?.attestationRequest][?.context.client.userAgent=/channel/].playbackContext.contentPlaybackContext.referer=repl({"regex":"(?:#reloadxhr)?$","replacement":"#reloadxhr"})'] },
  ]);
  const request = {
    attestationRequest: {},
    context: { client: { clientName: "WEB", userAgent: "Mozilla/5.0 (X11; channel) Gecko" } },
    playbackContext: { contentPlaybackContext: { lactMilliseconds: "-1", referer: "https://www.youtube.com/" } },
  };
  p.ctx.request = request;
  const sent = JSON.parse(p.eval("JSON.stringify(request)"));
  assert(sent.context.client.clientScreen == "CHANNEL", "conditions on the root and a node, then += merges");
  assert(/^\d{10,}$/.test(sent.playbackContext.contentPlaybackContext.lactMilliseconds), '="${now}" puts in the time');
  assert(sent.playbackContext.contentPlaybackContext.referer == "https://www.youtube.com/#reloadxhr", "=repl(...) edits a string");
  assert(!("clientScreen" in request.context.client) && request.playbackContext.contentPlaybackContext.lactMilliseconds == "-1",
         "the caller's object is unchanged; only what is sent is edited");
  p.ctx.plain = { context: { client: { clientName: "WEB", userAgent: "channel" } } };
  assert(p.eval("JSON.stringify(plain)") == JSON.stringify(p.ctx.plain), "objects that don't match go through untouched");
  assert(p.eval("JSON.stringify([1,'a'])") == '[1,"a"]' && p.eval("JSON.stringify('s')") == '"s"', "and so do non-objects");
}

// -- Timers and frames
{
  const p = page();
  p.run([{ name: "nano-setTimeout-booster", args: ["[native code]", "17000", "0.001"] }]);
  p.eval(`setTimeout(function () {}.bind(null), 17000); setTimeout(() => {}, 17000); setTimeout(function () {}.bind(null), 500);`);
  assert(JSON.stringify(p.ctx.delays) == "[17,17000,500]", "nano-setTimeout-booster: only matching callback and delay");
}
{
  const p = page();
  p.run([
    { name: "trusted-prevent-dom-bypass", args: ["Node.prototype.appendChild", "fetch"] },
    { name: "trusted-prevent-dom-bypass", args: ["Node.prototype.appendChild", "JSON.parse"] },
  ]);
  const frame = p.eval(`let f = { nodeName: "IFRAME" }; Node.prototype.appendChild.call({}, f); f`);
  assert(frame.contentWindow.fetch === p.eval("fetch") && frame.contentWindow.JSON.parse === p.eval("JSON.parse"),
         "trusted-prevent-dom-bypass: a new frame gets the page's own functions");
}

// -- Robustness
{
  const p = page();
  assert(p.run([{ name: "nope", args: [] }, { name: "json-prune", args: [] }, { name: "set-constant", args: ["a", "1"] }]) == 2,
         "unknown scriptlets are skipped, the rest run");
  assert(vm.runInContext(source, p.ctx)("not json") === 0, "bad input runs nothing");
  const names = Object.keys(p.ctx).filter(k => !["URL", "Request", "Response", "Headers", "location", "responses", "fetch", "XMLHttpRequest", "delays", "setTimeout", "Node", "a"].includes(k));
  assert(names.length == 0, "nothing is left on the page's global");
}
