# Manual checks

`tools/runtime/check.py` runs the browser headless. A few things need a real window, and those checks are reported as **skipped (headless)**, not as passed. Do them by hand in a normal (headed) run before a release:

| Check | Steps | Expected |
|---|---|---|
| An embedded player goes fullscreen (part 4) | Open a page that embeds a video from another site, for example a YouTube embed on any blog. Click the player's fullscreen button. | The video fills the screen. The address bar and tabs are hidden. The fullscreen notice names the page's site. Esc brings the bars back. |

Headless Gecko has no real window to make fullscreen, and it doesn't grant a fullscreen request that comes from a frame in another process. A page's own fullscreen button works headless and stays an automatic check.

## Running the automatic checks

```sh
tools/runtime/fetch-test-deps.sh     # once: strace (part 2) and gnome-keyring (part 11)
tools/runtime/check.py ../mozilla-central/obj-browser-wip/dist/bin
```

**Test dependencies.** `fetch-test-deps.sh` puts its tools in `${BWV_TEST_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-wip/test-deps}`.

- On Arch Linux it downloads the packages from pacman's mirror (or the Arch Linux Archive), checks them against pacman's keyring, and unpacks them. It needs no root.
- On other distributions, install `strace`, `gnome-keyring`, `libsecret-tools` (for `secret-tool`) and `dbus` with the package manager.

**What `check.py` does with them.**

- It puts that cache first on its own PATH.
- Before running anything, it checks that the chosen parts' tools are there. If any is missing, it stops and names the tool.
- It ends with a summary that gives every part's ok, failed and skipped counts, or "not run" for a part that wasn't chosen.
