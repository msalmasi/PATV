// The wire contract of the incentive budget routes, shared with camfrog-bot (test/fixtures/budget-contract.json = its ci/fixtures/ copy, written by its
// tools/gen_budget_vectors.py, sha256 pinned in both repos' tests): every request the converted call sites send is accepted by the real route and each
// answer has the fixture's shape, status and fields.
//   PEPE_BOT_DIR=<camfrog-bot checkout> also compares the bot's copy byte for byte.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-budget-contract.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const H = require("./fixtures/budget-harness");

H.setProcess("policy-budget-contract");
const repo = path.resolve(__dirname, "..");
const FIX = path.join(__dirname, "fixtures", "budget-contract.json");
const PIN = "9134d43a4e526cbbfe99d9cc9c371731e994488d2c7aa4369ef9f06570775c55";
const RAW = fs.readFileSync(FIX);
const K = JSON.parse(RAW.toString("utf8"));
let X, B, server, base;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const USER = K.requests[0].body.dest.userId;
/** Same keys, same kinds of value, all the way down (a number where a number was, an object where an object was). */
function sameShape(got, want, where = "body") {
  if (want === null) return;
  if (typeof want !== "object") { assert.equal(typeof got, typeof want, where); return; }
  assert.equal(typeof got, "object", where);
  assert.ok(got !== null, where);
  for (const k of Object.keys(want)) { assert.ok(k in got, `${where}.${k} missing`); sameShape(got[k], want[k], `${where}.${k}`); }
}

test.before(async () => {
  X = await H.boot(repo);
  B = X.R("policy", "budget");
  await X.runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES (?, 'contract_user', 'x', 0)", [USER]);
  const express = require("express");
  const app = express();
  app.use(express.json());
  B.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await B.init();
});
test.after(() => server && server.close());

test("the fixture is the pinned one, LF only (and the bot's copy, when given)", () => {
  assert.equal(crypto.createHash("sha256").update(RAW).digest("hex"), PIN);
  assert.ok(!RAW.includes(13), "CR in the fixture");
  if (process.env.PEPE_BOT_DIR) assert.ok(RAW.equals(fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "ci", "fixtures", "budget-contract.json"))));
});

test("the tables agree: paths, the key rule, every flow, the refusal codes", () => {
  assert.equal(new RegExp(K.key_re).source, B.KEY_RE.source);
  assert.deepEqual(Object.keys(K.flows).sort(), Object.keys(B.SPEND_FLOWS).sort());
  for (const [f, x] of Object.entries(K.flows)) assert.deepEqual({ vault: x.vault, group: x.group, dests: x.dests }, Object.assign({}, B.SPEND_FLOWS[f]));
  assert.deepEqual(K.refusal_codes.slice().sort(), B.REFUSAL_CODES.slice().sort());
  for (const [state, code] of Object.entries(B.HTTP)) {
    const a = Object.values(K.answers).find((x) => x.body.state === state);
    if (a) assert.equal(a.status, code, state);
  }
});

test("with Pepe as the owner every request is answered not_owner and nothing is recorded", async () => {
  for (const q of K.requests) {
    const r = await post(K.paths.spend, q.body);
    assert.equal(r.status, K.answers.not_owner.status, q.site);
    sameShape(r.body, K.answers.not_owner.body);
    assert.equal(r.body.state, "not_owner");
  }
  assert.equal((await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends"))[0].n, 0);
  const s = await post(K.paths.status, { key: K.requests[0].body.key });
  sameShape(s.body, K.answers.status_unknown.body);
  sameShape((await post(K.paths.week, {})).body, K.answers.week_pepe.body);
});

test("with the site as the owner every request pays, in the fixture's shape; each other answer has its shape too", async () => {
  await X.owner("site");
  await X.C.putCfg(Object.assign({}, await X.C._pushForSource(), { econ_cfg: Object.assign({}, X.cfg, { budget_activity: 7000000 }) }));   // the top-up's size
  for (const q of K.requests) {
    const r = await post(K.paths.spend, q.body);
    assert.equal(r.status, 200, `${q.site}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.state, "paid", q.site);
    sameShape(r.body, q.body.dest.kind === "pad" ? K.answers.paid_pad.body : Object.assign({}, K.answers.paid_user.body, { dest: q.body.dest.kind === "user" ? K.answers.paid_user.body.dest : { kind: "" } }), q.site);
  }
  const q0 = K.requests[0].body;
  const dup = await post(K.paths.spend, q0);
  assert.equal(dup.body.dup, true);
  sameShape((await post(K.paths.status, { key: q0.key })).body, K.answers.status_paid.body);
  const over = await post(K.paths.spend, Object.assign({}, q0, { key: "beg:contract:over", amount: 2000000 }));
  assert.equal(over.status, K.answers.refused.status);
  sameShape(over.body, Object.assign({}, K.answers.refused.body));
  const conflict = await post(K.paths.spend, Object.assign({}, q0, { amount: 1 }));
  assert.equal(conflict.status, K.answers.conflict.status);
  sameShape(conflict.body, K.answers.conflict.body);
  const bad = await post(K.paths.spend, Object.assign({}, q0, { key: "beg:contract:bad", flow: "nope" }));
  assert.equal(bad.status, K.answers.invalid.status);
  sameShape(bad.body, K.answers.invalid.body);
  assert.equal((await post(K.paths.spend, Object.assign({}, K.void))).body.state, "paid", "a recorded key keeps its answer");
  await X.owner("site", 1);
  const p = await post(K.paths.spend, Object.assign({}, q0, { key: "beg:contract:paused" }));
  assert.equal(p.status, K.answers.paused.status);
  sameShape(p.body, K.answers.paused.body);
  await X.owner("cutting");
  const c = await post(K.paths.spend, Object.assign({}, q0, { key: "beg:contract:cut" }));
  assert.equal(c.status, K.answers.cutting.status);
  sameShape(c.body, K.answers.cutting.body);
  await X.owner("site");
  await X.P._setMeta("live", false); X.P._forgetLive();
  const off = await post(K.paths.spend, Object.assign({}, q0, { key: "beg:contract:off" }));
  assert.equal(off.status, K.answers.offline.status);
  sameShape(off.body, K.answers.offline.body);
  await X.P._setMeta("live", true); X.P._forgetLive();
  const un = await fetch(base + K.paths.spend, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({}, q0, { password: "x" })) });
  assert.equal(un.status, K.answers.unauthorized.status);
});
