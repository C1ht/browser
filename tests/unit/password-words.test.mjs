// Passphrase suggestions (app/components/passwords/PasswordWords.sys.mjs).
const words = await import("../../app/components/passwords/PasswordWords.sys.mjs");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };

assert(words.wordCount() == 7776, "the EFF long list has 7776 words");
let p = words.suggestPassphrase();
assert(/^[a-z-]+$/.test(p) && p.split("-").length >= 5, "five lower-case words joined with dashes");
assert([...p].length >= 12, "always long enough for a master password");
let seen = new Set();
for (let i = 0; i < 200; i++) {
  seen.add(words.suggestPassphrase());
}
assert(seen.size == 200, "no repeats in 200 suggestions");
let first = new Map();
for (let i = 0; i < 20000; i++) {
  let w = words.suggestPassphrase(1);
  first.set(w, (first.get(w) ?? 0) + 1);
}
assert(first.size > 5000 && Math.max(...first.values()) < 20, "words are drawn across the whole list");
