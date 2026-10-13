// Offline tests for 1.99uu: EVERY PAD EARNS, connected to a chat room or not (the user, 2026-10-12: "earning does not need
// Plus"; camfrog-bot pepe_roomvault / pepe_recipe 1.99uu):
//   * roomvaults.hasVault / boosts.vaultEligible: a site-only pad has a vault; an unregistered room doesn't; a profile only
//     while profile vaults are on
//   * routing: pad-scoped spending on a site-only pad sends its room half to the pad's vault (a room:<flow>:<pad> claim);
//     the owner's own spend is all Fort Knox (self-dealing unchanged)
//   * /api/g/recipe/inputs: pad_days / owner_pad_days for a pad without a connected Camfrog room - a day counts with >= 3
//     QUALIFIED accounts (young accounts don't: anti-farm unchanged), the owner's posts / streams / moderation count, days
//     outside the 7 don't; a Camfrog pad is unchanged (0 / 0, active_days as before)
//   * the sync: the recipe copy's profile_vaults follows the sync's flag when Pepe leaves it out (prod 2026-10-12)
//   * the pad card is live on a site-only pad; tools/padvault-rows.js backfills empty rows idempotently (supply +0)
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-earn.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-earn-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const RC = require(path.join(repo, "recipe"));
const RV = require(path.join(repo, "roomvaults"));
const rooms = require(path.join(repo, "rooms"));
const B = require(path.join(repo, "boosts"));
const S = require(path.join(repo, "mainstage"));
const E = require(path.join(repo, "engagement"));
const PS = require(path.join(repo, "padsignals"));
const store = require(path.join(repo, "feedstore"));
const econ = require(path.join(repo, "econ"));

const DAY = 86400000;
const T = Date.UTC(2026, 9, 12, 6, 0, 0);
const DAYSTR = "2026-10-11";
const D = (n) => Date.UTC(2026, 9, 11 - n, 12, 0, 0);          // noon UTC, n days before the settled day
const dstr = (n) => new Date(D(n)).toISOString().slice(0, 10);
rooms._setClock(() => T); RC._setClock(() => T); RV._setClock(() => T); B._setClock(() => T); S._setClock(() => T); E._setClock(() => T); PS._setClock(() => T);
const GARDEN = "patv:garden", PLANT = "plant_based_chatting";
const OLD = "2026-08-01 00:00:00", YOUNG = "2026-10-10 00:00:00";
const LIVE = { reserve: 5000000, flows: {}, fortknox: 0, room_vaults: { on: true, cap: 50000000 } };
async function mkUser(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, level, created_at, isEmailVerified)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, 1)`, [id, id, id, o.bal || 1000000, o.camfrog || null, o.level != null ? o.level : 5, o.created || OLD]);
  return { userId: id, username: id, class: "pleb" };
}
let seq = 0;
async function mkPost(author, pad, at) {
  const id = "p" + (++seq);
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created, home_pad, global) VALUES (?, ?, 'a post', '', ?, ?, 1)", [id, author, at, pad]);
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES (?, ?, ?)", [id, pad, at]);
  return id;
}
const up = (pid, uid, at) => runQuery(`INSERT INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)`, [pid, uid, at, at]);
const comment = (pid, uid, at) => runQuery("INSERT INTO feed_comments (id, post_id, author_id, body, created) VALUES (?, ?, ?, 'nice', ?)", ["c" + (++seq), pid, uid, at]);

let base, server, owner, fan;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0,
                  created_at TIMESTAMP, isEmailVerified INTEGER DEFAULT 0, discordId TEXT, twitchId TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await new Promise((r) => setTimeout(r, 200));            // econ.js -> welcome.js creates welcome_bonus
  owner = await mkUser("gard");
  fan = await mkUser("fan");
  for (const m of ["m1", "m2", "m3"]) await mkUser(m);
  for (const n of ["n1", "n2", "n3"]) await mkUser(n, { created: YOUNG });          // 2 days old: never qualified
  await mkUser("pb", { camfrog: "foamy1111" });
  await S.init(); await rooms.init(); await B.init(); await RV.init(); await RC.init(); await store.init(); await econ.ready;
  await rooms.addRoom(GARDEN, "The Garden", "test");
  await rooms.setOwner(GARDEN, "gard", "test");
  await rooms.setOwner(PLANT, "foamy1111", "test");
  F.sync(LIVE);
  // the Garden's 7 days ending 2026-10-11 (UTC):
  const p0 = await mkPost("m1", GARDEN, D(0));                     // day 0: m1 posts, m2 comments, m3 upvotes -> active
  await comment(p0, "m2", D(0) + 60e3); await up(p0, "m3", D(0) + 120e3);
  const p1 = await mkPost("n1", GARDEN, D(1));                     // day 1: three YOUNG accounts + m1 -> only 1 qualified
  await comment(p1, "n2", D(1) + 60e3); await up(p1, "n3", D(1) + 90e3); await up(p1, "m1", D(1) + 120e3);
  const p2 = await mkPost("m1", GARDEN, D(2));                     // day 2: m1, m2 + m3 watching the owner's stream -> active;
  await comment(p2, "m2", D(2) + 60e3);                            //        the owner streamed -> an owner day
  await runQuery(`INSERT INTO econ_watch (day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, beats, status) VALUES (?, 'slot:g1', ?, 'gard', 'm3', 900, 0, 30, 'ok')`,
                 [dstr(2), GARDEN]);
  const p3 = await mkPost("gard", GARDEN, D(3));                   // day 3: the owner posts, m1-m3 upvote -> active + owner day
  for (const m of ["m1", "m2", "m3"]) await up(p3, m, D(3) + 60e3);
  await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, 'feed-remove', 'gard', 'spam')", [GARDEN, D(4)]);   // day 4: moderation
  await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, 'vault-rate', 'gard', '10 -> 12')", [GARDEN, D(5)]); // not moderation
  await mkPost("gard", GARDEN, D(9));                              // outside the 7 days
  const app = express();
  app.use(express.json());
  RC.register(app, { isBotToken: (t) => t === "bot-token" });
  RV.register(app, { addUser: (req, res, next) => next(), isBotToken: (t) => t === "bot-token" });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("every registered pad has a vault, connected or not; a profile only while profile vaults are on", async () => {
  assert.equal(RV.hasVault(GARDEN), true, "a site-only pad");
  assert.equal(RV.hasVault(PLANT), true, "a Camfrog pad (unchanged)");
  assert.equal(await B.vaultEligible(GARDEN), true);
  assert.equal(await B.vaultEligible("patv:nobody-made-this"), false, "an unregistered pad: no vault");
  const prof = rooms.profileId(owner.userId);
  RV._setProfileVaults(false);
  assert.equal(RV.hasVault(prof), false, "a profile: off");
  RV._setProfileVaults(true);
  assert.equal(RV.hasVault(prof), true, "a profile: on");
  RV._setProfileVaults(false);
});

test("pad-scoped spending on a site-only pad feeds its vault (room half claim); the owner's own spend is all Fort Knox", async () => {
  // a pad cosmetic / stage slot fee / library play on the Garden (boosts.routeInTx, the path every website room flow takes)
  const r = await B.tx(() => B.routeInTx({ ref: "t-garden-1", kind: "pad_cosmetic", room_id: GARDEN, payer_id: fan.userId, amount: 10001,
                                             owner_self: false, flow: "pad_cosmetics" }));
  assert.deepEqual([r.fortknox, r.room_vault], [5001, 5000]);
  const cl = await getQuery("SELECT flow, amount FROM reserve_claims WHERE flow LIKE 'room:%'");
  assert.deepEqual(cl.map((x) => [x.flow, x.amount]), [["room:pad_cosmetics:" + GARDEN, -5000]], "credited to room:patv:garden by Pepe");
  const o = await B.tx(() => B.routeInTx({ ref: "t-garden-2", kind: "pad_cosmetic", room_id: GARDEN, payer_id: owner.userId, amount: 3000,
                                             owner_self: true, flow: "pad_cosmetics" }));
  assert.deepEqual([o.fortknox, o.room_vault], [3000, 0], "self-dealing rules unchanged");
});

test("recipe inputs: a pad without a connected room is measured on the pad (qualified people only); a Camfrog pad is unchanged", async () => {
  const r = await post("/api/g/recipe/inputs", { password: "bot-token", day: DAYSTR,
    rooms: [{ room: GARDEN, owner_login: null, logins: [] }, { room: PLANT, owner_login: "foamy1111", logins: [] }] });
  assert.equal(r.status, 200);
  const g = r.body.rooms.find((x) => x.room === GARDEN), p = r.body.rooms.find((x) => x.room === PLANT);
  assert.deepEqual(g.owner, { userId: "gard" });
  assert.equal(g.pad_days, 3, "days 0, 2 and 3 (day 1's young accounts don't count; nothing else)");
  assert.equal(g.owner_pad_days, 3, "the owner streamed (day 2), posted (day 3), moderated (day 4); a rate change and day 9 don't count");
  assert.deepEqual([p.pad_days, p.owner_pad_days], [0, 0], "a Camfrog pad with no feed / stage activity: 0 pad days");
  assert.equal(typeof p.active_days, "number");
  const direct = await RC.padDays(await rooms.get(GARDEN), DAYSTR);
  assert.deepEqual([direct.pad_days, direct.owner_pad_days], [3, 3]);
  assert.deepEqual(direct.pad_dates, [dstr(3), dstr(2), dstr(0)], "the dates themselves (1.99vm)");
  assert.deepEqual(direct.owner_pad_dates, [dstr(4), dstr(3), dstr(2)]);
});

test("the sync: the recipe copy's profile_vaults follows the sync flag when Pepe leaves it out", async () => {
  await RV.sync({ on: true, profile_vaults: true, rooms: [{ id: GARDEN, balance: 5000, days: {}, history: [] }], recipe: { on: true, cfg: {} } });
  const m = await getQuery("SELECT value FROM room_vault_meta WHERE key = 'recipe'");
  assert.equal(JSON.parse(m[0].value).profile_vaults, true, "the recipe copy agrees with the top-level flag");
  await RV.sync({ on: true, profile_vaults: true, rooms: [{ id: GARDEN, balance: 5000, days: {}, history: [] }], recipe: { on: true, cfg: {}, profile_vaults: false } });
  assert.equal(JSON.parse((await getQuery("SELECT value FROM room_vault_meta WHERE key = 'recipe'"))[0].value).profile_vaults, false,
               "an explicit value from Pepe is kept");
  const c = await RV.card(GARDEN, null, {});
  assert.deepEqual([c.live, c.balance, c.profile], [true, 5000, false], "a site-only pad's card is live with its balance");
  RV._setProfileVaults(false);
});

test("tools/padvault-rows.js: dry run reports, --apply adds empty rows once (supply +0)", async () => {
  const tool = path.join(repo, "tools", "padvault-rows.js");
  const env = { ...process.env, NODE_PATH: process.env.NODE_PATH || "" };
  const sum0 = (await getQuery("SELECT COALESCE(SUM(balance),0) AS s, COUNT(*) AS n FROM room_vault_state"))[0];
  const dry = JSON.parse(execFileSync(process.execPath, [tool, "--json"], { cwd: tmp, env }).toString().replace(/^[^{]*/, ""));
  assert.ok(dry.rows_to_add >= 1 && dry.rows.includes(PLANT) && !dry.rows.includes(GARDEN), "the pads without a row (the Garden has one from the sync)");
  assert.equal(dry.supply.delta, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_vault_state"))[0].n, sum0.n, "a dry run writes nothing");
  assert.throws(() => execFileSync(process.execPath, [tool, "--apply"], { cwd: tmp, env, stdio: "pipe" }), "apply outside staging is refused");
  const ap = JSON.parse(execFileSync(process.execPath, [tool, "--apply", "--json"], { cwd: tmp, env: { ...env, STAGING: "1" } }).toString().replace(/^[^{]*/, ""));
  assert.equal(ap.applied, dry.rows_to_add);
  const again = JSON.parse(execFileSync(process.execPath, [tool, "--apply", "--json"], { cwd: tmp, env: { ...env, STAGING: "1" } }).toString().replace(/^[^{]*/, ""));
  assert.deepEqual([again.rows_to_add, again.applied], [0, 0], "idempotent");
  const sum1 = (await getQuery("SELECT COALESCE(SUM(balance),0) AS s FROM room_vault_state"))[0];
  assert.equal(sum1.s, sum0.s, "supply unchanged (empty rows)");
});

test("1.99vm: a connected pad's days join its chat room's and its pad's (either place qualifies; a day counts once)", async () => {
  // Houseplants: bridged active on day 1 and day 3; on the pad: day 3 (again) and day 5 with 3 qualified members
  for (const [d, m, pk] of [[dstr(1), 90, 4], [dstr(3), 120, 5]]) {
    await runQuery("INSERT INTO room_activity (room_id, day, minutes, peak, lines) VALUES (?, ?, ?, ?, 0)", [PLANT, d, m, pk]);
  }
  for (const n of [3, 5]) {
    const pid = await mkPost("m1", PLANT, D(n));
    await comment(pid, "m2", D(n) + 60e3); await up(pid, "m3", D(n) + 90e3);
  }
  const pb = await rooms.get(PLANT);
  const pid = await mkPost(pb.owner.userId, PLANT, D(6));               // the owner posts on the pad on day 6
  const r = await post("/api/g/recipe/inputs", { password: "bot-token", day: DAYSTR, rooms: [{ room: PLANT, owner_login: "foamy1111", logins: [] }] });
  const x = r.body.rooms[0];
  assert.deepEqual(x.active_dates, [dstr(3), dstr(1)].sort(), "the bridged active days");
  assert.deepEqual(x.pad_dates, [dstr(5), dstr(3)].sort(), "the pad's own active days");
  assert.equal(x.active_days, 2, "active_days is still the room's alone (older Pepes)");
  assert.equal(x.active_any_days, 3, "room OR pad: days 1, 3, 5 - day 3 once");
  assert.deepEqual(x.owner_pad_dates, [dstr(6)], "the owner's pad days go to Pepe as dates (he joins them with Camfrog presence)");
  assert.ok(pid);
});

test("1.99vm: every pad can be boosted and can rank on the front page / Top Pads by its site activity", async () => {
  const b = await B.boost(fan, GARDEN, { amount: 10001, ref: "r-garden-b1" });
  assert.deepEqual([b.fortknox, b.room_vault], [5001, 5000], "a site-only pad can be boosted; the room half goes to its vault");
  await assert.rejects(B.boost(fan, rooms.profileId(owner.userId), { amount: 5000, ref: "r-prof-b1" }), /Profiles can't be boosted|No such pad/);
  PS._reset();
  let rows = await PS.rows(20, T);
  const g0 = rows.find((r) => r.id === GARDEN);
  assert.equal(g0.live, false, "nothing in the last 20 minutes: not live (no score)");
  assert.ok(!rows.some((r) => r.id === PLANT), "a Camfrog pad keeps its bridge row (no site row)");
  // fresh activity: m1 posts, m2 comments, m3 + a 2-day-old account upvote, and someone watches the stage now
  const pid = await mkPost("m1", GARDEN, T - 5 * 60e3);
  await comment(pid, "m2", T - 4 * 60e3); await up(pid, "m3", T - 3 * 60e3); await up(pid, "n1", T - 3 * 60e3);
  await runQuery(`INSERT INTO econ_watch (day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, beats, status, updated) VALUES (?, 'slot:g2', ?, 'gard', 'fan', 60, 0, 2, 'ok', ?)`,
                 ["2026-10-12", GARDEN, T - 30e3]);
  PS._reset();
  rows = await PS.rows(20, T);
  const g = rows.find((r) => r.id === GARDEN);
  assert.equal(g.live, true);
  assert.deepEqual([g.act.chatters, g.act.lines, g.act.people, g.act.micMin], [3, 2, 1, 0], "3 qualified chatters (the young account doesn't count), 2 lines, 1 viewer");
  const merged = await PS.merge([{ id: PLANT, slug: "houseplants", name: "Houseplants", count: 3, live: true }], 20, T);
  assert.ok(merged.some((r) => r.id === GARDEN), "the site pad joins the bridge's rows");
  const RL = await rooms.rankLive([], { now: T });
  assert.ok(RL.ranked.some((r) => r.id === GARDEN && r.score > 0), "rankLive (Top Pads / the front pick) includes the site pad with a score");
});
