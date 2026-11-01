/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The rules for fetching a favorite's icon (SiteIcons.sys.mjs), without
 * Gecko, so the unit tests can check them: which hosts and addresses are
 * never contacted, what counts as the same site, which icons a home page
 * offers, and which image files are accepted.
 */

// Only this much of a home page is read.
export const MAX_PAGE_BYTES = 64 * 1024;
export const MAX_ICON_BYTES = 1024 * 1024;
// Larger images are refused before they are decoded.
export const MAX_ICON_DIMENSION = 1024;
// For the page and the icon together.
export const FETCH_TIMEOUT_MS = 10000;
export const MAX_REDIRECTS = 3;
// What a kept icon is re-encoded to.
export const STORED_SIZE = 128;

function ipv4Parts(host) {
  let match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) {
    return null;
  }
  let parts = match.slice(1).map(Number);
  return parts.every(n => n <= 255) ? parts : null;
}

function isPrivateIPv4([a, b]) {
  return (
    a == 0 || // "this network"
    a == 10 ||
    a == 127 ||
    (a == 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a == 169 && b == 254) || // link-local
    (a == 172 && b >= 16 && b <= 31) ||
    (a == 192 && b == 168) ||
    a >= 224 // multicast and reserved
  );
}

// The 8 groups of an IPv6 address, or null.
function ipv6Groups(text) {
  let host = text.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!host.includes(":") || !/^[0-9a-f:.]+$/i.test(host)) {
    return null;
  }
  // A trailing dotted IPv4 part (::ffff:127.0.0.1) as two groups.
  let tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (tail) {
    let v4 = ipv4Parts(tail[1]);
    if (!v4) {
      return null;
    }
    host = host.slice(0, -tail[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  let halves = host.split("::");
  if (halves.length > 2) {
    return null;
  }
  let parse = part => (part ? part.split(":").map(g => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN)) : []);
  let head = parse(halves[0]);
  let rest = halves.length == 2 ? parse(halves[1]) : [];
  let groups = halves.length == 2 ? [...head, ...Array(8 - head.length - rest.length).fill(0), ...rest] : head;
  return groups.length == 8 && groups.every(g => g >= 0) ? groups : null;
}

/**
 * True for an address that isn't on the public internet: loopback,
 * private, link-local, carrier-grade NAT, unique-local, multicast,
 * unspecified, and IPv4 addresses inside IPv6 (mapped, compatible, NAT64
 * well-known prefix). Anything that isn't an address counts as private.
 */
export function isPrivateAddress(address) {
  let v4 = ipv4Parts(address);
  if (v4) {
    return isPrivateIPv4(v4);
  }
  let g = ipv6Groups(address);
  if (!g) {
    return true;
  }
  let embedded = () => [g[6] >> 8, g[6] & 255];
  if (g.slice(0, 5).every(x => x == 0) && (g[5] == 0 || g[5] == 0xffff)) {
    // ::, ::1, ::a.b.c.d and ::ffff:a.b.c.d
    return g[5] == 0 && g[6] == 0 && g[7] <= 1 ? true : isPrivateIPv4(embedded());
  }
  if (g[0] == 0x64 && g[1] == 0xff9b && g.slice(2, 6).every(x => x == 0)) {
    return isPrivateIPv4(embedded());
  }
  return (
    (g[0] & 0xfe00) == 0xfc00 || // unique local
    (g[0] & 0xffc0) == 0xfe80 || // link-local
    (g[0] & 0xffc0) == 0xfec0 || // site-local (deprecated)
    (g[0] & 0xff00) == 0xff00 || // multicast
    (g[0] == 0x2001 && g[1] == 0x0db8) // documentation
  );
}

export function isIPAddress(host) {
  return !!ipv4Parts(host) || !!ipv6Groups(host);
}

/**
 * True for a host name that is never contacted: localhost and its
 * subdomains, .local (mDNS), .internal, .lan, .home.arpa, single-label
 * names (resolved on the local network) and private IP literals.
 */
export function isLocalHost(host) {
  host = host.toLowerCase().replace(/\.$/, "");
  if (isIPAddress(host)) {
    return isPrivateAddress(host);
  }
  return (
    !host.includes(".") ||
    host == "localhost" ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)
  );
}

/**
 * Two hosts are the same site when they share a registrable domain under
 * the whole public suffix list, private section included: a.github.io and
 * b.github.io are different sites. IP addresses only match themselves.
 * getBaseDomain is Services.eTLD.getBaseDomainFromHost (or a test's).
 */
export function sameSite(hostA, hostB, getBaseDomain) {
  let a = hostA.toLowerCase();
  let b = hostB.toLowerCase();
  if (a == b) {
    return true;
  }
  if (isIPAddress(a) || isIPAddress(b)) {
    return false;
  }
  try {
    return getBaseDomain(a) == getBaseDomain(b);
  } catch (e) {
    return false;
  }
}

/**
 * Whether a redirect may be followed: HTTPS, the same site as the
 * favorite, never a local host, and at most MAX_REDIRECTS of them.
 */
export function redirectAllowed(fromURL, toURL, count, getBaseDomain) {
  let from, to;
  try {
    from = new URL(fromURL);
    to = new URL(toURL);
  } catch (e) {
    return false;
  }
  return (
    count <= MAX_REDIRECTS &&
    to.protocol == "https:" &&
    !isLocalHost(to.hostname) &&
    sameSite(from.hostname, to.hostname, getBaseDomain)
  );
}

const LINK_RE = /<link\b[^>]*>/gi;

function attribute(tag, name) {
  let match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
}

function decodeEntities(text) {
  return text.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/**
 * The icons a home page names, best first: { url, touch }, touch marking
 * an apple-touch-icon (a whole square tile). Only HTTPS icons on the same
 * site as the page; /favicon.ico last.
 */
export function iconCandidates(html, pageURL, getBaseDomain) {
  let page = new URL(pageURL);
  let end = html.search(/<\/head>/i);
  let head = end >= 0 ? html.slice(0, end) : html;
  let found = [];
  for (let [tag] of head.matchAll(LINK_RE)) {
    let rel = (attribute(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    let href = attribute(tag, "href");
    if (!href) {
      continue;
    }
    let touch = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!touch && !rel.includes("icon")) {
      continue;
    }
    let url;
    try {
      url = new URL(decodeEntities(href), page);
    } catch (e) {
      continue;
    }
    if (url.protocol != "https:" || !sameSite(url.hostname, page.hostname, getBaseDomain)) {
      continue;
    }
    let sizes = (attribute(tag, "sizes") ?? "").toLowerCase();
    let svg = /\.svg$/i.test(url.pathname) || attribute(tag, "type") == "image/svg+xml";
    let size = sizes == "any" || svg ? 512 : Math.max(0, ...sizes.split(/\s+/).map(s => parseInt(s, 10) || 0));
    // Without sizes, a touch icon is usually 180px and an icon 16-32px.
    size ||= touch ? 180 : 32;
    found.push({ url: url.href, touch, score: (touch ? 1000 : 0) + Math.min(size, 512) });
  }
  found.sort((a, b) => b.score - a.score);
  let seen = new Set();
  let result = found.filter(c => !seen.has(c.url) && seen.add(c.url)).map(({ url, touch }) => ({ url, touch }));
  let fallback = new URL("/favicon.ico", page).href;
  if (page.protocol == "https:" && !seen.has(fallback)) {
    result.push({ url: fallback, touch: false });
  }
  return result;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes, signature, offset = 0) {
  return bytes.length >= offset + signature.length && signature.every((b, i) => bytes[offset + i] == b);
}

/**
 * What an icon file is, from its bytes, whatever the server said:
 * "image/png", "image/x-icon", "image/svg+xml", or null for anything else
 * (JPEG, GIF, WebP, BMP and the rest are not accepted).
 */
export function sniffImage(bytes) {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "image/png";
  }
  if (startsWith(bytes, [0, 0, 1, 0]) && bytes.length >= 6 && (bytes[4] | (bytes[5] << 8)) > 0) {
    return "image/x-icon";
  }
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 1024));
  // Optional BOM, XML declaration, comments and doctype, then <svg.
  let prolog = /^﻿?\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i;
  return prolog.test(text) ? "image/svg+xml" : null;
}

function pngSize(bytes, offset = 0) {
  // The IHDR chunk comes first: width and height, big-endian, at 16 and 20.
  if (!startsWith(bytes, PNG_SIGNATURE, offset) || bytes.length < offset + 24) {
    return null;
  }
  let view = new DataView(bytes.buffer, bytes.byteOffset + offset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * A raster icon's largest width and height from its header, or null when
 * the header is broken. ICO images inside are checked one by one,
 * including PNGs embedded in them.
 */
export function imageSize(bytes, type) {
  if (type == "image/png") {
    return pngSize(bytes);
  }
  if (type == "image/x-icon") {
    let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let count = view.getUint16(4, true);
    if (count > 64 || bytes.length < 6 + count * 16) {
      return null;
    }
    let size = { width: 0, height: 0 };
    for (let i = 0; i < count; i++) {
      let entry = 6 + i * 16;
      let length = view.getUint32(entry + 8, true);
      let offset = view.getUint32(entry + 12, true);
      if (offset + length > bytes.length || length < 8) {
        return null;
      }
      let inner = startsWith(bytes, PNG_SIGNATURE, offset)
        ? pngSize(bytes, offset)
        : { width: bytes[entry] || 256, height: bytes[entry + 1] || 256 };
      if (!inner) {
        return null;
      }
      size = { width: Math.max(size.width, inner.width), height: Math.max(size.height, inner.height) };
    }
    return size;
  }
  return null;
}

/** Whether an icon file may be decoded: a known type of sane size. */
export function checkIcon(bytes) {
  if (!bytes.length || bytes.length > MAX_ICON_BYTES) {
    return null;
  }
  let type = sniffImage(bytes);
  if (!type) {
    return null;
  }
  if (type == "image/svg+xml") {
    // Rasterized at STORED_SIZE whatever it says.
    return { type };
  }
  let size = imageSize(bytes, type);
  if (!size || !size.width || !size.height || size.width > MAX_ICON_DIMENSION || size.height > MAX_ICON_DIMENSION) {
    return null;
  }
  return { type, ...size };
}
