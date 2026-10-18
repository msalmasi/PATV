// webpushcrypto.js — 1.99acd: the Web Push primitives for webpush.js (QW-1), on node:crypto alone (no web-push package:
// this is a public repo deployed with `npm ci`, and the whole thing is ~120 lines pinned by the RFC's own test vector).
//
//   RFC 8291  Message Encryption for Web Push: aes128gcm (RFC 8188) with a key agreed by ECDH P-256 between a throwaway
//             sender key and the browser's p256dh key, mixed with the browser's 16-byte auth secret. One record, padded
//             to a fixed size when asked (webpush.js always asks: the length mustn't give away a pad's name).
//   RFC 8292  VAPID: every request carries "Authorization: vapid t=<ES256 JWT>, k=<our public key>". The push service
//             checks the JWT against the key the browser subscribed with, so only we can push to our subscriptions.
//
// Nothing here touches the database, the network or the logs. The private key lives in a KeyObject and is never
// returned, serialised or printed (loadVapid hands back a kid - a fingerprint of the PUBLIC key - for logs and pages).
//
//   b64u(buf) / unb64u(str)            strict base64url (no "+", "/", "=" or bad lengths)
//   checkKeys(p256dh, auth)            a usable browser subscription key pair?
//   encrypt(payload, p256dh, auth)     -> the request body (salt | rs | idlen | keyid | ciphertext)
//   loadVapid(env)                     {ok, why, publicKey, kid, key, subject} from VAPID_PUBLIC_KEY / _PRIVATE_KEY / _SUBJECT
//   vapidAuth(endpoint, vapid, now)    -> the Authorization header value (JWT cached per push-service origin for an hour)
//   generate()                         a new pair {publicKey, privateKey, kid} (tools/vapid-keys.js)
"use strict";
const crypto = require("crypto");

const RS = 4096;                    // the record size we declare (one record; our payloads are ~250 bytes)
const PAYLOAD_MAX = 3000;           // refuse anything bigger (push services take ~4 KB in all)
const PAD_STEP = 512;               // opts.padTo: a payload over the pad size is padded to the next multiple of this
const JWT_TTL_S = 12 * 3600;        // RFC 8292: exp no more than 24 h ahead
const JWT_CACHE_MS = 3600e3;        // reuse a JWT for one push-service origin this long

// ── base64url ──
function b64u(buf) { return Buffer.from(buf).toString("base64url"); }
/** Strict base64url -> Buffer, or null. Node's decoder is lenient (it skips junk), so check the alphabet + length first. */
function unb64u(s) {
  if (typeof s !== "string" || !s.length || !/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  const b = Buffer.from(s, "base64url");
  return b64u(b) === s ? b : null;
}

/** A P-256 point (65 bytes, uncompressed) that is really on the curve? */
function onCurve(pt) {
  if (!Buffer.isBuffer(pt) || pt.length !== 65 || pt[0] !== 0x04) return false;
  try {
    crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pt.subarray(1, 33)), y: b64u(pt.subarray(33)) }, format: "jwk" });
    return true;
  } catch (e) { return false; }
}
/** A browser's subscription keys: p256dh = an uncompressed P-256 point, auth = 16 bytes (both base64url). */
function checkKeys(p256dh, auth) {
  const a = unb64u(auth);
  return onCurve(unb64u(p256dh)) && !!a && a.length === 16;
}

const kidOf = (pub) => crypto.createHash("sha256").update(pub).digest("hex").slice(0, 16);

// ── RFC 8291 ──
/**
 * Encrypt one push message. payload: Buffer | string. opts.padTo: pad the record (payload + the 0x02 delimiter + zero
 * bytes, RFC 8188 §2) to at least this many bytes - a bigger payload to the next PAD_STEP - so the ciphertext's length
 * doesn't give the payload's away (the push service sees it). opts.asPrivate / opts.salt: TEST ONLY (the RFC vector) - a
 * real message always gets a fresh sender key and salt. -> Buffer (the request body).
 */
function encrypt(payload, p256dh, auth, opts = {}) {
  const plain = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  if (plain.length > PAYLOAD_MAX) throw new Error("push payload too big");
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  if (!onCurve(uaPublic) || !authSecret || authSecret.length !== 16) throw new Error("bad subscription keys");
  const ecdh = crypto.createECDH("prime256v1");
  if (opts.asPrivate) ecdh.setPrivateKey(Buffer.isBuffer(opts.asPrivate) ? opts.asPrivate : unb64u(opts.asPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const salt = opts.salt ? (Buffer.isBuffer(opts.salt) ? opts.salt : unb64u(opts.salt)) : crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const gcm = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const padTo = Math.min(Math.max(0, Math.floor(Number(opts.padTo) || 0)), RS - 16);
  const used = plain.length + 1;
  const size = !padTo ? used : used <= padTo ? padTo : Math.min(RS - 16, Math.ceil(used / PAD_STEP) * PAD_STEP);
  const record = Buffer.alloc(size);                                                   // zero bytes after the delimiter = padding
  plain.copy(record, 0);
  record[plain.length] = 0x02;                                                          // 0x02 = the last record
  const ct = Buffer.concat([gcm.update(record), gcm.final(), gcm.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RS);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

// ── VAPID (RFC 8292) ──
/** The operator's pair from the environment. Any problem -> {ok: false, why} (webpush.js logs it once and stays off). */
function loadVapid(env = process.env) {
  const pubS = String((env && env.VAPID_PUBLIC_KEY) || "").trim(), privS = String((env && env.VAPID_PRIVATE_KEY) || "").trim();
  const subject = String((env && env.VAPID_SUBJECT) || "").trim();
  if (!pubS || !privS || !subject) return { ok: false, why: "missing" };
  const pub = unb64u(pubS);
  if (!onCurve(pub)) return { ok: false, why: "bad_public" };
  const d = unb64u(privS);
  if (!d || d.length !== 32) return { ok: false, why: "mismatch" };
  try {
    const e = crypto.createECDH("prime256v1");
    e.setPrivateKey(d);
    if (!e.getPublicKey().equals(pub)) return { ok: false, why: "mismatch" };
  } catch (err) { return { ok: false, why: "mismatch" }; }
  if (!validSubject(subject)) return { ok: false, why: "bad_subject" };
  let key;
  try {
    key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
  } catch (err) { return { ok: false, why: "mismatch" }; }
  return { ok: true, why: null, publicKey: pubS, kid: kidOf(pub), key, subject };
}
/** mailto:<address> or an https: URL (Apple refuses pushes without one). */
function validSubject(s) {
  const v = String(s || "");
  if (v.length > 200) return false;
  if (/^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/i.test(v)) return true;
  try { const u = new URL(v); return u.protocol === "https:" && !!u.hostname; } catch (e) { return false; }
}

const jwtCache = new Map();     // aud -> {v, at, kid}
/** "vapid t=<jwt>, k=<public key>" for a push to `endpoint`. */
function vapidAuth(endpoint, vapid, nowMs = Date.now()) {
  if (!vapid || !vapid.ok) throw new Error("no VAPID keys");
  const aud = new URL(endpoint).origin;
  const c = jwtCache.get(aud);
  if (c && c.kid === vapid.kid && nowMs - c.at < JWT_CACHE_MS && nowMs >= c.at) return c.v;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + JWT_TTL_S, sub: vapid.subject }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + claims), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  const v = `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
  jwtCache.set(aud, { v, at: nowMs, kid: vapid.kid });
  if (jwtCache.size > 50) jwtCache.clear();
  return v;
}

/** A new key pair (tools/vapid-keys.js): the public key as the uncompressed point, the private key as the raw scalar d. */
function generate() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const j = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([0x04]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]);
  return { publicKey: b64u(pub), privateKey: j.d, kid: kidOf(pub) };
}

module.exports = { b64u, unb64u, checkKeys, encrypt, loadVapid, validSubject, vapidAuth, generate, kidOf, RS, PAYLOAD_MAX, PAD_STEP, JWT_TTL_S,
                   _clearJwtCache: () => jwtCache.clear() };
