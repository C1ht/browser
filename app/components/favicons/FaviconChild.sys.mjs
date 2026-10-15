/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Site icons (favicons), the page side. Picks the page's best
 * <link rel="icon">, or /favicon.ico when it declares none, loads it and
 * sends it to FaviconParent as a data: URL.
 *
 * As in Firefox (browser/modules/FaviconLoader.sys.mjs), the icon loads in
 * the page's own process with the <link> as its loading context: the
 * page's principal, cookie jar and content blocking apply, never the
 * browser's.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// Larger icons are not worth sending around for a 16-pixel tab icon.
const MAX_ICON_BYTES = 256 * 1024;
// Links usually arrive one after another while the head is parsed.
const SETTLE_MS = 100;
// The tab draws icons at 16 CSS pixels, twice that on high-DPI screens.
const WANTED_SIZE = 32;

function iconLinks(doc) {
  return [...doc.querySelectorAll("link[rel][href]")].filter(link => link.relList.contains("icon"));
}

// Prefers SVG, then the size closest to WANTED_SIZE (larger over smaller),
// then the first declared.
function score(link) {
  let type = link.type.toLowerCase();
  if (type == "image/svg+xml" || /\.svg($|\?)/i.test(link.href) || link.sizes.contains("any")) {
    return 1000;
  }
  let sizes = [...link.sizes].map(s => parseInt(s, 10)).filter(n => n > 0);
  if (!sizes.length) {
    return 100;
  }
  return Math.max(...sizes.map(n => 500 - Math.abs(n - WANTED_SIZE) - (n < WANTED_SIZE ? 50 : 0)));
}

function toBase64(buffer) {
  // URL-safe base64 back to the standard alphabet data: URLs use.
  return ChromeUtils.base64URLEncode(new Uint8Array(buffer), { pad: true })
    .replace(/-/g, "+")
    .replace(/_/g, "/");
}

export class FaviconChild extends JSWindowActorChild {
  handleEvent(event) {
    switch (event.type) {
      case "DOMLinkAdded":
      case "DOMLinkChanged":
        if (event.target.ownerDocument == this.document && event.target.relList?.contains("icon")) {
          this._scheduleLoad();
        }
        break;
      case "pageshow":
        this._pageShown = true;
        if (event.persisted && this._lastIcon) {
          // Back from the back-forward cache: the tab cleared its icon.
          this.sendAsyncMessage("Favicon:Set", this._lastIcon);
        } else {
          this._scheduleLoad();
        }
        break;
    }
  }

  didDestroy() {
    lazy.clearTimeout(this._timer);
  }

  _scheduleLoad() {
    lazy.clearTimeout(this._timer);
    this._timer = lazy.setTimeout(() => this._load(), SETTLE_MS);
  }

  _load() {
    let doc = this.document;
    if (!doc) {
      return;
    }
    let candidates = iconLinks(doc);
    let node, url;
    if (candidates.length) {
      node = candidates.reduce((best, link) => (score(link) > score(best) ? link : best));
      url = node.href;
    } else if (this._pageShown && /^https?:/.test(doc.documentURI)) {
      // No icon declared: the conventional one, once the page has loaded.
      node = doc;
      url = new URL("/favicon.ico", doc.documentURI).href;
    } else {
      return;
    }
    if (url == this._lastURL) {
      return;
    }
    this._lastURL = url;

    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch (e) {
      return;
    }
    if (!["http", "https", "data"].includes(uri.scheme)) {
      return;
    }

    let security =
      node.crossOrigin == "anonymous"
        ? Ci.nsILoadInfo.SEC_REQUIRE_CORS_INHERITS_SEC_CONTEXT
        : node.crossOrigin == "use-credentials"
          ? Ci.nsILoadInfo.SEC_REQUIRE_CORS_INHERITS_SEC_CONTEXT | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE
          : Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT;
    let channel = Services.io.newChannelFromURI(
      uri,
      node,
      node.nodePrincipal,
      node.nodePrincipal,
      security | Ci.nsILoadInfo.SEC_ALLOW_CHROME | Ci.nsILoadInfo.SEC_DISALLOW_SCRIPT,
      Ci.nsIContentPolicy.TYPE_INTERNAL_IMAGE_FAVICON
    );
    if (channel instanceof Ci.nsIHttpChannel) {
      let referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
      if (node.nodeType == node.DOCUMENT_NODE) {
        referrerInfo.initWithDocument(node);
      } else {
        referrerInfo.initWithElement(node);
      }
      channel.referrerInfo = referrerInfo;
    }
    channel.loadFlags |= Ci.nsIRequest.LOAD_BACKGROUND | Ci.nsIRequest.VALIDATE_NEVER | Ci.nsIRequest.LOAD_FROM_CACHE;

    let pageURL = doc.documentURI;
    lazy.NetUtil.asyncFetch(channel, (stream, status, request) => {
      try {
        if (!Components.isSuccessCode(status) || this._lastURL != url) {
          return;
        }
        if (request instanceof Ci.nsIHttpChannel && !request.requestSucceeded) {
          return;
        }
        let length = stream.available();
        if (!length || length > MAX_ICON_BYTES) {
          return;
        }
        let input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
        input.setInputStream(stream);
        let buffer = new ArrayBuffer(length);
        input.readArrayBuffer(length, buffer);

        let type = request.contentType;
        if (type != "image/svg+xml") {
          // What the bytes are, not what the server claims (as Firefox).
          let sniffer = Cc["@mozilla.org/image/loader;1"].createInstance(Ci.nsIContentSniffer);
          type = sniffer.getMIMETypeFromContent(request, new Uint8Array(buffer), length);
        }
        if (!type?.startsWith("image/")) {
          return;
        }
        this._lastIcon = { pageURL, dataURL: `data:${type};base64,${toBase64(buffer)}` };
        this.sendAsyncMessage("Favicon:Set", this._lastIcon);
      } catch (e) {
        // No icon; the tab keeps its letter tile.
      } finally {
        stream?.close();
      }
    });
  }
}
