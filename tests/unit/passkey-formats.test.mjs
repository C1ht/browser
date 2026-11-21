// Passkeys the browser keeps (app/components/passkeys/PasskeyFormats.sys.mjs):
// what it makes is checked the way a relying party checks it, with a CBOR
// decoder written here and Node's own crypto verifying the signatures.
import { createPublicKey, verify, createHash } from "node:crypto";

const F = await import("../../app/components/passkeys/PasskeyFormats.sys.mjs");
const assert = (c, m) => { if (!c) { console.log("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const hex = bytes => Buffer.from(bytes).toString("hex");

// A small CBOR decoder: the relying party's side.
function decode(bytes) {
  let pos = 0;
  let read = () => {
    let first = bytes[pos++], major = first >> 5, info = first & 31, n = info;
    if (info == 24) n = bytes[pos++];
    else if (info == 25) { n = (bytes[pos] << 8) | bytes[pos + 1]; pos += 2; }
    else if (info == 26) { n = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getUint32(0); pos += 4; }
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { let v = bytes.slice(pos, pos + n); pos += n; return v; }
      case 3: { let v = new TextDecoder().decode(bytes.slice(pos, pos + n)); pos += n; return v; }
      case 4: return Array.from({ length: n }, read);
      case 5: { let m = new Map(); for (let i = 0; i < n; i++) { let k = read(); m.set(k, read()); } return m; }
      case 7: return info == 21 ? true : info == 20 ? false : null;
    }
    throw new Error("unsupported CBOR");
  };
  let value = read();
  return { value, rest: bytes.length - pos };
}

assert(hex(F.cbor(new Map([[-3, 1], [1, 2], [-1, 3], [3, 4], [-2, 5]]))) == "a5010203042003210522" + "01",
       "CBOR maps are canonical: keys sorted by their encoding (1, 3, -1, -2, -3)");
assert(hex(F.cbor({ authData: new Uint8Array(0), fmt: "none", attStmt: {} })).startsWith("a363666d74646e6f6e656761747453746d74a0686175746844617461"),
       "the attestation object's keys come fmt, attStmt, authData");
assert(hex(F.cbor(500)) == "1901f4" && hex(F.cbor(-500)) == "3901f3" && hex(F.cbor(23)) == "17" && hex(F.cbor(24)) == "1818",
       "integers take their shortest encoding");

// DER: leading zeros dropped, a high bit padded.
let raw = new Uint8Array(64);
raw[0] = 0x80; raw[31] = 1; raw[63] = 7;
let der = F.derSignature(raw);
assert(hex(der) == "3026022100" + "80" + "00".repeat(30) + "01" + "020107",
       "DER signatures: a high first bit gets a 0 byte, leading zeros go");

// Registration, as a relying party verifies it.
const subtle = globalThis.crypto.subtle;
let pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
let publicRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
let credentialId = crypto.getRandomValues(new Uint8Array(16));
let rpIdHash = await F.sha256(new TextEncoder().encode("github.com"));
let authData = F.authenticatorData({ rpIdHash, flags: F.FLAGS.UP | F.FLAGS.UV | F.FLAGS.AT, credentialId, publicKey: F.coseKey(publicRaw) });
let { value: att, rest } = decode(F.attestationObject(authData));
assert(rest == 0 && att.get("fmt") == "none" && att.get("attStmt").size == 0, "attestation object: fmt none, empty statement");
let data = att.get("authData");
assert(hex(data.slice(0, 32)) == createHash("sha256").update("github.com").digest("hex"), "authenticator data starts with the RP ID's SHA-256");
assert(data[32] == 0x45 && hex(data.slice(33, 37)) == "00000000", "flags UP, UV and AT; signature counter 0");
assert(hex(data.slice(37, 53)) == "00".repeat(16), "AAGUID all zeros (nothing identifies the authenticator)");
let idLength = (data[53] << 8) | data[54];
assert(idLength == 16 && hex(data.slice(55, 71)) == hex(credentialId), "the credential id, with its length");
let { value: key, rest: keyRest } = decode(data.slice(71));
assert(keyRest == 0 && key.get(1) == 2 && key.get(3) == -7 && key.get(-1) == 1, "COSE key: EC2, ES256, P-256, and nothing after it");
let jwk = { kty: "EC", crv: "P-256", x: Buffer.from(key.get(-2)).toString("base64url"), y: Buffer.from(key.get(-3)).toString("base64url") };
let rpKey = createPublicKey({ key: jwk, format: "jwk" });

// Sign-in: authenticator data and the client data hash, signed, in DER.
let assertionData = F.authenticatorData({ rpIdHash, flags: F.FLAGS.UP | F.FLAGS.UV });
let clientDataHash = await F.sha256(new TextEncoder().encode('{"type":"webauthn.get","challenge":"abc","origin":"https://github.com"}'));
let signed = F.concat(assertionData, clientDataHash);
let rawSignature = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed));
let signature = F.derSignature(rawSignature);
assert(assertionData.length == 37, "sign-in authenticator data has no credential data");
assert(verify("sha256", signed, rpKey, Buffer.from(signature)), "a relying party verifies the signature with the registered key");
signed[0] ^= 1;
assert(!verify("sha256", signed, rpKey, Buffer.from(signature)), "and refuses it for anything else");
assert(hex(F.fromBase64url(F.base64url(credentialId))) == hex(credentialId), "base64url both ways");
