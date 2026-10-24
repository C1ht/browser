// Search suggestions' answers (app/components/library/SearchEngines.sys.mjs).
globalThis.Services = { prefs: { getStringPref: (n, d) => d } };
const { parseSuggestions, SEARCH_ENGINES, searchURL, currentEngine } = await import(
  "../../app/components/library/SearchEngines.sys.mjs"
);
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

assert(JSON.stringify(parseSuggestions('["weath",["weather","weather radar"]]', "weath")) == '["weather","weather radar"]',
       "the OpenSearch answer: the second element");
assert(parseSuggestions('["weather",["Weather","weather today"]]', "weather").join() == "weather today",
       "the query itself is left out, whatever its case");
assert(parseSuggestions('["a",["b","b","B ","c","d","e","f","g"]]', "a").join() == "b,c,d,e,f", "no duplicates, at most five");
assert(parseSuggestions('["a",[1,null,{"x":1},"ok"]]', "a").join() == "ok", "only strings");
assert(parseSuggestions(JSON.stringify(["a", ["line\nbreak", "x".repeat(300)]]), "a").join() == "line break",
       "control characters become spaces; very long ones are dropped");
assert(parseSuggestions("<html>", "a").length == 0 && parseSuggestions('{"a":1}', "a").length == 0,
       "anything else gives none");
assert(currentEngine().id == "brave" && searchURL("a b&c") == "https://search.brave.com/search?q=a%20b%26c",
       "Brave Search by default; terms are encoded");
assert(SEARCH_ENGINES.mojeek.suggest === null && Object.values(SEARCH_ENGINES).filter(e => e.suggest).every(e => e.suggest.startsWith("https://")),
       "Mojeek has no suggestions; the others are HTTPS");
