// 1.99acm hubinbound.js: the hub's signed calls into v1 (seam plan §2.5). 404 without an inbound key (or with one of another
// env / direction); verified over the raw target (path + query exactly as sent) and the raw body, with the current and the
// previous key; another direction's or environment's key refused (wrong_env), a replay 409, a stale request 401, a tampered
// body 401; snapshot pages and 404 for a switched-off topic; rewind's effect; Cache-Control: no-store; the site's JSON parser
// never touches /internal/ (index.js), and a form-encoded body (parsed by the site first) fails closed; /admin/keys#seam status.
//   node --test test/hubinbound.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "hubinbound-test-")));
delete process.env.STAGING;
delete process.env.HUB_V1_URL;
process.env.HUB_V1_ENV = "test";
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const HO = require(path.join(repo, "huboutbox"));
const IN = require(path.join(repo, "hubinbound"));
const S = require(path.join(repo, "hubsign"));
const V = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "hubseam-sign-vectors.json"), "utf8"));

let base, server;
const signed = (method, target, body = "", keyId = "hub-test-1", key = V.keys["hub-test-1"], ts) => S.sign({ method, path: target, body, keyId, key, ts });
const call = async (method, target, { body = "", headers = null, keyId, key, ts } = {}) => {
  const h = headers || signed(method, target, body, keyId, key, ts);
  const r = await fetch(base + target, { method, headers: { ...h, ...(body ? { "content-type": "application/json" } : {}) }, body: body || undefined });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return { status: r.status, j, cache: r.headers.get("cache-control"), retry: r.headers.get("retry-after") };
};

test.before(async () => {
  await HO.init();
  const app = express();
  // the same order as index.js: the site's parsers (JSON skipping /internal/, forms) run before the routes
  app.use((req, res, next) => (req.path.startsWith("/internal/") ? next() : express.json()(req, res, next)));
  app.use(express.urlencoded({ extended: true }));
  IN.register(app);
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("404 until an inbound key of direction hub for this env is set", async () => {
  delete process.env.HUB_V1_IN_KEY_ID; delete process.env.HUB_V1_IN_KEY;
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked")).status, 404);
  process.env.HUB_V1_IN_KEY_ID = "hub-staging-1";                  // another env's id
  process.env.HUB_V1_IN_KEY = V.keys["hub-test-1"];
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "hub-staging-1" })).status, 404);
  assert.equal(IN.status().env_ok, false, "/admin/keys#seam says why");
  process.env.HUB_V1_IN_KEY_ID = "v1-test-1";                     // the other direction's id
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "v1-test-1" })).status, 404);
  process.env.HUB_V1_IN_KEY_ID = "hub-test-1";
  assert.equal(IN.configured(), true);
});

test("signed requests: the raw target and body, both keys during a rotation; refusals by code; no-store", async () => {
  await HO.setSettings({ sessions: true });
  S._reset();
  const ok = await call("GET", "/internal/v1/snapshot/sessions/revoked");
  assert.equal(ok.status, 200);
  assert.equal(ok.cache, "no-store");
  assert.equal(ok.j.topic, "sessions/revoked");
  assert.equal(ok.j.complete, true);
  // the previous key during a rotation
  process.env.HUB_V1_IN_PREV_KEY_ID = "hub-test-0";
  process.env.HUB_V1_IN_PREV_KEY = "hub-test-previous-key-0123456789-not-real";
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "hub-test-0", key: process.env.HUB_V1_IN_PREV_KEY })).status, 200);
  delete process.env.HUB_V1_IN_PREV_KEY_ID; delete process.env.HUB_V1_IN_PREV_KEY;
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "hub-test-0", key: "hub-test-previous-key-0123456789-not-real" })).status, 401,
               "...and not once it is dropped");
  // a replay
  const h = signed("GET", "/internal/v1/snapshot/sessions/revoked");
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: h })).status, 200);
  const rp = await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: h });
  assert.deepEqual([rp.status, rp.j.error, rp.cache], [409, "replay", "no-store"]);
  // the query is signed: a cursor added after signing fails
  const hq = signed("GET", "/internal/v1/snapshot/sessions/revoked");
  assert.deepEqual((await call("GET", "/internal/v1/snapshot/sessions/revoked?cursor=eyJrIjoieiJ9", { headers: hq })).j, { ok: false, error: "bad_sig" });
  // other directions / environments: wrong_env; unsigned: missing; stale
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "v1-test-1", key: V.keys["v1-test-1"] })).j.error, "wrong_env");
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "hub-staging-1", key: V.keys["hub-test-1"] })).j.error, "wrong_env");
  assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "hub-test-9" })).j.error, "unknown_key");
  assert.deepEqual([(await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: {} })).status], [401]);
  const st = await call("GET", "/internal/v1/snapshot/sessions/revoked", { ts: Math.floor(Date.now() / 1000) - 61 });
  assert.deepEqual([st.status, st.j.error], [401, "stale"]);
  // a POST body is verified as the raw bytes (the site's JSON parser never ran on it)
  const body = JSON.stringify({ topic: "sessions/revoked", after_id: 0 });
  const hb = signed("POST", "/internal/v1/outbox/rewind", body);
  const tampered = await call("POST", "/internal/v1/outbox/rewind", { headers: hb, body: JSON.stringify({ topic: "sessions/revoked", after_id: 0 }, null, 1) });
  assert.deepEqual([tampered.status, tampered.j.error], [401, "bad_sig"], "the same JSON, other bytes");
  // unknown routes under /internal/v1 and a switched-off topic: 404 (after the signature)
  assert.equal((await call("GET", "/internal/v1/nope")).status, 404);
  await HO.setSettings({ sessions: false });
  const off = await call("GET", "/internal/v1/snapshot/sessions/revoked");
  assert.deepEqual([off.status, off.cache], [404, "no-store"]);
  assert.equal((await call("GET", "/internal/v1/snapshot/econ/committed")).status, 404);
  const s = IN.status();
  assert.ok(s.last.snapshot && s.last.snapshot.status === 404);
  assert.ok(s.refused.replay >= 1 && s.refused.bad_sig >= 2 && s.refused.wrong_env >= 2);
});

test("rewind over the wire: kept rows above after_id are posted again", async () => {
  await runQuery("DELETE FROM hub_outbox");
  await HO.setSettings({ erasure: true });
  for (let i = 0; i < 3; i++) await tx(() => HO.emit("privacy/forget", "forget:" + i, { i }, { dedupe: "in" + i }));
  await HO.setSettings({ erasure: false });
  await runQuery("UPDATE hub_outbox SET posted_at = 1");
  const first = (await getQuery("SELECT MIN(id) AS id FROM hub_outbox"))[0].id;
  const body = JSON.stringify({ topic: "privacy/forget", after_id: first });
  const r = await call("POST", "/internal/v1/outbox/rewind", { body });
  assert.equal(r.status, 200);
  assert.deepEqual(r.j, { ok: true, reposted: 2, oldest_kept_id: first, head: await HO.headId() });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n, 2);
  assert.equal((await call("POST", "/internal/v1/outbox/rewind", { body: JSON.stringify({ topic: "nope", after_id: 0 }) })).status, 404);
  assert.equal((await call("POST", "/internal/v1/outbox/rewind", { body: "{not json" })).status, 400);
  assert.ok(IN.status().last.rewind);
  // a form-encoded body is read by the site's form parser first: the raw bytes are gone, so the signature fails (closed)
  const form = "topic=privacy%2Fforget&after_id=0";
  const h = signed("POST", "/internal/v1/outbox/rewind", form);
  const r2 = await fetch(base + "/internal/v1/outbox/rewind", { method: "POST", headers: { ...h, "content-type": "application/x-www-form-urlencoded" }, body: form });
  assert.equal(r2.status, 401);
});

test("1.99acm: only the exact lowercase /internal/v1/ prefix, never through Cloudflare: a plain 404, nothing logged, nothing verified", async () => {
  await HO.setSettings({ sessions: true });
  IN._reset();
  const warns = [];
  const w = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    // a correctly signed request at another case of the prefix (Express mounts are case-insensitive)
    for (const target of ["/Internal/v1/snapshot/sessions/revoked", "/INTERNAL/V1/snapshot/sessions/revoked", "/internal/V1/snapshot/sessions/revoked"]) {
      const r = await fetch(base + target, { headers: signed("GET", target) });
      assert.equal(r.status, 404, target);
      assert.equal(await r.text(), "", "a bare 404 (nothing about the seam)");
    }
    // through the public edge: Cloudflare's headers
    for (const h of [{ "cf-ray": "8d1f2a3b4c5d6e7f-AMS" }, { "cf-connecting-ip": "203.0.113.5" }]) {
      const target = "/internal/v1/snapshot/sessions/revoked";
      const r = await fetch(base + target, { headers: { ...signed("GET", target), ...h } });
      assert.equal(r.status, 404);
    }
    assert.deepEqual(warns, [], "no log line for any of them");
    const st = IN.status();
    assert.equal(st.public_hits, 2, "/admin/keys#seam counts the public hits (the nginx rule is missing)");
    assert.deepEqual(Object.keys(st.refused), ["public"], "nothing reached the verifier");
    assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked")).status, 200, "the real route still answers");
  } finally { console.warn = w; await HO.setSettings({ sessions: false }); }
});

test("1.99acm: refusal warnings are rate-limited (one line per code per minute); the counters keep the totals", async () => {
  IN._reset();
  let t = 1_900_000_000_000;
  IN._setClock(() => t);
  const warns = [];
  const w = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    const bad = { "X-PATV-Key-Id": "hub-test-1", "X-PATV-Ts": String(Math.floor(t / 1000)), "X-PATV-Nonce": "ab".repeat(16), "X-PATV-Sig": "v1=00" };
    for (let i = 0; i < 25; i++) assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: bad })).status, 401);
    for (let i = 0; i < 5; i++) await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: {} });
    assert.equal(warns.filter((x) => x.includes("bad_sig")).length, 1);
    assert.equal(warns.filter((x) => x.includes("missing")).length, 1);
    assert.equal(IN.status().refused.bad_sig, 25);
    t += 61 * 1000;
    await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: { ...bad, "X-PATV-Ts": String(Math.floor(t / 1000)) } });
    assert.equal(warns.filter((x) => x.includes("bad_sig")).length, 2, "a minute later: one more line");
  } finally { console.warn = w; IN._setClock(null); }
});

test("1.99acm: nonces are taken durably - a restart (the in-memory cache gone) doesn't reopen the replay window", async () => {
  await HO.setSettings({ sessions: true, erasure: true });
  try {
    const target = "/internal/v1/snapshot/sessions/revoked";
    const h = signed("GET", target);
    assert.equal((await call("GET", target, { headers: h })).status, 200);
    S._reset();                                                    // a v1 restart / deploy: hubsign's memory is empty
    const rp = await call("GET", target, { headers: h });
    assert.deepEqual([rp.status, rp.j.error], [409, "replay"], "replayed within its ±60 s window after the restart: refused");
    const row = (await getQuery("SELECT key_id, until FROM hub_inbound_nonces WHERE nonce = ?", [h["X-PATV-Nonce"]]))[0];
    assert.equal(row.key_id, "hub-test-1");
    assert.ok(row.until >= Date.now() + 9 * 60 * 1000, "kept 10 minutes (the hub's rule)");
    // the rewind takes its nonce inside its own transaction: replayed after a restart -> 409 and no second rewind
    await runQuery("DELETE FROM hub_outbox");
    await tx(() => HO.emit("privacy/forget", "forget:n1", { n: 1 }, { dedupe: "n1" }));
    await runQuery("UPDATE hub_outbox SET posted_at = 1");
    const body = JSON.stringify({ topic: "privacy/forget", after_id: 0 });
    const hr = signed("POST", "/internal/v1/outbox/rewind", body);
    assert.equal((await call("POST", "/internal/v1/outbox/rewind", { headers: hr, body })).j.reposted, 1);
    await runQuery("UPDATE hub_outbox SET posted_at = 1");
    S._reset();
    const again = await call("POST", "/internal/v1/outbox/rewind", { headers: hr, body });
    assert.equal(again.status, 409);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE posted_at IS NULL"))[0].n, 0, "the replay changed nothing");
    // a rewind that fails leaves no nonce behind (it was taken inside the rewind's transaction, which rolled back)
    const bodyBad = JSON.stringify({ topic: "nope", after_id: 0 });
    const hb = signed("POST", "/internal/v1/outbox/rewind", bodyBad);
    assert.equal((await call("POST", "/internal/v1/outbox/rewind", { headers: hb, body: bodyBad })).status, 404);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_inbound_nonces WHERE nonce = ?", [hb["X-PATV-Nonce"]]))[0].n, 0);
    // cleanup sweeps expired nonces only
    await runQuery("INSERT INTO hub_inbound_nonces (key_id, nonce, until) VALUES ('hub-test-1', 'old0old0old0old0', 1)");
    assert.ok((await IN.cleanup()) >= 1);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_inbound_nonces WHERE nonce = 'old0old0old0old0'"))[0].n, 0);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_inbound_nonces WHERE nonce = ?", [h["X-PATV-Nonce"]]))[0].n, 1, "live ones stay");
  } finally { await HO.setSettings({ sessions: false, erasure: false }); }
});

test("the shared hub->v1 vectors verify at this receiver (env test)", () => {
  for (const v of V.positive.filter((x) => x.direction === "hub->v1")) {
    S._reset();
    const r = S.verifyFrom({ dir: "hub", env: "test", method: v.method, path: v.path, body: v.body, headers: v.headers,
                             keys: { "hub-test-1": V.keys["hub-test-1"] }, now: v.now_s * 1000 });
    assert.equal(r.ok, true, v.name);
  }
});

test("index.js: the JSON parser skips /internal/ (the form parser reads form bodies only) and the routes are mounted next to the seam", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /req\.path\.startsWith\("\/internal\/"\) \? next\(\) : express\.json\(\)\(req, res, next\)/);
  assert.match(src, /require\("\.\/hubinbound"\)\.register\(app\);/);
});

test("S1 H9-15-edge-key: a looks-only key signs POST /internal/v1/looks and nothing else (403 wrong_caller); it never stands in for the full key", async () => {
  process.env.HUB_V1_IN_KEY_ID = "hub-test-1";
  process.env.HUB_V1_IN_KEY = V.keys["hub-test-1"];
  const LK = "hub-test-looks-only-key-0123456789-not-real";
  process.env.HUB_V1_IN_LOOKS_KEY_ID = "hub-test-looks1";
  process.env.HUB_V1_IN_LOOKS_KEY = LK;
  const asLooks = { keyId: "hub-test-looks1", key: LK };
  IN._reset();
  try {
    await HO.setSettings({ sessions: true });
    assert.deepEqual(Object.keys(IN.looksKeys()), ["hub-test-looks1"]);
    assert.deepEqual(IN.status().looks_keys, ["hub-test-looks1"], "/admin/keys#seam can say which looks keys are in force");
    // the snapshot pull and the rewind: refused before any nonce is taken, with the hub's code for a key on a route its
    // caller may not call (seam plan §2.1), the code only
    const nonceRows = async (h) => (await getQuery("SELECT COUNT(*) AS n FROM hub_inbound_nonces WHERE nonce = ?", [h["X-PATV-Nonce"]]))[0].n;
    const hs = signed("GET", "/internal/v1/snapshot/sessions/revoked", "", asLooks.keyId, asLooks.key);
    const snap = await call("GET", "/internal/v1/snapshot/sessions/revoked", { headers: hs });
    assert.equal(snap.status, 403);
    assert.deepEqual(snap.j, { ok: false, error: "wrong_caller" });
    assert.equal(snap.cache, "no-store");
    assert.equal(await nonceRows(hs), 0, "a refused looks-only request takes no nonce");
    const rwBody = JSON.stringify({ topic: "sessions/revoked", after_id: 0 });
    const hr = signed("POST", "/internal/v1/outbox/rewind", rwBody, asLooks.keyId, asLooks.key);
    assert.equal((await call("POST", "/internal/v1/outbox/rewind", { headers: hr, body: rwBody })).status, 403);
    assert.equal(await nonceRows(hr), 0);
    assert.equal((await call("GET", "/internal/v1/looks", asLooks)).status, 403, "the looks route by POST only");
    assert.equal((await call("POST", "/internal/v1/nowhere", { ...asLooks, body: "{}" })).status, 403);
    assert.equal(IN.status().refused.wrong_caller, 4);
    assert.equal(IN.status().refused.scope, undefined);
    // the full key still reaches everything
    assert.equal((await call("GET", "/internal/v1/snapshot/sessions/revoked")).status, 200);
    // the looks call: past the gate exactly as the full key (here the looks switch is off: 404 not_found for both), its
    // nonce taken under the looks key's id (the 200 answer: huboutbox-s1.test.js, the golden call)
    const lb = JSON.stringify({ ids: [] });
    const hl = signed("POST", "/internal/v1/looks", lb, asLooks.keyId, asLooks.key);
    const byLooks = await call("POST", "/internal/v1/looks", { headers: hl, body: lb });
    const byFull = await call("POST", "/internal/v1/looks", { body: lb });
    assert.deepEqual([byLooks.status, byLooks.j], [byFull.status, byFull.j]);
    assert.deepEqual(byLooks.j, { ok: false, error: "not_found" });
    assert.deepEqual(await getQuery("SELECT key_id FROM hub_inbound_nonces WHERE nonce = ?", [hl["X-PATV-Nonce"]]), [{ key_id: "hub-test-looks1" }]);
    // a looks key that shares the full key's secret or id, or names another env or direction, is no key at all
    process.env.HUB_V1_IN_LOOKS_KEY = V.keys["hub-test-1"];
    assert.deepEqual(IN.looksKeys(), {});
    process.env.HUB_V1_IN_LOOKS_KEY = LK;
    for (const id of ["hub-test-1", "hub-staging-looks1", "v1-test-looks1"]) {
      process.env.HUB_V1_IN_LOOKS_KEY_ID = id;
      assert.deepEqual(IN.looksKeys(), {}, id);
    }
    process.env.HUB_V1_IN_LOOKS_KEY_ID = "hub-test-looks1";
    // its rotation pair works like the full key's
    process.env.HUB_V1_IN_LOOKS_PREV_KEY_ID = "hub-test-looks0";
    process.env.HUB_V1_IN_LOOKS_PREV_KEY = "hub-test-looks-only-previous-0123456789-x";
    assert.deepEqual(Object.keys(IN.looksKeys()).sort(), ["hub-test-looks0", "hub-test-looks1"]);
    const prev = await call("GET", "/internal/v1/snapshot/sessions/revoked", { keyId: "hub-test-looks0", key: process.env.HUB_V1_IN_LOOKS_PREV_KEY });
    assert.equal(prev.status, 403);
    // without the full key the routes don't exist, for the looks key too
    delete process.env.HUB_V1_IN_KEY_ID;
    assert.equal((await call("POST", "/internal/v1/looks", { ...asLooks, body: lb })).status, 404);
  } finally {
    process.env.HUB_V1_IN_KEY_ID = "hub-test-1";
    for (const k of ["HUB_V1_IN_LOOKS_KEY_ID", "HUB_V1_IN_LOOKS_KEY", "HUB_V1_IN_LOOKS_PREV_KEY_ID", "HUB_V1_IN_LOOKS_PREV_KEY"]) delete process.env[k];
    await HO.setSettings({ sessions: false });
  }
});
