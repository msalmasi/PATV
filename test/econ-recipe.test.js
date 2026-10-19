// Offline tests for economy v2 E-4 on the site (camfrog-bot pepe_recipe.py; recipe.js, royalties.cutover, roomvaults recipe):
//   * /api/g/recipe/inputs: the 6.4 active-day gate, the owner, verified watch-minutes per streamer (status ok only, muted
//     minutes out, 120 per viewer per streamer, viewer gates: age >= 7 days, level >= 2, verified), the participant gates
//     (linked, age, level, dup_of)
//   * /api/g/recipe/credit: keyed (a retry is a dup, credits once), a gone account -> 404 no_account, bot token only
//   * royalties.cutover: dry run lists pending per owner; the run releases each ONCE (keyed), freezes the ledger, settles
//     exactly (pending after = 0); a re-run answers the stored result; nothing accrues after; another key is refused
//   * roomvaults: Pepe's recipe epochs are stored and shown on the card (no names)
//   * 1.99ada: a payout day's games split (games_base + games_from_unpaid) and the recipe meta's applied website rev
//     (cfg_rev / cfg_src / cfg_applied_at / cfg_error, junk dropped)
//   NODE_PATH=G:/PATV/node_modules node --test test/econ-recipe.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-recipe-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const RC = require(path.join(repo, "recipe"));
const RY = require(path.join(repo, "royalties"));
const RV = require(path.join(repo, "roomvaults"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));
const B = require(path.join(repo, "boosts"));
const econ = require(path.join(repo, "econ"));

const DAY = 24 * 3600 * 1000;
const T = Date.UTC(2026, 9, 11, 18, 0, 0);
const DAYSTR = "2026-10-11";
rooms._setClock(() => T); require(path.join(repo, "vwm"))._setClock(() => T); RC._setClock(() => T); RY._setClock(() => T); RV._setClock(() => T); S._setClock(() => T); B._setClock(() => T);
const PLANT = "plant_based_chatting";
const old = new Date(T - 30 * DAY).toISOString().replace("T", " ").slice(0, 19);
const young = new Date(T - 2 * DAY).toISOString().replace("T", " ").slice(0, 19);
async function mkUser(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, password, points_balance, camfrogUsername, level, created_at, isEmailVerified, discordId, twitchId)
                  VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?, ?)`,
                 [id, o.username || id, o.bal || 0, o.camfrog || null, o.level != null ? o.level : 5, o.created || old, o.verified != null ? o.verified : 1, o.discord || null, null]);
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0,
                  created_at TIMESTAMP, isEmailVerified INTEGER DEFAULT 0, discordId TEXT, twitchId TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await new Promise((r) => setTimeout(r, 200));            // econ.js -> welcome.js creates welcome_bonus
  await mkUser("owner", { username: "pb", camfrog: "foamy1111" });
  await mkUser("reg1", { camfrog: "reg1" });
  await mkUser("reg2", { camfrog: "reg2" });
  await mkUser("young1", { camfrog: "young1", created: young });
  await mkUser("low1", { camfrog: "low1", level: 1 });
  await mkUser("alt1", { camfrog: "alt1" });
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of, state, created) VALUES ('alt1', 'reg1', 'dup', 0)");
  await mkUser("streamer", {});
  await mkUser("viewerA", {}); await mkUser("viewerB", {}); await mkUser("viewerNew", { created: young });
  await mkUser("viewerUnv", { verified: 0 });
  await S.init(); await rooms.init(); await B.init(); await RV.init(); await RC.init(); await RY.init(); await econ.ready;
  await rooms.setOwner(PLANT, "foamy1111", "test");
  // 6.4: 3 active days (>= 60 min, peak >= 3), 1 too short, 1 too small
  for (const [d, m, p] of [["2026-10-11", 90, 4], ["2026-10-09", 60, 3], ["2026-10-07", 200, 9], ["2026-10-06", 30, 9], ["2026-10-05", 300, 2], ["2026-10-01", 300, 9]]) {
    await runQuery("INSERT INTO room_activity (room_id, day, minutes, peak, lines) VALUES (?, ?, ?, ?, 0)", [PLANT, d, m, p]);
  }
  const W = (v, secs, muted, status = "ok", stream = "slot:s1", streamer = "streamer") =>
    runQuery(`INSERT INTO econ_watch (day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, beats, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
             [DAYSTR, stream, PLANT, streamer, v, secs, muted, status]);
  await W("viewerA", 3 * 3600, 0);            // 180 min -> capped at 120
  await W("viewerB", 40 * 60, 10 * 60);       // 40 min, 10 muted -> 30
  await W("viewerNew", 60 * 60, 0);           // a 2-day-old account: out
  await W("viewerUnv", 60 * 60, 0);           // not verified: out
  await W("alt1", 60 * 60, 0, "alt");         // flagged by the heartbeat: out
  await W("viewerA", 60 * 60, 0, "ok", "pepe:" + PLANT, null);   // Pepe's own stream: no streamer to pay
  const app = express();
  app.use(express.json());
  RC.register(app, { isBotToken: (t) => t === "bot-token" });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("inputs: the active-day gate, the owner, verified watch-minutes and the participant gates", async () => {
  assert.equal((await post("/api/g/recipe/inputs", { day: DAYSTR, rooms: [] })).status, 403);
  const r = await post("/api/g/recipe/inputs", { password: "bot-token", day: DAYSTR,
    rooms: [{ room: PLANT, owner_login: "foamy1111", logins: ["reg1", "reg2", "young1", "low1", "alt1", "nobody"] }] });
  assert.equal(r.status, 200);
  const x = r.body.rooms[0];
  assert.equal(x.active_days, 3, "3 days >= 60 min with >= 3 people in the 7 ending the day");
  assert.deepEqual(x.owner, { userId: "owner" });
  assert.deepEqual(x.streamers, [{ userId: "streamer", vwm: 150, viewers: 2 }], "120 (capped) + 30 (muted out); gated viewers and Pepe's stream out");
  assert.deepEqual(x.people.reg1, { ok: true, userId: "reg1" });
  assert.equal(x.people.young1.ok, false); assert.match(x.people.young1.why, /7 days/);
  assert.equal(x.people.low1.ok, false); assert.match(x.people.low1.why, /level 2/);
  assert.equal(x.people.alt1.ok, false); assert.match(x.people.alt1.why, /alt/);
  assert.equal(x.people.nobody.ok, false); assert.match(x.people.nobody.why, /no linked/);
});

test("credit: keyed, once; a gone account is refused (Pepe returns the PAT to the vault)", async () => {
  const b0 = await bal("reg1");
  const body = { password: "bot-token", ref: "rc-2026-10-11-plant-d:3", userId: "reg1", amount: 4321, room: PLANT, slice: "people", day: DAYSTR };
  const r1 = await post("/api/g/recipe/credit", body);
  const r2 = await post("/api/g/recipe/credit", body);
  assert.equal(r1.body.ok, true); assert.equal(r2.body.dup, true);
  assert.equal(await bal("reg1"), b0 + 4321, "credited once");
  const gone = await post("/api/g/recipe/credit", { ...body, ref: "rc-x-gone:1", userId: "deleted-user" });
  assert.equal(gone.status, 404); assert.equal(gone.body.code, "no_account");
  assert.equal((await post("/api/g/recipe/credit", { ...body, password: "nope" })).status, 403);
  assert.equal((await post("/api/g/recipe/credit", { ...body, ref: "rc-y:1", slice: "bogus" })).status, 400);
  const e = await RC.earned(PLANT, "reg1", "people");
  assert.equal(e.d7, 4321);
});

test("royalty cutover: dry run, release once under one key, frozen, settled exactly", async () => {
  F.sync({ reserve: 5000000, flows: { room_owner: "reserve" }, fortknox: 0 });
  await RY.setConfig({ enabled: true });
  // pending: two periods accrued, one partly released
  const ins = (kind, amount, ref, period) => runQuery(`INSERT INTO royalty_ledger (room_id, owner_user_id, kind, source, amount, period, ref, created)
                                                      VALUES (?, 'owner', ?, 'spend', ?, ?, ?, ?)`, [PLANT, kind, amount, period, ref, T - DAY]);
  const P = RY.periodOf(T);
  await ins("accrue", 23000, "spend:a", P - 1); await ins("accrue", 4680, "spend:b", P); await ins("release", 1000, "release:x", P - 1);
  const dry = await RY.cutover({ key: "rcut-test1", dry: true });
  assert.equal(dry.ok, true); assert.equal(dry.pending, 26680);
  assert.deepEqual(dry.pairs.map((p) => [p.room_id, p.owner, p.pending]), [[PLANT, "owner", 26680]]);
  const b0 = await bal("owner");
  const run = await RY.cutover({ key: "rcut-test1", dry: false });
  assert.equal(run.ok, true); assert.equal(run.released + run.queued, 26680); assert.equal(run.pending_after, 0);
  assert.equal(await bal("owner"), b0 + 26680, "paid once");
  const again = await RY.cutover({ key: "rcut-test1", dry: false });
  assert.equal(again.ok, true); assert.equal(again.done, true);
  assert.equal(await bal("owner"), b0 + 26680, "a re-run never pays twice");
  assert.equal((await RY.cutover({ key: "rcut-other", dry: false })).ok, false, "another key is refused");
  assert.ok(RY.frozen());
  assert.equal(await RY.accrue({ room_id: PLANT, source: "spend", amount: 500, ref: "spend:late", category: "ask" }), 0, "nothing accrues after the freeze");
  assert.deepEqual(await RY.releaseTick(), [], "the weekly release is off");
  const st = await RY.status(PLANT, "owner");
  assert.equal(st.pending, 0); assert.ok(st.frozen);
});

test("roomvaults: Pepe's recipe days are stored and shown on the card, never names", async () => {
  await RV.sync({ on: true, cap: 50000000, total: 1000, recipe: { on: true, topup: false, frozen: true, cfg: { owner_pct: 0.15, convoy_min: 25000 } },
    rooms: [{ id: PLANT, balance: 1000, days: { [DAYSTR]: { in: 10, out: 5, top: 2 } }, history: [{ ts: T, kind: "recipe", flow: "room payouts", amount: 5 }],
              recipe: { epochs: [{ day: DAYSTR, B: 100, rate: 10, owner: 15, gang: 0, streamers: 0, people: 35, people_n: 2, paid: 50, stays: 50,
                                   who: { u1: "secret" }, why: { gang: "no gang controls the room", owner: "<b>x</b>" } }], games: { day: DAYSTR, allow: 10, used: 4 } } }] });
  const c = await RV.card(PLANT, null, {});
  assert.equal(c.recipe.live, true); assert.equal(c.recipe.frozen, true);
  assert.equal(c.recipe.epochs[0].owner, 15); assert.equal(c.recipe.epochs[0].people_n, 2);
  assert.equal(c.recipe.epochs[0].who, undefined, "no names kept");
  assert.equal(c.recipe.epochs[0].why.owner, "bx/b", "reasons are plain text");
  assert.deepEqual(c.recipe.games, { day: DAYSTR, allow: 10, used: 4 });
  assert.equal(c.days[0].top, 2); assert.equal(c.history[0].kind, "recipe");
});

test("1.99ada: a payout day keeps the games split (slice + unpaid shares); the recipe meta keeps the applied website rev, junk dropped", async () => {
  await RV.sync({ on: true, cap: 50000000, total: 1000, recipe: { on: true, cfg: { games_pct: 0.1, games_unpaid: 1, hour: 5 } },
    rooms: [{ id: PLANT, balance: 1000, days: {}, history: [],
              recipe: { epochs: [{ day: DAYSTR, B: 1112080, games_allow: 722852, games_base: 111208, games_from_unpaid: 611644, games_from: { owner: 1 },
                                   games_capped: true, paid: 0, stays: 1112080 }] } }] });
  const e = (await RV.card(PLANT, null, {})).recipe.epochs[0];
  assert.deepEqual([e.games_allow, e.games_base, e.games_from_unpaid], [722852, 111208, 611644]);
  assert.equal(e.games_from, undefined, "the per-slice split stays Pepe's");
  assert.equal(RV.cleanRecipe({ epochs: [{ day: DAYSTR, games_allow: 5 }] }).epochs[0].games_base, 0, "an older Pepe: 0");
  const M = RV.cleanRecipeMeta;
  const m = M({ on: true, cfg: { owner_pct: 0.15, games_unpaid: 1, hour: 5 }, cfg_rev: 8, cfg_src: "site", cfg_applied_at: 1760885040,
                cfg_error: { rev: 9, errors: ["a", "b", "c", "d", "e", "sixth", "x"], extra: 1 } });
  assert.equal(m.cfg.games_unpaid, 1); assert.equal(m.cfg.hour, 5);
  assert.deepEqual([m.cfg_rev, m.cfg_src, m.cfg_applied_at], [8, "site", 1760885040]);
  assert.deepEqual(m.cfg_error, { rev: 9, errors: ["a", "b", "c", "d", "e"] }, "at most 5 errors");
  const long = M({ cfg_error: { rev: 1, errors: ["<b>" + "x".repeat(300), 7, null] } }).cfg_error;
  assert.equal(long.errors.length, 1, "non-strings dropped");
  assert.equal(long.errors[0], "b" + "x".repeat(119), "markup stripped, 120 characters");
  const junk = M({ cfg_rev: 1.5, cfg_src: "chat", cfg_applied_at: "soon", cfg_error: { rev: "9", errors: ["x"] } });
  assert.deepEqual([junk.cfg_rev, junk.cfg_src, junk.cfg_applied_at, junk.cfg_error], [null, null, null, null]);
  assert.equal(M({ cfg_rev: -1 }).cfg_rev, null);
  assert.equal(M({ cfg_rev: 0 }).cfg_rev, 0);
  const old = M({ on: true, cfg: { owner_pct: 0.15 } });
  assert.deepEqual([old.cfg_rev, old.cfg_src, old.cfg_applied_at, old.cfg_error], [null, null, null, null], "an older Pepe reports none of them");
});
