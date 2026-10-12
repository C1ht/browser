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
| `app/policies/` | Bundled enterprise policy that disables Remote Settings |
| `app/themes/shared/` | Folio styles, icons, Instrument Sans |
| `GECKO_REVISION` | The Firefox ESR this tracks (the same as Mullvad Browser and Tor Browser) |
| `tools/` | Gecko checkout, toolchain setup, rename, network-silence test, screenshots |
| `tests/unit/` | Tests that run in Node without a Gecko build |

## Build (Linux)

```sh
tools/fetch-gecko.sh                 # pinned Firefox ESR in ../mozilla-central
sudo tools/setup-system-toolchain.sh # or: (cd ../mozilla-central && ./mach bootstrap)
cd ../mozilla-central
MOZCONFIG=$PWD/../browser/mozconfigs/dev ./mach build
./obj-browser-wip/dist/bin/browser-wip
```

`mozconfigs/dev` targets a 4-core machine with about 13 GB of usable memory:
no debug symbols, 3 parallel jobs. After the first build, front-end changes
need only `./mach build faster`.

## Checks

```sh
tests/unit/run.sh                                        # no Gecko needed
tools/netsilence/run.sh ../mozilla-central/obj-browser-wip/dist/bin   # no background network calls
tools/wayland-shot.sh <dist/bin> /tmp/p shot.png         # screenshot on headless Weston
```

## Licenses

Code: MPL-2.0. Instrument Sans: SIL Open Font License 1.1
(`app/themes/shared/fonts/OFL.txt`). Filter lists: EasyList authors,
CC BY-SA 3.0, credited in Settings.
