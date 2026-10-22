#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Vendor the part of libsodium the password vault uses.

    python3 -I tools/vault/update-libsodium.py [--tarball FILE]

Downloads the pinned release (or takes a local tarball with its .minisig
beside it), checks its SHA-256 against the pin below and its minisign
signature against libsodium's published key, then replaces
app/third_party/libsodium/ with only the directories listed in KEEP.

To update: change VERSION and SHA256, run this, rebuild the vault tests,
and update sources.mozbuild if files were added or removed upstream.
"""

import argparse
import hashlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "1.0.22"
SHA256 = "adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349"
# From https://doc.libsodium.org/doc/installation
MINISIGN_KEY = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3"
URL = f"https://download.libsodium.org/libsodium/releases/libsodium-{VERSION}.tar.gz"

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / "app/third_party/libsodium"

# Under src/libsodium/: what Argon2id, XChaCha20-Poly1305, HKDF-SHA256,
# randombytes and guarded memory need, and nothing else.
KEEP = [
    "include",
    "sodium",
    "randombytes/randombytes.c",
    "randombytes/sysrandom",
    "crypto_pwhash/crypto_pwhash.c",
    "crypto_pwhash/argon2",
    "crypto_generichash/crypto_generichash.c",
    "crypto_generichash/blake2b",
    "crypto_aead/xchacha20poly1305",
    "crypto_aead/chacha20poly1305",
    "crypto_core/hchacha20",
    "crypto_stream/chacha20",
    "crypto_onetimeauth",
    "crypto_verify",
    "crypto_kdf/hkdf/kdf_hkdf_sha256.c",
    "crypto_auth/hmacsha256",
    "crypto_hash/sha256",
]

# Under test/: upstream's own known-answer tests for the primitives we use,
# run against our build by tools/vault/build.py.
KEEP_TESTS = [
    "default/cmptest.h",
    "quirks/quirks.h",
    "default/pwhash_argon2id.c",
    "default/pwhash_argon2id.exp",
    "default/aead_xchacha20poly1305.c",
    "default/aead_xchacha20poly1305.exp",
]


def fetch(url, path):
    with urllib.request.urlopen(url) as r, open(path, "wb") as f:
        shutil.copyfileobj(r, f)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tarball", type=Path, help="local copy, with .minisig beside it")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        if args.tarball:
            tarball, sig = args.tarball, Path(str(args.tarball) + ".minisig")
        else:
            tarball, sig = tmp / f"libsodium-{VERSION}.tar.gz", tmp / f"libsodium-{VERSION}.tar.gz.minisig"
            fetch(URL, tarball)
            fetch(URL + ".minisig", sig)

        digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
        if digest != SHA256:
            sys.exit(f"SHA-256 mismatch: got {digest}, pinned {SHA256}")
        if shutil.which("minisign"):
            cmd = ["minisign", "-V", "-P", MINISIGN_KEY, "-m", str(tarball), "-x", str(sig)]
        else:
            cmd = ["node", str(Path(__file__).with_name("minisign-verify.mjs")), MINISIGN_KEY, str(tarball), str(sig)]
        if subprocess.run(cmd).returncode != 0:
            sys.exit("minisign signature check failed")

        with tarfile.open(tarball) as t:
            t.extractall(tmp / "x", filter="data")
        src = tmp / "x" / f"libsodium-{VERSION}"

        if DEST.exists():
            shutil.rmtree(DEST / "src", ignore_errors=True)
            shutil.rmtree(DEST / "test", ignore_errors=True)
        (DEST / "test").mkdir(parents=True)
        for rel in KEEP_TESTS:
            shutil.copy2(src / "test" / rel, DEST / "test" / Path(rel).name)
        lib = src / "src/libsodium"
        for rel in KEEP:
            s, d = lib / rel, DEST / "src" / rel
            d.parent.mkdir(parents=True, exist_ok=True)
            if s.is_dir():
                shutil.copytree(s, d)
            else:
                shutil.copy2(s, d)
        shutil.copy2(src / "LICENSE", DEST / "LICENSE")

        # version.h is normally made by configure.
        configure = (src / "configure.ac").read_text()
        major = configure.split("SODIUM_LIBRARY_VERSION_MAJOR=")[1].split()[0]
        minor = configure.split("SODIUM_LIBRARY_VERSION_MINOR=")[1].split()[0]
        template = (lib / "include/sodium/version.h.in").read_text()
        version_h = (template.replace("@VERSION@", VERSION)
                     .replace("@SODIUM_LIBRARY_VERSION_MAJOR@", major)
                     .replace("@SODIUM_LIBRARY_VERSION_MINOR@", minor)
                     .replace("@SODIUM_LIBRARY_MINIMAL_DEF@", ""))
        (DEST / "src/include/sodium/version.h").write_text(version_h)
        (DEST / "src/include/sodium/version.h.in").unlink()

        (DEST / "VERSION").write_text(f"{VERSION}\nsha256 {SHA256}\nminisign {MINISIGN_KEY}\n")
    print(f"libsodium {VERSION} vendored into {DEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
