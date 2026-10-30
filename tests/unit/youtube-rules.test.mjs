// The YouTube ad blocker's rule handling (contentblocking/youtube/YouTubeRules.sys.mjs).
const {
  preprocess,
  splitScriptletArgs,
  compileLists,
  rulesForHost,
  domainsMatch,
  isYouTubeHost,
  patternToRegExp,
} = await import("../../app/components/contentblocking/youtube/YouTubeRules.sys.mjs");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const same = (a, b) => JSON.stringify(a) == JSON.stringify(b);

// -- !#if blocks, as uBlock Origin on Firefox without HTML filtering.
const pre = preprocess(`a
!#if env_firefox
b
!#if !cap_html_filtering
c
!#else
d
!#endif
!#endif
!#if env_mv3 || ext_ubol
e
!#else
f
!#endif
!#if (env_firefox && !env_mv3)
g
!#endif`);
assert(same(pre, ["a", "b", "c", "f", "g"]), "!#if, !#else, nesting, && || ! and parentheses");

// -- Scriptlet arguments.
assert(same(splitScriptletArgs("set, a.b, undefined"), ["set", "a.b", "undefined"]), "comma-separated, trimmed");
assert(same(splitScriptletArgs(`trusted-rpfr, '"adSlots"', '"no_ads"', player?`), ["trusted-rpfr", '"adSlots"', '"no_ads"', "player?"]),
       "quoted arguments lose their quotes, keep inner quotes");
assert(same(splitScriptletArgs("x, /a{2\\,4}\\]\\,/, , y"), ["x", "/a{2,4}\\],/", "", "y"]), "escaped commas; empty arguments; other escapes kept");
assert(same(splitScriptletArgs("x, 'a, b', c"), ["x", "a, b", "c"]), "a quoted argument keeps its commas");
assert(same(splitScriptletArgs(""), [""]), "no arguments at all");

// -- Domains.
assert(domainsMatch(["youtube.com"], "www.youtube.com") && domainsMatch(["youtube.com"], "youtube.com"), "a domain covers its subdomains");
assert(!domainsMatch(["youtube.com"], "notyoutube.com"), "but not lookalikes");
assert(domainsMatch(["youtube.*"], "www.youtube.com") && domainsMatch(["youtube.*"], "youtube.co.uk"), "entities: any public suffix");
assert(!domainsMatch(["youtube.com", "~music.youtube.com"], "music.youtube.com"), "negated entries win");
assert(isYouTubeHost("m.youtube.com") && isYouTubeHost("www.youtube-nocookie.com") && !isYouTubeHost("youtube.com.evil.example"),
       "YouTube hosts");

// -- Compiling: only YouTube's scriptlet and element-hiding rules.
const list = `! Title: test
example.com##+js(set, a, 1)
##+js(set, generic, 1)
youtube.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)
youtube.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)
www.youtube.com,example.org##+js(trusted-rpfr, '"adSlots"', '"no_ads"', player?)
m.youtube.com##+js(json-prune.js, adPlacements)
youtube.*##+js(nano-stb, [native code], 17000, 0.001)
www.youtube.com##+js(rpnt, script, /foo/, bar, sedCount, 1)
www.youtube.com##+js(some-unknown-scriptlet, x)
www.youtube.com##+js(json-prune, adSlots)
www.youtube.com#@#+js(json-prune, adSlots)
music.youtube.com#@#+js()
youtube.com###masthead-ad
youtube.com##.ad:style(height: 0 !important)
youtube.com##.tile:has-text(Ad)
youtube.com#?#.x:upward(1)
youtube.com##^script:has-text(fetch)
www.youtube.com#@##masthead-ad
||youtube.com/api/stats/ads$xhr
youtube.com#$#body { color: red }
!#if cap_html_filtering
www.youtube.com##+js(set, html-filtering-only, 1)
!#endif
`;
const compiled = compileLists([list]);
assert(compiled.stats.scriptlets == 8 && compiled.stats.cosmetic == 3, "keeps YouTube scriptlet and element-hiding rules, once each");
assert(compiled.stats.unsupported == 5, "counts unknown scriptlets, procedural, HTML-filtering and AdGuard rules as unsupported");
assert(!JSON.stringify(compiled).includes("generic") && !JSON.stringify(compiled).includes('"a"'),
       "drops rules for other sites and generic ones");
assert(!JSON.stringify(compiled).includes("html-filtering-only"), "applies the !#if blocks");
assert(same(JSON.parse(JSON.stringify(compiled)), compiled), "the result is plain JSON");

const www = rulesForHost(compiled, "www.youtube.com");
const names = www.page.map(s => s.name);
assert(names.includes("set-constant") && names.includes("trusted-replace-fetch-response") && names.includes("nano-setTimeout-booster"),
       "aliases become canonical names; entities apply");
assert(!names.includes("json-prune"), "a specific #@#+js() exception removes the rule");
assert(!names.includes("json-prune") && rulesForHost(compiled, "m.youtube.com").page.some(s => s.name == "json-prune"),
       "rules for one subdomain don't apply on another");
assert(www.node.length == 1 && www.node[0].name == "replace-node-text" && same(www.node[0].args, ["script", "/foo/", "bar", "sedCount", "1"]),
       "node-text scriptlets are kept apart, with their arguments");
assert(same(www.page.find(s => s.name == "trusted-replace-fetch-response").args, ['"adSlots"', '"no_ads"', "player?"]),
       "arguments arrive split");
assert(rulesForHost(compiled, "music.youtube.com").page.length == 0, "#@#+js() turns every scriptlet off there");
assert(same(www.css, [".ad{height: 0 !important}"]), "element hiding: :style() becomes a declaration; exceptions remove selectors");
assert(rulesForHost(compiled, "m.youtube.com").css.includes("#masthead-ad{display:none!important}"), "element hiding elsewhere on YouTube");
assert(same(rulesForHost(compiled, "example.com"), { page: [], node: [], css: [] }), "nothing applies outside YouTube");

// -- Patterns.
assert(patternToRegExp("/a+b/i").test("AAB") && !patternToRegExp("a+b").test("aab") && patternToRegExp("a+b").test("a+b"),
       "a /regex/ is a regex; anything else is literal text");
assert(patternToRegExp("/(/") === null, "an invalid regex gives nothing");
