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
    "urlclassifier.trackingTable": "wip-ads-digest256,wip-track-digest256",
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bindir")
    parser.add_argument("--part", type=int, nargs="*", default=[1, 2, 3, 4, 5])
    parser.add_argument("--shots", help="directory for screenshots")
    args = parser.parse_args()
    if args.shots:
        Path(args.shots).mkdir(parents=True, exist_ok=True)
    base = serve_pages()
    parts = {1: lambda: part1(args.bindir, base), 2: lambda: part2(args.bindir, base),
             3: lambda: part3(args.bindir, base, args.shots), 4: lambda: part4(args.bindir, base, args.shots),
             5: lambda: part5(args.bindir, base)}
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
