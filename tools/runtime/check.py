#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Runtime checks against a built browser-wip.

    python3 -I tools/runtime/check.py <dist/bin> [--part 1 2 3 4 5 6 7 8 9 10 11] [--shots DIR]

Starts the browser (headless, fresh profile, Marionette on a local port),
runs privileged JavaScript in its window and reports pass/fail per check.
Test pages are served from tests/runtime/pages on 127.0.0.1.
"""

import argparse
import base64
import functools
import re
import http.server
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from marionette import Marionette  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PAGES = ROOT / "tests/runtime/pages"

RESULTS = []
ALL_PARTS = list(range(1, 13))
# Headless Gecko (every check runs headless) can't do some things a real
# window can; those checks are skipped there and listed in
# docs/MANUAL-CHECKS.md for a headed run.
HEADLESS = True
# What fetch-test-deps.sh fetches: strace and gnome-keyring, unpacked.
TEST_DEPS = Path(os.environ.get("BWV_TEST_DEPS")
                 or Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "browser-wip/test-deps")


def record(part, name, ok, detail=""):
    RESULTS.append((part, name, "ok" if ok else "failed", detail))
    mark = "ok  " if ok else "FAIL"
    print(f"{mark} [{part}] {name}" + (f" — {detail}" if detail and not ok else ""), flush=True)


def skip(part, name, reason):
    RESULTS.append((part, name, "skipped", reason))
    print(f"SKIP [{part}] {name} — {reason}", flush=True)


def expected_headless_failure(part, name, ok, detail, reason):
    """A check headless Gecko can't pass: skipped there (with the reason),
    an ordinary check in a headed run."""
    if HEADLESS and not ok:
        skip(part, name, f"skipped (headless): {reason}")
    else:
        record(part, name, ok, detail)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


# Pages under /auth/ need HTTP Basic sign-in as wip:secret; /deny/ accepts
# nobody (part 6).
AUTH_HEADER = "Basic " + base64.b64encode(b"wip:secret").decode()


class PageHandler(QuietHandler):
    def do_GET(self):
        for prefix, realm in [("/auth/", "browser-wip check"), ("/deny/", "browser-wip deny")]:
            if self.path.startswith(prefix):
                break
        else:
            return super().do_GET()
        if prefix == "/auth/" and self.headers.get("Authorization") == AUTH_HEADER:
            body = b"<!doctype html><title>signed in</title>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
        else:
            body = b"<!doctype html><title>not signed in</title>"
            self.send_response(401)
            self.send_header("WWW-Authenticate", f'Basic realm="{realm}"')
            self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def serve_pages():
    port = free_port()
    handler = functools.partial(PageHandler, directory=str(PAGES))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{port}"


class Browser:
    def __init__(self, bindir, prefs=None, profile=None, args=(), env=None):
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
        env = {**{k: v for k, v in os.environ.items() if "proxy" not in k.lower()}, **(env or {})}
        self.log = open(self.profile / "browser.log", "w")
        exe = Path(bindir) / ("browser-wip.exe" if sys.platform == "win32" else "browser-wip")
        self.proc = subprocess.Popen(
            [str(exe), "--marionette", "--remote-allow-system-access", "--headless", "--no-remote",
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
        pinned = (ROOT / "GECKO_REVISION").read_text().split("version=")[1].split()[0]
        record(1, "runs on the pinned Gecko release", info["gecko"].startswith(pinned.split(".")[0] + "."),
               f"{info['gecko']} (pinned {pinned})")
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
    "privacy.resistFingerprinting.letterboxing": False,
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
    # The network blocker replaces the URL classifier's tables (part 7).
    "urlclassifier.trackingTable": "",
    "browserwip.search.engine": "brave",
}


def fingerprint(b, base):
    b.js("gBrowser.addTab(arguments[0]);", f"{base}/fingerprint.html")
    title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('fp:') && t;", timeout=30)
    b.js("gBrowser.removeTab(gBrowser.selectedTab);")
    return json.loads(title[3:])


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

        state = b.wait(BLOCKER_STATE + " return state == 'ready' && state;", timeout=30)
        record(2, "the network blocker is ready", state == "ready", b.js(BLOCKER_STATE + " return state;"))

        # End to end: a page embedding a tracker and an ad network.
        url = f"{base}/blocking.html"
        b.js("gBrowser.addTab(arguments[0]);", url)
        title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('ad:') && t;", timeout=30)
        record(2, "ad slot hidden, page content visible", title == "ad:none content:block", title)
        log = b.wait("""
          let log = JSON.parse(gBrowser.selectedBrowser.getContentBlockingLog() ?? "{}");
          let blocked = Object.entries(log).filter(([, e]) => e.some(([, blocked]) => blocked)).map(([o]) => o);
          return blocked.length >= 2 && blocked;""", timeout=15)
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
          // Only the prefs PrivacyModes manages; Gecko sets a few internal
          // migration flags of its own on first run.
          let managed = Object.values(PrivacyModes.TOGGLES).flatMap(t => Object.keys(t.strict ?? {}))
            .concat("privacy.fingerprintingProtection.overrides");
          r.userPrefs = managed.filter(n => Services.prefs.prefHasUserValue(n));
          return r;""")
        record(2, "Strict Privacy applies live", strict["mode"] == "strict" and strict["httpsOnly"]
               and strict["ion"] is False and strict["noHost"] and "JSDateTimeUTC" not in strict["fpp"], strict)
        record(2, "only the JIT change asks for a restart", strict["restart"] == ["jit"], strict["restart"])
        record(2, "returning to Standard leaves no overrides behind",
               strict["after"] == "standard" and not strict["userPrefs"], strict["userPrefs"])

        # What pages see: Standard hides device details only; Anonymous makes
        # the browser look like every other resistFingerprinting browser.
        fp = fingerprint(b, base)
        record(2, "the user agent is Firefox's", fp["ua"].endswith(" Firefox/" + fp["ua"].split("rv:")[1].split(")")[0]),
               fp["ua"])
        b.js(IMPORTS + """
          Services.prefs.setStringPref("browserwip.appearance", "dark");
          PrivacyModes.setMode("anonymous");""")
        anon = fingerprint(b, base)
        b.js(IMPORTS + """
          PrivacyModes.setMode("standard");
          Services.prefs.clearUserPref("browserwip.appearance");""")
        record(2, "Anonymous: UTC, English, light colors",
               anon["timeZone"] in ("UTC", "Atlantic/Reykjavik") and anon["languages"] == ["en-US", "en"]
               and anon["locale"] == "en-US" and anon["dark"] is False, anon)
        record(2, "Anonymous: the page size comes in letterbox steps",
               anon["innerWidth"] % 200 == 0 and anon["innerHeight"] % 100 == 0 and anon["innerWidth"] > 0
               and anon["innerHeight"] > 0, anon)
    finally:
        b.quit()

    if sys.platform.startswith("linux"):
        result = subprocess.run([str(ROOT / "tools/netsilence/run.sh"), bindir, "60"],
                                capture_output=True, text=True)
        record(2, "network silence: no outbound connections while idle", result.returncode == 0,
               (result.stdout + result.stderr)[-1500:])
    else:
        skip(2, "network silence: no outbound connections while idle", "needs strace (Linux only)")


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
                               "dom.disable_open_during_load": False,
                               # Gecko's fake camera and microphone; they only
                               # count as capturing with permission.fake.
                               "media.navigator.streams.fake": True,
                               "media.navigator.permission.fake": True})
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
        # This container has no internet, so the page itself fails to load;
        # what matters is where the browser sent the search.
        host = b.wait("let s = gBrowser.selectedBrowser.currentURI?.spec ?? ''; "
                      "return s.startsWith('https://search.brave.com/') && s;")
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

        # Reorder by dragging the first tab two places to the right.
        order = b.js("""
          while (gBrowser.tabs.length < 4) gBrowser.addTab("about:blank", { select: false });
          let tab = gBrowser.tabs[0]; gBrowser.selectTab(tab);
          let r = tab.getBoundingClientRect(), w = r.width, y = r.top + r.height / 2, x = r.left + w / 2;
          let fire = (target, type, cx) => target.dispatchEvent(new PointerEvent(type,
            { bubbles: true, clientX: cx, clientY: y, button: 0, buttons: type == "pointerup" ? 0 : 1,
              pointerId: 1, isPrimary: true, pointerType: "mouse" }));
          fire(tab.querySelector(".tab-label"), "pointerdown", x);
          for (let i = 1; i <= 10; i++) fire(window, "pointermove", x + (w * 2.2 * i) / 10);
          fire(window, "pointerup", x + w * 2.2);
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

        # Downloads: straight to the chosen folder, listed in the panel.
        target = tempfile.mkdtemp(prefix="wip-downloads-")
        tabs_before = b.js("""
          window.__tabEvents = { opened: 0, closed: 0 };
          gBrowser.tabContainer.addEventListener("TabOpen", () => window.__tabEvents.opened++);
          gBrowser.tabContainer.addEventListener("TabClose", () => window.__tabEvents.closed++);
          return gBrowser.tabs.length;""")
        b.js("""
          let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          dir.initWithPath(arguments[0]);
          Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, dir);
          Services.prefs.setIntPref("browser.download.folderList", 2);
          gBrowser.addTab(arguments[1]);""", target, f"{base}/download.html")
        item = b.wait("""
          let item = document.querySelector("#downloads-list .download");
          return item?.dataset.state == "done" && {
            button: !document.getElementById("downloads-button").hidden,
            panel: document.getElementById("downloads-panel").state,
            name: item.querySelector(".download-name").textContent,
            status: item.querySelector(".download-status").textContent };""", timeout=30)
        saved = Path(target, "download.bin")
        record(4, "a download is saved without asking and listed in the panel",
               bool(item) and item["button"] and item["name"] == "download.bin"
               and saved.exists() and saved.stat().st_size == 100000, item)
        # The page's own tab stays; the one its link opened for the file closes.
        tabs_after = b.wait("return gBrowser.tabs.length == arguments[0] && arguments[0];", tabs_before + 1, timeout=10)
        events = b.js("return window.__tabEvents;")
        record(4, "the tab opened only for the download closes",
               tabs_after == tabs_before + 1 and events == {"opened": 2, "closed": 1}, events)
        cleared = b.js("""
          document.getElementById("downloads-clear").click();
          document.getElementById("downloads-panel").hidePopup();
          return new Promise(r => setTimeout(() => r({
            items: document.querySelectorAll("#downloads-list .download").length,
            button: document.getElementById("downloads-button").hidden }), 1000));""")
        record(4, "clearing the list empties it and hides the button",
               cleared["items"] == 0 and cleared["button"], cleared)

        # Right-click menu on pages. Positions are fixed in contextmenu.html.
        b.js("gBrowser.addTab(arguments[0]);", f"{base}/contextmenu.html")
        b.wait("return gBrowser.selectedBrowser.contentTitle == 'context menu page';")
        b.js("gBrowser.selectedBrowser.focus();")
        visible = """let m = document.getElementById("content-context-menu");
          return m.state == "open" && [...m.children].filter(i => !i.hidden && i.id).map(i => i.id);"""
        def context_menu(x, y, command=None):
            b.m.right_click(x, y)
            items = b.wait(visible, timeout=5)
            if command:
                b.js("document.getElementById(arguments[0]).doCommand();", command)
            b.js("document.getElementById('content-context-menu').hidePopup();")
            time.sleep(0.3)
            return items
        menus = {name: context_menu(x, y) for name, (x, y) in
                 {"link": (25, 28), "image": (40, 90), "field": (30, 160), "page": (60, 350)}.items()}
        expected = {
            "link": ["context-openlink-tab", "context-openlink-window", "context-copylink", "context-savelink"],
            "image": ["context-openimage", "context-copyimage", "context-copyimage-link", "context-saveimage"],
            "field": ["context-undo", "context-cut", "context-copy-edit", "context-paste", "context-delete",
                      "context-selectall"],
            "page": ["context-back", "context-forward", "context-reload", "context-selectall",
                     "context-savepage", "context-viewsource"],
        }
        record(4, "right-click menus fit what was clicked (link, image, field, page)", menus == expected, menus)

        context_menu(25, 28, "context-copylink")
        copied = b.js("""let t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
          t.init(null); t.addDataFlavor("text/plain");
          Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard);
          let d = {}; t.getTransferData("text/plain", d);
          return d.value.QueryInterface(Ci.nsISupportsString).data;""")
        record(4, "Copy link copies the link's address", copied == f"{base}/target.html", copied)

        tabs = b.js("return gBrowser.tabs.length;")
        context_menu(25, 28, "context-openlink-tab")
        opened = b.wait("""let [count, expected] = arguments;
          let spec = gBrowser.tabs.length == count + 1 &&
            gBrowser.tabs[gBrowser.tabs.indexOf(gBrowser.selectedTab) + 1].linkedBrowser.currentURI.spec;
          return spec == expected && spec;""", tabs, f"{base}/target.html", timeout=15)
        record(4, "Open link in new tab opens it next to the page, in the background",
               opened == f"{base}/target.html", opened)

        # Middle-click and Ctrl+click on the same link do the same.
        for name, button, modifiers in [("Middle-click", 1, ()), ("Ctrl+click", 0, ("CONTROL",))]:
            page = b.js("""window.__opened = null; window.__page = gBrowser.selectedTab;
              gBrowser.tabContainer.addEventListener("TabOpen", e => window.__opened = e.target, { once: true });
              return gBrowser.selectedBrowser.currentURI.spec;""")
            b.m.click(25, 28, button, modifiers)
            got = b.wait("""let [target, page] = arguments, tab = window.__opened, from = window.__page;
              return tab?.linkedBrowser.currentURI.spec == target && {
                background: gBrowser.selectedTab == from,
                pageStays: from.linkedBrowser.currentURI.spec == page,
                besidePage: gBrowser.tabs.indexOf(tab) > gBrowser.tabs.indexOf(from) };""",
                         f"{base}/target.html", page, timeout=15)
            record(4, f"{name} on a link opens it in a background tab next to the page",
                   bool(got) and all(got.values()), got)

        b.js("""Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString("pasted");""")
        context_menu(30, 160, "context-paste")
        title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('field') && t;", timeout=5)
        record(4, "Paste puts the clipboard into the field", bool(title) and "pasted" in title, title)

        # Saving, without the file picker the menu would show.
        saved_dir = tempfile.mkdtemp(prefix="wip-save-")
        b.js("""
          let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          dir.initWithPath(arguments[0]);
          Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, dir);""", saved_dir)
        b.m.right_click(25, 28)
        b.wait(visible, timeout=5)
        b.js("""let { data } = BrowserContextMenu;
          ContentAreaUtilsScope.saveURL(data.linkURL, null, null, "SaveLinkTitle", false, true,
            E10SUtils.deserializeReferrerInfo(data.referrerInfo),
            E10SUtils.deserializeCookieJarSettings(data.cookieJarSettings), null, false, data.principal);
          document.getElementById("content-context-menu").hidePopup();""")
        saved = b.wait("""return [...document.querySelectorAll("#downloads-list .download")]
          .some(d => d.dataset.state == "done" && d.querySelector(".download-name").textContent == "target.html");""",
                       timeout=15)
        record(4, "Save link saves through the downloads manager",
               bool(saved) and Path(saved_dir, "target.html").exists(), sorted(os.listdir(saved_dir)))

        # Tab overview.
        b.js("document.getElementById('cmd_tabOverview').doCommand();")
        overview = b.wait("""let cards = [...document.querySelectorAll("#tab-overview-grid .overview-card")];
          let tabCards = cards.filter(c => c.tab);
          return !document.getElementById("tab-overview").hidden && tabCards.length == gBrowser.tabs.length &&
            tabCards.every(c => c.querySelector("canvas") || c.tab.pendingLoad) && {
              cards: cards.length, tabs: gBrowser.tabs.length,
              selected: tabCards.find(c => c.hasAttribute("selected"))?.tab == gBrowser.selectedTab };""", timeout=15)
        record(4, "the tab overview shows every tab with a snapshot, and the current one marked",
               bool(overview) and overview["cards"] == overview["tabs"] + 1 and overview["selected"], overview)
        chosen = b.js("""let search = document.getElementById("tab-overview-search");
          search.value = "contextmenu.html"; search.dispatchEvent(new Event("input"));
          let shown = [...document.querySelectorAll("#tab-overview-grid .overview-card:not([hidden])")].filter(c => c.tab).length;
          search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          return { shown, closed: document.getElementById("tab-overview").hidden,
                   url: gBrowser.selectedBrowser.currentURI.spec };""")
        record(4, "searching the overview and pressing Enter switches to the match",
               chosen["shown"] == 1 and chosen["closed"]
               and chosen["url"].endswith("/contextmenu.html"), chosen)
        closed = b.js("""document.getElementById("cmd_tabOverview").doCommand();
          let before = gBrowser.tabs.length;
          let card = [...document.querySelectorAll("#tab-overview-grid .overview-card")].find(c => c.tab && !c.hasAttribute("selected"));
          card.focus();
          card.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
          return new Promise(resolve => setTimeout(() => {
            let after = gBrowser.tabs.length;
            let focusedCard = !!document.activeElement?.closest(".overview-card");
            document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            resolve({ before, after, focusedCard, hidden: document.getElementById("tab-overview").hidden });
          }, 1000));""")
        record(4, "Delete closes a tab from the overview; Escape closes the overview",
               closed["after"] == closed["before"] - 1 and closed["focusedCard"] and closed["hidden"], closed)

        b.js("TabOverview.open();")
        ring = b.js("""let other = gBrowser.tabs.find(t => t != gBrowser.selectedTab);
          gBrowser.selectTab(other);
          let ringed = [...document.querySelectorAll("#tab-overview-grid .overview-card[selected]")];
          return ringed.length == 1 && ringed[0].tab == other;""")
        record(4, "selecting another tab while the overview is open moves its ring", ring is True, ring)
        added = b.js("""let before = gBrowser.tabs.length;
          document.querySelector("#tab-overview-grid .overview-new").click();
          return { added: gBrowser.tabs.length - before, open: !document.getElementById("tab-overview").hidden,
                   cards: document.querySelectorAll("#tab-overview-grid .overview-card").length - 1,
                   tabs: gBrowser.tabs.length };""")
        b.js("TabOverview.close();")
        record(4, "adding a tab from the overview keeps it open, with a card for the new tab",
               added["added"] == 1 and added["open"] and added["cards"] == added["tabs"], added)

        b.js("""TabOverview.open(); let s = document.getElementById("tab-overview-search");
          s.value = "no such tab anywhere"; s.dispatchEvent(new Event("input"));""")
        r = b.wait("""let e = document.getElementById("tab-overview-empty");
          return !e.hidden && e.textContent && { text: e.textContent, newHidden: document.querySelector("#tab-overview-grid .overview-new").hidden };""",
                   timeout=5)
        record(4, "an overview search that matches nothing says so", bool(r) and "no such tab anywhere" in r["text"] and r["newHidden"], r)
        r = b.js("""let s = document.getElementById("tab-overview-search"); s.value = ""; s.dispatchEvent(new Event("input"));
          let before = gBrowser.tabs.length;
          let card = [...document.querySelectorAll("#tab-overview-grid .overview-card")].find(c => c.tab && !c.hasAttribute("selected"));
          let rect = card.getBoundingClientRect();
          for (let type of ["mousedown", "mouseup"]) {
            window.synthesizeMouseEvent(type, rect.left + 40, rect.top + 40, { button: 1, clickCount: 1 });
          }
          return new Promise(done => setTimeout(() => done({ before, after: gBrowser.tabs.length, gone: !card.isConnected,
            cards: document.querySelectorAll("#tab-overview-grid .overview-card").length - 1 }), 600));""")
        record(4, "middle-click on a card closes its tab; the card leaves",
               r["after"] == r["before"] - 1 and r["gone"] and r["cards"] == r["after"], r)
        r = b.js("""let target = gBrowser.tabs.find(t => t != gBrowser.selectedTab);
          let rect = target.getBoundingClientRect();
          for (let type of ["mousedown", "mouseup"]) {
            window.synthesizeMouseEvent(type, rect.left + 30, rect.top + rect.height / 2, { button: 0, clickCount: 1 });
          }
          return { closed: !TabOverview.isOpen, selected: gBrowser.selectedTab == target };""")
        record(4, "clicking a tab in the tab strip closes the overview and goes to that tab", r["closed"] and r["selected"], r)
        b.js("TabOverview.close();")

        # More tabs than fit: the strip scrolls.
        b.js("""window.__extraTabs = [];
          for (let i = 0; i < 24; i++) {
            __extraTabs.push(gBrowser.addTab("about:blank", { select: false,
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));
          }""")
        r = b.wait("let s = gBrowser.tabContainer; return s.hasAttribute('overflowing') && s.hasAttribute('more-after') && "
                   "!s.hasAttribute('more-before') && s.scrollLeft == 0;", timeout=5)
        record(4, "with more tabs than fit, the tab strip scrolls, and its end fades", bool(r), r)
        r = b.js("""let s = gBrowser.tabContainer, rect = s.getBoundingClientRect();
          window.windowUtils.sendWheelEvent(rect.left + rect.width / 2, rect.top + rect.height / 2, 0, 3, 0,
            WheelEvent.DOM_DELTA_LINE, 0, 0, 3, 0);
          return new Promise(done => setTimeout(() => done({ left: s.scrollLeft, before: s.hasAttribute("more-before") }), 800));""")
        record(4, "the mouse wheel scrolls it sideways; then the start fades too", r["left"] > 0 and r["before"], r)
        r = b.js("""gBrowser.selectTab(gBrowser.tabs.at(-1));
          return new Promise(done => setTimeout(() => {
            let s = gBrowser.tabContainer.getBoundingClientRect(), t = gBrowser.selectedTab.getBoundingClientRect();
            done({ inside: t.left >= s.left && t.right <= s.right, after: gBrowser.tabContainer.hasAttribute("more-after") });
          }, 800));""")
        record(4, "selecting a tab out of view scrolls to it", r["inside"] and not r["after"], r)
        r = b.js("""let first = gBrowser.tabs[0]; gBrowser.setPinned(first, true);
          gBrowser.tabContainer.scrollLeft = 0;
          return new Promise(done => setTimeout(() => {
            gBrowser.tabContainer.scrollLeft = gBrowser.tabContainer.scrollWidth;
            setTimeout(() => {
              let s = gBrowser.tabContainer.getBoundingClientRect(), t = first.getBoundingClientRect();
              let result = { offset: Math.round(t.left - s.left), visible: t.right <= s.right };
              gBrowser.setPinned(first, false);
              done(result);
            }, 300);
          }, 300));""")
        record(4, "a pinned tab stays at the start while the others scroll", r["visible"] and 0 <= r["offset"] <= 16, r)
        b.js("for (let t of __extraTabs) gBrowser.removeTab(t, { skipPermitUnload: true });")
        b.wait("return !gBrowser.tabContainer.hasAttribute('overflowing');", timeout=5)

        # Fullscreen: a page's own button (a video's), and a player embedded
        # from another site, which asks from its own process.
        for name, page, (x, y) in [("a page", "fullscreen.html", (40, 40)),
                                   ("an embedded player", "fullscreen-embed.html", (40, 140))]:
            b.js("gBrowser.addTab(arguments[0]);", f"{base}/{page}")
            b.wait("return gBrowser.selectedBrowser.contentTitle == 'fullscreen off';")
            time.sleep(0.5)
            b.m.click(x, y)
            entered = b.wait("""let shown = id => getComputedStyle(document.getElementById(id)).display != "none";
              let text = document.getElementById("fullscreen-warning-text").textContent;
              return gBrowser.selectedBrowser.contentTitle == "fullscreen on" &&
                document.fullscreenElement == gBrowser.selectedBrowser && text.includes("127.0.0.1") && {
                  barsHidden: !shown("nav-bar") && !shown("tab-strip"),
                  warning: document.getElementById("fullscreen-warning").hasAttribute("shown"), text };""", timeout=15)
            if not entered:
                entered = b.js("return gBrowser.selectedBrowser.contentTitle;")
            ok = isinstance(entered, dict) and entered["barsHidden"] and entered["warning"]
            if name == "an embedded player":
                # The click lands in the frame's process, whose fullscreen
                # request headless Gecko doesn't grant (no real widget to go
                # fullscreen with); the page's own button works.
                expected_headless_failure(
                    4, f"{name} can go fullscreen, with the bars hidden and the site named", ok, entered,
                    "a cross-process frame's fullscreen request isn't granted without a real window")
            else:
                record(4, f"{name} can go fullscreen, with the bars hidden and the site named", ok, entered)
            b.js("FullScreen.exitDomFullScreen();")
            left = b.wait("""return gBrowser.selectedBrowser.contentTitle == "fullscreen off" && !document.fullscreenElement &&
                !document.documentElement.hasAttribute("inDOMFullscreen") &&
                getComputedStyle(document.getElementById("nav-bar")).display != "none";""", timeout=15)
            record(4, f"leaving fullscreen ({name}) brings the bars back", bool(left), left)

        # Site icons: a declared <link rel="icon">, and /favicon.ico otherwise.
        b.js("let [base] = arguments; gBrowser.addTab(base + '/icon.html'); gBrowser.addTab(base + '/target.html');", base)
        icons = b.wait("""let tab = name => gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith(name));
          let declared = tab("/icon.html")?.favicon, fallback = tab("/target.html")?.favicon;
          return declared && fallback && { declared: declared.slice(0, 22), fallback: fallback.slice(0, 25),
            shown: tab("/icon.html").querySelector(".tab-icon").hasAttribute("favicon") };""", timeout=15)
        record(4, "tabs show the page's declared icon, or the site's favicon.ico",
               bool(icons) and icons["declared"] == "data:image/png;base64," and
               icons["fallback"].startswith("data:image/") and icons["shown"], icons)
        cleared = b.js("""let tab = gBrowser.tabs.find(t => t.linkedBrowser.currentURI.spec.endsWith("/icon.html"));
          tab.linkedBrowser.loadURI(Services.io.newURI("about:blank"),
            { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
          return new Promise(r => setTimeout(() => r(tab.favicon ?? null), 1500));""")
        record(4, "leaving a page clears its icon", cleared is None, cleared)

        # Permission prompts. Buttons are at fixed positions in permissions.html.
        b.js("gBrowser.addTab(arguments[0]);", f"{base}/permissions.html")
        b.wait("return gBrowser.selectedBrowser.contentTitle == 'permissions page';")

        def click(x, y):
            b.js("""let [x, y] = arguments; let r = gBrowser.selectedBrowser.getBoundingClientRect();
              for (let type of ["mousedown", "mouseup"]) {
                window.synthesizeMouseEvent(type, r.left + x, r.top + y, { button: 0, clickCount: 1 });
              }""", x, y)

        def page_title(prefix):
            return b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith(arguments[0]) && t;",
                          prefix, timeout=15)

        prompt = """let p = document.getElementById("permission-panel"); return p.state == "open" && {
          message: document.getElementById("permission-message").textContent,
          video: !document.getElementById("permission-video-row").hidden,
          audio: !document.getElementById("permission-audio-row").hidden };"""
        answer = """let [allow, remember] = arguments;
          document.getElementById("permission-remember").checked = remember;
          document.getElementById(allow ? "permission-allow" : "permission-block").click();"""

        click(60, 155)
        record(4, "video calls can connect (WebRTC connections are allowed)", page_title("pc") == "pc offer",
               b.js("return gBrowser.selectedBrowser.contentTitle;"))

        click(60, 35)
        shown = b.wait(prompt, timeout=10)
        b.js(answer, False, False)
        record(4, "a location request prompts, and Block refuses it",
               bool(shown) and "location" in shown["message"] and page_title("geo") == "geo error 1", shown)

        click(60, 75)
        shown = b.wait(prompt, timeout=10)
        b.js(answer, True, True)
        granted = page_title("notify")
        stored = b.js("""return Services.perms.testExactPermissionFromPrincipal(
          gBrowser.selectedBrowser.contentPrincipal, "desktop-notification") == Services.perms.ALLOW_ACTION;""")
        click(60, 75)
        time.sleep(1)
        again = b.js("return [document.getElementById('permission-panel').state, gBrowser.selectedBrowser.contentTitle];")
        record(4, "allowing notifications with Remember stores it; the site isn't asked again",
               bool(shown) and granted == "notify granted" and stored and again == ["closed", "notify granted"],
               [shown, granted, stored, again])
        b.js("Services.perms.removeAll();")

        b.js("gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]), "
             "{triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()});",
             f"{base}/permissions.html?spam")
        spam = page_title("spam")
        record(4, "notification requests without a click are refused without a prompt",
               # Gecko itself answers "default" for requests without a click.
               spam in ("spam default", "spam denied")
               and b.js("return document.getElementById('permission-panel').state;") == "closed",
               spam)

        click(60, 115)
        shown = b.wait(prompt, timeout=10)
        b.js(answer, True, False)
        stream = page_title("gum")
        sharing = b.wait("""return gBrowser.selectedTab.hasAttribute("sharing") &&
          !document.getElementById("sharing-button").hidden;""", timeout=10)
        record(4, "camera and microphone: one prompt with both devices, then the sharing indicator",
               bool(shown) and shown["video"] and shown["audio"] and stream == "gum audio+video" and bool(sharing),
               [shown, stream, sharing])
        b.js("document.getElementById('sharing-button').click();")
        b.wait("return document.getElementById('sharing-panel').state == 'open';", timeout=5)
        b.js("document.getElementById('sharing-stop').click();")
        ended = page_title("gum ended")
        cleared = b.wait("""return !gBrowser.selectedTab.hasAttribute("sharing") &&
          document.getElementById("sharing-button").hidden;""", timeout=10)
        record(4, "Stop sharing ends the stream and clears the indicator",
               ended == "gum ended" and bool(cleared), [ended, cleared])
    finally:
        b.quit()


# ---------------------------------------------------------------------------
# Part 5: session restore

# The tabs of the window with the most tabs (Marionette may be attached to
# another one).
TABS = """let win = [...Services.wm.getEnumerator("navigator:browser")]
  .sort((a, b) => b.gBrowser.tabs.length - a.gBrowser.tabs.length)[0];
return win.gBrowser.tabs.map(t => ({
  url: t.pendingLoad?.url ?? t.linkedBrowser.currentURI.spec, pending: !!t.pendingLoad,
  pinned: t.hasAttribute("pinned"), selected: t == win.gBrowser.selectedTab }));"""
WINDOWS = """return [...Services.wm.getEnumerator("navigator:browser")].map(w => w.gBrowser.tabs.length);"""


def part5(bindir, base):
    profile = tempfile.mkdtemp(prefix="wip-session-")

    def start(**prefs):
        b = Browser(bindir, profile=profile, prefs={"browserwip.firstrun.completed": True, **prefs})
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        b.wait(WINDOWS.replace("return", "let n =") + " return n.length && n.every(c => c > 0);", timeout=15)
        return b

    # A session: a pinned tab, two others, and a second window.
    b = start(**{"browserwip.startup.restoreSession": True})
    b.js("""let [base] = arguments;
      let load = (browser, url) => browser.loadURI(Services.io.newURI(url),
        { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
      load(gBrowser.selectedBrowser, base + "/target.html");
      gBrowser.addTab(base + "/contextmenu.html", { pinned: true });
      gBrowser.addTab(base + "/permissions.html");
      BrowserWip.openNewWindow(base + "/target.html");""", base)
    b.wait("""let wins = [...Services.wm.getEnumerator("navigator:browser")];
      return wins.length == 2 && wins.every(w => w.gBrowser?.tabs.every(t => t.linkedBrowser.contentTitle));""",
           timeout=20)
    b.quit()
    saved = json.loads(Path(profile, "sessionstore.json").read_text())
    record(5, "quitting saves every window's tabs as a clean exit",
           saved["cleanExit"] and sorted(len(w["tabs"]) for w in saved["windows"]) == [1, 3], saved)

    b = start()
    tabs = b.js(TABS)
    windows = b.wait(WINDOWS.replace("return", "let n =") + " return n.length == 2 && n;", timeout=15)
    record(5, "Continue where you left off brings back windows, tabs, pinning and selection",
           [t["url"] for t in tabs] == [f"{base}/contextmenu.html", f"{base}/target.html", f"{base}/permissions.html"]
           and tabs[0]["pinned"] and tabs[2]["selected"] and sorted(windows or []) == [1, 3], [tabs, windows])
    record(5, "only the selected tab loads; the others wait",
           [t["pending"] for t in tabs] == [True, True, False], tabs)
    b.js(TABS.split("return")[0] + "win.gBrowser.selectTab(win.gBrowser.tabs[1]);")
    loaded = b.wait(TABS.split("return")[0] + "let tab = win.gBrowser.selectedTab; "
                    "return tab.linkedBrowser.contentTitle.startsWith('target') && !tab.pendingLoad;", timeout=15)
    record(5, "a waiting tab loads when selected", bool(loaded))
    b.quit()

    b = start(**{"browserwip.startup.restoreSession": False})
    first = b.js(TABS)
    enabled = b.js("""let menu = document.getElementById("app-menu"); menu.openPopup();
      return new Promise(r => setTimeout(() => {
        let enabled = !document.getElementById("cmd_restoreSession").hasAttribute("disabled");
        menu.hidePopup(); r(enabled); }, 300));""")
    b.js("document.getElementById('cmd_restoreSession').doCommand();")
    restored = b.wait(WINDOWS.replace("return", "let n =") + " return n.length == 2 && n;", timeout=15)
    record(5, "Open a new tab starts fresh; Restore previous session brings the tabs back",
           [t["url"] for t in first] == ["about:newtab"] and enabled and sorted(restored or []) == [1, 3],
           [first, enabled, restored])
    time.sleep(4)  # let the restored session be saved
    b.proc.kill()
    b.proc.wait()

    b = start()
    windows = b.wait(WINDOWS.replace("return", "let n =") + " return n.length == 2 && n;", timeout=15)
    record(5, "after a crash the session comes back even when set to open a new tab",
           sorted(windows or []) == [1, 3], windows)
    b.quit()


# ---------------------------------------------------------------------------
# Part 6: Firefox's password manager is off; HTTP sign-in still works

SIGNON_OFF = {
    "signon.rememberSignons": False,
    "signon.autofillForms": False,
    "signon.generation.enabled": False,
    "signon.formlessCapture.enabled": False,
    "signon.privateBrowsingCapture.enabled": False,
    "signon.backup.enabled": False,
    "signon.includeOtherSubdomainsInLookup": False,
    "signon.schemeUpgrades": False,
}

# HTTP sign-in dialogs are toolkit's window-modal commonDialog, since this
# browser has no tab-modal prompts. Marionette dismisses a window-modal dialog
# it finds open before running a command (WebDriver's user prompt handling),
# so each one is answered from inside the browser as it loads, with the next
# queued [user, password] (none left: cancel). window.__auth.seen keeps what
# each dialog showed.
AUTH_ANSWERER = """window.__auth = { seen: [], answers: arguments[0] };
if (!window.__authObserver) {
  window.__authObserver = win => {
    if (win.location.href != "chrome://global/content/commonDialog.xhtml") {
      return;
    }
    let doc = win.document;
    window.__auth.seen.push({ text: doc.getElementById("infoBody").textContent,
      login: !doc.getElementById("loginContainer")?.hidden });
    let [user, password] = window.__auth.answers.shift() ?? [];
    if (user == null) {
      doc.getElementById("commonDialog").cancelDialog();
      return;
    }
    doc.getElementById("loginTextbox").value = user;
    doc.getElementById("password1Textbox").value = password;
    doc.getElementById("commonDialog").acceptDialog();
  };
  Services.obs.addObserver(window.__authObserver, "common-dialog-loaded");
}"""


def part6(bindir, base):
    # Console messages from chrome and pages go to the log, to look for
    # errors from code that expects toolkit's password manager.
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True,
                               "devtools.console.stdout.chrome": True,
                               "devtools.console.stdout.content": True})
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        wrong = b.js(IMPORTS + "let [want] = arguments; return Object.entries(want)"
                     ".filter(([k, v]) => pref(k) !== v).map(([k]) => [k, pref(k)]);", SIGNON_OFF)
        record(6, "Firefox's password manager prefs are off", not wrong, wrong)

        def open_tab(url, title):
            b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0]));", url)
            return b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith(arguments[0]) && t;",
                          title, timeout=15)

        open_tab(f"{base}/forms.html", "forms page")
        actor = b.js("""return gBrowser.selectedBrowser.browsingContext.currentWindowGlobal
          .getActor("LoginManager").constructor.name;""")
        record(6, "toolkit's LoginManager actor is replaced by the inert one", actor == "LoginManagerStubParent", actor)

        # Form history still saves typed (here: pasted) text, which needs the
        # LoginManager actor to exist; and a password field takes focus
        # without errors.
        b.js("gBrowser.selectedBrowser.focus();")
        b.js("""Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper)
          .copyString("wip-history-check");""")
        b.m.right_click(30, 30)
        b.wait("return document.getElementById('content-context-menu').state == 'open';", timeout=5)
        b.js("document.getElementById('context-paste').doCommand();"
             "document.getElementById('content-context-menu').hidePopup();")
        pasted = b.wait("return gBrowser.selectedBrowser.contentTitle == 'forms page q wip-history-check';",
                        timeout=5)
        b.m.click(30, 70)
        focused = b.wait("return gBrowser.selectedBrowser.contentTitle == 'forms page pw focused';", timeout=5)
        time.sleep(0.5)
        b.m.click(30, 110)
        submitted = b.wait("return gBrowser.selectedBrowser.contentTitle.startsWith('target page');", timeout=15)
        saved = b.wait("""const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
          return FormHistory.count({ fieldname: "wipq", value: "wip-history-check" });""", timeout=10)
        record(6, "form history is still saved when a form with a password field is submitted",
               pasted and focused and submitted and saved == 1, [pasted, focused, submitted, saved])

        # HTTP Basic: a dialog names the site; signing in loads the page.
        b.js(AUTH_ANSWERER, [["wip", "secret"]])
        b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0]));", f"{base}/auth/")
        title = b.wait("return gBrowser.selectedBrowser.contentTitle == 'signed in';", timeout=15)
        shown = b.js("return window.__auth.seen[0];")
        record(6, "HTTP Basic sign-in prompts with the site's name and signs in",
               bool(shown) and "127.0.0.1" in shown["text"] and shown["login"] and bool(title),
               [shown, b.js("return gBrowser.selectedBrowser.contentTitle;")])

        # Cancelling twice in a tab stops further prompts from that site there.
        b.js(AUTH_ANSWERER, [])
        b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0]));", f"{base}/deny/1")
        prompts = []
        for i in range(3):
            if i:
                b.js("gBrowser.selectedBrowser.loadURI(Services.io.newURI(arguments[0]),"
                     "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });",
                     f"{base}/deny/{i + 1}")
            shown = b.wait("return window.__auth.seen.length > arguments[0];", i, timeout=5 if i == 2 else 15)
            prompts.append(bool(shown))
            if shown:
                b.wait("""return ![...Services.wm.getEnumerator(null)].some(w =>
                  w.location.href == "chrome://global/content/commonDialog.xhtml");""", timeout=5)
        record(6, "a site whose sign-in prompt is cancelled twice gets no third", prompts == [True, True, False],
               prompts)

        loaded = b.js("""return ["LoginManagerParent", "LoginManagerAuthPrompter", "storage-json", "storage-rust",
          "LoginManager"].filter(m => Cu.isESModuleLoaded(`resource://gre/modules/${m}.sys.mjs`));""")
        record(6, "none of Firefox's password manager loaded in the browser process", loaded == [], loaded)
    finally:
        b.quit()
    files = [f for f in ("logins.json", "logins.db", "logins-backup.json") if (b.profile / f).exists()]
    record(6, "no Firefox login store in the profile", not files, files)
    errors = [line for line in (b.profile / "browser.log").read_text(errors="replace").splitlines()
              if re.search(r"LoginManager(?!Stub)|Delegation to password manager|authentication prompt failed", line)]
    record(6, "no errors from code expecting Firefox's password manager", not errors, errors[:5])


# ---------------------------------------------------------------------------
# Part 7: the network blocker (adblock-rust through toolkit's FFI)
#
# Requests go through a local HTTP proxy that answers for every host, so the
# tests can use real hosts from the lists without the network. Which requests
# were cancelled is read from the parent's own HTTP observers.

BLOCKER_CASES = ROOT / "tests/blocker"
REASON_TRACKING = 2004  # nsILoadInfo.BLOCKING_REASON_CLASSIFY_TRACKING_URI
REASON_SOCIALTRACKING = 2009  # BLOCKING_REASON_CLASSIFY_SOCIALTRACKING_URI


class ProxyHandler(http.server.BaseHTTPRequestHandler):
    """An HTTP proxy that answers every request itself.

    /__run?g=NAME and /__frame?g=NAME on any host are pages that make the
    requests of a group of cases; /__redirect?to=URL redirects; anything
    else is an empty 200 that any origin may read.
    """

    groups = {}

    def log_message(self, *args):
        pass

    def do_GET(self):
        self.answer()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.answer()

    def answer(self):
        url = urllib.parse.urlsplit(self.path)
        query = urllib.parse.parse_qs(url.query)
        status, headers, body = 200, {"Content-Type": "text/plain"}, b""
        if url.path in ("/__run", "/__frame") and query.get("g", [""])[0] in self.groups:
            headers["Content-Type"] = "text/html; charset=utf-8"
            body = runner_page(self.groups[query["g"][0]]).encode()
        elif url.path == "/__redirect":
            status, headers["Location"] = 302, query["to"][0]
        self.send_response(status)
        for k, v in {**headers, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
                     "Content-Length": str(len(body))}.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)


RUNNER = """<!doctype html><meta charset="utf-8"><title>running</title><body><script>
// Scripts report whether they loaded: the proxy answers every request, so
// only a cancelled one fails. The title becomes "ran", then "ran {results}".
const scripts = {};
let pending = 0;
const settle = (url, outcome) => {
  scripts[url] = outcome;
  if (--pending == 0) document.title = "ran " + JSON.stringify(scripts);
};
for (const c of ITEMS) {
  try {
    switch (c.kind) {
      case "script": { let s = document.createElement("script"); s.src = c.url; pending++;
        s.onload = () => settle(c.url, "load"); s.onerror = () => settle(c.url, "error");
        document.head.append(s); break; }
      case "image": new Image().src = c.url; break;
      case "stylesheet": { let l = document.createElement("link"); l.rel = "stylesheet"; l.href = c.url;
        document.head.append(l); break; }
      case "xhr": { let x = new XMLHttpRequest(); x.open("GET", c.url); x.send(); break; }
      case "fetch": fetch(c.url, { mode: "no-cors" }).catch(() => {}); break;
      case "subdocument": case "frame": { let f = document.createElement("iframe"); f.src = c.url;
        document.body.append(f); break; }
      case "beacon": navigator.sendBeacon(c.url, "x"); break;
      case "media": { let a = document.createElement("audio"); a.preload = "auto"; a.src = c.url;
        document.body.append(a); a.load(); break; }
      case "font": new FontFace("f" + Math.random().toString(36).slice(2), "url(" + JSON.stringify(c.url) + ")")
        .load().catch(() => {}); break;
    }
  } catch (e) {}
}
// Script events come later, never during this loop.
document.title = "ran";
</script>"""


def runner_page(items):
    # Each item: {"kind", "url"}; kind "frame" loads a nested runner.
    return RUNNER.replace("ITEMS", json.dumps(items).replace("</", "<\\/"))


def serve_proxy():
    port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), ProxyHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return port


def proxy_prefs(port):
    return {"network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": port,
            "network.proxy.no_proxies_on": "",
            # The test pages are plain HTTP on purpose, on real hosts, some of
            # them HSTS-preloaded; the proxy cannot answer HTTPS.
            "dom.security.https_first": False,
            "network.stricttransportsecurity.preloadlist": False}


BLOCKER_STATE = """let state = Cc["@browser-wip/network-blocker;1"].getService(Ci.nsIBrowserWipBlocker).state;"""

# Every HTTP request's outcome, by URL, from the parent's observers. The
# status after http-on-modify-request is read once all of that topic's
# observers (the blocker among them) have run.
WATCH_REQUESTS = """
if (window.__bkObserver) {
  for (let t of ["http-on-modify-request", "http-on-stop-request", "http-on-failed-opening-request"]) {
    Services.obs.removeObserver(window.__bkObserver, t);
  }
}
window.__bk = { seen: {}, out: {} };
let note = ch => {
  let r = window.__bk.out[ch.URI.spec] ??= [];
  let list = ""; try { list = ch.QueryInterface(Ci.nsIClassifiedChannel).matchedList; } catch (e) {}
  r.push({ status: ch.status >>> 0, reason: ch.loadInfo.requestBlockingReason, list });
};
window.__bkObserver = { observe(subject, topic) {
  let ch; try { ch = subject.QueryInterface(Ci.nsIHttpChannel); } catch (e) { return; }
  if (topic == "http-on-modify-request") {
    window.__bk.seen[ch.URI.spec] = true;
    Services.tm.dispatchToMainThread(() => note(ch));
  } else {
    note(ch);
  }
} };
for (let t of ["http-on-modify-request", "http-on-stop-request", "http-on-failed-opening-request"]) {
  Services.obs.addObserver(window.__bkObserver, t);
}
return true;"""

# Outcome per URL: "block" (cancelled by the blocker), "allow", or "unseen".
OUTCOMES = """let [urls] = arguments;
let blocked = [0x805D0022, 0x805D002B];  // NS_ERROR_TRACKING_URI, NS_ERROR_SOCIALTRACKING_URI
let out = {};
for (let url of urls) {
  let spec = Services.io.newURI(url).spec;
  let records = window.__bk.out[spec];
  if (!window.__bk.seen[spec] && !records) { out[url] = { verdict: "unseen" }; continue; }
  let hit = (records ?? []).find(r => blocked.includes(r.status));
  out[url] = hit ? { verdict: "block", reason: hit.reason, list: hit.list } : { verdict: "allow" };
}
return out;"""


def case_groups(cases):
    """Runner pages: one per tab page, plus one per frame inside it."""
    groups, tops = {}, {}
    for c in cases:
        top, page = c.get("top", c["page"]), c["page"]
        item = {"kind": c["kind"], "url": c.get("via", c["url"])}
        if top == page:
            tops.setdefault(top, []).append(item)
        else:
            name = f"frame-{top}-{page}"
            groups.setdefault(name, []).append(item)
            frame = {"kind": "frame", "url": urllib.parse.urljoin(page, "/__frame?g=" + urllib.parse.quote(name))}
            if frame not in tops.setdefault(top, []):
                tops[top].append(frame)
    runners = {}
    for top, items in tops.items():
        groups[f"top-{top}"] = items
        runners[top] = urllib.parse.urljoin(top, "/__run?g=" + urllib.parse.quote(f"top-{top}"))
    return groups, runners


def run_cases(b, cases, settle=4, timeout=40):
    """Load the pages that make the cases' requests; outcome per case id,
    and the tab index of each page."""
    groups, runners = case_groups(cases)
    ProxyHandler.groups.update(groups)
    b.js(WATCH_REQUESTS)
    tabs = {}
    for top, url in runners.items():
        tabs[top] = b.js("return gBrowser.tabs.indexOf(gBrowser.addTab(arguments[0]));", url)
        b.wait("return gBrowser.tabs[arguments[0]].linkedBrowser.contentTitle.startsWith('ran');",
               tabs[top], timeout=30)
    urls = [c["url"] for c in cases]
    deadline = time.time() + timeout
    while time.time() < deadline:
        if all(o["verdict"] != "unseen" for o in b.js(OUTCOMES, urls).values()):
            break
        time.sleep(1)
    time.sleep(settle)
    out = b.js(OUTCOMES, urls)
    return {c["id"]: out[c["url"]] for c in cases}, tabs


def part7(bindir, base):
    hand = json.loads((BLOCKER_CASES / "hand-cases.json").read_text(encoding="utf-8"))["cases"]
    generated = json.loads((BLOCKER_CASES / "cases.json").read_text(encoding="utf-8"))["cases"]
    expected = json.loads((BLOCKER_CASES / "cases-expected.json").read_text(encoding="utf-8"))["verdicts"]
    port = serve_proxy()
    log_dir = Path(tempfile.mkdtemp(prefix="wip-blocker-log-"))

    # A page given on the command line loads while the engine is still being
    # built: its requests are held until the engine is ready, then checked.
    ProxyHandler.groups["startup"] = [
        {"kind": "script", "url": "http://google-analytics.com/startup.js"},
        {"kind": "script", "url": "http://cdn.example.org/startup.js"},
    ]
    startup_page = "http://startup.example.com/__run?g=startup"
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True, **proxy_prefs(port)},
                args=[startup_page],
                env={"MOZ_LOG": "BrowserWipBlocker:5", "MOZ_LOG_FILE": str(log_dir / "blocker.log")})
    try:
        state = b.wait(BLOCKER_STATE + " return state == 'ready' && state;", timeout=30)
        record(7, "the network blocker becomes ready", state == "ready", b.js(BLOCKER_STATE + " return state;"))
        tab = b.wait("return gBrowser.tabs.findIndex(t => t.linkedBrowser.currentURI.spec == arguments[0]) + 1;",
                     startup_page, timeout=30)
        title = b.wait("""let t = gBrowser.tabs[arguments[0] - 1].linkedBrowser.contentTitle;
          return t.startsWith("ran {") && t;""", tab, timeout=30) if tab else None
        startup = json.loads(title[4:]) if title else None
        record(7, "a page loading at startup, while the engine is built, is filtered",
               startup == {"http://google-analytics.com/startup.js": "error",
                           "http://cdn.example.org/startup.js": "load"}, [tab, title])

        # Tables: Gecko's URL classifier gets none, so nothing is counted twice.
        tables = b.js("""let db = Cc["@mozilla.org/url-classifier/dbservice;1"].getService(Ci.nsIUrlClassifierDBService);
          return new Promise(r => db.getTables(r));""")
        prefs = b.js(IMPORTS + """return ["urlclassifier.trackingTable", "urlclassifier.trackingAnnotationTable",
          "urlclassifier.features.socialtracking.blacklistTables"].map(pref);""")
        record(7, "the URL classifier has no blocking tables", prefs == ["", "", ""] and not (tables or "").strip(),
               [prefs, tables])

        # Hand-written cases: expectations from filter semantics.
        engine_cases = [c for c in hand if c["kind"] != "document"]
        got, tabs = run_cases(b, engine_cases)
        print("     hand cases (expectation from filter semantics / browser):")
        bad = []
        for c in engine_cases:
            o = got[c["id"]]
            ok = o["verdict"] == c["expect"]
            if c["expect"] == "block":
                ok = ok and o.get("reason") == REASON_TRACKING and o.get("list") == "browserwip-ads-trackers"
            if not ok:
                bad.append(c["id"])
            detail = f"  reason {o.get('reason')} list {o.get('list')}" if o["verdict"] == "block" else ""
            print(f"     {c['id']}  {c['kind']:11} expect {c['expect']}  browser {o['verdict']}{detail}"
                  f"  {'ok' if ok else 'WRONG'}  ({c['why']})")
        record(7, f"{len(engine_cases)} hand-written cases match their expected verdicts "
               "(blocked ones with reason 2004 and the list name)", not bad, bad)

        # Pages opened in a tab: only $document rules block them, and the
        # blocked-page screen (about:blocked) shows in place of the page.
        doc_of = ("let s = gBrowser.tabs[arguments[0]].linkedBrowser.browsingContext.currentWindowGlobal?.documentURI?.spec;"
                  "return s && s != 'about:blank' && s;")
        for c in (c for c in hand if c["kind"] == "document"):
            index = b.js("return gBrowser.tabs.indexOf(gBrowser.addTab(arguments[0]));", c["url"])
            doc = b.wait(doc_of, index, timeout=15) or ""
            blocked = doc.startswith("about:blocked?")
            record(7, f"{c['id']}: " + ("a page matching a $document rule shows the blocked-page screen" if c["expect"] == "block"
                                        else "a rule without $document doesn't block a page opened in a tab"),
                   blocked == (c["expect"] == "block"), doc)

        # The screen: Go back, Open it anyway (pressed from the keyboard, as
        # its "Go back" button has focus), and the session exception.
        press = """let [key, keyCode] = arguments;
          let tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
          tip.beginInputTransactionForTests(window);
          let ev = new KeyboardEvent("", { key, code: key, keyCode }); tip.keydown(ev); tip.keyup(ev);"""
        here = ("let s = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal?.documentURI?.spec;"
                "return s && s != 'about:blank' && s;")

        def go(url):
            b.js("gBrowser.loadURL(gBrowser.selectedBrowser, arguments[0], "
                 "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", url)

        def arrive(predicate, *args):
            return b.wait("let s = gBrowser.selectedBrowser.browsingContext.currentWindowGlobal?.documentURI?.spec ?? '';"
                          f"return ({predicate}) && s;", *args, timeout=15)

        b.js("gBrowser.selectTab(gBrowser.addTab('http://news.example.com/'));")
        arrive("s == 'http://news.example.com/'")
        go("http://news.example.com/smartpop/")
        doc = arrive("s.startsWith('about:blocked?')")
        title = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t && t != 'news.example.com/smartpop/' && t;", timeout=10)
        record(7, "an address typed in is checked too; the screen says the page was blocked", bool(doc) and title == "Page blocked", [doc, title])
        b.js("gBrowser.selectedBrowser.focus();")
        time.sleep(0.5)
        b.js(press, "Enter", 13)
        r = arrive("s == 'http://news.example.com/'")
        record(7, "Go back returns to the page before", bool(r), b.js(here))
        go("http://news.example.com/smartpop/")
        arrive("s.startsWith('about:blocked?')")
        b.js("gBrowser.selectedBrowser.focus();")
        time.sleep(0.5)
        b.js(press, "Tab", 9)
        b.js(press, "Enter", 13)
        r = arrive("s == 'http://news.example.com/smartpop/'")
        record(7, "Open it anyway opens the page", bool(r), b.js(here))
        go("http://news.example.com/smartpop/?again")
        r = arrive("s == 'http://news.example.com/smartpop/?again'")
        record(7, "and pages on that site aren't blocked again until quitting", bool(r), b.js(here))
        go("http://elsewhere.example.org/page/bouncy.php?id=1")
        r = arrive("s.startsWith('about:blocked?')")
        record(7, "other sites still are", bool(r), b.js(here))
        b.js("Services.prefs.setBoolPref('browserwip.contentblocking.blockpages.enabled', false);")
        go("http://third.example.com/smartpop/")
        r = arrive("s == 'http://third.example.com/smartpop/'")
        record(7, "with browserwip.contentblocking.blockpages.enabled off, no page is blocked", bool(r), b.js(here))
        b.js("Services.prefs.clearUserPref('browserwip.contentblocking.blockpages.enabled');")

        # The shield counts each blocked origin once, as the content-blocking
        # log does.
        top = "http://news.example.com/"
        origins = sorted({"http://" + urllib.parse.urlsplit(c["url"]).netloc for c in engine_cases
                          if c.get("top", c["page"]) == top and got[c["id"]]["verdict"] == "block"})
        shield = b.js("return gBrowser.tabs[arguments[0]].blockedTrackers;", tabs[top])
        record(7, "the shield counts the page's blocked origins", shield == len(origins), [shield, origins])

        # Per-site switch: nothing on that page is blocked any more.
        b.js(WATCH_REQUESTS)
        b.js(IMPORTS + """let b = gBrowser.tabs[arguments[0]].linkedBrowser;
          ContentBlockingAllowList.add(b); b.reload();""", tabs[top])
        time.sleep(5)
        mine = [c for c in engine_cases if c.get("top", c["page"]) == top]
        after = b.js(OUTCOMES, [c["url"] for c in mine])
        blocked_after = [u for u, o in after.items() if o["verdict"] == "block"]
        seen_after = [u for u, o in after.items() if o["verdict"] != "unseen"]
        record(7, "turning protections off for the site lets its requests through",
               not blocked_after and len(seen_after) > 5, [blocked_after, len(seen_after)])
        b.js(IMPORTS + "ContentBlockingAllowList.remove(gBrowser.tabs[arguments[0]].linkedBrowser);", tabs[top])

        # Social list: Strict's socialtracking pref, live.
        b.js("Services.prefs.setBoolPref('privacy.trackingprotection.socialtracking.enabled', true);")
        for c in (c for c in hand if c.get("social")):
            c = {**c, "page": "http://social.example.com/"}
            o = run_cases(b, [c])[0][c["id"]]
            record(7, f"{c['id']}: the social list blocks with socialtracking on (reason 2009)",
                   o["verdict"] == "block" and o.get("reason") == REASON_SOCIALTRACKING
                   and o.get("list") == "browserwip-social", o)
        b.js("Services.prefs.clearUserPref('privacy.trackingprotection.socialtracking.enabled');")

        # Generated cases: adblock-rust's own verdicts on requests recorded on
        # real pages.
        got, _ = run_cases(b, generated, timeout=60)
        diff = [(c["id"], c["kind"], c["url"][:100], expected[c["id"]], got[c["id"]]["verdict"])
                for c in generated if got[c["id"]]["verdict"] != expected[c["id"]]]
        blocked = sum(1 for c in generated if got[c["id"]]["verdict"] == "block")
        print(f"     generated cases: {len(generated)}, browser blocked {blocked}, "
              f"reference blocks {sum(1 for v in expected.values() if v == 'block')}, differ {len(diff)}")
        for d in diff:
            print(f"     differs: {d}")
        record(7, f"{len(generated)} recorded requests get adblock-rust's reference verdicts", not diff, diff[:10])
        r = b.js('const { ProtectionStats } = ChromeUtils.importESModule("resource://gre/modules/browserwip/ProtectionStats.sys.mjs");'
                 "return ProtectionStats.recent(1);")
        record(7, "what pages blocked is counted for the new tab's privacy report", r["trackers"] > 0 and r["pages"] > 0, r)

        # Odd URLs through the real glue: nothing may crash the parent.
        page = "http://odd.example.com/"
        odd = [
            {"id": "o1", "page": page, "kind": "image", "url": "http://odd.example.org/" + "a" * 60000},
            {"id": "o2", "page": page, "kind": "image", "url": "http://bücher.example/x.png"},
            {"id": "o3", "page": page, "kind": "image", "url": "http://[2001:db8::1]/x.png"},
            {"id": "o4", "page": page, "kind": "image", "url": "http://ODD-Case.Example.COM/X.png"},
            {"id": "o5", "page": page, "kind": "image", "url": "http://g.doubleclick.net:8080/x.png"},
            {"id": "o6", "page": page, "kind": "image", "url": "http://odd.example.org/%00%ff%e4%be%8b?$^|*"},
        ]
        got, _ = run_cases(b, odd, settle=2, timeout=20)
        alive = b.js("return Services.appinfo.name;")
        print("     odd URLs: " + ", ".join(f"{k} {v['verdict']}" for k, v in got.items()))
        record(7, "odd URLs (60 kB, IDN, IPv6, mixed case, port, escapes) are checked without crashing",
               alive == "browser-wip" and got["o5"]["verdict"] == "block", got)

        # The shield when the blocker isn't working. Only the UI: the state is
        # faked, since nothing in a release build can make the engine fail.
        ui = b.js("""const { ContentBlockingLists } = ChromeUtils.importESModule(
            "resource://gre/modules/browserwip/ContentBlockingLists.sys.mjs");
          gBrowser.selectTab(gBrowser.tabs[arguments[0]]);
          let real = Object.getOwnPropertyDescriptor(ContentBlockingLists, "unavailable");
          Object.defineProperty(ContentBlockingLists, "unavailable", { get: () => true, configurable: true });
          Services.obs.notifyObservers(null, "browserwip:blocker-state", "failed");
          let button = document.getElementById("protections-button");
          let r = { attr: button.hasAttribute("unavailable"), l10n: button.getAttribute("data-l10n-id"),
                    icon: button.querySelector("img").src };
          BrowserWip._fillProtectionsPanel();
          r.summary = document.getElementById("protections-summary").getAttribute("data-l10n-id");
          Object.defineProperty(ContentBlockingLists, "unavailable", real);
          Services.obs.notifyObservers(null, "browserwip:blocker-state", "ready");
          r.after = button.getAttribute("data-l10n-id");
          return r;""", tabs[top])
        record(7, "a failed blocker shows on the shield (crossed-out icon, unavailable wording)",
               ui["attr"] and ui["l10n"] == "protections-button-unavailable" and ui["icon"].endswith("shield-off.svg")
               and ui["summary"] == "protections-summary-unavailable" and ui["after"] == "protections-button", ui)
    finally:
        b.quit()

    # The blocker's own log: rule counts, build time, held requests, and the
    # main-thread time of every check.
    lines = []
    for f in sorted(log_dir.glob("blocker.log*")):
        lines += [line for line in f.read_text(errors="replace").splitlines() if "BrowserWipBlocker" in line]
    info = [line for line in lines if " check " not in line and "  http" not in line]
    print("     blocker log (MOZ_LOG=BrowserWipBlocker:5), without the per-request lines:")
    for line in info[:40]:
        print("       " + line)
    record(7, "the 28 $redirect rules are left out, and the count is logged",
           any("dropped 28 $redirect rules" in line for line in info), info[:5])
    # Whether the startup page's requests came before the engine was ready
    # depends on timing; the log says which happened.
    held = [line for line in info if "held" in line or "holding" in line]
    print(f"     requests held at startup: {held or 'none (the engine was ready first)'}")
    checks = sorted(float(line.split(" check ")[1].split(" us")[0]) for line in lines if " check " in line)
    if checks:
        print(f"     main-thread time per check, {len(checks)} requests: median {checks[len(checks) // 2]:.1f} us, "
              f"p99 {checks[min(len(checks) - 1, int(len(checks) * 0.99))]:.1f} us, max {checks[-1]:.1f} us")

    # DNS: a blocked request should not look its host up. With
    # network.dns.notifyResolution, Gecko reports every lookup it starts.
    # No proxy here, so lookups are real.
    for mode in ["standard", "strict"]:
        b = Browser(bindir, prefs={"browserwip.firstrun.completed": True, "network.dns.notifyResolution": True})
        try:
            b.wait(BLOCKER_STATE + " return state == 'ready';", timeout=30)
            if mode == "strict":
                b.js(IMPORTS + "PrivacyModes.setMode('strict');")
            b.js("""window.__dns = [];
              window.__dnsObserver = { observe(s, t, host) { window.__dns.push(host); } };
              Services.obs.addObserver(window.__dnsObserver, "dns-resolution-request");""")
            b.js(WATCH_REQUESTS)
            b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0]));", f"{base}/blocking-dns.html?{mode}")
            b.wait("return gBrowser.selectedBrowser.contentTitle == 'dns page';", timeout=20)
            time.sleep(8)
            looked_up = set(b.js("return window.__dns;"))
            paths = [
                ("script", "www.google-analytics.com", "https://www.google-analytics.com/analytics.js"),
                ("image", "securepubads.g.doubleclick.net", "https://securepubads.g.doubleclick.net/pagead/pixel.gif"),
                ("fetch", "stats.bitdefender.com", "https://stats.bitdefender.com/collect"),
                ("iframe", "ad.doubleclick.net", "https://ad.doubleclick.net/frame.html"),
                ("<link rel=dns-prefetch>", "fls.doubleclick.net", None),
                ("<link rel=preconnect>", "static.doubleclick.net", None),
                ("<a href> on the page", "www.googletagmanager.com", None),
            ]
            if mode == "strict":
                paths.append(("social iframe", "www.facebook.com", "https://www.facebook.com/plugins/like.php?href=x"))
            outcomes = b.js(OUTCOMES, [u for _, _, u in paths if u])
            print(f"     {mode}: hosts Gecko started a DNS lookup for: {sorted(looked_up)}")
            for path, host, url in paths:
                verdict = outcomes[url]["verdict"] if url else "not a request"
                record(7, f"{mode}: no DNS lookup for a blocked host ({path}: {host}; request: {verdict})",
                       host not in looked_up and (not url or verdict == "block"))
        finally:
            b.quit()


# ---------------------------------------------------------------------------
# Part 8: the password manager (docs/PASSWORDS.md §15)
#
# Login pages are served over HTTPS with a certificate made for the run;
# the test profile trusts it through the certificate override service. A
# second server on another port and one on another loopback host (127.0.0.2)
# are "another site".

PW_STYLE = ("<style>body{margin:0;font:14px sans-serif}input{position:absolute;left:40px;width:260px;"
            "height:30px;box-sizing:border-box}button{position:absolute;left:40px;top:220px}"
            "iframe{position:absolute;left:0;top:0;width:400px;height:300px;border:0}</style>")
# Each page reports its fields in its title (and, in a frame, to the top
# page): the username, the password's length, whether the confirmation
# matches.
PW_REPORT = """<script>
function report() {
  let c = document.getElementById("c");
  let t = `u=${u.value} p=${p.value.length}` + (c ? ` same=${p.value == c.value}` : "");
  document.title = t;
  if (parent != window) parent.postMessage(t, "*");
}
for (let f of document.querySelectorAll("input")) f.addEventListener("input", report);
</script>"""
PW_PAGES = {
    "/login": f"""<!doctype html><meta charset=utf-8><title>login</title>{PW_STYLE}
<form action="/welcome" method="post">
<input id=u name=username autocomplete=username style="top:40px">
<input id=p name=password type=password autocomplete=current-password style="top:100px">
<button id=go>Sign in</button></form>{PW_REPORT}""",
    "/signup": f"""<!doctype html><meta charset=utf-8><title>signup</title>{PW_STYLE}
<form action="/welcome" method="post">
<input id=u name=email type=email autocomplete=email style="top:40px">
<input id=p name=new type=password autocomplete=new-password style="top:100px">
<input id=c name=confirm type=password autocomplete=new-password style="top:160px">
<button id=go>Create account</button></form>{PW_REPORT}""",
    # The username field is off-screen: only the password is filled.
    "/offscreen": f"""<!doctype html><meta charset=utf-8><title>offscreen</title>{PW_STYLE}
<form action="/welcome" method="post">
<input id=u name=username autocomplete=username style="top:40px;left:-10000px">
<input id=p name=password type=password autocomplete=current-password style="top:100px">
<button id=go>Sign in</button></form>{PW_REPORT}""",
    # Focused by the page's script, not the user: no dropdown.
    "/autofocus": f"""<!doctype html><meta charset=utf-8><title>autofocus</title>{PW_STYLE}
<form action="/welcome" method="post">
<input id=u name=username autocomplete=username style="top:40px">
<input id=p name=password type=password autocomplete=current-password style="top:100px">
<button id=go>Sign in</button></form>{PW_REPORT}
<script>setTimeout(() => {{ u.focus(); u.click(); document.title = "focused"; }}, 300);</script>""",
    "/welcome": "<!doctype html><meta charset=utf-8><title>welcome</title><p>Signed in.",
}


class PasswordPageHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/frame":
            src = urllib.parse.parse_qs(query).get("src", [""])[0]
            body = (f"<!doctype html><meta charset=utf-8><title>frame</title>{PW_STYLE}"
                    f"<iframe src='{src}'></iframe><script>addEventListener('message', e => "
                    f"document.title = 'frame:' + e.data);</script>")
        else:
            body = PW_PAGES.get(path)
        data = (body or "not found").encode()
        self.send_response(200 if body else 404)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self.path = "/welcome"
        self.do_GET()


def make_certificate(directory):
    """A self-signed certificate for the run, or None without openssl."""
    openssl = shutil.which("openssl")
    if not openssl and sys.platform == "win32":
        git = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Git/usr/bin/openssl.exe"
        openssl = str(git) if git.exists() else None
    if not openssl:
        return None
    cert, key = Path(directory) / "cert.pem", Path(directory) / "key.pem"
    result = subprocess.run(
        [openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-keyout", str(key),
         "-out", str(cert), "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,IP:127.0.0.2"],
        capture_output=True,
    )
    return (cert, key) if result.returncode == 0 else None


def serve_https(host, certificate, plain=False):
    server = http.server.ThreadingHTTPServer((host, 0), PasswordPageHandler)
    if not plain:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*certificate)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    scheme = "http" if plain else "https"
    return server, f"{scheme}://{host}:{server.server_address[1]}"


PV = 'const { PasswordVault } = ChromeUtils.importESModule("resource://gre/modules/browserwip/PasswordVault.sys.mjs");'
PM = 'const { PrivacyModes } = ChromeUtils.importESModule("resource://gre/modules/browserwip/PrivacyModes.sys.mjs");'
# Keys, as the user types them (nsITextInputProcessor: trusted events).
PW_TYPE = """let [text, key] = arguments;
let tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
if (!tip.beginInputTransactionForTests(window)) throw new Error("no TIP");
let send = init => { let ev = new KeyboardEvent("", init); tip.keydown(ev); tip.keyup(ev); };
if (key) {
  send({ key, code: key, keyCode: KeyboardEvent["DOM_VK_" + { Enter: "RETURN", ArrowDown: "DOWN" }[key]] });
} else {
  for (let ch of text) send({ key: ch });
}"""
PW_PANEL = """let p = document.getElementById("passwords-panel"), b = document.getElementById("passwords-button");
return { state: p.state, view: p.getAttribute("view"), button: !b.hidden, pending: b.hasAttribute("pending") };"""
PW_DROPDOWN = """let d = document.getElementById("passwords-dropdown");
return { state: d.state, rows: [...d.querySelectorAll(".passwords-option, .passwords-dropdown-header")]
  .map(r => r.textContent.replace(/\\s+/g, " ").trim()) };"""


def part8_frame(bindir, site, other_host):
    """A login form in a cross-origin frame (§7.1.4). Headless Gecko doesn't
    route a click synthesized in the window into an out-of-process frame, so
    this profile keeps frames in the page's process; the rule under test
    depends on the frame's origin, not its process."""
    secret = "frame-secret-pass"
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True, "fission.autostart": False})
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        b.js('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService)'
             '.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);')
        b.js(PV + """return (async () => {
          await PasswordVault.setup("correct horse battery", "correct horse battery");
          await PasswordVault.saveLogin({ origin: arguments[0], username: "frame@example.com", password: arguments[1] });
        })();""", other_host, secret)
        url = f"{site}/frame?src={urllib.parse.quote(other_host + '/login')}"
        b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0], "
             "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));", url)
        b.wait("return gBrowser.selectedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentTitle == 'login';",
               timeout=15)
        time.sleep(1)
        r = b.js("return document.getElementById('passwords-dropdown').state;")
        record(8, "a cross-origin frame opens nothing by itself", r == "closed", r)
        b.m.click(60, 55)
        r = b.wait("return document.getElementById('passwords-dropdown').state == 'open';", timeout=5)
        d = b.js(PW_DROPDOWN)
        host = urllib.parse.urlsplit(other_host).netloc
        record(8, "a click in it opens the dropdown, naming the frame's site",
               r and d["rows"] and host in d["rows"][0] and any(row.startswith("frame@example.com") for row in d["rows"]), d)
        b.js("document.querySelector('#passwords-dropdown .passwords-option')?.click();")
        r = b.wait("return gBrowser.selectedBrowser.contentTitle == arguments[0];",
                   f"frame:u=frame@example.com p={len(secret)}", timeout=5)
        record(8, "and picking the login fills the frame", r, b.js("return gBrowser.selectedBrowser.contentTitle;"))
    finally:
        b.quit()


def part8_subdomains(bindir, site):
    """Logins on other subdomains and the parent domain stay behind "Show all
    for example.test", in the dropdown and the key button's panel. The test
    names resolve to the local server (network.dns.localDomains)."""
    port = urllib.parse.urlsplit(site).port
    origin = lambda host: f"https://{host}:{port}"
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True,
                                "network.dns.localDomains": "example.test,mail.example.test,accounts.example.test"})
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        b.js('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService)'
             '.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);')
        b.js(PV + """return (async () => {
          await PasswordVault.setup("correct horse battery", "correct horse battery");
          let [mail, parent, accounts] = arguments;
          await PasswordVault.saveLogin({ origin: mail, username: "mail-user", password: "mail-Secret-123" });
          await PasswordVault.saveLogin({ origin: parent, username: "parent-user", password: "parent-Secret-123" });
          await PasswordVault.saveLogin({ origin: accounts, username: "accounts-user", password: "accounts-Secret-123" });
        })();""", origin("mail.example.test"), origin("example.test"), origin("accounts.example.test"))
        b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0], "
             "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));",
             origin("mail.example.test") + "/login")
        b.wait("return gBrowser.selectedBrowser.contentTitle == 'login';", timeout=15)
        b.m.click(60, 55)
        b.wait("return document.getElementById('passwords-dropdown').state == 'open';", timeout=5)
        d = b.js(PW_DROPDOWN)
        users = lambda rows: [u for u in ["mail-user", "parent-user", "accounts-user"] if any(u in row for row in rows)]
        record(8, "on a subdomain the dropdown offers only that subdomain's logins, with Show all for the site",
               users(d["rows"]) == ["mail-user"] and any("Show all for example.test" in row for row in d["rows"]), d)
        b.js("""[...document.querySelectorAll('#passwords-dropdown .passwords-option')]
          .find(o => o.textContent.includes('Show all')).click();""")
        r = b.wait(PW_DROPDOWN.replace("return {", "let r = {") + "\nreturn r.rows.some(x => x.includes('parent-user')) && r;", timeout=5)
        record(8, "and Show all adds the parent domain's and other subdomains' logins",
               bool(r) and users(r["rows"]) == ["mail-user", "parent-user", "accounts-user"]
               and not any("Show all" in row for row in r["rows"]), r or b.js(PW_DROPDOWN))
        b.js("document.getElementById('passwords-dropdown').hidePopup();")
        site_list = """let list = document.getElementById("passwords-site-list"), all = document.getElementById("passwords-site-all");
          return { rows: [...list.querySelectorAll(".passwords-site-row")].map(r => r.textContent),
                   all: !all.hidden && all.textContent, title: document.getElementById("passwords-title").textContent };"""
        b.js("PasswordsUI.openPanel();")
        b.wait("let p = document.getElementById('passwords-panel'); return p.state == 'open' && p.getAttribute('view') == 'site';", timeout=10)
        r = b.wait(site_list.replace("return {", "let r = {") + "\nreturn r.all && r;", timeout=5)
        record(8, "the key button's panel lists that subdomain's logins, with Show all for the site",
               bool(r) and users(r["rows"]) == ["mail-user"] and "example.test (2)" in r["all"]
               and "mail.example.test" in r["title"], r or b.js(site_list))
        b.js("document.getElementById('passwords-site-all').click();")
        r = b.wait(site_list.replace("return {", "let r = {") + "\nreturn r.rows.length == 3 && r;", timeout=5)
        record(8, "and Show all there lists the whole site",
               bool(r) and users(r["rows"]) == ["mail-user", "parent-user", "accounts-user"], r or b.js(site_list))
    finally:
        b.quit()


def part8(bindir, base, shots):
    work = tempfile.mkdtemp(prefix="wip-pw-")
    certificate = make_certificate(work)
    if not certificate:
        record(8, "openssl makes the test server's certificate", False, "openssl not found or failed")
        return
    servers = []
    try:
        for host in ["127.0.0.1", "127.0.0.1", "127.0.0.2"]:
            servers.append(serve_https(host, certificate))
        servers.append(serve_https("127.0.0.1", certificate, plain=True))
    except OSError as e:
        record(8, "test servers start", False, repr(e))
        return
    site, other_port, other_host, plain = (url for _, url in servers)
    master, fresh = "correct horse battery", "a brand new master pass"
    secret = "hunter2-but-longer"
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True})
    secrets = [master, fresh, secret]
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        b.js('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService)'
             '.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);')
        title = lambda: b.js("return gBrowser.selectedBrowser.contentTitle;")
        typ = lambda text: b.js(PW_TYPE, text, None)
        key = lambda k: b.js(PW_TYPE, "", k)
        panel = lambda: b.js(PW_PANEL)
        dropdown = lambda: b.js(PW_DROPDOWN)
        vault_file = b.profile / "passwords" / "vault.bwv"

        def load(url, expected, timeout=15):
            b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0], "
                 "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));", url)
            return b.wait("return gBrowser.selectedBrowser.contentTitle == arguments[0];", expected, timeout=timeout)

        def close_tabs():
            b.js("for (let t of gBrowser.tabs.slice(1)) gBrowser.removeTab(t);")

        def open_dropdown(x, y):
            b.m.click(x, y)
            return b.wait("return document.getElementById('passwords-dropdown').state == 'open';", timeout=5)

        def sign_in(url, username, password):
            load(url, "login")
            b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
            b.m.click(60, 55)
            typ(username)
            b.m.click(60, 115)
            typ(password)
            b.wait("return gBrowser.selectedBrowser.contentTitle.startsWith(arguments[0]);", f"u={username}", timeout=5)
            b.js("document.getElementById('passwords-dropdown').hidePopup();")
            key("Enter")

        # -- No vault until setup; Hello not set up means the master password.
        load(site + "/login", "login")
        r = b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
        record(8, "the key button shows on an HTTPS login page", r)
        record(8, "no vault file in the profile until setup", not vault_file.exists())
        r = b.js(PV + "return (async () => { await PasswordVault.init(); return [PasswordVault.state, PasswordVault.canUnlockWithHello]; })();")
        record(8, "a new profile has no vault and no Windows Hello unlock", r == ["none", False], r)

        # -- Setup, with a recovery key.
        code = b.js(PV + "return (async () => { await PasswordVault.setup(arguments[0], arguments[0]); "
                    "return PasswordVault.newRecoveryKey(arguments[0]); })();", master)
        secrets.append(code)
        record(8, "setup writes the vault", vault_file.exists())
        record(8, "a recovery key is 8 groups of 4", bool(re.fullmatch(r"([A-Z2-7]{4}-){7}[A-Z2-7]{4}", code or "")), code)

        # -- Saving: the prompt after signing in.
        close_tabs()
        sign_in(site + "/login", "ana@example.com", secret)
        r = b.wait("let p = document.getElementById('passwords-panel'); return p.state == 'open' && p.getAttribute('view');", timeout=15)
        record(8, "signing in offers to save the login", r == "save", panel())
        b.js("document.getElementById('passwords-save-confirm').click();")
        r = b.wait(PV + "let e = PasswordVault.entries(); return e.length && e.map(x => [x.origin, x.username]);", timeout=10)
        record(8, "Save puts it in the vault", r == [[site, "ana@example.com"]], r)

        # -- Filling on the exact origin only.
        close_tabs()
        load(site + "/login", "login")
        b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
        r = open_dropdown(60, 55)
        d = dropdown()
        record(8, "the dropdown lists the login on its own origin", r and d["rows"][:1] and d["rows"][0].startswith("ana@example.com"), d)
        key("ArrowDown")
        key("Enter")
        r = b.wait("return gBrowser.selectedBrowser.contentTitle == arguments[0];", f"u=ana@example.com p={len(secret)}", timeout=5)
        record(8, "picking it fills username and password", r, title())
        for label, url in [("another port", other_port), ("another host", other_host)]:
            close_tabs()
            load(url + "/login", "login")
            b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
            open_dropdown(60, 55)
            d = dropdown()
            record(8, f"nothing offered on {label}", not any("ana@example.com" in row for row in d["rows"]), d)
            b.js("document.getElementById('passwords-dropdown').hidePopup();")
        close_tabs()
        load(plain + "/login", "login")
        time.sleep(1)
        b.m.click(60, 55)
        time.sleep(1)
        r = b.js("return [document.getElementById('passwords-button').hidden, document.getElementById('passwords-dropdown').state];")
        record(8, "nothing on HTTP: no key button, no dropdown", r == [True, "closed"], r)

        # -- Script focus opens nothing; off-screen fields aren't filled.
        close_tabs()
        load(site + "/autofocus", "focused")
        time.sleep(1)
        r = b.js("return document.getElementById('passwords-dropdown').state;")
        record(8, "a field focused and clicked by script opens no dropdown", r == "closed", r)
        close_tabs()
        load(site + "/offscreen", "offscreen")
        b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
        open_dropdown(60, 115)
        key("ArrowDown")
        key("Enter")
        r = b.wait("return gBrowser.selectedBrowser.contentTitle == arguments[0];", f"u= p={len(secret)}", timeout=5)
        record(8, "an off-screen username field isn't filled; the password is", r, title())

        # -- Never for this site.
        close_tabs()
        sign_in(other_port + "/login", "bob@example.com", "never-saved-password")
        secrets.append("never-saved-password")
        r = b.wait("let p = document.getElementById('passwords-panel'); return p.state == 'open' && p.getAttribute('view');", timeout=15)
        b.js("document.getElementById('passwords-never').doCommand();")
        b.wait("return document.getElementById('passwords-panel').state == 'closed';", timeout=5)
        close_tabs()
        sign_in(other_port + "/login", "bob@example.com", "never-saved-password")
        b.wait("return gBrowser.selectedBrowser.contentTitle == 'welcome';", timeout=10)
        time.sleep(1.5)
        p = panel()
        r = b.js(PV + "return PasswordVault.entries().some(e => e.username == 'bob@example.com');")
        record(8, "after Never for this site, signing in there asks nothing", r is False and p["state"] == "closed" and not p["pending"], p)

        # -- Generated passwords: Standard saves them with Undo, Strict asks.
        for mode, view in [("strict", "save"), ("standard", "saved")]:
            b.js(PM + "PrivacyModes.setMode(arguments[0]);", mode)
            close_tabs()
            load(site + "/signup", "signup")
            b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
            b.m.click(60, 55)
            typ(f"{mode}@example.com")
            # No saved login starts with what was typed: the list closes.
            b.wait("return document.getElementById('passwords-dropdown').state == 'closed';", timeout=5)
            open_dropdown(60, 115)
            b.js("document.querySelector('#passwords-dropdown .passwords-option.generator').click();")
            b.wait("return gBrowser.selectedBrowser.contentTitle.endsWith('p=20 same=true');", timeout=5)
            b.m.click(60, 175)
            key("Enter")
            r = b.wait("let p = document.getElementById('passwords-panel'); return p.state == 'open' && p.getAttribute('view');", timeout=15)
            record(8, f"{mode.capitalize()}: a generated password is {'offered' if view == 'save' else 'saved, with Undo'}", r == view, panel())
            b.js("document.getElementById('passwords-panel').hidePopup();")
        b.js(PM + "PrivacyModes.setMode('standard');")

        # -- The clipboard is cleared after 30 s (checked further down).
        b.js(PV + "return PasswordVault.copyPassword(PasswordVault.entries().find(e => e.username == 'ana@example.com').id);")
        copied_at = time.time()
        CLIPBOARD = """let t = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
t.init(null); t.addDataFlavor("text/plain");
try { Services.clipboard.getData(t, Ci.nsIClipboard.kGlobalClipboard, null); } catch (e) { return ""; }
let data = {}; try { t.getTransferData("text/plain", data); } catch (e) { return ""; }
return data.value.QueryInterface(Ci.nsISupportsString).data;"""
        record(8, "Copy puts the password on the clipboard", b.js(CLIPBOARD) == secret)

        # -- Locking: on idle (the idle service's observer, at the pref's
        # time) and when Windows locks.
        b.js("Services.prefs.setIntPref('browserwip.passwords.lockAfterMinutes', 1);")
        r = b.wait(PV + "return PasswordVault._idleArmed;", timeout=5)
        record(8, "unlocked, the vault waits for the set idle time", r == 60, r)
        b.js(PV + "PasswordVault.observe(null, 'idle');")
        r = b.wait(PV + "return PasswordVault.state == 'locked';", timeout=5)
        record(8, "idle locks the vault", r)
        b.js(PV + "return PasswordVault.unlock(arguments[0]);", master)
        b.js("Services.obs.notifyObservers(null, 'browserwip:session-locked');")
        r = b.wait(PV + "return PasswordVault.state == 'locked';", timeout=5)
        record(8, "the Windows session locking locks the vault", r)
        close_tabs()
        load(site + "/login", "login")
        b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
        b.js("PasswordsUI.openPanel();")
        r = b.wait("let p = document.getElementById('passwords-panel'); return p.getAttribute('view') == 'unlock' && "
                   "[document.getElementById('passwords-unlock-hello').hidden, document.activeElement?.id];", timeout=5)
        record(8, "without Windows Hello, unlocking asks for the master password", r and r[0], r)
        b.js("document.getElementById('passwords-panel').hidePopup();")

        # -- Forgot password: the recovery key sets a new one.
        close_tabs()
        load("about:passwords#forgot", "")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.readyState == 'complete' && "
                   "!d.getElementById('card-forgot').hidden && !d.getElementById('recover-form').hidden;", timeout=15)
        record(8, "Forgot password offers the recovery key", r)
        r = b.js(PV + "return PasswordVault.recover(arguments[0], arguments[1], arguments[1]).then(() => 'ok', e => e.code);",
                 "AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH", fresh)
        record(8, "a wrong recovery key is refused", r == "wrong-recovery-key", r)
        r = b.js(PV + "return PasswordVault.recover(arguments[0], arguments[1], arguments[1]).then(() => PasswordVault.state, e => e.code);",
                 code.lower(), fresh)
        record(8, "the recovery key unlocks and sets a new master password", r == "unlocked", r)
        b.js(PV + "return PasswordVault.lock();")
        r = b.js(PV + "return PasswordVault.unlock(arguments[0]).then(() => 'ok', e => e.code);", master)
        record(8, "the old master password no longer opens it", r == "wrong-password", r)
        r = b.js(PV + "return PasswordVault.unlock(arguments[0]).then(() => PasswordVault.entries().length, e => e.code);", fresh)
        record(8, "the new one does, with every login", r == 2, r)

        # -- The clipboard, 30 s after the copy.
        time.sleep(max(0, copied_at + 32 - time.time()))
        record(8, "the clipboard is cleared after 30 s", b.js(CLIPBOARD) != secret)

        # -- Start over: the old vault kept, a new one set up from the page.
        b.js(PV + "return PasswordVault.lock();")
        r = b.js(PV + "return PasswordVault.startOver('start').then(() => 'ok', e => e.code);")
        record(8, "Start over needs “start over” typed", r == "not-confirmed", r)
        r = b.js(PV + "return PasswordVault.startOver('Start over').then(n => [n, PasswordVault.state], e => e.code);")
        kept = r[0] if isinstance(r, list) else ""
        record(8, "Start over keeps the old vault and leaves none in use",
               isinstance(r, list) and r[1] == "none" and not vault_file.exists() and (vault_file.parent / kept).exists(), r)
        r = b.js(PV + "return PasswordVault.olderVaults();")
        record(8, "Settings can find the kept vault", r == [kept], r)
        close_tabs()
        load("about:passwords", "")
        b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.readyState == 'complete' && !d.getElementById('card-setup').hidden;", timeout=15)
        b.js("gBrowser.selectedBrowser.contentDocument.getElementById('setup-suggest').click();")
        r = b.js("let d = gBrowser.selectedBrowser.contentDocument, a = d.getElementById('setup-password'), c = d.getElementById('setup-confirm');"
                 "return [a.type, c.type, a.value == c.value, a.value.split('-').length];")
        record(8, "Suggest a passphrase fills both fields, shown, with five words", r and r[:3] == ["text", "text", True] and r[3] >= 5, r)
        phrase = b.js("return gBrowser.selectedBrowser.contentDocument.getElementById('setup-password').value;")
        secrets.append(phrase)
        b.js("gBrowser.selectedBrowser.contentDocument.getElementById('setup-submit').click();")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d.getElementById('recovery-dialog').open && "
                   "d.getElementById('recovery-code').children.length;", timeout=30)
        record(8, "setting up offers a recovery key, shown once in 8 groups", r == 8, r)
        secrets.append(b.js("return gBrowser.selectedBrowser.contentDocument.getElementById('recovery-code').textContent;"))
        b.js("gBrowser.selectedBrowser.contentDocument.getElementById('recovery-done').click();")
        r = b.js("let d = gBrowser.selectedBrowser.contentDocument; return [d.getElementById('recovery-dialog').open, d.getElementById('recovery-code').textContent];")
        record(8, "“I’ve written it down” closes it and forgets the key", r == [False, ""], r)
        r = b.js(PV + "return [PasswordVault.state, PasswordVault.hasRecoveryKey, PasswordVault.entries().length];")
        record(8, "the new vault is empty and has its recovery key", r == ["unlocked", True, 0], r)

        # -- Settings: the recovery key (again, with the master password),
        # and the kept vault.
        load("about:settings#passwords", "")
        S = "let d = gBrowser.selectedBrowser.contentDocument; "
        r = b.wait(S + "return d?.readyState == 'complete' && !d.getElementById('passwords-recovery-row').hidden && "
                   "[d.getElementById('passwords-recovery').textContent, d.getElementById('passwords-older-row').hidden];", timeout=15)
        record(8, "Settings offers a new recovery key and the older vault", r and r[0] == "Make a new one" and r[1] is False, r)
        b.js(S + "d.getElementById('passwords-recovery').click();")
        b.js(S + "d.getElementById('passwords-recovery-master').value = 'not the password'; d.getElementById('passwords-recovery-submit').click();")
        r = b.wait(S + "let e = d.getElementById('passwords-recovery-result'); return !e.hidden && e.textContent;", timeout=15)
        record(8, "a new recovery key needs the master password", r == "That isn’t the master password.", r)
        b.js(S + "d.getElementById('passwords-recovery-master').value = arguments[0]; d.getElementById('passwords-recovery-submit').click();", phrase)
        r = b.wait(S + "return !d.getElementById('passwords-recovery-shown').hidden && d.getElementById('passwords-recovery-code').children.length;", timeout=30)
        record(8, "with it, Settings shows the new key once", r == 8, r)
        settings_code = b.js(S + "return d.getElementById('passwords-recovery-code').textContent;")
        secrets.append(settings_code)
        b.js(S + "d.getElementById('passwords-recovery-done').click();")
        r = b.js(S + "return [d.getElementById('passwords-recovery-shown').hidden, d.getElementById('passwords-recovery-code').textContent];")
        record(8, "and forgets it once written down", r == [True, ""], r)

        # -- Open an older vault: its logins come back with its password.
        r = b.js(PV + """return (async () => {
          let bytes = await IOUtils.read(PathUtils.join(PasswordVault.directory, arguments[0]));
          let { logins } = await PasswordVault.readImport(bytes, arguments[1]);
          await PasswordVault.applyImport(PasswordVault.planImport(logins));
          return PasswordVault.entries().map(e => e.username).sort();
        })();""", kept, fresh)
        record(8, "an older vault opened with its master password adds its logins back",
               r == ["ana@example.com", "standard@example.com"], r)

        # -- Password health: reused and weak, worked out in the core.
        b.js(PV + """return (async () => {
          await PasswordVault.saveLogin({ origin: "https://one.example", username: "a", password: "same-Password-123!" });
          await PasswordVault.saveLogin({ origin: "https://two.example", username: "b", password: "same-Password-123!" });
          await PasswordVault.saveLogin({ origin: "https://weak.example", username: "c", password: "password1" });
        })();""")
        secrets += ["same-Password-123!"]
        r = b.js(PV + """return PasswordVault.health().then(h => PasswordVault.entries()
          .map(e => [new URL(e.origin).hostname, h.get(e.id).reused, h.get(e.id).weak]).sort());""")
        record(8, "health: the same password on two sites is reused, a short simple one weak",
               r and ["one.example", 1, False] in r and ["two.example", 1, False] in r and ["weak.example", 0, True] in r
               and ["127.0.0.1", 0, False] in r, r)
        close_tabs()
        load("about:passwords", "")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; let s = d?.getElementById('health-summary');"
                   "return s && !s.hidden && s.textContent && [s.textContent, d.querySelectorAll('.health-badge').length];",
                   timeout=15)
        record(8, "about:passwords sums it up and marks the logins", r == ["2 reused · 1 weak", 3], r)

        # -- Show and copy: Windows Hello offered where it's set up; if its
        # slot is gone, it says so and the master password still works.
        b.js(PV + "PasswordVault._revealUntil = 0; PasswordVault.hello = { available: true, enrolled: true };")
        b.js("let d = gBrowser.selectedBrowser.contentDocument; d.querySelector('#detail [data-action=show]').click();")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; let h = d.querySelector('#inline-slot .confirm-hello');"
                   "return h && d.activeElement == h;", timeout=5)
        record(8, "with Windows Hello, Show offers it first", r)
        b.js("gBrowser.selectedBrowser.contentDocument.querySelector('#inline-slot .confirm-hello').click();")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; let e = d.querySelector('#inline-slot .error');"
                   "return e && !e.hidden && e.textContent && [e.textContent, d.querySelector('#inline-slot .confirm-hello').hidden];", timeout=15)
        record(8, "a Hello that can't open the vault falls back to the master password", r and "Windows Hello" in r[0] and r[1], r)
        b.js("let d = gBrowser.selectedBrowser.contentDocument; d.querySelector('#inline-slot').replaceChildren();")
        b.js(PV + "return PasswordVault._refreshHello();")

        # -- Replace encryption key: the new recovery key shown before the
        # swap; saves wait meanwhile; afterwards only the new key works.
        code_new = b.js(PV + "return PasswordVault.replacePrepare(arguments[0]);", phrase)
        secrets.append(code_new)
        record(8, "replacing the key makes a new recovery key, shown before the swap",
               bool(re.fullmatch(r"([A-Z2-7]{4}-){7}[A-Z2-7]{4}", code_new or "")), code_new)
        r = b.js(PV + """let saved = false;
          PasswordVault.saveLogin({ origin: "https://during.example", username: "d", password: "saved-during-replace" }).then(() => saved = true);
          return new Promise(r => setTimeout(() => r(saved), 1500));""")
        record(8, "a save during the replacement waits for it", r is False, r)
        r = b.js(PV + "return PasswordVault.replaceCommit();")
        record(8, "committing puts the new vault in use", r == "done", r)
        r = b.wait(PV + "return PasswordVault.entries().some(e => e.username == 'd');", timeout=10)
        record(8, "and the waiting save lands in it", r)
        b.js(PV + "return PasswordVault.lock();")
        r = b.js(PV + "return PasswordVault.recover(arguments[0], 'whatever whatever', 'whatever whatever').then(() => 'ok', e => e.code);",
                 settings_code)
        record(8, "the old recovery key no longer works", r == "wrong-recovery-key", r)
        r = b.js(PV + "return PasswordVault.unlock(arguments[0]).then(() => PasswordVault.entries().length, e => e.code);", phrase)
        record(8, "the master password opens the new vault, with every login", r == 6, r)

        # The same from Settings, with a password change: "my old password
        # may have been exposed".
        load("about:settings#passwords", "")
        b.wait(S + "return d?.readyState == 'complete' && !d.getElementById('passwords-change-box').hidden;", timeout=15)
        renewed = "a renewed master password"
        secrets.append(renewed)
        b.js(S + """d.getElementById('passwords-change-box').open = true;
          d.getElementById('passwords-current').value = arguments[0];
          d.getElementById('passwords-new').value = arguments[1];
          d.getElementById('passwords-repeat').value = arguments[1];
          d.getElementById('passwords-exposed').checked = true;
          d.getElementById('passwords-change-submit').click();""", phrase, renewed)
        r = b.wait(S + "return !d.getElementById('passwords-replace-shown').hidden && d.getElementById('passwords-replace-code').children.length;",
                   timeout=60)
        record(8, "a change with “may have been exposed” shows the new recovery key first", r == 8, r)
        code_renewed = b.js(S + "return d.getElementById('passwords-replace-code').textContent;")
        secrets.append(code_renewed)
        b.js(S + "d.getElementById('passwords-replace-stored').click();")
        r = b.wait(S + "let r = d.getElementById('passwords-change-result'), done = d.getElementById('passwords-replace-done');"
                   "return !r.hidden && !done.hidden && r.textContent && d.getElementById('passwords-replace-done-text').textContent && [r.textContent, d.getElementById('passwords-replace-done-text').textContent];",
                   timeout=60)
        record(8, "“I have stored it” finishes it", r and r[0] == "Master password changed." and "old recovery key no longer works" in r[1], r)
        phrase = renewed
        code_new = code_renewed

        # -- This computer only (a real TPM: Windows with a TPM 2.0).
        device = b.js(PV + "return PasswordVault.device;")
        if not device["available"]:
            print("     no TPM 2.0 here: “only on this computer” not checked")
        else:
            r = b.js(PV + "return PasswordVault.enableDeviceBinding('not the password').then(() => 'ok', e => e.code);")
            record(8, "binding to this computer needs the master password", r == "wrong-password", r)
            r = b.js(PV + "return PasswordVault.enableDeviceBinding(arguments[0]).then(() => PasswordVault.device.bound, e => e.code);", phrase)
            record(8, "with it, the vault is bound to this computer's TPM", r is True, r)
            b.js(PV + "return PasswordVault.lock();")
            r = b.js(PV + "return PasswordVault.unlock(arguments[0]).then(() => PasswordVault.entries().length, e => e.code);", phrase)
            record(8, "here, the master password still opens it", r == 6, r)
            r = b.js(PV + "return PasswordVault.disableDeviceBinding(arguments[0]).then(() => PasswordVault.device.bound, e => e.code);", phrase)
            record(8, "turning it off unbinds it", r is False, r)
            b.js(PV + "return PasswordVault.lock();")
            r = b.js(PV + "return PasswordVault.unlock(arguments[0]).then(() => 'ok', e => e.code);", phrase)
            record(8, "and the master password alone opens it again", r == "ok", r)
            b.js(PV + "return PasswordVault.enableDeviceBinding(arguments[0]);", phrase)
            b.js(PV + "return PasswordVault.lock();")
            # Another computer: the same file without this TPM key.
            data = vault_file.read_bytes()
            pos, vault_id = 16, None
            while pos + 3 <= 16 + int.from_bytes(data[10:12], "little"):
                kind, size = data[pos], int.from_bytes(data[pos + 1:pos + 3], "little")
                if kind == 0x01:
                    vault_id = data[pos + 3:pos + 3 + size].hex()
                    break
                pos += 3 + size
            deleted = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "Add-Type -AssemblyName System.Core; "
                 "$p = New-Object System.Security.Cryptography.CngProvider('Microsoft Platform Crypto Provider'); "
                 f"[System.Security.Cryptography.CngKey]::Open('BWVAULT-DEVICE-{vault_id}', $p).Delete()"],
                capture_output=True)
            record(8, "(the test removes the TPM key, as on another computer)", deleted.returncode == 0,
                   deleted.stderr.decode(errors="replace")[-300:])
            r = b.js(PV + "return PasswordVault.unlock(arguments[0]).then(() => 'ok', e => e.code);", phrase)
            record(8, "without this computer's TPM key, the master password alone doesn't open it", r == "wrong-password", r)
            r = b.js(PV + "return PasswordVault.recover(arguments[0], arguments[1], arguments[1]).then(() => [PasswordVault.state, PasswordVault.device.bound], e => e.code);",
                     code_new, phrase)
            record(8, "the recovery key still does, and leaves it unbound", r == ["unlocked", False], r)

        log = (b.profile / "browser.log").read_text(errors="replace")
        leaked = [s for s in secrets if s and s in log]
        record(8, "no secrets in the browser log", not leaked, f"{len(leaked)} found")
    finally:
        b.quit()
    try:
        part8_frame(bindir, site, other_host)
        part8_subdomains(bindir, site)
    finally:
        for server, _ in servers:
            server.shutdown()
        shutil.rmtree(work, ignore_errors=True)


# ---------------------------------------------------------------------------
# Part 9: bookmarks, history and the address bar's dropdown
#
# Pages come from a local server: /page/<name> has the title <name>. A fake
# search engine answers suggestions at /suggest and remembers every query,
# so the checks can tell exactly what was sent.


class LibraryHandler(http.server.BaseHTTPRequestHandler):
    queries = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/suggest":
            q = urllib.parse.parse_qs(query).get("q", [""])[0]
            LibraryHandler.queries.append(q)
            body = json.dumps([q, [q + " recipe", q + " history", q]]).encode()
            kind = "application/json"
        elif path.startswith("/page/"):
            name = urllib.parse.unquote(path[len("/page/"):])
            body = f"<!doctype html><meta charset=utf-8><title>{name}</title><p>{name}".encode()
            kind = "text/html; charset=utf-8"
        else:
            body, kind = b"not found", "text/plain"
        self.send_response(200 if kind != "text/plain" else 404)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


URLBAR_ROWS = """return [...document.querySelectorAll("#urlbar-results .urlbar-row")].map(r => ({
  kind: r.className.replace("urlbar-row ", ""), text: r.querySelector(".urlbar-row-primary").textContent,
  selected: r.hasAttribute("selected") }));"""


def part9(bindir, base):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), LibraryHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    site = f"http://127.0.0.1:{server.server_address[1]}"
    LibraryHandler.queries = []
    b = Browser(bindir, prefs={"browserwip.firstrun.completed": True,
                               "browserwip.search.suggest.testURL": site + "/suggest?q="})
    LIB = 'const { Library } = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");'
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        title = lambda: b.js("return gBrowser.selectedBrowser.contentTitle;")

        def visit(name):
            b.js("gBrowser.loadURL(gBrowser.selectedBrowser, arguments[0], "
                 "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", f"{site}/page/{name}")
            return b.wait("return gBrowser.selectedBrowser.contentTitle == arguments[0];", name, timeout=15)

        def type_in_urlbar(text):
            b.js("gURLBar.focusAndSelect();")
            b.js(PW_TYPE, text, None)

        def in_history(name):
            return b.js(LIB + "return Library.history().then(h => h.some(e => e.title == arguments[0]));", name)

        # -- History: kept in Standard, shown on about:history.
        r = b.js(LIB + "return Library.historyEnabled;")
        record(9, "Standard remembers history", r is True, r)
        visit("Pelican facts")
        record(9, "a visited page is in history", b.wait(LIB + "return Library.history().then(h => h.some(e => e.title == 'Pelican facts'));", timeout=10))
        b.js("gBrowser.selectTab(gBrowser.addTab('about:history', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; let h = d?.querySelector('.day-heading');"
                   "return h?.textContent && [h.textContent, [...d.querySelectorAll('.entry-title')].map(e => e.textContent)];", timeout=15)
        record(9, "about:history lists it under Today", r and r[0] == "Today" and "Pelican facts" in r[1], r)
        b.js("gBrowser.removeTab(gBrowser.selectedTab);")

        # -- The dropdown: search first, then the visited page; Enter goes there.
        type_in_urlbar("pelican")
        r = b.wait("return document.getElementById('urlbar-popup').state == 'open' && document.querySelectorAll('#urlbar-results .urlbar-row.page').length > 0 && "
                   "!!document.querySelector('#urlbar-results .urlbar-row-primary').textContent;", timeout=10)
        rows = b.js(URLBAR_ROWS)
        record(9, "typing opens the dropdown: search first (selected), then the page",
               r and rows[0]["kind"] == "heuristic" and rows[0]["selected"] and "pelican" in rows[0]["text"]
               and any(x["kind"] == "page" and x["text"] == "Pelican facts" for x in rows), rows)
        record(9, "with suggestions off, nothing is sent to the search engine", LibraryHandler.queries == [], LibraryHandler.queries)
        record(9, "and it offers them once", any(x["kind"] == "offer" for x in rows), rows)
        visit("Somewhere else")
        type_in_urlbar("pelican")
        b.wait("return document.querySelectorAll('#urlbar-results .urlbar-row.page').length > 0;", timeout=10)
        b.js(PW_TYPE, "", "ArrowDown")
        b.js(PW_TYPE, "", "Enter")
        record(9, "ArrowDown, Enter opens the page", b.wait("return gBrowser.selectedBrowser.contentTitle == 'Pelican facts';", timeout=10), title())

        # Shift+Delete forgets the selected page.
        type_in_urlbar("pelican")
        b.wait("return document.querySelectorAll('#urlbar-results .urlbar-row.page').length > 0;", timeout=10)
        b.js(PW_TYPE, "", "ArrowDown")
        b.js("""let tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
          tip.beginInputTransactionForTests(window);
          tip.keydown(new KeyboardEvent("", { key: "Shift", code: "ShiftLeft" }));
          let del = new KeyboardEvent("", { key: "Delete", code: "Delete", keyCode: KeyboardEvent.DOM_VK_DELETE });
          tip.keydown(del); tip.keyup(del);
          tip.keyup(new KeyboardEvent("", { key: "Shift", code: "ShiftLeft" }));""")
        r = b.wait(LIB + "return Library.history().then(h => !h.some(e => e.title == 'Pelican facts'));", timeout=10)
        record(9, "Shift+Delete in the dropdown forgets the page", r)
        b.js("gURLBar.closePopup(); gBrowser.selectedBrowser.focus();")

        # -- Suggestions: on, only for searches, never for addresses.
        b.js("Services.prefs.setBoolPref('browserwip.search.suggest.enabled', true);")
        type_in_urlbar("bread")
        r = b.wait("return [...document.querySelectorAll('#urlbar-results .urlbar-row.suggestion')].map(r => r.textContent);", timeout=10)
        record(9, "turned on, suggestions come from the engine", r == ["bread recipe", "bread history"], r)
        record(9, "for what was typed", LibraryHandler.queries and LibraryHandler.queries[-1] == "bread", LibraryHandler.queries)
        sent = len(LibraryHandler.queries)
        type_in_urlbar("secret.example.com/path")
        time.sleep(1.2)
        rows = b.js(URLBAR_ROWS)
        record(9, "an address is never sent for suggestions", len(LibraryHandler.queries) == sent and rows and rows[0]["kind"] == "heuristic"
               and rows[0]["text"].startswith("Go to"), [LibraryHandler.queries[sent:], rows[:1]])
        b.js("gURLBar.closePopup(); gBrowser.selectedBrowser.focus();")
        b.js("Services.prefs.setBoolPref('browserwip.search.suggest.enabled', false);")

        # -- Bookmarks: the star, its panel, the bar.
        visit("Heron notes")
        b.wait("return !document.getElementById('star-button').hidden;", timeout=5)
        b.js("document.getElementById('star-button').click();")
        r = b.wait("let p = document.getElementById('bookmark-panel'); return p.state == 'open' && document.getElementById('bookmark-panel-name').value;", timeout=10)
        record(9, "the star bookmarks the page and opens its panel", r == "Heron notes", r)
        b.js("document.getElementById('bookmark-panel-name').value = 'Herons'; document.getElementById('bookmark-panel-done').click();")
        r = b.wait(LIB + "return Library.bookmarkFor(arguments[0]).then(bm => bm && [bm.title, bm.parentGuid == Library.BAR]);", f"{site}/page/Heron notes", timeout=10)
        record(9, "renamed, in the bookmarks bar folder", r == ["Herons", True], r)
        r = b.wait("return document.getElementById('star-button').hasAttribute('starred');", timeout=5)
        record(9, "the star shows the page is bookmarked", r)
        b.js("Services.prefs.setBoolPref('browserwip.bookmarks.bar', true);")
        r = b.wait("let bar = document.getElementById('bookmarks-bar'); return !bar.hidden && [...bar.querySelectorAll('.bookmark-label')].map(l => l.textContent);", timeout=10)
        record(9, "the bookmarks bar shows it", r == ["Herons"], r)
        visit("Somewhere else")
        b.js("document.querySelector('#bookmarks-bar .bookmark-item').click();")
        record(9, "and clicking it opens the page", b.wait("return gBrowser.selectedBrowser.contentTitle == 'Heron notes';", timeout=10), title())

        # -- Strict Privacy: no history; the dropdown has bookmarks only.
        b.js(PM + "PrivacyModes.setMode('strict');")
        r = b.js("return Services.prefs.getBoolPref('places.history.enabled');")
        record(9, "Strict Privacy turns history off", r is False, r)
        visit("Secret visit")
        time.sleep(1.5)
        record(9, "a page visited then isn't kept", not in_history("Secret visit"))
        type_in_urlbar("o")
        b.wait("return document.querySelectorAll('#urlbar-results .urlbar-row.page').length > 0;", timeout=10)
        rows = b.js(URLBAR_ROWS)
        pages = [x["text"] for x in rows if x["kind"] == "page"]
        record(9, "the dropdown then suggests bookmarks, not history", pages == ["Herons"], rows)
        b.js("gURLBar.closePopup(); gBrowser.selectedBrowser.focus();")
        b.js("gBrowser.selectTab(gBrowser.addTab('about:history', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        r = b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.readyState == 'complete' && !d.getElementById('history-off').hidden;", timeout=15)
        record(9, "about:history says history is off", r)
        b.js("gBrowser.removeTab(gBrowser.selectedTab);")
        b.js(PM + "PrivacyModes.setMode('anonymous');")
        record(9, "so does Anonymous", b.js("return Services.prefs.getBoolPref('places.history.enabled');") is False)

        # Settings: the History switch turns it back on (a custom mix then).
        b.js("gBrowser.selectTab(gBrowser.addTab('about:settings', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        S = "let d = gBrowser.selectedBrowser.contentDocument; "
        r = b.wait(S + "return d?.readyState == 'complete' && d.getElementById('history-remember')?.getAttribute('aria-checked');", timeout=15)
        record(9, "Settings shows history off", r == "false", r)
        b.js(S + "d.getElementById('history-remember').click();")
        r = b.wait(PM + S + "return Services.prefs.getBoolPref('places.history.enabled') && "
                   "[d.getElementById('history-remember').getAttribute('aria-checked'), PrivacyModes.mode];", timeout=5)
        record(9, "turning it on there remembers history again (a custom mix)", r and r[0] == "true" and r[1] == "custom", r)

        # Settings' sidebar and search.
        r = b.js(S + """d.querySelector("#settings-nav a[data-section=passwords]").click();
          return new Promise(done => setTimeout(() => done([d.querySelector("#settings-nav a[aria-current]")?.dataset.section,
            d.location.hash, d.querySelectorAll("#settings-nav a[data-section]").length]), 1200));""")
        record(9, "Settings' sidebar goes to a section and marks it", r == ["passwords", "#passwords", 6], r)
        search_rows = S + """let s = d.getElementById("settings-search"); s.value = arguments[0];
          s.dispatchEvent(new d.defaultView.Event("input"));
          return [...d.querySelectorAll(".toggle-row, .inline-row")].filter(row => row.checkVisibility())
            .map(row => row.querySelector("label, .label")?.textContent);"""
        r = b.js(search_rows, "time zone")
        record(9, "searching Settings shows just the settings that match",
               r == ["Look like everyone else", "Report time zone as UTC"], r)
        b.js(search_rows, "no such setting at all")
        r = b.wait(S + "let e = d.getElementById('settings-empty'); return !e.hidden && e.textContent;", timeout=5)
        record(9, "and says when nothing does", bool(r) and "no such setting at all" in r, r)
        r = b.js(S + """let s = d.getElementById("settings-search");
          s.dispatchEvent(new d.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          return [s.value, d.getElementById("settings-empty").hidden,
                  [...d.querySelectorAll("#settings > section")].every(x => x.checkVisibility())];""")
        record(9, "Escape clears the search and brings everything back", r == ["", True, True], r)
        r = b.js(S + """d.getElementById("blocking-pages").click();
          let off = Services.prefs.getBoolPref("browserwip.contentblocking.blockpages.enabled");
          d.getElementById("blocking-pages").click();
          return [off, Services.prefs.getBoolPref("browserwip.contentblocking.blockpages.enabled")];""")
        record(9, "the scam-page switch turns blocking pages off and on", r == [False, True], r)
        b.js(PM + "PrivacyModes.setMode('standard');")
        b.js("gBrowser.removeTab(gBrowser.selectedTab);")

        # The new tab page: a search bar, Favorites (the bookmarks bar, no
        # default tiles), Customize and the privacy report.
        b.js("gBrowser.selectTab(gBrowser.addTab('about:newtab', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        r = b.wait(S + """return d?.body?.hasAttribute("ready") && Library.children(Library.BAR).then(bar => ({
          labels: [...d.querySelectorAll("#favorites .site-label")].map(l => l.textContent),
          bar: bar.filter(i => i.type == "bookmark" && /^https?:/.test(i.url)).map(i => i.title),
          empty: !d.querySelector("#favorites .favorites-empty").hidden }));""".replace("return d?", LIB + "return d?"),
                   timeout=15)
        record(9, "the new tab page's Favorites is the bookmarks bar, with no default tiles",
               bool(r) and r["bar"] and r["labels"] == r["bar"][:16] and not r["empty"], r)
        r = b.js(S + """d.getElementById("customize").click();
          let box = d.querySelector("#customize-panel input[data-section=favorites]");
          box.click();
          return new Promise(done => setTimeout(() => {
            let hidden = d.getElementById("favorites").hidden;
            box.click();
            setTimeout(() => done([hidden, d.getElementById("favorites").hidden,
              Services.prefs.getBoolPref("browserwip.newtab.favorites")]), 500);
          }, 500));""")
        record(9, "Customize hides a section and shows it again", r == [True, False, True], r)
        r = b.js(S + 'const { ProtectionStats } = ChromeUtils.importESModule("resource://gre/modules/browserwip/ProtectionStats.sys.mjs");'
                 """return ProtectionStats.recent(7).then(stats => [!d.getElementById("report").hidden,
                   d.getElementById("report-chart").children.length, stats.trackers,
                   d.getElementById("report-text").textContent]);""")
        record(9, "the privacy report shows the week's count, day by day", r and r[0] and r[1] == 7 and "last 7 days" in r[3], r)
        r = b.js(S + """let input = d.getElementById("search-input");
          return [d.activeElement != input, input.placeholder];""")
        b.js(S + """let input = d.getElementById("search-input"); input.value = arguments[0];
          d.getElementById("search").requestSubmit();""", f"{site}/page/Searched%20from%20home")
        r2 = b.wait("return gBrowser.selectedBrowser.contentTitle == 'Searched from home';", timeout=15)
        record(9, "the search bar opens an address typed into it (the address field keeps focus first)",
               bool(r2) and r[0] and "Search with" in r[1], [r, b.js("return gBrowser.selectedBrowser.contentTitle;")])
        b.js("gBrowser.removeTab(gBrowser.selectedTab);")

        # -- Clearing: everything goes; bookmarks stay.
        visit("Kept for a moment")
        b.wait(LIB + "return Library.history().then(h => h.some(e => e.title == 'Kept for a moment'));", timeout=10)
        b.js("gBrowser.selectTab(gBrowser.addTab('about:history#clear', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        r = b.wait(S + "return d?.readyState == 'complete' && d.getElementById('clear-dialog').open;", timeout=15)
        record(9, "Settings' Clear history opens the dialog on about:history", r)
        b.js(S + "d.querySelector('#clear-range [data-range=all]').click(); d.getElementById('clear-submit').click();")
        r = b.wait(LIB + "return Library.history().then(h => h.length == 0);", timeout=10)
        record(9, "clearing everything empties history", r)
        r = b.js(LIB + "return Library.bookmarkFor(arguments[0]).then(bm => !!bm);", f"{site}/page/Heron notes")
        record(9, "and keeps bookmarks", r is True)
        r = b.wait(S + "let e = d.getElementById('history-empty'); return !e.hidden && e.textContent;", timeout=10)
        record(9, "about:history then says it's empty", r == "Pages you visit will show here.", r)
        b.js("gBrowser.removeTab(gBrowser.selectedTab);")

        # -- about:bookmarks: folders, editing in place, export and import.
        b.js("gBrowser.selectTab(gBrowser.addTab('about:bookmarks', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        r = b.wait(S + "return d?.readyState == 'complete' && d.querySelectorAll('#items .entry').length && "
                   "[d.getElementById('items-heading').textContent, [...d.querySelectorAll('#items .entry-title')].map(e => e.textContent)];", timeout=15)
        record(9, "about:bookmarks opens on the bookmarks bar", r == ["Bookmarks bar", ["Herons"]], r)
        b.js(S + "d.querySelector('#items .entry-more').click();")
        b.js(S + "d.querySelector('#items .menu [data-action=edit]').click();")
        r = b.wait(S + "return !!d.querySelector('#items form.editing');", timeout=5)
        record(9, "Edit turns the row into a form", r)
        b.js(S + "let f = d.querySelector('#items form.editing'); f.querySelector('input').value = 'Grey herons'; "
                 "f.querySelector('[type=url]').value = 'notaurl'; f.querySelector('[type=submit]').click();")
        r = b.wait(S + "let e = d.querySelector('#items form.editing .error'); return e && !e.hidden && e.textContent;", timeout=5)
        record(9, "a bad address is refused", r == "That isn’t a web address.", r)
        b.js(S + "let f = d.querySelector('#items form.editing'); f.querySelector('[type=url]').value = arguments[0]; f.querySelector('[type=submit]').click();",
             f"{site}/page/Grey herons")
        r = b.wait(S + "return !d.querySelector('#items form.editing') && [...d.querySelectorAll('#items .entry-title')].map(e => e.textContent);", timeout=10)
        record(9, "a good one is saved", r == ["Grey herons"], r)
        r = b.wait("return [...document.querySelectorAll('#bookmarks-bar .bookmark-label')].map(l => l.textContent);", timeout=5)
        record(9, "and the bar follows", r == ["Grey herons"], r)
        export = Path(tempfile.mkdtemp(prefix="wip-bm-")) / "bookmarks.html"
        count = b.js(LIB + "return Library.exportHTML(arguments[0]);", str(export))
        text = export.read_text(encoding="utf-8", errors="replace") if export.exists() else ""
        record(9, "export writes the bookmarks as an HTML file", "Grey herons" in text and "/page/Grey%20herons" in text, count)
        b.js(LIB + "return (async () => { let bm = await Library.bookmarkFor(arguments[0]); await Library.removeBookmark(bm.guid); })();",
             f"{site}/page/Grey herons")
        r = b.wait("return document.querySelectorAll('#bookmarks-bar .bookmark-item').length == 0;", timeout=5)
        record(9, "deleting it empties the bar", r)
        b.js(LIB + "return Library.importHTML(arguments[0]);", str(export))
        r = b.wait(LIB + "return Library.searchBookmarks('Grey herons').then(r => r.length);", timeout=10)
        record(9, "importing the file brings it back", r == 1, r)

        log = (b.profile / "browser.log").read_text(errors="replace")
        errors = [l for l in log.splitlines() if re.search(r"Library|bookmarks|urlbar|history", l) and re.search(r"Error|Exception", l)]
        record(9, "no errors from bookmarks, history or the address bar", not errors, errors[:3])
    finally:
        b.quit()
        server.shutdown()


# ---------------------------------------------------------------------------
# Part 10: YouTube ads (opt-in; contentblocking/youtube/)

# Rules written the way uBlock Origin's YouTube rules are.
YT_LIST = r"""! Title: YouTube test rules
www.youtube.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)
www.youtube.com##+js(set, ytInitialPlayerResponse.playerAds, undefined)
www.youtube.com##+js(json-prune-fetch-response, adPlacements playerAds, , propsToMatch, /\/player(\?|$)/)
!#if !cap_html_filtering
www.youtube.com##+js(trusted-replace-xhr-response, '"adPlacements"', '"no_ads"', /\/player(?:\?.+)?$/)
!#else
www.youtube.com##+js(set, wrongBranch, 1)
!#endif
youtube.com##+js(json-prune, playerResponse.adPlacements)
www.youtube.com##+js(rpnt, script, /(\(function serverContract\(\))/, window.__rpnt=1;$1, sedCount, 1, condition, /serverContract|js_ld/)
www.youtube.com##+js(rmnt, script, window\,"fetch")
youtube.com###masthead-ad
youtube-nocookie.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)
example.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)
"""

# A watch page shaped like YouTube's, under its Trusted Types policy. The
# title reports what the page saw.
YT_WATCH = r"""<!doctype html><meta charset="utf-8"><title>loading</title>
<script>var ytInitialPlayerResponse = {"adPlacements":[{"a":1}],"playerAds":[1],"videoDetails":{"videoId":"test"}};</script>
<script>(function serverContract() { window.__contract = 1; })(); /* js_ld */</script>
<script>window.__rmntTarget = 1; // window,"fetch"</script>
<div id="masthead-ad">ad</div>
<script>
(async () => {
  let p = ytInitialPlayerResponse;
  let r = { href: location.href, initial: { ads: p.adPlacements !== undefined || p.playerAds !== undefined, id: p.videoDetails?.videoId } };
  r.contract = window.__contract === 1;
  r.rpnt = window.__rpnt === 1;
  r.rmnt = window.__rmntTarget === undefined;
  r.wrongBranch = window.wrongBranch === 1;
  let player = await (await fetch("/youtubei/v1/player?key=x")).json();
  r.fetchAds = "adPlacements" in player || "playerAds" in player;
  r.fetchKept = player.videoDetails?.videoId == "test";
  let x = new XMLHttpRequest();
  x.open("GET", "/youtubei/v1/player");
  await new Promise(done => { x.onload = done; x.send(); });
  r.xhrAds = x.responseText.includes("adPlacements");
  r.parseAds = "adPlacements" in JSON.parse('{"playerResponse":{"adPlacements":[1]}}').playerResponse;
  r.hidden = getComputedStyle(document.getElementById("masthead-ad")).display == "none";
  r.native = Function.prototype.toString.call(fetch).includes("[native code]");
  document.title = "done " + JSON.stringify(r);
})();
</script>"""

YT_EMBED = r"""<!doctype html><meta charset="utf-8"><title>loading</title>
<script>var ytInitialPlayerResponse = {"adPlacements":[1]};</script>
<script>document.title = "embed " + (ytInitialPlayerResponse.adPlacements !== undefined);</script>"""


class YouTubeHandler(http.server.BaseHTTPRequestHandler):
    """A proxy answering for YouTube and every other host, and the list
    server, reached directly on 127.0.0.1."""

    requests = []
    list_status = 200

    def log_message(self, *args):
        pass

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        YouTubeHandler.requests.append({"path": url.path, "cookie": self.headers.get("Cookie"),
                                        "referer": self.headers.get("Referer")})
        status, headers, body = 200, {"Content-Type": "text/html; charset=utf-8"}, ""
        if url.path.startswith("/__lists/"):
            status = YouTubeHandler.list_status
            headers["Content-Type"] = "text/plain; charset=utf-8"
            body = YT_LIST if status == 200 else "unavailable"
        elif url.path == "/__setcookie":
            headers["Set-Cookie"] = "session=secret; Path=/"
            body = "<!doctype html><title>cookie</title>"
        elif url.path == "/watch":
            headers["Content-Security-Policy"] = "require-trusted-types-for 'script'"
            body = YT_WATCH
        elif url.path.startswith("/youtubei/v1/player"):
            headers["Content-Type"] = "application/json"
            body = json.dumps({"adPlacements": [{"x": 1}], "playerAds": [1], "videoDetails": {"videoId": "test"}})
        elif url.path.startswith("/embed/"):
            body = YT_EMBED
        elif url.path == "/embedder":
            body = '<!doctype html><title>embedder</title><iframe src="http://www.youtube-nocookie.com/embed/x"></iframe>'
        data = body.encode()
        self.send_response(status)
        for k, v in {**headers, "Cache-Control": "no-store", "Content-Length": str(len(data))}.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)


def part10(bindir, base):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), YouTubeHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    YouTubeHandler.requests = []
    YouTubeHandler.list_status = 200
    prefs = {"browserwip.firstrun.completed": True,
             "browserwip.youtubeblocking.lists": f"http://127.0.0.1:{port}/__lists/a.txt http://127.0.0.1:{port}/__lists/b.txt",
             **proxy_prefs(port)}
    YT = 'const { YouTubeBlocking } = ChromeUtils.importESModule("resource://gre/modules/browserwip/YouTubeBlocking.sys.mjs");'
    S = "let d = gBrowser.selectedBrowser.contentDocument;"
    cache = lambda: Path(b.profile, "youtube-blocking.json")
    lists_fetched = lambda: [r for r in YouTubeHandler.requests if r["path"].startswith("/__lists/")]
    loads = [0]
    b = Browser(bindir, prefs=prefs)
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")

        def load(url):
            b.js("gBrowser.loadURL(gBrowser.selectedBrowser, arguments[0], "
                 "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });", url)

        def watch(host="www.youtube.com"):
            loads[0] += 1
            url = f"http://{host}/watch?v=test&n={loads[0]}"
            load(url)
            r = b.wait("let t = gBrowser.selectedBrowser.contentTitle; return t.startsWith('done ') && t.includes(arguments[0]) && t;",
                       f"n={loads[0]}", timeout=20)
            return json.loads(r[5:]) if r else None

        def settings():
            load("about:settings#youtube")
            b.wait(S + "return d?.readyState == 'complete' && d.getElementById('youtube-ads');", timeout=15)

        # -- Off by default.
        r = watch()
        record(10, "off by default: YouTube pages are left alone",
               bool(r) and r["initial"]["ads"] and r["fetchAds"] and r["xhrAds"] and r["parseAds"] and not r["hidden"] and not r["rpnt"], r)
        record(10, "and nothing is downloaded", not lists_fetched(), lists_fetched())

        # -- Settings asks before anything is downloaded.
        load(f"http://127.0.0.1:{port}/__setcookie")
        b.wait("return gBrowser.selectedBrowser.contentTitle == 'cookie';", timeout=10)
        settings()
        b.js(S + "d.getElementById('youtube-ads').click();")
        r = b.wait(S + "return !d.getElementById('youtube-ads-confirm').hidden && d.getElementById('youtube-ads-disclaimer').textContent;", timeout=5)
        record(10, "turning it on first says what gets downloaded, from where and how often",
               bool(r) and "ublockorigin.github.io" in r and "8 hours" in r, r)
        time.sleep(1)
        r = b.js(S + "return [Services.prefs.getBoolPref('browserwip.youtubeblocking.enabled'), d.getElementById('youtube-ads').getAttribute('aria-checked')];")
        record(10, "nothing is downloaded or turned on before agreeing", r == [False, "false"] and not lists_fetched(), r)
        b.js(S + "d.getElementById('youtube-ads-cancel').click();")
        r = b.js(S + "return [d.getElementById('youtube-ads-confirm').hidden, Services.prefs.getBoolPref('browserwip.youtubeblocking.enabled')];")
        record(10, "Cancel leaves it off", r == [True, False] and not lists_fetched(), r)
        b.js(S + "d.getElementById('youtube-ads').click(); d.getElementById('youtube-ads-accept').click();")
        r = b.wait(S + "let s = d.getElementById('youtube-ads-status');"
                   "return !d.getElementById('youtube-ads-status-row').hidden && s.textContent.startsWith('Rules downloaded') && s.textContent;",
                   timeout=20)
        record(10, "agreeing downloads the rules, and Settings says when", bool(r), r)
        got = lists_fetched()
        record(10, "both lists, without cookies or a referrer", len(got) == 2 and not any(g["cookie"] or g["referer"] for g in got), got)
        record(10, "the rules are cached in the profile", cache().exists())

        # -- A YouTube page with the rules.
        r = watch()
        ok = bool(r)
        record(10, "set-constant: ytInitialPlayerResponse loses its ads and keeps the rest",
               ok and not r["initial"]["ads"] and r["initial"]["id"] == "test", r)
        record(10, "json-prune-fetch-response: the player API answer loses its ads", ok and not r["fetchAds"] and r["fetchKept"], r)
        record(10, "trusted-replace-xhr-response, from the !#if branch without HTML filtering",
               ok and not r["xhrAds"] and not r["wrongBranch"], r)
        record(10, "json-prune: JSON.parse", ok and not r["parseAds"], r)
        record(10, "replace-node-text changes an inline script, which still runs under Trusted Types",
               ok and r["rpnt"] and r["contract"], r)
        record(10, "remove-node-text empties one", ok and r["rmnt"], r)
        record(10, "element hiding", ok and r["hidden"], r)
        record(10, "wrapped functions still look native", ok and r["native"], r)

        r = watch("example.com")
        record(10, "other sites are left alone, even when a rule names them", bool(r) and r["initial"]["ads"] and r["fetchAds"], r)
        load("http://example.com/embedder")
        r = b.wait("let t = gBrowser.selectedBrowser.browsingContext.children[0]?.currentWindowGlobal?.documentTitle;"
                   "return t?.startsWith('embed') && t;", timeout=20)
        record(10, "an embedded player (youtube-nocookie.com, its own frame and process) gets its rules", r == "embed false", r)

        watch()
        b.js(IMPORTS + "ContentBlockingAllowList.add(gBrowser.selectedBrowser);")
        r = watch()
        record(10, "turning protections off for YouTube turns this off there too", bool(r) and r["initial"]["ads"] and r["fetchAds"], r)
        b.js(IMPORTS + "ContentBlockingAllowList.remove(gBrowser.selectedBrowser);")

        # -- A failed update keeps the rules in use.
        YouTubeHandler.list_status = 500
        b.js(YT + "return YouTubeBlocking.update();")
        r = b.js(YT + "return YouTubeBlocking.status;")
        record(10, "a failed update keeps the rules in use", r["state"] == "error" and r["updated"] > 0, r)
        r = watch()
        record(10, "and pages still get them", bool(r) and not r["initial"]["ads"], r)
        settings()
        r = b.wait(S + "let s = d.getElementById('youtube-ads-status'); return s.hasAttribute('error') && s.textContent;", timeout=5)
        record(10, "Settings says the update failed and which rules are used", bool(r) and "couldn’t be updated" in r, r)
        YouTubeHandler.list_status = 200

        # -- After a restart: the cached rules at once, no download.
        fetched = len(lists_fetched())
        b.quit()
        b = Browser(bindir, prefs=prefs, profile=b.profile)
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        r = watch()
        record(10, "after a restart the cached rules apply at once, without downloading",
               bool(r) and not r["initial"]["ads"] and len(lists_fetched()) == fetched, r)

        # -- Turning it off.
        settings()
        b.js(S + "d.getElementById('youtube-ads').click();")
        r = b.js(S + "return [Services.prefs.getBoolPref('browserwip.youtubeblocking.enabled'), d.getElementById('youtube-ads-status-row').hidden];")
        record(10, "turning it off needs no confirmation", r == [False, True], r)
        r = watch()
        record(10, "and pages are left alone again", bool(r) and r["initial"]["ads"] and r["fetchAds"], r)
        deadline = time.time() + 5
        while cache().exists() and time.time() < deadline:
            time.sleep(0.2)
        record(10, "and the cached rules are deleted", not cache().exists())
    finally:
        b.quit()
        server.shutdown()


# ---------------------------------------------------------------------------
# Part 11: unlocking passwords with the system keyring (Linux)

def private_bus():
    """A session bus of our own, so the user's keyring is never touched."""
    proc = subprocess.Popen(["dbus-daemon", "--session", "--nofork", "--print-address=1"],
                            stdout=subprocess.PIPE, text=True)
    return proc.stdout.readline().strip(), proc


def bus_has(address, name):
    out = subprocess.run(["dbus-send", f"--bus={address}", "--print-reply", "--dest=org.freedesktop.DBus",
                          "/org/freedesktop/DBus", "org.freedesktop.DBus.NameHasOwner", f"string:{name}"],
                         capture_output=True, text=True)
    return "boolean true" in out.stdout


def keyring_daemon():
    """gnome-keyring-daemon and a library directory for it: BWV_KEYRING_DAEMON
    and BWV_KEYRING_LIBS, else fetch-test-deps.sh's cache, else PATH."""
    if os.environ.get("BWV_KEYRING_DAEMON"):
        return os.environ["BWV_KEYRING_DAEMON"], os.environ.get("BWV_KEYRING_LIBS")
    cached = TEST_DEPS / "root/usr/bin/gnome-keyring-daemon"
    if cached.exists():
        return str(cached), str(TEST_DEPS / "root/usr/lib")
    return shutil.which("gnome-keyring-daemon"), None


def start_keyring(address, work):
    """GNOME Keyring on that bus, unlocked, with its data in `work`. None
    if gnome-keyring-daemon isn't installed (BWV_KEYRING_DAEMON overrides
    where it is, BWV_KEYRING_LIBS adds a library directory)."""
    daemon, libs = keyring_daemon()
    if not daemon:
        return None
    for d in ("data", "run"):
        Path(work, d).mkdir(mode=0o700, exist_ok=True)
    env = {**os.environ, "DBUS_SESSION_BUS_ADDRESS": address,
           "XDG_DATA_HOME": str(Path(work, "data")), "XDG_RUNTIME_DIR": str(Path(work, "run"))}
    if libs:
        env["LD_LIBRARY_PATH"] = libs
    proc = subprocess.Popen([daemon, "--unlock", "--components=secrets", "--foreground"], env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    proc.stdin.write(b"keyring-test-password")
    proc.stdin.close()
    deadline = time.time() + 10
    while not bus_has(address, "org.freedesktop.secrets") and time.time() < deadline:
        time.sleep(0.1)
    return proc


def keyring_generations(address):
    """The generations of this browser's items in the keyring."""
    out = subprocess.run(["secret-tool", "search", "--all", "xdg:schema", "org.browserwip.Vault"],
                         capture_output=True, text=True, env={**os.environ, "DBUS_SESSION_BUS_ADDRESS": address})
    return [line.split("=", 1)[1].strip() for line in (out.stdout + out.stderr).splitlines()
            if line.startswith("attribute.generation")]


def part11(bindir, base):
    if not sys.platform.startswith("linux"):
        skip(11, "the system keyring", "Linux only")
        return
    work = tempfile.mkdtemp(prefix="wip-keyring-")
    master = "correct horse battery staple"
    S = "let d = gBrowser.selectedBrowser.contentDocument;"
    procs = []
    b = None

    def start(address, profile=None):
        browser = Browser(bindir, prefs={"browserwip.firstrun.completed": True}, profile=profile,
                          env={"DBUS_SESSION_BUS_ADDRESS": address})
        browser.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
        browser.js(PV + "return PasswordVault.init();")
        return browser

    def settings(browser):
        browser.js("gBrowser.loadURL(gBrowser.selectedBrowser, 'about:settings#passwords', "
                   "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });")
        browser.wait(S + "return d?.readyState == 'complete' && d.getElementById('passwords-keyring-help')?.textContent;", timeout=15)

    try:
        # -- No keyring on the bus: offered nowhere, and said so in Settings.
        address, bus = private_bus()
        procs.append(bus)
        b = start(address)
        r = b.js(PV + "return PasswordVault.setup(arguments[0], arguments[0]).then(() => PasswordVault.keyring);", master)
        record(11, "without a Secret Service the keyring isn't offered", r == {"available": False, "enrolled": False}, r)
        settings(b)
        r = b.js(S + """let row = d.getElementById("passwords-keyring-row");
          return [row.hidden, d.getElementById("passwords-keyring").disabled, d.getElementById("passwords-keyring-help").textContent];""")
        record(11, "Settings shows the keyring switch, off, and says no keyring is running",
               r[0] is False and r[1] is True and "No system keyring is running" in r[2], r)
        r = b.js(S + "return [d.getElementById('passwords-hello-row').hidden, d.getElementById('passwords-hello-form').hidden];")
        record(11, "and nothing for Windows Hello", r == [True, True], r)
        b.quit()
        b = None

        # -- With GNOME Keyring on a bus of our own.
        address, bus = private_bus()
        procs.append(bus)
        keyring = start_keyring(address, work)
        if not keyring or not bus_has(address, "org.freedesktop.secrets"):
            record(11, "gnome-keyring-daemon starts on the test bus", False, keyring_daemon())
            return
        procs.append(keyring)
        b = start(address)
        b.js('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService)'
             '.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);')
        certificate = make_certificate(work)
        server, site = serve_https("127.0.0.1", certificate)
        b.js(PV + """return PasswordVault.setup(arguments[0], arguments[0]).then(() =>
          PasswordVault.saveLogin({ origin: arguments[1], username: "ana@example.com", password: "hunter2-but-longer" }));""",
             master, site)
        record(11, "a running Secret Service is found", b.js(PV + "return PasswordVault.keyring;") == {"available": True, "enrolled": False})

        settings(b)
        b.js(S + "d.getElementById('passwords-keyring').click();")
        b.wait(S + "return !d.getElementById('passwords-keyring-form').hidden;", timeout=5)
        b.js(S + """d.getElementById("passwords-keyring-master").value = arguments[0];
          d.getElementById("passwords-keyring-submit").click();""", master)
        r = b.wait(S + "let r = d.getElementById('passwords-keyring-result'); return !r.hidden && r.textContent;", timeout=20)
        gens = keyring_generations(address)
        record(11, "Settings turns it on with the master password; one key goes into the keyring",
               bool(r) and "can now unlock" in r and len(gens) == 1, [r, gens])

        b.js(PV + "return PasswordVault.lock();")
        r = b.js(PV + "return PasswordVault.unlockWithKeyring().then(() => [PasswordVault.state, PasswordVault.entries().length], e => e.code);")
        record(11, "the keyring unlocks the vault", r == ["unlocked", 1], r)
        r = b.js(PV + "let [e] = PasswordVault.entries(); return PasswordVault.revealPassword(e.id).then(() => 'revealed', e => e.code);")
        record(11, "showing a password still needs the master password", r != "revealed", r)

        # A click in a login field unlocks through the keyring at once.
        b.js(PV + "return PasswordVault.lock();")
        b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0], "
             "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));", site + "/login")
        b.wait("return gBrowser.selectedBrowser.contentTitle == 'login';", timeout=15)
        b.wait("return !document.getElementById('passwords-button').hidden;", timeout=10)
        b.m.click(60, 55)
        r = b.wait(PV + """let d = document.getElementById("passwords-dropdown");
          return PasswordVault.state == "unlocked" && d.state == "open" && d.textContent.replace(/\\s+/g, " ");""", timeout=15)
        record(11, "a click in a login field unlocks through the keyring and lists the login",
               bool(r) and "ana@example.com" in r, r)
        b.js("document.getElementById('passwords-dropdown').hidePopup();")

        old = keyring_generations(address)
        b.js(PV + "return PasswordVault.replacePrepare(arguments[0]).then(() => PasswordVault.replaceCommit());", master)
        gens = keyring_generations(address)
        record(11, "replacing the key moves the keyring entry to a new generation and deletes the old",
               len(gens) == 1 and gens != old, [old, gens])

        # After a restart, the keyring still unlocks.
        profile = b.profile
        b.quit()
        b = start(address, profile=profile)
        r = b.js(PV + "return PasswordVault.unlockWithKeyring().then(() => PasswordVault.state, e => e.code);")
        record(11, "after a restart the keyring still unlocks", r == "unlocked", r)

        settings(b)
        b.js(S + "d.getElementById('passwords-keyring').click();")
        r = b.wait(PV + "return !PasswordVault.keyring.enrolled;", timeout=10)
        record(11, "turning it off in Settings deletes the keyring entry", bool(r) and not keyring_generations(address),
               keyring_generations(address))
        b.js(PV + "return PasswordVault.lock();")
        r = b.js(PV + "return PasswordVault.unlockWithKeyring().then(() => 'unlocked', e => e.code);")
        record(11, "then only the master password unlocks", r == "keyring-unavailable", r)
        server.shutdown()
    finally:
        if b:
            b.quit()
        for proc in procs:
            proc.terminate()


# -- Part 12: favorite icons on the new tab page (SiteIcons.sys.mjs) ---------


def make_png(width, height, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


TOUCH_PNG = make_png(180, 180, (30, 120, 200))
TAB_PNG = make_png(32, 32, (200, 60, 30))
BIG_ICON_BYTES = 8 * 1024 * 1024
HOSTILE_SVG = """<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"
     onload="fetch('https://beacon.example.test:{port}/onload')">
<style>@import url("https://beacon.example.test:{port}/css");</style>
<script>fetch("https://beacon.example.test:{port}/script");
  new Image().src = "https://beacon.example.test:{port}/script-img";
  top.location = "https://beacon.example.test:{port}/navigate";</script>
<image href="https://beacon.example.test:{port}/image" width="64" height="64"/>
<foreignObject width="64" height="64"><img xmlns="http://www.w3.org/1999/xhtml"
  src="https://beacon.example.test:{port}/foreign"/></foreignObject>
<a href="https://beacon.example.test:{port}/link"><rect width="64" height="64" fill="#00aa00"/></a>
</svg>"""


class IconHandler(http.server.BaseHTTPRequestHandler):
    """Every test site of part 12, told apart by the Host header. Records each
    request with its headers, and how many were in flight at once."""

    requests = []
    lock = threading.Lock()
    inflight = 0
    max_inflight = 0
    big_sent = 0
    port = 0
    plain_port = 0

    def log_message(self, *args):
        pass

    def do_GET(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].lower()
        path = self.path.split("?")[0]
        with IconHandler.lock:
            IconHandler.requests.append({"host": host, "path": path,
                                         "headers": {k.lower(): v for k, v in self.headers.items()}})
            IconHandler.inflight += 1
            IconHandler.max_inflight = max(IconHandler.max_inflight, IconHandler.inflight)
        try:
            self.route(host, path)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError, OSError):
            pass
        finally:
            with IconHandler.lock:
                IconHandler.inflight -= 1

    def send(self, status, kind, body, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def page(self, head="", extra=None):
        self.send(200, "text/html; charset=utf-8",
                  f"<!doctype html><html><head><meta charset=utf-8><title>icons</title>{head}</head><body>hi</body></html>"
                  .encode(), extra)

    def route(self, host, path):
        port, name = IconHandler.port, host.split(".")[0]
        document = self.headers.get("Sec-Fetch-Dest") == "document"
        if host == "good.example.test" and not document and any(
                self.headers.get(h) for h in ("Cookie", "Referer", "Origin")):
            self.send(500, "text/plain", b"cookie, referer or origin sent")
            return
        touch = '<link rel="apple-touch-icon" href="/touch.png">'
        tab = '<link rel="icon" href="/tab.png" sizes="32x32">'
        if path == "/setcookie":
            self.page("", {"Set-Cookie": "session=secret; Secure; SameSite=None; Path=/; Max-Age=3600"})
        elif path == "/":
            if name in ("good", "slow1", "slow2"):
                time.sleep(0.6)
            if name == "stall":
                time.sleep(15)
            heads = {
                "good": touch, "slow1": touch, "slow2": touch, "page": tab, "visit": tab + touch, "shot": tab + touch,
                "privvisit": tab + touch, "noauto": touch, "off": touch, "strict": touch, "privfav": touch,
                "big": '<link rel="apple-touch-icon" href="/big.png">',
                "late": "<!--" + "x" * 70000 + '--><link rel="apple-touch-icon" href="/late.png">',
                "http-icon": f'<link rel="apple-touch-icon" href="http://http-icon.example.test:{IconHandler.plain_port}/i.png">',
                "cdn": f'<link rel="apple-touch-icon" href="https://cdn.other.test:{port}/i.png">',
                "svg": '<link rel="icon" type="image/svg+xml" href="/evil.svg">',
                "g": touch, "stall": touch,
                "single": '<link rel="icon" href="/big-tab.png" sizes="192x192">',
                "strictcdn": tab + f'<link rel="apple-touch-icon" href="https://cdn2.other.test:{port}/touch.png">',
            }
            redirects = {"redir-local": f"https://localhost:{port}/", "redir-private": f"https://inner.example.test:{port}/",
                         "redir-cross": f"https://other.test:{port}/", "a": f"https://b.github.io:{port}/"}
            if name in redirects:
                self.send(302, "text/plain", b"", {"Location": redirects[name]})
            elif name == "fail" and not document:
                self.send(404, "text/plain", b"not found")
            else:
                self.page(heads.get(name, ""))
        elif path == "/touch.png":
            self.send(200, "image/png", TOUCH_PNG)
        elif path == "/tab.png":
            self.send(200, "image/png", TAB_PNG)
        elif path == "/big-tab.png":
            self.send(200, "image/png", TOUCH_PNG)
        elif path == "/evil.svg":
            self.send(200, "image/svg+xml", HOSTILE_SVG.replace("{port}", str(port)).encode())
        elif path == "/big.png":
            # No Content-Length: the 1 MB limit has to stop it mid-stream.
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(TOUCH_PNG[:33])
            block = b"\0" * 65536
            while IconHandler.big_sent < BIG_ICON_BYTES:
                self.wfile.write(block)
                IconHandler.big_sent += len(block)
                time.sleep(0.005)
        else:
            self.send(404, "text/plain", b"not found")


ICON_TEST_HOSTS = [
    "good.example.test", "slow1.example.test", "slow2.example.test", "big.example.test", "late.example.test",
    "redir-local.example.test", "redir-private.example.test", "redir-cross.example.test", "other.test",
    "a.github.io", "b.github.io", "http-icon.example.test", "cdn.example.test", "cdn.other.test",
    "stall.example.test", "svg.example.test", "beacon.example.test", "g.doubleclick.net", "fail.example.test",
    "page.example.test", "visit.example.test", "privvisit.example.test", "privfav.example.test",
    "strict.example.test", "off.example.test", "noauto.example.test", "shot.example.test",
    "single.example.test", "strictcdn.example.test", "cdn2.other.test", "imported.example.test",
]
# Resolve to 127.0.0.1 too, but aren't test hosts: private addresses.
ICON_PRIVATE_HOSTS = ["inner.example.test", "lan.example.test"]
SI = 'const { SiteIcons } = ChromeUtils.importESModule("resource://gre/modules/browserwip/SiteIcons.sys.mjs");'


class RequestLogProxy(http.server.BaseHTTPRequestHandler):
    """A proxy that forwards nothing: it writes down every request the
    browser makes, plain or CONNECT, and refuses it."""

    log = []

    def log_message(self, *args):
        pass

    def refuse(self):
        RequestLogProxy.log.append(f"{self.command} {self.path}")
        self.send_response(403)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = do_HEAD = do_CONNECT = do_PUT = do_OPTIONS = refuse


def part12_first_run(bindir):
    """A fresh profile with every default: start, open a new tab, wait. The
    browser must not contact any site (nothing was chosen yet)."""
    port = free_port()
    proxy = http.server.ThreadingHTTPServer(("127.0.0.1", port), RequestLogProxy)
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    log_dir = Path(tempfile.mkdtemp(prefix="wip-firstrun-log-"))
    RequestLogProxy.log = []
    prefs = {"network.proxy.type": 1, "network.proxy.http": "127.0.0.1", "network.proxy.http_port": port,
             "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": port, "network.proxy.no_proxies_on": "",
             "network.proxy.allow_hijacking_localhost": True}
    b = Browser(bindir, prefs=prefs, env={"MOZ_LOG": "nsHostResolver:5", "MOZ_LOG_FILE": str(log_dir / "dns.log")})
    empty = None
    try:
        b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';", timeout=60)
        first = b.js("return gBrowser.selectedBrowser.currentURI.spec;")
        b.js("gBrowser.selectTab(gBrowser.addTab('about:newtab', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.body?.hasAttribute('ready');", timeout=15)
        b.wait("""let d = gBrowser.selectedBrowser.contentDocument;
          return d.getElementById("favorites-hint").textContent && d.getElementById("import-bookmarks").textContent;""",
               timeout=10)
        empty = b.js("""let d = gBrowser.selectedBrowser.contentDocument;
          return { tiles: d.querySelectorAll("#favorites .site").length,
                   shown: !d.getElementById("favorites").hidden && !d.querySelector("#favorites .favorites-empty").hidden,
                   hint: d.getElementById("favorites-hint").textContent,
                   button: d.getElementById("import-bookmarks").textContent };""")
        time.sleep(20)
    finally:
        b.quit()
        proxy.shutdown()
    lookups = []
    for f in log_dir.glob("dns.log*"):
        for line in f.read_text(errors="replace").splitlines():
            m = re.search(r"Resolving host \[([^\]]+)\]", line)
            if m and m.group(1) not in lookups:
                lookups.append(m.group(1))
    shutil.rmtree(log_dir, ignore_errors=True)
    print("     first-run request log (proxy, every HTTP/HTTPS request):")
    for line in RequestLogProxy.log or ["(empty)"]:
        print("       " + line)
    print("     first-run DNS lookups (nsHostResolver log):")
    for host in lookups or ["(none)"]:
        print("       " + host)
    record(12, "first run: a fresh profile, a new tab, 20 s: no request to any site and no DNS lookup",
           not RequestLogProxy.log and not lookups, [first, RequestLogProxy.log, lookups])
    record(12, "no default tiles: Favorites shows the hint and Import bookmarks",
           bool(empty) and empty["tiles"] == 0 and empty["shown"] and "letter until you visit" in empty["hint"]
           and empty["button"] == "Import bookmarks…", empty)


def part12_session(bindir, port, env, extra_prefs=None):
    prefs = {"browserwip.firstrun.completed": True,
             "network.dns.localDomains": ",".join(ICON_TEST_HOSTS + ICON_PRIVATE_HOSTS),
             "browserwip.newtab.siteIcons.testHosts": ",".join(ICON_TEST_HOSTS), **(extra_prefs or {})}
    b = Browser(bindir, prefs=prefs, env=env)
    b.wait("return gBrowser?.selectedTab && document.readyState == 'complete';")
    b.js('Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService)'
         '.setDisableAllSecurityChecksAndLetAttackersInterceptMyData(true);')
    b.js("window.resizeTo(1280, 860);")
    origin = lambda host: f"https://{host}:{port}"

    def add(host, title=None):
        return b.js("return PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.toolbarGuid, "
                    "url: arguments[0], title: arguments[1] }).then(() => true);", origin(host) + "/", title or host)

    def entry(host):
        return b.js(SI + """return SiteIcons._load().then(() => {
          let e = SiteIcons._cache[arguments[0]];
          return e ? { src: e.src ? e.src.slice(0, 22) : null, touch: !!e.touch, failed: !!e.failed } : null; });""",
                    origin(host))

    def wait_entry(host, timeout=15):
        return b.wait(SI + """return SiteIcons._load().then(() => {
          let e = SiteIcons._cache[arguments[0]];
          return e ? { src: e.src ? e.src.slice(0, 22) : null, touch: !!e.touch, failed: !!e.failed } : null; });""",
                      origin(host), timeout=timeout)

    def load(url):
        b.js("gBrowser.selectTab(gBrowser.addTab(arguments[0], "
             "{ triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));", url)
        return b.wait("return gBrowser.selectedBrowser.contentTitle == 'icons';", timeout=15)

    return b, origin, add, entry, wait_entry, load


def hits(host, path=None):
    return [r for r in IconHandler.requests if r["host"] == host and (path is None or r["path"] == path)]


def newtab_shot(b, shots, name, customize=True):
    b.js('Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService);')
    b.js("gBrowser.selectTab(gBrowser.addTab('about:newtab', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
    b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.body?.hasAttribute('ready');", timeout=15)
    time.sleep(1)
    if customize:
        b.js("gBrowser.selectedBrowser.contentDocument.getElementById('customize').click();")
        time.sleep(0.5)
    b.wait("""let box = gBrowser.selectedBrowser.contentDocument.getElementById("site-icons");
      return !!Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService).getAccessibleFor(box);""",
           timeout=10)
    state = b.js("""let d = gBrowser.selectedBrowser.contentDocument, box = d.getElementById("site-icons");
      let acc = Cc["@mozilla.org/accessibilityService;1"].getService(Ci.nsIAccessibilityService).getAccessibleFor(box);
      return { checked: box.checked, disabled: box.disabled, note: !d.getElementById("site-icons-note").hidden,
               describedby: box.getAttribute("aria-describedby"), a11yName: acc?.name, a11yDescription: acc?.description,
               tiles: [...d.querySelectorAll("#favorites .site")].map(t => t.textContent.trim() + ":" +
                 (t.querySelector(".site-icon").classList.contains("letter") ? "letter" : "image")) };""")
    if shots:
        b.m.screenshot(str(Path(shots) / f"{name}.png"))
    b.js("gBrowser.removeTab(gBrowser.selectedTab);")
    return state


def part12(bindir, base, shots):
    part12_first_run(bindir)
    work = tempfile.mkdtemp(prefix="wip-icons-")
    certificate = make_certificate(work)
    if not certificate:
        record(12, "openssl makes the test server's certificate", False, "openssl not found or failed")
        return
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), IconHandler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(*certificate)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    plain = http.server.ThreadingHTTPServer(("127.0.0.1", 0), IconHandler)
    for srv in (server, plain):
        threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = IconHandler.port = server.server_address[1]
    IconHandler.plain_port = plain.server_address[1]
    IconHandler.requests = []
    automation = {"BWV_AUTOMATION": "1"}
    try:
        part12_fetch(bindir, port, automation, shots)
        part12_private(bindir, port, automation, shots)
        part12_no_automation(bindir, port)
    finally:
        server.shutdown()
        plain.shutdown()
        shutil.rmtree(work, ignore_errors=True)


def part12_fetch(bindir, port, env, shots):
    b, origin, add, entry, wait_entry, load = part12_session(bindir, port, env)
    try:
        r = b.js(SI + "return [Services.prefs.getBoolPref('browserwip.newtab.siteIcons'), SiteIcons.blockedReason(false)];")
        record(12, "the setting is off by default", r == [False, "pref"], r)

        # -- Off: adding a favorite fetches nothing.
        add("off.example.test")
        time.sleep(3)
        record(12, "with the setting off, adding a favorite fetches nothing",
               not hits("off.example.test") and entry("off.example.test") is None, [hits("off.example.test"), entry("off.example.test")])

        # -- A visit: the page's own largest icon, with the setting off.
        add("visit.example.test")
        load(origin("visit.example.test") + "/")
        r = wait_entry("visit.example.test")
        record(12, "visiting a favorite keeps the icon the page loaded, its apple-touch-icon (setting off)",
               bool(r) and r["src"] == "data:image/png;base64," and r["touch"], r)
        # The tab icon already is the largest: no second request for it.
        add("single.example.test")
        load(origin("single.example.test") + "/")
        r = wait_entry("single.example.test")
        time.sleep(1)
        record(12, "on a visit, no second image request when the tab icon already is the largest",
               bool(r) and r["src"] == "data:image/png;base64," and len(hits("single.example.test", "/big-tab.png")) == 1,
               [r, [x["path"] for x in hits("single.example.test")]])
        shot_state = newtab_shot(b, shots, "newtab-standard-off")
        record(12, "Standard, setting off: unchecked, enabled, no note",
               shot_state["checked"] is False and not shot_state["disabled"] and not shot_state["note"]
               and not shot_state["describedby"] and "contacts each site" in (shot_state["a11yName"] or ""), shot_state)

        b.js("Services.prefs.setBoolPref('browserwip.newtab.siteIcons', true);")
        shot_state = newtab_shot(b, shots, "newtab-standard-on")
        record(12, "Standard, setting on: checked, enabled", shot_state["checked"] and not shot_state["disabled"], shot_state)

        # -- From the page you're on: the tab's icon, no fetch.
        load(origin("page.example.test") + "/")
        b.wait("return !!gBrowser.selectedTab.favicon;", timeout=10)
        before = len(hits("page.example.test"))
        b.js("BookmarksUI.bookmarkPage();")
        r = wait_entry("page.example.test")
        b.js("document.getElementById('bookmark-panel')?.hidePopup?.();")
        time.sleep(1)
        record(12, "adding a favorite from the page you're on uses the icon the page loaded: no fetch",
               bool(r) and r["src"] == "data:image/png;base64," and len(hits("page.example.test")) == before,
               [r, hits("page.example.test")[before:]])

        # -- A typed favorite: one fetch, no Cookie, Referer or Origin.
        load(origin("good.example.test") + "/setcookie")
        cookies = b.js("return Services.cookies.getCookiesFromHost('good.example.test', {}).length;")
        IconHandler.max_inflight = 0
        mark = len(IconHandler.requests)
        for host in ("good.example.test", "slow1.example.test", "slow2.example.test"):
            add(host)
        r = wait_entry("good.example.test")
        r2 = wait_entry("slow2.example.test")
        fetched = [(x["host"], x["path"]) for x in IconHandler.requests[mark:]]
        record(12, "a typed favorite gets one fetch: its home page, then its apple-touch-icon",
               bool(r) and r["touch"] and [p for h, p in fetched if h == "good.example.test"] == ["/", "/touch.png"], [r, fetched])
        leaked = [{k: v for k, v in x["headers"].items() if k in ("cookie", "referer", "origin")}
                  for x in IconHandler.requests[mark:] if x["host"] == "good.example.test"]
        record(12, "it sends no Cookie, Referer or Origin (the site had a cookie set)",
               cookies > 0 and leaked and not any(leaked), [cookies, leaked])
        record(12, "favorites are fetched one at a time", bool(r2) and IconHandler.max_inflight == 1,
               [IconHandler.max_inflight, fetched])
        mark = len(IconHandler.requests)
        b.js(SI + "return SiteIcons._added(arguments[0]).then(() => true);", origin("good.example.test") + "/")
        for _ in range(2):
            b.js("gBrowser.selectTab(gBrowser.addTab('about:newtab', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
            b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.body?.hasAttribute('ready');", timeout=15)
        time.sleep(3)
        tile = b.js("""let t = [...gBrowser.selectedBrowser.contentDocument.querySelectorAll("#favorites .site")]
          .find(t => t.textContent.includes("good.example.test")); return t?.querySelector(".site-icon").className;""")
        record(12, "after that: another add event and new tabs fetch nothing; the tile shows the icon",
               IconHandler.requests[mark:] == [] and tile == "site-icon touch",
               [[(x["host"], x["path"]) for x in IconHandler.requests[mark:]], tile])
        b.js("for (let t of gBrowser.tabs.slice(1)) gBrowser.removeTab(t);")

        # -- Limits.
        add("big.example.test")
        r = wait_entry("big.example.test", timeout=20)
        record(12, "an oversized icon (8 MB, no Content-Length) is refused and the download stops early",
               bool(r) and r["failed"] and hits("big.example.test", "/big.png") and IconHandler.big_sent < BIG_ICON_BYTES,
               [r, IconHandler.big_sent])
        add("late.example.test")
        r = wait_entry("late.example.test")
        record(12, "only the first 64 KB of the home page is read: a later icon link isn't seen",
               bool(r) and r["failed"] and hits("late.example.test", "/") and not hits("late.example.test", "/late.png"),
               [r, [x["path"] for x in hits("late.example.test")]])
        add("redir-local.example.test")
        r = wait_entry("redir-local.example.test")
        record(12, "a redirect to localhost is refused (the server never sees a request for localhost)",
               bool(r) and r["failed"] and not hits("localhost"), [r, hits("localhost")])
        add("redir-private.example.test")
        r = wait_entry("redir-private.example.test")
        record(12, "a redirect to a same-site name on a private address is refused",
               bool(r) and r["failed"] and not hits("inner.example.test"), [r, hits("inner.example.test")])
        add("redir-cross.example.test")
        r = wait_entry("redir-cross.example.test")
        record(12, "a redirect to another site is refused", bool(r) and r["failed"] and not hits("other.test"),
               [r, hits("other.test")])
        add("a.github.io")
        r = wait_entry("a.github.io")
        record(12, "a.github.io redirecting to b.github.io is refused (public suffix list, private section)",
               bool(r) and r["failed"] and not hits("b.github.io"), [r, hits("b.github.io")])
        add("http-icon.example.test")
        r = wait_entry("http-icon.example.test")
        record(12, "an icon over HTTP is skipped", bool(r) and r["failed"] and not hits("http-icon.example.test", "/i.png"),
               [r, [x["path"] for x in hits("http-icon.example.test")]])
        add("cdn.example.test")
        r = wait_entry("cdn.example.test")
        record(12, "an icon on another domain is skipped", bool(r) and r["failed"] and not hits("cdn.other.test"),
               [r, hits("cdn.other.test")])
        started = time.time()
        add("stall.example.test")
        r = wait_entry("stall.example.test", timeout=30)
        elapsed = time.time() - started
        record(12, "a server that stalls is given up after 10 s", bool(r) and r["failed"] and 9 <= elapsed <= 13,
               [r, round(elapsed, 1)])
        add("svg.example.test")
        r = wait_entry("svg.example.test")
        time.sleep(2)
        record(12, "a hostile SVG becomes a plain PNG: no script runs, nothing it names is requested",
               bool(r) and r["src"] == "data:image/png;base64," and not hits("beacon.example.test"),
               [r, [x["path"] for x in hits("beacon.example.test")]])
        b.wait(BLOCKER_STATE + " return state == 'ready';", timeout=30)
        add("g.doubleclick.net")
        r = wait_entry("g.doubleclick.net")
        record(12, "the network blocker sees the fetch: a favorite on a blocked host is never contacted",
               bool(r) and r["failed"] and not hits("g.doubleclick.net"), [r, hits("g.doubleclick.net")])
        b.js("return PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.toolbarGuid, "
             "url: 'https://printer.local:' + arguments[0] + '/', title: 'printer' }).then(() => true);", port)
        add("lan.example.test")
        r = wait_entry("lan.example.test")
        r2 = b.js(SI + "return SiteIcons._load().then(() => SiteIcons._cache[arguments[0]] ?? null);", f"https://printer.local:{port}")
        record(12, "LAN and private-address favorites get no fetch", bool(r) and r["failed"] and not hits("lan.example.test")
               and not hits("printer.local"), [r, r2, hits("lan.example.test")])

        # -- A failure is remembered until the next visit.
        add("fail.example.test")
        r = wait_entry("fail.example.test")
        mark = len(IconHandler.requests)
        b.js(SI + "return SiteIcons._added(arguments[0]).then(() => true);", origin("fail.example.test") + "/")
        time.sleep(1)
        again = IconHandler.requests[mark:]
        load(origin("fail.example.test") + "/")
        r2 = b.wait(SI + "return SiteIcons._load().then(() => !SiteIcons._cache[arguments[0]]);", origin("fail.example.test"), timeout=10)
        record(12, "one attempt per favorite: a failure is remembered, then forgotten on the next visit",
               bool(r) and r["failed"] and not again and r2, [r, again, r2])

        # -- Imported bookmarks: never fetched for, letter tiles until visited.
        html = Path(tempfile.mkdtemp(prefix="wip-import-")) / "bookmarks.html"
        html.write_text("<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n<DT><H3 PERSONAL_TOOLBAR_FOLDER=\"true\">Bar</H3>\n"
                        f"<DL><p>\n<DT><A HREF=\"{origin('imported.example.test')}/\">Imported</A>\n</DL><p>\n</DL><p>\n")
        b.js("""const { Library } = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");
          return Library.importHTML(arguments[0]).then(() => true);""", str(html))
        time.sleep(3)
        b.js("gBrowser.selectTab(gBrowser.addTab('about:newtab', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }));")
        b.wait("let d = gBrowser.selectedBrowser.contentDocument; return d?.body?.hasAttribute('ready');", timeout=15)
        # The bar has more than the 16 tiles shown by now: ask the page which
        # icon it would draw for the imported one (null: a letter tile).
        icon = b.js("""let url = arguments[0];
          return gBrowser.selectedBrowser.contentWindow.wrappedJSObject.siteIcon({ url, pages: [url] })
            .then(i => i && i.src.slice(0, 22));""", origin("imported.example.test") + "/")
        b.js("gBrowser.removeTab(gBrowser.selectedTab);")
        record(12, "imported favorites are never fetched for and get a letter tile (setting on)",
               not hits("imported.example.test") and entry("imported.example.test") is None and icon is None,
               [hits("imported.example.test"), icon])

        # -- Strict and Anonymous: off, and the checkbox says so.
        b.js(IMPORTS + "PrivacyModes.setMode('strict');")
        add("strictcdn.example.test")
        load(origin("strictcdn.example.test") + "/")
        r = wait_entry("strictcdn.example.test")
        time.sleep(1)
        record(12, "in Strict, a visit doesn't load a favorite's icon from another domain (the tab icon is kept)",
               bool(r) and r["src"] == "data:image/png;base64," and not r["touch"] and not hits("cdn2.other.test"),
               [r, hits("cdn2.other.test")])
        add("strict.example.test")
        time.sleep(3)
        record(12, "in Strict, adding a favorite fetches nothing (setting on)",
               not hits("strict.example.test") and entry("strict.example.test") is None, hits("strict.example.test"))
        shot_state = newtab_shot(b, shots, "newtab-strict")
        record(12, "Strict: unchecked, disabled, and the note is the checkbox's description for screen readers",
               shot_state["checked"] is False and shot_state["disabled"] and shot_state["note"]
               and shot_state["describedby"] == "site-icons-note"
               and shot_state["a11yDescription"] == "Off in Strict privacy and private windows.", shot_state)
        b.js(IMPORTS + "PrivacyModes.setMode('anonymous');")
        shot_state = newtab_shot(b, shots, "newtab-anonymous")
        record(12, "Anonymous: the same", shot_state["disabled"] and shot_state["note"]
               and shot_state["a11yDescription"] == "Off in Strict privacy and private windows.", shot_state)
        b.js(IMPORTS + "PrivacyModes.setMode('standard');")

        # -- Deleting a favorite deletes its icon; Clear history -> All clears them all.
        b.js("""return PlacesUtils.bookmarks.fetch({ url: arguments[0] }).then(bm => PlacesUtils.bookmarks.remove(bm)).then(() => true);""",
             origin("good.example.test") + "/")
        r = b.wait(SI + "return SiteIcons._load().then(() => !SiteIcons._cache[arguments[0]]);", origin("good.example.test"), timeout=10)
        record(12, "deleting a favorite deletes its icon", r, entry("good.example.test"))
        b.js("""const { Library } = ChromeUtils.importESModule("resource://gre/modules/browserwip/Library.sys.mjs");
          return Library.clearHistory("all").then(() => true);""")
        r = b.js(SI + """return SiteIcons._load().then(async () => [Object.keys(SiteIcons._cache).length,
          await IOUtils.exists(PathUtils.join(PathUtils.profileDir, "favorite-icons.json"))]);""")
        record(12, "Clear history -> All clears the icon cache", r == [0, False], r)
    finally:
        b.quit()


def part12_private(bindir, port, env, shots):
    """Private browsing (this browser has no private-window command; Gecko's
    permanent private browsing makes every window private)."""
    b, origin, add, entry, wait_entry, load = part12_session(
        bindir, port, env, {"browser.privatebrowsing.autostart": True, "browserwip.newtab.siteIcons": True})
    try:
        r = b.js("return PrivateBrowsingUtils.isWindowPrivate(window);")
        record(12, "permanent private browsing makes the window private", r is True, r)
        add("privfav.example.test")
        time.sleep(3)
        record(12, "in a private window, adding a favorite fetches nothing (setting on)",
               not hits("privfav.example.test") and entry("privfav.example.test") is None, hits("privfav.example.test"))
        add("privvisit.example.test")
        load(origin("privvisit.example.test") + "/")
        time.sleep(3)
        shot_state = newtab_shot(b, shots, "newtab-private")
        record(12, "and a visit there keeps no icon, in the new tab cache or in history",
               entry("privvisit.example.test") is None
               and any(t.endswith("privvisit.example.test:letter") for t in shot_state["tiles"]),
               [entry("privvisit.example.test"), shot_state["tiles"]])
        record(12, "private window: unchecked, disabled, with the note as its description",
               shot_state["checked"] is False and shot_state["disabled"]
               and shot_state["a11yDescription"] == "Off in Strict privacy and private windows.", shot_state)
    finally:
        b.quit()


def part12_no_automation(bindir, port):
    """The test-hosts pref without BWV_AUTOMATION: ignored, so the test
    server's private address is refused like any other."""
    b, origin, add, entry, wait_entry, load = part12_session(bindir, port, {"BWV_AUTOMATION": ""},
                                                            {"browserwip.newtab.siteIcons": True})
    try:
        add("noauto.example.test")
        r = wait_entry("noauto.example.test")
        record(12, "without the automation variable the test-hosts pref is ignored: a private address is refused",
               bool(r) and r["failed"] and not hits("noauto.example.test"), [r, hits("noauto.example.test")])
    finally:
        b.quit()


def set_path():
    """The runner's own PATH: fetch-test-deps.sh's cache first, then the
    caller's."""
    os.environ["PATH"] = os.pathsep.join([str(TEST_DEPS / "root/usr/bin"), os.environ.get("PATH", "")])


def preflight(parts):
    """Every tool the chosen parts need, or a clear message and exit 2
    before anything starts."""
    need = {}
    linux = sys.platform.startswith("linux")
    if linux and 2 in parts:
        need["strace"] = "part 2 (network silence)"
    if linux and 11 in parts:
        for tool in ("dbus-daemon", "dbus-send", "secret-tool"):
            need[tool] = "part 11 (system keyring)"
    if sys.platform != "win32" and (8 in parts or 12 in parts):
        need["openssl"] = "parts 8 and 12 (HTTPS test servers)"
    missing = [f"{tool} — {why}" for tool, why in need.items() if not shutil.which(tool)]
    if linux and 11 in parts and not keyring_daemon()[0]:
        missing.append("gnome-keyring-daemon — part 11 (system keyring)")
    if missing:
        print("check.py: missing tools, nothing was run:", file=sys.stderr)
        for line in missing:
            print("  " + line, file=sys.stderr)
        print(f"Run tools/runtime/fetch-test-deps.sh (it fills {TEST_DEPS}), "
              "or install them with the system's package manager, or leave those parts out with --part.",
              file=sys.stderr)
        sys.exit(2)


def summary(selected):
    print("\nSummary by part (ok / failed / skipped):")
    for part in ALL_PARTS:
        results = [r for r in RESULTS if r[0] == part]
        if part not in selected:
            print(f"  part {part:2}: not run")
            continue
        counts = {k: sum(1 for r in results if r[2] == k) for k in ("ok", "failed", "skipped")}
        line = f"  part {part:2}: {counts['ok']} ok, {counts['failed']} failed, {counts['skipped']} skipped"
        print(line + ("  (recorded nothing)" if not results else ""))
        for r in results:
            if r[2] != "ok":
                print(f"           {r[2]}: {r[1]}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bindir")
    parser.add_argument("--part", type=int, nargs="*", default=ALL_PARTS)
    parser.add_argument("--shots", help="directory for screenshots")
    args = parser.parse_args()
    set_path()
    preflight(args.part)
    if args.shots:
        Path(args.shots).mkdir(parents=True, exist_ok=True)
    base = serve_pages()
    parts = {1: lambda: part1(args.bindir, base), 2: lambda: part2(args.bindir, base),
             3: lambda: part3(args.bindir, base, args.shots), 4: lambda: part4(args.bindir, base, args.shots),
             5: lambda: part5(args.bindir, base), 6: lambda: part6(args.bindir, base),
             7: lambda: part7(args.bindir, base), 8: lambda: part8(args.bindir, base, args.shots),
             9: lambda: part9(args.bindir, base), 10: lambda: part10(args.bindir, base),
             11: lambda: part11(args.bindir, base), 12: lambda: part12(args.bindir, base, args.shots)}
    for p in args.part:
        try:
            parts[p]()
        except Exception as e:  # a crash in one part shouldn't hide the others
            record(p, "check run completed", False, repr(e))
    summary(args.part)
    failed = [r for r in RESULTS if r[2] == "failed"]
    skipped = [r for r in RESULTS if r[2] == "skipped"]
    ok = len(RESULTS) - len(failed) - len(skipped)
    print(f"\n{ok} ok, {len(failed)} failed, {len(skipped)} skipped, of {len(RESULTS)} checks")
    sys.exit(1 if failed or any(not any(r[0] == p for r in RESULTS) for p in args.part) else 0)


if __name__ == "__main__":
    main()
