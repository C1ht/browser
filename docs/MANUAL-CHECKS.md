# Manual checks

`tools/runtime/check.py` runs the browser headless. A few things need a real window, and those checks are reported as **skipped (headless)**, not as passed. Do them by hand in a normal (headed) run before a release:

| Check | Steps | Expected |
|---|---|---|
| An embedded player goes fullscreen (part 4) | Open a page that embeds a video from another site, for example a YouTube embed on any blog. Click the player's fullscreen button. | The video fills the screen. The address bar and tabs are hidden. The fullscreen notice names the page's site. Esc brings the bars back. |
| The print preview fills its area (part 14) | Open a long page, press Ctrl+P. Resize the window. | The preview's pages are centered on a gray area that fills the left of the dialog, and stay so after resizing. Headless screenshots show them at two thirds of the area (the preview is drawn at the printer's 144 dpi). |
| A passkey kept by the browser (part 22) | On github.com → Settings → Password and authentication → Add a passkey, choose "Save in browser-wip". Sign out, then sign in with "Sign in with a passkey", or pick the passkey in the username field's dropdown. Try passkeys.io and webauthn.io as well. | The site accepts the passkey at both steps. about:passwords lists it under Passkeys. Choosing "Use a security key" instead goes to the key's prompts. |
| A passkey on a security key (part 21) | Plug in a security key (a YubiKey, say). On github.com → Settings → Password and authentication → Add a passkey. Then sign out and sign in with the passkey. | The site-information button shows the prompts: the key's PIN if it has one, then "Touch your security key". The passkey is added, and signing in with it works. Cancel at any prompt stops it, and the site says so. |
| Authenticator codes on a real site (part 20) | Turn on two-step verification on a site you use (for example GitHub → Settings → Password and authentication). When it shows the QR code, right-click it and choose "Add authenticator from QR code", pick your login, and enter the code the panel shows. Sign out and in again. | The site accepts the code. When it asks for a code on sign-in, clicking the field offers the current code and fills it. |
| Screenshot to the clipboard (part 19) | Press Ctrl+Shift+S on any page, drag over part of it and click Copy. Paste into an image editor or a chat. | The pasted image is the area you selected, sharp at your screen's scale. |
| Page translation panel (part 18) | Open a page in another language, for example fr.wikipedia.org. Click the translate button in the address bar. | The panel shows From and To, with the page's language and yours, and how much downloads first. While translating, it shows the download's progress, then closes, and the button shows the new language (for example EN). Show original brings the page back. Headless screenshots don't show panels. |
| DRM playback (part 17) | In Standard, open a DRM-protected video, for example the Widevine demos at bitmovin.com/demos/drm or a Netflix or Spotify page you use. | The first time, a notice says Widevine is being installed, then the video plays. Later visits play straight away. In Strict Privacy, the page is refused and the notice offers Turn on DRM. |
| Split view with a real pointer (part 4 simulates the drag events) | Drag a tab slowly over the middle of another tab, then let go. Click into the page that isn't selected. Drag the bar between the pages. | While the tab is over the middle, that tab shows both tabs side by side. Letting go splits the window. Clicking into the other page moves the address bar to it. The bar resizes the pages. |

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
