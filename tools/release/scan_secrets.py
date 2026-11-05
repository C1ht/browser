#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Check unpacked release packages for anything private before publishing.

    python3 -I tools/release/scan_secrets.py <directory>...

Reads every file under each directory, and every file inside the zip
archives among them (omni.ja, .xpi, .jar, .zip), at any depth, for:

  - private keys: PEM (with a key body after the header), OpenSSH, PGP,
    PuTTY;
  - access tokens: GitHub, AWS, Slack, Google API, Anthropic, OpenAI;
  - this machine's own secrets, matched literally and never printed: the
    GitHub CLI's token (from BWV_SCAN_LITERALS_FILE, one per line);
  - files that only a profile, a key store or a checkout has: key4.db,
    logins.json, cookies.sqlite, id_rsa, .git-credentials, .git, ..., and a
    profile's prefs.js (by its header).

Exits 1 and names each finding, or 0. Paths of the build machine's home
directory, which compilers write into binaries, are counted and reported
but aren't findings.
"""

import io
import os
import re
import sys
import zipfile
from pathlib import Path

PATTERNS = {
    "PEM private key": rb"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*(?:[A-Za-z-]+: [^\r\n]*\s*)*[A-Za-z0-9+/=\r\n]{64,}",
    "PGP private key": rb"-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "PuTTY private key": rb"PuTTY-User-Key-File-\d: ",
    "GitHub token": rb"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,})(?![A-Za-z0-9_])",
    "AWS access key": rb"(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])",
    "Slack token": rb"xox[baprs]-[0-9]{10,}-[0-9A-Za-z-]{10,}",
    "Google API key": rb"AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])",
    "Anthropic API key": rb"sk-ant-[A-Za-z0-9_-]{40,}",
    "OpenAI API key": rb"(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])",
    # A profile's prefs.js, by its header (DevTools has modules named prefs.js).
    "a profile's prefs.js": rb"\A// Mozilla User Preferences",
}
COMPILED = {name: re.compile(p) for name, p in PATTERNS.items()}

PRIVATE_NAMES = {
    "key3.db", "key4.db", "cert8.db", "cert9.db", "logins.json", "logins-backup.json", "cookies.sqlite",
    "places.sqlite", "formhistory.sqlite", "sessionstore.jsonlz4", "id_rsa", "id_dsa", "id_ecdsa",
    "id_ed25519", ".netrc", ".git-credentials", "hosts.yml", ".npmrc", ".pypirc", "credentials",
}
PRIVATE_SUFFIXES = (".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".ppk", ".gpg", ".asc", ".pem", ".key")
ARCHIVES = (".ja", ".xpi", ".jar", ".zip")


def literals():
    path = os.environ.get("BWV_SCAN_LITERALS_FILE")
    if not path:
        return []
    return [line.strip().encode() for line in Path(path).read_text().splitlines() if len(line.strip()) >= 8]


class Scan:
    def __init__(self):
        self.findings = []
        self.files = 0
        self.home = os.path.expanduser("~").encode() + b"/"
        self.home_paths = 0
        self.literals = literals()

    def name(self, label, name):
        base = name.rstrip("/").rsplit("/", 1)[-1]
        if base in PRIVATE_NAMES or base.lower().endswith(PRIVATE_SUFFIXES) or base == ".git":
            self.findings.append(f"{label}: a file a profile, key store or checkout has ({base})")

    def data(self, label, data, depth=0):
        self.files += 1
        for kind, pattern in COMPILED.items():
            if pattern.search(data):
                self.findings.append(f"{label}: {kind}")
        for i, literal in enumerate(self.literals):
            if literal in data:
                self.findings.append(f"{label}: this machine's secret #{i + 1}")
        if self.home in data:
            self.home_paths += 1
        if data[:4] == b"PK\x03\x04" or label.lower().endswith(ARCHIVES):
            self.archive(label, data, depth)

    def archive(self, label, data, depth):
        if depth > 4:
            return
        try:
            # omni.ja is a zip whose central directory may come first.
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for info in z.infolist():
                    inner = f"{label}!/{info.filename}"
                    self.name(inner, info.filename)
                    if not info.is_dir():
                        self.data(inner, z.read(info), depth + 1)
        except zipfile.BadZipFile:
            pass

    def tree(self, root):
        for dirpath, dirnames, filenames in os.walk(root):
            for d in dirnames:
                self.name(os.path.join(dirpath, d), d)
            for f in filenames:
                path = os.path.join(dirpath, f)
                self.name(path, f)
                if os.path.islink(path) or not os.path.isfile(path):
                    continue
                with open(path, "rb") as fh:
                    self.data(path, fh.read())


def main():
    scan = Scan()
    for root in sys.argv[1:]:
        scan.tree(root)
    print(f"scan_secrets: {scan.files} files read (archives included); "
          f"{len(scan.literals)} machine secret(s) checked; "
          f"{scan.home_paths} file(s) mention the build machine's home directory (build paths, not a finding)")
    for finding in scan.findings:
        print(f"FOUND {finding}")
    if scan.findings:
        print(f"scan_secrets: {len(scan.findings)} finding(s); don't publish")
        return 1
    print("scan_secrets: nothing private found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
