#!/usr/bin/env bash
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#
# Unit tests for app logic that runs without Gecko (Node 20+, Python 3).
set -euo pipefail
cd "$(dirname "$0")/../.."
export CB_OUT="$(mktemp -d)"
trap 'rm -rf "$CB_OUT"' EXIT
python3 -I app/components/contentblocking/compile_lists.py "$CB_OUT" \
  app/components/contentblocking/lists/*.txt > /dev/null
status=0
echo "== tests/unit/compile_lists_test.py"
python3 -I tests/unit/compile_lists_test.py || status=1
for t in tests/unit/*.test.mjs; do
  echo "== $t"
  node "$t" || status=1
done
exit $status
