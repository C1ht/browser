/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Default preferences for browser-wip.
//
// These ARE the Standard privacy mode: a profile that never changes a setting
// runs exactly these values, so a skipped or crashed first run still lands on
// Standard. Strict Privacy, Anonymous and the Advanced toggles are applied as
// user prefs on top of these by PrivacyModes.sys.mjs.
//
// Toolkit's own defaults (modules/libpref/init/all.js) are weaker than
// Firefox's, which sets most protections in browser/app/profile/firefox.js.
// Section 2 restores them; section 3 removes every background connection.

// ---------------------------------------------------------------------------
// 1. Application
// ---------------------------------------------------------------------------

// The first window toolkit's default command-line handler opens.
pref("toolkit.defaultChromeURI", "chrome://browser-wip/content/browser.xhtml");
pref("browser.chromeURL", "chrome://browser-wip/content/browser.xhtml");

// Appearance: "auto" follows the desktop; "light" or "dark" force one.
pref("browserwip.appearance", "auto");

// Links and window.open() calls that ask for a new window open a tab instead
// (3), except popups that set a size or position (restriction 2).
pref("browser.link.open_newwindow", 3);
pref("browser.link.open_newwindow.restriction", 2);
pref("browser.link.open_newwindow.override.external", -1);

// Find bar: toolkit's widget expects these (Firefox's values). Typing on a
// page does not start a search.
pref("accessibility.typeaheadfind", false);
pref("accessibility.typeaheadfind.timeout", 5000);
pref("accessibility.typeaheadfind.flashBar", 1);
pref("accessibility.typeaheadfind.linksonly", false);

// Downloads go straight to the Downloads folder, as in Firefox, and show in
// the downloads panel (downloads.js). Settings can pick another folder or ask
// each time. Toolkit's defaults would ask with a bare file picker. Downloads
// are kept out of Windows' recent documents.
pref("browser.download.useDownloadDir", true);
pref("browser.download.folderList", 1);
pref("browser.download.always_ask_before_handling_new_types", false);
pref("browser.download.manager.addToRecentDocs", false);

// At startup, open a new tab (false) or the previous session's tabs (true).
// After a crash the previous session always comes back.
pref("browserwip.startup.restoreSession", false);

// Closing the last tab closes the window.
pref("browser.tabs.closeWindowWithLastTab", true);

// Search. Brave Search runs its own index and needs no API key for results.
// Suggestions send each keystroke to the engine, so they are opt-in.
pref("browserwip.search.engine", "brave");
pref("browserwip.search.suggest.enabled", false);

// Privacy mode as last chosen by the user. Informational: the effective mode
// is always derived from the actual prefs (PrivacyModes.sys.mjs).
pref("browserwip.privacy.mode", "standard");
pref("browserwip.firstrun.completed", false);

// Version of the bundled filter lists last loaded into the URL classifier.
pref("browserwip.contentblocking.listsVersion", "");

// ---------------------------------------------------------------------------
// 2. Protections (Standard)
// ---------------------------------------------------------------------------

// Total Cookie Protection: every site gets its own cookie jar.
pref("network.cookie.cookieBehavior", 5);
pref("network.cookie.cookieBehavior.pbmode", 5);

// Bounce-tracking protection: purge state of sites that only redirect.
pref("privacy.bounceTrackingProtection.mode", 1);

// Global Privacy Control: tell sites not to sell or share data.
pref("privacy.globalprivacycontrol.enabled", true);

// Strip known click-tracking parameters from navigations. The list is bundled
// here because Firefox fetches it from Remote Settings.
pref("privacy.query_stripping.enabled", true);
pref("privacy.query_stripping.enabled.pbmode", true);
pref("privacy.query_stripping.strip_list", "__hsfp __hssc __hstc __s _hsenc _openstat dclid epik fbclid gbraid gclid gclsrc hsCtaTracking igshid mc_eid ml_subscriber ml_subscriber_hash msclkid oft_c oft_ck oft_d oft_id oft_ids oft_k oft_lk oft_sk oly_anon_id oly_enc_id rb_clickid s_cid srsltid ttclid twclid vero_conv vero_id wbraid wickedid yclid");

// HTTPS-First: try HTTPS, fall back to HTTP with a visible warning.
pref("dom.security.https_first", true);
pref("dom.security.https_first_pbm", true);
pref("dom.security.https_only_mode", false);
pref("security.mixed_content.block_active_content", true);
pref("security.mixed_content.upgrade_display_content", true);

// Ads and trackers, from the bundled lists (ContentBlockingLists.sys.mjs).
// The classifier only blocks third-party loads, so a site's own resources are
// never affected. Mozilla's table names are replaced so nothing looks for
// tables that would have to be downloaded.
pref("privacy.trackingprotection.enabled", true);
pref("privacy.trackingprotection.pbmode.enabled", true);
pref("privacy.trackingprotection.socialtracking.enabled", false);
pref("privacy.trackingprotection.fingerprinting.enabled", false);
pref("privacy.trackingprotection.cryptomining.enabled", false);
pref("privacy.trackingprotection.emailtracking.enabled", false);
pref("privacy.trackingprotection.emailtracking.pbmode.enabled", false);
pref("urlclassifier.trackingTable", "wip-ads-digest256,wip-track-digest256");
pref("urlclassifier.trackingAnnotationTable", "wip-ads-digest256,wip-track-digest256");
pref("urlclassifier.trackingWhitelistTable", "");
pref("urlclassifier.trackingAnnotationWhitelistTable", "");
pref("urlclassifier.features.socialtracking.blacklistTables", "wip-social-digest256");
pref("urlclassifier.features.socialtracking.annotate.blacklistTables", "wip-social-digest256");
pref("urlclassifier.features.socialtracking.whitelistTables", "");
pref("urlclassifier.features.socialtracking.annotate.whitelistTables", "");
pref("urlclassifier.features.fingerprinting.blacklistTables", "");
pref("urlclassifier.features.fingerprinting.annotate.blacklistTables", "");
pref("urlclassifier.features.fingerprinting.whitelistTables", "");
pref("urlclassifier.features.fingerprinting.annotate.whitelistTables", "");
pref("urlclassifier.features.cryptomining.blacklistTables", "");
pref("urlclassifier.features.cryptomining.annotate.blacklistTables", "");
pref("urlclassifier.features.cryptomining.whitelistTables", "");
pref("urlclassifier.features.cryptomining.annotate.whitelistTables", "");
pref("urlclassifier.features.emailtracking.blocklistTables", "");
pref("urlclassifier.features.emailtracking.allowlistTables", "");
pref("urlclassifier.features.emailtracking.datacollection.blocklistTables", "");
pref("urlclassifier.features.emailtracking.datacollection.allowlistTables", "");
pref("urlclassifier.features.consentmanager.annotate.blocklistTables", "");
pref("urlclassifier.features.consentmanager.annotate.allowlistTables", "");
pref("urlclassifier.features.antifraud.annotate.blocklistTables", "");
pref("urlclassifier.features.antifraud.annotate.allowlistTables", "");
pref("urlclassifier.features.harmfuladdon.blocklistTables", "");
// Element hiding for leftover ad slots (ContentBlockingChild.sys.mjs).
pref("browserwip.contentblocking.cosmetic.enabled", true);

// Fingerprinting Protection: Gecko's default target set (canvas
// randomization, language-pack-only fonts, tiered hardware concurrency,
// fdlibm math, screen and touch normalization), plus everything that only
// changes what pages can measure about the device: graphics card, installed
// fonts, screen and window geometry, media devices, audio, network type,
// timer precision, speech voices, gamepads, sensors and WebGPU limits.
// Time zone, language and color scheme stay real; the Anonymous mode
// (resistFingerprinting) hides those too. PrivacyModes.sys.mjs writes this
// list sorted, so keep it sorted for a return to Standard to clear the pref.
pref("privacy.fingerprintingProtection", true);
pref("privacy.fingerprintingProtection.pbmode", true);
pref("privacy.fingerprintingProtection.overrides", "+AudioSampleRate,+DeviceSensors,+FontVisibilityBaseSystem,+Gamepad,+MediaCapabilities,+MediaDevices,+NetworkConnection,+ReduceTimerPrecision,+ScreenAvailRect,+ScreenPixelDepth,+ScreenRect,+SpeechSynthesis,+WebGLRendererConstant,+WebGLVendorSanitize,+WebGPULimits,+WindowOuterSize,+WindowScreenXY");
pref("privacy.resistFingerprinting", false);
pref("privacy.resistFingerprinting.pbmode", false);
pref("privacy.spoof_english", 0);
// Margins around pages so their size comes in steps (letterbox.js). Only
// the Anonymous mode turns it on.
pref("privacy.resistFingerprinting.letterboxing", false);

// WebRTC on, for calls. Gecko already hides LAN addresses behind mDNS names
// and offers no host candidates until camera or microphone is granted.
pref("media.peerconnection.enabled", true);
pref("media.peerconnection.ice.obfuscate_host_addresses", true);
pref("media.peerconnection.ice.default_address_only", false);
pref("media.peerconnection.ice.no_host", false);
pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);

// JIT on. Strict turns it off for web content; the browser's own UI keeps it.
pref("javascript.options.jit_trustedprincipals", true);

// Referrers: another site only ever learns the site you came from, never
// the page, even if a site asks for more with its own Referrer-Policy (as
// Tor Browser and Mullvad Browser do). "Hide where you came from" in
// Advanced (XOriginPolicy) drops it for other sites entirely.
pref("network.http.referer.defaultPolicy", 2);
pref("network.http.referer.defaultPolicy.pbmode", 2);
pref("network.http.referer.XOriginTrimmingPolicy", 2);
pref("network.http.referer.XOriginPolicy", 0);

// Hyperlink auditing pings.
pref("browser.send_pings", false);

// Revocation without network lookups: OCSP tells the certificate authority
// every site you visit, and CRLite filters come from Mozilla's servers.
// OneCRL ships in the build and updates with releases.
pref("security.OCSP.enabled", 0);
pref("security.OCSP.require", false);
pref("security.pki.crlite_mode", 0);
pref("security.remote_settings.crlite_filters.enabled", false);
pref("security.remote_settings.intermediates.enabled", false);

// ---------------------------------------------------------------------------
// 3. No background connections
//
// tools/netsilence verifies this section: a fresh profile left idle makes no
// outbound connections at all.
// ---------------------------------------------------------------------------

// Telemetry and data reporting (also compiled out: MOZ_TELEMETRY_REPORTING).
pref("datareporting.healthreport.uploadEnabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("datareporting.usage.uploadEnabled", false);
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.unified", false);
pref("toolkit.telemetry.archive.enabled", false);
pref("toolkit.telemetry.server", "");
pref("toolkit.telemetry.dap.leader.url", "");
pref("toolkit.telemetry.dap.helper.url", "");
pref("toolkit.coverage.endpoint.base", "");

// Experiments.
pref("app.normandy.enabled", false);
pref("app.shield.optoutstudies.enabled", false);
pref("nimbus.rollouts.enabled", false);
pref("messaging-system.rsexperimentloader.enabled", false);

// Remote Settings is disabled through the bundled enterprise policy
// (app/policies); these keep the poller idle as well.
pref("services.settings.poll_interval", 0);

// Safe Browsing (Google): excluded, including download reputation.
pref("browser.safebrowsing.malware.enabled", false);
pref("browser.safebrowsing.phishing.enabled", false);
pref("browser.safebrowsing.blockedURIs.enabled", false);
pref("browser.safebrowsing.downloads.enabled", false);
pref("browser.safebrowsing.downloads.remote.enabled", false);
pref("browser.safebrowsing.downloads.remote.url", "");
pref("browser.safebrowsing.provider.google.updateURL", "");
pref("browser.safebrowsing.provider.google.gethashURL", "");
pref("browser.safebrowsing.provider.google4.updateURL", "");
pref("browser.safebrowsing.provider.google4.gethashURL", "");
pref("browser.safebrowsing.provider.google4.dataSharingURL", "");
pref("browser.safebrowsing.provider.google5.updateURL", "");
pref("browser.safebrowsing.provider.google5.gethashURL", "");
pref("browser.safebrowsing.provider.mozilla.updateURL", "");
pref("browser.safebrowsing.provider.mozilla.gethashURL", "");
pref("urlclassifier.malwareTable", "");
pref("urlclassifier.phishTable", "");
pref("urlclassifier.downloadAllowTable", "");
pref("urlclassifier.downloadBlockTable", "");
pref("urlclassifier.globalCacheTable", "");
pref("urlclassifier.blockedTable", "");

// Push service (Mozilla autopush holds a WebSocket open from startup).
// Notifications still work while a site's tab is open.
pref("dom.push.enabled", false);
pref("dom.push.connection.enabled", false);
pref("dom.push.serverURL", "");

// Connectivity and captive-portal probes. The desktop's NetworkManager owns
// connectivity checking.
pref("network.captive-portal-service.enabled", false);
pref("network.connectivity-service.enabled", false);
pref("captivedetect.canonicalURL", "");

// Geolocation from the operating system, which the user controls there
// (GeoClue on Linux, Windows' location service); never Google's network
// lookup. Sites still have to ask (permissions.js).
pref("geo.provider.use_geoclue", true);
pref("geo.provider.ms-windows-location", true);
pref("geo.provider.network.url", "");
pref("browser.region.network.url", "");
pref("browser.region.update.enabled", false);

// DNS through the system resolver, never a built-in DoH provider.
pref("network.trr.mode", 5);

// Speculative connections: nothing is fetched before the user asks for it.
pref("network.prefetch-next", false);
pref("network.dns.disablePrefetch", true);
pref("network.dns.disablePrefetchFromHTTPS", true);
pref("network.http.speculative-parallel-limit", 0);
pref("network.predictor.enabled", false);
pref("network.predictor.enable-prefetch", false);

// Media plugins (Widevine, OpenH264) are never downloaded automatically.
pref("media.gmp-manager.updateEnabled", false);
pref("media.gmp-manager.url", "");
pref("media.gmp-gmpopenh264.enabled", false);
pref("media.gmp-gmpopenh264.autoupdate", false);
pref("media.gmp-widevinecdm.enabled", false);
pref("media.gmp-widevinecdm.autoupdate", false);
pref("media.eme.enabled", false);

// Add-ons are not supported until v2; keep the manager from calling AMO.
pref("extensions.update.enabled", false);
pref("extensions.update.autoUpdateDefault", false);
pref("extensions.getAddons.cache.enabled", false);
pref("extensions.blocklist.enabled", false);
pref("extensions.systemAddon.update.enabled", false);
pref("extensions.abuseReport.enabled", false);
pref("webextensions.storage.sync.enabled", false);
pref("webextensions.storage.sync.serverURL", "");

// Machine-learning features download models from Mozilla.
pref("browser.ml.enable", false);
pref("browser.ml.chat.enabled", false);
pref("browser.translations.enable", false);
pref("captchadetection.actor.enabled", false);
pref("toolkit.shopping.ohttpConfigURL", "");
pref("toolkit.shopping.ohttpRelayURL", "");

// Password manager: no Firefox Relay, no breach alerts.
pref("signon.firefoxRelay.feature", "disabled");
pref("signon.management.page.breach-alerts.enabled", false);
pref("signon.recipes.remoteRecipes.enabled", false);

// Firefox Accounts and Sync are not part of this browser.
pref("identity.fxaccounts.enabled", false);

// Other report endpoints.
pref("media.decoder-doctor.new-issue-endpoint", "");
pref("extensions.webcompat-reporter.newIssueEndpoint", "");
pref("devtools.performance.recording.ui-base-url", "");
pref("browser.tabs.crashReporting.sendReport", false);
