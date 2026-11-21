#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Refresh the list of page-translation files from Mozilla.

The browser never asks Remote Settings for this list (it's turned off by
policy). Developers run this script to snapshot it into the repository, and
the browser downloads only the files in the snapshot, each checked against
the hash recorded here (components/translations/PageTranslations.sys.mjs).

    python3 -I tools/update-translation-models.py

Fetches the translations-models-v2 and translations-wasm-v2 collections from
Mozilla's Remote Settings server over HTTPS and keeps the records the engine
in this Gecko would use, as TranslationsParent.sys.mjs picks them:

  - records whose filter expression holds for a desktop release build;
  - model files of the major version this Gecko supports
    (LANGUAGE_MODEL_MAJOR_VERSION_MIN/MAX), and the bergamot-translator wasm
    of BERGAMOT_MAJOR_VERSION, read from TranslationsParent.sys.mjs;
  - per file name and language pair, the newest version;
  - no lexical shortlists ("lex"): the engine leaves them out
    (browser.translations.useLexicalShortlist is false);
  - per language pair, only the files of its model's version.

Writes app/components/translations/models.json. Review the diff before
committing it: the hashes in it decide what the browser accepts.
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GECKO = ROOT.parent / "mozilla-central"
PARENT = GECKO / "toolkit/components/translations/actors/TranslationsParent.sys.mjs"
OUT = ROOT / "app/components/translations/models.json"
SERVER = "https://firefox.settings.services.mozilla.com/v1"
COLLECTIONS = {"models": "translations-models-v2", "wasm": "translations-wasm-v2"}

# Filter expressions seen in these collections, and whether each holds for a
# desktop (Linux or Windows) release build. Anything else stops the script.
FILTERS = {
    "": True,
    "env.appinfo.OS != 'Android'": True,
    "env.appinfo.OS == 'Android'": False,
    # Pre-release models, for Nightly and local Firefox builds.
    "env.channel == 'default' || env.channel == 'nightly'": False,
}
# Kept from each record; the rest is Remote Settings bookkeeping.
FIELDS = (
    "id", "name", "fileType", "sourceLanguage", "targetLanguage", "variant", "architecture", "version",
    "release", "revision", "license", "attachment", "decompressedHash", "decompressedSize",
)


def get_json(url):
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "browser-wip-dev"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def gecko_constant(name):
    match = re.search(rf"static {name} = (\d+);", PARENT.read_text(encoding="utf-8"))
    if not match:
        sys.exit(f"update-translation-models: {name} not found in {PARENT}")
    return int(match.group(1))


def version_key(version):
    """Orders "3.0a1" < "3.0" < "3.1", as Services.vc.compare does here."""
    match = re.fullmatch(r"(\d+)\.(\d+)(?:a(\d+))?", version)
    if not match:
        raise ValueError(f"unexpected version {version!r}")
    major, minor, alpha = match.groups()
    return (int(major), int(minor), 0 if alpha else 1, int(alpha or 0))


def applicable(records):
    kept = []
    for record in records:
        if record.get("deleted"):
            continue
        expression = record.get("filter_expression", "")
        if expression not in FILTERS:
            sys.exit(f"update-translation-models: unknown filter expression {expression!r}; add it to FILTERS")
        if FILTERS[expression]:
            kept.append({k: record[k] for k in FIELDS if k in record})
    return kept


def newest(records, key, major_min, major_max):
    best = {}
    for record in records:
        if not major_min <= version_key(record["version"])[0] <= major_max:
            continue
        k = key(record)
        if k not in best or version_key(best[k]["version"]) < version_key(record["version"]):
            best[k] = record
    return list(best.values())


def select_models(records, major_min, major_max):
    def pair(r):
        return (r["sourceLanguage"], r["targetLanguage"], r.get("variant") or "")

    records = newest(applicable(records), lambda r: (r["name"],) + pair(r), major_min, major_max)
    records = [r for r in records if r["fileType"] != "lex"]
    model_version = {pair(r): r["version"] for r in records if r["fileType"] == "model"}
    records = [r for r in records if model_version.get(pair(r)) == r["version"]]
    return sorted(records, key=lambda r: pair(r) + (r["fileType"], r["name"]))


def select_wasm(records, major):
    records = [r for r in applicable(records) if r["name"] == "bergamot-translator"]
    return newest(records, lambda r: r["name"], major, major)


def main():
    model_min = gecko_constant("LANGUAGE_MODEL_MAJOR_VERSION_MIN")
    model_max = gecko_constant("LANGUAGE_MODEL_MAJOR_VERSION_MAX")
    wasm_major = gecko_constant("BERGAMOT_MAJOR_VERSION")
    attachments = get_json(f"{SERVER}/")["capabilities"]["attachments"]["base_url"]
    if not attachments.startswith("https://"):
        sys.exit(f"update-translation-models: unexpected attachments address {attachments}")
    fetched = {
        kind: get_json(f"{SERVER}/buckets/main/collections/{name}/changeset?_expected=0")
        for kind, name in COLLECTIONS.items()
    }
    models = select_models(fetched["models"]["changes"], model_min, model_max)
    wasm = select_wasm(fetched["wasm"]["changes"], wasm_major)
    if not models or len(wasm) != 1:
        sys.exit(f"update-translation-models: {len(models)} model files and {len(wasm)} engines; expected some and 1")
    data = {
        "comment": "Generated by tools/update-translation-models.py; don't edit.",
        "attachmentsURL": attachments,
        "timestamps": {kind: fetched[kind]["timestamp"] for kind in COLLECTIONS},
        "wasm": wasm,
        "models": models,
    }
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    pairs = {(r["sourceLanguage"], r["targetLanguage"]) for r in models}
    print(f"update-translation-models: {len(models)} files for {len(pairs)} language pairs, "
          f"engine {wasm[0]['version']}, in {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
