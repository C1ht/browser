# browser-wip: Stage 1 report and Stage 2 plan

Status: **approved; Stage 3 in progress.** Decisions are recorded below, and they override the open questions at the end of this document.
Design mockups: `design/mockups/chrome-directions.html` (also published as an artifact).

## Decisions (after review)

| Question | Decision | What it means in the build |
|---|---|---|
| Design direction | **Folio** | `app/themes/shared/browser.css` |
| Q1 DRM | **None at first, addable later** | Built with `--enable-eme` off. Adding it later means rebuilding with `--enable-eme=widevine` and adding an on-demand install prompt; nothing else depends on its absence. Paid streaming (Netflix, Disney+, Spotify Web) won't play until then. |
| Q2 Ad blocking | **On by default, our own built-in tool** | EasyList, EasyPrivacy and Fanboy Social are vendored. Network blocking: adblock-rust, already in every libxul, checks every request in the parent (`docs/CONTENT-BLOCKING.md`). Element hiding: stylesheets compiled at build time. Never fetched. No extension needed. |
| Q3 Mozilla downloads | **None**, so no CRLite. Safe Browsing excluded. | OCSP is also off: it reports every site you visit to the certificate authority. Revocation relies on the OneCRL list bundled with each release. A bundled enterprise policy disables Remote Settings entirely. |
| Q4 Extensions | **v2** | Not supported in v1; AMO and update calls are off. |
| Q5 Gecko | **Firefox Release** | Pinned in `GECKO_REVISION` (currently 157.0.2), updated with `tools/fetch-gecko.sh --update`. Considered and rejected on 2026-10-12: Firefox ESR to match Mullvad/Tor Browser, since ordinary Firefox users are the far larger crowd. |
| Q6 Search | **Brave Search**, with DuckDuckGo, Startpage and Mojeek selectable | Suggestions off (not implemented yet). |
| Q7 Decorations | **Desktop-drawn on Linux, app-drawn on Windows** | Linux: no custom titlebar. The compositor must offer server-side decorations to GTK3 apps (KDE's `org_kde_kwin_server_decoration` protocol); otherwise GTK draws its own. Windows is not built yet. |
| Q7 Font | (no preference given) **Bundle Instrument Sans** | Consistent across Linux and Windows. Switching to the desktop font is a one-token change in `browser.css`. |
| Q7 Accent | (no preference given) **Fixed teal** | Contrast is verified for this accent; following the desktop accent can come later. |
| Q7 Desktop services | **Yes**: the desktop handles captive portals, geolocation (GeoClue) and DNS privacy | The browser's own checks are off. |
| Q9 App ID | Not decided | Uses the codename everywhere (`browser-wip`); `tools/rename.sh` swaps it. |
| Q11 Sync | **Never** | No Firefox Accounts code or UI. |

---

## Stage 1: environment report

| Resource | Value |
|---|---|
| CPU | 4 cores |
| RAM | 15 GiB, no swap |
| Disk | 31 GB writable allowance at start, **25 GB** left after the mozilla-central checkout |
| Toolchain on the box | rustc 1.97 (m-c needs ≥ 1.90), clang 18.1, gcc 13.3, node 22, python 3.13 |
| Session limits | Each background command is capped at 2 h (resumable, since `mach build` is incremental). The container is **ephemeral**: it is reclaimed after inactivity, and anything not pushed to git (the objdir, `~/.mozbuild`) is lost. |

**mozilla-central:** shallow clone of `github.com/mozilla-firefox/firefox` (canonical since Mozilla moved to Git) at `2a69ca02` (2026-10-06): 1.0 GB `.git` plus 4.8 GB working tree, at `/home/user/mozilla-central`. It is outside this repo and not committed.

**Bootstrap: partial failure.** `mach bootstrap` installs the system packages it wants and accepts the installed Rust. It then fails on the step that downloads Mozilla's prebuilt toolchains (clang, sysroot, cbindgen, wasi-sysroot, etc.). The network policy blocks these hosts with HTTP 403:

- `firefox-ci-tc.services.mozilla.com` (toolchains, **artifact builds**)
- `archive.mozilla.org`, `ftp.mozilla.org`, `download-installer.cdn.mozilla.net` (prebuilt Firefox runtimes)
- `packages.mozilla.org`, `hg.mozilla.org`

`apt`, `crates.io`, `static.rust-lang.org`, GitHub and npm are reachable.

### Is a full Gecko build realistic here?

**Possible, but marginal. I would not depend on it as the main development loop.**

- **Toolchain:** a build would use Ubuntu's clang 18, Rust 1.97, `cbindgen` from crates.io, and Ubuntu's `wasi-libc` plus `libclang-rt-18-dev-wasm32` for the RLBox sandbox. Mozilla doesn't test this combination, so expect some configure fixups. It is still far more viable than it would be on most distros.
- **Time:** my estimate for one clean optimized build on 4 cores is **2.5–4 hours**. I haven't measured it. It would need two or three resumed 2-hour background runs.
- **Disk:** objdir plus toolchain is about 12–18 GB, against 25 GB free. That fits, but leaves little headroom.
- **Persistence:** the main risk. If the container is reclaimed between my turns (for example while you review), the objdir is gone and the next session starts over.

**What I'd scope Stage 3 to in this environment:**
1. Write all scaffolding, build config, prefs, first-run and chrome code.
2. Verify the build-system integration with `mach configure` against our project. That takes minutes and proves the "zero mozilla-central changes" claim.
3. Run **one** full compile in the background and iterate front-end changes with `mach build faster`, which repackages JS/CSS/XHTML in seconds once libxul exists. If the container is lost mid-build, I'll report that rather than loop.

**What would make this much better (your call, see Q8):** allowlist `firefox-ci-tc.services.mozilla.com` and `firefoxci.taskcluster-artifacts.net`. That enables Mozilla's supported toolchains via bootstrap and **artifact builds**. Our app is almost entirely front-end code on top of an unmodified libxul, so artifact builds would cut a working build to roughly 15–20 minutes. Release builds would still be full compiles, done on a bigger machine or in CI.

---

## 1. Standalone-app architecture

### 1.1 Confirmed: nothing requires touching mozilla-central

I read the build system in the cloned revision:

- `--enable-project=<dir>` (alias `--enable-application`) accepts **any directory under topsrcdir that contains a `moz.configure`** (`build/moz.configure/init.configure`, `include_project_configure`). The root `moz.build` then includes `/<project>/app.mozbuild`. Thunderbird uses the same mechanism with `comm/` checked out inside mozilla-central.
- The only `MOZ_BUILD_APP == "browser"` conditionals outside `browser/` are:
  - **Things we want off anyway:** Normandy and the messaging system are only built for `browser`, so they drop out automatically. Bundled Remote Settings dumps for browser-only collections, the sqlite-vec extension and browser-only tests also drop out.
  - **Harmless:** a Windows-only OLE hook, and `MOZ_BREAK_XUL_OVERLAYS`.
  - **One minor loss:** `nsOSHelperAppService::IsCurrentAppOSDefaultForProtocol` returns false for non-browser apps on GTK. The DE owns default-app settings anyway.

**Layout:** this repo is the product. A pinned mozilla-central lives next to it, and our project directory is mounted into it as `gecko/browser-wip/`. The mount is a symlink if mozbuild accepts one (to verify in Stage 3), otherwise a scripted sync. Our code never lands in mozilla-central's history, and mozilla-central files are never edited.

```
browser/                        ← this repo
  tools/fetch-gecko.sh          pinned m-c revision → ../gecko, mounts app/ as gecko/browser-wip
  tools/rename.sh               codename rename + leftover check (see 1.4)
  tools/netsilence/             test asserting zero unexpected outbound connections
  mozconfigs/{dev,release}
  app/                          ← the --enable-project directory
    moz.configure               app options (below), then include("../toolkit/moz.configure")
    app.mozbuild                include toolkit.mozbuild; DIRS += branding, app
    confvars.sh                 MOZ_BRANDING_DIRECTORY=browser-wip/branding/wip
    moz.build
    launcher/                   main() adapted from browser/app/nsBrowserApp.cpp (MPL-2.0)
    profile/browser-wip.js      the default prefs (the Standard posture)
    branding/wip/               configure.sh, brand.ftl, icons, .desktop, AppStream metainfo
    base/content/               browser.xhtml and the chrome UI
    components/                 privacy modes, first run, settings, session store, blocklists, permissions UI
    locales/en-US/              Fluent strings
    installer/package-manifest.in
```

### 1.2 Build configuration

`app/moz.configure` implies:

- `MOZ_APP_NAME=browser-wip`, `MOZ_APP_VENDOR`, `MOZ_APP_ID`, `MOZ_APP_REMOTINGNAME`, `MOZ_APP_PROFILE`
- `MOZ_PLACES` (history and bookmarks storage), `MOZ_DEDICATED_PROFILES`, `MOZ_BLOCK_PROFILE_DOWNGRADE`
- `BROWSER_CHROME_URL=chrome://browser-wip/content/browser.xhtml`
- `MOZ_DEVTOOLS=server` initially (see Q4)

It deliberately does **not** imply `MOZ_NORMANDY`, `MOZ_SERVICES_SYNC`, `MOZ_SERVICES_HEALTHREPORT`, or `MOZ_PROFILE_MIGRATOR`.

`mozconfig`:
```
ac_add_options --enable-project=browser-wip
ac_add_options --disable-crashreporter      # defaults ON for Linux x86_64; must be explicit
ac_add_options --disable-updater            # defaults ON; updates come from the distro package
ac_add_options --disable-necko-wifi         # Wi-Fi scanner only feeds network geolocation
ac_add_options --disable-backgroundtasks    # only needed by updater and agent machinery
ac_add_options --enable-eme=widevine        # only if Q1 keeps DRM; compiling it in fetches nothing
# MOZILLA_OFFICIAL stays unset: it defaults MOZ_TELEMETRY_REPORTING on.
```

### 1.3 Excluded, and how

Toolkit's defaults are **weaker** than Firefox's, because Firefox sets many protections in `browser/app/profile/firefox.js`. A clear example is `network.cookie.cookieBehavior`, which toolkit leaves at `0` (accept all) and Firefox sets to `5`. So the work has two layers: first restore everything Firefox enables, then remove what phones home.

| Item | How it is excluded |
|---|---|
| Telemetry, Glean/FOG upload | `MOZ_TELEMETRY_REPORTING` not built; upload prefs false; no data-reporting UI |
| Normandy, messaging system | Not built (browser-only directories) |
| Nimbus experiments | Built in toolkit; disabled by prefs, and it gets no data because Remote Settings sync is off |
| Firefox Accounts / Sync | `MOZ_SERVICES_SYNC` not implied; no FxA UI or prefs |
| Crash reporter | `--disable-crashreporter` |
| Updater | `--disable-updater`; updates via distro packages |
| Wi-Fi geolocation (Google) | `--disable-necko-wifi`; `geo.provider.network.url` empty; geolocation via **GeoClue**, which the DE controls |
| Safe Browsing (Google) | All `browser.safebrowsing.*` off, update and lookup URLs empty, download reputation off (see Q3) |
| Remote Settings polling | Server pref neutralized; collections we need ship as bundled local dumps (blocklists, query-stripping list, fingerprinting web-compat exemptions) |
| Push service (Mozilla autopush, connects at startup) | `dom.push.connection.enabled=false`. Notifications still work while a site's tab is open; background web push does not (see Q6) |
| Captive portal and connectivity checks | Off; the DE/NetworkManager owns connectivity |
| GMP auto-download (Widevine, OpenH264) | `media.gmp-manager.updateEnabled=false`; on-demand only (see Q1) |
| Add-on update and discovery (AMO) | Off |
| Speculative network activity | Predictor, link prefetch, DNS prefetch, URL-bar speculative connects off |
| DoH (TRR) | Off; uses the system resolver, where the DE can configure DoT/DoH |
| Search suggestions | Off by default, one-click opt-in in the URL bar dropdown |
| Pocket, Firefox Suggest, sponsored tiles, about:home content | Live in `browser/`; never built |

**Enforcement:** `tools/netsilence/` launches the build with a fresh profile behind a logging proxy and network namespace. It idles, opens every `about:` page, opens Settings, and toggles both privacy modes. It **fails on any outbound connection**. Then it loads one local test page and asserts that only that host is contacted. This test is the definition of "no background calls," and it runs on every build.

### 1.4 What toolkit does *not* give us (we build it)

Toolkit gives us the engine and many backends: Places, password manager, form autofill, downloads backend, PDF.js, reader mode, find bar, printing, Picture-in-Picture, PopupNotifications, the profile service, and about:config. Firefox's **front-end** is all in `browser/`, so we write our own:

tab browser, URL bar and suggestions, session restore, downloads panel, context menus, permission prompts, the **WebRTC device picker and sharing indicator** (needed for video calls in Standard), certificate-error handling, history and bookmarks UI, Settings, the new-tab page, and the DRM prompt.

Where Firefox's MPL code is a good fit, we adapt it with attribution instead of rewriting from scratch.

**Renaming:** the codename appears only in `MOZ_APP_*` values, the branding directory, the chrome package name `browser-wip`, pref prefix `browserwip.`, the desktop-file ID and the binary name. `tools/rename.sh <new>` rewrites all of them, and a CI check greps for leftovers. User-visible strings use Fluent `{ -brand-short-name }` and never hard-code the name.

---

## 2. Privacy posture

**Principle:** Standard is the shipped default prefs file, so a skipped or crashed first run still leaves you in Standard. Strict and Anonymous are presets of overrides. The mode label (Standard / Strict / Anonymous / Custom) is derived from the actual settings, so it can never disagree with them.

**Anonymous** (decided 2026-10-12) is a third mode for looking like everyone else rather than looking random: everything in Strict, plus `resistFingerprinting`, English pages (`privacy.spoof_english=2`), time zone UTC, WebRTC off and letterboxing. It accepts the costs Standard and Strict avoid: UTC clocks, English pages, light page colors, margins around pages, no calls.

| Feature | Standard (default) | Strict Privacy | Reasoning |
|---|---|---|---|
| **WebRTC** | **On.** Host IPs hidden behind mDNS; no host candidates until camera or mic is granted (Gecko's model); clear device picker and sharing indicators. | **Restricted:** `ice.default_address_only` + `no_host`. Only the default-route public address is exposed; no LAN IPs, no VPN bypass. Advanced: "Disable WebRTC entirely". | Calls must work in Standard. Gecko's default IP-leak mitigations already cover most of the privacy value. Strict closes the remaining LAN/VPN leak while most calls (via STUN/TURN) still work. |
| **JIT for web content** | **On** | **Off** for content (Ion, Baseline JIT, optimizing Wasm). Interpreters stay; browser chrome keeps its JIT. | This is a **security** measure: JIT bugs are the most exploited engine class. It does nothing for privacy. Cost: script-heavy apps 2–5× slower, Wasm apps (Figma, games) much slower. Applies to new content processes, so Settings offers "Reload tabs to apply". There's no per-site exception in Gecko today (possible later work). |
| **Fingerprinting** | Firefox's default **Fingerprinting Protection (FPP)** target set plus every target that only changes what pages can measure: WebGL vendor sanitizing, fonts limited to base system set, screen and window geometry, media devices, audio, network type, coarser timers, speech, gamepads, sensors, WebGPU limits. Blocking known fingerprinting scripts is still to do (no bundled list yet). | Same as Standard. **Anonymous:** `resistFingerprinting` (UTC, English, light colors, uniform screen/UA/timers) plus letterboxing. | No `resistFingerprinting` in Standard or Strict: it breaks dark mode, time zones, locale and zoom. Standard takes everything from the anonymous set that nobody notices; the parts people notice live in Anonymous. Time zone → UTC is also a separate Advanced toggle. Letterboxing is our own (`letterbox.js`) because Gecko's (`RFPHelper.sys.mjs`) is written for Firefox's tab browser; with `resistFingerprinting` on, Gecko also stops restoring the window size, so `letterbox.js` sizes new windows to a rounded page area (max 1400×900). The UA is identical to Firefox's (`MOZ_APP_UA_NAME=Firefox` in `moz.configure`; Gecko otherwise appends `browser-wip/<version>`). Standard aims at the largest crowd a Gecko browser can join, ordinary users of the same Firefox release, rather than at Tor/Mullvad users; per-site randomization keeps a fingerprint from linking sites even where it is rare. |
| **Referrers** | Other sites only ever get the origin, even if a page asks for more (`XOriginTrimmingPolicy=2`, as Mullvad Browser). | Same. Advanced: "Hide where you came from" sends none to other sites (`XOriginPolicy=1`), in no mode by default. | Spoofing a referrer breaks more sites than dropping it and hides nothing more. |
| **Cookie partitioning** | **Strict in both:** Total Cookie Protection (`cookieBehavior=5`), bounce-tracking protection, **query-parameter stripping** (bundled list), **Global Privacy Control** on. | Also disables storage-access heuristics, so some sign-in flows ask for permission once. | TCP is invisible and very high value. GPC has legal weight in several jurisdictions and breaks nothing. Heuristics exist for SSO compatibility, so they stay on in Standard. |
| **HTTPS** | **HTTPS-First:** upgrade silently, fall back with a visible "Not secure" chip. | **HTTPS-Only:** interstitial with one-click per-site exception. | HTTPS-Only in Standard would interrupt routers, printers, captive portals and intranets. Ordinary users would learn to click through warnings. |
| **Tracker blocklists (bundled, never fetched)** | Block cross-site trackers (ads, analytics, social), fingerprinters and cryptominers, with **web-compat shims** for common breakage. | Adds the stricter content list and email-tracker blocking. | Delivered through **Gecko's own URL classifier**. Its lists now arrive via Remote Settings (`moz-sbrs://`), which can load **bundled dumps** with no network. Lists update with browser releases, which is fine for tracker domains because they change slowly. **Licensing must be checked (Q10).** |
| **DRM / Widevine** | **Your decision (Q1).** My recommendation: **on-demand.** Zero network activity until a site requests protected playback, then a one-click bar: "This site needs Google's Widevine component to play protected video. Download it?" | Same; the prompt adds a note that Widevine is a closed-source Google component. | See Q1: without a Widevine distribution agreement, "streaming works out of the box" may not be legally achievable. |

**Changing modes without a restart:** cookie behavior, FPP, HTTPS mode, classifier features, query stripping and WebRTC ICE policy are all live prefs (new loads or new connections pick them up). JIT applies to newly created content processes, so Settings reloads tabs or offers to. I'll verify each one in Stage 3, and any that turn out to need a restart get labeled in Settings.

**Per-site escape hatch:** the shield in the address field opens a panel with "Turn off protections for this site". That one toggle is what makes "privacy-focused without breaking the web" work for ordinary people.

---

## 3. First-run screen

The interactive mock is in the design page.

- Shown once, when a profile is created, in place of the first tab. It is a privileged local page with no network access.
- Three cards: **Standard (Recommended)**, preselected, **Strict Privacy** and **Anonymous**. One plain sentence each, no jargon.
- **Advanced** (collapsed): Fast JavaScript (JIT), Full WebRTC, Look like everyone else, Time zone as UTC. The cards and toggles stay in sync, and any other combination shows as **Custom**.
- **Continue, Esc, Enter, or closing the window all land on Standard.** Standard is the defaults file, so clicking through writes nothing.
- No other first-run questions. The DE owns default-browser choice, and data import is out of scope for v1 (Firefox's migrator is in `browser/`).
- Settings has the same cards and toggles. Every option applies live, except JIT, which asks to reload tabs.
- Keyboard and screen-reader complete, with all strings in Fluent.

---

## 4. Layout: tabs below the address bar

```
┌───────────────────────────────────────────────────────────────┐
│ ‹ › ⟳   [ ⚙ fieldguide.org/lichens/cascade-range   ☆ ⛨14 ]  ↓ ≡  ○○○ │  toolbar 48px, window drag region
│ (C)(S) │ Weekly sync 🎥 │╭ Lichens of the Cas… ╮│ Inbox (3) │ +   │  tab strip 40px
├────────────────────────╯                      ╰──────────────────┤
│                         page                                   │
```

- **Why the inversion works:** the address field always describes the active tab, and the active tab now sits directly on the page. The active tab is drawn in the page's background color, with curved shoulders that merge into the page.
- **New-tab flow:** Ctrl+T or `+` opens the tab next to the current one, at the end of the strip, and **moves focus up to the address field**. That's a short eye movement, because the field is directly above. Suggestions drop down from the field over the strip and page. The new-tab page is local only: pinned sites and recent history, no remote content. Middle-click or double-click on empty strip space also opens a tab.
- **Window dragging (Wayland CSD):** empty toolbar space is the drag region, and double-click there maximizes. Empty strip space is for tab actions, never window moves, so the two rows have distinct jobs.
- **Drag to reorder:** horizontal drag with live displacement of neighbors. Pinned tabs reorder only among themselves. Dragging more than about 24px vertically detaches the tab into a new window. Under Wayland the app can't place the new window at the cursor; the compositor decides. Your DE could do better here (Q7). Dropping a link on the strip opens it at that position.
- **Overflow:** tabs shrink to about 96px, then the strip scrolls horizontally with faded edges and a "list all tabs" button at the end.
- **Loading:** the active tab's progress is a thin accent line along the bottom of the address field. Every loading tab's icon becomes a spinner, which is the only state visible across background tabs.
- **Security and privacy indicators** live **in the address field**, because they describe the current page:
  - Left: the site-information button (permissions, cookies, certificate).
  - HTTPS is normal and gets no badge. Plain HTTP gets a warning "Not secure" chip.
  - Right: the bookmark star and the shield with the blocked-tracker count.
  - When camera, mic, screen or location is in use, a red chip with the device glyphs appears in the field and also on that tab.
- **Per-tab state on tabs:** loading, playing audio (click to mute), and camera or mic in use. Nothing else, to keep titles readable.
- **Keyboard:** F6 cycles address field → tab strip → page. In the strip, arrow keys move between tabs and Ctrl+Shift+PgUp/PgDn reorder. Alt+1…9 hints appear on hover after a delay.

---

## 5. Visual design

Mockups for three directions, each in light and dark, plus indicator states and the first-run screen: **`design/mockups/chrome-directions.html`**.

| Direction | Character | Chrome height |
|---|---|---|
| **A · Folio** (recommended) | Folder-tab active tab with curved shoulders into the page; borderless inactive tabs with hairline dividers; cool stone neutrals; deep **teal** accent; Instrument Sans | 88px |
| **B · Graphite** | Dense, precise: equal-width tab cells in a recessed track, Alt+N numbers, monospace URLs; Atkinson Hyperlegible; **cobalt** accent | 74px |
| **C · Pebble** | Soft: page as an inset card on a warm grey backdrop, pill tabs, round buttons; Figtree; muted **berry** accent | 92px + card margins |

**Why Folio:** tabs below the address bar are directly next to the page, so a folder tab is the most literal way to connect the active tab to it. It spends no pixels on margins and is neutral enough to sit inside your DE without clashing. The folder tab alone makes it recognizable. Two ideas from Graphite carry over: Alt+N hints, and the semibold-host URL treatment for spotting lookalike domains.

**Hard constraints, verified for Folio:**
- Light, dark and auto. Auto follows the desktop color-scheme setting via the portal, which Gecko reads. Both palettes are fully specified.
- Contrast (WCAG): primary text 13.3:1 (light) and 14.3:1 (dark). Muted text is **4.7:1 at its worst** (light chrome) and 5.7–6.7:1 elsewhere. Accent on its backgrounds is 5.0–8.5:1. The warning chip is 5.8:1 (light) and 7.8:1 (dark). Everything passes AA.
- One accent, used only for the focus ring, loading progress, selected or checked controls, and the selected first-run card. Camera, mic and warning colors are semantic, not accent.

---

## 6. Open questions and tradeoffs I want you to decide

**Q1 · DRM/Widevine (explicit tradeoff).** Netflix, Disney+, Prime Video, Max and Spotify Web need Widevine. YouTube, Twitch and most news video don't. Widevine is a closed Google binary that Google distributes only to licensed browsers. Firefox fetches it through Mozilla's update service under Mozilla's agreement. Pointing our build at Mozilla's endpoint would technically work (other forks do it), but it isn't ours to use for a separate product.
- (a) **Exclude:** major paid streaming won't work. This conflicts with your "streaming must work" requirement.
- (b) **On-demand prompt (my recommendation):** no network activity until a site asks for it, then one click. This needs either a Widevine license from Google (the proper route; slow and not guaranteed for a small project) or accepting the Mozilla-endpoint gray area.
- (c) **Enabled and pre-downloaded** like Firefox: a background call to Google at startup, which contradicts the no-background-calls rule.

Even with Widevine, Netflix on Linux is capped at 720p. OpenH264 (H.264 for some video calls) has the same structure: Cisco must serve the binary for its patent license to apply, so it can't be bundled. I'd use the same on-demand prompt and default to VP8/VP9.

**Q2 · Ad blocking by default?** Tracker blocking via Gecko's classifier is planned for both modes. Blocking **ads** as well (Brave-style) is a bigger stance. The cleanest mechanism is bundling **uBlock Origin Lite**, which uses declarative rules, ships its lists inside the extension, never fetches them and is GPLv3. That depends on Q4 extension infrastructure. Options: on by default, opt-in, or not at all.

**Q3 · Is Mozilla a "third party"?** Two security features need periodic, anonymous downloads that contain no browsing data:
- **CRLite** (certificate revocation, from Mozilla Remote Settings). Without it we fall back to OCSP, which tells the CA every site you visit, or to no revocation checking.
- **Safe Browsing** (Google). You asked to exclude it, and I've planned that. The cost is that ordinary users get **no phishing or malware warnings**. Bundled lists can't replace it, because phishing domains live for hours.

My suggestion: allow CRLite only, as one documented exception, and keep Safe Browsing out unless you want it back.

**Q4 · Extensions in v1?** Toolkit has the extension engine, but `tabs`, `windows`, `browserAction`, `menus`, `commands`, `bookmarks` and `history` are implemented in `browser/`. Password managers (Bitwarden, 1Password) need them. Supporting them means adapting Firefox's implementations onto our tab browser, which is significant work. DevTools' client has the same `browser/` coupling. Options: no extensions in v1; built-in only (uBO Lite and Firefox's web-compat shims); or full support as a later stage. Password-manager support matters a lot for daily-drivability.

**Q5 · Which Gecko to track?** Firefox **Release** tags (monthly, current web compatibility, and our front-end tracks API changes monthly) or **ESR** (yearly major updates and less churn, but older web-platform features). I recommend Release, pinned per release, with security point releases merged promptly.

**Q6 · Defaults for ordinary users.**
- Default search engine? I'd suggest DuckDuckGo or Startpage.
- Search suggestions off by default?
- Background web push off? This means no Gmail or Slack notifications when the tab is closed, and running a push server is the alternative.

**Q7 · Desktop integration.**
- Server- or client-side window decorations? The mockups assume CSD with controls at the right of the toolbar.
- Chrome font: the DE's UI font, or bundle Instrument Sans (OFL)?
- Fixed teal accent, or follow the DE accent from the portal?
- Does the DE handle captive portals, geolocation (GeoClue) and DNS privacy? I've assumed yes.
- Could your compositor support placing a detached tab's window at the cursor?

**Q8 · Build infrastructure.** Can you allowlist the Mozilla CI hosts (see Stage 1) for this environment? Where will release builds run? This box is too small and too ephemeral for regular full builds.

**Q9 · Identity.** I need a reverse-DNS app ID (desktop file, D-Bus remoting name, extension ID). For example `org.example.BrowserWip`. What domain should it use?

**Q10 · Blocklist licensing.** Mozilla's tracker lists are derived from Disconnect's list. I believe that list is licensed CC BY-NC-SA for anyone other than Mozilla, but this needs verifying. If it is, bundling it in a product needs permission from Disconnect. The fallback is EasyPrivacy (GPLv3 / CC BY-SA), converted to classifier format. It's comparable for tracker domains but loses Disconnect's categories (social, fingerprinting, cryptomining).

**Q11 · No Sync.** Excluding Firefox Accounts means no cross-device sync of bookmarks and passwords. Is that acceptable for v1, or should a self-hostable sync option be on the roadmap?

---

## Stage 3 order (after approval)

1. **Scaffolding and build config:** `fetch-gecko.sh`, project directory, branding, launcher, package manifest. Verify with `mach configure`, then a full compile and a launch to a blank window. Checkpoint.
2. **Default prefs and privacy modes:** prefs file, mode module, bundled Remote Settings dumps, the netsilence test. Verify the prefs actually apply, run the netsilence test, check live switching. Checkpoint.
3. **First-run screen.** Verify keyboard-only flow and the defaults-on-skip behavior. Checkpoint.
4. **Browser chrome and layout:** tab browser, URL bar, tab strip with reordering, indicators, light and dark themes. Checkpoint.

If any build error repeats more than a few attempts, I stop and explain it rather than retrying.
