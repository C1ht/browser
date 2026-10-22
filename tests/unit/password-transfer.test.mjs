// Importing and exporting logins (app/components/passwords/PasswordTransfer.sys.mjs).
// Rows are given as toolkit's CSV.parse returns them: the header, then one
// object per row keyed by the header's names.
const { isVaultFile, loginsFromCSV, planImport, toCSV } = await import(
  "../../app/components/passwords/PasswordTransfer.sys.mjs"
);
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const rowsOf = (header, ...lines) => [header, lines.map(l => Object.fromEntries(header.map((h, i) => [h, l[i]])))];

// Firefox
let [header, rows] = rowsOf(
  ["url", "username", "password", "httpRealm", "formActionOrigin", "guid", "timeCreated", "timeLastUsed", "timePasswordChanged"],
  ["https://accounts.example.com", "ana", "pw1", "", "https://accounts.example.com", "{1}", "1700000000000", "1700000000001", "1700000000002"],
  ["chrome://FirefoxAccounts", "x", "pw", "Firefox Accounts credentials", "", "{2}", "0", "0", "0"],
  ["http://router.home.arpa", "admin", "pw2", "", "", "{3}", "", "", ""],
);
let { logins, skipped } = loginsFromCSV(header, rows);
assert(logins.length == 2 && skipped == 1, "Firefox: web logins kept, chrome:// skipped");
assert(logins[0].origin == "https://accounts.example.com" && logins[0].created == 1700000000000 && logins[0].changed == 1700000000002,
       "Firefox: origin and times carried over");
assert(logins[1].origin == "http://router.home.arpa", "Firefox: an http login is kept (it won't be filled)");

// Chrome
[header, rows] = rowsOf(["name", "url", "username", "password", "note"],
  ["example.com", "https://www.example.com/login?next=/", "bob", "pw3", ""],
  ["app", "android://abc@com.example.app/", "bob", "pw4", ""]);
({ logins, skipped } = loginsFromCSV(header, rows));
assert(logins.length == 1 && logins[0].origin == "https://www.example.com" && skipped == 1,
       "Chrome: the page URL becomes its origin, android:// is skipped");

// Bitwarden
[header, rows] = rowsOf(["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"],
  ["", "", "login", "Mail", "", "", "0", "https://mail.example.org", "carol", "pw5", ""],
  ["", "", "note", "A note", "text", "", "0", "", "", "", ""]);
({ logins, skipped } = loginsFromCSV(header, rows));
assert(logins.length == 1 && logins[0].username == "carol" && skipped == 1, "Bitwarden: login rows kept, notes skipped");

// KeePassXC
[header, rows] = rowsOf(["Group", "Title", "Username", "Password", "URL", "Notes", "TOTP", "Icon", "Last Modified", "Created"],
  ["Root", "Shop", "dave", "pw6", "shop.example.net", "", "", "0", "", ""],
  ["Root", "No URL", "eve", "pw7", "", "", "", "0", "", ""]);
({ logins, skipped } = loginsFromCSV(header, rows));
assert(logins.length == 1 && logins[0].origin == "https://shop.example.net" && skipped == 1,
       "KeePassXC: capitalised headers, a bare host taken as https, entries without a URL skipped");

let threw = null;
try { loginsFromCSV(["name", "notes"], []); } catch (e) { threw = e.code; }
assert(threw == "no-columns", "a file with no address or password column is refused");

const existing = [{ id: "1", origin: "https://accounts.example.com", username: "ana" }];
const plan = planImport(existing, [
  { origin: "https://accounts.example.com", username: "ana", password: "new" },
  { origin: "https://accounts.example.com", username: "ana.lab", password: "x" },
  { origin: "https://accounts.example.com", username: "ana.lab", password: "y" },
  { origin: "http://router.home.arpa", username: "admin", password: "z" },
]);
assert(plan.fresh.length == 2 && plan.duplicates.length == 1 && plan.duplicates[0].existing.id == "1",
       "planImport: a saved site and username is a duplicate to choose about, not overwritten");
assert(plan.repeated == 1 && plan.fresh[0].password == "x", "planImport: a login the file has twice is taken once (the first)");
assert(plan.insecure == 1, "planImport: http logins are counted as not secure");

const csv = toCSV([
  { origin: "https://a.example", username: "ana", password: "p,w\"1", realm: null },
  { origin: "https://b.example", username: " lead", password: "line\nbreak", realm: "Realm" },
]);
assert(csv == 'url,username,password,httpRealm\r\nhttps://a.example,ana,"p,w""1",\r\nhttps://b.example," lead","line\nbreak",Realm\r\n',
       "toCSV quotes commas, quotes, line breaks and edge spaces (RFC 4180)");

assert(isVaultFile(new Uint8Array([0x42, 0x57, 0x56, 0x41, 0x55, 0x4c, 0x54, 0, 2, 0])), "a vault file is recognised by its magic");
assert(!isVaultFile(new TextEncoder().encode("url,username,password\r\n")), "a CSV file is not");
