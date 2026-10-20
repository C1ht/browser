#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Run tools/runtime/check.py against a Windows build on the Windows test VM,
# over SSH (forgejo-runner has no Windows build; docs/FORGEJO.md).
#
#   tools/ci/windows-smoke.sh USER@HOST browser-wip-...-windows-x86_64.zip "1 2 3 4 7"
#
# The runner's user needs key-based SSH access to the VM. The exit status is
# check.py's.
set -euo pipefail

host="${1:?host}"
zip="${2:?zip}"
parts="${3:-1 2 3 4}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
run="C:/ci/run-$(date +%Y%m%d-%H%M%S)-$$"
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=accept-new)

# What check.py needs from the repository, plus the build.
bundle="$(mktemp -d)/bundle.tar"
tar -C "$root" -cf "$bundle" GECKO_REVISION tools/runtime tools/ci tests
ssh "${ssh_opts[@]}" "$host" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '$run' | Out-Null\""
scp "${ssh_opts[@]}" -q "$bundle" "$zip" "$host:$run/"
rm -rf "$(dirname "$bundle")"

ssh "${ssh_opts[@]}" "$host" \
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"tar -xf '$run/bundle.tar' -C '$run'; & '$run/tools/ci/windows-smoke.ps1' -Run '$run' -Zip '$(basename "$zip")' -Parts '$parts'; exit \$LASTEXITCODE\""
