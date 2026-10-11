// G1: the gang system on the site (gangs.js).
//   * import: off unless enabled, only after the pools are live, digest + totals + every member's account checked, verified
//     backup first, idempotent by key, the supply total must not move by one PAT, the casino rep queue retires into it
//   * ops: keyed (a retry answers the first result), refusals not recorded; ranks / invites / limits like Pepe's
//   * money: deposit / withdraw (the per-rank daily allowance, the 5% cut to Fort Knox) / spend / move / disband - one
//     transaction each, the treasury a "gang:<gid>" pools row the pool views never show
//   * rep: once per key, the site's own wins direct; rollback: every treasury -> 0 under one key, the state handed back
//   NODE_PATH=G:/PATV/node_modules node --test test/gangs.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gangs-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const E = require(path.join(repo, "econstore"));
const G = require(path.join(repo, "gangs"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
async function supply() {
  const w = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
  const j = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
  const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
  let rows = snap ? JSON.parse(snap.pools) : [];
  rows = await P.supplyRows(rows);
  rows = await G.supplyRows(rows);
  return { total: w + j + rows.reduce((t, r) => t + r.amount, 0), rows };
}
const POOLS = { reserve: 1000000, fortknox: 500000, incentives: 200000, heist: 100000 };
const SUPPLY = [...Object.entries(POOLS).map(([k, v]) => ({ key: "vault:" + k, label: k, amount: v })), { key: "gangs", label: "gangs", amount: 1234 }];
function packPools() {
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, supply: SUPPLY, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  return { key: "pc-gangs-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: 4, per_pool: POOLS } };
}
// prod's shape (gang_data.json): The Family-like gang + a tiny one
const GANGS = {
  aa11bb22: { name: "The Family", tag: "FAM", boss: "foamy", officers: ["tricon"], members: ["foamy", "tricon", "zoltar", "ann_cf"], treasury: 1000,
              rep: 7800, created: "2026-07-04", wars: { wins: 5, losses: 7 }, turf_rep0: 4500, last_claim: 1791571053.2, heat: 4,
              withdraw_date: "2020-01-01", withdraw_today: 100000, unpaid_days: 0, upgrades: { lookouts: 3, recruiter: 1 },
              withdrawn: { tricon: 100000 }, rank_limits: { member: 50000, recruit: 10000, officer: 100000 } },
  cc33dd44: { name: "Meth", tag: "MET", boss: "bob_cf", officers: [], members: ["bob_cf"], treasury: 234, rep: 100, created: "2026-08-26",
              wars: { wins: 4, losses: 0 } },
};
const MEMBERS = { foamy: "aa11bb22", tricon: "aa11bb22", zoltar: "aa11bb22", ann_cf: "aa11bb22", bob_cf: "cc33dd44" };
const USERS = { foamy: { userId: "u-foamy" }, tricon: { userId: "u-tricon" }, zoltar: { userId: "u-zoltar" }, ann_cf: { userId: "u1" }, bob_cf: { userId: "u2" } };
function pack(extra = {}, key = "gc-0001") {
  const body = Object.assign({ v: 1, source: "pepe", gangs: GANGS, members: MEMBERS, users: USERS, disbanded: {}, supply_gangs: 1234,
                               casino_rep_done: ["cbj:t1:r1:u1"], cfg: { cut_rate: 0.05 } }, extra.payload || {});
  const payload = JSON.stringify(body);
  const gs = Object.values(body.gangs);
  return { key, payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: Object.assign({ gangs: gs.length, members: Object.keys(body.members).length, treasury: gs.reduce((t, g) => t + (g.treasury || 0), 0),
                                   rep: gs.reduce((t, g) => t + (g.rep || 0), 0) }, extra.totals || {}) };
}

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const op = (b) => post("/api/gangs/bot/op", b);
let webUser = null;
const web = (body) => fetch(base + "/api/gangs/act", { method: "POST", headers: { "content-type": "application/json", "X-Requested-With": "fetch", "x-test-user": webUser || "" },
                                                        body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf] of [["u1", "ann", 100000, "ann_cf"], ["u2", "bob", 5000, "bob_cf"], ["u-foamy", "CFfoamy", 0, null],
                                   ["u-tricon", "tri", 0, "tricon"], ["u-zoltar", "CFzoltar", 0, null], ["u3", "carl", 50000, "carl_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cf]);
  }
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, ?)", [JSON.stringify(SUPPLY)]);
  await require(path.join(repo, "funding")).init();
  await require(path.join(repo, "casino", "rewards")).ensure();
  // two queued casino rep events: one Pepe already applied (in the export), one he didn't
  await runQuery("INSERT INTO casino_rep_queue (key, userId, camfrog, amount, created, acked) VALUES ('cbj:t1:r1:u1', 'u1', 'ann_cf', 50, 1, NULL)");
  await runQuery("INSERT INTO casino_rep_queue (key, userId, camfrog, amount, created, acked) VALUES ('cbj:t1:r2:u1', 'u1', 'ann_cf', 70, 2, NULL)");
  P._setSupplyFn(supply);
  G._setSupplyFn(supply);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); if (u) req.user = { userId: u, username: u }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  P.register(app, deps);
  E.register(app, deps);
  G.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("off by default on prod, and only after the pools are live", async () => {
  assert.equal(await G.enabled(), false);
  assert.equal((await post("/api/gangs/admin/import", pack())).body.code, "E_FEATURE_OFF");
  assert.equal((await op({ op: "deposit", key: "dep-000001", member: "ann_cf", amount: 5 })).body.code, "E_NOT_LIVE");
  await G._setMeta("enabled", true);
  assert.equal((await post("/api/gangs/admin/import", pack())).body.code, "E_POOLS_LOCAL");
  await P._setMeta("enabled", true);
  const pr = await post("/api/pools/admin/import", packPools());
  assert.equal(pr.body.ok, true, JSON.stringify(pr.body));
});

test("import: digest, totals and identities are checked; a mismatch keeps nothing", async () => {
  const bad = pack();
  bad.digest = "0".repeat(64);
  assert.equal((await post("/api/gangs/admin/import", bad)).body.code, "E_DIGEST");
  assert.equal((await post("/api/gangs/admin/import", pack({ totals: { treasury: 1 } }))).body.code, "E_TOTALS");
  const noUser = pack({ payload: { users: Object.assign({}, USERS, { zoltar: { userId: "u-nobody" } }) } });
  assert.equal((await post("/api/gangs/admin/import", noUser)).body.code, "E_IDENTITY");
  const pend = pack({ payload: { gangs: Object.assign({}, GANGS, { cc33dd44: Object.assign({}, GANGS.cc33dd44, { wd_pending: { w1: { net: 5 } } }) }) } });
  assert.equal((await post("/api/gangs/admin/import", pend)).body.code, "E_PENDING");
  assert.equal(await G.live(), false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM gangs"))[0].n, 0);
});

test("import: every gang lands, treasuries match, the supply doesn't move, the casino rep queue retires; idempotent", async () => {
  const before = (await supply()).total;
  const r = await post("/api/gangs/admin/import", pack());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.totals, { gangs: 2, members: 5, treasury: 1234, rep: 7900 + 70 });
  assert.equal(r.body.casino_rep.applied, 1);              // only the key Pepe hadn't applied
  assert.equal(r.body.supply_before, r.body.supply_after);
  assert.equal((await supply()).total, before);
  assert.equal(await G.live(), true);
  const st = await G.stateAll();
  const fam = st.gangs.aa11bb22;
  assert.equal(fam.treasury, 1000);
  assert.equal(fam.rep, 7870);
  assert.deepEqual(fam.officers, ["tricon"]);
  assert.deepEqual(fam.members, ["foamy", "tricon", "zoltar", "ann_cf"]);
  assert.equal(fam.turf_rep0, 4500);                        // the engine fields ride along in `extra`
  assert.equal(fam.withdraw_today, 100000);
  assert.deepEqual(fam.wars, { wins: 5, losses: 7 });
  assert.deepEqual(st.members, MEMBERS);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_rep_queue WHERE acked IS NULL"))[0].n, 0);
  // the pool views never show a treasury
  assert.equal(Object.keys(await P.balances()).some((k) => k.startsWith("gang:")), false);
  assert.equal((await post("/api/gangs/admin/import", pack())).body.already, true);
  assert.equal((await post("/api/gangs/admin/import", pack({}, "gc-0002"))).body.code, "E_ALREADY");
  // the pools can't be rolled back under live gangs
  assert.equal((await post("/api/pools/admin/rollback", { key: "pr-0001" })).body.code, "E_GANGS_LIVE");
  // the pools' own API can't touch a treasury
  assert.equal((await post("/api/pools/move", { key: "mv-gang-1", legs: [["gang:aa11bb22", -5], ["reserve", 5]] })).body.code, "E_BAD_LEGS");
});

test("deposit / withdraw: one transaction each, the allowance per rank and day, the cut to Fort Knox", async () => {
  const d = await op({ op: "deposit", key: "dep-000002", member: "ann_cf", username: "ann", amount: 20000 });
  assert.equal(d.body.ok, true, JSON.stringify(d.body));
  assert.equal(d.body.treasury, 21000);
  assert.equal(await bal("u1"), 80000);
  assert.equal((await op({ op: "deposit", key: "dep-000002", member: "ann_cf", username: "ann", amount: 20000 })).body.dup, true);
  assert.equal(await bal("u1"), 80000);
  assert.equal((await op({ op: "deposit", key: "dep-000003", member: "ann_cf", username: "ann", amount: 999999 })).body.code, "E_INSUFFICIENT_PAT");
  // ann is a member: 50,000 / day in The Family. 60k refused, 40k ok (cut 2,000 -> Fort Knox, 38,000 in hand)
  const fk0 = await P.balance("fortknox");
  assert.equal((await op({ op: "withdraw", key: "wd-0000001", member: "ann_cf", amount: 60000 })).body.code, "E_TREASURY");
  await op({ op: "deposit", key: "dep-000004", member: "ann_cf", username: "ann", amount: 80000 });
  const big = await op({ op: "withdraw", key: "wd-0000002", member: "ann_cf", amount: 60000 });
  assert.equal(big.body.code, "E_ALLOWANCE");
  const w = await op({ op: "withdraw", key: "wd-0000003", member: "ann_cf", amount: 40000 });
  assert.equal(w.body.ok, true, JSON.stringify(w.body));
  assert.equal(w.body.cut, 2000);
  assert.equal(w.body.net, 38000);
  assert.deepEqual(w.body.cut_legs, [["fortknox", 2000]]);
  assert.equal(await P.balance("fortknox"), fk0 + 2000);
  assert.equal(await bal("u1"), 38000);
  assert.equal(w.body.gang.treasury, 101000 - 40000);
  assert.equal(w.body.gang.withdrawn.ann_cf, 40000);
  assert.equal((await op({ op: "withdraw", key: "wd-0000004", member: "ann_cf", amount: 20000 })).body.code, "E_ALLOWANCE");
  // Pepe's own cut legs are used as given (validated)
  const w2 = await op({ op: "withdraw", key: "wd-0000005", member: "foamy", amount: 1000, cut_legs: [["fortknox", 30], ["reserve", 20]] });
  assert.equal(w2.body.ok, true);
  assert.equal(await bal("u-foamy"), 950);
  assert.equal((await op({ op: "withdraw", key: "wd-0000006", member: "foamy", amount: 1000, cut_legs: [["burn", 50]] })).body.code, "E_BAD_LEGS");
});

test("ranks, invites, kicks, tags, limits - Pepe's rules", async () => {
  assert.equal((await op({ op: "invite", key: "inv-000001", actor: "zoltar", target: "carl_cf" })).body.code, "E_RANK");
  const i = await op({ op: "invite", key: "inv-000002", actor: "tricon", target: "carl_cf" });
  assert.equal(i.body.ok, true);
  const a = await op({ op: "accept", key: "acc-000001", member: "carl_cf", username: "carl" });
  assert.equal(a.body.ok, true);
  assert.equal(a.body.gang.members.length, 5);
  assert.equal((await op({ op: "kick", key: "kck-000001", actor: "tricon", target: "foamy" })).body.code, "E_BOSS");
  assert.equal((await op({ op: "promote", key: "prm-000001", actor: "tricon", target: "carl_cf" })).body.code, "E_RANK");
  assert.equal((await op({ op: "promote", key: "prm-000002", actor: "foamy", target: "carl_cf" })).body.gang.officers.includes("carl_cf"), true);
  assert.equal((await op({ op: "kick", key: "kck-000002", actor: "tricon", target: "carl_cf" })).body.code, "E_RANK");   // officer: boss only
  assert.equal((await op({ op: "demote", key: "dem-000001", actor: "foamy", target: "carl_cf" })).body.ok, true);
  assert.equal((await op({ op: "kick", key: "kck-000003", actor: "tricon", target: "carl_cf" })).body.ok, true);
  assert.equal((await op({ op: "tag", key: "tag-000001", actor: "foamy", tag: "met" })).body.code, "E_TAG_TAKEN");
  assert.equal((await op({ op: "limits", key: "lim-000001", actor: "foamy", rank: "member", amount: 0 })).body.gang.rank_limits.member, 0);
  assert.equal((await op({ op: "leave", key: "lv-0000001", member: "foamy" })).body.code, "E_BOSS");
  assert.equal((await op({ op: "defect", key: "dfc-000001", member: "zoltar" })).body.code, "E_NO_GROUNDS");
  const b = await op({ op: "boss", key: "bos-000001", actor: "foamy", target: "tricon" });
  assert.equal(b.body.gang.boss, "tricon");
  assert.equal(b.body.gang.officers.includes("foamy"), true);
});

test("spend (a gang upgrade) and move (turf legs): keyed, the treasury can't go below 0, the gang must exist", async () => {
  const t0 = (await G.stateAll()).gangs.aa11bb22.treasury;
  const r0 = await P.balance("reserve");
  // recruiter is Lv1 -> Lv2 costs 80,000 (level 2 needs rep >= 5,000: 7,870 ok)
  assert.equal((await op({ op: "spend", key: "sp-0000001", actor: "tricon", amount: 40000, flow: "turf_upgrades", legs: [["reserve", 40000]],
                           upgrade: { key: "recruiter" } })).body.code, "E_PRICE");
  const s = await op({ op: "spend", key: "sp-0000002", actor: "tricon", amount: 80000, flow: "turf_upgrades", legs: [["reserve", 80000]], upgrade: { key: "recruiter" } });
  assert.equal(s.body.code, "E_TREASURY");
  await op({ op: "deposit", key: "dep-000005", member: "carl_cf", username: "carl", amount: 1 }).then((x) => assert.equal(x.body.code, "E_NOT_MEMBER"));
  const m = await op({ op: "move", key: "turf:d1:aa11bb22", gid: "aa11bb22", legs: [["gang", 150000]], why: "turf tick income", flow: "turf_income" });
  assert.equal(m.body.ok, true, JSON.stringify(m.body));
  assert.equal(m.body.gang.treasury, t0 + 150000);
  const s2 = await op({ op: "spend", key: "sp-0000003", actor: "tricon", amount: 80000, flow: "turf_upgrades", legs: [["reserve", 80000]], upgrade: { key: "recruiter" } });
  assert.equal(s2.body.ok, true, JSON.stringify(s2.body));
  assert.equal(s2.body.gang.upgrades.recruiter, 2);
  assert.equal(await P.balance("reserve"), r0 + 80000);
  // a tick-like multi-leg move: incentives -> treasury, treasury -> Reserve (upkeep), treasury -> Casino vault (raid tax)
  const inc0 = await P.balance("incentives");
  const tk = await op({ op: "move", key: "turf:d2:aa11bb22", gid: "aa11bb22", legs: [["incentives", -1000], ["gang", 1000 - 3000 - 500], ["reserve", 3000], ["heist", 500]] });
  assert.equal(tk.body.ok, true, JSON.stringify(tk.body));
  assert.equal(await P.balance("incentives"), inc0 - 1000);
  // more than the treasury holds: refused, nothing recorded, the same key can succeed later
  const tre = tk.body.gang.treasury;
  assert.equal((await op({ op: "move", key: "turf:claim:x1", gid: "aa11bb22", legs: [["gang", -(tre + 1)]] })).body.code, "E_TREASURY");
  assert.equal((await op({ op: "move", key: "turf:claim:x1", gid: "aa11bb22", legs: [["gang", -tre]] })).body.ok, true);
  assert.equal((await op({ op: "move", key: "turf:claim:x2", legs: [["gang:ffffffff", 5]] })).body.code, "E_NO_GANG");
  assert.equal((await op({ op: "move", key: "turf:claim:x3", legs: [["burn", 5]] })).body.code, "E_BAD_LEGS");
  await op({ op: "move", key: "turf:back:x1", gid: "aa11bb22", legs: [["gang", tre]] });
});

test("patch (engine fields) and rep (once per key; the site's wins direct)", async () => {
  const p = await op({ op: "patch", key: "gp-000000001", gid: "aa11bb22", set: { heat: 9, wars: { wins: 6, losses: 7 }, extra: { last_invade: 123, treasury: 5 } } });
  assert.equal(p.body.gang.heat, 9);
  assert.equal(p.body.gang.wars.wins, 6);
  assert.equal(p.body.gang.last_invade, 123);
  assert.equal(p.body.gang.treasury > 5, true);             // a money field is never patched
  const rep0 = (await G.stateAll()).gangs.cc33dd44.rep;
  const r = await post("/api/gangs/bot/rep", { events: [{ key: "rep:pepe:abc123", member: "bob_cf", amount: 10, src: "heist" },
                                                        { key: "rep:pepe:abc123", member: "bob_cf", amount: 10, src: "heist" },
                                                        { key: "rep:pepe:nogang1", member: "stranger", amount: 10 }] });
  assert.equal(r.body.applied, 1);
  assert.equal(r.body.dup, 1);
  assert.equal(r.body.nogang, 1);
  assert.equal(await G.addRep({ key: "lotto:9:u2", userId: "u2", amount: 5, src: "lotto" }), true);
  assert.equal((await G.stateAll()).gangs.cc33dd44.rep, rep0 + 15);
  // the casino applies rep here now and queues nothing for Pepe
  const rw = require(path.join(repo, "casino", "rewards"));
  rw.hooks.updateLevel = async () => {};
  await rw.winReward({ id: "t9", players: { u2: { camfrog: "bob_cf" } } }, "cbj:t9:r1:u2", "u2", 2000);
  assert.equal((await G.stateAll()).gangs.cc33dd44.rep, rep0 + 25);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_rep_queue WHERE key = 'cbj:t9:r1:u2'"))[0].n, 0);
});

test("the website: deposit / withdraw / invite / accept / leave for signed-in members", async () => {
  webUser = "u1";
  const d = await web({ op: "deposit", amount: 1000, idem: "idem-dep-1" });
  assert.equal(d.body.ok, true, JSON.stringify(d.body));
  const w = await web({ op: "withdraw", amount: 100, idem: "idem-wd-1" });
  assert.equal(w.body.ok, true, JSON.stringify(w.body));
  assert.match(w.body.msg, /95 to your wallet/);
  assert.equal((await web({ op: "kick", target: "zoltar", idem: "idem-kick-1" })).body.code, "E_RANK");
  webUser = "u-tricon";                                     // the boss now
  assert.equal((await web({ op: "invite", target: "carl", idem: "idem-inv-1" })).body.ok, true);
  webUser = "u3";
  const v = await G.gangView("FAM", "u3");
  assert.equal(v.invited, true);
  assert.equal((await web({ op: "accept", gid: "aa11bb22", idem: "idem-acc-1" })).body.ok, true);
  assert.equal((await web({ op: "leave", idem: "idem-lv-1" })).body.ok, true);
  webUser = null;
  assert.equal((await web({ op: "deposit", amount: 5 })).status, 401);
  const board = await G.boardView(null);
  assert.equal(board.live, true);
  assert.equal(board.gangs[0].tag, "FAM");
});

test("disband: treasury + released stakes split among the members, dust to the Reserve, the record kept", async () => {
  await op({ op: "deposit", key: "dep-000010", member: "bob_cf", username: "bob", amount: 1000 });
  const t = (await G.stateAll()).gangs.cc33dd44.treasury;
  const b0 = await bal("u2"), r0 = await P.balance("reserve");
  const s0 = (await supply()).total;
  const d = await op({ op: "disband", key: "dsb-000001", actor: "bob_cf", stakes: 501, released: { soho: 501 }, rid: "disband-cc33dd44-1" });
  assert.equal(d.body.ok, true, JSON.stringify(d.body));
  assert.equal(d.body.per, t + 501);
  assert.equal(await bal("u2"), b0 + t + 501);
  assert.equal(await P.balance("reserve"), r0);
  assert.equal((await G.stateAll()).gangs.cc33dd44, undefined);
  assert.equal((await G.stateAll()).disbanded.cc33dd44.released.soho, 501);
  assert.equal((await supply()).total, s0 + 501);           // the stakes came in from Pepe's turf store
});

test("rollback: every treasury back to Pepe under one key; a re-import with a new key works", async () => {
  const st0 = await G.stateAll();
  const tre = Object.values(st0.gangs).reduce((t, g) => t + g.treasury, 0);
  const r = await post("/api/gangs/admin/rollback", { key: "gr-0001", actor: "test" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.totals.treasury, tre);
  assert.equal(r.body.gangs.aa11bb22.treasury, st0.gangs.aa11bb22.treasury);
  assert.equal(await G.live(), false);
  assert.equal((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'gang:%'"))[0].t, 0);
  assert.equal((await post("/api/gangs/admin/rollback", { key: "gr-0001" })).body.dup, true);
  assert.equal((await op({ op: "deposit", key: "dep-000020", member: "ann_cf", amount: 5 })).body.code, "E_NOT_LIVE");
  // Pepe re-exports (his file now holds what the site handed back) and cuts over again
  const back = { gangs: r.body.gangs, members: r.body.members, users: Object.assign({}, USERS), disbanded: r.body.disbanded, casino_rep_done: [], supply_gangs: tre };
  const again = pack({ payload: back }, "gc-0003");
  const ri = await post("/api/gangs/admin/import", again);
  assert.equal(ri.body.ok, true, JSON.stringify(ri.body));
  assert.equal(ri.body.totals.treasury, tre);
  assert.equal(ri.body.digest, r.body.digest);
});
