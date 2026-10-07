#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Refresh the vendored filter lists from a checkout of EasyList's sources.

The browser never downloads lists. Developers run this script to snapshot
them into the repository, and the build compiles the snapshot.

    git clone --depth 1 https://github.com/easylist/easylist.git /tmp/easylist
    python3 -I tools/update-blocklists.py /tmp/easylist

EasyList, EasyPrivacy and Fanboy's Social list are dual licensed under
GPLv3 and CC BY-SA 3.0 (https://easylist.to/pages/licence.html). We use them
under CC BY-SA 3.0; the attribution header is kept in each snapshot.
"""

import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app/components/contentblocking/lists"

# template in the EasyList repo -> snapshot file name
LISTS = {
    "easylist.template": "easylist.txt",
    "easyprivacy.template": "easyprivacy.txt",
    "fanboy-social.template": "fanboy-social.txt",
}

INCLUDE = re.compile(r"^%include easylist:(.+)%$")


def assemble(repo: Path, template: str) -> list[str]:
    lines = []
    for line in (repo / template).read_text(encoding="utf-8").splitlines():
        m = INCLUDE.match(line.strip())
        if m:
            path = (repo / m.group(1)).resolve()
            if repo.resolve() not in path.parents:
                raise SystemExit(f"include escapes the repository: {m.group(1)}")
            lines.extend(path.read_text(encoding="utf-8").splitlines())
        else:
            lines.append(line)
    return lines


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    repo = Path(sys.argv[1])
    commit = subprocess.run(
        ["git", "-C", str(repo), "log", "-1", "--format=%H %cI"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()

    OUT.mkdir(parents=True, exist_ok=True)
    for template, name in LISTS.items():
        lines = assemble(repo, template)
        # Line 1 is the "[Adblock Plus x.y]" marker; keep it first.
        lines.insert(1, f"! Snapshot: github.com/easylist/easylist {commit}")
        (OUT / name).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"{name}: {len(lines)} lines")


if __name__ == "__main__":
    main()
