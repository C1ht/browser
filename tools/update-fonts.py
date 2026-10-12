#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Refresh the fonts bundled on Windows (app/fonts/).

The Anonymous mode only lets pages see these fonts plus a fixed list of
Windows system fonts, exactly as Mullvad Browser and Tor Browser do, so the
font list matches theirs. The set and versions follow tor-browser-build's
projects/fonts/config (Windows: the common Noto families, Noto Naskh Arabic,
Noto Sans, Noto Serif, and Pyidaungsu). Keep them in step with it: any other
font, or another version of one, changes the fingerprint.

    python3 -I tools/update-fonts.py

Noto fonts and Pyidaungsu are under the SIL Open Font License 1.1.
"""

import hashlib
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app/fonts"

# tor-browser-build projects/fonts/config: noto-monthly-release-2026.02.01
NOTO_REPO = "https://github.com/notofonts/notofonts.github.io.git"
NOTO_COMMIT = "0dd6225462349adf863bf50d1a69ead98342e14d"

NOTO_FAMILIES = """
NotoSansAdlam NotoSansBalinese NotoSansBamum NotoSansBassaVah NotoSansBatak
NotoSansBengali NotoSansBuginese NotoSansBuhid NotoSansCanadianAboriginal
NotoSansChakma NotoSansCham NotoSansCherokee NotoSansCoptic NotoSansDeseret
NotoSansDevanagari NotoSansElbasan NotoSansEthiopic NotoSansGeorgian
NotoSansGrantha NotoSansGujarati NotoSansGunjalaGondi NotoSansGurmukhi
NotoSansHanifiRohingya NotoSansHanunoo NotoSansKannada NotoSansKhmer
NotoSansJavanese NotoSansKayahLi NotoSansKhojki NotoSansKhudawadi NotoSansLao
NotoSansLepcha NotoSansLimbu NotoSansLisu NotoSansMahajani NotoSansMalayalam
NotoSansMandaic NotoSansMasaramGondi NotoSansMedefaidrin NotoSansMeeteiMayek
NotoSansMendeKikakui NotoSansMiao NotoSansModi NotoSansMongolian NotoSansMro
NotoSansMultani NotoSansNewa NotoSansNewTaiLue NotoSansNKo NotoSansOlChiki
NotoSansOriya NotoSansOsage NotoSansOsmanya NotoSansPahawhHmong
NotoSansPauCinHau NotoSansRejang NotoSansRunic NotoSansSamaritan
NotoSansSaurashtra NotoSansSharada NotoSansShavian NotoSansSinhala
NotoSansSoraSompeng NotoSansSoyombo NotoSansSundanese NotoSansSylotiNagri
NotoSansSymbols2 NotoSansSymbols NotoSansSyriac NotoSansTagalog
NotoSansTagbanwa NotoSansTaiLe NotoSansTaiTham NotoSansTaiViet NotoSansTakri
NotoSansTamil NotoSansTelugu NotoSansThaana NotoSansTifinagh NotoSansTirhuta
NotoSansVai NotoSansWancho NotoSansWarangCiti NotoSansYi
NotoSansZanabazarSquare NotoSerifBalinese NotoSerifBengali NotoSerifDevanagari
NotoSerifDogra NotoSerifEthiopic NotoSerifGeorgian NotoSerifGrantha
NotoSerifGujarati NotoSerifGurmukhi NotoSerifKannada NotoSerifKhmer
NotoSerifKhojki NotoSerifLao NotoSerifMalayalam NotoSerifMyanmar
NotoSerifNPHmong NotoSerifSinhala NotoSerifTamil NotoSerifTelugu
NotoSerifTibetan NotoSerifYezidi
NotoNaskhArabic NotoSans NotoSerif
""".split()

PYIDAUNGSU = (
    "https://github.com/mcfnlp/Pyidaungsu/raw/ff1cd8dfe8c451244329d7a6181c83e769226cac/"
    "Pyidaungsu2.5.3/Release/Pyidaungsu-2.5.3_Regular.ttf",
    "df7106c15da76f6a24c10821b43da51f54961f6bc6791fb1fcf21c6c60bb2e10",
)


def git(*args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "noto"
        repo.mkdir()
        git("init", "-q", cwd=repo)
        git("remote", "add", "origin", NOTO_REPO, cwd=repo)
        # Only the regular hinted TTFs of the listed families are downloaded.
        git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", NOTO_COMMIT, cwd=repo)
        git("sparse-checkout", "set", "--no-cone",
            *[f"/fonts/{f}/hinted/ttf/*-Regular.ttf" for f in NOTO_FAMILIES], cwd=repo)
        git("checkout", "-q", NOTO_COMMIT, cwd=repo)

        # OFL.txt and moz.build stay; moz.build is rewritten below.
        if OUT.exists():
            for old in OUT.glob("*.[ot]tf"):
                old.unlink()
        OUT.mkdir(exist_ok=True)
        count = 0
        for family in NOTO_FAMILIES:
            fonts = [p for p in (repo / "fonts" / family / "hinted/ttf").glob("*-Regular.ttf")
                     if not p.name.endswith("UI-Regular.ttf")]
            if not fonts:
                sys.exit(f"no fonts for {family}")
            for font in fonts:
                shutil.copy(font, OUT / font.name)
                count += 1

    url, sha256 = PYIDAUNGSU
    data = urllib.request.urlopen(url).read()
    if hashlib.sha256(data).hexdigest() != sha256:
        sys.exit("Pyidaungsu checksum mismatch")
    (OUT / Path(url).name).write_bytes(data)
    write_moz_build()
    print(f"{count + 1} fonts in {OUT}")


def write_moz_build():
    names = sorted(p.name for p in OUT.glob("*.[ot]tf"))
    lines = [
        "# This Source Code Form is subject to the terms of the Mozilla Public",
        "# License, v. 2.0. If a copy of the MPL was not distributed with this",
        "# file, You can obtain one at http://mozilla.org/MPL/2.0/.",
        "",
        "# Generated by tools/update-fonts.py. The fonts pages may use on Windows,",
        "# installed to <appdir>/fonts where Gecko loads bundled fonts from, plus",
        "# Firefox's emoji font from the Gecko tree.",
        "",
        "FINAL_TARGET_FILES.fonts += [",
        '    "OFL.txt",',
        *[f'    "{n}",' for n in names],
        '    "/browser/fonts/TwemojiMozilla.ttf",',
        "]",
        "",
    ]
    (OUT / "moz.build").write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
