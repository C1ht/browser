// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Checks a minisign signature, for update-libsodium.py on machines without
// the minisign tool. Node has Ed25519 and BLAKE2b-512, which is all it takes.
//
//   node minisign-verify.mjs <public key> <file> <file.minisig>
//
// Exits 0 only when both the signature and its trusted comment verify.

import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";

const [pubB64, file, sigFile] = process.argv.slice(2);
const pub = Buffer.from(pubB64, "base64");
if (pub.length != 42 || pub.subarray(0, 2).toString() != "Ed") {
  throw new Error("not a minisign public key");
}
const [, sigLine, trustedLine, globalLine] = readFileSync(sigFile, "utf8").split(/\r?\n/);
const sig = Buffer.from(sigLine, "base64");
if (sig.length != 74 || !sig.subarray(2, 10).equals(pub.subarray(2, 10))) {
  throw new Error("signature is not from this key");
}
const key = createPublicKey({
  // DER prefix of an Ed25519 SubjectPublicKeyInfo, then the raw key.
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10)]),
  format: "der",
  type: "spki",
});
// "ED" signatures are over the BLAKE2b-512 hash of the file, "Ed" over the file.
const data = readFileSync(file);
const alg = sig.subarray(0, 2).toString();
const message = alg == "ED" ? createHash("blake2b512").update(data).digest() : data;
const signature = sig.subarray(10);
const ok = verify(null, message, key, signature);
const trusted = trustedLine.replace(/^trusted comment: /, "");
const okTrusted = verify(
  null,
  Buffer.concat([signature, Buffer.from(trusted)]),
  key,
  Buffer.from(globalLine, "base64")
);
console.log(`signature ${ok ? "valid" : "INVALID"}, trusted comment ${okTrusted ? "valid" : "INVALID"}: ${trusted}`);
process.exit(ok && okTrusted ? 0 : 1);
