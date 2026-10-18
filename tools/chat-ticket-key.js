#!/usr/bin/env node
// tools/chat-ticket-key.js — a new Ed25519 key for v1 chat tickets (chatticket.js, 1.99acf; docs/chat-tickets.md).
//
//   node tools/chat-ticket-key.js --out <file> [--kid v1-YYYY-MM] [--prev-from <the current key file>]
//
// Writes, to a NEW file created with mode 0600 (it refuses stdout and refuses to overwrite anything):
//   CHAT_TICKET_KEY=<base64 PKCS8 DER private key>
//   CHAT_TICKET_KID=<kid>                       default v1-<this month>; use v1stg-YYYY-MM on staging (each environment has
//                                               its own key, so a staging ticket never verifies at prod)
// and with --prev-from (a rotation), the key in that older file as the previous one, published in the JWKS only:
//   CHAT_TICKET_PREV_PUB=<base64 SPKI DER public key>
//   CHAT_TICKET_PREV_KID=<its kid>
// It prints only the kid(s) and the public "x" values - never a private key.
//
// Rotation: run it with --prev-from <the file you made last time>, replace those four lines in the site's .env, restart the
// site. The hub caches the JWKS for 5 minutes and a ticket lives 5 minutes, so tickets signed with the old key still verify
// through the overlap. Drop the PREV lines at the next rotation.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KID_RE = /^[A-Za-z0-9._:~-]{1,64}$/;

function arg(name) {
  const i = process.argv.indexOf("--" + name);
  if (i >= 0) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith("--" + name + "="));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function die(msg) { console.error("chat-ticket-key: " + msg); process.exit(2); }
function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}
const xOf = (pub) => pub.export({ format: "jwk" }).x;

function main() {
  const out = arg("out");
  if (!out || out === "-" || out === "/dev/stdout") die("--out <file> is required (a new file; never stdout)");
  const month = new Date().toISOString().slice(0, 7);
  const kid = arg("kid") || "v1-" + month;
  if (!KID_RE.test(kid)) die("--kid must match " + KID_RE);
  const lines = [];
  let prev = null;
  const prevFrom = arg("prev-from");
  if (prevFrom) {
    let env;
    try { env = readEnvFile(prevFrom); } catch (e) { die("can't read --prev-from " + path.basename(prevFrom)); }
    try {
      const priv = crypto.createPrivateKey({ key: Buffer.from(String(env.CHAT_TICKET_KEY || ""), "base64"), format: "der", type: "pkcs8" });
      if (priv.asymmetricKeyType !== "ed25519") throw new Error("type");
      const pkid = String(env.CHAT_TICKET_KID || "");
      if (!KID_RE.test(pkid)) throw new Error("kid");
      if (pkid === kid) die("the new kid must differ from the previous one (" + pkid + ")");
      prev = { kid: pkid, pub: crypto.createPublicKey(priv) };
    } catch (e) {
      die("--prev-from has no usable CHAT_TICKET_KEY / CHAT_TICKET_KID");
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  lines.push("CHAT_TICKET_KEY=" + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  lines.push("CHAT_TICKET_KID=" + kid);
  if (prev) {
    lines.push("CHAT_TICKET_PREV_PUB=" + prev.pub.export({ format: "der", type: "spki" }).toString("base64"));
    lines.push("CHAT_TICKET_PREV_KID=" + prev.kid);
  }
  let fd;
  try { fd = fs.openSync(out, "wx", 0o600); } catch (e) { die(e.code === "EEXIST" ? "refusing to overwrite " + out : "can't create " + out + " (" + e.code + ")"); }
  fs.writeSync(fd, lines.join("\n") + "\n");
  fs.closeSync(fd);
  try { fs.chmodSync(out, 0o600); } catch (e) { /* Windows */ }
  console.log(`wrote ${out}`);
  console.log(`kid ${kid}  x ${xOf(publicKey)}`);
  if (prev) console.log(`previous kid ${prev.kid}  x ${xOf(prev.pub)}`);
}

if (require.main === module) main();
module.exports = { readEnvFile, KID_RE };
