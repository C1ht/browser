#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Check a Gecko build for the vault core's test hooks.

    python3 -I tools/vault/release_binary_check.py <objdir>

Scans the vault core's object files as Gecko compiled them, then libxul
(libxul.so or xul.dll in dist/bin), for the strings that exist only in the
test build (testhooks.FORBIDDEN). Fails if any is found, or if the vault
objects aren't there at all. For libxul it also says whether the core is in
it: until something in the browser calls the core, the linker may leave it
out, and then "no hooks in libxul" proves nothing on its own; the objects
are the check that counts.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from testhooks import REQUIRED, scan  # noqa: E402


def main():
    objdir = Path(sys.argv[1])
    ok = True
    objects = sorted(p for p in objdir.glob("**/passwords/vault/*")
                     if p.suffix in (".o", ".obj") and p.stem in ("bwvault", "bwvstore", "bwvtxn"))
    if len(objects) != 3:
        print(f"vault core objects: expected 3, found {len(objects)}: {[str(p) for p in objects]}")
        ok = False
    for obj in objects:
        found, has_core = scan(obj.read_bytes(), REQUIRED.get(obj.stem))
        need = REQUIRED.get(obj.stem)
        print(f"{obj.relative_to(objdir)}: test hooks: {', '.join(found) if found else 'none'}"
              + (f"; contains {need.decode()!r}: {'yes' if has_core else 'NO'}" if need else ""))
        ok &= not found and has_core

    libs = [p for p in (objdir / "dist/bin/libxul.so", objdir / "dist/bin/xul.dll") if p.exists()]
    for lib in libs:
        data = lib.read_bytes()
        found, _ = scan(data)
        present = all(marker in data for marker in REQUIRED.values())
        print(f"{lib.relative_to(objdir)}: {len(data)} bytes; test hooks: "
              f"{', '.join(found) if found else 'none'}; vault core linked in: "
              f"{'yes' if present else 'no (nothing calls it yet; the objects above are the check)'}")
        ok &= not found
    if not libs:
        print("no libxul.so or xul.dll under dist/bin")
        ok = False
    print("release binary check:", "passed" if ok else "FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
