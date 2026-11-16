"use strict";
// roulette2 WP3, Pepe's long-poll (contract 5, O12(b)): state_after in, state_seq + now out - a wake that found no waiting poll can
// no longer be lost (a web wheel on the stream drawn by "Spin now" writes no event row); rooms carry each room's game toggles and
// push / advertise refuse a room with that game off; an older Pepe (no state_after, rooms {id, name}) polls exactly as before.
// Invented accounts a..d only.
const test = require("node:test"),
  assert = require("node:assert/strict");
const h = require("./fixtures/casino-rl-harness");
const { svc, act, room, expect, actor } = h;
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

let n = 0;
const openWeb = (uid) => svc.act(actor(uid), "start", [], { room: null, game: "roulette" }, "poll-open-" + uid + "-" + ++n);
const admin = (uid) => ({ ...actor(uid), admin: true });
const settle = async (ok, what) => {
  for (let i = 0; i < 1000 && !ok(); i++) await new Promise((r) => setTimeout(r, 2));
  assert.ok(ok(), what);
};
const timed = async (p) => {
  const t0 = Date.now();
  const out = await p;
  return { out, ms: Date.now() - t0 };
};

test("O12(b): a change with no event row and no waiting poll (Spin now on a web wheel on the stream) is never lost with state_after", async () => {
  const W = svc.getTable(expect(await openWeb("a")).table);
  expect(await svc.stream(W.id, true, admin("a"), false));
  expect(await act(W, "a", "bet", "red 100"));
  const first = await svc.poll(-1, 0);
  assert.equal(first.tables[W.id].phase, "betting");
  assert.equal(typeof first.state_seq, "number");
  assert.equal(first.now, h.time(), "now: the site's clock");
  assert.equal(svc.S.waiters.size, 0, "nobody is waiting");
  // the sole bettor's Spin now: the draw wakes nobody (no poll is waiting) and its line writes no event row (a web-only wheel)
  expect(await act(W, "a", "go"));
  assert.equal(W.eng.phase, "spinning");
  // an older Pepe (no state_after): no new row - he waits his long-poll out (the board stays on "Place your bets" meanwhile)
  const old = await timed(svc.poll(first.cursor, 400));
  assert.ok(old.ms >= 350, "waited " + old.ms + " ms");
  assert.equal(old.out.events.length, 0);
  // this Pepe: the state changed since his last answer - answered at once, with the committed spin
  const fresh = await timed(svc.poll(first.cursor, 6000, first.state_seq));
  assert.ok(fresh.ms < 2000, "at once (" + fresh.ms + " ms)");
  const v = fresh.out.tables[W.id];
  assert.equal(v.phase, "spinning");
  assert.equal(v.spin.number, W.round.pocket);
  assert.equal(v.rev, W.rev);
  assert.ok(fresh.out.state_seq > first.state_seq);
  assert.equal(fresh.out.now, h.time());
  // nothing new since: his next poll waits
  const idle = await timed(svc.poll(fresh.out.cursor, 300, fresh.out.state_seq));
  assert.ok(idle.ms >= 250, "waited " + idle.ms + " ms");
  assert.equal(idle.out.state_seq, fresh.out.state_seq);
});

test("O12(b): every wake bumps state_seq; a poll at the current seq waits for the next change and answers it at once", async () => {
  const W = svc.getTable(expect(await openWeb("b")).table);
  expect(await svc.stream(W.id, true, admin("b"), false));
  const base = await svc.poll(-1, 0);
  const seq = svc.S.stateSeq;
  assert.equal(base.state_seq, seq);
  const waiting = svc.S.waiters.size;
  const t0 = Date.now();
  const p = svc.poll(base.cursor, 6000, base.state_seq);
  await settle(() => svc.S.waiters.size > waiting, "it waits: nothing changed");
  expect(await act(W, "b", "bet", "black 200")); // (a web wheel on the stream: no event row, only its save's wake)
  const out = await p;
  assert.ok(Date.now() - t0 < 3000, "woken");
  assert.equal(out.events.length, 0);
  assert.ok(out.state_seq > seq, "bumped");
  assert.equal(out.tables[W.id].phase, "betting");
  assert.deepEqual(out.tables[W.id].felt, [{ t: "black", n: 200, k: 1 }]);
  // a seq from another process (a restart: his number is not this process's) answers at once; junk is no state_after
  assert.ok((await timed(svc.poll(out.cursor, 6000, svc.S.stateSeq + 12345))).ms < 2000);
  assert.ok((await timed(svc.poll(out.cursor, 6000, 1))).ms < 2000);
  assert.ok((await timed(svc.poll(out.cursor, 300, "x"))).ms >= 250, "not a number: waits as an older Pepe does");
  // a quiet web wheel (not in a room, not on the stream) changes nothing Pepe draws: no wake, no bump
  const Q = svc.getTable(expect(await openWeb("c")).table);
  const before = svc.S.stateSeq;
  expect(await act(Q, "c", "bet", "red 100"));
  assert.equal(svc.S.stateSeq, before);
});

test("contract 5 over HTTP: state_after in, state_seq + now out; rooms' game flags (push refuses a room with roulette off); an older Pepe is as before", async (t) => {
  const express = require("express"),
    app = express();
  app.use(express.json());
  require("../casino/routes").register(app, { isBotToken: (x) => x === "localtest", addUser: (q, r, next) => ((q.user = null), next()) });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  t.after(() => srv.close());
  const poll = async (body) => {
    const t0 = Date.now();
    const r = await fetch("http://127.0.0.1:" + srv.address().port + "/api/casino/bot/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "localtest", ...body }),
    });
    return { j: await r.json(), ms: Date.now() - t0 };
  };
  const W = svc.getTable(expect(await openWeb("a")).table);
  const R = await room("pad-on");
  // a new Pepe: each room's game toggles
  const { j } = await poll({
    after: -1,
    wait: 0,
    games: ["roulette"],
    state_after: 0,
    rooms: [
      { id: "pad-on", name: "Pad On", games: { bj: true, holdem: true, roulette: true } },
      { id: "pad-off", name: "Pad Off", games: { bj: true, holdem: false, roulette: false } },
      { id: "pad-free", name: "Pad Free", games: { bj: false, holdem: false, roulette: true } },
    ],
  });
  assert.equal(j.ok, true);
  assert.equal(typeof j.state_seq, "number");
  assert.equal(j.now, h.time());
  const rows = Object.fromEntries(j.roulette.map((x) => [x.id, x]));
  for (const k of ["tier", "high_stakes", "min_bet", "max_straight", "max_spin", "players", "phase", "deadline", "land_at", "rooms", "room_name", "lobby", "slot"])
    assert.ok(k in rows[W.id], k);
  assert.deepEqual(rows[R.id].rooms, ["pad-on"]);
  assert.equal(rows[R.id].room_name, "Pad On");
  const fresh = Object.fromEntries(svc.freshRooms("roulette").map((r) => [r.id, r]));
  assert.equal(fresh["pad-off"].off, true);
  assert.equal(fresh["pad-free"].off, false);
  assert.deepEqual(fresh["pad-off"].games, { bj: true, holdem: false, roulette: false });
  const cardRoom = svc.freshRooms("bj").find((r) => r.id === "pad-free");
  assert.equal(cardRoom.off, undefined, "a card table's push isn't judged by Pepe's toggles (his card lines aren't gated by them)");
  assert.deepEqual(cardRoom.games, { bj: false, holdem: false, roulette: true }, "the flags themselves are there for every table");
  assert.equal(svc.freshRooms().find((r) => r.id === "pad-off").off, undefined, "no game asked: no verdict");
  assert.equal((await svc.push(W.id, "pad-off", actor("a"))).reply, "Roulette is off in that room.");
  expect(await svc.push(W.id, "pad-free", actor("a")));
  // an advert is posted only where that game's toggle is on (Pepe's own gate) - so one he'd never post is refused, any game
  await svc.setSetting("bj_enabled", "1");
  const B = svc.getTable(expect(await svc.act(actor("c", "room"), "start", [], { room: "pad-bj", game: "bj" }, "poll-bj-open")).table);
  assert.equal((await svc.advertise(B.id, "pad-free", actor("c"), true)).reply, "Blackjack is off in that room.");
  expect(await svc.advertise(B.id, "pad-off", actor("c"), true));
  // state_after reaches the service: an older seq answers at once; the current one waits
  const at = await poll({ after: j.cursor, wait: 6, games: ["roulette"], state_after: j.state_seq - 1, rooms: [] });
  assert.ok(at.ms < 3000, "at once (" + at.ms + " ms)");
  const cur = await poll({ after: at.j.cursor, wait: 0.3, games: ["roulette"], state_after: at.j.state_seq, rooms: [] });
  assert.ok(cur.ms >= 250, "waited " + cur.ms + " ms");
  // an older Pepe: rooms {id, name} only, no state_after, no games list - every field he read before, roulette stripped, he waits
  const old = await poll({ after: cur.j.cursor, wait: 0.3, rooms: [{ id: "pad-old", name: "Pad Old" }] });
  for (const k of ["ok", "cursor", "events", "stream", "tables", "private", "private_mtt", "open", "lobby", "rep", "ach_want", "sng", "sng_on", "mtt_on", "enabled", "hm_enabled", "now"])
    assert.ok(k in old.j, k);
  assert.equal(old.j.roulette, undefined);
  assert.ok(!Object.values(old.j.tables).some((x) => x.game === "roulette"));
  assert.ok(old.ms >= 250, "waited " + old.ms + " ms");
  const oldRoom = svc.freshRooms("roulette").find((r) => r.id === "pad-old");
  assert.equal(oldRoom.games, undefined, "no flags invented");
  assert.equal(oldRoom.off, false);
  expect(await svc.push(W.id, "pad-old", actor("a")));
  // his room heartbeat without flags keeps the flags a newer poll sent for that room
  await poll({ after: old.j.cursor, wait: 0, rooms: [{ id: "pad-off", name: "Pad Off" }] });
  assert.equal(svc.freshRooms("roulette").find((r) => r.id === "pad-off").off, true);
  // a later heartbeat with flags replaces them
  await poll({ after: old.j.cursor, wait: 0, rooms: [{ id: "pad-off", name: "Pad Off", games: { roulette: true } }] });
  assert.equal(svc.freshRooms("roulette").find((r) => r.id === "pad-off").off, false);
});
