/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The page side of camera, microphone and screen sharing (getUserMedia,
 * getDisplayMedia) and of WebRTC connections. Gecko asks through observer
 * notifications in the content process and waits for an answer; Firefox
 * answers in browser/actors/WebRTCChild.sys.mjs, which this follows.
 *
 * WebRTCProcessChild receives the notifications (one per content process)
 * and hands each to the WebRTC actor of the window it is about, which asks
 * WebRTCParent and carries out the answer.
 */

const lazy = {};
ChromeUtils.defineLazyGetter(lazy, "MediaManagerService", () =>
  Cc["@mozilla.org/mediaManagerService;1"].getService(Ci.nsIMediaManagerService)
);

function actorFor(win) {
  try {
    return win?.windowGlobalChild?.getActor("WebRTC") ?? null;
  } catch (e) {
    // Chrome documents have no such actor.
    return null;
  }
}

function deny(callID) {
  Services.obs.notifyObservers(null, "getUserMedia:response:deny", callID);
}

export class WebRTCProcessChild extends JSProcessActorChild {
  observe(subject, topic, data) {
    switch (topic) {
      case "getUserMedia:request": {
        let win = Services.wm.getOuterWindowWithId(subject.windowID);
        let actor = actorFor(win);
        if (actor) {
          actor.request(subject, win);
        } else {
          deny(subject.callID);
        }
        break;
      }
      case "PeerConnection:request":
        // Connections themselves need no prompt; only the devices they send
        // do. Firefox's parent only says no for enterprise policy blockers.
        Services.obs.notifyObservers(null, "PeerConnection:response:allow", subject.callID);
        break;
      case "recording-device-events": {
        let win = subject instanceof Ci.nsIPropertyBag ? subject.getProperty("window") : null;
        actorFor(win)?.sendIndicators(win);
        break;
      }
      case "recording-window-ended": {
        let win = Services.wm.getOuterWindowWithId(data);
        actorFor(win)?.sendIndicators(win, { ended: true });
        break;
      }
    }
  }
}

export class WebRTCChild extends JSWindowActorChild {
  actorCreated() {
    // callID -> the nsIMediaDevice list the request offered.
    this.pending = new Map();
  }

  didDestroy() {
    for (let callID of this.pending.keys()) {
      deny(callID);
    }
    this.pending.clear();
  }

  request(request, win) {
    let constraints = request.getConstraints();
    let video = constraints.video || constraints.picture;
    let audio = constraints.audio;
    let sharingScreen = video && typeof video != "boolean" && video.mediaSource != "camera";
    let sharingAudio = audio && typeof audio != "boolean" && audio.mediaSource != "microphone";

    let devices = [];
    let videoInputDevices = [];
    let audioInputDevices = [];
    for (let device of request.devices) {
      device = device.QueryInterface(Ci.nsIMediaDevice);
      let entry = { name: device.rawName, deviceIndex: devices.length };
      // Only the kind that was asked for: a camera for a camera request, a
      // screen or window for a screen request.
      if (device.type == "videoinput" && video && (device.mediaSource == "camera") != sharingScreen) {
        videoInputDevices.push(entry);
        devices.push(device);
      } else if (
        device.type == "audioinput" &&
        audio &&
        (device.mediaSource == "microphone") != sharingAudio
      ) {
        audioInputDevices.push(entry);
        devices.push(device);
      }
    }

    let requestTypes = [];
    if (videoInputDevices.length) {
      requestTypes.push(sharingScreen ? "Screen" : "Camera");
    }
    if (audioInputDevices.length) {
      requestTypes.push(sharingAudio ? "AudioCapture" : "Microphone");
    }
    // Speaker selection (selectAudioOutput) is not offered.
    if (!requestTypes.length || request.type == "selectaudiooutput") {
      deny(request.callID);
      return;
    }

    this.pending.set(request.callID, devices);
    this.sendAsyncMessage("webrtc:Request", {
      callID: request.callID,
      windowID: request.windowID,
      requestTypes,
      videoInputDevices,
      audioInputDevices,
      isHandlingUserInput: request.isHandlingUserInput,
    });
  }

  receiveMessage(message) {
    let { callID } = message.data ?? {};
    switch (message.name) {
      case "webrtc:Allow": {
        let devices = this.pending.get(callID);
        this.pending.delete(callID);
        if (!devices) {
          return;
        }
        let allowed = Cc["@mozilla.org/array;1"].createInstance(Ci.nsIMutableArray);
        for (let index of message.data.devices) {
          allowed.appendElement(devices[index]);
        }
        Services.obs.notifyObservers(allowed, "getUserMedia:response:allow", callID);
        break;
      }
      case "webrtc:Deny":
        this.pending.delete(callID);
        deny(callID);
        break;
      case "webrtc:StopSharing":
        // An inner window ID stops every device that window uses.
        Services.obs.notifyObservers(null, "getUserMedia:revoke", String(message.data.windowId));
        break;
    }
  }

  /** Tells the browser what this window is capturing, for the indicators. */
  sendIndicators(win, { ended = false } = {}) {
    let state = ended ? { camera: false, microphone: false, screen: false } : this._captureState(win);
    state.windowId = win.windowGlobalChild.innerWindowId;
    try {
      this.sendAsyncMessage("webrtc:UpdateIndicators", state);
    } catch (e) {
      // The window is going away; the parent drops its indicators then.
    }
  }

  _captureState(win) {
    let camera = {},
      microphone = {},
      screen = {},
      window = {},
      browser = {},
      devices = {};
    lazy.MediaManagerService.mediaCaptureWindowState(win, camera, microphone, screen, window, browser, devices);
    let capturing = state => state.value != lazy.MediaManagerService.STATE_NOCAPTURE;
    return {
      camera: capturing(camera),
      microphone: capturing(microphone),
      screen: capturing(screen) || capturing(window) || capturing(browser),
    };
  }
}
