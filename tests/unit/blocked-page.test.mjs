// The blocked-page screen (app/base/content/blocked.html) runs its inline
// style and script under a CSP that names their hashes; edits must keep
// those in step.
const fs = await import("node:fs");
const crypto = await import("node:crypto");
const html = fs.readFileSync(new URL("../../app/base/content/blocked.html", import.meta.url), "utf8");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const hash = text => crypto.createHash("sha256").update(text).digest("base64");
const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)[1];
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const style = html.match(/<style>([\s\S]*?)<\/style>/)[1];
assert(csp.includes(`script-src 'sha256-${hash(script)}'`), "the CSP allows exactly the inline script (update its hash after editing it)");
assert(csp.includes(`style-src 'sha256-${hash(style)}'`), "the CSP allows exactly the inline style (update its hash after editing it)");
assert(csp.startsWith("default-src 'none'") && !/https?:|chrome:|resource:/.test(html.replace(/<!--[\s\S]*?-->/g, "").replace(/http:\/\/www\.w3\.org\/2000\/svg/, "")),
       "nothing loads from anywhere else");
assert(!/innerHTML|insertAdjacentHTML|document\.write/.test(script), "the address is only ever set as text");
