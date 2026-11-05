#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Adds a local build to the desktop's app launcher, for this user only: the
# desktop entry (app/branding/wip/linux/browser-wip.desktop, run from the
# given build) and the icons, in ~/.local/share. Run it again after the
# icons change; it replaces what it installed and refreshes the icon cache,
# which launchers otherwise keep showing the old icons from.
#
#   tools/install-launcher.sh ../mozilla-central/obj-browser-wip/dist/bin
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
bindir="$(cd "${1:?usage: $0 <dist/bin of a build>}" && pwd)"
[[ -x "$bindir/browser-wip" ]] || { echo "install-launcher: no browser-wip in $bindir" >&2; exit 1; }
data="${XDG_DATA_HOME:-$HOME/.local/share}"
branding="$repo/app/branding/wip"
icons="$data/icons/hicolor"

for size in 16 22 24 32 48 64 128 256; do
  install -Dm644 "$branding/default$size.png" "$icons/${size}x$size/apps/browser-wip.png"
done
install -Dm644 "$branding/icon.svg" "$icons/scalable/apps/browser-wip.svg"

# The packaged entry, run from this build instead of from PATH.
mkdir -p "$data/applications"
sed "s|^Exec=browser-wip|Exec=$bindir/browser-wip|" "$branding/linux/browser-wip.desktop" \
  > "$data/applications/browser-wip.desktop"

# Some launchers (hyprlauncher: hyprtoolkit's icon lookup) skip an icon
# theme folder without its index.theme, and with it every icon in it. The
# folder here only adds icons to the system's hicolor theme, so it gets the
# system's index.
if [[ ! -f "$icons/index.theme" && -f /usr/share/icons/hicolor/index.theme ]]; then
  cp /usr/share/icons/hicolor/index.theme "$icons/index.theme"
fi
# A stale cache makes GTK, and launchers that use it, keep the old icons.
if command -v gtk-update-icon-cache > /dev/null && [[ -f "$icons/index.theme" ]]; then
  gtk-update-icon-cache -q -f -t "$icons" || rm -f "$icons/icon-theme.cache"
else
  rm -f "$icons/icon-theme.cache"
fi
command -v update-desktop-database > /dev/null && update-desktop-database -q "$data/applications" || true
touch "$icons"
echo "install-launcher: browser-wip from $bindir, with its icons, in $data"
# A launcher running in the background reads icons once, when it starts.
if pgrep -x hyprlauncher > /dev/null; then
  echo "install-launcher: hyprlauncher is running and keeps the icons it read at startup; restart it" \
    "(pkill -x hyprlauncher, then open it again)"
fi
