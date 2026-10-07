// Offline tests for economy v2 phase E-1 on the site (camfrog-bot docs/ECONOMY-V2.md 2 / 12):
//   * funding.sync: Fort Knox is "live" only while Pepe reports its balance (every sync resets it)
//   * boosts.routeInTx: the Fort Knox half of a boost / slot fee is a "fortknox:<flow>" claim (fk_to =
//     'fortknox') while Fort Knox is live, else a plain "boost" claim for the Reserve (fk_to NULL)
//   * the one-time Fort Knox migration: the summary sums only the Reserve-held halves, counts claims
//     still in flight; the mark is batch-keyed, amount-checked, stamps exactly those rows, a replay is a
//     no-op; the bot routes need the bot token
//   * conservation on the site side: wallet debits == Fort Knox claims + room-vault escrow
//   * supplylayers: every supply key has a layer; grouping keeps the total
//   * econ.js: kind "layer" rows are journaled but never revenue
//   NODE_PATH=G:/PATV/node_modules node --test test/econ-layers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-layers-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const B = require(path.join(repo, "boosts"));
const F = require(path.join(repo, "funding"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));
const SL = require(path.join(repo, "supplylayers"));
const econ = require(path.join(repo, "econ"));

let T = Date.UTC(2026, 9, 7, 18, 0, 0);
rooms._setClock(() => T); B._setClock(() => T); S._setClock(() => T);
const START = 1000000;
let n = 0;
async function mkUser(bal = START) {
  const id = "u" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, class) VALUES (?, ?, ?, 'x', ?, 'pleb')`,
                 [id, "user" + n, "User " + n, bal]);
  return { userId: id, username: "user" + n };
}
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS w FROM users"))[0].w;
const claims = async () => getQuery("SELECT flow, amount, settled FROM reserve_claims ORDER BY rowid");

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await S.init();
  await rooms.init();
  await B.init();
  await econ.ready;
  await rooms.addRoom("DRAMA_CENTRAL", null, "test");
  const app = express();
  app.use(express.json());
  const isBotToken = (t) => t === "bot-token";
  B.register(app, { addUser: (req, res, next) => next(), isBotToken });
  econ.register && econ.register(app, { addUser: (req, res, next) => next(), isBotToken });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("funding.sync: Fort Knox is live only while Pepe reports it; any sync without it turns it off", () => {
  assert.equal(F.fortknoxLive(), false, "never synced: not live");
  F.sync({ reserve: 5000000, flows: {}, fortknox: 12345 });
  assert.equal(F.fortknoxLive(), true);
  assert.equal(F.state.fortknox, 12345);
  F.sync({ reserve: 5000000, flows: {} });           // an older Pepe / layers off: no key
  assert.equal(F.fortknoxLive(), false);
  F.sync({ reserve: 5000000, fortknox: null });
  assert.equal(F.fortknoxLive(), false);
  F.sync({ reserve: 5000000, fortknox: "lots" });
  assert.equal(F.fortknoxLive(), false, "junk is not live");
});

test("routeInTx: the Fort Knox half goes to the Reserve before E-1, straight to Fort Knox while it's live", async () => {
  const a = await mkUser(), b = await mkUser();
  const w0 = await wallets();
  F.sync({ reserve: 1, fortknox: null });
  const r1 = await B.boost(a, "DRAMA_CENTRAL", { amount: 10001, ref: ref() });
  F.sync({ reserve: 1, fortknox: 0 });
  const r2 = await B.boost(b, "DRAMA_CENTRAL", { amount: 4000, ref: ref() });
  assert.deepEqual([r1.fortknox, r1.room_vault, r2.fortknox, r2.room_vault], [5001, 5000, 2000, 2000]);
  const c = await claims();
  assert.deepEqual(c.map((x) => [x.flow, x.amount]), [["boost", -5001], ["fortknox:boost", -2000]]);
  const rows = await getQuery("SELECT fortknox, fk_to FROM room_flow_ledger ORDER BY id");
  assert.deepEqual(rows.map((r) => r.fk_to), [null, "fortknox"]);
  // site-side conservation: what left the wallets == Fort Knox claims + the room-vault escrow
  const esc = await B.escrow();
  assert.equal(w0 - (await wallets()), -c.reduce((s, x) => s + x.amount, 0) + esc.room_vault);
  assert.equal(esc.fortknox, 5001, "only the pre-E-1 half is still waiting in the Reserve");
  assert.equal(esc.fortknox_done, 2000);
});

test("migration summary / mark: exact rows, pending claims, batch-keyed, amount-checked, replay-safe", async () => {
  F.sync({ reserve: 1, fortknox: null });
  const u = await mkUser();
  await B.boost(u, "DRAMA_CENTRAL", { amount: 3000, ref: ref() });           // another Reserve-held half: 1500
  let s = await B.fkMigrationSummary();
  assert.deepEqual({ amount: s.amount, rows: s.rows }, { amount: 6501, rows: 2 });
  assert.equal(s.pending_claims, 2, "the 'boost' claims haven't been settled by Pepe yet");
  await runQuery("UPDATE reserve_claims SET settled = 1");
  s = await B.fkMigrationSummary();
  assert.equal(s.pending_claims, 0);
  // bot routes need the token
  assert.equal((await post("/api/g/fortknox-migration", { password: "nope" })).status, 403);
  const got = await post("/api/g/fortknox-migration", { password: "bot-token" });
  assert.deepEqual([got.status, got.body.ok, got.body.amount, got.body.max_id], [200, true, 6501, s.max_id]);
  // a new Fort-Knox-live boost after the summary is not part of the batch
  F.sync({ reserve: 1, fortknox: 0 });
  await B.boost(u, "DRAMA_CENTRAL", { amount: 1000, ref: ref() });
  const bad = await post("/api/g/fortknox-migration/mark", { password: "bot-token", batch: "fkm" + s.max_id, max_id: s.max_id, amount: 6500 });
  assert.equal(bad.status, 409, "a different amount than the ledger holds: nothing stamped");
  assert.equal((await B.fkMigrationSummary()).amount, 6501);
  assert.equal((await post("/api/g/fortknox-migration/mark", { password: "bot-token", batch: "evil; drop", max_id: 1, amount: 1 })).status, 400);
  const ok = await post("/api/g/fortknox-migration/mark", { password: "bot-token", batch: "fkm" + s.max_id, max_id: s.max_id, amount: 6501 });
  assert.deepEqual([ok.status, ok.body.ok, ok.body.rows, ok.body.dup], [200, true, 2, false]);
  const again = await post("/api/g/fortknox-migration/mark", { password: "bot-token", batch: "fkm" + s.max_id, max_id: s.max_id, amount: 6501 });
  assert.deepEqual([again.body.ok, again.body.dup, again.body.rows], [true, true, 2], "a replay returns the first result");
  assert.equal((await post("/api/g/fortknox-migration/mark", { password: "bot-token", batch: "fkm" + s.max_id, max_id: s.max_id, amount: 1 })).status, 409);
  assert.equal((await B.fkMigrationSummary()).amount, 0, "nothing left to migrate");
  const esc = await B.escrow();
  assert.equal(esc.fortknox, 0);
  assert.equal(esc.fortknox_done, 6501 + 2000 + 500);
});

test("supply layers: every pool has a layer, grouping keeps the total", () => {
  const rows = [
    { key: "wallets", amount: 900 }, { key: "jackpot", amount: 170 }, { key: "vault:reserve", amount: 50 },
    { key: "vault:fortknox", amount: 7 }, { key: "vault:incentives", amount: 3 }, { key: "vault:heist", amount: 44 },
    { key: "vault:bank", amount: 52 }, { key: "vault:mm", amount: 7 }, { key: "vault:lotto", amount: 191 },
    { key: "vault:burn", amount: 2 }, { key: "room_vault_escrow", amount: 4 }, { key: "gangs", amount: 640 },
    { key: "stashes", amount: 5 }, { key: "escrow", amount: 1 }, { key: "turf:stakes", amount: 30 }, { key: "vault:something_new", amount: 9 },
  ];
  assert.equal(SL.layerOf("vault:reserve"), "fed");
  assert.equal(SL.layerOf("vault:fortknox"), "incentive");
  assert.equal(SL.layerOf("vault:incentives"), "incentive");
  assert.equal(SL.layerOf("jackpot"), "treasury");
  assert.equal(SL.layerOf("vault:burn"), "burn");
  assert.equal(SL.layerOf("room:DRAMA_CENTRAL"), "incentive");
  assert.equal(SL.layerOf("vault:something_new"), "pots", "an unknown pool is still counted");
  const g = SL.group(rows);
  assert.equal(g.reduce((s, x) => s + x.amount, 0), rows.reduce((s, r) => s + r.amount, 0));
  assert.equal(g.reduce((s, x) => s + x.rows.length, 0), rows.length);
  assert.deepEqual(g.map((x) => x.key), ["players", "fed", "treasury", "incentive", "pots", "burn"]);
  assert.match(g[1].label, /Federal Reserve \(backstop\)/);
});

test("econ.js: 'layer' rows are journaled (idempotent ref) but never revenue", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const ts = Date.now();
  const saved = await econ.ingestCharges([
    { ref: "fedmint-loan-0001", ts, day, room: "", flow: "fed_mint:loan", kind: "layer", payer: "boss", amount: 250000, via: "chat" },
    { ref: "fedmint-loan-0001", ts, day, room: "", flow: "fed_mint:loan", kind: "layer", payer: "boss", amount: 250000, via: "chat" },
    { ref: "e1-fkmig-12", ts, day, room: "", flow: "fortknox_migration", kind: "layer", amount: 6501, via: "system" },
    { ref: "chg-0000001", ts, day, room: "DRAMA_CENTRAL", flow: "ask", kind: "room", payer: "alice", amount: 100, via: "chat" },
  ]);
  assert.equal(saved, 3, "the replayed ref is ignored");
  const layers = await getQuery("SELECT COUNT(*) AS n FROM econ_charges WHERE kind = 'layer'");
  assert.equal(layers[0].n, 2);
  const rev = (await getQuery("SELECT COALESCE(SUM(amount), 0) AS a FROM econ_charges WHERE kind <> 'layer'"))[0].a;
  const t = await econ.telemetry(7);
  assert.equal(t.totals.revenue, rev, "a policy mint / the migration is not revenue (only the real charges: the boosts above + !ask)");
  assert.deepEqual(t.layer_moves, { "fed_mint:loan": 250000, fortknox_migration: 6501 });
  assert.ok(!t.rooms.some((r) => r.room_id === "" && r.revenue.total > 0), "no 'no room' revenue row from layer moves");
});
