# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""last_modified.json for toolkit's bundled Remote Settings dumps.

Same output as services/settings/dumps/gen_last_modified.py, whose
per-file logic is reused; only the dump location is decided here, because
the upstream script refuses unknown apps.
"""

import glob
import importlib.util
import json
import os

import buildconfig
import mozpack.path as mozpath

_upstream_path = mozpath.join(
    buildconfig.topsrcdir, "services", "settings", "dumps", "gen_last_modified.py"
)
_spec = importlib.util.spec_from_file_location("gen_last_modified", _upstream_path)
_upstream = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_upstream)


def main(output):
    root = mozpath.join(buildconfig.topsrcdir, "services", "settings", "dumps")
    dumps = {}
    for path in glob.iglob(mozpath.join(root, "*", "*.json")):
        folder, filename = os.path.split(path)
        dumps[f"{os.path.basename(folder)}/{os.path.splitext(filename)[0]}"] = path
    json.dump(
        {key: _upstream.get_last_modified(path) for key, path in dumps.items()},
        output,
        sort_keys=True,
    )
    return set(dumps.values()) | {_upstream_path}
