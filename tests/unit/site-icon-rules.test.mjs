// The rules for fetching a favorite's icon
// (app/components/library/SiteIconRules.sys.mjs).
import {
  isPrivateAddress, isLocalHost, sameSite, redirectAllowed, iconCandidates, sniffImage, imageSize, checkIcon,
  MAX_ICON_BYTES,
} from "../../app/components/library/SiteIconRules.sys.mjs";
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

// A slice of the public suffix list, private section included.
const SUFFIXES = ["com", "org", "co.uk", "uk", "github.io", "test", "io"];
const getBaseDomain = host => {
  let labels = host.split(".");
  for (let i = 0; i < labels.length; i++) {
    if (SUFFIXES.includes(labels.slice(i).join("."))) {
      if (i == 0) throw new Error("bare suffix");
      return labels.slice(i - 1).join(".");
    }
  }
  return labels.slice(-2).join(".");
};

// -- Addresses
for (let a of ["127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
               "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1%eth0",
               "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.1", "::127.0.0.1", "64:ff9b::10.0.0.1",
               "2001:db8::1", "not an address", "999.1.1.1"]) {
  assert(isPrivateAddress(a), `${a} is private`);
}
for (let a of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
  assert(!isPrivateAddress(a), `${a} is public`);
}

// -- Host names
for (let h of ["localhost", "LOCALHOST.", "a.localhost", "printer.local", "nas", "router.lan", "x.home.arpa",
               "svc.internal", "127.0.0.1", "192.168.0.10", "[::1]"]) {
  assert(isLocalHost(h), `${h} is never contacted`);
}
for (let h of ["example.com", "a.b.example.co.uk", "8.8.8.8"]) {
  assert(!isLocalHost(h), `${h} may be contacted`);
}

// -- Same site, private section of the list included
assert(sameSite("www.example.com", "cdn.example.com", getBaseDomain), "subdomains of one domain are one site");
assert(!sameSite("a.github.io", "b.github.io", getBaseDomain), "a.github.io and b.github.io are different sites");
assert(!sameSite("example.co.uk", "other.co.uk", getBaseDomain), "co.uk is a suffix");
assert(!sameSite("1.2.3.4", "1.2.3.5", getBaseDomain) && sameSite("1.2.3.4", "1.2.3.4", getBaseDomain),
       "IP addresses only match themselves");

// -- Redirects
const from = "https://www.example.com/";
assert(redirectAllowed(from, "https://example.com/home", 1, getBaseDomain), "a same-site HTTPS redirect is followed");
assert(!redirectAllowed(from, "http://www.example.com/", 1, getBaseDomain), "never to HTTP");
assert(!redirectAllowed(from, "https://other.com/", 1, getBaseDomain), "never to another site");
assert(!redirectAllowed(from, "https://localhost/", 1, getBaseDomain), "never to localhost");
assert(!redirectAllowed(from, "https://127.0.0.1/", 1, getBaseDomain), "never to a private address");
assert(!redirectAllowed("https://a.github.io/", "https://b.github.io/", 1, getBaseDomain), "never to another github.io site");
assert(!redirectAllowed(from, "https://example.com/", 4, getBaseDomain), "at most 3 redirects");

// -- Icons a page names
const page = "https://www.example.com/";
let html = `<html><head>
  <link rel="icon" href="/favicon-16.png" sizes="16x16">
  <link rel="icon" href="/favicon-96.png" sizes="96x96">
  <link rel='apple-touch-icon' href='https://static.example.com/touch.png'>
  <link rel="apple-touch-icon" href="https://cdn.other.com/touch.png">
  <link rel="icon" href="http://www.example.com/plain.png" sizes="512x512">
  <link rel="stylesheet" href="/site.css">
</head><body><link rel="icon" href="/late.png" sizes="512x512"></body></html>`;
let c = iconCandidates(html, page, getBaseDomain);
let urls = c.map(x => x.url);
assert(c[0].url == "https://static.example.com/touch.png" && c[0].touch, "the same-site apple-touch-icon comes first");
assert(c[1].url == "https://www.example.com/favicon-96.png" && !c[1].touch, "then the largest icon");
assert(!urls.includes("https://cdn.other.com/touch.png"), "icons on other domains are skipped");
assert(!urls.includes("http://www.example.com/plain.png"), "HTTP icons are skipped");
assert(!urls.includes("https://www.example.com/site.css") && !urls.includes("https://www.example.com/late.png"),
       "only icons, only from the head");
assert(urls.at(-1) == "https://www.example.com/favicon.ico", "/favicon.ico last");
assert(iconCandidates(`<link href="/a.png?x=1&amp;y=2" rel=icon>`, page, getBaseDomain)[0].url ==
       "https://www.example.com/a.png?x=1&y=2", "entities and unquoted attributes");
assert(iconCandidates(`<link rel="icon" href="javascript:alert(1)"><link rel="icon" href="data:image/png;base64,AA">`,
                      page, getBaseDomain).length == 1, "only https icons");
assert(iconCandidates(`<link rel="icon" href="https://b.github.io/i.png">`, "https://a.github.io/", getBaseDomain).length == 1,
       "an icon on another github.io site is skipped");

// -- Files
const png = (w, h) => {
  let b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const ico = entries => {
  let images = entries.map(e => e.data ?? new Uint8Array(40));
  let b = new Uint8Array(6 + entries.length * 16 + images.reduce((n, i) => n + i.length, 0));
  let v = new DataView(b.buffer);
  v.setUint16(2, 1, true);
  v.setUint16(4, entries.length, true);
  let offset = 6 + entries.length * 16;
  entries.forEach((e, i) => {
    b[6 + i * 16] = e.w;
    b[6 + i * 16 + 1] = e.h;
    v.setUint32(6 + i * 16 + 8, images[i].length, true);
    v.setUint32(6 + i * 16 + 12, offset, true);
    b.set(images[i], offset);
    offset += images[i].length;
  });
  return b;
};
const text = s => new TextEncoder().encode(s);
assert(sniffImage(png(16, 16)) == "image/png", "PNG from its signature");
assert(sniffImage(ico([{ w: 16, h: 16 }])) == "image/x-icon", "ICO from its header");
assert(sniffImage(text('﻿<?xml version="1.0"?><!-- x --><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg">')) ==
       "image/svg+xml", "SVG after a BOM, declaration, comment and doctype");
assert(sniffImage(text("<html><svg>")) == null, "an HTML page isn't an SVG");
assert(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) == null && sniffImage(text("GIF89a")) == null &&
       sniffImage(text("RIFF\0\0\0\0WEBP")) == null, "JPEG, GIF and WebP are not accepted");
assert(JSON.stringify(imageSize(png(180, 180), "image/png")) == '{"width":180,"height":180}', "PNG size from IHDR");
assert(imageSize(ico([{ w: 0, h: 0 }, { w: 16, h: 16 }]), "image/x-icon").width == 256, "ICO: 0 means 256");
assert(imageSize(ico([{ w: 16, h: 16, data: png(4096, 4096) }]), "image/x-icon").width == 4096, "ICO: embedded PNGs are read");
assert(checkIcon(png(180, 180))?.type == "image/png", "a 180px PNG is accepted");
assert(checkIcon(png(5000, 5000)) == null, "a 5000px PNG is refused before decoding");
assert(checkIcon(ico([{ w: 16, h: 16, data: png(4096, 4096) }])) == null, "so is an ICO hiding a 4096px PNG");
let big = new Uint8Array(MAX_ICON_BYTES + 1);
big.set(png(32, 32));
assert(checkIcon(big) == null, "an icon over 1 MB is refused");
let broken = ico([{ w: 16, h: 16 }]);
new DataView(broken.buffer).setUint32(18, 1 << 30, true);
assert(checkIcon(broken) == null, "an ICO pointing past its end is refused");
assert(checkIcon(text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))?.type == "image/svg+xml",
       "an SVG is accepted (it is only ever drawn as an image)");
