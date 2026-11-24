#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Build the per-user Windows installer from a packaged build:
#
#   tools/installer/build.sh <stage> <output.exe>
#
# <stage> is the browser-wip directory of `mach package`'s zip, unpacked
# (obj-*/dist/browser-wip after packaging, or a copy with dev-build.json
# added for a dev build). Uses the NSIS that `mach bootstrap` installs into
# ~/.mozbuild/nsis; MAKENSIS overrides it.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
stage="$1"
out="$2"
[[ -f "$stage/browser-wip.exe" ]] || { echo "no $stage/browser-wip.exe; run ./mach package first" >&2; exit 1; }
version="$(sed -n 's/^Version=//p' "$stage/application.ini" | tr -d '\r')"
makensis="${MAKENSIS:-$HOME/.mozbuild/nsis/makensis.exe}"

winpath() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
mkdir -p "$(dirname "$out")"
"$makensis" -V2 \
  "-DSTAGE=$(winpath "$(cd "$stage" && pwd)")" \
  "-DVERSION=$version" \
  "-DOUTFILE=$(winpath "$(cd "$(dirname "$out")" && pwd)/$(basename "$out")")" \
  "-DICON=$(winpath "$root/app/branding/wip/browser-wip.ico")" \
  "$(winpath "$root/tools/installer/browser-wip.nsi")"
echo "Built $out (browser-wip $version)"
