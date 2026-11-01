#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Fetches what the runtime checks (check.py) need beyond a desktop's usual
# tools, without root, into a cache check.py looks in:
#
#   ${BWV_TEST_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-wip/test-deps}
#       root/usr/bin/strace                 part 2, the network-silence check
#       root/usr/bin/gnome-keyring-daemon   part 11, the system keyring
#       root/usr/lib/...                    their libraries
#
# On Arch Linux it downloads the versions pacman's sync database names, from
# the first mirror in pacman's mirror list (or the Arch Linux Archive when
# the mirror has moved on), checks each against pacman's own
# keyring (/etc/pacman.d/gnupg) and unpacks them into the cache. Elsewhere,
# install the same tools with the system's package manager (Debian and
# Ubuntu: apt install strace gnome-keyring libsecret-tools dbus); check.py
# finds them on PATH.
#
#   tools/runtime/fetch-test-deps.sh          fetch what's missing
#   tools/runtime/fetch-test-deps.sh --force  fetch again
set -euo pipefail

cache="${BWV_TEST_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-wip/test-deps}"
packages=(strace gnome-keyring gcr gcr-4)
force="${1:-}"

if [[ -x "$cache/root/usr/bin/strace" && -x "$cache/root/usr/bin/gnome-keyring-daemon" && "$force" != "--force" ]]; then
  echo "fetch-test-deps: already in $cache ($(cat "$cache/versions" 2>/dev/null | tr '\n' ' '))"
  exit 0
fi

if ! command -v pacman > /dev/null; then
  missing=()
  for tool in strace gnome-keyring-daemon secret-tool dbus-daemon; do
    command -v "$tool" > /dev/null || missing+=("$tool")
  done
  if ((${#missing[@]})); then
    echo "fetch-test-deps: not Arch Linux; install these with your package manager: ${missing[*]}" >&2
    exit 1
  fi
  echo "fetch-test-deps: not Arch Linux, and everything is on PATH already"
  exit 0
fi

mirror="$(sed -n '/^[[:space:]]*Server[[:space:]]*=/{s/^[^=]*=[[:space:]]*//p;q}' /etc/pacman.d/mirrorlist)"
mirror="${mirror:-https://fastly.mirror.pkgbuild.com/\$repo/os/\$arch}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/root"
: > "$work/versions"

for name in "${packages[@]}"; do
  read -r repo version arch < <(pacman -Si "$name" | awk -F': ' '
    /^Repository/ { r = $2 } /^Version/ { v = $2 } /^Architecture/ { a = $2 } END { print r, v, a }')
  base="${mirror//\$repo/$repo}"
  base="${base//\$arch/$(uname -m)}"
  file="$name-${version//:/%3A}-$arch.pkg.tar.zst"
  # A sync database older than the mirror names a version the mirror has
  # dropped; the Arch Linux Archive keeps every version, with signatures.
  archive="https://archive.archlinux.org/packages/${name:0:1}/$name"
  if ! curl -sSfL -o "$work/$name.pkg" "$base/$file" 2> /dev/null; then
    base="$archive"
    curl -sSfL -o "$work/$name.pkg" "$base/$file"
  fi
  curl -sSfL -o "$work/$name.pkg.sig" "$base/$file.sig"
  if ! gpg --homedir /etc/pacman.d/gnupg --no-auto-check-trustdb --status-fd 1 \
      --verify "$work/$name.pkg.sig" "$work/$name.pkg" 2> /dev/null | grep -q '^\[GNUPG:\] VALIDSIG'; then
    echo "fetch-test-deps: $name $version: the signature doesn't verify against pacman's keyring" >&2
    exit 1
  fi
  tar -C "$work/root" -xf "$work/$name.pkg" usr 2> /dev/null
  echo "$name $version" >> "$work/versions"
  echo "fetch-test-deps: $name $version (signature good)"
done

for binary in strace gnome-keyring-daemon; do
  if LD_LIBRARY_PATH="$work/root/usr/lib" ldd "$work/root/usr/bin/$binary" | grep -q "not found"; then
    echo "fetch-test-deps: $binary needs libraries this system lacks:" >&2
    LD_LIBRARY_PATH="$work/root/usr/lib" ldd "$work/root/usr/bin/$binary" | grep "not found" >&2
    exit 1
  fi
done

mkdir -p "$cache"
rm -rf "$cache/root"
mv "$work/root" "$cache/root"
mv "$work/versions" "$cache/versions"
echo "fetch-test-deps: done, in $cache"
