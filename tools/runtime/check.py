#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Runtime checks against a built browser-wip.

    python3 -I tools/runtime/check.py <dist/bin> [--part 1 2 3 4 5 6 7 8] [--shots DIR]

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
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
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
        record(4, "switching tabs in the strip moves the overview's ring", ring is True, ring)
        added = b.js("""let before = gBrowser.tabs.length;
          document.querySelector("#tab-overview-grid .overview-new").click();
          return { added: gBrowser.tabs.length - before, open: !document.getElementById("tab-overview").hidden,
                   cards: document.querySelectorAll("#tab-overview-grid .overview-card").length - 1,
                   tabs: gBrowser.tabs.length };""")
        b.js("TabOverview.close();")
        record(4, "adding a tab from the overview keeps it open, with a card for the new tab",
               added["added"] == 1 and added["open"] and added["cards"] == added["tabs"], added)

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
            record(4, f"{name} can go fullscreen, with the bars hidden and the site named",
                   isinstance(entered, dict) and entered["barsHidden"] and entered["warning"], entered)
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

        # Top-level pages are not blocked in this phase ($document rules).
        for c in (c for c in hand if c["kind"] == "document"):
            b.js(WATCH_REQUESTS)
            index = b.js("return gBrowser.tabs.indexOf(gBrowser.addTab(arguments[0]));", c["url"])
            time.sleep(3)
            o = b.js(OUTCOMES, [c["url"]])[c["url"]]
            spec = b.js("return gBrowser.tabs[arguments[0]].linkedBrowser.currentURI.spec;", index)
            record(7, f"{c['id']}: a top-level page matching a $document rule still loads",
                   o["verdict"] == "allow" and spec == c["url"], [o, spec])

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
        secrets.append(b.js(S + "return d.getElementById('passwords-recovery-code').textContent;"))
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

        log = (b.profile / "browser.log").read_text(errors="replace")
        leaked = [s for s in secrets if s and s in log]
        record(8, "no secrets in the browser log", not leaked, f"{len(leaked)} found")
    finally:
        b.quit()
    try:
        part8_frame(bindir, site, other_host)
    finally:
        for server, _ in servers:
            server.shutdown()
        shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bindir")
    parser.add_argument("--part", type=int, nargs="*", default=[1, 2, 3, 4, 5, 6, 7, 8])
    parser.add_argument("--shots", help="directory for screenshots")
    args = parser.parse_args()
    if args.shots:
        Path(args.shots).mkdir(parents=True, exist_ok=True)
    base = serve_pages()
    parts = {1: lambda: part1(args.bindir, base), 2: lambda: part2(args.bindir, base),
             3: lambda: part3(args.bindir, base, args.shots), 4: lambda: part4(args.bindir, base, args.shots),
             5: lambda: part5(args.bindir, base), 6: lambda: part6(args.bindir, base),
             7: lambda: part7(args.bindir, base), 8: lambda: part8(args.bindir, base, args.shots)}
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
