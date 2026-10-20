// 1.99acf hubsign.js: the per-request HMAC of the v1 seam (the chat design §16). 1.99acm: the vectors are the shared file
// test/fixtures/hubseam-sign-vectors.json (byte-identical in the hub repo, both pinned by sha256 - so the two implementations
// provably agree): every positive vector signs to its headers and verifies at its receiver, every negative vector is refused
// with its code (in the shared refusal order); the hidden_h and why -> reason tables; the ±60 s window, a replayed nonce
// refused, and the other refusals.
//   node --test test/hubsign.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const S = require(path.join(path.resolve(__dirname, ".."), "hubsign"));

const FIX = path.join(__dirname, "fixtures");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
// Update together with the hub's copy (services/rooms/test/fixtures/, its pins in test/seam-sign.test.ts).
const PINS = {
  "hubseam-sign-vectors.json": "757649d1324767a9af6bbe22e0673bb3532883ac9dc1a8fa1301d2a8f5d6cd88",     // S1 (Q0 + Q5b, seam plan §12.11)
  "hubseam-golden-rows.json": "229350db2d64ef24b20a678b85ca83720eaeca2cf4383a9fa622663cc0dfc93c",
};
const V = JSON.parse(fs.readFileSync(path.join(FIX, "hubseam-sign-vectors.json"), "utf8"));

const KEY = "test-key-not-real";
const VEC = { method: "POST", path: "/internal/v1/heartbeat", body: '{"v":1}', keyId: "v1-prod-1", key: KEY, ts: 1760727600,
              nonce: "00112233445566778899aabbccddeeff" };

test("the shared fixture files are the pinned versions (a change on one side fails until the other is updated)", () => {
  for (const [name, pin] of Object.entries(PINS)) assert.equal(sha(fs.readFileSync(path.join(FIX, name))), pin, name);
  const other = process.env.PATV_HUB_DIR;           // optional: a hub checkout - the copies must be byte-identical
  if (other) {
    for (const name of Object.keys(PINS)) {
      assert.equal(sha(fs.readFileSync(path.join(other, "services", "rooms", "test", "fixtures", name))), PINS[name], "hub copy of " + name);
    }
  }
});

test("every positive vector: body hash, base string, headers; it verifies at its receiver (direction + environment)", () => {
  assert.ok(V.positive.length >= 6);
  for (const v of V.positive) {
    S._reset();
    const signed = S.sign({ method: v.method, path: v.path, body: v.body, keyId: v.key_id, key: V.keys[v.key_id], ts: v.ts, nonce: v.nonce });
    assert.equal(S.bodyHash(v.body), v.body_sha256, v.name);
    assert.equal(S._base({ keyId: v.key_id, method: v.method, path: v.path, ts: v.ts, nonce: v.nonce, body: v.body }), v.base, v.name);
    assert.deepEqual(signed, v.headers, v.name);
    const dir = v.direction === "hub->v1" ? "hub" : "v1";
    const keys = Object.fromEntries(Object.entries(V.keys).filter(([id]) => S.keyIdOk(id, dir, v.receiver_env)));
    const r = S.verifyFrom({ dir, env: v.receiver_env, method: v.method, path: v.path, body: Buffer.from(v.body, "utf8"), headers: v.headers,
                             keys, now: v.now_s * 1000 });
    assert.deepEqual(r, { ok: true, keyId: v.key_id }, v.name);
    assert.equal(S.verifyFrom({ dir, env: v.receiver_env, method: v.method, path: v.path, body: v.body, headers: v.headers, keys,
                                now: v.now_s * 1000 }).error, "replay", v.name + " (replayed)");
  }
  // the doc vector (docs/chat-tickets.md) is the first one
  assert.equal(V.positive[0].headers["X-PATV-Sig"], "v1=270a385ccba6ace561f8c1715198d39260435a33c0d61c721c5b5b533f26a18a");
  assert.throws(() => S.sign({ ...VEC, key: "" }), /no key/);
});

test("every negative vector is refused with its code; the refusal order is the shared one", () => {
  assert.deepEqual(V.refusal_order, ["missing", "wrong_env", "unknown_key", "stale", "missing (nonce format)", "bad_sig", "replay", "busy"]);
  for (const v of V.negative) {
    S._reset();
    const keys = Object.fromEntries(v.receiver_keys.map((id) => [id, V.keys[id]]));
    const dir = v.receiver_keys[0].split("-")[0];
    const r = S.verifyFrom({ dir, env: v.receiver_env, method: v.method, path: v.path, body: v.body, headers: v.headers, keys, now: v.now_s * 1000 });
    assert.deepEqual(r, { ok: false, error: v.error }, v.name);
  }
  // a key id outside the seam's shape is simply unknown; one of the right shape but the wrong direction / env is wrong_env
  assert.equal(S.keyIdOk("v1-test-1", "v1", "test"), true);
  assert.equal(S.keyIdOk("v1-test-1", "hub", "test"), false);
  assert.equal(S.keyIdOk("v1-staging-1", "v1", "test"), false);
  assert.equal(S.keyIdOk("v1stg-test", "v1", "staging"), false);
});

test("the hidden_h and why -> reason tables (the hub computes login hashes; v1's form is quotes.hiddenHash)", () => {
  process.chdir(fs.mkdtempSync(path.join(require("os").tmpdir(), "hubsign-test-")));   // hubhidden / quotes open a (temp) database
  const H = require(path.join(path.resolve(__dirname, ".."), "hubhidden"));
  for (const v of V.hidden_h) {
    if (v.h) assert.equal(H.hash(v.input), v.h, v.input);
    assert.equal(H.loginHash(v.input) != null, v.login_valid, v.input);
    if (v.login_valid) assert.equal(H.loginHash(v.input), v.h, v.input);
  }
  assert.equal(require(path.join(path.resolve(__dirname, ".."), "quotes")).hiddenHash("Alice"), V.hidden_h[0].h, "the same hash as quotes.hiddenHash");
  // v1 sends `why` as is; every string it writes maps to a reason class (the table both repos test)
  for (const why of ["signed out", "signed out everywhere", "signed out everywhere else", "account deletion requested", "password reset", "admin", "ban"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(V.why_reason, why), "why table covers " + why);
  }
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
