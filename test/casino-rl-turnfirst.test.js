// 1.99aof review fix ENGINE-2 / SUITES-1: a room player whose TOURNAMENT turn it is types a bare !fold / !call / !check (Pepe sends
// game "holdem") in a room that has an open roulette room wheel. POST /api/casino/bot/act still resolves the MTT table turn-first (as
// beside a blackjack or Hold'em cash table), never "A roulette wheel is open here — use !rl.". A non-turn game-less !bet in the
// wheel's room still gets the !rl pointer. (Before the fix the wheel lookup ran before the turn-first block.)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-rl-turnfirst");
const { svc, MT, H } = h;
const routes = require(path.join(h.repo, "casino", "routes"));

let server, base;
let k = 0;
const idem = () => "rl-turnfirst-idem-" + String(++k).padStart(4, "0");
const post = async (url, body) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => ({})) };
};
const bot = (body) => post("/api/casino/bot/act", Object.assign({ password: "bot-pw", idem: idem(), room: "WheelRoom" }, body));

test.before(async () => {
  await h.setup(12);
  await h.fresh();
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  routes.register(app, { isBotToken: (p) => p === "bot-pw", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) { server.closeAllConnections(); server.close(); } });

test("a tournament player's bare turn verb from a room with a roulette wheel acts at their MTT table", async () => {
  await h.fresh();
  await svc.setSetting("casino_roulette", "everyone", "test");
  await svc.loadSettings(true);
  const M = await h.schedule({ max_entries: 20, min_entries: 2 });
  const pl = h.players;
  await h.reg(M, pl.slice(0, 3));
  await h.toStart(M);
  await h.later(7);
  const T = MT.liveTables(M)[0];
  assert.ok(T && T.eng.hand_active, "an MTT hand is running");
  const a = H.currentActor(T.eng);
  const who = h.byUid[a];
  // a room wheel in the room the tournament player is chatting from (opened by someone else)
  svc.noteRooms([{ id: "WheelRoom", name: "WheelRoom" }]);
  const opened = await h.act(Object.assign({}, pl[10], { via: "room", room: "WheelRoom" }), "start", [], { game: "roulette", room: "WheelRoom" });
  assert.ok(opened.ok, opened.reply);
  assert.equal(svc.tableForRoom("WheelRoom").game, "roulette");
  assert.equal(svc.tourneyTableFor(a, "WheelRoom").T.id, T.id, "turn first: the MTT table");
  const handBefore = T.eng.hand_no, actorBefore = H.currentActor(T.eng);
  const verb = H.toCall(T.eng, a) ? "call" : "check";
  const r = await bot({ username: who.username, game: "holdem", verb, args: [] });
  assert.ok(r.j.ok, "refused: " + r.j.reply);
  assert.doesNotMatch(String(r.j.reply || ""), /roulette wheel is open here/i);
  assert.ok(T.eng.hand_no !== handBefore || H.currentActor(T.eng) !== actorBefore, "the action landed at the MTT table");
});

test("a non-turn game-less !bet in the wheel's room still gets the !rl pointer", async () => {
  await h.fresh();
  await svc.setSetting("casino_roulette", "everyone", "test");
  await svc.loadSettings(true);
  const pl = h.players;
  svc.noteRooms([{ id: "WheelRoom", name: "WheelRoom" }]);
  const opened = await h.act(Object.assign({}, pl[10], { via: "room", room: "WheelRoom" }), "start", [], { game: "roulette", room: "WheelRoom" });
  assert.ok(opened.ok, opened.reply);
  const r = await bot({ username: pl[2].username, game: null, verb: "bet", args: ["500"] });
  assert.equal(r.j.ok, false);
  assert.match(String(r.j.reply), /!rl/);
});
