// Where saved logins may be offered (app/components/passwords/PasswordRules.sys.mjs).
const rules = await import("../../app/components/passwords/PasswordRules.sys.mjs");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

// A tiny public suffix list: enough for the edge cases below.
const SUFFIXES = new Set(["com", "org", "io", "net", "uk", "co.uk", "github.io"]);
function getBaseDomain(host) {
  let labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (SUFFIXES.has(labels.slice(i).join("."))) {
      if (i == 0) throw new Error("public suffix");
      return labels.slice(i - 1).join(".");
    }
  }
  throw new Error("unknown suffix");
}

const norm = rules.normalizeOrigin;
assert(norm("https://Accounts.Example.COM/signin?x=1") == "https://accounts.example.com", "origin is lower-cased, path dropped");
assert(norm("https://example.com:443") == "https://example.com", "default port dropped");
assert(norm("https://example.com:8443/") == "https://example.com:8443", "other port kept");
assert(norm("example.com") == "https://example.com", "bare host taken as https");
assert(norm("https://раypal.com").startsWith("https://xn--"), "IDN host becomes punycode");
assert(norm("ftp://example.com") === null && norm("data:text/html,x") === null && norm("file:///etc") === null,
       "other schemes are not origins for logins");
assert(norm("") === null && norm("https://") === null && norm(42) === null, "garbage is refused");

const fillable = rules.isFillableOrigin;
assert(fillable("https://example.com"), "https is fillable");
assert(!fillable("http://example.com"), "plain http is never fillable");
assert(!fillable("http://localhost") && !fillable("http://192.168.1.1"), "no exception for localhost or LAN");
assert(!fillable("null") && !fillable("about:blank") && !fillable("moz-extension://x"), "opaque and internal origins refused");
assert(!fillable("https://Example.com"), "only the normal form is accepted");

const e = (origin, username, extra = {}) => ({ id: username + "@" + origin, origin, username, also: [], used: 0, ...extra });
const entries = [
  e("https://accounts.example.com", "ana"),
  e("https://accounts.example.com", "ana.lab", { used: 5 }),
  e("https://www.example.com", "old"),
  e("https://example.com:8443", "port"),
  e("http://accounts.example.com", "insecure"),
  e("https://paypal.com", "pp"),
  e("https://ana.github.io", "gh"),
  e("https://shop.example.co.uk", "uk"),
  e("https://idp.example.org", "sso", { also: ["https://login.example.org"] }),
  e("https://192.168.1.10", "router"),
];
const match = (origin, allowSameSite = true) => rules.matchEntries(entries, origin, { getBaseDomain, allowSameSite });
const names = list => list.map(x => x.username).join(",");

let m = match("https://accounts.example.com");
assert(names(m.exact) == "ana.lab,ana", "exact origin matches, most used first");
assert(names(m.sameSite) == "old,port", "other origins of the same site are offered separately");
assert(!names(m.exact).includes("port"), "another port is a different origin, never filled as this one");
assert(!names(m.exact).includes("insecure") && !names(m.sameSite).includes("insecure"), "an http entry is never offered");
assert(names(match("https://accounts.example.com", false).sameSite) == "", "no other-subdomain group when not allowed");

assert(names(match("https://paypal.com.evil.io").exact) == "", "paypal.com.evil.io gets nothing of paypal.com");
assert(names(match(norm("https://раypal.com")).exact) == "", "an IDN look-alike gets nothing");
assert(names(match("https://paypal.com.").exact) == "", "a trailing dot is a different origin");
assert(names(match("https://bob.github.io").sameSite) == "", "github.io user sites stay separate");
assert(names(match("https://www.example.co.uk").sameSite) == "uk", "co.uk sites group by registrable domain");
assert(names(match("https://login.example.org").exact) == "sso", "an entry fills on the origins in its also list");
assert(names(match("https://192.168.1.10").exact) == "router" && names(match("https://192.168.1.11").sameSite) == "",
       "IP addresses match only exactly");
assert(names(match("http://accounts.example.com").exact) == "", "nothing is offered on an http page");

assert(rules.findLogin(entries, "https://accounts.example.com", "ana")?.username == "ana", "findLogin by origin and username");
assert(rules.findLogin(entries, "https://accounts.example.com", "nobody") === null, "findLogin misses cleanly");

const id = rules.newEntryId(b => b.fill(255));
assert(id == "_____________________w" && id.length == 22, "entry ids are 16 bytes, base64url, unpadded");

let index = rules.parseIndex(JSON.stringify({ v: 1, entries: [{ id: "a", origin: "https://x.com", username: "u" }, { bad: 1 }] }));
assert(index.entries.length == 1 && Array.isArray(index.never) && index.entries[0].also.length == 0 && index.entries[0].used === 0,
       "parseIndex drops malformed entries and fills defaults");
let threw = false;
try { rules.parseIndex('{"v":2,"entries":[]}'); } catch { threw = true; }
assert(threw, "parseIndex refuses an index version it doesn't know");
