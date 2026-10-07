#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Run the browser on a headless Weston (native Wayland, software rendering),
# wait, and save a screenshot. For checking the UI on machines without a
# display.
#
#   tools/wayland-shot.sh <dist/bin> <profile-dir> <out.png> [seconds] [-- browser args...]
#
# Environment: PREFS="name=value ..." are written to the profile's user.js
# before starting (strings must be quoted, e.g. PREFS='browserwip.appearance="dark"').
set -euo pipefail

bindir="$(cd "$1" && pwd)"; profile="$2"; out="$3"; seconds="${4:-12}"
shift 4 || shift $#
[[ "${1:-}" == "--" ]] && shift

runtime="$(mktemp -d)"
chmod 700 "$runtime"
export XDG_RUNTIME_DIR="$runtime"
cleanup() {
  [[ -n "${app_pid:-}" ]] && kill "$app_pid" 2>/dev/null || true
  [[ -n "${weston_pid:-}" ]] && kill "$weston_pid" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$runtime"
}
trap cleanup EXIT

weston --backend=headless --renderer=pixman --socket=wl-shot \
  --width=1280 --height=820 --debug > "$runtime/weston.log" 2>&1 &
weston_pid=$!
until [[ -S "$runtime/wl-shot" ]]; do sleep 0.2; done

mkdir -p "$profile"
for pref in ${PREFS:-}; do
  echo "user_pref(\"${pref%%=*}\", ${pref#*=});" >> "$profile/user.js"
done

WAYLAND_DISPLAY=wl-shot GDK_BACKEND=wayland MOZ_ENABLE_WAYLAND=1 \
  "$bindir/browser-wip" --no-remote --profile "$profile" "$@" \
  > "$runtime/browser.log" 2>&1 &
app_pid=$!
sleep "$seconds"

if ! kill -0 "$app_pid" 2>/dev/null; then
  echo "browser exited early:" >&2
  tail -40 "$runtime/browser.log" >&2
  exit 1
fi
(cd "$runtime" && WAYLAND_DISPLAY=wl-shot weston-screenshooter > /dev/null 2>&1)
mv "$runtime"/wayland-screenshot-*.png "$out"
cp "$runtime/browser.log" "${out%.png}.log"
echo "saved $out (browser output: ${out%.png}.log)"
