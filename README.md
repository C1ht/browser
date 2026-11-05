# browser-wip

A standalone Gecko browser: its own front end on top of Gecko and toolkit,
with no changes to mozilla-central. `browser-wip` is a codename;
`tools/rename.sh` replaces it everywhere.

- Plan, decisions and rationale: [`docs/PLAN.md`](docs/PLAN.md)
- Design mockups: [`design/mockups/chrome-directions.html`](design/mockups/chrome-directions.html)

## Layout

| Path | What it is |
|---|---|
| `app/` | The `--enable-project` directory, mounted into the Gecko tree as `browser-wip/` |
| `app/moz.configure` | Product identity, and features switched off at build time (telemetry, crash reporter, updater, EME, …) |
| `app/profile/browser-wip.js` | Default prefs. These are the Standard privacy mode. |
| `app/launcher/` | The `browser-wip` executable |
| `app/base/content/` | Browser window, tab strip, address bar, about: pages |
| `app/components/` | Startup, privacy modes, content blocking, about: page module |
| `app/components/contentblocking/lists/` | Vendored filter lists (`tools/update-blocklists.py` refreshes them) |
| `app/components/contentblocking/youtube/` | Opt-in YouTube ad blocker: uBlock Origin's YouTube rules, downloaded only while it is on |
| `app/policies/` | Bundled enterprise policy that disables Remote Settings |
| `app/themes/shared/` | Folio styles, icons, Instrument Sans |
| `GECKO_REVISION` | The Firefox release this tracks |
| `tools/` | Gecko checkout, toolchain setup, rename, network-silence test, screenshots |
| `tests/unit/` | Tests that run in Node without a Gecko build |

## Build (Linux)

```sh
tools/fetch-gecko.sh                 # pinned Firefox release in ../mozilla-central
sudo tools/setup-system-toolchain.sh # or: (cd ../mozilla-central && ./mach bootstrap)
cd ../mozilla-central
MOZCONFIG=$PWD/../browser/mozconfigs/dev ./mach build
./obj-browser-wip/dist/bin/browser-wip
```

On other distributions, or without root, use `mozconfigs/dev-bootstrap`
instead: it fetches Mozilla's toolchains into `~/.mozbuild` and needs only
the GTK/X11/Wayland development libraries, plus `unzip` and `zip`.

To start it from the desktop's app launcher, run
`tools/install-launcher.sh ../mozilla-central/obj-browser-wip/dist/bin`
once. Run it again after the icons change.

`mozconfigs/dev` targets a 4-core machine with about 13 GB of usable memory:
no debug symbols, 3 parallel jobs. After the first build, front-end changes
need only `./mach build faster`.

## Checks

```sh
tests/unit/run.sh                                        # no Gecko needed
tools/runtime/fetch-test-deps.sh                         # once: strace and gnome-keyring, into ~/.cache
tools/runtime/check.py ../mozilla-central/obj-browser-wip/dist/bin    # runtime checks, all parts
tools/netsilence/run.sh ../mozilla-central/obj-browser-wip/dist/bin   # no background network calls
tools/wayland-shot.sh <dist/bin> /tmp/p shot.png         # screenshot on headless Weston
```

What the runtime checks need and what they can't check headless (to do by hand): [docs/MANUAL-CHECKS.md](docs/MANUAL-CHECKS.md).

## Dev builds

Every pushed commit can be published as an unstable dev build, a GitHub
pre-release, built and packaged on this machine (not on GitHub Actions):

```sh
tools/release/dev-release.sh --dry-run   # build, package and check; publish nothing
tools/release/dev-release.sh             # the same, then publish the pushed HEAD
```

It makes `.tar.zst`, `.tar.xz`, `.deb`, `.rpm`, `.AppImage` and an AUR
`PKGBUILD` (template: `packaging/aur/PKGBUILD.in`), with `SHA256SUMS`. Before
publishing it unpacks each package again and checks it: no private keys,
tokens or profile files, the PKGBUILD builds with makepkg, and the checksums
match, both locally and as GitHub serves the files. Its packaging tools come
from `tools/release/fetch-release-deps.sh` (no root). The build uses
`mozconfigs/ci-linux`, in `../mozilla-central/obj-release`.

Each package carries `dev-build.json` (tag, commit, date), which the
browser's opt-in "Check for new dev builds" (Settings → About) compares with
the newest release on GitHub.

## Licenses

Code: MPL-2.0. Instrument Sans: SIL Open Font License 1.1
(`app/themes/shared/fonts/OFL.txt`). Filter lists: EasyList authors,
CC BY-SA 3.0, credited in Settings.
