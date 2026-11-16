"use strict";
// 1.99aoe roulette review fixes (handoff 37 integration review): one test per finding, invented accounts a..d.
const test = require("node:test"),
  assert = require("node:assert/strict");
const h = require("./fixtures/casino-rl-harness");
const { svc, act, cash, total, room, expect, tick } = h;
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

test("MONEY-1: Rebet while a spin is in the air repeats that spin's slip (queued), also for a first-time player", async () => {
  const T = await room();
  const start = await total();
  expect(await act(T, "a", "bet", "17 5000"));
  await tick(25000);
  await tick(8000);
  await tick(5000);
  expect(await act(T, "a", "bet", "red 100"));
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  assert.equal((await svc.meView(T, "a")).last_slip, "red 100");
  const out = expect(await act(T, "a", "rebet"));
  assert.match(out.reply, /red 100/);
  assert.doesNotMatch(out.reply, /17 5,?000/);
  await tick(8000);
  assert.equal((await svc.meView(T, "a")).last_slip, "red 100", "at the result: the spin that landed");
  const landed = await cash("a");
  await tick(5000);
  assert.equal(landed - (await cash("a")), 100, "the queued rebet is charged when the next window opens");
  // betting: the previous spin, not the lines on the wheel now
  assert.equal((await svc.meView(T, "a")).last_slip, "red 100");
  const first = await room("pad-b");
  expect(await act(first, "b", "bet", "black 200"));
  await tick(25000);
  const again = expect(await act(first, "b", "rebet"));
  assert.match(again.reply, /black 200/);
  await tick(8000);
  await tick(5000);
  assert.equal(await total(), start);
});

test("ENGINE-3 / SECURITY-2 / UI-1: a table poll never takes the intro notice; the first request asks for it and the page and the Dock show its text", async () => {
  const fs = require("node:fs"),
    path = require("node:path");
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use((q, r, next) => {
    q.user = q.get("x-user") ? { userId: q.get("x-user"), username: "player" + q.get("x-user") } : null;
    next();
  });
  require(path.join(h.repo, "casino", "routes")).register(app, { isBotToken: () => false, addUser: (q, r, n) => n() });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  const get = (q) =>
    fetch("http://127.0.0.1:" + srv.address().port + "/api/casino/t/" + h.lobby().id + q, { headers: { "x-user": "c" } }).then((r) => r.json());
  try {
    const seen = async () => (await h.rows("SELECT COUNT(*) AS n FROM casino_notice_seen WHERE userId='c'"))[0].n;
    for (let i = 0; i < 3; i++) assert.equal((await get("")).me.notice, null);
    assert.equal(await seen(), 0, "a poll is a read");
    const first = await get("?notice=1");
    assert.equal(first.me.notice.id, "rl_intro");
    assert.match(first.me.notice.text, /no cash value/);
    assert.equal(await seen(), 1);
    assert.equal((await get("?notice=1")).me.notice, null, "once per account");
  } finally {
    srv.close();
  }
  const read = (f) => fs.readFileSync(path.join(h.repo, f), "utf8");
  const en = JSON.parse(read("locales/en.json"));
  assert.match(en["js.casino.rl_intro"], /no cash value/);
  const page = read("public/js/casinorl.js"),
    dock = read("public/js/casinorl-dock.js");
  assert.doesNotMatch(page, /CZ\.note\(\s*me\.notice\s*\)/, 'the notice object would read "[object Object]"');
  assert.match(page, /CZ\.note\(\s*T\(\s*"rl_intro"/);
  assert.match(page, /startTable\(render, \{ first: CZ\.signed \? "\?notice=1"/);
  assert.match(dock, /\?notice=1/);
  assert.match(dock, /T\(\s*"rl_intro"/, "the Dock shows the notice it asked for");
  assert.match(read("public/js/casino-ui.js"), /function startTable\(render, opts\)/);
});

const viaRoom = { via: "room", game: "roulette" };
test("SUITES-2 / ENGINE-4: a queued line is refused now when its limits, its balance or a closing room wheel say so", async () => {
  const T = await room();
  expect(await act(T, "a", "bet", "red 100", viaRoom));
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  const over = await act(T, "b", "bet", "17 9000", viaRoom);
  assert.equal(over.ok, false);
  assert.match(over.reply, /limit on 17 is 5,000/);
  await h.sql("UPDATE users SET points_balance=0 WHERE userId='c'");
  const broke = await act(T, "c", "bet", "red 500", viaRoom);
  assert.equal(broke.ok, false);
  assert.match(broke.reply, /enough available PAT/);
  expect(await act(T, "d", "bet", "black 200", viaRoom));
  assert.ok(T.eng.pending.d);
  assert.equal(T.eng.pending.b, undefined);
  assert.equal(T.eng.pending.c, undefined);
});

test("SUITES-2 / MONEY-9: a queued line refused when betting opens, or dropped by a close, is told privately (page, Dock, Pepe's PM)", async () => {
  const path = require("node:path");
  const T = await room();
  const start = await total();
  let k = 0;
  // a Camfrog room player as POST /api/casino/bot/act makes them (actor.room = the room they typed in)
  const say = (uid, verb, line) =>
    svc.act({ ...h.actor(uid, "room"), room: "pad-a" }, verb, line == null ? [] : [line], { table: T.id, room: "pad-a", game: "roulette" }, "rl-say-" + ++k);
  expect(await say("a", "bet", "red 100"));
  await tick(25000);
  expect(await say("b", "bet", "black 400"));
  await h.sql("UPDATE users SET points_balance=100 WHERE userId='b'");      // spent meanwhile
  await tick(8000);
  await tick(5000);
  assert.equal(T.eng.phase, "idle");
  assert.equal(T.eng.pending.b, undefined);
  const note = (await svc.meView(T, "b")).private_note;
  assert.match(note, /^Your queued line \(black 400\) wasn't placed: The stake could not be charged/);
  // Pepe: the poll's private_mtt carries it as a notice for b's Camfrog name in b's room (POST /api/casino/bot/poll)
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  require(path.join(h.repo, "casino", "routes")).register(app, { isBotToken: () => true, addUser: (q, r, n) => n() });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  const poll = (games) =>
    fetch("http://127.0.0.1:" + srv.address().port + "/api/casino/bot/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "x", after: -1, wait: 0, rooms: [{ id: "pad-a", name: "pad-a" }], games }),
    }).then((r) => r.json());
  try {
    const j = await poll(["roulette"]);
    const pm = j.private_mtt.filter((p) => p.camfrog === "Frogb");
    assert.equal(pm.length, 1);
    assert.equal(pm[0].kind, "notice");
    assert.equal(pm[0].room, "pad-a");
    assert.match(pm[0].text, /black 400/);
    assert.match(pm[0].key, new RegExp("^rl:" + T.id + ":"));
    assert.equal((await poll(undefined)).private_mtt.filter((p) => p.camfrog === "Frogb").length, 0, "only a roulette-aware Pepe");
    // a line queued before the host's end mid-spin: the close tells it
    await h.sql("UPDATE users SET points_balance=500000 WHERE userId='b'");
    expect(await say("a", "bet", "red 100"));
    await tick(25000);
    expect(await say("c", "bet", "black 100"));
    expect(await say("a", "end", null));
    await tick(8000);
    await tick(5000);
    assert.equal(T.status, "closed");
    assert.match((await svc.meView(T, "c")).private_note, /\(black 100\) wasn't placed: the wheel closed/);
    assert.equal((await poll(["roulette"])).private_mtt.filter((p) => p.camfrog === "Frogc").length, 1);
  } finally {
    srv.close();
  }
  assert.equal(await total(), start, "conserved (b's balance is back where the test set it from)");
});

test("ENGINE-4: the lobby's rotation carries a line queued in its last spin to the fresh lobby, and names it for the page", async () => {
  const L = h.lobby();
  const start = await total();
  expect(await act(L, "a", "bet", "red 100"));
  await tick(25000);
  h.move(86400000);
  const q = expect(await act(L, "b", "bet", "black 200"));
  assert.match(q.reply, /Queued for the next spin/);
  await tick(1000);
  await tick(5000);
  const N = h.lobby();
  assert.ok(N && N.id !== L.id);
  assert.equal(L.status, "closed");
  assert.equal(svc.publicView(L).next_table, N.id);
  assert.ok(N.eng.pending.b);
  await tick(250);
  assert.equal(N.escrowed.b, 200, "charged when the fresh lobby's window opens");
  assert.equal(N.eng.phase, "betting");
  assert.equal(await total(), start);
  const ui = require("node:fs").readFileSync(require("node:path").join(h.repo, "public/js/casinorl.js"), "utf8");
  assert.match(ui, /location\.replace\("\/casino\/roulette\/t\/" \+ t\.next_table\)/);
});

test("ENGINE-5: a full room wheel says it closes after this spin; its closed line says why", async () => {
  for (let i = 0; i < 35; i++)
    await h.sql("INSERT OR IGNORE INTO users (userId,username,displayname,camfrogUsername,points_balance) VALUES (?,?,?,?,500000)", [
      "full" + i,
      "fulluser" + i,
      "Full" + i,
      "FullFrog" + i,
    ]);
  const T = await room();
  for (let i = 0; i < 29; i++) expect(await act(T, "full" + i, "bet", "red 100"));
  await tick(25000);
  await tick(8000);
  await tick(5000);
  for (let i = 29; i < 34; i++) expect(await act(T, "full" + i, "bet", "red 100"));
  const refused = await act(T, "full34", "bet", "red 100");
  assert.equal(refused.ok, false);
  assert.match(refused.reply, /closes after this spin, then !rl start opens a new one/);
  await tick(25000);
  await tick(8000);
  const queued = await act(T, "full0", "bet", "red 100");
  assert.equal(queued.ok, false, "a full room wheel queues nothing for a spin it won't have");
  await tick(5000);
  assert.equal(T.status, "closed");
  assert.match(T.log.at(-1).text, /it reached 35 players/);
  await h.sql("DELETE FROM users WHERE userId LIKE 'full%'");
});

test("MONEY-3 / MONEY-4 / SECURITY-5: a bank refusal offers only an amount that is then taken; limits rounds the bank's headroom", async () => {
  const T = await room();
  expect(await act(T, "a", "bet", "17 5000"));          // pocket 17 owes 175,000
  await svc.setSetting("rl_spin_cap", 200000);
  const lim = await act(T, "b", "limits");
  assert.match(lim.reply, /straight up to 700,/, "(200,000 - 175,000) / 35 = 714, rounded down to the 100 minimum");
  const r1 = await act(T, "b", "bet", "17 5000");
  assert.match(r1.reply, /at most 700 more on 17/);
  expect(await act(T, "b", "bet", "17 700"));
  await svc.setSetting("rl_spin_cap", 100000);           // the bank shrinks below the book's worst pocket
  const r2 = await act(T, "c", "bet", "red 100");
  assert.equal(r2.ok, false);
  assert.match(r2.reply, /can't take more on red/, "no offer the limits or the bank would refuse");
  const r3 = await act(T, "c", "bet", "17 100");
  assert.match(r3.reply, /can't take more on 17/);
});

test("MONEY-5: an amount too large to hold is refused as too large, not as below the minimum", () => {
  const grammar = require("../casino/rlbets");
  for (const line of ["17 9007199254740993", "17 999999999999b", "red 99999999999999999"]) {
    const r = grammar.parse(line, { minBet: 100, maxPairs: 6 });
    assert.equal(r.ok, false);
    assert.equal(r.error, "Amount too large.", line);
  }
  assert.match(grammar.parse("17 50", { minBet: 100 }).error, /minimum is 100/);
  assert.equal(grammar.parse("17-19 100").hint, "Splits on 17: 14-17, 16-17, 17-18, 17-20.", "SUITES-9: in order");
});

test("MONEY-6 / SECURITY-4 / ENGINE-7: one failed lobby creation at boot or in a tick never takes the casino down", async () => {
  svc.stop();
  await h.sql("UPDATE casino_tables SET status='closed'");
  await h.sql("CREATE TRIGGER rl_lobby_fail BEFORE INSERT ON casino_rounds BEGIN SELECT RAISE(ABORT, 'database is locked'); END");
  try {
    await svc.boot({ tick: false });
    await svc.tickOnce();
  } finally {
    await h.sql("DROP TRIGGER rl_lobby_fail");
  }
  await svc.boot({ tick: false });
  await svc.tickOnce();
  assert.ok(h.lobby(), "the next tick opened the lobby");
  expect(await act(null, "b", "start", null, { room: "pad-z", via: "room", game: "roulette" }));
});

test("MONEY-8: one player's failing reward write doesn't skip the next players' rewards", async () => {
  const T = await room();
  expect(await act(T, "d", "bet", "red 100"));
  await tick(25000);
  await tick(8000);
  await tick(5000);
  await h.sql("CREATE TRIGGER rl_rw_fail BEFORE INSERT ON casino_ach_counts WHEN NEW.userId = 'b' BEGIN SELECT RAISE(ABORT, 'busy'); END");
  try {
    for (const u of ["a", "b", "c"]) expect(await act(T, u, "bet", "red 100"));
    await tick(25000);
    await tick(8000);
  } finally {
    await h.sql("DROP TRIGGER rl_rw_fail");
  }
  const n = async (uid) => (await h.rows("SELECT n FROM casino_ach_counts WHERE userId=? AND metric='rl_spins'", [uid]))[0]?.n || 0;
  assert.equal(await n("a"), 1);
  assert.equal(await n("c"), 1);
});

test("ENGINE-6: a web-only lobby spin writes no event rows and never wakes Pepe's long-poll", async () => {
  const L = h.lobby();
  const before = (await h.rows("SELECT COUNT(*) AS n FROM casino_events"))[0].n;
  let woke = 0;
  const w = () => { woke++; svc.S.waiters.add(w); };
  svc.S.waiters.add(w);
  try {
    for (const u of ["a", "b"]) expect(await act(L, u, "bet", "red 100"));
    await tick(25000);
    await tick(8000);
    await tick(5000);
  } finally {
    svc.S.waiters.delete(w);
  }
  assert.equal(L.last_round.round_no, 1);
  assert.equal(woke, 0);
  assert.equal((await h.rows("SELECT COUNT(*) AS n FROM casino_events"))[0].n, before);
  const R = await room();
  const w2 = () => { woke++; };
  svc.S.waiters.add(w2);
  expect(await act(R, "a", "bet", "red 100"));
  assert.ok(woke > 0, "a room wheel still wakes him");
});

test("FAIR-5: a proof whose paid result differs from the rebuilt pocket is not verified (server and page)", async () => {
  const fair = h.fair;
  const seed = fair.newServerSeed(),
    client = fair.newClientSeed(),
    p = fair.spinPocket(seed, client, 1);
  const rec = { server_seed: seed, commitment: fair.commitment(seed), client_seed: client, round: 1, shoe: { pocket: p, pockets: 37 } };
  assert.equal(fair.verifySpin({ ...rec, results: { number: p } }).ok, true);
  assert.equal(fair.verifySpin({ ...rec, results: null }).ok, true, "a closed wheel's unused seed has no result");
  assert.equal(fair.verifySpin({ ...rec, results: { number: (p + 1) % 37 } }).ok, false);
  const page = require("node:fs").readFileSync(require("node:path").join(h.repo, "views", "casino-fair.ejs"), "utf8");
  assert.match(page, /spin === j\.shoe\.pocket && \(j\.results == null \|\| j\.results\.number === spin\)/);
  assert.match(page, /t\('casino\.fair\.rl_result'\)/);
});

test("SECURITY-3 / SECURITY-7: a staff-only wheel's proofs and history answer only staff; the pad lookup is rate-limited", async () => {
  const path = require("node:path");
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use((q, r, next) => { const id = q.get("x-user"); q.user = id ? { userId: id, username: "player" + id } : null; next(); });
  require(path.join(h.repo, "casino", "routes")).register(app, { isBotToken: () => false, addUser: (q, r, n) => n() });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  const get = (p, user) => fetch("http://127.0.0.1:" + srv.address().port + p, { headers: user ? { "x-user": user } : {} }).then((r) => r.status);
  try {
    const W = await room();
    expect(await act(W, "c", "bet", "red 300"));
    await tick(25000);
    await tick(8000);
    await svc.setSetting("casino_roulette", "staff");
    assert.equal(await get("/api/casino/fair/" + W.id + "/1"), 404);
    assert.equal(await get("/api/casino/fair/" + W.id + "/1", "b"), 404);
    assert.equal(await get("/api/casino/fair/" + W.id + "/1", "a"), 200, "staff (a)");
    svc.S.tables.delete(W.id);
    assert.equal(await get("/api/casino/t/" + W.id + "/history"), 404, "out of memory, still a wheel");
    assert.equal(await get("/api/casino/t/" + W.id + "/history", "a"), 200);
    await svc.setSetting("casino_roulette", "off");
    assert.equal(await get("/api/casino/fair/" + W.id + "/1"), 200, "switched off, past spins stay verifiable");
    await svc.setSetting("casino_roulette", "everyone");
    const codes = [];
    for (let i = 0; i < 40; i++) codes.push(await get("/api/casino/roulette/pad/no-such-pad-" + i, "d"));
    assert.ok(codes.slice(0, 30).every((c) => c === 200), "30 in 10 s pass (the Dock's 2 s poll and its refreshes)");
    assert.ok(codes.slice(30).every((c) => c === 429));
  } finally {
    srv.close();
  }
});

test("UI-10 / SUITES-3: switched off mid-window, the riding player keeps the view through the landing; others get 404; staff mode as before", async () => {
  const path = require("node:path");
  const express = require(path.join(h.repo, "node_modules", "express"));
  const app = express();
  app.use(express.json());
  app.use((q, r, next) => { const id = q.get("x-user"); q.user = id ? { userId: id, username: "player" + id } : null; next(); });
  require(path.join(h.repo, "casino", "routes")).register(app, { isBotToken: () => false, addUser: (q, r, n) => n() });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  const get = (id, user) => fetch("http://127.0.0.1:" + srv.address().port + "/api/casino/t/" + id, { headers: { "x-user": user } });
  try {
    const T = await room();
    expect(await act(T, "b", "bet", "red 300 black 300"));
    await svc.setSetting("casino_roulette", "staff");
    assert.equal((await get(T.id, "b")).status, 404, "staff mode: the gate refuses b (brief G)");
    await svc.setSetting("casino_roulette", "off");
    assert.equal((await get(T.id, "b")).status, 200, "off: b's 600 PAT still ride");
    assert.equal((await get(T.id, "c")).status, 404);
    const bet = await act(T, "b", "bet", "red 100");
    assert.equal(bet.ok, false, "read-only: no new bet");
    await tick(25000);
    await tick(8000);
    assert.equal(T.eng.phase, "result");
    const r = await get(T.id, "b");
    assert.equal(r.status, 200);
    assert.equal(typeof (await r.json()).me.net, "number", "b sees the landing and the net");
    await tick(5000);
    assert.equal(T.status, "closed");
  } finally {
    srv.close();
  }
});

test("SUITES-5: the lobby's host reads Pepe; last_activity moves on a charge and a landing; the seed column stays NULL until the reveal; end in every phase", async () => {
  const L = h.lobby();
  assert.equal(svc.publicView(L).host, "Pepe");
  assert.equal((await svc.meView(L, "a")).host, false, "nobody hosts the lobby");
  const T = await room();
  const seedCol = async (n) => (await h.rows("SELECT server_seed, revealed FROM casino_rounds WHERE table_id=? AND round_no=?", [T.id, n]))[0];
  assert.deepEqual(await seedCol(1), { server_seed: null, revealed: null }, "the column, not just fairRecord, holds no seed before the reveal");
  h.move(1000);
  const t0 = T.last_activity;
  expect(await act(T, "b", "bet", "red 100"));
  assert.ok(T.last_activity > t0, "a charged line");
  await tick(25000);
  assert.equal((await seedCol(1)).server_seed, null, "spinning: still no seed");
  const t1 = T.last_activity;
  await tick(8000);
  assert.ok(T.last_activity > t1, "a landed spin");
  assert.equal((await seedCol(1)).server_seed, T.round.seed);
  // end: idle (closes now) / betting (refunds, closes) / spinning and result (closes after the spin)
  const idle = await room("pad-i");
  expect(await act(idle, "a", "end"));
  assert.equal(idle.status, "closed");
  const betting = await room("pad-j");
  expect(await act(betting, "c", "bet", "red 100"));
  expect(await act(betting, "a", "end"));
  assert.equal(betting.status, "closed");
  assert.equal(await cash("c"), 500000, "refunded");
  const spinning = await room("pad-k");
  expect(await act(spinning, "c", "bet", "red 100"));
  await tick(25000);
  assert.equal(spinning.eng.phase, "spinning");
  assert.match(expect(await act(spinning, "a", "end")).reply, /after this spin/);
  await tick(8000);
  assert.equal(spinning.eng.phase, "result");
  assert.match(expect(await act(spinning, "a", "end")).reply, /after this spin/);
  await tick(5000);
  assert.equal(spinning.status, "closed");
});

test("SUITES-5: blackjack rounds still verify through the fair record next to roulette", async () => {
  await svc.setSetting("bj_enabled", "1");
  const W = await room();
  expect(await act(W, "b", "bet", "red 100"));
  await tick(25000);
  await tick(8000);
  assert.equal((await svc.fairRecord(W.id, 1)).verified, true);
  const out = expect(await act(null, "c", "start", null, { room: "pad-bj", via: "room", game: "bj" }));
  const B = svc.getTable(out.table);
  assert.equal(B.game, "bj");
  expect(await svc.act(h.actor("c", "room"), "bet", ["100"], { table: B.id, room: "pad-bj", game: "bj" }, "rl-bj-bet-1"));
  for (let i = 0; i < 12 && !B.last_round; i++) {
    const cur = B.turn && B.turn.uid;
    if (cur) await svc.act(h.actor(cur, "room"), "stand", [], { table: B.id, room: "pad-bj", game: "bj" }, "rl-bj-stand-" + i);
    await tick(31000);
  }
  assert.ok(B.last_round, "the blackjack round finished");
  const rec = await svc.fairRecord(B.id, B.last_round.round_no || 1);
  assert.equal(rec.game, "bj");
  assert.equal(rec.verified, true);
});

test("FAIR-3: a line queued during a spin is accepted after its spin is committed and shown; a close reveals that unused commitment", async () => {
  const T = await room();
  expect(await act(T, "b", "bet", "red 100"));
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  const committed = (await h.rows("SELECT commitment FROM casino_rounds WHERE table_id=? AND round_no=2", [T.id]))[0];
  assert.ok(committed, "spin 2 is committed at spin 1's draw");
  assert.equal(svc.publicView(T).next_commitment, committed.commitment);
  assert.equal(svc.publicView(T).next_round, 2);
  assert.equal((await svc.fairRecord(T.id, 2)).server_seed, null);
  const q = expect(await act(T, "c", "bet", "black 100"));
  assert.ok(q.reply.includes("spin 2 committed " + committed.commitment.slice(0, 12)), q.reply);
  await tick(8000);
  await tick(5000);
  assert.equal(T.round.no, 2);
  assert.equal(T.round.commitment, committed.commitment, "spin 2 plays the commitment shown");
  assert.ok(T.eng.book.some((l) => l.uid === "c"));
  // the host ends it mid-spin: spin 3, committed at spin 2's draw, closes unused and revealed
  await tick(25000);
  expect(await act(T, "a", "end"));
  await tick(8000);
  await tick(5000);
  assert.equal(T.status, "closed");
  const r3 = await svc.fairRecord(T.id, 3);
  assert.ok(r3.server_seed, "the unused commitment is revealed at the close");
  assert.equal(r3.verified, true);
  assert.equal(r3.results, null);
});
