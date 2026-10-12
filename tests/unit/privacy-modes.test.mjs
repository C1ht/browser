// Minimal two-branch pref store mirroring nsIPrefService semantics.
const defaults = new Map(), user = new Map();
const T = { PREF_INVALID: 0, PREF_STRING: 32, PREF_INT: 64, PREF_BOOL: 128 };
const typeOf = v => typeof v == "boolean" ? T.PREF_BOOL : typeof v == "number" ? T.PREF_INT : T.PREF_STRING;
const get = n => user.has(n) ? user.get(n) : defaults.get(n);
const prefs = { ...T,
  getPrefType: n => (user.has(n) || defaults.has(n)) ? typeOf(get(n)) : 0,
  getBoolPref: n => get(n), getIntPref: n => get(n), getStringPref: (n, d) => get(n) ?? d,
  setBoolPref: (n, v) => user.set(n, v), setIntPref: (n, v) => user.set(n, v), setStringPref: (n, v) => user.set(n, v),
  clearUserPref: n => user.delete(n), prefHasUserValue: n => user.has(n),
  getDefaultBranch: () => ({ ...T, getPrefType: n => defaults.has(n) ? typeOf(defaults.get(n)) : 0,
    getBoolPref: n => defaults.get(n), getIntPref: n => defaults.get(n), getStringPref: n => defaults.get(n) }),
};
globalThis.Services = { prefs, obs: { notifyObservers() {} } };
// Defaults as in browser-wip.js.
const DEVICE = "+AudioSampleRate,+DeviceSensors,+FontVisibilityBaseSystem,+Gamepad,+MediaCapabilities,+MediaDevices,+NetworkConnection,+ReduceTimerPrecision,+ScreenAvailRect,+ScreenPixelDepth,+ScreenRect,+SpeechSynthesis,+WebGLRendererConstant,+WebGLVendorSanitize,+WebGPULimits,+WindowOuterSize,+WindowScreenXY";
for (const [k, v] of Object.entries({
  "javascript.options.baselinejit": true, "javascript.options.ion": true, "javascript.options.native_regexp": true, "javascript.options.wasm_optimizingjit": true,
  "media.peerconnection.ice.default_address_only": false, "media.peerconnection.ice.no_host": false, "media.peerconnection.enabled": true,
  "privacy.fingerprintingProtection.overrides": DEVICE, "dom.security.https_only_mode": false, "dom.security.https_only_mode_pbm": false,
  "privacy.restrict3rdpartystorage.heuristic.opened_window_after_interaction": true, "privacy.restrict3rdpartystorage.heuristic.redirect": true,
  "privacy.restrict3rdpartystorage.heuristic.recently_visited": true, "privacy.restrict3rdpartystorage.heuristic.window_open": true,
  "privacy.trackingprotection.socialtracking.enabled": false, "browserwip.privacy.mode": "standard",
  "privacy.resistFingerprinting": false, "privacy.resistFingerprinting.pbmode": false, "privacy.spoof_english": 0,
  "privacy.resistFingerprinting.letterboxing": false, "network.http.referer.XOriginPolicy": 0 })) defaults.set(k, v);

const { PrivacyModes } = await import("../../app/components/privacy/PrivacyModes.sys.mjs");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
assert(PrivacyModes.mode == "standard", "fresh profile is standard");
assert(user.size == 0, "fresh profile has no user prefs");
PrivacyModes.setMode("strict");
assert(PrivacyModes.mode == "strict", "setMode(strict) -> strict");
assert(get("javascript.options.ion") === false && get("dom.security.https_only_mode") === true, "strict writes JIT off and HTTPS-Only");
assert(!user.has("privacy.fingerprintingProtection.overrides"), "strict leaves time zone alone");
assert(get("media.peerconnection.enabled") === true, "strict keeps WebRTC available");
assert(get("privacy.resistFingerprinting") === false, "strict leaves resistFingerprinting off");
PrivacyModes.setStrict("utcTimezone", true);
assert(PrivacyModes.mode == "custom", "strict + UTC -> custom");
assert(get("privacy.fingerprintingProtection.overrides").includes("+JSDateTimeUTC") &&
  get("privacy.fingerprintingProtection.overrides").includes("+WebGLVendorSanitize"), "UTC adds to the device-detail targets");
PrivacyModes.setStrict("utcTimezone", false);
assert(!user.has("privacy.fingerprintingProtection.overrides"), "UTC off restores the default target list");
user.set("privacy.fingerprintingProtection.overrides", DEVICE + ",-CanvasRandomization"); // hand-edited
PrivacyModes.setStrict("utcTimezone", true);
assert(get("privacy.fingerprintingProtection.overrides").endsWith(",-CanvasRandomization"), "foreign override entries survive");
user.delete("privacy.fingerprintingProtection.overrides");
PrivacyModes.setMode("anonymous");
assert(PrivacyModes.mode == "anonymous", "setMode(anonymous) -> anonymous");
assert(get("privacy.resistFingerprinting") === true && get("privacy.resistFingerprinting.pbmode") === true &&
  get("privacy.spoof_english") === 2 && get("privacy.resistFingerprinting.letterboxing") === true,
  "anonymous turns on resistFingerprinting, English and letterboxing");
assert(get("privacy.fingerprintingProtection.overrides").includes("+JSDateTimeUTC") && get("media.peerconnection.enabled") === false &&
  get("dom.security.https_only_mode") === true, "anonymous adds UTC, turns calls off and keeps Strict's protections");
PrivacyModes.setStrict("letterboxing", false);
assert(PrivacyModes.mode == "custom", "anonymous without margins -> custom");
PrivacyModes.setStrict("letterboxing", true);
PrivacyModes.setStrict("hideReferrer", true);
assert(get("network.http.referer.XOriginPolicy") === 1 && PrivacyModes.mode == "custom", "hiding the referrer is outside every mode");
PrivacyModes.setMode("strict");
assert(PrivacyModes.mode == "strict" && get("privacy.resistFingerprinting") === false && !user.has("privacy.spoof_english"),
  "anonymous -> strict undoes the anonymous-only prefs");
PrivacyModes.setMode("standard");
assert(PrivacyModes.mode == "standard", "setMode(standard) -> standard");
assert([...user.keys()].length == 0, "back to standard leaves no user prefs: " + [...user.keys()]);
PrivacyModes.init(); PrivacyModes.setStrict("jit", true);
assert(PrivacyModes.pendingRestart.includes("jit"), "JIT change reports pending restart");
PrivacyModes.setStrict("jit", false);
assert(PrivacyModes.pendingRestart.length == 0, "reverting JIT clears pending restart");

// Profiles from before Standard hid device details.
user.set("privacy.fingerprintingProtection.overrides", DEVICE); // old Strict
PrivacyModes.init();
assert(!user.has("privacy.fingerprintingProtection.overrides"), "an old Strict target list goes back to the default");
user.set("privacy.fingerprintingProtection.overrides", "+JSDateTimeUTC"); // old Standard + UTC
PrivacyModes.init();
assert(get("privacy.fingerprintingProtection.overrides") == "+AudioSampleRate,+DeviceSensors,+FontVisibilityBaseSystem,+Gamepad,+JSDateTimeUTC,+MediaCapabilities,+MediaDevices,+NetworkConnection,+ReduceTimerPrecision,+ScreenAvailRect,+ScreenPixelDepth,+ScreenRect,+SpeechSynthesis,+WebGLRendererConstant,+WebGLVendorSanitize,+WebGPULimits,+WindowOuterSize,+WindowScreenXY",
  "an old UTC-only list gains the device-detail targets");
user.delete("privacy.fingerprintingProtection.overrides");

// State helpers used by the first-run preview.
const strictState = PrivacyModes.stateForMode("strict");
assert(PrivacyModes.modeFor(strictState) == "strict", "modeFor(strict preset) -> strict");
assert(PrivacyModes.modeFor(PrivacyModes.stateForMode("standard")) == "standard", "modeFor(standard preset) -> standard");
assert(PrivacyModes.modeFor(PrivacyModes.stateForMode("anonymous")) == "anonymous", "modeFor(anonymous preset) -> anonymous");
assert(PrivacyModes.modeFor({ ...strictState, jit: false }) == "custom", "modeFor(strict minus JIT) -> custom");
PrivacyModes.applyState({ ...strictState, utcTimezone: true });
assert(PrivacyModes.mode == "custom" && PrivacyModes.isStrict("utcTimezone") && PrivacyModes.isStrict("jit"), "applyState writes a previewed custom state");
PrivacyModes.applyState(PrivacyModes.stateForMode("standard"));
assert(user.size == 0, "applyState(standard) leaves no protection prefs: " + [...user.keys()]);
