# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Compile Adblock Plus filter lists into the formats the browser loads.

Network rules become Safe Browsing v2 "digest256" table updates: one SHA-256
hash per URL fragment ("host/" or "host/path"). Gecko's URL classifier matches
them locally with full hashes, so no lookup ever leaves the machine. Only rules
the classifier can express exactly are kept: a host, optionally a literal
path, and no options beyond third-party (the classifier only blocks
third-party loads anyway).

Element-hiding rules become one user-agent stylesheet of generic selectors and
a JSON index of per-site selectors and exceptions, applied by the
ContentBlockingChild actor.

Run by the build (see moz.build). Can also be run by hand:
    python3 compile_lists.py <out-dir> lists/*.txt
"""

import hashlib
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# list file stem -> classifier table its network rules go into
TABLES = {
    "easylist": "wip-ads-digest256",
    "easyprivacy": "wip-track-digest256",
    "fanboy-social": "wip-social-digest256",
}

# Lists whose element-hiding rules are applied. Social widgets are only
# hidden in Strict mode, which handles them through its own table.
COSMETIC_LISTS = {"easylist", "easyprivacy"}

COSMETIC = re.compile(r"^([^#]*)(##|#@#|#\?#|#@\?#|#\$#|#@\$#|#%#|#@%#)(.+)$")
HOST_RULE = re.compile(
    r"^\|\|(?P<host>[a-z0-9][a-z0-9.-]*[a-z0-9])(?P<path>/[^*^|$]*)?\^?\|?$"
)
# Options a host rule may carry and still be applied. Resource-type options
# are accepted: the classifier then blocks every third-party load from the
# host, which is right for hosts that exist to serve ads or tracking.
# Anything scoped to particular sites ($domain=), first-party-only, popup-only,
# or rewriting requests ($redirect=, $csp=, ...) is skipped, because applying
# it everywhere would block more than the list intends.
NETWORK_OPTIONS_OK = {
    "third-party", "3p", "important", "all", "document", "doc",
    "script", "image", "stylesheet", "css", "xmlhttprequest", "xhr",
    "subdocument", "frame", "ping", "beacon", "media", "object",
    "websocket", "font", "other",
}
RESOURCE_TYPES = NETWORK_OPTIONS_OK - {"third-party", "3p", "important", "all"}
EXCEPTION_COSMETIC_OPTIONS = {"generichide", "ghide", "elemhide", "ehide"}

# Procedural or extension-specific selector syntax that CSS cannot apply.
UNSUPPORTED_SELECTOR = re.compile(
    r":-abp-|:has-text\(|:xpath\(|:upward\(|:remove\(|:style\(|:matches-|"
    r":min-text-length|:watch-attr|:others\(|:nth-ancestor|\+js\(|^\^"
)


def split_options(rule):
    # "$" introduces options unless the rule is a regex.
    if rule.startswith("/") or "$" not in rule:
        return rule, set()
    body, _, opts = rule.rpartition("$")
    return body, {o.strip().lower() for o in opts.split(",") if o.strip()}


def fragment(body):
    """Classifier fragment for a network rule body, or None."""
    m = HOST_RULE.match(body.lower())
    if not m:
        return None
    host, path = m.group("host"), m.group("path")
    if ".." in host or "." not in host:
        return None
    return f"{host}{path}" if path and path != "/" else f"{host}/"


class Compiled:
    def __init__(self):
        self.blocked = defaultdict(set)  # table -> fragments
        self.badfilters = set()  # (fragment, options) cancelled by $badfilter
        self.rule_options = defaultdict(set)  # fragment -> option sets seen
        self.allowed = set()  # fragments unblocked everywhere
        self.generic = set()
        self.generic_except = defaultdict(set)  # selector -> domains
        self.generic_disabled_everywhere = set()
        self.specific = defaultdict(set)  # domain -> selectors
        self.specific_except = defaultdict(set)  # domain -> selectors
        self.no_generic = set()  # domains with $generichide / $elemhide
        self.skipped = defaultdict(int)

    def add_list(self, stem, lines):
        table = TABLES[stem]
        cosmetic = stem in COSMETIC_LISTS
        for raw in lines:
            line = raw.strip()
            if not line or line.startswith(("!", "[")):
                continue
            m = COSMETIC.match(line)
            if m:
                if cosmetic:
                    self.add_cosmetic(*m.groups())
                continue
            self.add_network(table, line)

    def add_cosmetic(self, domains, sep, selector):
        if sep not in ("##", "#@#") or UNSUPPORTED_SELECTOR.search(selector):
            self.skipped["cosmetic-unsupported"] += 1
            return
        if "{" in selector or "}" in selector:
            self.skipped["cosmetic-unsafe"] += 1
            return
        include = [d for d in domains.lower().split(",") if d and not d.startswith("~")]
        exclude = [d[1:] for d in domains.lower().split(",") if d.startswith("~")]
        if sep == "#@#":
            if include:
                for d in include:
                    self.specific_except[d].add(selector)
            else:
                self.generic_disabled_everywhere.add(selector)
            return
        if include:
            for d in include:
                self.specific[d].add(selector)
            for d in exclude:
                self.specific_except[d].add(selector)
        else:
            self.generic.add(selector)
            for d in exclude:
                self.generic_except[selector].add(d)

    def add_network(self, table, line):
        exception = line.startswith("@@")
        body, opts = split_options(line[2:] if exception else line)
        frag = fragment(body)
        if exception:
            if opts & EXCEPTION_COSMETIC_OPTIONS and frag and frag.endswith("/"):
                self.no_generic.add(frag[:-1])
            elif frag and not opts:
                self.allowed.add(frag)
            return
        if "badfilter" in opts:
            # "rule$badfilter" cancels "rule" wherever it appears.
            if frag:
                self.badfilters.add((frag, frozenset(opts - {"badfilter"})))
            return
        if frag is None:
            self.skipped["network-pattern"] += 1
        elif not opts <= NETWORK_OPTIONS_OK:
            self.skipped["network-options"] += 1
        else:
            self.blocked[table].add(frag)
            self.rule_options[frag].add(frozenset(opts))

    def _cancelled(self, frag):
        # A fragment is dropped only if every rule that produced it was
        # cancelled by a matching $badfilter.
        seen = self.rule_options.get(frag, set())
        return bool(seen) and all((frag, o) in self.badfilters for o in seen)

    def table_update(self, table):
        hashes = sorted(
            hashlib.sha256(f.encode()).digest()
            for f in self.blocked[table] - self.allowed
            if not self._cancelled(f)
        )
        data = b"".join(hashes)
        head = f"n:1000\ni:{table}\na:1:32:{len(data)}\n".encode()
        return head + data, len(hashes)

    def conditional_generic(self):
        """Generic selectors some sites opt out of, with those sites.

        Exceptions come from "~site##sel" and from "site#@#sel". Such
        selectors cannot go into the shared stylesheet; the actor adds them
        per document instead.
        """
        excepted = defaultdict(set)
        for selector, domains in self.generic_except.items():
            excepted[selector] |= domains
        for domain, selectors in self.specific_except.items():
            for selector in selectors & self.generic:
                excepted[selector].add(domain)
        return {
            s: sorted(d)
            for s, d in excepted.items()
            if s in self.generic and s not in self.generic_disabled_everywhere
        }

    def generic_css(self):
        conditional = self.conditional_generic()
        always = sorted(
            s for s in self.generic
            if s not in conditional and s not in self.generic_disabled_everywhere
        )
        # One rule per selector: an invalid selector then drops only itself.
        return "".join(f"{s}{{display:none!important}}\n" for s in always), len(always)

    def site_index(self):
        conditional = self.conditional_generic()
        return {
            "conditionalGeneric": conditional,
            "specific": {d: sorted(s) for d, s in sorted(self.specific.items())},
            "specificExcept": {d: sorted(s) for d, s in sorted(self.specific_except.items())},
            "noGeneric": sorted(self.no_generic),
        }


def compile_lists(out_dir, list_paths):
    c = Compiled()
    digest = hashlib.sha256()
    snapshot = None
    for p in sorted(map(Path, list_paths)):
        text = p.read_text(encoding="utf-8")
        digest.update(text.encode())
        lines = text.splitlines()
        snapshot = snapshot or next(
            (l.split(":", 1)[1].strip() for l in lines[:5] if l.startswith("! Snapshot:")), None
        )
        c.add_list(p.stem, lines)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    # The browser reloads its classifier tables when this changes.
    stats = {"version": digest.hexdigest()[:16], "snapshot": snapshot, "tables": {}}
    for table in TABLES.values():
        data, count = c.table_update(table)
        (out_dir / f"{table}.update").write_bytes(data)
        stats["tables"][table] = count
    css, count = c.generic_css()
    (out_dir / "cosmetic-generic.css").write_text(css, encoding="utf-8")
    stats["generic-selectors"] = count
    index = c.site_index()
    (out_dir / "cosmetic-sites.json").write_text(
        json.dumps(index, separators=(",", ":")), encoding="utf-8"
    )
    stats["sites-with-selectors"] = len(index["specific"])
    stats["skipped"] = dict(c.skipped)
    return stats


# Entry point for moz.build GeneratedFile. The build opens the first output
# (compile-stats.json) and passes it in; the other outputs are written next to
# it. The inputs are already dependencies, so no extra ones are returned.
def generate(output, *list_paths):
    stats = compile_lists(Path(output.name).parent, list_paths)
    output.write(json.dumps(stats, indent=1, sort_keys=True) + "\n")
    return set()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    print(json.dumps(compile_lists(sys.argv[1], sys.argv[2:]), indent=1, sort_keys=True))
