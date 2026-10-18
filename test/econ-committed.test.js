// 1.99acf the econ/committed callback (the chat design §13): idemBegin's done() (index.js -> huboutbox.idemDone) stores the
// outcome as before and, for a key in the chat hub's interaction namespace ("ix:..."), writes {key, tx, outcome, endpoint, at}
// to the hub outbox in the same transaction while hubseam.econ is on. Non-ix keys never; a second done() (or a replay, which
// never reaches done()) one row only; definitive refusals are outcomes too; fail() emits nothing.
//   node --test test/econ-committed.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "econ-committed-test-")));
delete process.env.STAGING;
delete process.env.HUB_V1_URL;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const HO = require(path.join(repo, "huboutbox"));

const claim = (key, endpoint) => runQuery("INSERT INTO idempotency_keys (key, endpoint) VALUES (?, ?)", [key, endpoint]);
const stored = async (key) => (await getQuery("SELECT status, body FROM idempotency_keys WHERE key = ?", [key]))[0];
const rows = () => getQuery("SELECT entity, payload, dedupe_key FROM hub_outbox WHERE topic = 'econ/committed' ORDER BY id");

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status INTEGER, body TEXT,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await HO.init();
});

test("switch off: done() stores the outcome and writes nothing for the hub", async () => {
  await claim("ix:off:tip", "tip");
  await HO.idemDone("ix:off:tip", "tip", 200, { ok: true, tx: "T0" });
  assert.equal((await stored("ix:off:tip")).status, 200);
  assert.equal((await rows()).length, 0);
});

test("an ix: key -> {key, tx, outcome, endpoint, at}; non-ix keys never; a second done() is one row", async () => {
  await HO.setSettings({ econ: true });
  await claim("ix:01JB2R:tip", "tip");
  await HO.idemDone("ix:01JB2R:tip", "tip", 200, { ok: true, tx: "T1", balance: 5 });
  const s = await stored("ix:01JB2R:tip");
  assert.equal(s.status, 200);
  assert.deepEqual(JSON.parse(s.body), { ok: true, tx: "T1", balance: 5 }, "the stored response is unchanged (replays get it)");
  let r = await rows();
  assert.equal(r.length, 1);
  const p = JSON.parse(r[0].payload);
  assert.deepEqual({ ...p, at: 0 }, { key: "ix:01JB2R:tip", tx: "T1", outcome: { status: 200, ok: true, code: null }, endpoint: "tip", at: 0 });
  assert.equal(r[0].entity, "ix:01JB2R:tip");
  assert.equal(r[0].dedupe_key, "econ:ix:01JB2R:tip");
  await HO.idemDone("ix:01JB2R:tip", "tip", 200, { ok: true, tx: "T1" });
  assert.equal((await rows()).length, 1, "deduped on the key");
  await claim("rt-1234-abcd", "wager/charge");
  await HO.idemDone("rt-1234-abcd", "wager/charge", 200, { ok: true, transactionId: "T2" });
  assert.equal((await stored("rt-1234-abcd")).status, 200);
  assert.equal((await rows()).length, 1, "v1's own keys never reach the hub");
});

test("definitive refusals are outcomes too (the reconciler can stop); transactionId is read when tx is absent", async () => {
  await claim("ix:01JB2S:charge", "wager/charge");
  await HO.idemDone("ix:01JB2S:charge", "wager/charge", 402, { ok: false, error: "insufficient_funds" });
  await claim("ix:01JB2T:charge", "wager/charge");
  await HO.idemDone("ix:01JB2T:charge", "wager/charge", 200, { ok: true, transactionId: "T9" });
  const r = (await rows()).map((x) => JSON.parse(x.payload));
  const refused = r.find((x) => x.key === "ix:01JB2S:charge");
  assert.deepEqual(refused.outcome, { status: 402, ok: false, code: "insufficient_funds" });
  assert.equal(refused.tx, null);
  assert.equal(r.find((x) => x.key === "ix:01JB2T:charge").tx, "T9");
});

test("index.js wires done() to huboutbox.idemDone; fail() and replays never emit", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const begin = src.slice(src.indexOf("async function idemBegin"), src.indexOf("// ── Wager escrow"));
  assert.match(begin, /done: \(status, body\) => require\("\.\/huboutbox"\)\.idemDone\(key, endpoint, status, body\)/);
  assert.match(begin, /fail: \(\) => runQuery\("DELETE FROM idempotency_keys WHERE key = \? AND status IS NULL"/);
  assert.ok(!/emit\(/.test(begin), "nothing else in idemBegin talks to the hub (a replay returns before done)");
});
