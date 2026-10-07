# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Which filter-list rules the compiler turns into classifier entries."""

import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "app/components/contentblocking"))
from compile_lists import Compiled  # noqa: E402

TABLE = "wip-ads-digest256"
failed = False


def check(cond, msg):
    global failed
    print(("ok  " if cond else "FAIL") + " " + msg)
    failed |= not cond


def blocked(lines):
    c = Compiled()
    c.add_list("easylist", lines)
    data, _ = c.table_update(TABLE)
    body = data.split(b"\n", 3)[3]
    hashes = {body[i:i + 32] for i in range(0, len(body), 32)}
    return lambda frag: hashlib.sha256(frag.encode()).digest() in hashes


b = blocked([
    "||ads.example^",
    "||tracker.example^$script,third-party,xmlhttprequest",
    "||site-scoped.example^$domain=news.example",
    "||popup.example^$popup",
    "||firstparty.example^$~third-party",
    "||cancelled.example^$third-party",
    "||cancelled.example^$third-party,badfilter",
    "||path.example/ads/",
    "||wild.example^*/pixel.js",
    "@@||allowed.example^",
    "||allowed.example^",
    "||redirect.example^$redirect=noop.js",
])
check(b("ads.example/"), "plain host rule is blocked")
check(b("tracker.example/"), "rule with resource types is blocked")
check(not b("site-scoped.example/"), "$domain= rule is skipped")
check(not b("popup.example/"), "popup-only rule is skipped")
check(not b("firstparty.example/"), "first-party-only rule is skipped")
check(not b("cancelled.example/"), "$badfilter cancels its rule")
check(b("path.example/ads/"), "literal path prefix is kept")
check(not b("wild.example/"), "wildcard path is not widened to the whole host")
check(not b("allowed.example/"), "exception removes the host")
check(not b("redirect.example/"), "$redirect= rule is skipped")
sys.exit(1 if failed else 0)
