#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Build and test the password vault core without Gecko.

    python3 -I tools/vault/build.py [--cc clang|gcc|clang-cl] [--sanitize]
                                    [--out DIR] [--run]
    python3 -I tools/vault/build.py --fuzz SECONDS     (Linux, clang)

Compiles the vendored libsodium exactly as app/third_party/libsodium/
sources.mozbuild describes for this OS, plus the vault core, then (--run):
libsodium's own known-answer tests for Argon2id and XChaCha20-Poly1305
against this build, and the vault tests. --fuzz builds the libFuzzer target
and runs it on a corpus seeded by `vault_test corpus`.
"""

import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SODIUM = ROOT / "app/third_party/libsodium"
VAULT = ROOT / "app/components/passwords/vault"
CODENAME = re.compile(r"browser-?wip", re.I)


def sodium_config():
    """The lists from sources.mozbuild, for this OS and CPU."""
    scope = {}
    exec((SODIUM / "sources.mozbuild").read_text(), scope)
    os_arch = "WINNT" if sys.platform == "win32" else "Linux"
    cpu = "x86_64" if platform.machine().lower() in ("x86_64", "amd64") else platform.machine()
    defines = dict(scope["sodium_defines"])
    defines.update(scope["sodium_defines_cpu"].get(cpu, {}))
    defines.update(scope["sodium_defines_os"][os_arch])
    sources = [SODIUM / s for s in scope["sodium_sources"]]
    includes = [SODIUM / i for i in scope["sodium_includes"]]
    return sources, includes, defines


class Compiler:
    def __init__(self, cc, sanitize, fuzz):
        self.cc = cc
        self.msvc = cc == "clang-cl"
        self.windows = sys.platform == "win32"
        self.sanitize = sanitize
        self.fuzz = fuzz

    def obj_ext(self):
        return ".obj" if self.windows else ".o"

    def common(self):
        if self.msvc:
            flags = ["/nologo", "/O2", "/Z7"]
            if self.sanitize:
                flags.append("/fsanitize=address")
            return flags
        flags = ["-O2", "-g", "-std=gnu11"]
        if self.fuzz:
            flags += ["-fsanitize=fuzzer-no-link,address,undefined", "-fno-omit-frame-pointer"]
        elif self.sanitize:
            sanitizers = "address" if self.windows else "address,undefined"
            flags += [f"-fsanitize={sanitizers}", "-fno-sanitize-recover=all", "-fno-omit-frame-pointer"]
        return flags

    def compile(self, src, obj, includes, defines, ours, kat=False):
        if self.msvc:
            cmd = [self.cc, *self.common(), "/c", str(src), f"/Fo{obj}"]
            cmd += ["/W4", "/WX"] if ours else ["/w"]
            cmd += [f"/I{i}" for i in includes]
            cmd += [f"/D{k}={v}" for k, v in defines.items()]
        else:
            cmd = [self.cc, *self.common(), "-c", str(src), "-o", str(obj)]
            cmd += ["-Wall", "-Wextra", "-Werror"] if ours else ["-w"]
            if kat and self.sanitize:
                # Under ASan, upstream's harness sets its guard page to NULL
                # and its misuse checks pass that to non-null parameters on
                # purpose. Only the test programs are exempt, not libsodium.
                cmd.append("-fno-sanitize=nonnull-attribute")
            cmd += [f"-I{i}" for i in includes]
            cmd += [f"-D{k}={v}" for k, v in defines.items()]
        return subprocess.run(cmd, capture_output=True, text=True)

    def link(self, objs, exe):
        if self.msvc:
            cmd = [self.cc, *self.common(), *map(str, objs), f"/Fe{exe}", "advapi32.lib"]
        else:
            cmd = [self.cc, *self.common(), *map(str, objs), "-o", str(exe)]
            if self.fuzz:
                cmd.append("-fsanitize=fuzzer")
            if self.windows:
                cmd.append("-ladvapi32")
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            sys.exit(f"link failed: {exe.name}\n{result.stdout}{result.stderr}")


def build(args):
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    cc = Compiler(args.cc, args.sanitize, args.fuzz is not None)
    sources, includes, defines = sodium_config()
    ext = cc.obj_ext()

    # Constants in the vault format must not contain the codename.
    leaks = [p.name for p in VAULT.glob("*.[ch]") if CODENAME.search(p.read_text())]
    if leaks:
        sys.exit(f"vault format files mention the codename: {leaks}")

    jobs = [(s, out / "obj" / (s.relative_to(SODIUM).as_posix().replace("/", "_") + ext), False)
            for s in sources]
    jobs.append((VAULT / "bwvault.c", out / "obj" / ("bwvault" + ext), True))
    tests = {
        "vault_test": VAULT / "tests/vault_test.c",
        "kat_argon2id": SODIUM / "test/pwhash_argon2id.c",
        "kat_xchacha20poly1305": SODIUM / "test/aead_xchacha20poly1305.c",
    }
    if args.fuzz is not None:
        tests = {"fuzz_vault": VAULT / "tests/fuzz_vault.c"}
    for name, src in tests.items():
        jobs.append((src, out / "obj" / (name + ext), name in ("vault_test", "fuzz_vault")))
    (out / "obj").mkdir(exist_ok=True)

    inc = includes + [VAULT, SODIUM / "test"]
    test_defines = dict(defines)
    # Upstream tests find their expected output here.
    test_defines["TEST_SRCDIR"] = '"' + (SODIUM / "test").as_posix() + '"'

    def run(job):
        src, obj, ours = job
        is_kat = src.parent == SODIUM / "test"
        return src, cc.compile(src, obj, inc, test_defines if is_kat else defines, ours, is_kat)

    with ThreadPoolExecutor(max_workers=os.cpu_count() or 4) as pool:
        failed = [(s, r) for s, r in pool.map(run, jobs) if r.returncode != 0]
    if failed:
        for src, r in failed:
            print(f"--- {src.relative_to(ROOT)}\n{r.stdout}{r.stderr}", file=sys.stderr)
        sys.exit(f"{len(failed)} file(s) failed to compile")

    lib = [out / "obj" / (s.relative_to(SODIUM).as_posix().replace("/", "_") + ext) for s in sources]
    core = out / "obj" / ("bwvault" + ext)
    exe_ext = ".exe" if cc.windows else ""
    exes = {}
    for name in tests:
        exe = out / (name + exe_ext)
        objs = [out / "obj" / (name + ext), *lib]
        if name in ("vault_test", "fuzz_vault"):
            objs.append(core)
        cc.link(objs, exe)
        exes[name] = exe
    print(f"built {', '.join(exes)} in {out}")
    return out, exes


def run_tests(out, exes):
    ok = True
    for name in ("kat_argon2id", "kat_xchacha20poly1305"):
        # Upstream tests write <name>.res in the working directory and
        # compare it with the .exp file; exit 0 means identical.
        r = subprocess.run([str(exes[name])], cwd=out)
        print(f"{'ok  ' if r.returncode == 0 else 'FAIL'}  libsodium {name[4:]} known answers")
        ok &= r.returncode == 0
    r = subprocess.run([str(exes["vault_test"])], cwd=out)
    ok &= r.returncode == 0
    return ok


def fuzz(out, exes, seconds):
    corpus = out / "corpus"
    corpus.mkdir(exist_ok=True)
    seeds = ROOT / "app/components/passwords/vault/tests/corpus"
    if seeds.is_dir():
        for f in seeds.iterdir():
            shutil.copy2(f, corpus / f.name)
    r = subprocess.run([str(exes["fuzz_vault"]), str(corpus), f"-max_total_time={seconds}",
                        "-max_len=40000", "-timeout=10", "-rss_limit_mb=4096",
                        f"-artifact_prefix={out}/"])
    return r.returncode == 0


def main():
    parser = argparse.ArgumentParser()
    default_cc = "clang" if shutil.which("clang") else "gcc"
    parser.add_argument("--cc", default=os.environ.get("CC", default_cc))
    parser.add_argument("--sanitize", action="store_true")
    parser.add_argument("--fuzz", type=int, metavar="SECONDS")
    parser.add_argument("--out", default=str(ROOT / "obj-vault"))
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    out, exes = build(args)
    if args.fuzz is not None:
        sys.exit(0 if fuzz(out, exes, args.fuzz) else 1)
    if args.run:
        sys.exit(0 if run_tests(out, exes) else 1)


if __name__ == "__main__":
    main()
