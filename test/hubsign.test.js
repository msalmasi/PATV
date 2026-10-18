// 1.99acf hubsign.js: the per-request HMAC of the v1 seam (the chat design §16). A fixed test vector (docs/chat-tickets.md -
// the hub side reproduces it), the ±60 s window, a replayed nonce refused, and the other refusals.
//   node --test test/hubsign.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const S = require(path.join(path.resolve(__dirname, ".."), "hubsign"));

const KEY = "test-key-not-real";
const VEC = { method: "POST", path: "/internal/v1/heartbeat", body: '{"v":1}', keyId: "v1-prod-1", key: KEY, ts: 1760727600,
              nonce: "00112233445566778899aabbccddeeff" };

test("the fixed test vector", () => {
  assert.equal(S.bodyHash('{"v":1}'), "afbf9d0f3560b0fd7795e81c42a0a79ee6b6fc67e064f77826aee642cad28d91");
  assert.equal(S._base(VEC), "POST\n/internal/v1/heartbeat\n1760727600\n00112233445566778899aabbccddeeff\nafbf9d0f3560b0fd7795e81c42a0a79ee6b6fc67e064f77826aee642cad28d91");
  assert.deepEqual(S.sign(VEC), {
    "X-PATV-Key-Id": "v1-prod-1", "X-PATV-Ts": "1760727600", "X-PATV-Nonce": "00112233445566778899aabbccddeeff",
    "X-PATV-Sig": "v1=d74f5230393ff8b27f916e4089692954d0135d024e45f87962d7e974927ad31d",
  });
  assert.throws(() => S.sign({ ...VEC, key: "" }), /no key/);
});

test("the replay cache: only expired nonces are evicted; full of live ones it refuses (busy) instead of wiping them", () => {
  S._reset();
  S._setMax(5);
  try {
    const keys = { "v1-prod-1": KEY };
    const now = VEC.ts * 1000;
    const signed = [];
    for (let i = 0; i < 5; i++) {
      const h = S.sign({ ...VEC, nonce: require("crypto").randomBytes(16).toString("hex") });
      signed.push(h);
      assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: h, keys, now }).ok, true);
    }
    assert.equal(S._size(), 5);
    const sixth = S.sign({ ...VEC, nonce: require("crypto").randomBytes(16).toString("hex") });
    assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: sixth, keys, now }).error, "busy", "full: refused, not wiped");
    for (const h of signed) {
      assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: h, keys, now: now + 1000 }).error, "replay",
                   "every captured request is still refused as a replay");
    }
    // once their timestamps leave the window (ts + 60 s, + a margin) the nonces expire, and room is made by evicting only those
    const later = now + (S.SKEW_S + 10) * 1000;
    const fresh = S.sign({ ...VEC, ts: VEC.ts + S.SKEW_S + 10, nonce: require("crypto").randomBytes(16).toString("hex") });
    assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: fresh, keys, now: later }).ok, true);
    assert.equal(S._size(), 1, "the expired ones were swept, the new one kept");
    assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: signed[0], keys, now: later }).error, "stale",
                 "an old captured request is refused by its timestamp");
    assert.ok(S.NONCE_MS < 10 * 60 * 1000 && S.NONCE_MS >= 2 * S.SKEW_S * 1000, "nonces are kept only as long as they can matter");
  } finally { S._setMax(null); S._reset(); }
});

test("verify: good once, a replayed nonce refused; ±60 s; tampering, unknown keys and missing headers refused", () => {
  S._reset();
  const keys = { "v1-prod-1": KEY };
  const now = VEC.ts * 1000;
  const headers = S.sign(VEC);
  const v = (o = {}) => S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers, keys, now, ...o });
  assert.deepEqual(v(), { ok: true, keyId: "v1-prod-1" });
  assert.deepEqual(v(), { ok: false, error: "replay" }, "the same nonce again");
  const fresh = (dt) => S.verify({ method: "POST", path: VEC.path, body: VEC.body, keys, now: now + dt * 1000,
                                   headers: S.sign({ ...VEC, nonce: require("crypto").randomBytes(16).toString("hex") }) });
  assert.equal(fresh(60).ok, true, "60 s late is fine");
  assert.equal(fresh(-60).ok, true, "60 s early is fine");
  assert.equal(fresh(61).error, "stale");
  assert.equal(fresh(-61).error, "stale");
  const h2 = S.sign({ ...VEC, nonce: "ffeeddccbbaa99887766554433221100" });
  assert.equal(S.verify({ method: "POST", path: VEC.path, body: '{"v":2}', headers: h2, keys, now }).error, "bad_sig", "body changed");
  assert.equal(S.verify({ method: "POST", path: "/internal/v1/other", body: VEC.body, headers: h2, keys, now }).error, "bad_sig", "path changed");
  assert.equal(S.verify({ method: "GET", path: VEC.path, body: VEC.body, headers: h2, keys, now }).error, "bad_sig", "method changed");
  assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: h2, keys: { "v1-prod-1": "other" }, now }).error, "bad_sig", "another key");
  assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: h2, keys: { other: KEY }, now }).error, "unknown_key");
  assert.equal(S.verify({ method: "POST", path: VEC.path, body: VEC.body, headers: { "X-PATV-Ts": "1" }, keys, now }).error, "missing");
  // headers in any case, or a getter
  const lower = Object.fromEntries(Object.entries(S.sign({ ...VEC, nonce: "0123456789abcdef0123456789abcdef" })).map(([k, x]) => [k.toLowerCase(), x]));
  assert.equal(S.verify({ method: "post", path: VEC.path, body: Buffer.from(VEC.body), headers: (n) => lower[n.toLowerCase()], keys, now }).ok, true);
});
