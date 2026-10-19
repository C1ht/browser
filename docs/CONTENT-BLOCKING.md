# Content blocking

The built-in ad and tracker blocker has two parts:

- **Network blocking** decides which requests may go out. It uses adblock-rust, the engine Brave uses.
- **Element hiding** hides the empty ad slots that blocked requests leave behind.

Both use the vendored EasyList, EasyPrivacy and Fanboy Social lists (`app/components/contentblocking/lists/`, updated with `tools/update-blocklists.py`). Nothing is fetched.

## Network blocking (phase 1)

`app/components/contentblocking/blocker/`, all in our own code. Nothing in mozilla-central changes.

- **Engine.** Every libxul already links adblock-rust 0.12.1 through toolkit's `content_classifier_engine` crate, which is unconditional in `gkrust-shared`. That crate has a small C FFI: build an engine from rule lines, and check a request. `AdblockRustEngine.cpp` is the only file that calls it, behind the `NetworkFilterEngine` interface, so the engine can be swapped (phase 2 brings its own build).
- **Lists.** The lists ship as text. `ContentBlockingLists.sys.mjs` reads them at startup and hands them to the blocker. The blocker drops element-hiding lines and the rules described under "What isn't supported yet", then builds two engines on a background thread:
  - EasyList and EasyPrivacy
  - Fanboy Social

  A build takes about 0.15 s.
- **Where requests are checked.** An `http-on-modify-request` observer in the parent sees every HTTP request from every content process, including a site's own requests. It sees them again for each redirect target. The fields it passes:

  | Field | Value |
  |---|---|
  | URL | The request's ASCII URL. |
  | Host | The request's host, not its registrable domain. Host-anchored rules (`\|\|ads.example.com^`) compare hostnames by suffix, so passing the domain would miss them. |
  | Source host | The host of the document that made the request, the frame's own document for requests from frames. A sandboxed document counts as the site that created it. |
  | Request type | Named as WebExtensions name them. `fetch()` counts as `xmlhttprequest`. |
  | Third party | Whether the two hosts belong to different sites. |
- **What a block does.** It is reported exactly as Gecko's tracking protection reports one:
  - `requestBlockingReason` is 2004 ("Tracking" in devtools), or 2009 for the social list.
  - The matched list is recorded as `browserwip-ads-trackers` or `browserwip-social`.
  - An entry goes into the content-blocking log, which the shield counts.

  The channel is then cancelled with `NS_ERROR_TRACKING_URI` or `NS_ERROR_SOCIALTRACKING_URI`. Gecko's URL classifier gets no tables at all, so nothing is blocked or counted twice.
- **Switches.** The blocker follows the existing prefs; nothing new was added:
  - `privacy.trackingprotection.enabled` turns blocking on, and `.pbmode.enabled` does the same in private windows.
  - `privacy.trackingprotection.socialtracking.enabled` adds the social list. Strict and Anonymous turn it on.
  - The shield's per-site switch (the content-blocking allow list) lets a site's requests through.
- **Startup.** Requests made before the engines are built are held, then checked. They are let go unchecked straight away if the build fails, if protection is turned off, or after 10 seconds. If the engines fail to build or take longer than that, the shield shows a crossed-out icon on every site and says "Ad and tracker blocking isn't working".
- **Logging.** `MOZ_LOG=BrowserWipBlocker:3` logs startup, rule counts and state changes. Level `:4` adds each check's main-thread time, and `:5` adds the URL. The log stays local; nothing is sent anywhere.

### Top-level pages are not blocked

Pages opened in a tab are never blocked in this phase, even when a rule matches them. EasyList has **590 `$document` rules** for whole pages: scam and pop-under landing pages. uBlock Origin shows a "page blocked" screen for these, with a way to continue anyway.

Cancelling the load without such a screen would leave an error page and no way forward, so these rules are not applied until that screen exists. It's in the [backlog](BACKLOG.md).

Frames (`subdocument`) and everything else a page loads are blocked as usual.

### What isn't supported yet

| Item | Status | Back in |
|---|---|---|
| `$redirect=` and `$redirect-rule=` (28 rules, all in EasyPrivacy) | Left out of the engine. Without the stand-in resources the engine would block these requests instead of answering them, which breaks pages that need the stand-in. The count is logged at startup. | Phase 2 |
| Top-level pages (`$document`) | Not blocked, as described above. | When the blocked page exists |
| `$popup` | Never matches. | |
| `$csp=` | Ignored. | |
| `$removeparam` | Ignored. The engine works out the rewritten URL, but the FFI doesn't return it. | |
| Options adblock-rust 0.12.1 doesn't know (`$header`, `$permissions`, `$replace`, `$urltransform`, `$denyallow`, `$to`, `$method`, `$strict1p`, `$strict3p`, ...) | The whole rule is dropped by the engine's parser. | |
| `!#if` and `!#include` | Not processed. | |
| Requests that aren't HTTP (`data:`, `blob:`, `file:`), and responses a service worker serves from its own cache | Not seen. A service worker's own network requests are seen. | |
| Cosmetic and scriptlet rules (`+js`, procedural `#?#` rules, `:has-text` and the like) | Element hiding keeps working as before (`compile_lists.py`, `ContentBlockingChild.sys.mjs`). | Phase 2 |

### Behaviour changes from the URL-classifier tables

- **Every request is checked**, not only third-party ones.
- **All network rules apply**, not only plain host rules: paths, wildcards, regular expressions, `$domain=`, types, exceptions and `$important`.
- **Trackers that aren't blocked are no longer annotated as trackers.** Before, the classifier did annotate them; this covered requests let through by an exception or on a site with protections off. Annotation feeds Gecko's tracker-specific cookie rules and request prioritisation.
- **DNS.** `nsHttpChannel::BeginConnect` starts a DNS lookup for the request's host (`MaybeStartDNSPrefetch`) before it fires `http-on-modify-request`. The classifier used to cancel requests before that point. `tools/runtime/check.py` part 7 tests whether blocked hosts get looked up, in Standard and in Strict.

### Tests

- **`tests/blocker/hand-cases.json`.** About 20 cases whose expected verdicts are worked out from filter semantics, each naming the list rule it rests on. A failure means the glue is wrong.
- **`tests/blocker/cases.json`.** 406 requests recorded on real pages: a YouTube watch page and the independent.co.uk and speedtest.net front pages. `cases-expected.json` holds adblock-rust's own verdicts for them.
- **`tools/adblock`.** Builds adblock-rust exactly as Gecko does, without Gecko:
  - `reference` checks both case files against the engine.
  - `stress` feeds the FFI's calls odd input (very long, IDN, malformed, empty) with the full lists. Gecko builds Rust with `panic = "abort"`, so a panic in the engine would take the browser down.

  The `Ad blocker engine` workflow runs both on Linux and Windows.
- **`tools/runtime/check.py` part 7.** Runs on the built browser. Requests go through a local proxy that answers for every host. It covers:
  - the hand and recorded cases
  - blocking reasons and list names
  - the shield count, the per-site switch and the social list
  - startup holding
  - odd URLs
  - the "not working" shield
  - DNS lookups for blocked hosts
