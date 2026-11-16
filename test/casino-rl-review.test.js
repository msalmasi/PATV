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
  assert.doesNotMatch(out.reply, /17 5000/);
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
