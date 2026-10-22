# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""What the compiler takes from the lists: element-hiding rules, and the
exceptions that switch element hiding off for a site. Network rules are the
network blocker's (tests/blocker, tools/adblock)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "app/components/contentblocking"))
from compile_lists import Compiled  # noqa: E402

failed = False


def check(cond, msg):
    global failed
    print(("ok  " if cond else "FAIL") + " " + msg)
    failed |= not cond


c = Compiled()
c.add_list("easylist", [
    "! comment",
    "||ads.example^",
    "##.ad-banner",
    "news.example##.site-ad",
    "##.ad-slot",
    "~quiet.example##.ad-slot",
    "##.everywhere",
    "#@#.everywhere",
    "##.promo:has-text(Sponsored)",
    "##div{}",
    "@@||nohide.example^$generichide",
    "@@||plain.example^",
])
c.add_list("fanboy-social", ["##.social-widget"])
css, _ = c.generic_css()
index = c.site_index()

check(".ad-banner{display:none!important}\n" in css, "generic rule goes into the shared sheet")
check(index["specific"] == {"news.example": [".site-ad"]}, "site rule goes into the site index only")
check(".ad-slot" not in css and index["conditionalGeneric"].get(".ad-slot") == ["quiet.example"],
      "generic rule with an excepted site is applied per site")
check(".everywhere" not in css and ".everywhere" not in index["conditionalGeneric"],
      "#@# without sites turns a generic rule off everywhere")
check(c.skipped["cosmetic-unsupported"] == 1 and ":has-text" not in css, "procedural selector is skipped")
check(c.skipped["cosmetic-unsafe"] == 1 and "div{" not in css, "selector with braces is skipped")
check(index["noGeneric"] == ["nohide.example"], "$generichide switches generic hiding off; a plain exception doesn't")
check(".social-widget" not in css, "the social list's element hiding is not applied")
check("ads.example" not in css + str(index), "network rules are left to the network blocker")
sys.exit(1 if failed else 0)
