# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Which translation files tools/update-translation-models.py keeps: the
ones the engine would use, as TranslationsParent.sys.mjs picks them. The
snapshot in models.json is what the browser accepts."""

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("update_models", ROOT / "tools/update-translation-models.py")
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)

failed = False


def check(cond, msg):
    global failed
    print(("ok  " if cond else "FAIL") + " " + msg)
    failed |= not cond


def rec(name, file_type, version, src="fr", tgt="en", expression="", **extra):
    return {"id": f"{name}-{src}{tgt}-{version}", "name": name, "fileType": file_type, "version": version,
            "sourceLanguage": src, "targetLanguage": tgt, "filter_expression": expression,
            "attachment": {"hash": "0" * 64, "size": 1, "location": "x"}, "schema": 1, "last_modified": 2, **extra}


check([update.version_key(v) for v in ("3.0a1", "3.0", "3.1")] == sorted(update.version_key(v) for v in ("3.1", "3.0a1", "3.0")),
      "versions order as Gecko compares them: 3.0a1 < 3.0 < 3.1")

kept = update.select_models([
    rec("model.fren", "model", "3.0"),
    rec("model.fren", "model", "3.1"),
    rec("vocab.fren", "vocab", "3.0"),
    rec("vocab.fren", "vocab", "3.1"),
    rec("lex.fren", "lex", "3.1"),
    rec("model.fren", "model", "2.1"),
    rec("model.fren", "model", "4.0"),
    rec("model.deen", "model", "3.0", src="de", expression="env.appinfo.OS == 'Android'"),
    rec("model.esen", "model", "3.0a1", src="es", expression="env.channel == 'default' || env.channel == 'nightly'"),
    rec("model.iten", "model", "3.0", src="it", expression="env.appinfo.OS != 'Android'"),
    rec("vocab.iten", "vocab", "2.0", src="it"),
    rec("model.nlen", "model", "3.0", src="nl", deleted=True),
], 3, 3)
names = sorted((r["name"], r["version"]) for r in kept)
check(("model.fren", "3.1") in names and ("vocab.fren", "3.1") in names, "keeps the newest version of each file")
check(not any(v.startswith(("2.", "4.")) for _, v in names), "drops major versions this Gecko doesn't support")
check(not any(n.startswith("lex") for n, _ in names), "drops lexical shortlists")
check(not any(r["sourceLanguage"] in ("de", "es") for r in kept), "drops Android-only and pre-release files")
check(("model.iten", "3.0") in names, "keeps files for every desktop")
check(not any(r["sourceLanguage"] == "nl" for r in kept), "drops deleted records")
check(all("filter_expression" not in r and "schema" not in r and "last_modified" not in r for r in kept),
      "keeps no Remote Settings bookkeeping")

try:
    update.select_models([rec("model.fren", "model", "3.0", expression="env.locale == 'fr'")], 3, 3)
    check(False, "an unknown filter expression stops the script")
except SystemExit:
    check(True, "an unknown filter expression stops the script")

wasm = update.select_wasm([
    {"id": "a", "name": "bergamot-translator", "version": "4.0", "attachment": {}, "filter_expression": ""},
    {"id": "b", "name": "bergamot-translator", "version": "3.0", "attachment": {}, "filter_expression": ""},
    {"id": "c", "name": "fasttext-wasm", "version": "4.0", "attachment": {}, "filter_expression": ""},
], 4)
check([w["id"] for w in wasm] == ["a"], "keeps the one engine of the major version this Gecko supports")

# The snapshot in the repository is what the script makes.
data = json.loads((ROOT / "app/components/translations/models.json").read_text(encoding="utf-8"))
pairs = {(r["sourceLanguage"], r["targetLanguage"]) for r in data["models"]}
check(len(data["wasm"]) == 1 and data["attachmentsURL"].startswith("https://"), "models.json has one engine and an https server")
check(all(len(r["attachment"]["hash"]) == 64 and r["attachment"]["size"] > 0 for r in data["wasm"] + data["models"]),
      "every file in models.json has a SHA-256 and a size")
check(("fr", "en") in pairs and ("en", "fr") in pairs and not any(r["fileType"] == "lex" for r in data["models"]),
      "models.json covers French both ways, without shortlists")

sys.exit(1 if failed else 0)
