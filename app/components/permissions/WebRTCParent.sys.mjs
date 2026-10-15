/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The browser side of camera, microphone and screen sharing: applies a
 * remembered decision, or asks through the window's permission prompt
 * (permissions.js), and reports what is being captured for the sharing
 * indicators.
 *
 * Decisions are kept per origin as the "camera" and "microphone" permissions,
 * as in Firefox. Screen sharing is never remembered.
 */

const PERMISSIONS = { Camera: "camera", Microphone: "microphone" };

export class WebRTCParent extends JSWindowActorParent {
  get browser() {
    return this.browsingContext.top.embedderElement;
  }

  get chromeWindow() {
    return this.browser?.ownerDocument.defaultView ?? null;
  }

  didDestroy() {
    this.chromeWindow?.PermissionPrompts?.forgetWebRTC(this);
  }

  receiveMessage(message) {
    let prompts = this.chromeWindow?.PermissionPrompts;
    switch (message.name) {
      case "webrtc:Request":
        if (prompts) {
          this._request(prompts, message.data);
        } else {
          this._send("webrtc:Deny", { callID: message.data.callID });
        }
        break;
      case "webrtc:UpdateIndicators":
        prompts?.updateSharing(this.browser, this, message.data);
        break;
    }
  }

  _request(prompts, data) {
    // The origin that asked (a frame's own, for an embedded call); the
    // WindowGlobalParent's, which a web process cannot forge.
    let principal = this.manager.documentPrincipal;
    let { perms } = Services;
    let stored = data.requestTypes.map(type =>
      PERMISSIONS[type] ? perms.testExactPermissionFromPrincipal(principal, PERMISSIONS[type]) : perms.UNKNOWN_ACTION
    );
    if (stored.includes(perms.DENY_ACTION)) {
      this._send("webrtc:Deny", { callID: data.callID });
      return;
    }
    let defaults = [data.videoInputDevices[0], data.audioInputDevices[0]]
      .filter(Boolean)
      .map(d => d.deviceIndex);
    if (stored.every(s => s == perms.ALLOW_ACTION)) {
      this._send("webrtc:Allow", { callID: data.callID, devices: defaults });
      return;
    }

    prompts.request({
      kind: "webrtc",
      browser: this.browser,
      principal,
      actor: this,
      callID: data.callID,
      requestTypes: data.requestTypes,
      videoInputDevices: data.videoInputDevices,
      audioInputDevices: data.audioInputDevices,
      // Screen sharing can only be allowed once.
      canRemember: !data.requestTypes.some(t => t == "Screen" || t == "AudioCapture"),
      respond: (allow, { remember = false, devices = defaults, dismissed = false } = {}) => {
        for (let type of dismissed ? [] : data.requestTypes) {
          let permission = PERMISSIONS[type];
          if (!permission) {
            continue;
          }
          if (remember) {
            perms.addFromPrincipal(
              principal,
              permission,
              allow ? perms.ALLOW_ACTION : perms.DENY_ACTION,
              perms.EXPIRE_NEVER
            );
          } else if (!allow) {
            // Not asked again until the browser restarts.
            perms.addFromPrincipal(principal, permission, perms.DENY_ACTION, perms.EXPIRE_SESSION);
          }
        }
        this._send(allow ? "webrtc:Allow" : "webrtc:Deny", { callID: data.callID, devices });
      },
    });
  }

  stopSharing(windowId) {
    this._send("webrtc:StopSharing", { windowId });
  }

  _send(name, data) {
    try {
      this.sendAsyncMessage(name, data);
    } catch (e) {
      // The page went away while the prompt was open.
    }
  }
}
