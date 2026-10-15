# brag plan: browser-wip

**What it is:** A standalone privacy browser built on Gecko (Firefox 157.0.2) with its own "Folio" front end. It makes no changes to mozilla-central.
**For whom:** People who want the Firefox engine without anything phoning home.
**What sets it apart:** It doesn't just switch telemetry off. The phone-home features are never built (no telemetry, crash reporter, updater, Sync, Normandy or Pocket). A test called `netsilence` fails the build if the browser makes any outbound connection.
**Most impressive claim:** EasyList, EasyPrivacy and Fanboy Social (about 151k lines of filters) are compiled in at build time. They are "never downloaded."
**Visual hook:** A list of everything a normal browser sends home, crossed out one item at a time.
**Real UI:** The Folio chrome: the URL bar with the hostname emphasized, the teal load bar, folder tabs with shoulders, the shield count and the Protections panel. Also the first-run screen, "How much privacy do you want?", with three mode cards.
**Tone:** `polished` with a dry twist (Folio is a restrained, serious design). Humor comes from the codename: the product has no name yet.
**Share caption:** "A Gecko browser that never sends your browsing to us or anyone else, and a test that fails the build if it tries."

## Identity
- Font: Instrument Sans, the project's bundled TTF. Mono text uses Cascadia Mono.
- Colors: the dark Folio tokens for the stage (#15191C chrome, #1D2226 page, #E3E8EB fg, #96A1AA muted, #5EC4BE accent). The browser window uses the light tokens (#E5E9EC, #0B6E6E accent) so it pops.
- Mark: `app/branding/wip/icon.svg`, animated piece by piece.

## Storyboard (23.0s, 1920×1080, 30fps, cuts on the beat at 120 BPM, A minor)

| # | Time | Scene | On screen | Audio |
|---|---|---|---|---|
| 1 Hook | 0.0–3.5 | "Most browsers phone home." | The headline lands. Six chips stagger in: Telemetry, Crash reports, Experiments, Sync, Sponsored tiles, Update pings. A teal strike crosses each one and it dims. | Pad fades in; soft tick per strike |
| 2 Reveal | 3.5–7.5 | Mark + name | The icon builds (teal bar, then the folder). "browser-wip". Eyebrow: "A standalone Gecko browser". Line: "Never sends your browsing to us or anyone else." | Kick enters; low whoosh |
| 3 Blocking | 7.5–13.0 | Folio window | URL is typed: `news.example.com/today`. The teal progress bar runs, then the page loads with empty ad slots collapsing. The shield count ticks 0→14 and the Protections panel opens: "Blocked 14 trackers and ads on this page. Standard privacy is on." Side caption: "Ads and trackers blocked. Built in. On by default." | Typing clicks; tick per count (quiet) |
| 4 Modes | 13.0–16.5 | First run | "How much privacy do you want?" Three cards (Standard / Strict Privacy / Anonymous). The cursor clicks Strict, then Anonymous. The real footer: "You can change this any time in Settings." | Click sfx |
| 5 Proof | 16.5–20.0 | Terminal | `$ tools/netsilence/run.sh dist/bin` → "running for 90s" → "fresh profile · DNS + socket logging · strace … 90s" → big **PASS: no outbound network activity**. Caption: "Phones home? The test fails." | Rise, then hit on PASS |
| 6 Outro | 20.0–23.0 | Lockup | Mark + "browser-wip", "Gecko 157 · no telemetry · no sync · MPL-2.0". Punchline: "Name pending. Privacy isn't." | Pad resolves, tail |

All content is the project's own. Fictional stand-ins: `news.example.com` as the demo site (its blocked count of 14 is illustrative). No personal data is shown.
