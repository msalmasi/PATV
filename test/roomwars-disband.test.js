// Room Wars R5 (1.99??, room-wars plan 2026-11-02): Pepe's disband_release switch (decision 7) - a gang holding a room may
// disband; Pepe puts its rooms on his own 72 h release clock and splits what comes back of each bond among the members.
// His disband op lists those rooms (`room_release`), and the site's disband guard (R1, roomwars.heldBy) stands aside for
// exactly them - any other held room still refuses, and a disband without the field is refused as before.
//   node --test test/roomwars-disband.test.js        (NODE_PATH=G:/PATV/node_modules outside a worktree with the junction)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rw-disband-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const E = require(path.join(repo, "econstore"));
const G = require(path.join(repo, "gangs"));
const RW = require(path.join(repo, "roomwars"));

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
const SUPPLY = [...Object.entries(POOLS).map(([k, v]) => ({ key: "vault:" + k, label: k, amount: v })), { key: "gangs", label: "gangs", amount: 1235 }];
function packPools() {
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, supply: SUPPLY, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  return { key: "pc-rwd-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: 4, per_pool: POOLS } };
}
const GANGS = {
  aa11bb22: { name: "The Family", tag: "FAM", boss: "foamy", officers: [], members: ["foamy", "tricon"], treasury: 1000, rep: 10 },
  cc33dd44: { name: "Meth", tag: "MET", boss: "bob_cf", officers: [], members: ["bob_cf", "carl_cf", "ann_cf"], treasury: 235, rep: 5 },
};
const MEMBERS = { foamy: "aa11bb22", tricon: "aa11bb22", bob_cf: "cc33dd44", carl_cf: "cc33dd44", ann_cf: "cc33dd44" };
const USERS = { foamy: { userId: "u-foamy" }, tricon: { userId: "u-tricon" }, bob_cf: { userId: "u2" }, carl_cf: { userId: "u3" }, ann_cf: { userId: "u1" } };
function pack(key = "gc-rwd-0001") {
  const body = { v: 1, source: "pepe", gangs: GANGS, members: MEMBERS, users: USERS, disbanded: {}, supply_gangs: 1235, casino_rep_done: [],
                 cfg: { cut_rate: 0.05 } };
  const payload = JSON.stringify(body);
  const gs = Object.values(body.gangs);
  return { key, payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { gangs: gs.length, members: Object.keys(body.members).length, treasury: gs.reduce((t, g) => t + (g.treasury || 0), 0),
                     rep: gs.reduce((t, g) => t + (g.rep || 0), 0) } };
}

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const op = (b) => post("/api/gangs/bot/op", b);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf] of [["u1", "ann", 100000, "ann_cf"], ["u2", "bob", 5000, "bob_cf"], ["u-foamy", "CFfoamy", 0, "foamy"],
                                   ["u-tricon", "tri", 0, "tricon"], ["u3", "carl", 50000, "carl_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cf]);
  }
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, ?)", [JSON.stringify(SUPPLY)]);
  await require(path.join(repo, "funding")).init();
  await require(path.join(repo, "casino", "rewards")).ensure();
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
  assert.equal(await G.enabled(), false);                     // (creates the tables)
  await G._setMeta("enabled", true);
  await P.enabled();
  await P._setMeta("enabled", true);
  const pr = await post("/api/pools/admin/import", packPools());
  assert.equal(pr.body.ok, true, JSON.stringify(pr.body));
  const gr = await post("/api/gangs/admin/import", pack());
  assert.equal(gr.body.ok, true, JSON.stringify(gr.body));
  await RW.init();
});
test.after(() => server && server.close());

test("R5 disband_release: the guard stands aside for exactly the rooms Pepe's op says he releases", async () => {
  await RW.put({ revision: 20, map: { rooms: { Room_A: { name: "Room A", tier: "outer", eligible: true, bond: 600000 },
                                               Room_B: { name: "Room B", tier: "mid", eligible: true, bond: 900000 } } },
                 room_control: { Room_A: { gang: "cc33dd44", bond: 600000, perks: [] }, Room_B: { gang: "cc33dd44", bond: 900000, perks: [] } } });
  // no room_release (Pepe's switch off, or an older Pepe): refused as before (R1)
  const r0 = await op({ op: "disband", key: "dsb-rwd-000001", actor: "bob_cf" });
  assert.equal(r0.status, 409, JSON.stringify(r0.body));
  assert.equal(r0.body.code, "E_ROOM_HELD");
  assert.deepEqual(r0.body.rooms, ["Room_A", "Room_B"]);
  // a list that misses one of its rooms: the room it misses still refuses
  const r1 = await op({ op: "disband", key: "dsb-rwd-000002", actor: "bob_cf", room_release: ["Room_A"] });
  assert.equal(r1.status, 409, JSON.stringify(r1.body));
  assert.deepEqual(r1.body.rooms, ["Room_B"]);
  assert.match(r1.body.error, /\[MET\] holds Room B in Room Wars/);
  assert.ok((await G.stateAll()).gangs.cc33dd44, "nothing changed");
  // every held room listed: the disband goes through - the treasury split as always, the record keeps the rooms
  const s0 = (await supply()).total;
  const b0 = { u1: await bal("u1"), u2: await bal("u2"), u3: await bal("u3") };
  const r2 = await op({ op: "disband", key: "dsb-rwd-000003", actor: "bob_cf", room_release: ["Room_A", "Room_B"], rid: "disband-cc33dd44-9" });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(r2.body.ok, true);
  assert.equal(r2.body.per, 78);                                   // 235 / 3 members, dust 1 to the Reserve
  assert.equal(await bal("u1"), b0.u1 + 78);
  assert.equal(await bal("u2"), b0.u2 + 78);
  assert.equal(await bal("u3"), b0.u3 + 78);
  assert.equal((await G.stateAll()).gangs.cc33dd44, undefined);
  const rec = (await G.stateAll()).disbanded.cc33dd44;
  assert.deepEqual(rec.rooms_release, ["Room_A", "Room_B"]);
  assert.deepEqual(rec.members.slice().sort(), ["ann_cf", "bob_cf", "carl_cf"], "Pepe splits the bonds among these members");
  assert.equal((await supply()).total, s0, "the supply doesn't move");
});

test("R5: room_release never lets another gang's held room through, and a gang holding nothing is unaffected", async () => {
  await RW.put({ revision: 21, map: { rooms: { Room_C: { name: "Room C", tier: "outer", eligible: true, bond: 600000 } } },
                 room_control: { Room_C: { gang: "aa11bb22", bond: 600000, perks: [] } } });
  const r = await op({ op: "disband", key: "dsb-rwd-000004", actor: "foamy", room_release: ["Room_X"] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.deepEqual(r.body.rooms, ["Room_C"]);
  await RW.put({ revision: 22, map: { rooms: {} }, room_control: {} });
  const ok = await op({ op: "disband", key: "dsb-rwd-000005", actor: "foamy" });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal((await G.stateAll()).disbanded.aa11bb22.rooms_release, undefined);
});
