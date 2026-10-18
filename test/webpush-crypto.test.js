// 1.99acd: the Web Push primitives (webpushcrypto.js) - RFC 8291 message encryption pinned by the RFC's own Appendix A vector,
// a round trip through a test browser key, strict key checks, VAPID (RFC 8292) JWTs that verify with our public key and carry
// nothing secret, and the env loader's refusals.
//   node --test test/webpush-crypto.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const C = require(path.join(__dirname, "..", "webpushcrypto"));

// RFC 8291 Appendix A ("When I grow up, I want to be a watermelon")
const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  as_public: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  as_private: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  ua_public: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ua_private: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth_secret: "BTBZMqHH6r4Tts7J_aSIgg",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** The browser side of RFC 8291 (test only): decrypt a body with the UA's private key + auth secret. */
function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.isBuffer(uaPrivate) ? uaPrivate : Buffer.from(uaPrivate, "base64url"));
  const uaPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(auth, "base64url"), Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(out[out.length - 1], 0x02, "the last-record delimiter");
  return { plain: out.subarray(0, out.length - 1), rs, asPublic };
}
function uaKeys() {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  return { priv: e.getPrivateKey(), p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
}

test("RFC 8291 Appendix A: encrypt() gives the RFC's message byte for byte", () => {
  const body = C.encrypt(Buffer.from(V.plaintext, "base64url"), V.ua_public, V.auth_secret, { asPrivate: V.as_private, salt: V.salt });
  assert.equal(body.toString("base64url"), V.message);
  // and the RFC's own receiver side gets the plaintext back
  const d = decrypt(body, V.ua_private, V.auth_secret);
  assert.equal(d.plain.toString(), "When I grow up, I want to be a watermelon");
  assert.equal(d.rs, 4096);
  assert.equal(d.asPublic.toString("base64url"), V.as_public);
});

test("round trip with a fresh browser key; every message gets a new sender key and salt", () => {
  const ua = uaKeys();
  const payload = JSON.stringify({ v: 1, k: "dm", t: "New message" });
  const a = C.encrypt(payload, ua.p256dh, ua.auth), b = C.encrypt(payload, ua.p256dh, ua.auth);
  assert.equal(decrypt(a, ua.priv, ua.auth).plain.toString(), payload);
  assert.equal(decrypt(b, ua.priv, ua.auth).plain.toString(), payload);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), "salt differs");
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), "sender key differs");
  assert.throws(() => C.encrypt("x".repeat(C.PAYLOAD_MAX + 1), ua.p256dh, ua.auth), /too big/);
  assert.throws(() => C.encrypt("x", "nope", ua.auth), /bad subscription keys/);
});

test("padTo: one body length whatever the payload's length (RFC 8188 padding: 0x02, then zero bytes); bigger ones step by 512", () => {
  const ua = uaKeys();
  /** Decrypt and strip the padding the way a browser does. */
  const open = (body) => {
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.setPrivateKey(ua.priv);
    const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdh.computeSecret(asPublic), Buffer.from(ua.auth, "base64url"),
      Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
    const d = crypto.createDecipheriv("aes-128-gcm", Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16)),
      Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12)));
    d.setAuthTag(ct.subarray(ct.length - 16));
    const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    let end = out.length - 1;
    while (end >= 0 && out[end] === 0) end--;
    assert.equal(out[end], 0x02, "the delimiter, then only zero bytes");
    return out.subarray(0, end).toString("utf8");
  };
  const short = JSON.stringify({ t: "You were mentioned in A" }), long = JSON.stringify({ t: "You were mentioned in " + "Ünïcode pad ".repeat(3) });
  const a = C.encrypt(short, ua.p256dh, ua.auth, { padTo: 1024 }), b = C.encrypt(long, ua.p256dh, ua.auth, { padTo: 1024 });
  assert.equal(a.length, 86 + 1024 + 16, "header (salt, rs, idlen, key) + the padded record + the tag");
  assert.equal(b.length, a.length, "the pad name's length doesn't show");
  assert.equal(open(a), short);
  assert.equal(open(b), long);
  const big = "x".repeat(1100);
  const c = C.encrypt(big, ua.p256dh, ua.auth, { padTo: 1024 });
  assert.equal(c.length, 86 + 1536 + 16, "over the pad size: the next 512");
  assert.equal(open(c), big);
  assert.equal(C.encrypt(short, ua.p256dh, ua.auth).length, 86 + short.length + 1 + 16, "no padTo: no padding (the RFC vector stays exact)");
});

test("checkKeys: a real P-256 point + 16 bytes of auth, strict base64url", () => {
  const ua = uaKeys();
  assert.equal(C.checkKeys(ua.p256dh, ua.auth), true);
  assert.equal(C.checkKeys(V.ua_public, V.auth_secret), true);
  const pt = Buffer.from(ua.p256dh, "base64url");
  assert.equal(C.checkKeys(pt.subarray(0, 64).toString("base64url"), ua.auth), false, "wrong length");
  const off = Buffer.from(pt); off[64] ^= 1;                                       // y changed: not on the curve
  assert.equal(C.checkKeys(off.toString("base64url"), ua.auth), false, "off-curve point");
  const comp = Buffer.from(pt); comp[0] = 0x02;
  assert.equal(C.checkKeys(comp.toString("base64url"), ua.auth), false, "not the uncompressed form");
  assert.equal(C.checkKeys(ua.p256dh, crypto.randomBytes(15).toString("base64url")), false, "auth length");
  assert.equal(C.checkKeys(ua.p256dh.replace(/-/g, "+").replace(/_/g, "/") + "+", ua.auth), false, "not base64url");
  assert.equal(C.checkKeys(ua.p256dh, ua.auth + "=="), false, "padding refused");
  assert.equal(C.checkKeys(null, undefined), false);
  assert.equal(C.unb64u("a"), null);
  assert.equal(C.unb64u("ab+c"), null);
  assert.deepEqual(C.unb64u("AQID"), Buffer.from([1, 2, 3]));
});

test("loadVapid: missing / bad / mismatched pairs say why; the subject must be mailto: or https:", () => {
  const k = C.generate(), k2 = C.generate();
  assert.deepEqual(C.loadVapid({}), { ok: false, why: "missing" });
  assert.equal(C.loadVapid({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey }).why, "missing", "the subject too");
  assert.equal(C.loadVapid({ VAPID_PUBLIC_KEY: "AAAA", VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:a@b.co" }).why, "bad_public");
  assert.equal(C.loadVapid({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k2.privateKey, VAPID_SUBJECT: "mailto:a@b.co" }).why, "mismatch");
  assert.equal(C.loadVapid({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: "short", VAPID_SUBJECT: "mailto:a@b.co" }).why, "mismatch");
  for (const bad of ["ops@x.co", "http://x.co", "mailto:nobody", "javascript:alert(1)"]) {
    assert.equal(C.loadVapid({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: bad }).why, "bad_subject", bad);
  }
  const ok = C.loadVapid({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "https://publicaccess.tv" });
  assert.equal(ok.ok, true);
  assert.equal(ok.kid, k.kid);
  assert.match(ok.kid, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(ok).includes(k.privateKey), "the private key is not in anything serialisable");
});

test("vapidAuth: an ES256 JWT for the push service's origin that verifies with our public key; nothing secret in it", () => {
  const k = C.generate();
  const vapid = C.loadVapid({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" });
  C._clearJwtCache();
  const now = Date.UTC(2026, 9, 18, 12);
  const h = C.vapidAuth("https://fcm.googleapis.com/fcm/send/abc:def", vapid, now);
  const m = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(h);
  assert.ok(m, h);
  assert.equal(m[4], k.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(m[1], "base64url")), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(m[2], "base64url"));
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "mailto:ops@example.com");
  assert.ok(claims.exp > now / 1000 && claims.exp - now / 1000 <= 24 * 3600, "exp within 24 h");
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: Buffer.from(k.publicKey, "base64url").subarray(1, 33).toString("base64url"),
                                               y: Buffer.from(k.publicKey, "base64url").subarray(33).toString("base64url") }, format: "jwk" });
  const sig = Buffer.from(m[3], "base64url");
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]), { key: pub, dsaEncoding: "ieee-p1363" }, sig), "the signature verifies");
  assert.ok(!h.includes(k.privateKey));
  // cached per origin, a new one for another push service
  assert.equal(C.vapidAuth("https://fcm.googleapis.com/fcm/send/other", vapid, now + 1000), h);
  assert.notEqual(C.vapidAuth("https://updates.push.services.mozilla.com/wpush/v2/x", vapid, now), h);
});
