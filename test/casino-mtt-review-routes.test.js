// h22 phase 2 review (1.99amj): the scheduled tournaments' HTTP + Pepe surface, the cases the first build got wrong (casino/routes.js,
// casino/service.js tourneyTableFor, casino/mtt.js start presence):
//   * start presence: the lobby block's poll (GET /api/casino/mtt, /api/casino/lobby), registering on the web, and a room registrant
//     watching on the web count as present; an absent web entrant is told (inbox) that they start sitting out
//   * a room player's bare verb goes turn-first only to TOURNAMENT tables: a game-less !bet never lands in a cash Hold'em pot elsewhere, a
//     !call stays with the room's table; two tournament turns at once -> the one whose clock runs out first
//   * at a tournament table only the action verbs answer quiet: !cards / !sitout / !sitin come back (as a PM)
//   * the leaderboard API follows the switch like its page
//   * a Pepe that doesn't know tournaments (a poll without `scene`) gets no tournament lines and no tournament table on his board
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-review-routes");
const { svc, MT, H, getQuery } = h;
const routes = require(path.join(h.repo, "casino", "routes"));
require(path.join(h.repo, "casino", "mttseat")).newSeed = () => "a9".repeat(32);

let server, base;
const hdr = (uid, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", "x-forwarded-for": "10.2.0." + (uid ? String(uid).replace(/\D/g, "") || "200" : "99") },
                                          uid ? { "x-test-user": uid } : {}, extra || {});
const post = async (url, body, uid) => { const r = await fetch(base + url, { method: "POST", headers: hdr(uid), body: JSON.stringify(body) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
const get = async (url, uid) => { const r = await fetch(base + url, { headers: hdr(uid), redirect: "manual" }); return { status: r.status, j: await r.json().catch(() => null) }; };
let k = 0;
const idem = () => "rv-idem-" + String(++k).padStart(5, "0");
const bot = (body) => post("/api/casino/bot/act", Object.assign({ password: "bot-pw", idem: idem(), room: "PepeLab" }, body));
const lab = () => svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);

test.before(async () => {
  await h.setup(40);
  await h.fresh();
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(h.repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); });
  routes.register(app, { isBotToken: (p) => p === "bot-pw", addUser: (req, res, next) => next(), discordBridge: async () => ({ ok: true }) });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) { server.closeAllConnections(); server.close(); } });

test("start presence (mtt_presence on): the lobby block's poll, the lobby, registering on the web and a room registrant on the web page count; an absent web entrant is told", async () => {
  await h.fresh({ presence: "on" });
  const M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 9, late_levels: 0 }, { startIn: 90 });
  const pl = h.players;
  const [lobbyOnly, lobbyApi, webReg, roomReg, away, roomActive, roomQuiet] = [pl[1], pl[2], pl[3], pl[4], pl[5], pl[6], pl[7]];
  await h.reg(M, [lobbyOnly, lobbyApi, away]);
  lab();
  for (const [p, cf] of [[roomReg, "RoomRegCF"], [roomActive, "RoomActiveCF"], [roomQuiet, "RoomQuietCF"]]) {
    const rr = await bot({ username: p.username, camfrog: cf, game: "mtt", verb: "join", args: [String(M.no)] });
    assert.ok(rr.j.ok, rr.j.reply);
  }
  h.NOW = M.start_at - 10 * 60e3;
  const me = await bot({ username: roomActive.username, camfrog: "RoomActiveCF", game: "mtt", verb: "me", args: [] });   // any casino command through Pepe
  assert.ok(me.j.ok, me.j.reply);
  h.NOW = M.start_at - 3 * 60e3;
  const w = await post(`/api/casino/mtt/${M.id}/register`, { idem: idem() }, webReg.uid);
  assert.equal(w.status, 200, JSON.stringify(w.j));
  h.NOW = M.start_at - 2 * 60e3;
  assert.equal((await get("/api/casino/mtt", lobbyOnly.uid)).status, 200);               // the Hold'em lobby's Tournaments block (10 s poll)
  assert.equal((await get("/api/casino/lobby", lobbyApi.uid)).status, 200);
  assert.equal((await get(`/api/casino/mtt/${M.id}`, roomReg.uid)).status, 200);         // registered through Pepe 88 min ago, watching on the web now
  await h.toStart(M);
  assert.equal(M.status, "running");
  const T = MT.liveTables(M)[0];
  for (const p of [lobbyOnly, lobbyApi, webReg, roomReg, roomActive]) assert.equal(T.qol[p.uid].out, false, `${p.uid}: present`);
  assert.equal(T.qol[away.uid].out, true, "nobody heard from: sitting out");
  assert.equal(T.qol[roomQuiet.uid].out, true, "a room registrant quiet for 30+ minutes: sitting out (Pepe's start PM tells them)");
  await new Promise((r) => setTimeout(r, 10));
  const told = await getQuery("SELECT title, body FROM inbox WHERE user_id = ? AND ref LIKE ?", [away.uid, `mtt:${M.id}:%`]);
  assert.ok(told.some((n) => /sitting out/i.test(n.title + " " + n.body)), `the absent web entrant is told: ${JSON.stringify(told)}`);
  for (const p of [lobbyOnly, webReg]) {
    const n = await getQuery("SELECT title, body FROM inbox WHERE user_id = ? AND ref LIKE ?", [p.uid, `mtt:${M.id}:%start%`]);
    assert.ok(!n.some((x) => /sitting out/i.test(x.title + " " + x.body)), `${p.uid}: present - no sitting-out notice`);
  }
});

test("bare verbs: turn-first only at tournament tables - a game-less !bet never goes to a cash Hold'em table elsewhere, !call stays with the room's table; two tournament turns -> the one due first", async () => {
  await h.fresh();
  const pl = h.players;
  lab();
  // X at a web cash Hold'em table (no room) - it's X's turn there; PepeLab has its own blackjack table
  const X = pl[10];
  const cash = await h.act(pl[11], "start", ["25/50"], { game: "holdem", room: null });
  const C = svc.getTable(cash.table);
  H.sit(C.eng, X.uid, X.name, 2000);
  C.eng.hand_active = true; C.eng.actor = X.uid;
  await svc.setSetting("bj_enabled", "1", "test");
  const bj = await h.act(Object.assign({}, pl[12], { via: "room", room: "PepeLab" }), "start", [], { game: "bj", room: "PepeLab" });
  assert.ok(bj.ok, bj.reply);
  assert.equal(svc.tourneyTableFor(X.uid, "PepeLab", { turnOnly: true }).T, null, "a game-less !bet: not the cash Hold'em table where it's X's turn");
  const paid0 = C.eng.street_paid[X.uid] || 0, chips0 = C.eng.chips[X.uid];
  await bot({ username: X.username, verb: "bet", args: ["500"] });
  assert.equal(C.eng.chips[X.uid], chips0, "no chips moved at the cash Hold'em table");
  assert.equal(C.eng.street_paid[X.uid] || 0, paid0);
  // !call (game holdem) from PepeLab where X sits at the room's Hold'em table: the room's table, not a cash table in another place
  await svc.locked(async () => { const B = svc.getTable(bj.table); B.status = "closed"; });
  const room = await h.act(Object.assign({}, pl[13], { via: "room", room: "PepeLab" }), "start", ["25/50"], { game: "holdem", room: "PepeLab" });
  const RT = svc.getTable(room.table);
  H.sit(RT.eng, X.uid, X.name, 2000);
  assert.equal(svc.tourneyTableFor(X.uid, "PepeLab").T.id, RT.id, "the room's table");
  C.eng.hand_active = false; C.eng.actor = null;
  // two tournaments, X's turn at both: the one whose turn clock runs out first
  const M1 = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  const M2 = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 }, { startIn: 61 });
  await h.reg(M1, [X, pl[20], pl[21]]);
  await h.reg(M2, [X, pl[22], pl[23]]);
  await svc.locked(() => MT.admin("start", h.admin, M1, {}));
  await svc.locked(() => MT.admin("start", h.admin, M2, {}));
  const T1 = MT.liveTables(M1)[0], T2 = MT.liveTables(M2)[0];
  for (const [T, dl] of [[T1, h.NOW + 40e3], [T2, h.NOW + 20e3]]) { T.eng.hand_active = true; T.eng.actor = X.uid; T.dl.turn = dl; }
  let f = svc.tourneyTableFor(X.uid, "PepeLab");
  assert.ok(!f.err, f.err);
  assert.equal(f.T.id, T2.id, "T2's clock runs out first");
  T2.dl.turn = h.NOW + 50e3;
  f = svc.tourneyTableFor(X.uid, "PepeLab");
  assert.equal(f.T.id, T1.id);
  for (const T of [T1, T2]) { T.eng.hand_active = false; T.eng.actor = null; T.dl.turn = null; }
});

test("at a tournament table only the action verbs answer quiet: !cards / !sitout / !sitin come back as a PM", async () => {
  await h.fresh();
  lab();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  const pl = h.players;
  await h.reg(M, pl.slice(0, 3));
  await h.toStart(M);
  await h.later(7);
  const T = MT.liveTables(M)[0];
  assert.ok(T.eng.hand_active);
  const who = h.byUid[T.eng.players.find((k) => k !== H.currentActor(T.eng))];
  let r = await bot({ username: who.username, game: "holdem", verb: "cards", args: [] });
  assert.ok(r.j.ok, r.j.reply);
  assert.match(r.j.reply, /Your hand/);
  assert.ok(!r.j.quiet, "the cards are the answer - never quiet");
  assert.equal(r.j.pm, true);
  r = await bot({ username: who.username, game: "holdem", verb: "sitout", args: [] });
  assert.ok(r.j.ok && !r.j.quiet && r.j.pm, JSON.stringify(r.j));
  assert.match(r.j.reply, /sitting out/);
  r = await bot({ username: who.username, game: "holdem", verb: "sitin", args: [] });
  assert.ok(r.j.ok && !r.j.quiet && r.j.pm, JSON.stringify(r.j));
  assert.match(r.j.reply, /back in/);
  const actor = h.byUid[H.currentActor(T.eng)];
  r = await bot({ username: actor.username, game: "holdem", verb: H.toCall(T.eng, actor.uid) ? "call" : "check", args: [] });
  assert.ok(r.j.ok, r.j.reply);
  assert.equal(r.j.quiet, true, "an action: quiet (the next PM is the feedback)");
});

test("the leaderboard API follows casino_mtt like its page: staff only -> 403 for everyone else", async () => {
  await h.fresh({ mtt: "staff" });
  assert.equal((await get("/api/casino/mtt/leaderboard?period=all", null)).status, 403);
  assert.equal((await get("/api/casino/mtt/leaderboard?period=all", "u1")).status, 403);
  assert.equal((await get("/api/casino/mtt/leaderboard?period=all", "st")).status, 200, "staff");
  await svc.setSetting("casino_mtt", "everyone", "test");
  assert.equal((await get("/api/casino/mtt/leaderboard?period=all", null)).status, 200);
  await svc.setSetting("casino_mtt", "off", "test");
  assert.equal((await get("/api/casino/mtt/leaderboard?period=all", null)).status, 403);
});

test("a Pepe that doesn't know tournaments (no `scene` in his poll) gets no tournament lines and no tournament table; a new Pepe gets both", async () => {
  await h.fresh();
  lab();
  const M = await h.schedule({ max_entries: 20, min_entries: 2, table_size: 9, late_levels: 0, rooms: ["PepeLab"] });
  await h.reg(M, h.players.slice(0, 4));
  lab();
  await h.toStart(M);
  const F = MT.liveTables(M)[0];
  assert.equal(svc.S.stream.table, F.id, "the final table is on Pepe's stream slot");
  const pollAs = (extra) => post("/api/casino/bot/poll", Object.assign({ password: "bot-pw", after: 0, wait: 0, rooms: [{ id: "PepeLab", name: "PepeLab" }] }, extra));
  const old = await pollAs({});
  assert.equal(old.status, 200);
  assert.ok(!old.j.events.some((e) => e.kind === "mtt"), "no tournament lines for an older Pepe");
  assert.ok(!Object.values(old.j.tables || {}).some((t) => t.tourney && t.tourney.kind === "mtt"), "no tournament table on his board");
  const neu = await pollAs({ scene: { held: false } });
  assert.ok(neu.j.events.some((e) => e.kind === "mtt"), "the lines");
  assert.ok(Object.values(neu.j.tables || {}).some((t) => t.tourney && t.tourney.kind === "mtt"), "the final table");
  assert.ok(neu.j.mtt_on && old.j.mtt_on, "mtt_on rides on both");
});
