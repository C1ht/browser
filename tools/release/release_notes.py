#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Release notes for a dev build, from the commits since the last one.

    python3 -I tools/release/release_notes.py --base <name> --tag <tag> \\
        --gecko <version> --repo <owner/name> [--previous <tag>] <revision range>

Reads each commit's message in the range (oldest first) and gathers:

  - the paragraphs before the first section: what the commit is about;
  - the sections "New", "Fixes" and "Changes": "- " lines, merged across
    commits in that order. A commit with none of them counts its subject
    as a change.

Commit trailers (Co-Authored-By, Claude-Session, ...) and "[skip ci]" are
left out. Prints the notes as Markdown: the summary, the sections, how to
install each package, and a link to the full list of commits. See
CLAUDE.md, "Commit messages", for the format.
"""

import argparse
import re
import subprocess
import sys

SECTIONS = ("New", "Fixes", "Changes")
TRAILER = re.compile(r"^[A-Za-z-]+: \S")


def commits(revisions):
    log = subprocess.run(["git", "log", "--reverse", "--format=%H%x00%B%x01", revisions],
                         check=True, capture_output=True, text=True).stdout
    for entry in log.split("\x01"):
        entry = entry.strip("\n")
        if entry:
            sha, _, message = entry.partition("\x00")
            yield sha, message


def parse(message):
    lines = [line.rstrip() for line in message.strip().splitlines()]
    while lines and (TRAILER.match(lines[-1]) or not lines[-1]):
        lines.pop()
    subject = lines[0].replace("[skip ci]", "").strip() if lines else ""
    summary, sections, current = [], {}, None
    for line in lines[1:]:
        heading = line.strip().rstrip(":")
        if heading in SECTIONS:
            current = sections.setdefault(heading, [])
        elif current is None:
            summary.append(line)
        elif line.startswith("- "):
            current.append(line[2:].strip())
        elif line.startswith("  ") and current:
            # A bullet's continuation line.
            current[-1] += " " + line.strip()
    paragraphs = [p.strip() for p in "\n".join(summary).split("\n\n") if p.strip()]
    if not sections:
        sections["Changes"] = [subject]
    return subject, [" ".join(p.split()) for p in paragraphs], sections


def notes(args):
    summary, merged = [], {name: [] for name in SECTIONS}
    count = 0
    for _sha, message in commits(args.range):
        count += 1
        _subject, paragraphs, sections = parse(message)
        summary += paragraphs
        for name in SECTIONS:
            merged[name] += sections.get(name, [])
    if not count:
        sys.exit("release_notes: no commits in " + args.range)

    out = ["> **Unstable dev build.** Not a stable release: expect bugs, and keep backups of anything important.", ""]
    out += [p + "\n" for p in summary]
    for name in SECTIONS:
        if merged[name]:
            out.append(f"### {name}\n")
            out += [f"- {item}" for item in merged[name]]
            out.append("")
    base = args.base
    out += [
        "### Install (Linux x86_64)\n",
        "| System | File | How |",
        "|---|---|---|",
        f"| Any distribution | `{base}.tar.zst` or `.tar.xz` | Extract it and run `browser-wip/browser-wip` |",
        f"| Any distribution, one file | `{base}.AppImage` | `chmod +x` it and run it |",
        f"| Debian, Ubuntu | `{base}.deb` | `sudo apt install ./{base}.deb` |",
        f"| Fedora, openSUSE | `{base}.rpm` | `sudo dnf install ./{base}.rpm` |",
        "| Arch Linux | `PKGBUILD` | Put it in an empty folder and run `makepkg -si` |",
        "",
        "Check a download with `sha256sum -c SHA256SUMS --ignore-missing`. The packages aren't signed.",
        "",
        f"Built from {args.sha[:7] if args.sha else 'this commit'}, on the Gecko of Firefox {args.gecko}.",
    ]
    if args.previous:
        out.append(f"\n**Full changelog:** https://github.com/{args.repo}/compare/{args.previous}...{args.tag}")
    return "\n".join(out) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("range", help="git revision range, e.g. 1a2b3c4..HEAD, or a single commit")
    parser.add_argument("--base", required=True, help="the packages' file name, without extension")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--gecko", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", default="")
    parser.add_argument("--previous", default="", help="the last dev build's tag, for the changelog link")
    sys.stdout.write(notes(parser.parse_args()))


if __name__ == "__main__":
    main()
