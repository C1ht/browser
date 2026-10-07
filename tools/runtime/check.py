#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Runtime checks against a built browser-wip.

    python3 -I tools/runtime/check.py <dist/bin> [--part 1 2 3 4] [--shots DIR]

Starts the browser (headless, fresh profile, Marionette on a local port),
runs privileged JavaScript in its window and reports pass/fail per check.
Test pages are served from tests/runtime/pages on 127.0.0.1.
"""

import argparse
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marionette import Marionette  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PAGES = ROOT / "tests/runtime/pages"

RESULTS = []


def record(part, name, ok, detail=""):
    RESULTS.append((part, name, bool(ok), detail))
    mark = "ok  " if ok else "FAIL"
    print(f"{mark} [{part}] {name}" + (f" — {detail}" if detail and not ok else ""), flush=True)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve_pages():
    port = free_port()
    handler = functools.partial(QuietHandler, directory=str(PAGES))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}"


class Browser:
    def __init__(self, bindir, prefs=None, profile=None, args=()):
        self.profile = Path(profile or tempfile.mkdtemp(prefix="wip-profile-"))
        port = free_port()
        prefs = {
            # Marionette otherwise applies "recommended" automation prefs,
            # which would change the very settings under test.
            "remote.prefs.recommended": False,
            "marionette.port": port,
            **(prefs or {}),
        }
        with open(self.profile / "user.js", "a") as f:
            for k, v in prefs.items():
                f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
        env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
        self.log = open(self.profile / "browser.log", "w")
        self.proc = subprocess.Popen(
            [str(Path(bindir) / "browser-wip"), "--marionette", "--headless", "--no-remote",
             "--profile", str(self.profile), *args],
            stdout=self.log, stderr=subprocess.STDOUT, env=env,
        )
        self.m = Marionette(port, timeout=90)

    def js(self, script, *args):
        return self.m.js(script, *args)

    def wait(self, script, *args, timeout=30, interval=0.25):
        deadline = time.time() + timeout
        while True:
            value = self.js(script, *args)
            if value or time.time() > deadline:
                return value
            time.sleep(interval)

    def quit(self):
        self.m.quit()
        try:
            self.proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()

    def tail(self, n=30):
        return "\n".join(Path(self.profile / "browser.log").read_text(errors="replace").splitlines()[-n:])


IMPORTS = """
const { AppConstants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
const { PrivacyModes } = ChromeUtils.importESModule("resource://gre/modules/browserwip/PrivacyModes.sys.mjs");
const { ContentBlockingAllowList } = ChromeUtils.importESModule("resource://gre/modules/ContentBlockingAllowList.sys.mjs");
function pref(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Services.prefs.PREF_BOOL: return Services.prefs.getBoolPref(name);
    case Services.prefs.PREF_INT: return Services.prefs.getIntPref(name);
    case Services.prefs.PREF_STRING: return Services.prefs.getStringPref(name);
  }
  return null;
}
"""


# ---------------------------------------------------------------------------
# Part 1: scaffolding and build config


def part1(bindir, base):
    gecko = ROOT.parent / "mozilla-central"
    if (gecko / ".git").exists():
        status = subprocess.run(["git", "-C", str(gecko), "status", "--porcelain"],
                                capture_output=True, text=True).stdout.strip()
        record(1, "mozilla-central has no local changes", status == "", status[:300])

    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True})
    try:
        info = b.js(IMPORTS + """
          return {
            name: Services.appinfo.name, vendor: Services.appinfo.vendor, id: Services.appinfo.ID,
            version: Services.appinfo.version, gecko: Services.appinfo.platformVersion,
            windowType: document.documentElement.getAttribute("windowtype"),
            brand: Services.strings.createBundle("chrome://branding/locale/brand.properties")
                     .GetStringFromName("brandShortName"),
            crashreporter: !!AppConstants.MOZ_CRASHREPORTER, updater: !!AppConstants.MOZ_UPDATER,
            telemetry: !!AppConstants.MOZ_TELEMETRY_REPORTING, datareporting: !!AppConstants.MOZ_DATA_REPORTING,
            normandy: !!AppConstants.MOZ_NORMANDY, sync: !!AppConstants.MOZ_SERVICES_SYNC,
            eme: !!AppConstants.MOZ_WIDEVINE_EME,
            crashReporterService: "@mozilla.org/toolkit/crash-reporter;1" in Cc
              && Cc["@mozilla.org/toolkit/crash-reporter;1"].getService(Ci.nsICrashReporter).enabled,
            profileDir: Services.dirsvc.get("ProfD", Ci.nsIFile).path,
          };""")
        record(1, "app identity is browser-wip", info["name"] == "browser-wip" and info["brand"] == "browser-wip", info)
        record(1, "runs on the pinned Gecko release", info["gecko"].startswith("157."), info["gecko"])
        record(1, "main window opened", info["windowType"] == "navigator:browser", info["windowType"])
        for key in ["crashreporter", "updater", "telemetry", "datareporting", "normandy", "sync", "eme"]:
            record(1, f"built without {key}", info[key] is False, info[key])
        record(1, "crash reporter is not running", not info["crashReporterService"], info["crashReporterService"])
        record(1, "uses the requested profile", Path(info["profileDir"]) == b.profile, info["profileDir"])
    finally:
        b.quit()


# ---------------------------------------------------------------------------
# Part 2: default prefs and privacy modes

STANDARD_PREFS = {
    "network.cookie.cookieBehavior": 5,
    "privacy.trackingprotection.enabled": True,
    "privacy.fingerprintingProtection": True,
    "privacy.resistFingerprinting": False,
    "privacy.globalprivacycontrol.enabled": True,
    "privacy.query_stripping.enabled": True,
    "privacy.bounceTrackingProtection.mode": 1,
    "dom.security.https_first": True,
    "dom.security.https_only_mode": False,
    "media.peerconnection.enabled": True,
    "media.peerconnection.ice.obfuscate_host_addresses": True,
    "javascript.options.ion": True,
    "datareporting.healthreport.uploadEnabled": False,
    "browser.safebrowsing.malware.enabled": False,
    "dom.push.connection.enabled": False,
    "network.captive-portal-service.enabled": False,
    "network.trr.mode": 5,
    "security.OCSP.enabled": 0,
    "media.eme.enabled": False,
    "urlclassifier.trackingTable": "wip-ads-digest256,wip-track-digest256",
    "browserwip.search.engine": "brave",
}


def part2(bindir, base):
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True})
    try:
        prefs = b.js(IMPORTS + "return Object.fromEntries(arguments[0].map(n => [n, pref(n)]));",
                     list(STANDARD_PREFS))
        wrong = {k: prefs[k] for k, v in STANDARD_PREFS.items() if prefs[k] != v}
        record(2, f"{len(STANDARD_PREFS)} Standard-mode prefs have their intended values", not wrong, wrong)
        record(2, "privacy mode reads as Standard", b.js(IMPORTS + "return PrivacyModes.mode;") == "standard")

        policy = b.js("return [Services.policies.status, Services.policies.isAllowed('remoteSettings')];")
        record(2, "bundled policy disables Remote Settings",
               policy == [1, False], f"status, allowed = {policy}")  # 1 == ACTIVE

        tables = b.wait("""
          if (!Services.prefs.getStringPref("browserwip.contentblocking.listsVersion", "")) return null;
          let db = Cc["@mozilla.org/url-classifier/dbservice;1"].getService(Ci.nsIUrlClassifierDBService);
          return new Promise(r => db.getTables(r));""", timeout=60)
        names = sorted(line.split(";")[0] for line in (tables or "").splitlines() if line)
        record(2, "bundled blocklists loaded into the URL classifier",
               names == ["wip-ads-digest256", "wip-social-digest256", "wip-track-digest256"], names)

        # End to end: a page embedding a tracker and an ad network.
        url = f"{base}/blocking.html"
        b.js("gBrowser.addTab(arguments[0]);", url)
        title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('ad:') && t;", timeout=30)
        record(2, "ad slot hidden, page content visible", title == "ad:none content:block", title)
        log = b.wait("""
          return gBrowser.selectedBrowser.getContentBlockingLog().then(JSON.parse).then(log => {
            let blocked = Object.entries(log).filter(([, e]) => e.some(([, blocked]) => blocked)).map(([o]) => o);
            return blocked.length >= 2 && blocked;
          });""", timeout=15)
        record(2, "tracker and ad requests blocked",
               bool(log) and any("google-analytics" in o for o in log) and any("doubleclick" in o for o in log), log)
        count = b.js("return gBrowser.selectedTab.blockedTrackers;")
        record(2, "shield shows the blocked count", count and count >= 2, count)

        # Per-site switch turns both kinds of blocking off.
        b.js(IMPORTS + "ContentBlockingAllowList.add(gBrowser.selectedBrowser); gBrowser.selectedBrowser.reload();")
        time.sleep(1)
        title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('ad:') && t;", timeout=30)
        record(2, "turning protections off for a site shows its ads", title == "ad:block content:block", title)
        b.js(IMPORTS + "ContentBlockingAllowList.remove(gBrowser.selectedBrowser);")

        # Strict Privacy, live.
        strict = b.js(IMPORTS + """
          PrivacyModes.setMode("strict");
          let r = { mode: PrivacyModes.mode, httpsOnly: pref("dom.security.https_only_mode"),
                    ion: pref("javascript.options.ion"), noHost: pref("media.peerconnection.ice.no_host"),
                    fpp: pref("privacy.fingerprintingProtection.overrides"),
                    restart: PrivacyModes.pendingRestart };
          PrivacyModes.setMode("standard");
          r.after = PrivacyModes.mode;
          r.userPrefs = Services.prefs.getChildList("").filter(n => Services.prefs.prefHasUserValue(n)
            && /^(javascript\\.options|dom\\.security|media\\.peerconnection|privacy\\.)/.test(n));
          return r;""")
        record(2, "Strict Privacy applies live", strict["mode"] == "strict" and strict["httpsOnly"]
               and strict["ion"] is False and strict["noHost"] and "+WebGLVendorSanitize" in strict["fpp"], strict)
        record(2, "only the JIT change asks for a restart", strict["restart"] == ["jit"], strict["restart"])
        record(2, "returning to Standard leaves no overrides behind",
               strict["after"] == "standard" and not strict["userPrefs"], strict["userPrefs"])
    finally:
        b.quit()

    result = subprocess.run([str(ROOT / "tools/netsilence/run.sh"), bindir, "60"],
                            capture_output=True, text=True)
    record(2, "network silence: no outbound connections while idle", result.returncode == 0,
           (result.stdout + result.stderr)[-1500:])


# ---------------------------------------------------------------------------
# Part 3: first run

WELCOME = "let d = gBrowser.selectedBrowser.contentDocument; "


def part3(bindir, base, shots):
    b = Browser(bindir)
    try:
        url = b.wait("return gBrowser.selectedBrowser.currentURI?.spec == 'about:welcome' && "
                     "gBrowser.selectedBrowser.contentDocument?.getElementById('mode-standard') && 'about:welcome';")
        record(3, "a new profile opens the first-run screen", url == "about:welcome", url)
        state = b.wait(WELCOME + """
          let std = d.getElementById("mode-standard"), adv = d.getElementById("advanced");
          return std.getAttribute("aria-checked") == "true" && {
            standard: std.getAttribute("aria-checked"),
            strict: d.getElementById("mode-strict").getAttribute("aria-checked"),
            advancedOpen: adv.open, toggles: d.querySelectorAll(".toggle-row").length,
            heading: d.querySelector("h1").textContent };""")
        record(3, "Standard is preselected, Advanced collapsed",
               state and state["strict"] == "false" and state["advancedOpen"] is False and state["toggles"] == 4, state)
        if shots:
            b.m.screenshot(str(Path(shots) / "first-run.png"))

        # Strict, then fast JavaScript back on: a custom mix that needs no restart.
        mix = b.js(WELCOME + """
          d.getElementById("mode-strict").click();
          let strict = d.getElementById("mode-strict").getAttribute("aria-checked");
          let restartLabel = d.getElementById("continue").getAttribute("data-l10n-id");
          d.getElementById("toggle-jit").click();
          return { strict, restartLabel,
                   custom: !d.querySelector(".custom-note").hidden,
                   label: d.getElementById("continue").getAttribute("data-l10n-id"),
                   prefsUntouched: !Services.prefs.prefHasUserValue("dom.security.https_only_mode") };""")
        record(3, "choosing Strict selects it and offers a restart for JIT",
               mix["strict"] == "true" and mix["restartLabel"] == "welcome-continue-restart", mix)
        record(3, "flipping a switch shows Custom; nothing applied before Continue",
               mix["custom"] and mix["label"] == "welcome-continue" and mix["prefsUntouched"], mix)
        b.js(WELCOME + "d.getElementById('continue').click();")
        after = b.wait(IMPORTS + """
          return gBrowser.selectedBrowser.currentURI.spec == "about:newtab" && {
            mode: PrivacyModes.mode, httpsOnly: pref("dom.security.https_only_mode"),
            ion: pref("javascript.options.ion"), done: pref("browserwip.firstrun.completed") };""")
        record(3, "Continue applies the choice and opens a new tab",
               after and after["mode"] == "custom" and after["httpsOnly"] and after["ion"] and after["done"], after)
    finally:
        b.quit()

    # Escape: leaves without applying anything.
    b = Browser(bindir)
    try:
        b.wait(WELCOME + "return d?.getElementById('mode-strict');")
        b.js(WELCOME + """
          d.getElementById("mode-strict").click();
          d.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));""")
        after = b.wait(IMPORTS + """
          return gBrowser.selectedBrowser.currentURI.spec == "about:newtab" &&
            { mode: PrivacyModes.mode, done: pref("browserwip.firstrun.completed") };""")
        record(3, "Escape lands on Standard", after and after["mode"] == "standard" and after["done"], after)
    finally:
        b.quit()
    # And the screen doesn't come back.
    b = Browser(bindir, profile=b.profile)
    try:
        url = b.wait("return gBrowser.selectedBrowser.currentURI?.spec != 'about:blank' && "
                     "gBrowser.selectedBrowser.currentURI.spec;")
        record(3, "next launch skips the first-run screen", url == "about:newtab", url)
    finally:
        b.quit()


# ---------------------------------------------------------------------------
# Part 4: browser chrome and layout


def part4(bindir, base, shots):
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True,
                               "dom.disable_open_during_load": False})
    try:
        b.wait("return gBrowser.selectedBrowser.currentURI?.spec == 'about:newtab';")
        layout = b.js("""
          let r = id => document.getElementById(id).getBoundingClientRect();
          let tab = gBrowser.selectedTab.getBoundingClientRect();
          let page = getComputedStyle(document.getElementById("browsers")).backgroundColor;
          return { nav: r("nav-bar").top, strip: r("tab-strip").top, browsers: r("browsers").top,
                   tabBottom: tab.bottom, tabBg: getComputedStyle(gBrowser.selectedTab).backgroundColor,
                   page, focused: document.activeElement?.id };""")
        record(4, "tab strip sits below the address bar, above the page",
               layout["nav"] < layout["strip"] < layout["browsers"], layout)
        record(4, "selected tab joins the page (same color, no gap)",
               abs(layout["tabBottom"] - layout["browsers"]) < 1 and layout["tabBg"] == layout["page"], layout)
        record(4, "new tab focuses the address field", layout["focused"] == "urlbar-input", layout["focused"])

        # Typing an address.
        b.js("""
          gURLBar.input.focus(); gURLBar.input.value = arguments[0];
          gURLBar.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));""",
             base.removeprefix("http://") + "/target.html")
        title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('target') && t;")
        record(4, "typing an address loads it", bool(title), title)
        shown = b.js("""return { host: document.querySelector("#urlbar-display .host")?.textContent,
                       state: document.getElementById("identity-button").getAttribute("state"),
                       label: gBrowser.selectedTab.querySelector(".tab-label").textContent };""")
        record(4, "address field shows the host; tab shows the title",
               shown["host"] == "127.0.0.1" and shown["label"] == "target page, opener none", shown)
        record(4, "plain HTTP is marked not secure", shown["state"] == "insecure", shown["state"])

        # Typing words searches with the default engine.
        b.js("""gURLBar.input.focus(); gURLBar.input.value = "privacy browser";
                gURLBar.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));""")
        host = b.wait("let u = gBrowser.selectedBrowser.currentURI; return u.host == 'search.brave.com' && u.spec;")
        record(4, "typing words searches with Brave Search", bool(host) and "q=privacy%20browser" in host, host)

        # window.open() from a page (popup blocking is relaxed for the test
        # profile; the page opens target.html as soon as it loads).
        before = b.js("return gBrowser.tabs.length;")
        opened = b.js("""
          return new Promise(resolve => {
            gBrowser.tabContainer.addEventListener("TabOpen", e => resolve(gBrowser.tabs.indexOf(e.target)), { once: true });
            gBrowser.loadURL(gBrowser.selectedBrowser, arguments[0]);
            setTimeout(() => resolve(-1), 15000);
          });""", f"{base}/opener.html?auto")
        record(4, "window.open() from a page opens a tab next to it", opened == before,
               f"index {opened}, tabs before {before}")
        if opened >= 0:
            title = b.wait("let t = gBrowser.tabs[arguments[0]].linkedBrowser.contentTitle;"
                           " return t.startsWith('target') && t;", opened)
            record(4, "opened tab keeps its opener", title == "target page, opener kept", title)

        # Reorder by dragging the selected tab two places to the right.
        order = b.js("""
          while (gBrowser.tabs.length < 4) gBrowser.addTab("about:blank", { select: false });
          let tab = gBrowser.tabs[0]; gBrowser.selectTab(tab);
          let r = tab.getBoundingClientRect(), w = r.width, y = r.top + r.height / 2;
          let u = windowUtils, x = r.left + w / 2;
          u.sendMouseEvent("mousedown", x, y, 0, 1, 0);
          for (let i = 1; i <= 10; i++) u.sendMouseEvent("mousemove", x + (w * 2.2 * i) / 10, y, 0, 0, 0);
          u.sendMouseEvent("mouseup", x + w * 2.2, y, 0, 1, 0);
          return gBrowser.tabs.indexOf(tab);""")
        record(4, "dragging a tab reorders it", order == 2, f"dragged tab now at {order}")

        closed = b.js("""
          let n = gBrowser.tabs.length, i = gBrowser.tabs.indexOf(gBrowser.selectedTab);
          let right = gBrowser.tabs[i + 1];
          return gBrowser.removeTab(gBrowser.selectedTab, { skipPermitUnload: true })
            .then(() => ({ fewer: gBrowser.tabs.length == n - 1, selectedRight: gBrowser.selectedTab == right }));""")
        record(4, "closing a tab selects the one to its right", closed["fewer"] and closed["selectedRight"], closed)

        for mode, expected in [("dark", "rgb(21, 25, 28)"), ("light", "rgb(229, 233, 236)")]:
            got = b.js("""Services.prefs.setStringPref("browserwip.appearance", arguments[0]);
              return new Promise(r => setTimeout(() => r(getComputedStyle(document.documentElement).backgroundColor), 500));""", mode)
            record(4, f"{mode} appearance applies live", got == expected, got)
            if shots:
                b.js("gBrowser.selectTab(gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.includes('target')) ?? gBrowser.tabs[0]);")
                time.sleep(1)
                b.m.screenshot(str(Path(shots) / f"chrome-{mode}.png"))
        b.js("Services.prefs.clearUserPref('browserwip.appearance');")
    finally:
        b.quit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bindir")
    parser.add_argument("--part", type=int, nargs="*", default=[1, 2, 3, 4])
    parser.add_argument("--shots", help="directory for screenshots")
    args = parser.parse_args()
    if args.shots:
        Path(args.shots).mkdir(parents=True, exist_ok=True)
    base = serve_pages()
    parts = {1: lambda: part1(args.bindir, base), 2: lambda: part2(args.bindir, base),
             3: lambda: part3(args.bindir, base, args.shots), 4: lambda: part4(args.bindir, base, args.shots)}
    for p in args.part:
        try:
            parts[p]()
        except Exception as e:  # a crash in one part shouldn't hide the others
            record(p, "check run completed", False, repr(e))
    failed = [r for r in RESULTS if not r[2]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
