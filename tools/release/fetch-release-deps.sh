#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Fetches the packaging tools dev-release.sh needs, without root, into
#
#   ${BWV_RELEASE_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-wip/release-deps}
#       root/usr/bin/rpmbuild      the .rpm
#       root/usr/bin/dpkg-deb      the .deb
#       root/usr/bin/mksquashfs    the AppImage's file system
#       root/usr/lib/...           their libraries
#       appimage-runtime-x86_64    the AppImage's runtime (the part that runs)
#
# Arch Linux packages come from pacman's mirror (or the Arch Linux Archive)
# and are checked against pacman's keyring, as fetch-test-deps.sh does.
# rpm-tools' rpm-sequoia is still linked against nettle 3, so nettle comes
# from the Archive at a fixed version. The AppImage runtime is a fixed
# release of AppImage's type2-runtime, checked against its signing key and
# a pinned SHA-256.
#
#   tools/release/fetch-release-deps.sh          fetch what's missing
#   tools/release/fetch-release-deps.sh --force  fetch again
set -euo pipefail

cache="${BWV_RELEASE_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-wip/release-deps}"
# name, or name=version for a fixed version from the Archive.
packages=(rpm-tools rpm-sequoia squashfs-tools dpkg nettle=3.10.2-1)
runtime_release=20251108
runtime_sha256=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
runtime_key=570C77ACEA40C0F1B758902CBF96CCA56490F695
force="${1:-}"

ready() {
  [[ -x "$cache/root/usr/bin/rpmbuild" && -x "$cache/root/usr/bin/dpkg-deb" && -x "$cache/root/usr/bin/mksquashfs" \
    && -f "$cache/appimage-runtime-x86_64" ]]
}

if ready && [[ "$force" != "--force" ]]; then
  echo "fetch-release-deps: already in $cache ($(tr '\n' ' ' < "$cache/versions"))"
  exit 0
fi
if ! command -v pacman > /dev/null; then
  echo "fetch-release-deps: needs Arch Linux (pacman); elsewhere, install rpm (rpmbuild), dpkg (dpkg-deb)" \
    "and squashfs-tools, and put AppImage's type2-runtime $runtime_release at $cache/appimage-runtime-x86_64" >&2
  exit 1
fi

mirror="$(sed -n '/^[[:space:]]*Server[[:space:]]*=/{s/^[^=]*=[[:space:]]*//p;q}' /etc/pacman.d/mirrorlist)"
mirror="${mirror:-https://fastly.mirror.pkgbuild.com/\$repo/os/\$arch}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/root"
: > "$work/versions"

for entry in "${packages[@]}"; do
  name="${entry%%=*}"
  archive="https://archive.archlinux.org/packages/${name:0:1}/$name"
  if [[ "$entry" == *=* ]]; then
    version="${entry#*=}" arch=x86_64 base="$archive"
  else
    read -r repo version arch < <(pacman -Si "$name" | awk -F': ' '
      /^Repository/ { r = $2 } /^Version/ { v = $2 } /^Architecture/ { a = $2 } END { print r, v, a }')
    base="${mirror//\$repo/$repo}"
    base="${base//\$arch/$(uname -m)}"
  fi
  file="$name-${version//:/%3A}-$arch.pkg.tar.zst"
  # A sync database older than the mirror names a version the mirror has
  # dropped; the Archive keeps every version, with signatures.
  if ! curl -sSfL -o "$work/$name.pkg" "$base/$file" 2> /dev/null; then
    base="$archive"
    curl -sSfL -o "$work/$name.pkg" "$base/$file"
  fi
  curl -sSfL -o "$work/$name.pkg.sig" "$base/$file.sig"
  if ! gpg --homedir /etc/pacman.d/gnupg --no-auto-check-trustdb --status-fd 1 \
      --verify "$work/$name.pkg.sig" "$work/$name.pkg" 2> /dev/null | grep -q '^\[GNUPG:\] VALIDSIG'; then
    echo "fetch-release-deps: $name $version: the signature doesn't verify against pacman's keyring" >&2
    exit 1
  fi
  tar -C "$work/root" -xf "$work/$name.pkg" usr 2> /dev/null
  echo "$name $version" >> "$work/versions"
  echo "fetch-release-deps: $name $version (signature good)"
done

url="https://github.com/AppImage/type2-runtime/releases/download/$runtime_release"
curl -sSfL -o "$work/runtime" "$url/runtime-x86_64"
curl -sSfL -o "$work/runtime.sig" "$url/runtime-x86_64.sig"
curl -sSfL -o "$work/runtime-key.asc" "$url/signing-pubkey.asc"
mkdir -m 700 "$work/gnupg"
gpg --homedir "$work/gnupg" --import "$work/runtime-key.asc" 2> /dev/null
if ! gpg --homedir "$work/gnupg" --status-fd 1 --verify "$work/runtime.sig" "$work/runtime" 2> /dev/null \
    | grep -q "^\[GNUPG:\] VALIDSIG $runtime_key "; then
  echo "fetch-release-deps: the AppImage runtime's signature doesn't verify against key $runtime_key" >&2
  exit 1
fi
if [[ "$(sha256sum < "$work/runtime" | cut -d' ' -f1)" != "$runtime_sha256" ]]; then
  echo "fetch-release-deps: the AppImage runtime isn't the pinned one (SHA-256 differs)" >&2
  exit 1
fi
echo "appimage-runtime $runtime_release" >> "$work/versions"
echo "fetch-release-deps: AppImage runtime $runtime_release (signature and SHA-256 good)"

for binary in rpmbuild dpkg-deb mksquashfs; do
  if LD_LIBRARY_PATH="$work/root/usr/lib" ldd "$work/root/usr/bin/$binary" | grep -q "not found"; then
    echo "fetch-release-deps: $binary needs libraries this system lacks:" >&2
    LD_LIBRARY_PATH="$work/root/usr/lib" ldd "$work/root/usr/bin/$binary" | grep "not found" >&2
    exit 1
  fi
done

mkdir -p "$cache"
rm -rf "$cache/root"
mv "$work/root" "$cache/root"
mv "$work/runtime" "$cache/appimage-runtime-x86_64"
mv "$work/versions" "$cache/versions"
echo "fetch-release-deps: done, in $cache"
