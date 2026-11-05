// PO-4 (economy policy -> site plan, "Phase 6"): the weekly staking audit + digest (policy/digest.js), Pepe's _tr_audit / _tr_digest
// ported - in SHADOW it audits Pepe's settled record, rebuilt from the site's rows, and compares with his own notices (sending
// nothing); LIVE (the treasury engine on the site, dormant until H2a) it sends them once per epoch to the Pepe owners + opsalerts.
//   * W2026-10-19-shaped: 8 stashes paid through landed moves, none notified, conserved false -> exactly one problem + the info line
//   * W2026-10-26 / W2026-11-02: the digests Pepe sent on prod (aggregate PAT only - public on /staking), byte for byte
//   * matching: his rows -> audit_match / digest_match 1; a different body 0; his replay-audit line still 1; a cut notice matches
//     on the title + the prefix rule; the shadow audit waits >= 10 min after his done, final at +2 h (a missing row: he sent none)
//   * live: result.p31 before == after; one wf-digest inbox row per owner account and one ops alert per ref; the audit notice only
//     with problems; a second afterEpoch / the retry sends nothing; a crash after the commit is sent once by the retry; the run's
//     conservation unchanged
//   * review of PO-4: a broken P3.1 read never aborts the settlement (p31 null); a crash mid-send leaves the notice unmarked and
//     the retry sends it once; the staging Monday (his simulated ts after his real done: no "legs took" problem) - a pending
//     tagged audit is finished by an untagged pass at +2 h
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-digest.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-digest-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const ST = require(path.join(repo, "stashes"));
const CC = require(path.join(repo, "capital", "core"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const G = require(path.join(repo, "policy", "gather"));
const A = require(path.join(repo, "policy", "apply"));
const DG = require(path.join(repo, "policy", "digest"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const SR = require(path.join(repo, "staffroles"));
const OPS = require(path.join(repo, "opsalerts"));
const inbox = require(path.join(repo, "inbox"));

const alerts = [];
OPS.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
const M = 1000000;
const MON = Date.UTC(2026, 10, 9, 4, 5) / 1000;          // Monday 2026-11-09 04:05 UTC
const EID = "W2026-11-09";
const POOLS = { reserve: 40 * M, bank: 3 * M, mm: 1 * M, fortknox: 16 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
const HOUSE = 20 * M;
const CFG = {
  econ_cfg: Object.assign({}, E.DEFAULTS, { fed_floor: 25 * M, fed_ceiling: 150 * M, incentive_guarantee_target: 25 * M }),
  consts: E.CONSTS, flags: { layers: true, tr_live: true, ap_on: false }, tz: "America/New_York", skip: [],
  journal: [{ eid: "W2026-11-02", boundary: Date.UTC(2026, 10, 2, 4) / 1000, state: "done", incentives_after: 3 * M }], days_done: [],
  burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0,
};
let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, cf, cls] of [["u1", "ann", "ann_cf", "pleb"], ["u2", "bob", "bob_cf", "pleb"], ["u3", "own", "owner_cf", "Admin"], ["u4", "own2", "owner2_cf", "Admin"],
                                     ["u5", "adm", "admin_cf", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, 0, ?)", [id, name, cls, cf]);
  }
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('owner2_cf', 'owner', 1), ('admin_cf', 'admin', 1)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  assert.equal((await P.importFromPepe({ key: "pc-digest-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                         totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } })).ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  await ST.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 1000, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "bob_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await ST.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 1000, count: 2, seq: 2 })).ok, true);
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 400000.0, s2: 100000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 3 * M }, mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 0.0, holders: {} }, queue: {}, epochs: [{ ts: MON - 60, price: { bank: 1, house: 2, mm: 1, auto: 1 }, nav: {}, staked: {} }], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: {}, fed_loans: {}, fed_loan_repaid: {} } },
                     econ_treasury: { rev: 1, doc: { week: { id: "W2026-11-02", budgets: {}, spent: {} }, bank_lent: [], days: {} } } });
  require(path.join(repo, "econ"));
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER DEFAULT 0,
                  mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  SCH.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await post("/api/policy/bot/config", { cfg: CFG })).body.ok, true);
  await C.setMode("treasury", "shadow", { by: "test", armedAt: MON - 7 * 86400 });
});
test.after(() => server && server.close());

// ── the pure audit / digest ──
const W1026 = {
  epoch: "W2026-10-26", boundary: Date.UTC(2026, 9, 26, 4) / 1000, ts: Date.UTC(2026, 9, 26, 4, 0, 28) / 1000, days: 7.0, staker_share: 0.2,
  vaults: {}, legs: [], done_legs: [], notified: {},
  track: { ref_cap_pct: 25.0, cap_in_force_pct: 0.0, pool: 214930, paid: 128627, would25: 128635, fallback: ["house", "bank"],
           vaults: { house: { pool: 214723, paid: 128425, cap25: 128428, would25: 128428, weighting: "partial", cap_pct: 25.0, fallback: true, payout_apr: 0.249 },
                     bank: { pool: 207, paid: 202, cap25: 300, would25: 207, weighting: "partial", cap_pct: 25.0, fallback: true, payout_apr: 0.2433 },
                     mm: { pool: 0, paid: 0, cap25: 0, would25: 0, weighting: "snapshot", cap_pct: 0.0, fallback: false } } },
};
const GOLDEN_1026 = {
  title: "Staking week W2026-10-26: paid 128,627 (25% cap: 128,635) ⚠",
  text: "🏛️ Staking week W2026-10-26: stakers were paid 128,627 of their 214,930 share of the protocol's surplus (weekly cap: none). A 25% APR cap would have paid 128,635. 🎰 House paid 128,425 of 214,723, a 25% cap: 128,428 · 🏦 Bank paid 202 of 207, a 25% cap: 207. Stakes weighted by PAT-days that began mid-week. Capped at 25% APR this week (not a full week of time-weighting): 🎰 House, 🏦 Bank.",
};
const GOLDEN_1102 = {
  title: "Staking week W2026-11-02: paid 144,945 (25% cap: 144,948)",
  text: "🏛️ Staking week W2026-11-02: stakers were paid 144,945 of their 144,948 share of the protocol's surplus (weekly cap: none). A 25% APR cap would have paid 144,948. 🎰 House paid 144,945 of 144,948, a 25% cap: 144,948. Stakes weighted by PAT-days (time-weighted).",
};
const W1102 = { epoch: "W2026-11-02", track: { ref_cap_pct: 25.0, cap_in_force_pct: 0.0, pool: 144948, paid: 144945, would25: 144948, fallback: [],
                                             vaults: { house: { pool: 144948, paid: 144945, cap25: 151000, would25: 144948, weighting: "pat_days", cap_pct: 0.0, fallback: false, payout_apr: 0.24 },
                                                       bank: { pool: 0, paid: 0, cap25: 0, would25: 0, weighting: "snapshot", cap_pct: 0.0, fallback: false } } } };

/** A W2026-10-19-shaped record: the House paid 8 stashes (invented ids) through landed moves; no payout notice; conserved false. */
function w1019() {
  const eid = "W2026-10-19";
  const ids = ["31", "4", "17", "8", "26", "12", "40", "5"];
  const legs = ids.map((id, i) => ({ tid: `wf-${eid}-house-stk-${id}`, src: "jackpot", dst: `stash:${id}`, amt: 1000 + i, why: "waterfall stakers", vault: "house" }));
  const stk = legs.reduce((s, l) => s + l.amt, 0);
  legs.push({ tid: `wf-${eid}-house-fed`, src: "jackpot", dst: "reserve", amt: 5000, why: "waterfall fed", vault: "house" });
  legs.push({ tid: `wf-${eid}-house-inc`, src: "jackpot", dst: "incentives", amt: 5000, why: "waterfall incentives", vault: "house" });
  return { epoch: eid, boundary: Date.UTC(2026, 9, 19, 4) / 1000, ts: Date.UTC(2026, 9, 19, 4, 0, 26) / 1000, done: Date.UTC(2026, 9, 19, 4, 0, 37) / 1000, days: 7.0,
           vaults: { house: { surplus: stk + 10000, stakers_share: 20000, apr_cap: 20000, staked: 0, stakers: stk, stakers_n: 8, fed: 5000, incentives: 5000, price: 2.0 } },
           legs, done_legs: legs.map((l) => l.tid), notified: {}, conserved: false, pools_before: 100 * M, pools_after: 100 * M - 10502634 };
}

test("a W2026-10-19-shaped record: 8 paid stashes without a notice -> exactly one problem (+ the conservation info line)", () => {
  const rec = w1019();
  const a = DG.auditRecord(rec, { stakers: () => [], lastBoundary: 0, now: rec.done });
  assert.deepEqual(a.problems, ["8 paid stash(es) got no payout notice: 12, 17, 26, 31, 4, 40"], "sorted as strings (Python sorted), the first 6");
  assert.deepEqual(a.info, ["pools before 100,000,000 != after 89,497,366 (off by -10,502,634: other activity during the run)"], "the conservation line (info, not a problem)");
  assert.deepEqual(a.bind, { house: 0.4014 });
  assert.deepEqual(DG.auditNotice(rec.epoch, a.problems), { title: "Staking audit W2026-10-19: 1 problem(s)",
                                                            text: "🏛️ Staking payouts W2026-10-19: 1 problem(s) - 8 paid stash(es) got no payout notice: 12, 17, 26, 31, 4, 40" });
  // with the notices: clean
  rec.notified = Object.fromEntries(["31", "4", "17", "8", "26", "12", "40", "5"].map((id) => [id, rec.done]));
  assert.deepEqual(DG.auditRecord(rec, { now: rec.done }).problems, []);
  assert.equal(DG.auditNotice(rec.epoch, []), null);
});

test("the W2026-10-26 and W2026-11-02 digests Pepe sent on prod, byte for byte", () => {
  const a = DG.auditRecord(Object.assign({}, W1026, { done: W1026.ts + 5 }), { now: W1026.ts + 5 });
  assert.deepEqual(a.problems, [], "a notice for every paid stash: clean");
  assert.deepEqual(DG.digestOf(W1026, ""), GOLDEN_1026);
  assert.deepEqual(DG.digestOf(W1102, ""), GOLDEN_1102);
  assert.ok(a.info.some((x) => /^house: no weekly cap, but not a full week of time-weighting \(partial\): paid under the 25% reference cap$/.test(x)));
  // code points, not UTF-16 units: the text's length as Python counts it
  assert.equal(DG.cpLen(GOLDEN_1026.text), Array.from(GOLDEN_1026.text).length);
  assert.ok(GOLDEN_1026.text.length > DG.cpLen(GOLDEN_1026.text), "'🏛️' is 2 code points, 3 units");
  // Python's half-even on the exact double ('.0f'): 0.5 -> "0", 1.5 -> "2", 2.5 -> "2"; ':g'
  assert.deepEqual([0.5, 1.5, 2.5, 15.5, 16.5].map((x) => DG.fixed(x, 0)), ["0", "2", "2", "16", "16"]);
  assert.deepEqual([25.0, 12.3456, 100, 0.5, 1e6, 37.12].map((x) => DG.fmtG(x)), ["25", "12.3456", "100", "0.5", "1e+06", "37.12"]);
  assert.equal(DG.fixed(1234567.5, 0, true), "1,234,568");
});

test("matching Pepe's rows: equal -> match; another body -> no match; his replay-audit line; a notice cut at 590", () => {
  const rec = W1026;
  const render = (al) => DG.digestOf(rec, al);
  assert.equal(DG.matchDigest(render, GOLDEN_1026.text), true);
  assert.equal(DG.matchDigest(render, GOLDEN_1026.text.replace("128,425", "128,426")), false);
  const aline = " 🔎 Staking audit: can't verify rebalances rb12, rb13 - several cut-offs fit by time and price; the book still rebuilds (!econ staking audit).";
  const withLine = DG.digestOf(rec, aline).text;
  assert.ok(withLine.endsWith(aline));
  assert.equal(DG.matchDigest(render, DG.storedBody(withLine)), true, "his line is split off and the site's digest re-rendered with it");
  // the audit notice: a long list cut at 590 - the title exact, the items a multiset, the cut item a prefix
  const probs = Array.from({ length: 12 }, (_, i) => `house: stash ${100 + i} was paid 1,000 but holds no stake there`);
  const n = DG.auditNotice("W2026-10-26", probs);
  assert.equal(DG.cpLen(n.text), 590);
  const shuffled = probs.slice().reverse();
  const pepe = DG.auditNotice("W2026-10-26", shuffled);
  assert.equal(DG.matchAudit("W2026-10-26", probs, { title: pepe.title, body: DG.storedBody(pepe.text) }), true, "another set order, cut");
  assert.equal(DG.matchAudit("W2026-10-26", probs.slice(1), { title: pepe.title, body: DG.storedBody(pepe.text) }), false, "another count");
  assert.equal(DG.matchAudit("W2026-10-26", probs, { title: pepe.title, body: DG.storedBody(pepe.text.replace("stash 111", "stash 999")) }), false);
  assert.equal(DG.matchAudit("W2026-10-26", [], null), true, "neither sent one");
});

// ── the shadow audit on the site's rows ──
/** Pepe's settled week on the site: his shadow report (plan + inputs), his legs landed, his push saying it's done at `doneS`. */
async function pepeWeek(eid, nowS, doneS, { notify = true } = {}) {
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, 's', NULL, ?)", [`topup-${eid}`, 6 * M]);   // the week's House profit
  const inputs = await G.epoch(nowS, eid);
  const plan = E.planEpoch(inputs);
  assert.ok(plan.legs.some((l) => l.why === "waterfall stakers"), JSON.stringify(plan.totals));
  for (const l of plan.legs) await tx(() => A.transfer(l.tid, l.src, l.dst, l.amt, l.why));
  await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, pepe_inputs, pepe_plan, ok, created, updated) VALUES (?, 'shadow', 'treasury', ?, ?, ?, 1, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET pepe_inputs = excluded.pepe_inputs, pepe_plan = excluded.pepe_plan`,
                 [`shadow:treasury:${eid}`, eid, JSON.stringify(inputs), JSON.stringify(plan), Date.now(), Date.now()]);
  if (notify) {
    for (const id of new Set(plan.legs.filter((l) => l.why === "waterfall stakers").map((l) => l.dst.slice(6)))) {
      const s = await ST.get(id);
      await inbox.add(s.owner_id, { kind: "staking", title: "Staking payout", body: "x", ref: `wf:${eid}:s${id}` });
    }
  }
  const m = (await CC.meta("cfg")) || {};
  m.wf_settled = (m.wf_settled || []).concat([{ epoch: eid, boundary: plan.boundary, state: "done", done: doneS }]);
  await CC.setMeta("cfg", m);
  return { inputs, plan, track: E.trackOf(inputs, plan) };
}
async function pepeNotices(eid, rec, { body = null } = {}) {
  const d = DG.digestOf(rec, "");
  if (d) await inbox.add("u5", { kind: "admin", title: d.title, body: body === null ? d.text : body, link: "/admin/economy", ref: `wf-digest:${eid}` });
  const a = DG.auditNotice(eid, DG.auditRecord(rec, { now: rec.done }).problems);
  if (a) await inbox.add("u5", { kind: "admin", title: a.title, body: a.text, link: "/admin/economy", ref: `wf-audit:${eid}` });
}

test("the shadow audit: waits >= 10 min after Pepe's done; his matching rows -> audit_match 1, digest_match 1; it sends nothing", async () => {
  const eid = "W2026-11-02-p4a";
  const now = MON - 7 * 86400 + 60;
  const done = now + 30;                                            // his settled time (the legs took 30 s)
  const w = await pepeWeek(eid, now, done);
  const inbox0 = (await getQuery("SELECT COUNT(*) AS n FROM inbox"))[0].n;
  const a0 = alerts.length;
  assert.equal(await DG.shadowAudit(eid, done + 599), null, "less than 10 minutes after his done: not yet");
  assert.equal(await DG.row(eid), null);
  // his rows aren't there yet: pending
  assert.equal(await DG.shadowAudit(eid, done + 700), "pending");
  let r = await DG.row(eid);
  assert.equal(r.via, "shadow");
  assert.equal(r.state, "pending");
  assert.equal(r.digest_match, null);
  // his notices arrive (the same digest; no problems -> no audit notice): the digest matches; the audit waits for the 2 h
  const got = await DG.pepeRecord(eid, done);
  assert.deepEqual(got.rec.done_legs, w.plan.legs.map((l) => l.tid), "every leg landed");
  await pepeNotices(eid, got.rec);
  assert.equal(await DG.shadowAudit(eid, done + 800), "pending");
  r = await DG.row(eid);
  assert.equal(r.digest_match, 1);
  assert.equal(r.audit_match, null, "his audit row may still come");
  assert.equal(await DG.shadowAudit(eid, done + 2 * 3600 + 1), "final");
  r = await DG.row(eid);
  assert.equal(r.state, "final");
  assert.equal(r.audit_match, 1, "neither sent an audit notice");
  assert.equal(r.digest_match, 1);
  assert.deepEqual(r.audit.problems, []);
  assert.ok(r.audit.na.length >= 1, "Pepe's P3.1 sums: not pushed (na)");
  assert.equal(r.pepe.digest_title, DG.digestOf(got.rec, "").title);
  // it sent nothing: the inbox gained only Pepe's own rows (1 digest), no ops alert
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox"))[0].n, inbox0 + 1);
  assert.equal(alerts.length, a0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_effects WHERE key LIKE '%wf-%'"))[0].n, 0);
  // final is final
  const u = r.updated;
  assert.equal(await DG.shadowAudit(eid, done + 3 * 3600), "final");
  assert.equal((await DG.row(eid)).updated, u);
});

test("the shadow audit: a body that differs -> 0; a missing payout notice on both sides -> the same problem, match 1; no row at +2 h = he sent none", async () => {
  // (a) Pepe's digest body differs
  const e1 = "W2026-10-26-p4b";
  const d1 = MON - 14 * 86400 + 90;
  await pepeWeek(e1, MON - 14 * 86400 + 60, d1);
  const g1 = await DG.pepeRecord(e1, d1);
  await pepeNotices(e1, g1.rec, { body: "🏛️ Staking week something else" });
  assert.equal(await DG.shadowAudit(e1, d1 + 2 * 3600 + 5), "final");
  assert.equal((await DG.row(e1)).digest_match, 0);
  // (b) no payout notice reached the stashes: both audits say so (his notice = the site's), match
  const e2 = "W2026-10-19-p4c";
  const d2 = MON - 21 * 86400 + 90;
  await pepeWeek(e2, MON - 21 * 86400 + 60, d2, { notify: false });
  const g2 = await DG.pepeRecord(e2, d2);
  const probs = DG.auditRecord(g2.rec, { now: d2 }).problems;
  assert.ok(probs.length === 1 && /paid stash\(es\) got no payout notice: 1, 2$/.test(probs[0]), probs.join(" | "));
  await pepeNotices(e2, g2.rec);
  assert.equal(await DG.shadowAudit(e2, d2 + 700), "final", "both of his rows seen: final at once");
  const r2 = await DG.row(e2);
  assert.equal(r2.audit_match, 1);
  assert.equal(r2.digest_match, 1);
  // (c) the site would send a digest, Pepe sent none by +2 h -> "he sent none": 0
  const e3 = "W2026-10-12-p4d";
  const d3 = MON - 28 * 86400 + 90;
  await pepeWeek(e3, MON - 28 * 86400 + 60, d3);
  assert.equal(await DG.shadowAudit(e3, d3 + 3600), "pending");
  assert.equal(await DG.shadowAudit(e3, d3 + 2 * 3600 + 1), "final");
  assert.equal((await DG.row(e3)).digest_match, 0);
});

// ── the live path (dormant until H2a) ──
test("live: the site's own epoch -> result.p31 before == after; one wf-digest row per owner + one ops alert per ref, once; the retry after a crash sends once", async () => {
  const rec0 = await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref LIKE 'wf-digest:%' OR ref LIKE 'wf-audit:%'");
  await C.setMode("treasury", "live", { by: "test", armedAt: MON - 3600 });
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('topup-live', 's', NULL, ?)", [10 * M]);   // the House earned this week
  const a0 = alerts.length;
  const res = await A.runTreasuryEpoch(EID, MON);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.result.p31 && res.result.p31.before === res.result.p31.after, JSON.stringify(res.result.p31));
  assert.equal(res.result.conserved, res.result.pools_before === res.result.pools_after + (res.result.to_wallet || 0));
  assert.equal(res.result.conserved, true, "the run's own conservation is unchanged by the hook");
  const owners = ["u3", "u4"];
  const dig = await getQuery("SELECT user_id, title, body, link FROM inbox WHERE ref = ? ORDER BY user_id", [`wf-digest:${EID}`]);
  assert.deepEqual(dig.map((r) => r.user_id), owners, "every Pepe-owner account, nobody else");
  assert.equal(dig[0].link, "/admin/economy");
  assert.equal(dig[0].title, DG.digestOf(Object.assign({}, res.plan, { track: res.track }), "").title);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref = ?", [`wf-audit:${EID}`]))[0].n, 0, "no problems: no audit notice");
  const mine = alerts.slice(a0);
  assert.deepEqual(mine.map((a) => [a.source, a.ref]), [["staking-digest", `wf-digest:${EID}`]]);
  const row = await DG.row(EID);
  assert.equal(row.via, "site");
  assert.ok(row.digest_sent_at && row.audit_sent_at);
  // a second afterEpoch / the retry: nothing more
  await DG.afterEpoch(EID, res);
  assert.deepEqual(await DG.retryLive(), []);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref = ?", [`wf-digest:${EID}`]))[0].n, 2);
  assert.equal(alerts.length, a0 + 1);
  // a crash between the commit and the digest (the next week): the retry pass sends it once
  const NEXT = MON + 7 * 86400, EID2 = "W2026-11-16";
  const orig = DG.afterEpoch, origP31 = DG.p31Base;
  DG.afterEpoch = async () => { throw new Error("crash after the commit"); };
  DG.p31Base = () => { throw new Error("a broken monitoring read"); };     // review of PO-4: the P3.1 read never aborts a settlement
  let r2;
  try { r2 = await A.runTreasuryEpoch(EID2, NEXT); } finally { DG.afterEpoch = orig; DG.p31Base = origP31; }
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.result.p31, { before: null, after: null }, "the P3.1 read failed: logged, null, the epoch settled");
  assert.equal(r2.result.conserved, true);
  assert.equal(await DG.row(EID2), null, "no audit row: the crash");
  const sent = await DG.retryLive();
  assert.deepEqual(sent, [EID2]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref = ?", [`wf-digest:${EID2}`]))[0].n, r2.track && r2.track.pool > 0 ? 2 : 0);
  assert.deepEqual(await DG.retryLive(), [], "once");
  // the digest pass (live) runs the retry and never throws
  assert.ok(Array.isArray(await SCH.digestPass(NEXT + 60, await SCH.clockInfo(NEXT + 60), { mode: "live" })));
  void rec0;
  await C.setMode("treasury", "shadow", { by: "test", armedAt: MON - 7 * 86400 });
});

test("live: an epoch with a problem sends the audit notice (problems only) to the owners + one ops alert", async () => {
  // a site-run record whose payout notice didn't reach a stash (an owner with no account): the audit says so
  const eid = "W2026-11-23";
  const plan = { epoch: eid, boundary: Date.UTC(2026, 10, 23, 4) / 1000, ts: Date.UTC(2026, 10, 23, 4, 5) / 1000, days: 7.0, staker_share: 0.2,
                 vaults: { house: { surplus: 3000, stakers_share: 600, apr_cap: 600, staked: 0, stakers: 600, stakers_n: 1, fed: 1200, incentives: 1200, price: 2.0 } },
                 legs: [{ tid: `wf-${eid}-house-stk-9`, src: "jackpot", dst: "stash:9", amt: 600, why: "waterfall stakers", vault: "house" },
                        { tid: `wf-${eid}-house-fed`, src: "jackpot", dst: "reserve", amt: 1200, why: "waterfall fed", vault: "house" },
                        { tid: `wf-${eid}-house-inc`, src: "jackpot", dst: "incentives", amt: 1200, why: "waterfall incentives", vault: "house" }], totals: {} };
  await C.putRun("treasury", eid, { state: "done", boundary: plan.boundary, via: "site", inputs: { cfg: {}, vaults: {}, journal: [] }, plan,
                                    result: { done_legs: plan.legs.map((l) => l.tid), conserved: true } });
  const a0 = alerts.length;
  const out = await DG.afterEpoch(eid, null);
  assert.deepEqual(out.audit.problems, ["1 paid stash(es) got no payout notice: 9"]);
  assert.equal(out.sent.audit, true);
  const rows = await getQuery("SELECT user_id, title, body FROM inbox WHERE ref = ? ORDER BY user_id", [`wf-audit:${eid}`]);
  assert.deepEqual(rows.map((r) => r.user_id), ["u3", "u4"]);
  assert.equal(rows[0].title, `Staking audit ${eid}: 1 problem(s)`);
  assert.equal(rows[0].body, `🏛️ Staking payouts ${eid}: 1 problem(s) - 1 paid stash(es) got no payout notice: 9`);
  assert.ok(alerts.slice(a0).some((a) => a.source === "staking-digest" && a.ref === `wf-audit:${eid}`));
  assert.equal((await DG.afterEpoch(eid, null)).sent.audit, false, "once");
});

test("review of PO-4: a crash while a live notice goes out leaves it unmarked - the retry sends it, once", async () => {
  const eid = "W2026-11-30";
  const plan = { epoch: eid, boundary: Date.UTC(2026, 10, 30, 4) / 1000, ts: Date.UTC(2026, 10, 30, 4, 5) / 1000, days: 7.0, staker_share: 0.2,
                 vaults: { house: { surplus: 3000, stakers_share: 600, apr_cap: 600, staked: 0, stakers: 600, stakers_n: 1, fed: 1200, incentives: 1200, price: 2.0 } },
                 legs: [{ tid: `wf-${eid}-house-stk-9`, src: "jackpot", dst: "stash:9", amt: 600, why: "waterfall stakers", vault: "house" },
                        { tid: `wf-${eid}-house-fed`, src: "jackpot", dst: "reserve", amt: 1200, why: "waterfall fed", vault: "house" },
                        { tid: `wf-${eid}-house-inc`, src: "jackpot", dst: "incentives", amt: 1200, why: "waterfall incentives", vault: "house" }], totals: {} };
  await C.putRun("treasury", eid, { state: "done", boundary: plan.boundary, via: "site", inputs: { cfg: {}, vaults: {}, journal: [] }, plan,
                                    result: { done_legs: plan.legs.map((l) => l.tid), conserved: true } });
  const origAdd = inbox.addSafe;
  inbox.addSafe = async () => { throw new Error("crash mid-send"); };
  let out;
  try { out = await DG.afterEpoch(eid, null); } finally { inbox.addSafe = origAdd; }
  assert.equal(out, null, "the crash (afterEpoch never throws)");
  assert.equal((await DG.row(eid)).audit_sent_at, null, "not marked: it didn't go out");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref = ?", [`wf-audit:${eid}`]))[0].n, 0);
  assert.ok((await DG.retryLive()).includes(eid));
  assert.deepEqual((await getQuery("SELECT user_id FROM inbox WHERE ref = ? ORDER BY user_id", [`wf-audit:${eid}`])).map((r) => r.user_id), ["u3", "u4"]);
  assert.ok((await DG.row(eid)).audit_sent_at, "marked once it went out");
  assert.ok(!(await DG.retryLive()).includes(eid), "once");
});

test("review of PO-4: the staging Monday - a simulated at (his plan's ts) after his real done gives no 'legs took' problem; the pending tagged audit is finished by an untagged pass at +2 h", async () => {
  const eid = "W2026-11-30-p4z";
  const at = Date.UTC(2026, 10, 30, 4, 5) / 1000;                 // the rehearsal's simulated Monday: his plan's ts
  const done = MON - 3 * 86400;                                   // his real done, days BEFORE it (took < 0 on both sides)
  await pepeWeek(eid, at, done);
  assert.equal(await DG.shadowAudit(eid, done + 700), "pending");
  const got = await DG.pepeRecord(eid, done);
  assert.ok(Number(got.rec.ts) > Number(got.rec.done));
  assert.deepEqual(DG.auditRecord(got.rec, { now: got.rec.done }).problems, [], "no problem: Pepe sends no audit notice either");
  await pepeNotices(eid, got.rec);                                // his digest (and no audit row)
  assert.equal(await DG.shadowAudit(eid, done + 730), "pending");
  assert.equal((await DG.row(eid)).digest_match, null, "a pending audit is rebuilt at most once a minute (not on every 15 s pass)");
  assert.equal(await DG.shadowAudit(eid, done + 800), "pending", "his audit row may still come");
  assert.equal((await DG.row(eid)).digest_match, 1);
  // the test clock is cleared and the tagged ticks stopped: the next UNTAGGED pass finishes it on the real clock
  SCH._setRealClock(() => done + 2 * 3600 + 1);
  try {
    const out = await SCH.digestPass(done + 2 * 3600 + 1, await SCH.clockInfo(done + 2 * 3600 + 1), { mode: "shadow" });
    assert.ok(out.includes(`shadow audit ${eid} final`), JSON.stringify(out));
  } finally { SCH._setRealClock(null); }
  const r = await DG.row(eid);
  assert.equal(r.state, "final");
  assert.equal(r.audit_match, 1, "neither side sent an audit notice");
  assert.equal(r.digest_match, 1);
  assert.deepEqual(r.audit.problems, []);
});
