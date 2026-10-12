#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Fetch the pinned Firefox release source and mount app/ into it as the
# browser-wip project directory. mozilla-central itself is never modified:
# the mount is an untracked symlink, hidden through .git/info/exclude.
#
#   tools/fetch-gecko.sh            fetch the commit in GECKO_REVISION
#   tools/fetch-gecko.sh --update   move the pin to the head of the release branch
#
# GECKO_DIR overrides the checkout location (default: ../mozilla-central).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
gecko="${GECKO_DIR:-$root/../mozilla-central}"
remote="https://github.com/mozilla-firefox/firefox.git"
pin() { sed -n "s/^$1=//p" "$root/GECKO_REVISION"; }

if [[ ! -d "$gecko/.git" ]]; then
  git init -q "$gecko"
  git -C "$gecko" remote add origin "$remote"
fi

if [[ "${1:-}" == "--update" ]]; then
  git -C "$gecko" fetch -q --depth 1 origin "$(pin tag)"
  commit="$(git -C "$gecko" rev-parse FETCH_HEAD)"
  version="$(git -C "$gecko" show FETCH_HEAD:browser/config/version.txt)"
  sed -i -e "s/^commit=.*/commit=$commit/" -e "s/^version=.*/version=$version/" \
    "$root/GECKO_REVISION"
  echo "Pinned Firefox $version ($commit)"
fi

commit="$(pin commit)"
if [[ "$(git -C "$gecko" rev-parse -q --verify HEAD || true)" != "$commit" ]]; then
  git -C "$gecko" fetch -q --depth 1 origin "$commit"
  git -C "$gecko" checkout -q -B release-pin "$commit"
fi

ln -sfn "$root/app" "$gecko/browser-wip"
grep -qx "/browser-wip" "$gecko/.git/info/exclude" 2>/dev/null ||
  echo "/browser-wip" >> "$gecko/.git/info/exclude"

if [[ -n "$(git -C "$gecko" status --porcelain)" ]]; then
  echo "warning: $gecko has local changes; browser-wip expects a pristine tree" >&2
fi
echo "Gecko $(pin version) at $gecko, app mounted at $gecko/browser-wip"
