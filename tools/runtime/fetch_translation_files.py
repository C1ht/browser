#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Fetch the page-translation files the runtime checks use (part 18).

    python3 -I tools/runtime/fetch_translation_files.py <directory>

Downloads the translation engine and the French-to-English files listed in
app/components/translations/models.json from Mozilla's attachment server,
into <directory>/<sha256>, checking each against the list. check.py serves
them on 127.0.0.1, so the checks translate a page for real, offline.
"""

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIST = ROOT / "app/components/translations/models.json"
PAIR = ("fr", "en")


def files():
    data = json.loads(LIST.read_text(encoding="utf-8"))
    models = [r for r in data["models"] if (r["sourceLanguage"], r["targetLanguage"]) == PAIR]
    return data["attachmentsURL"], data["wasm"] + models


def main(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    base, records = files()
    for record in records:
        attachment = record["attachment"]
        path = directory / attachment["hash"]
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == attachment["hash"]:
            continue
        request = urllib.request.Request(base + attachment["location"], headers={"User-Agent": "browser-wip-tests"})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read()
        if len(data) != attachment["size"] or hashlib.sha256(data).hexdigest() != attachment["hash"]:
            sys.exit(f"fetch_translation_files: {record['name']} doesn't match models.json")
        path.write_bytes(data)
        print(f"fetch_translation_files: {record['name']} ({len(data) // 1000} kB, hash good)")
    print(f"fetch_translation_files: {len(records)} files in {directory}")


if __name__ == "__main__":
    main(sys.argv[1])
