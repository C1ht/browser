# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Minimal Marionette client: enough to run privileged JavaScript in the
browser's chrome context for automated checks.

Wire format: each message is "<length>:<json>". Commands are
[0, id, name, params]; replies are [1, id, error, result].
"""

import json
import socket
import time


class MarionetteError(Exception):
    pass


class Marionette:
    def __init__(self, port=2828, timeout=60):
        deadline = time.time() + timeout
        while True:
            try:
                self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
                break
            except OSError:
                if time.time() > deadline:
                    raise
                time.sleep(0.5)
        self.sock.settimeout(120)
        self._id = 0
        self._buf = b""
        hello = self._read()
        if hello.get("marionetteProtocol") != 3:
            raise MarionetteError(f"unexpected handshake: {hello}")
        self.command("WebDriver:NewSession", {"capabilities": {}})
        self.command("Marionette:SetContext", {"value": "chrome"})

    def _read(self):
        while True:
            if b":" in self._buf:
                head, _, rest = self._buf.partition(b":")
                length = int(head)
                if len(rest) >= length:
                    self._buf = rest[length:]
                    return json.loads(rest[:length])
            self._recv()

    def _recv(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise MarionetteError("connection closed")
        self._buf += chunk

    def command(self, name, params=None):
        self._id += 1
        data = json.dumps([0, self._id, name, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b":" + data)
        while True:
            reply = self._read()
            if isinstance(reply, list) and reply[0] == 1 and reply[1] == self._id:
                break
        _, _, error, result = reply
        if error:
            raise MarionetteError(f"{name}: {error.get('error')}: {error.get('message')}")
        return result

    def js(self, script, *args):
        """Run `script` as a function body in the chrome window. A returned
        promise is awaited."""
        result = self.command(
            "WebDriver:ExecuteScript",
            {"script": script, "args": list(args), "newSandbox": False},
        )
        return result.get("value") if isinstance(result, dict) else result

    def right_click(self, x, y):
        """Right-click the selected tab's page at (x, y) CSS pixels from its
        top left. The event is synthesized in the browser window and routed
        to the page like real input, so the page sees a trusted contextmenu
        event. (Marionette's own actions only know Firefox's tab browser.)"""
        self.js("""
          let [x, y] = arguments;
          let r = gBrowser.selectedBrowser.getBoundingClientRect();
          // As on Windows: the button goes down and up, then the menu event.
          for (let type of ["mousedown", "mouseup", "contextmenu"]) {
            window.synthesizeMouseEvent(type, r.left + x, r.top + y, { button: 2, clickCount: 1 });
          }""", x, y)

    def screenshot(self, path):
        data = self.command("WebDriver:TakeScreenshot", {"full": False, "hash": False})
        import base64

        with open(path, "wb") as f:
            f.write(base64.b64decode(data["value"]))

    def quit(self):
        try:
            self.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except Exception:
            pass
        self.sock.close()
