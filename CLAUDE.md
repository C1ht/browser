# CLAUDE.md

Guidance for Claude Code (and anyone else) working on this repository.

## What this is

browser-wip is a standalone Gecko browser. It has its own front end (window, tab strip, address bar, settings and library pages) on top of Gecko and toolkit. It tracks a pinned Firefox Release (`GECKO_REVISION`) and makes **no changes to mozilla-central**. `browser-wip` is a codename; `tools/rename.sh` replaces it everywhere.

The maintainer uses their local dev build as their everyday browser. A regression is felt immediately, so test what you change.

Key docs:
- `docs/PLAN.md`: decisions and rationale (privacy posture, DRM, search, design). The decisions table at the top overrides the open questions further down.
- `docs/CONTENT-BLOCKING.md`: the network blocker, element hiding, the shield count.
- `docs/PASSWORDS.md`: the password vault.
- `docs/MANUAL-CHECKS.md`: what headless runtime checks can't verify.
- `docs/BACKLOG.md`: ideas not started.

## Directory layout

The Gecko checkout sits next to this repo, never inside it:

```
~/Documents/Projects/Browser/
  browser/            this repo
  mozilla-central/    pinned Firefox source (tools/fetch-gecko.sh)
    browser-wip/  ->  symlink to browser/app (the --enable-project directory)
    obj-browser-wip/  dev build      (mozconfigs/dev-bootstrap)
    obj-release/      release build  (mozconfigs/ci-linux, used by dev-release.sh)
```

| Path | What it is |
|---|---|
| `app/moz.configure` | Product identity; build-time features on/off (telemetry, crash reporter and updater off; EME on with Widevine) |
| `app/profile/browser-wip.js` | Default prefs. These are the Standard privacy mode. |
| `app/base/content/` | Browser window (`browser.xhtml`, `browser.js`), `tabbrowser.js`, `urlbar.js`, `taboverview.js`, panels, and the about: pages (settings, welcome, newtab, history, bookmarks, passwords, blocked) |
| `app/base/jar.mn` | Chrome registration. Every new content file must be listed here. |
| `app/components/` | Privileged modules (`*.sys.mjs`, served as `resource://gre/modules/browserwip/…`) and JSWindowActors, one directory per feature |
| `app/components/startup/BrowserWipGlue.sys.mjs` | Startup: registers every JSWindowActor (`JSWINDOWACTORS`) and starts services |
| `app/components/contentblocking/` | Network blocker (C++, `blocker/`), filter lists, element hiding, the YouTube ad blocker (opt-in) |
| `app/components/passwords/` | Password manager: C++ vault (`service/`, libsodium) and actors |
| `app/components/privacy/PrivacyModes.sys.mjs` | Standard / Strict / Anonymous modes and their toggles |
| `app/locales/en-US/browser-wip/*.ftl` | All UI strings (Fluent) |
| `app/themes/shared/` | CSS ("Folio" design), icons, the bundled Instrument Sans font |
| `app/branding/wip/` | Icons and logo (`icon.svg`, `mark.svg`, PNGs, `.ico`) |
| `tools/runtime/check.py` | Runtime checks against a built browser (Marionette) |
| `tests/unit/` | Node and Python tests that need no Gecko build |
| `tools/release/` | Local dev-build packaging and publishing |
| `mozconfigs/` | `dev-bootstrap` (use this one), `dev` (Ubuntu, clang-20), `ci-linux`, `ci-win64`, `release` |

## Building

On this machine (Arch, no passwordless sudo) use `mozconfigs/dev-bootstrap`. Some tools (`unzip`, `zip`, `strace`) live in `~/.local/bin`, which isn't on PATH by default, so prefix it:

```sh
cd ~/Documents/Projects/Browser/mozilla-central
PATH=$HOME/.local/bin:$PATH MOZCONFIG=$PWD/../browser/mozconfigs/dev-bootstrap ./mach build         # full or C++ changes
PATH=$HOME/.local/bin:$PATH MOZCONFIG=$PWD/../browser/mozconfigs/dev-bootstrap ./mach build faster  # JS/CSS/FTL/jar.mn changes
./obj-browser-wip/dist/bin/browser-wip
```

- A clean build takes about 13 minutes; an incremental C++ build takes seconds to minutes.
- Files in `dist/bin` are symlinks to the sources. Edits to existing JS, CSS and FTL apply after a browser restart, with no rebuild. A **new** file needs `build faster`, plus its line in `jar.mn` or `moz.build`.
- C++ changes (`app/components/**/*.cpp`) and `moz.configure` changes need a full `./mach build`.
- Restarting means quitting the browser fully. The maintainer may be running it, so tell them to restart rather than killing their instance.
- The profile in daily use is `~/.browser-wip/m6apb42s.default-default`. Don't touch it; tests use fresh temporary profiles.
- To add the build to the desktop's app launcher: `tools/install-launcher.sh ../mozilla-central/obj-browser-wip/dist/bin`. Run it again after icon changes. It copies hicolor's `index.theme` (hyprlauncher skips icon folders without one) and refreshes the icon cache. A running hyprlauncher must be restarted (`pkill -x hyprlauncher`).

## Testing

Run the checks relevant to a change before reporting it done, and say what ran and what didn't.

```sh
# Unit tests (no Gecko); needs node from ~/.mozbuild
PATH=$HOME/.mozbuild/node/bin:$PATH tests/unit/run.sh

# Runtime checks: headless browser, fresh profile, Marionette. Run from mozilla-central.
PATH=$HOME/.local/bin:$PATH python3 -I ../browser/tools/runtime/check.py obj-browser-wip/dist/bin --part 4
PATH=$HOME/.local/bin:$PATH python3 -I ../browser/tools/runtime/check.py obj-browser-wip/dist/bin     # all parts, slow

# No background network traffic (strace + network logging)
tools/netsilence/run.sh ../mozilla-central/obj-browser-wip/dist/bin
```

Runtime check parts (`ALL_PARTS` in `check.py`; add a new part there and in `.github/workflows/release.yml`):

| Part | Area |
|---|---|
| 1 | mozilla-central untouched, build identity, default prefs |
| 2 | Standard privacy prefs, network blocker end to end, the shield count, privacy modes live |
| 3 | First run and privacy-mode toggles |
| 4 | Browser window: address bar, tabs, split view, tab overview, context menu, toolbar buttons |
| 5 | Session restore |
| 6 | Password manager stubs, console errors |
| 7 | Blocker cases (`tests/blocker/*.json`), blocked page |
| 8 | Passwords (HTTPS test server, subdomains, frames) |
| 9 | Library: history, bookmarks, search engines |
| 10 | YouTube ad blocker |
| 11 | System keyring (Linux) |
| 12 | Site icons and the new tab page |
| 13 | Cache |
| 14 | Printing and Save to PDF |
| 15 | Dev-build check |
| 16 | Clear site data |
| 17 | DRM (Widevine, with a local stand-in for Google's download) |

How to write checks:
- Test pages live in `tests/runtime/pages/`, served on 127.0.0.1. Use `Browser(bindir, prefs=…)`, `b.js(…)`, `b.wait(…)`, `record(part, name, ok, detail)`.
- When fixing a bug, add a check, and verify it **fails without the fix** (temporarily revert, run, restore). Then report it.
- Headless can't do some things (real fullscreen, the true look of print previews). Use `skip`/`expected_headless_failure` and list them in `docs/MANUAL-CHECKS.md`. The embedded-player fullscreen check in part 4 is a known headless skip.
- Prefs that exist only for tests (for example `browserwip.devBuilds.testApi`, `browserwip.drm.testSources`) must be honoured only under automation: `BWV_AUTOMATION=1` **and** Marionette running.
- Put temporary scripts and screenshots in the session scratchpad, not in the repo or `/tmp`.

## Code conventions

- Match the surrounding code: comment density, naming, idiom. Comments explain *why* and what a reader can't see, in plain sentences. Every file starts with the MPL-2.0 header.
- Codename spellings: `browser-wip` (paths, chrome package, binary), `browserwip` (pref branch `browserwip.*`, identifiers), `BrowserWip` (classes). New prefs go under `browserwip.`.
- The chrome window's CSP forbids inline event handlers. Wire handlers in JS (`BrowserWip.COMMANDS` in `browser.js` for `<command>`s and toolbar buttons with `data-command`).
- Toolbar buttons act on the left button only (`e.button == 0`). A chrome document also gets `click` for the middle button. Middle-click and Ctrl+click on Back/Forward/Reload go through `BrowserWip.IN_NEW_TAB`.
- All UI text goes through Fluent (`data-l10n-id`, `document.l10n.setAttributes`) with strings in `app/locales/en-US/browser-wip/`. No hard-coded English in markup or JS.
- The browser window is an HTML document with some XUL elements; XUL `flex` isn't mapped there, so size with CSS.
- Colors are CSS tokens; light and dark themes both have to work.
- **Gecko gotchas:**
  - `element.ownerGlobal` does not exist in this Gecko (it was renamed `documentGlobal`). Use `element.ownerDocument.defaultView`.
  - Gecko only fires `onContentBlockingEvent` when a page's blocking state changes, not for every block. The shield recounts on `browserwip:request-blocked`, which `NetworkBlocker.cpp` sends for each blocked request.
  - Content processes are sandboxed. Data they need is published from the parent through `Services.ppmm.sharedData`.
- New JSWindowActors are registered in `JSWINDOWACTORS` in `BrowserWipGlue.sys.mjs`; new modules go in the directory's `moz.build` (`EXTRA_JS_MODULES.browserwip`) and new directories in `app/components/moz.build`.
- Privacy modes: a toggle that affects prefs is defined in `PrivacyModes.sys.mjs`, shown through `privacy-controls.js`, and listed in Settings and `welcome.js`. A toggle added after release goes in `ADDED_TOGGLES` so existing profiles get its default once. Update `tests/unit/privacy-modes.test.mjs`.
- **Privacy rules:**
  - No background network calls unless the user turned the feature on (netsilence enforces this).
  - Requests the browser makes for itself are anonymous: `credentials: "omit"`, no referrer, nothing about the user.
  - No telemetry.
  - Never send the maintainer's email or other personal data to any service.
- When behaviour changes, update the matching doc (`docs/PLAN.md` section, `CONTENT-BLOCKING.md`, `MANUAL-CHECKS.md`, `README.md`).

## Hard rules

- **Never modify mozilla-central.** Everything lives in `app/`. If something seems to need a Gecko change, find another way or ask.
- **Never run anything on GitHub Actions.** Credits are limited. Workflow push triggers are restricted to branches, and every commit message carries `[skip ci]`.
- **Commit and push only when asked.** Work is on `main`. Commit as `c1ht <notanderx@gmail.com>` through environment variables (no git identity is configured):
  ```sh
  GIT_AUTHOR_NAME=c1ht GIT_AUTHOR_EMAIL=notanderx@gmail.com \
  GIT_COMMITTER_NAME=c1ht GIT_COMMITTER_EMAIL=notanderx@gmail.com \
  git commit -m "Summary [skip ci]"
  ```
  Don't commit files you didn't create without asking (for example large reference files under `docs/design/`).
- **After every push, publish a dev build:** `tools/release/dev-release.sh`.
  - It builds with `mozconfigs/ci-linux` in `obj-release`.
  - It packages `.tar.zst`, `.tar.xz`, `.deb`, `.rpm`, `.AppImage` and an AUR `PKGBUILD`, with `SHA256SUMS`.
  - It scans the unpacked packages for keys, tokens and profile files (`scan_secrets.py`), and checks the checksums again after upload.
  - It publishes a GitHub **pre-release** `dev-<date>-<sha>` that is never marked stable or latest.
  - It needs a clean tree and a pushed HEAD. `--dry-run` does everything but publish. Its packaging tools come from `tools/release/fetch-release-deps.sh` (no root).
- Ask before destructive or outward-facing actions beyond those above.
