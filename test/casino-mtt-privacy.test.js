// h22 phase 2 (1.99amj): privacy on every scheduled-tournament surface - a veiled entrant (incognito, out, a failed check = unknown) is
// "someone" in the players list, !mtt top, the results, the room lines and the batched hand-for-hand lines; no account ids, addresses, the
// draw seed (before the end) or M.people in any answer; veiled results stay off the public leaderboard and someone veiled NOW is left off it;
// a moved player starts a new seat session at the new table; hole cards and turn prompts only in the player's own view and in Pepe's
// private part for room players, in their own room.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
let veiled = new Map();                     // userId -> kind
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-privacy", { veil: async (keys) => { for (const k of keys) { const m = /^u:(.+)$/.exec(k); if (m && veiled.has(m[1])) return veiled.get(m[1]); } return null; } });
const { svc, MT, H, getQuery } = h;
require(path.join(h.repo, "casino", "mttseat")).newSeed = () => "d4".repeat(32);
const V = require(path.join(h.repo, "casino", "veil"));

test.before(async () => { await h.setup(40); });
test.after(() => svc.stop());
const P = () => h.players;
const noSecrets = (M, obj, label) => {
  const s = JSON.stringify(obj);
  for (const uid of Object.keys(M.people)) assert.ok(!s.includes(`"${uid}"`), `${label}: no account id ${uid}`);
  assert.ok(!s.includes("iph"), `${label}: no address hash`);
  if (!["done", "cancelled", "settled"].includes(M.status)) assert.ok(!s.includes(M.seed.draw_seed), `${label}: no seed before the end`);
  assert.ok(!s.includes('"people"'), `${label}: never M.people`);
};

test("a veiled entrant is 'someone' in the players list, !mtt top, the results and the room lines; no ids / addresses / seeds in any answer", async () => {
  await h.fresh();
  V._reset();
  veiled = new Map([[P()[1].uid, "incognito"], [P()[2].uid, "out"], [P()[3].uid, "unknown"]]);
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }]);
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0, rooms: ["PepeLab"] });
  await h.reg(M, P().slice(0, 6).map((p, i) => (i === 0 ? h.mk(p.uid, p.name, { iph: "addr-0" }) : p)));
  await h.toStart(M);
  const pl = await MT.players(M, 1);
  const names = pl.rows.map((r) => r.name);
  assert.equal(names.filter((n) => n === "someone").length, 3, "incognito, out and unknown read as someone");
  for (const p of P().slice(1, 4)) assert.ok(!names.includes(p.name));
  noSecrets(M, pl, "players");
  noSecrets(M, MT.publicView(M), "view");
  noSecrets(M, await MT.lobby(P()[0].uid), "lobby");
  noSecrets(M, MT.view(MT.liveTables(M)[0]), "table tourney block");
  const top = await h.M(P()[0], "top", [String(M.no)]);
  for (const p of P().slice(1, 4)) assert.ok(!top.reply.includes(p.name), "!mtt top masks");
  await h.drive(M, { policy: h.allIn() });
  const res = await MT.results(M);
  for (const p of P().slice(1, 4)) assert.ok(!res.some((r) => r.name === p.name), "results mask");
  const lines = (await getQuery("SELECT data FROM casino_events WHERE table_id = ? AND kind = 'mtt'", [M.id])).map((r) => JSON.parse(r.data).text).join(" | ");
  for (const p of P().slice(1, 4)) assert.ok(!lines.includes(p.name), `the room lines never name ${p.name}: ${lines}`);
  noSecrets(M, (await getQuery("SELECT data FROM casino_events WHERE table_id = ?", [M.id])).map((r) => JSON.parse(r.data)), "events");
  // the seed is public once it's over
  assert.equal(MT.publicView(M).seed, M.seed.draw_seed);
});

test("the leaderboard: results veiled at play time never count publicly; someone veiled NOW is left off entirely and the ranks close up", async () => {
  await h.fresh({ settings: { mtt_points_min_field: 2 } });
  V._reset();
  veiled = new Map([[P()[10].uid, "incognito"]]);
  const M = await h.schedule({ max_entries: 20, min_entries: 2, late_levels: 0 });
  await h.reg(M, P().slice(10, 16));
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  const rows = await getQuery("SELECT * FROM casino_mtt_points WHERE tid = ?", [M.id]);
  assert.equal(rows.find((r) => r.user_id === P()[10].uid).veiled, 1);
  let lb = await MT.leaderboard("all", 1);
  assert.ok(!lb.rows.some((r) => r.name === P()[10].name), "veiled play stays off");
  assert.ok((await MT.veiledPoints(P()[10].uid)) >= 0);
  // veiled now (not at play time): omitted entirely
  veiled = new Map([[P()[11].uid, "out"]]);
  V._reset();
  await new Promise((r) => setTimeout(r, 5));
  h.NOW += 120e3;
  lb = await MT.leaderboard(new Date(h.NOW).toISOString().slice(0, 7), 1);
  assert.ok(!lb.rows.some((r) => r.name === P()[11].name), "veiled now: omitted");
  assert.deepEqual(lb.rows.map((r) => r.rank), lb.rows.map((_, i) => i + 1), "ranks recomputed");
  veiled = new Map();
});

test("a moved player starts a new seat session at the new table; hole cards / turn prompts only in their own view and in Pepe's private part, in their own room", async () => {
  await h.fresh();
  V._reset();
  veiled = new Map();
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }, { id: "OtherRoom", name: "OtherRoom" }]);
  const M = await h.schedule({ max_entries: 30, min_entries: 2, table_size: 6, late_levels: 0 });
  const room = h.mk(P()[20].uid, P()[20].name, { via: "room", camfrog: "RoomGuy", room: "PepeLab" });
  await h.reg(M, [room].concat(P().slice(21, 27)));
  await h.toStart(M);
  await h.later(7);
  const T = MT.liveTables(M).find((x) => x.eng.seats.includes(room.uid));
  assert.ok(T);
  // Pepe's private part: the room player's cards, keyed per table / hand / login, in their own room only (the rooms Pepe reports now)
  svc.noteRooms([{ id: "PepeLab", name: "PepeLab" }, { id: "OtherRoom", name: "OtherRoom" }]);
  const priv = await MT.privateMtt();
  const mine = priv.filter((x) => x.camfrog === "RoomGuy");
  if (T.eng.hand_active) {
    const cards = mine.find((x) => x.kind === "cards");
    assert.ok(cards, "the hole cards");
    assert.equal(cards.room, "PepeLab");
    assert.equal(cards.key, `${T.id}:${T.eng.hand_no}:roomguy`);
    assert.ok(!priv.some((x) => x.room === "OtherRoom"), "never another room");
    assert.ok(priv.every((x) => x.camfrog === "RoomGuy"), "only room players");
  }
  // the public table view never carries hole cards; meView carries only your own
  const pub = svc.publicView(T);
  const others = T.eng.seats.filter((k) => k !== room.uid);
  const me = await svc.meView(T, others[0]);
  if (T.eng.hand_active) {
    assert.deepEqual(me.cards, T.eng.hole[others[0]]);
    for (const k of T.eng.seats) for (const c of T.eng.hole[k] || []) assert.ok(!JSON.stringify(pub).includes(`"${c}"`) || T.eng.board.includes(c), "no hole card in the public view");
  }
  // the room player leaves Pepe's rooms: no PM at all
  svc.S.rooms.clear();
  assert.equal((await MT.privateMtt()).length, 0);
});

test("review: a veiled player moved to another table gets a NEW seat session there - masked at the new table (balancing, a break)", async () => {
  await h.fresh({ deckSeed: 3 });
  V._reset();
  veiled = new Map();
  const M = await h.schedule({ max_entries: 40, min_entries: 2, table_size: 6, late_levels: 0 });
  await h.reg(M, P().slice(0, 17));
  await h.toStart(M);
  // everyone away from table 1 is incognito from now on: whoever is moved to table 1 (busts there only) arrives veiled
  for (const T of MT.liveTables(M)) if (T.tourney.no !== 1) for (const u of T.eng.seats) veiled.set(u, "incognito");
  V._reset();
  const where0 = new Map(MT.liveTables(M).flatMap((T) => T.eng.seats.map((u) => [u, T.id])));
  const agg = h.policy(0.5, 0.9);
  let moved = null;
  await h.drive(M, {
    policy: (T, a) => (T.tourney.no === 1 ? agg(T, a) : H.toCall(T.eng, a) ? "fold" : "check"),
    each: async (m) => { if (moved) return; for (const T of MT.liveTables(m)) for (const u of T.eng.seats) if (veiled.has(u) && where0.get(u) !== T.id) moved = { u, T }; },
    until: (m) => !!moved || m.status !== "running",
  });
  assert.ok(moved, "a veiled player was moved");
  const pub = svc.publicView(moved.T);
  const seat = pub.seats[moved.T.eng.seats.indexOf(moved.u)];
  assert.ok(seat && seat.veil, `masked at the new table: ${JSON.stringify(seat)}`);
  assert.notEqual(seat.name, h.byUid[moved.u].name, "never their name");
  assert.ok(!JSON.stringify(pub).includes(h.byUid[moved.u].name), "nowhere in the new table's view");
  veiled = new Map();
});

