/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The page side of the right-click menu: on `contextmenu` it reports what was
 * clicked (link, image, video or audio, editable field, selected text) to
 * ContextMenuParent, which opens the menu in the browser window.
 *
 * Pages that show their own menu (preventDefault) keep it, as in Firefox.
 *
 * Copy image asks back for the clicked image, which is sent as PNG bytes:
 * the same route Firefox takes for canvases.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
const XLINK_NS = "http://www.w3.org/1999/xlink";
// The selection is only used for Copy and Search; enough for either.
const MAX_SELECTION = 1000;

function referrerInfo(init) {
  let info = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
  init(info);
  return lazy.E10SUtils.serializeReferrerInfo(info);
}

function linkURL(link) {
  if (link.namespaceURI == "http://www.w3.org/2000/svg") {
    let href = link.getAttribute("href") ?? link.getAttributeNS(XLINK_NS, "href");
    return href ? new URL(href, link.baseURI).href : null;
  }
  return link.href || null;
}

export class ContextMenuChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.defaultPrevented && Services.prefs.getBoolPref("dom.event.contextmenu.enabled", true)) {
      return;
    }
    this._image = null;
    let target = event.composedTarget;
    if (target?.nodeType != target?.ELEMENT_NODE) {
      target = target?.parentElement;
    }
    if (!target) {
      return;
    }
    let doc = target.ownerDocument;
    let win = doc.defaultView;
    let data = {
      // Device pixels, so the parent can place the menu whatever the zoom.
      screenX: event.screenX * win.devicePixelRatio,
      screenY: event.screenY * win.devicePixelRatio,
      referrerInfo: referrerInfo(info => info.initWithDocument(doc)),
      cookieJarSettings: lazy.E10SUtils.serializeCookieJarSettings(doc.cookieJarSettings),
    };

    let link = target.closest("a[href], area[href], a");
    let url = link && linkURL(link);
    if (url) {
      data.linkURL = url;
      data.linkReferrerInfo = referrerInfo(info => info.initWithElement(link));
    }

    if (win.HTMLImageElement.isInstance(target) && target.currentURI) {
      data.imageURL = target.currentURI.spec;
      this._image = Cu.getWeakReference(target);
    } else if (win.HTMLMediaElement.isInstance(target)) {
      data.mediaType = win.HTMLVideoElement.isInstance(target) ? "video" : "audio";
      // Streams (MediaSource, blob:) have no address worth opening or saving.
      let src = target.currentSrc;
      if (src && !src.startsWith("blob:") && !src.startsWith("mediasource:")) {
        data.mediaURL = src;
      }
    }

    let field = null;
    if (
      (win.HTMLInputElement.isInstance(target) && TEXT_INPUT_TYPES.has(target.type)) ||
      win.HTMLTextAreaElement.isInstance(target)
    ) {
      field = target;
    }
    data.editable = !!field || target.isContentEditable || doc.designMode == "on";
    data.readOnly = !!field && (field.readOnly || field.disabled);

    let selection;
    if (field) {
      selection = field.type == "password" ? "" : field.value.substring(field.selectionStart ?? 0, field.selectionEnd ?? 0);
    } else {
      selection = win.getSelection()?.toString() ?? "";
    }
    data.selection = selection.trim().slice(0, MAX_SELECTION);

    this.sendAsyncMessage("ContextMenu:Open", data);
  }

  receiveMessage(message) {
    if (message.name == "ContextMenu:ImageAsPNG") {
      return this._imageAsPNG();
    }
    return undefined;
  }

  _imageAsPNG() {
    let image = this._image?.get();
    let container = image?.getRequest(Ci.nsIImageLoadingContent.CURRENT_REQUEST)?.image;
    if (!container) {
      return null;
    }
    let tools = Cc["@mozilla.org/image/tools;1"].getService(Ci.imgITools);
    let stream = tools.encodeImage(container, "image/png", "");
    let input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
    input.setInputStream(stream);
    let buffer = new ArrayBuffer(stream.available());
    input.readArrayBuffer(buffer.byteLength, buffer);
    return buffer;
  }
}
