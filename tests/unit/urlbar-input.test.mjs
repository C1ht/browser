// URL-or-search decision in the address field (app/base/content/urlbar.js).
import fs from "node:fs";
import vm from "node:vm";

const KNOWN_SCHEMES = new Set(["http", "https", "about", "file", "data", "view-source", "chrome", "resource", "moz-extension", "blob", "javascript", "mailto"]);
const context = vm.createContext({
  Services: { io: { getProtocolHandler: s => ({ scheme: KNOWN_SCHEMES.has(s) ? s : "default" }) } },
});
vm.runInContext(fs.readFileSync("app/base/content/urlbar.js", "utf8") + "\nthis.interpretInput = interpretInput;", context);
const { interpretInput } = context;

const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const url = ["example.com", "www.example.com/path?q=1", "https://example.com", "about:config", "localhost", "localhost:8080",
  "192.168.1.1", "10.0.0.1:3000/admin", "[::1]:8080", "printer.local", "router/", "file:///etc/hosts", "sub.domain.co.uk", "example.com."];
const search = ["cats", "how to bake bread", "what is 2.5", "3.14", "C++ templates", "rust", "hello world.com", "?"];
for (const t of url) assert(interpretInput(t)?.url, `"${t}" opens as an address`);
for (const t of search) assert(interpretInput(t)?.search, `"${t}" is a search`);
assert(interpretInput("   ") === null, "blank input does nothing");
assert(interpretInput("javascript:alert(document.cookie)") === null, "javascript: URLs are refused");
assert(interpretInput("JavaScript:void(0)") === null, "javascript: check ignores case");
