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
