#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Network-silence test: start the browser with a fresh profile, leave it idle,
# and fail if it resolves any host name or opens any connection outside this
# machine. This is the definition of "no background network calls".
#
#   tools/netsilence/run.sh <dist/bin directory> [seconds]
#
# Two independent observers:
#   - Gecko's own logging (nsHostResolver, nsSocketTransport) names every host
#     the networking stack looks up or connects to.
#   - strace records connect() and sendto() from every process, which also
#     catches traffic that bypasses Necko.
set -euo pipefail

bindir="$(cd "${1:?usage: run.sh <dist/bin> [seconds]}" && pwd)"
seconds="${2:-90}"
app="$bindir/browser-wip"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir "$work/profile"

# Outbound attempts must fail fast instead of reaching a proxy, and the
# profile must not inherit anything from the environment.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy

echo "netsilence: running $app for ${seconds}s"
MOZ_LOG="timestamp,sync,nsHostResolver:5,nsSocketTransport:5" \
MOZ_LOG_FILE="$work/gecko.log" \
timeout --signal=TERM --kill-after=15 "$seconds" \
  strace -f -qq -e trace=connect,sendto -e signal=none -o "$work/strace.log" \
  "$app" --headless --no-remote --profile "$work/profile" \
  > "$work/stdout.log" 2>&1 || true

python3 -I "$(dirname "$0")/check.py" "$work"
