// Authenticator codes (app/components/passwords/Authenticator.sys.mjs):
// RFC 6238's test vectors, setup keys and otpauth:// links.
const { authenticatorURI, base32Decode, cleanSettings, formatCode, parseAuthenticator, totp } = await import(
  "../../app/components/passwords/Authenticator.sys.mjs"
);
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const base32 = bytes => {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (let b of bytes) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  return bits ? out + A[(value << (5 - bits)) & 31] : out;
};
const ascii = s => new TextEncoder().encode(s);

// RFC 6238 appendix B: 8 digits, 30 s steps, a key per algorithm.
const keys = {
  SHA1: base32(ascii("12345678901234567890")),
  SHA256: base32(ascii("12345678901234567890123456789012")),
  SHA512: base32(ascii("1234567890123456789012345678901234567890123456789012345678901234")),
};
const vectors = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];
let all = true;
for (let [time, sha1, sha256, sha512] of vectors) {
  for (let [algorithm, expected] of [["SHA1", sha1], ["SHA256", sha256], ["SHA512", sha512]]) {
    let { code } = await totp(keys[algorithm], { digits: 8, period: 30, algorithm }, time * 1000);
    if (code != expected) {
      all = false;
      console.log("  ", algorithm, time, code, "expected", expected);
    }
  }
}
assert(all, "RFC 6238 test vectors, SHA-1, SHA-256 and SHA-512, up to the year 2603");
let { code, remaining } = await totp(keys.SHA1, {}, 59 * 1000);
assert(code == "287082" && remaining == 1, "6 digits by default (the last 6 of the 8), with the seconds left");

// Setup keys as sites show them.
let parsed = parseAuthenticator("jbsw y3dp ehpk 3pxp");
assert(parsed.key == "JBSWY3DPEHPK3PXP" && parsed.settings.digits == 6 && parsed.settings.period == 30,
       "a bare key: spaces and lower case are fine, and the defaults apply");
assert(base32Decode("JBSWY3DPEHPK3PXP").length == 10, "Base32 decodes to bytes");
let uri = parseAuthenticator("otpauth://totp/Example:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example&digits=8&period=60&algorithm=SHA256");
assert(uri.key == "JBSWY3DPEHPK3PXP" && uri.settings.issuer == "Example" && uri.settings.account == "alice@example.com"
       && uri.settings.digits == 8 && uri.settings.period == 60 && uri.settings.algorithm == "SHA256",
       "an otpauth:// link: key, issuer, account, digits, period and algorithm");
let labelOnly = parseAuthenticator("otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP");
assert(labelOnly.settings.issuer == "GitHub" && labelOnly.settings.account == "octocat", "the issuer from the label when there's no issuer parameter");
for (let [input, code, what] of [
  ["otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1", "otp-counter", "counter-based codes (HOTP) are refused, by name"],
  ["not a key!", "otp-not-a-key", "text that isn't Base32 is refused"],
  ["JBSWY3DP", "otp-short-key", "a key shorter than 80 bits is refused"],
  ["otpauth://totp/x", "otp-not-a-key", "a link without a key is refused"],
]) {
  let got;
  try { parseAuthenticator(input); } catch (e) { got = e.code; }
  assert(got == code, what);
}
let settings = cleanSettings({ digits: "9", period: "5", algorithm: "MD5", issuer: 3 });
assert(settings.digits == 6 && settings.period == 30 && settings.algorithm == "SHA1" && settings.issuer == "",
       "settings out of range fall back to the defaults");
let back = parseAuthenticator(authenticatorURI(uri.key, uri.settings));
assert(JSON.stringify(back) == JSON.stringify(uri), "an otpauth:// link made from a key reads back the same");
assert(formatCode("123456") == "123 456" && formatCode("12345678") == "1234 5678", "codes are grouped for reading");
