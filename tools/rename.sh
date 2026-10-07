#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Replace the codename everywhere it appears: file contents, file names and
# directory names. The codename has three spellings:
#   browser-wip  binary, paths, chrome package, profile, remoting name
#   browserwip   pref branch (browserwip.*) and identifiers
#   BrowserWip   type and class names
#
#   tools/rename.sh <kebab-name> <lowername> <CamelName>
#   tools/rename.sh --check     exit 1 if the codename still appears
#
# Visible product strings come from app/branding/*/locales; review those by
# hand after renaming, since a product name may need different casing there.
set -euo pipefail
cd "$(dirname "$0")/.."

pattern='browser-wip|browserwip|BrowserWip'
# Paths whose contents mention the codename for historical reasons.
exclude=(':!docs/PLAN.md' ':!tools/rename.sh')

if [[ "${1:-}" == "--check" ]]; then
  if git grep -nIE "$pattern" -- . "${exclude[@]}"; then
    echo "codename still present" >&2
    exit 1
  fi
  exit 0
fi

[[ $# -eq 3 ]] || { sed -n '2,/^set -e/p' "$0" | grep '^#' | cut -c3-; exit 2; }
kebab="$1" lower="$2" camel="$3"

git grep -lIE "$pattern" -- . "${exclude[@]}" | while read -r f; do
  sed -i -e "s/browser-wip/$kebab/g" -e "s/browserwip/$lower/g" \
    -e "s/BrowserWip/$camel/g" "$f"
done

# -depth visits children before their parents, so renaming a directory never
# invalidates a path still to be visited.
find . -depth -path ./.git -prune -o -regextype egrep -regex ".*/[^/]*($pattern)[^/]*" -print |
  while read -r path; do
    base="$(basename "$path")"
    new="$(sed -e "s/browser-wip/$kebab/g" -e "s/browserwip/$lower/g" -e "s/BrowserWip/$camel/g" <<<"$base")"
    git mv "$path" "$(dirname "$path")/$new"
  done
echo "Renamed. Re-run tools/fetch-gecko.sh to remount the project directory."
