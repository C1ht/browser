/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env worker */

"use strict";

/**
 * Reads a QR code from pixels, off the window's main thread (passwords.js:
 * an authenticator's QR code on the page on screen). jsQR is vendored in
 * app/third_party/jsqr. Posts back the code's text, or null.
 */

importScripts("chrome://browser-wip/content/jsQR.js");

self.onmessage = ({ data: { pixels, width, height } }) => {
  let result = null;
  try {
    result = self.jsQR(pixels, width, height, { inversionAttempts: "attemptBoth" });
  } catch (e) {
    // Not a picture with a QR code in it.
  }
  self.postMessage(typeof result?.data == "string" ? result.data : null);
};
