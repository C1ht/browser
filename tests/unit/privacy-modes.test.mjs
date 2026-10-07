// Minimal two-branch pref store mirroring nsIPrefService semantics.
const defaults = new Map(), user = new Map();
const T = { PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128 };
const typeOf = v => typeof v == "boolean" ? T.PREF_BOOL : typeof v == "number" ? T.PREF_INT : T.PREF_STRING;
const get = n => user.has(n) ? user.get(n) : defaults.get(n);
const prefs = { ...T,
  getPrefType: n => (user.has(n) || defaults.has(n)) ? typeOf(get(n)) : 0,
  getBoolPref: n => get(n), getIntPref: n => get(n), getStringPref: (n, d) => get(n) ?? d,
  setBoolPref: (n, v) => user.set(n, v), setIntPref: (n, v) => user.set(n, v), setStringPref: (n, v) => user.set(n, v),
  clearUserPref: n => user.delete(n),
  getDefaultBranch: () => ({ ...T, getPrefType: n => defaults.has(n) ? typeOf(defaults.get(n)) : 0,
    getBoolPref: n => defaults.get(n), getIntPref: n => defaults.get(n), getStringPref: n => defaults.get(n) }),
};
globalThis.Services = { prefs, obs: { notifyObservers() {} } };
// Defaults as in browser-wip.js.
for (const [k, v] of Object.entries({
  "javascript.options.baselinejit": true, "javascript.options.ion": true, "javascript.options.native_regexp": true, "javascript.options.wasm_optimizingjit": true,
  "media.peerconnection.ice.default_address_only": false, "media.peerconnection.ice.no_host": false, "media.peerconnection.enabled": true,
  "privacy.fingerprintingProtection.overrides": "", "dom.security.https_only_mode": false, "dom.security.https_only_mode_pbm": false,
  "privacy.restrict3rdpartystorage.heuristic.opened_window_after_interaction": true, "privacy.restrict3rdpartystorage.heuristic.redirect": true,
  "privacy.restrict3rdpartystorage.heuristic.recently_visited": true, "privacy.restrict3rdpartystorage.heuristic.window_open": true,
  "privacy.trackingprotection.socialtracking.enabled": false, "browserwip.privacy.mode": "standard" })) defaults.set(k, v);

const { PrivacyModes } = await import("../../app/components/privacy/PrivacyModes.sys.mjs");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
assert(PrivacyModes.mode == "standard", "fresh profile is standard");
assert(user.size == 0, "fresh profile has no user prefs");
PrivacyModes.setMode("strict");
assert(PrivacyModes.mode == "strict", "setMode(strict) -> strict");
assert(get("javascript.options.ion") === false && get("dom.security.https_only_mode") === true, "strict writes JIT off and HTTPS-Only");
assert(!get("privacy.fingerprintingProtection.overrides").includes("JSDateTimeUTC"), "strict leaves time zone alone");
assert(get("media.peerconnection.enabled") === true, "strict keeps WebRTC available");
PrivacyModes.setStrict("utcTimezone", true);
assert(PrivacyModes.mode == "custom", "strict + UTC -> custom");
PrivacyModes.setStrict("hideDeviceDetails", false);
assert(get("privacy.fingerprintingProtection.overrides") == "+JSDateTimeUTC", "removing device details keeps UTC target");
PrivacyModes.setStrict("utcTimezone", false);
user.set("privacy.fingerprintingProtection.overrides", "-CanvasRandomization"); // hand-edited
PrivacyModes.setStrict("hideDeviceDetails", true);
assert(get("privacy.fingerprintingProtection.overrides").endsWith(",-CanvasRandomization"), "foreign override entries survive");
user.delete("privacy.fingerprintingProtection.overrides");
PrivacyModes.setMode("standard");
assert(PrivacyModes.mode == "standard", "setMode(standard) -> standard");
assert([...user.keys()].length == 0, "back to standard leaves no user prefs: " + [...user.keys()]);
PrivacyModes.init(); PrivacyModes.setStrict("jit", true);
assert(PrivacyModes.pendingRestart.includes("jit"), "JIT change reports pending restart");
PrivacyModes.setStrict("jit", false);
assert(PrivacyModes.pendingRestart.length == 0, "reverting JIT clears pending restart");
