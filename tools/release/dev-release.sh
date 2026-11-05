#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Builds browser-wip here, on this machine, packages it for Linux, and
# publishes the packages as a GitHub pre-release: a dev build of the pushed
# commit, never marked stable or latest. Nothing runs on GitHub Actions.
#
#   tools/release/dev-release.sh              build, package, check, publish
#   tools/release/dev-release.sh --dry-run    all but publishing; the working
#                                             tree may have changes
#   tools/release/dev-release.sh --no-build   package the last build as it is
#
# What it makes, for x86_64, named browser-wip-<tag>-linux-x86_64.*:
#   .tar.zst, .tar.xz   the app as `mach package` makes it: extract, run
#                       browser-wip/browser-wip
#   .deb                Debian, Ubuntu; installs to /opt/browser-wip
#   .rpm                Fedora, openSUSE; installs to /opt/browser-wip
#   .AppImage           any distribution: make it executable and run it
#   PKGBUILD, SRCINFO   Arch Linux (AUR browser-wip-bin, where SRCINFO is
#                       .SRCINFO), from the .tar.zst
#   SHA256SUMS          of all of the above
#
# Before publishing it checks:
#   - the build has no password-vault test hooks (release_binary_check.py);
#   - every package, unpacked again with its own format's tools, has no
#     private keys, tokens, profile files or this machine's GitHub token in
#     it (scan_secrets.py);
#   - the PKGBUILD builds a package with makepkg, from the .tar.zst and the
#     checksums it names;
#   - SHA256SUMS matches the files, and after uploading, the files as GitHub
#     serves them.
#
# The tag is dev-<commit date>-<short commit>, e.g. dev-20261105-1a2b3c4; a
# commit already published is skipped. Needs: gh (logged in), zstd, xz,
# makepkg, and the tools fetch-release-deps.sh fetches (it runs it).
set -euo pipefail

dry_run=0 build=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --no-build) build=0 ;;
    *) echo "usage: $0 [--dry-run] [--no-build]" >&2; exit 2 ;;
  esac
done

repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
gecko="${GECKO_DIR:-$repo/../mozilla-central}"
gecko="$(cd "$gecko" && pwd)"
export MOZCONFIG="$repo/mozconfigs/ci-linux"
objdir="$gecko/obj-release"
deps="${BWV_RELEASE_DEPS:-${XDG_CACHE_HOME:-$HOME/.cache}/browser-wip/release-deps}"
github=C1ht/browser
export PATH="$HOME/.local/bin:$PATH"
say() { echo "dev-release: $*"; }
die() { echo "dev-release: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Which commit

cd "$repo"
sha="$(git rev-parse HEAD)"
short="${sha:0:7}"
dirty="$(git status --porcelain)"
if ((dry_run)); then
  epoch="$(date +%s)"
  [[ -n "$dirty" ]] && short="$short-dirty"
else
  [[ -z "$dirty" ]] || die "the working tree has changes; commit them first (or use --dry-run)"
  git fetch -q origin
  [[ -n "$(git branch -r --contains HEAD)" ]] || die "HEAD ($short) isn't pushed to GitHub yet; push it first"
  epoch="$(git log -1 --format=%ct HEAD)"
fi
export SOURCE_DATE_EPOCH="$epoch"
tag="dev-$(date -u -d "@$epoch" +%Y%m%d)-$short"
stamp="$(date -u -d "@$epoch" +%Y%m%d%H%M)"
if ((!dry_run)) && gh release view "$tag" --repo "$github" > /dev/null 2>&1; then
  say "$tag is published already; nothing to do"
  exit 0
fi
say "building $tag"

"$repo/tools/release/fetch-release-deps.sh"
tools="$deps/root/usr/bin"
export LD_LIBRARY_PATH="$deps/root/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export RPM_CONFIGDIR="$deps/root/usr/lib/rpm"

# ---------------------------------------------------------------------------
# Build

if ((build)); then
  (cd "$gecko" && ./mach build)
fi
python3 -I "$repo/tools/vault/release_binary_check.py" "$objdir"
(cd "$gecko" && ./mach package)
package="$objdir/dist/$(cat "$objdir/dist/package_name.txt")"
appver="$(sed -n 's/^Version=//p' "$objdir/dist/bin/application.ini")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
out="$objdir/dev-release/$tag"
rm -rf "$out"
mkdir -p "$out" "$work/stage"
tar -C "$work/stage" -xf "$package"
[[ -x "$work/stage/browser-wip/browser-wip" ]] || die "$package has no browser-wip/browser-wip"
base="browser-wip-$tag-linux-x86_64"
# Debian and RPM sort ~ before anything, so a dev build sorts before the
# release of the same version.
version="${appver}~dev${stamp}.g${short//-/.}"
pkgver="${appver}.dev${stamp}.g${short//-/.}"

# Same bytes for the same commit: names sorted, owner root, times fixed.
tarball() { tar --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$epoch" -C "$1" -cf - "${@:2}"; }

# ---------------------------------------------------------------------------
# Dependencies: the system libraries the app links against, as each
# distribution names them.

mapfile -t sonames < <(
  cd "$work/stage/browser-wip"
  own="$(find . -name '*.so*' -printf '%f\n')"
  find . -type f \( -name '*.so*' -o -perm -u+x \) -print0 | xargs -0 readelf -d 2> /dev/null \
    | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | sort -u | grep -vxF -e "$own"
)
declare -A DEB=(
  [libc.so.6]=libc6 [ld-linux-x86-64.so.2]=libc6 [libdl.so.2]=libc6 [libm.so.6]=libc6 [libpthread.so.0]=libc6
  [libresolv.so.2]=libc6 [librt.so.1]=libc6 [libgcc_s.so.1]=libgcc-s1 [libstdc++.so.6]=libstdc++6
  [libX11.so.6]=libx11-6 [libX11-xcb.so.1]=libx11-xcb1 [libXcomposite.so.1]=libxcomposite1
  [libXcursor.so.1]=libxcursor1 [libXdamage.so.1]=libxdamage1 [libXext.so.6]=libxext6 [libXfixes.so.3]=libxfixes3
  [libXi.so.6]=libxi6 [libXrandr.so.2]=libxrandr2 [libXrender.so.1]=libxrender1 [libxcb.so.1]=libxcb1
  [libxcb-shm.so.0]=libxcb-shm0 [libasound.so.2]="libasound2t64 | libasound2"
  [libatk-1.0.so.0]="libatk1.0-0t64 | libatk1.0-0" [libcairo.so.2]=libcairo2
  [libcairo-gobject.so.2]=libcairo-gobject2 [libdbus-1.so.3]=libdbus-1-3 [libfontconfig.so.1]=libfontconfig1
  [libfreetype.so.6]=libfreetype6 [libgdk-3.so.0]="libgtk-3-0t64 | libgtk-3-0"
  [libgtk-3.so.0]="libgtk-3-0t64 | libgtk-3-0" [libgdk_pixbuf-2.0.so.0]=libgdk-pixbuf-2.0-0
  [libglib-2.0.so.0]="libglib2.0-0t64 | libglib2.0-0" [libgio-2.0.so.0]="libglib2.0-0t64 | libglib2.0-0"
  [libgobject-2.0.so.0]="libglib2.0-0t64 | libglib2.0-0" [libpango-1.0.so.0]=libpango-1.0-0
  [libpangocairo-1.0.so.0]=libpangocairo-1.0-0
)
deb_depends=() rpm_requires=() arch_depends=()
for soname in "${sonames[@]}"; do
  [[ -n "${DEB[$soname]:-}" ]] || die "no Debian package known for $soname; add it to DEB in $0"
  deb_depends+=("${DEB[$soname]}")
  rpm_requires+=("$soname()(64bit)")
  owner="$(pacman -Qqo "/usr/lib/$soname" 2> /dev/null)" || die "no Arch package owns /usr/lib/$soname"
  arch_depends+=("$owner")
done
mapfile -t deb_depends < <(printf '%s\n' "${deb_depends[@]}" | sort -u)
mapfile -t arch_depends < <(printf '%s\n' "${arch_depends[@]}" | sort -u | grep -vxE 'glibc|libgcc|libstdc\+\+|gcc-libs')
say "links against ${#sonames[@]} system libraries"

# ---------------------------------------------------------------------------
# Archives

tarball "$work/stage" browser-wip | zstd -q -19 -T0 > "$out/$base.tar.zst"
tarball "$work/stage" browser-wip | xz -9 -T0 > "$out/$base.tar.xz"

# The installed layout the .deb and .rpm share.
root="$work/root"
branding="$repo/app/branding/wip"
mkdir -p "$root/opt" "$root/usr/bin"
cp -a "$work/stage/browser-wip" "$root/opt/browser-wip"
printf '#!/bin/sh\nexec /opt/browser-wip/browser-wip "$@"\n' > "$root/usr/bin/browser-wip"
chmod 755 "$root/usr/bin/browser-wip"
install -Dm644 "$branding/linux/browser-wip.desktop" "$root/usr/share/applications/browser-wip.desktop"
install -Dm644 "$branding/linux/browser-wip.metainfo.xml" "$root/usr/share/metainfo/browser-wip.metainfo.xml"
for size in 16 22 24 32 48 64 128 256; do
  install -Dm644 "$branding/default$size.png" "$root/usr/share/icons/hicolor/${size}x$size/apps/browser-wip.png"
done
install -Dm644 "$branding/icon.svg" "$root/usr/share/icons/hicolor/scalable/apps/browser-wip.svg"
install -Dm644 "$repo/LICENSE" "$root/usr/share/doc/browser-wip/LICENSE"
find "$root" -exec touch -h -d "@$epoch" {} +

summary="Web browser built on Gecko that blocks trackers and ads (unstable dev build)"
description="Unstable development build of commit $sha. Not a stable release."

# .deb
deb="$work/deb"
cp -a "$root" "$deb"
mkdir -p "$deb/DEBIAN"
cat > "$deb/DEBIAN/control" << EOF
Package: browser-wip
Version: $version
Architecture: amd64
Maintainer: c1ht <notanderx@gmail.com>
Installed-Size: $(du -sk --exclude=DEBIAN "$deb" | cut -f1)
Depends: $(IFS=,; echo "${deb_depends[*]}" | sed 's/,/, /g')
Recommends: libpulse0
Suggests: libavcodec-extra
Section: web
Priority: optional
Homepage: https://github.com/$github
Description: $summary
 $description
EOF
(cd "$deb" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' | sort -z | xargs -0 md5sum > DEBIAN/md5sums)
touch -d "@$epoch" "$deb/DEBIAN" "$deb/DEBIAN/"*
"$tools/dpkg-deb" --root-owner-group -Zxz --build "$deb" "$out/$base.deb" > /dev/null

# .rpm
rpmtop="$work/rpm"
mkdir -p "$rpmtop/SPECS"
cat > "$rpmtop/SPECS/browser-wip.spec" << EOF
Name: browser-wip
Version: $version
Release: 1
Summary: $summary
License: MPL-2.0 AND OFL-1.1 AND CC-BY-SA-3.0
URL: https://github.com/$github
BuildArch: x86_64
AutoReqProv: no
$(printf 'Requires: %s\n' "${rpm_requires[@]}")
Recommends: (pulseaudio-libs or libpulse0)

%description
$description

%install
mkdir -p %{buildroot}
cp -a "$root/." %{buildroot}/

%files
/opt/browser-wip
/usr/bin/browser-wip
/usr/share/applications/browser-wip.desktop
/usr/share/metainfo/browser-wip.metainfo.xml
/usr/share/icons/hicolor/*/apps/browser-wip.*
%license /usr/share/doc/browser-wip/LICENSE
EOF
"$tools/rpmbuild" -bb --quiet \
  --define "_topdir $rpmtop" --define "_dbpath $rpmtop/db" \
  --define "_buildhost localhost" --define "use_source_date_epoch_as_buildtime 1" \
  --define "build_mtime_policy clamp_to_source_date_epoch" --define "debug_package %{nil}" \
  --define "_build_id_links none" --define "__os_install_post %{nil}" \
  --define "_binary_payload w19T0.zstdio" \
  "$rpmtop/SPECS/browser-wip.spec"
mv "$rpmtop"/RPMS/x86_64/*.rpm "$out/$base.rpm"

# .AppImage: AppImage's runtime, then a squashfs of the app (its times from
# SOURCE_DATE_EPOCH).
appdir="$work/AppDir"
mkdir -p "$appdir"
cp -a "$work/stage/browser-wip" "$appdir/browser-wip"
printf '#!/bin/sh\nhere="$(dirname "$(readlink -f "$0")")"\nexec "$here/browser-wip/browser-wip" "$@"\n' > "$appdir/AppRun"
chmod 755 "$appdir/AppRun"
cp "$branding/linux/browser-wip.desktop" "$appdir/"
cp "$branding/default256.png" "$appdir/browser-wip.png"
ln -s browser-wip.png "$appdir/.DirIcon"
"$tools/mksquashfs" "$appdir" "$work/app.squashfs" -quiet -no-progress -root-owned -noappend -no-xattrs \
  -comp zstd -Xcompression-level 19 > /dev/null
cat "$deps/appimage-runtime-x86_64" "$work/app.squashfs" > "$out/$base.AppImage"
chmod 755 "$out/$base.AppImage"

# PKGBUILD, from the .tar.zst and the files it takes from the repository
# at this commit.
pkgdir="$work/pkgbuild"
mkdir -p "$pkgdir"
cp "$out/$base.tar.zst" "$pkgdir/"
cp "$branding/linux/browser-wip.desktop" "$branding/linux/browser-wip.metainfo.xml" "$pkgdir/"
cp "$branding/default256.png" "$pkgdir/browser-wip-256.png"
cp "$branding/icon.svg" "$pkgdir/browser-wip.svg"
sums="$(cd "$pkgdir" && for f in "$base.tar.zst" browser-wip.desktop browser-wip.metainfo.xml browser-wip-256.png browser-wip.svg; do
  printf "'%s'\n" "$(sha256sum "$f" | cut -d' ' -f1)"; done)"
sed -e "s|@PKGVER@|$pkgver|" -e "s|@TAG@|$tag|" -e "s|@COMMIT@|$sha|g" -e "s|@TARBALL@|$base.tar.zst|g" \
  -e "s|@DEPENDS@|$(printf "'%s' " "${arch_depends[@]}" | sed 's/ $//')|" \
  "$repo/packaging/aur/PKGBUILD.in" | awk -v sums="$sums" '
    /@SHA256SUMS@/ { n = split(sums, s, "\n"); line = "sha256sums=(" s[1];
      for (i = 2; i <= n; i++) line = line "\n            " s[i]; print line ")"; next } { print }' \
  > "$pkgdir/PKGBUILD"
# The template's own explanation (up to the first blank line) doesn't belong
# in the filled-in file.
sed -i '2,/^$/{/^$/!d}' "$pkgdir/PKGBUILD"
cp "$pkgdir/PKGBUILD" "$out/PKGBUILD"
# The AUR's .SRCINFO; GitHub doesn't keep a leading dot in asset names.
(cd "$pkgdir" && makepkg --printsrcinfo) > "$out/SRCINFO"

(cd "$out" && sha256sum "$base".* PKGBUILD SRCINFO > SHA256SUMS)
say "packages in $out"

# ---------------------------------------------------------------------------
# Checks

# Each package, unpacked again by its own format's tools.
check="$work/check"
mkdir -p "$check"/{zst,xz,deb,rpm,appimage,arch}
tar -C "$check/zst" -xf "$out/$base.tar.zst"
tar -C "$check/xz" -xf "$out/$base.tar.xz"
"$tools/dpkg-deb" -x "$out/$base.deb" "$check/deb"
"$tools/dpkg-deb" -e "$out/$base.deb" "$check/deb/DEBIAN"
"$tools/rpm2cpio" "$out/$base.rpm" | bsdtar -C "$check/rpm" -xf -
"$tools/rpm" -qp --dbpath "$rpmtop/db" --requires "$out/$base.rpm" > "$check/rpm-requires.txt"
# The squashfs starts where the runtime ends.
"$tools/unsquashfs" -q -n -d "$check/appimage/root" -o "$(stat -c %s "$deps/appimage-runtime-x86_64")" \
  "$out/$base.AppImage" > /dev/null
(cd "$pkgdir" && PKGDEST="$check/arch-pkg" makepkg --nodeps --noconfirm --noprogressbar -f > "$work/makepkg.log" 2>&1) \
  || { cat "$work/makepkg.log" >&2; die "makepkg couldn't build the PKGBUILD"; }
bsdtar -C "$check/arch" -xf "$check"/arch-pkg/*.pkg.tar.*
for unpacked in zst xz deb rpm appimage/root arch; do
  find "$check/$unpacked" -path '*/browser-wip/browser-wip' -type f -perm -u+x | grep -q . \
    || die "the $unpacked package has no runnable browser-wip"
done
[[ -x "$check/deb/usr/bin/browser-wip" && -x "$check/rpm/usr/bin/browser-wip" && -x "$check/arch/usr/bin/browser-wip" ]] \
  || die "a .deb, .rpm or Arch package lacks /usr/bin/browser-wip"

secrets="$work/secrets"
(umask 077 && gh auth token > "$secrets" 2> /dev/null || : > "$secrets")
BWV_SCAN_LITERALS_FILE="$secrets" python3 -I "$repo/tools/release/scan_secrets.py" "$check" "$out"
rm -f "$secrets"
(cd "$out" && sha256sum --quiet -c SHA256SUMS)
say "checks passed: each package unpacks and runs from where it should, nothing private in any," \
  "the PKGBUILD builds, the checksums match"

if ((dry_run)); then
  say "dry run: not publishing $tag"
  exit 0
fi

# ---------------------------------------------------------------------------
# Publish

gecko_version="$(sed -n 's/^version=//p' "$repo/GECKO_REVISION")"
cat > "$work/notes.md" << EOF
**Unstable dev build. Not a stable release.** Built automatically on the developer's machine from $sha, on Gecko $gecko_version. Expect bugs; don't rely on it for anything important.

| Linux x86_64 | File |
|---|---|
| Any distribution, portable | \`$base.tar.zst\` or \`$base.tar.xz\`: extract, run \`browser-wip/browser-wip\` |
| Any distribution, one file | \`$base.AppImage\`: \`chmod +x\` it, run it |
| Debian, Ubuntu | \`$base.deb\`: \`sudo apt install ./$base.deb\` |
| Fedora, openSUSE | \`$base.rpm\`: \`sudo dnf install ./$base.rpm\` |
| Arch Linux | \`PKGBUILD\`: put it in an empty folder, run \`makepkg -si\` |

Check a download with \`sha256sum -c SHA256SUMS --ignore-missing\`. The packages aren't signed.
EOF
gh release create "$tag" --repo "$github" --target "$sha" --prerelease --latest=false \
  --title "Dev build $(date -u -d "@$epoch" +%Y-%m-%d) ($short), unstable" --notes-file "$work/notes.md" \
  "$out/$base".* "$out/PKGBUILD" "$out/SRCINFO" "$out/SHA256SUMS"

# What GitHub serves has to match what was checked.
mkdir "$work/served"
gh release download "$tag" --repo "$github" --dir "$work/served"
(cd "$work/served" && sha256sum --quiet -c SHA256SUMS) || die "the files GitHub serves don't match SHA256SUMS"
say "published https://github.com/$github/releases/tag/$tag (pre-release); the files GitHub serves match SHA256SUMS"
