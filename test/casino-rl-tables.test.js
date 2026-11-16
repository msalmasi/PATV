"use strict";
// roulette2 WP3 (decisions D1-D7, contracts 2-4): web-opened wheels (normal and 💎 High Roller), the High Roller gate on live,
// queued and rebet lines, ONE House budget across every wheel and tier (admission and removal), the per-spin limit snapshot, the
// felt's chips with incognito seats masked, the refusal codes, Host Tools on a web wheel and the casino lobby's wheel rows.
// Invented accounts a..d only.
const test = require("node:test"),
  assert = require("node:assert/strict");
const path = require("node:path");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, rows, act, cash, total, room, lobby, tick, expect, actor, repo } = h;
const RLCFG = require("../casino/roulette");
const engine = require("../casino/rlengine");
test.before(h.initialize);
test.beforeEach(async () => {
  await h.fresh();
  await sql("DELETE FROM user_roles");
});
test.after(() => svc.stop());

let n = 0;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
// a web player's open (POST /api/casino/open calls exactly this) and a Camfrog room player's "!rl start [hr]"
const openWeb = (uid, hr) => svc.act(actor(uid), "start", hr ? ["hr"] : [], { room: null, game: "roulette" }, "open-" + uid + "-" + ++n);
const openRoom = (uid, roomId, words = []) =>
  svc.act({ ...actor(uid, "room"), room: roomId }, "start", words, { room: roomId, game: "roulette" }, "start-" + uid + "-" + ++n);
const highRoller = (uid) => sql("INSERT OR IGNORE INTO user_roles (userId, role) VALUES (?, 'High Roller')", [uid]);
const notHighRoller = (uid) => sql("DELETE FROM user_roles WHERE userId = ?", [uid]);
const wheels = () => [...svc.S.tables.values()].filter((t) => t.game === "roulette" && t.status === "open");
const exposure = (t) => (t.eng.book.length ? Math.max(0, engine.worst(engine.lossVector(t.eng.book))) : 0);
async function budget() {
  const house = await require("../casino/money").houseBalance();
  return svc.RL.bankRoom(wheels()[0], house, wheels()).budget;
}
// D2's bank invariant over every open wheel
async function invariant(what) {
  const all = sum(wheels().map(exposure)),
    hr = sum(wheels().filter((t) => t.high_stakes).map(exposure));
  assert.ok(all <= (await budget()), what + ": every wheel's worst pocket " + all + " fits the one House budget " + (await budget()));
  assert.ok(hr <= svc.S.settings.rl_hr_spin_cap, what + ": the High Roller wheels' " + hr + " fit their share " + svc.S.settings.rl_hr_spin_cap);
}
async function server(t, bot = false) {
  const express = require("express"),
    app = express();
  app.use(express.json());
  const addUser = (q, r, next) => {
    const id = q.get("x-test-user");
    q.user = id ? { userId: id, username: "player" + id } : null;
    next();
  };
  require("../casino/routes").register(app, { isBotToken: (x) => bot && x === "localtest", addUser });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((ok) => srv.once("listening", ok));
  t.after(() => srv.close());
  return async (p, user, b) => {
    const r = await fetch("http://127.0.0.1:" + srv.address().port + p, {
      method: b ? "POST" : "GET",
      redirect: "manual",
      headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", "x-test-user": user || "" },
      body: b ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test("D1: a web player opens their own wheel - one per host, hosted, quiet for Pepe, normal limits, the lobby stays", async (t) => {
  const api = await server(t);
  const L = lobby();
  const r = await api("/api/casino/open", "a", { game: "roulette", idem: "open-wheel-1" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  const W = svc.getTable(r.body.table);
  assert.ok(W && W.game === "roulette" && W.status === "open");
  assert.equal(W.lobby, false);
  assert.equal(W.web, true);
  assert.equal(W.room, null);
  assert.equal(W.host.uid, "a");
  assert.equal(lobby(), L, "the always-on lobby wheel stays");
  const v = svc.publicView(W);
  assert.equal(v.host, "Playera");
  assert.equal(v.tier, "main");
  assert.equal(v.high_stakes, false);
  assert.equal(v.slot, null);
  assert.equal(v.theme, "classic");
  assert.equal(v.min_bet, 100);
  assert.equal(v.max_bet, 100000);
  assert.equal(v.max_seats, 30);
  assert.deepEqual(v.rules.caps, { straight: 5000, split: 10000, street: 15000, corner: 20000, line: 30000, outside: 50000 });
  assert.equal(v.rules.kinds.trio, "street");
  assert.equal(v.rules.kinds.first_four, "corner");
  for (const k of ["dozen", "column", "red", "black", "odd", "even", "low", "high"]) assert.equal(v.rules.kinds[k], "outside");
  assert.equal(v.rules.max_people, 35);
  assert.equal(svc.publicView(L).slot, "main");
  // quiet for Pepe until it plays in a room: its "opened" line is in its own log only (no casino_events row, nothing for his poll)
  assert.equal((await rows("SELECT COUNT(*) AS n FROM casino_events WHERE table_id=?", [W.id]))[0].n, 0);
  assert.match(W.log[0].text, /opened a roulette wheel — .*bets from 100 PAT, up to 100,000 PAT per player a spin\. Play on the web: /);
  // the opener is its host: me.host, and Host Tools' close
  assert.equal((await svc.meView(W, "a")).host, true);
  assert.equal((await svc.meView(W, "b")).host, false);
  // at most ONE open web wheel per host (the answer names it, so the page can go there)
  const again = await api("/api/casino/open", "a", { game: "roulette", idem: "open-wheel-2" });
  assert.equal(again.status, 409);
  assert.match(again.body.reply, /already have a roulette wheel open/);
  assert.equal(again.body.table, W.id);
  // the same idempotency key replays the first answer
  assert.equal((await api("/api/casino/open", "a", { game: "roulette", idem: "open-wheel-1" })).body.table, W.id);
  // a room wheel isn't a web wheel: the same host may run one in a room as well
  expect(await openRoom("a", "pad-a"));
  // others open their own; max_tables counts web wheels like any table
  expect(await openWeb("b"));
  await svc.setSetting("max_tables", 3);
  assert.match((await openWeb("c")).reply, /tables open already/);
  await svc.setSetting("max_tables", 0);
  // its host closes it; then they can open another
  svc.S.rate.clear();
  expect(await act(W, "a", "end"));
  assert.equal(W.status, "closed");
  expect(await openWeb("a"));
  // signed out: no wheel
  assert.equal((await api("/api/casino/open", null, { game: "roulette", idem: "open-wheel-3" })).status, 401);
  // switched off: none either
  await svc.setSetting("casino_roulette", "off");
  assert.equal((await api("/api/casino/open", "d", { game: "roulette", idem: "open-wheel-4" })).status, 409);
});

test("D1/D2: a 💎 High Roller wheel - opened by High Rollers only (web and !rl start hr), its own limits, anyone watches", async (t) => {
  const api = await server(t, true);
  const no = await api("/api/casino/open", "c", { game: "roulette", hr: true, idem: "open-hr-1" });
  assert.equal(no.status, 409);
  assert.match(no.body.reply, /High Roller tables are for High Rollers/);
  await highRoller("b");
  const ok = await api("/api/casino/open", "b", { game: "roulette", hr: true, idem: "open-hr-2" });
  assert.equal(ok.status, 200);
  const H = svc.getTable(ok.body.table);
  assert.equal(H.high_stakes, true);
  const v = svc.publicView(H);
  assert.equal(v.tier, "hr");
  assert.equal(v.high_stakes, true);
  assert.equal(v.min_bet, 1000);
  assert.equal(v.max_bet, 500000);
  assert.deepEqual(v.rules.caps, { straight: 25000, split: 50000, street: 75000, corner: 100000, line: 150000, outside: 250000 });
  assert.equal(v.limits.rl_min_bet, 1000, "the placard's rl_* map is the wheel's own");
  assert.equal(v.limits.rl_max_spin, 500000);
  assert.match(H.log[0].text, /💎 High Roller roulette wheel — .*bets from 1,000 PAT, up to 500,000 PAT per player a spin \(High Rollers only; anyone can watch\)/);
  // anyone may watch: the table view answers a non-High Roller and a signed-out viewer
  const watch = await api("/api/casino/t/" + H.id, "c");
  assert.equal(watch.status, 200);
  assert.equal(watch.body.table.high_stakes, true);
  assert.equal(watch.body.me.high_roller, false);
  assert.equal((await api("/api/casino/t/" + H.id, "b")).body.me.high_roller, true);
  assert.equal((await api("/api/casino/t/" + H.id, null)).status, 200);
  // chat: "!rl start hr" (Pepe sends up to two words after start) - High Rollers only; another word is refused
  const bot = (uid, verb, args, roomId) =>
    api("/api/casino/bot/act", null, { password: "localtest", username: "player" + uid, room: roomId, game: "roulette", verb, args, idem: "bot-start-" + uid + "-" + ++n });
  assert.match((await bot("c", "start", ["hr"], "pad-h")).body.reply, /High Roller tables are for High Rollers/);
  assert.match((await bot("b", "start", ["saloon"], "pad-h")).body.reply, /usage: !rl start/);
  assert.equal((await bot("b", "start", ["hr", "x"], "pad-h")).status, 200, "two words after start pass the route");
  assert.equal((await bot("b", "bet", ["red", "100"], "pad-h")).status, 400, "a bet is still one line");
  const R = await bot("b", "start", ["hr"], "pad-h");
  assert.equal(R.body.ok, true);
  const RH = svc.getTable(R.body.table);
  assert.equal(RH.high_stakes, true);
  assert.equal(RH.web, false);
  assert.deepEqual(svc.roomsOf(RH), ["pad-h"]);
  // the room wheel's opened line is in the room (casino_events), naming the tier
  const opened = JSON.parse((await rows("SELECT data FROM casino_events WHERE table_id=? AND kind='opened'", [RH.id]))[0].data);
  assert.match(opened.text, /💎 High Roller roulette wheel/);
  // limits(): the lobby's / pages' figures for both tiers
  const lim = svc.limits().roulette;
  assert.equal(lim.min_bet, 100);
  assert.equal(lim.max_spin, 100000);
  assert.equal(lim.caps.straight, 5000);
  assert.deepEqual(lim.hr, { min_bet: 1000, max_spin: 500000, caps: v.rules.caps, spin_cap: 1000000 });
});

test("D1: the High Roller gate covers live, queued and rebet lines (E_HR); the role can lapse between spins", async () => {
  await highRoller("b");
  const H = svc.getTable(expect(await openWeb("b", true)).table);
  const live = await act(H, "c", "bet", "red 1000");
  assert.equal(live.ok, false);
  assert.equal(live.code, "E_HR");
  assert.match(live.reply, /only High Rollers can play here/);
  expect(await act(H, "b", "bet", "red 1000"));
  // a bet below the High Roller minimum is refused (the bet grammar takes the wheel's minimum)
  const small = await act(H, "b", "bet", "black 500");
  assert.equal(small.ok, false);
  assert.match(small.reply, /minimum is 1000 whole PAT/);
  expect(await act(H, "b", "go"));
  assert.equal(H.eng.phase, "spinning");
  // queued while it spins: c refused; b queued
  assert.equal((await act(H, "c", "bet", "black 1000")).code, "E_HR");
  expect(await act(H, "b", "bet", "black 1000"));
  assert.ok(H.eng.pending.b);
  // the role lapses: the queued line is refused when betting opens (told privately), and so is a rebet
  await notHighRoller("b");
  await tick(8000);
  const landed = await cash("b");
  await tick(5000);
  assert.equal(H.eng.pending.b, undefined);
  assert.equal(await cash("b"), landed, "nothing charged");
  assert.match((await svc.meView(H, "b")).private_note, /black 1,?000\) wasn't placed: 💎 this is a High Roller table/);
  const rebet = await act(H, "b", "rebet");
  assert.equal(rebet.ok, false);
  assert.equal(rebet.code, "E_HR");
  await highRoller("b");
  expect(await act(H, "b", "rebet"));
  // a normal wheel takes anyone, High Roller or not
  expect(await act(lobby(), "c", "bet", "red 100"));
  expect(await act(lobby(), "b", "bet", "red 100"));
});

test("D2: ONE House budget across every wheel and tier, with the High Roller share - checked at admission AND removal", async () => {
  const start = await total();
  for (const uid of ["b", "d"]) await highRoller(uid);
  // a small High Roller share, so its sub-cap binds before the House budget: 35 x the straight must fit in it
  await svc.setSetting("rl_hr_max_straight", 2000);
  await svc.setSetting("rl_hr_spin_cap", 100000);
  await assert.rejects(svc.setSetting("rl_hr_max_straight", 3000), /35 times the straight limit/);
  const L = lobby(),
    H = svc.getTable(expect(await openWeb("b", true)).table),
    H2 = svc.getTable(expect(await openWeb("d", true)).table),
    R = await room("pad-r");
  expect(await act(H, "b", "bet", "17 2000"));
  assert.equal(exposure(H), 70000);
  await invariant("High Roller wheel 1");
  // a second High Roller wheel: the House budget has room, the High Roller share has 30,000 left - refused
  const second = await act(H2, "d", "bet", "20 2000");
  assert.equal(second.ok, false);
  assert.equal(second.code, "E_BANK");
  assert.match(second.reply, /🏦 The wheel can/);
  assert.equal(exposure(H2), 0);
  await invariant("High Roller share binds");
  // a normal wheel is not held to the High Roller share
  expect(await act(L, "a", "bet", "5 5000"));
  assert.equal(exposure(L), 175000);
  await invariant("the lobby");
  expect(await act(R, "c", "bet", "9 100"));
  expect(await act(R, "d", "bet", "10 100"));
  assert.equal(exposure(R), 3400);
  await invariant("a room wheel");
  // the House budget binds across tiers: exactly what the books need now, then a removal that would raise R's worst is refused
  await svc.setSetting("rl_spin_cap", 70000 + 175000 + 3400);
  await invariant("the budget at its edge");
  const kept = await act(R, "d", "clear");
  assert.equal(kept.ok, false);
  assert.equal(kept.code, "E_BANK");
  assert.match(kept.reply, /it rides/);
  assert.equal(exposure(R), 3400);
  // ... and an admission that raises a worst pocket on any wheel
  assert.equal((await act(L, "c", "bet", "5 100")).code, "E_BANK");
  assert.equal((await act(H, "b", "bet", "17-18 1000")).code, "E_BANK");
  await invariant("refusals");
  // removal on a High Roller wheel against its share: b hedges, the share drops to the book, b's undo would raise it again
  await svc.setSetting("rl_spin_cap", 2000000);
  expect(await act(H, "b", "bet", "18 2000"));
  assert.equal(exposure(H), 68000);
  await svc.setSetting("rl_hr_max_straight", 1900); // (H keeps 2,000 this spin - D3)
  await svc.setSetting("rl_hr_spin_cap", 68000);
  await invariant("the High Roller share at its edge");
  const undo = await act(H, "b", "undo");
  assert.equal(undo.ok, false);
  assert.equal(undo.code, "E_BANK");
  assert.equal(exposure(H), 68000);
  await invariant("High Roller removal refused");
  // a removal that lowers the worst is fine anywhere
  await svc.setSetting("rl_spin_cap", 2000000);
  await svc.setSetting("rl_hr_spin_cap", 1000000);
  expect(await act(L, "a", "undo"));
  await invariant("a removal");
  // every spin lands and pays; PAT is conserved
  await tick(25000);
  await tick(8000);
  await tick(5000);
  assert.equal(await total(), start);
});

test("D3: each spin takes the limits it opened with; an edit applies from the next spin (and an idle wheel follows it); D6 12 s", async () => {
  const R = await room("pad-s");
  assert.equal(svc.RL.limOf(R).caps.straight, 5000);
  await svc.setSetting("rl_max_straight", 1000);
  assert.equal(svc.publicView(R).rules.caps.straight, 1000, "no betting window open: the wheel follows the setting");
  await svc.setSetting("rl_max_straight", 5000);
  expect(await act(R, "a", "bet", "red 100"));
  await svc.setSetting("rl_max_straight", 1000);
  // the open spin keeps 5,000 - the checks, the view and the placard map alike
  expect(await act(R, "c", "bet", "17 2000"));
  assert.equal(svc.publicView(R).rules.caps.straight, 5000);
  assert.equal(svc.publicView(R).limits.rl_max_straight, 5000);
  assert.equal(JSON.parse((await rows("SELECT state FROM casino_tables WHERE id=?", [R.id]))[0].state).lim.caps.straight, 5000, "saved with the wheel");
  await tick(25000);
  assert.equal(R.eng.phase, "spinning");
  expect(await act(R, "c", "bet", "17 3000")); // queued: checked against this spin's limits now...
  await tick(8000);
  await tick(5000);
  // ...and against the next spin's own when betting opens: refused then, told privately
  assert.equal(R.eng.pending.c, undefined);
  assert.match((await svc.meView(R, "c")).private_note, /The limit on 17 is 1,000 PAT/);
  assert.equal(svc.RL.limOf(R).caps.straight, 1000);
  const capped = await act(R, "c", "bet", "17 2000");
  assert.equal(capped.code, "E_CAP");
  assert.deepEqual({ token: capped.token, cap: capped.cap, have: capped.have, min: capped.min }, { token: "17", cap: 1000, have: 0, min: 100 });
  assert.match(capped.reply, /^The limit on 17 is 1,000 PAT, minimum 100\.$/, "the text is as before");
  // the snapshot survives a restart
  expect(await act(R, "c", "bet", "17 600"));
  await svc.setSetting("rl_max_straight", 5000);
  const R2 = await h.restart(R.id);
  assert.equal(svc.RL.limOf(R2).caps.straight, 1000);
  assert.equal((await act(R2, "c", "bet", "17 500")).code, "E_CAP");
  // D6: the default spin is 12 s (bounds 4-20 kept); a draw takes the setting
  assert.equal(RLCFG.DEFAULTS.rl_spin_secs, 12);
  assert.equal(RLCFG.readSettings({}).rl_spin_secs, 12);
  for (const bad of [3, 21]) assert.throws(() => RLCFG.checkSetting("rl_spin_secs", bad));
  for (const good of [4, 20]) assert.equal(RLCFG.checkSetting("rl_spin_secs", good), String(good));
  await svc.setSetting("rl_spin_secs", 12);
  await tick(25000);
  assert.equal(R2.eng.phase, "spinning");
  assert.equal(svc.publicView(R2).spin.secs, 12);
  assert.equal(R2.dl.land - R2.dl.start, 12000);
  // D2: the High Roller settings are checked as a set and fall back as a set
  assert.throws(() => RLCFG.checkSetting("rl_hr_max_straight", 30000, RLCFG.DEFAULTS), /35 times/);
  assert.throws(() => RLCFG.checkSetting("rl_hr_max_outside", 600000, RLCFG.DEFAULTS), /High Roller position limits/);
  assert.throws(() => RLCFG.checkSetting("rl_hr_min_bet", 30000, RLCFG.DEFAULTS), /High Roller position limits/);
  assert.equal(RLCFG.checkSetting("rl_hr_spin_cap", 2000000, RLCFG.DEFAULTS), "2000000");
  const bad = RLCFG.readSettings({ rl_hr_max_straight: "900000", rl_max_straight: "4000" });
  assert.equal(bad.rl_hr_max_straight, 25000);
  assert.equal(bad.rl_max_straight, 4000, "the normal set is checked on its own");
});

test("D5: the felt shows every player's CHARGED chips per position (never a queued line); incognito seats under their label", async () => {
  const R = await room("pad-f");
  h.veil._reset();
  h.veil._hooks.kind = async (keys) => (Array.isArray(keys) && keys.includes("u:b") ? "out" : null);
  expect(await act(R, "a", "bet", "red 500 17 100"));
  expect(await svc.act({ ...actor("b"), veil: "out" }, "bet", ["red 200 d1 300"], { table: R.id }, "veiled-b"));
  const v = svc.publicView(R);
  const felt = Object.fromEntries(v.felt.map((f) => [f.t, f]));
  assert.deepEqual(felt.red, { t: "red", n: 700, k: 2 });
  assert.deepEqual(felt["17"], { t: "17", n: 100, k: 1 });
  assert.deepEqual(felt.d1, { t: "d1", n: 300, k: 1 });
  const sa = v.seats.find((s) => !s.veil),
    sb = v.seats.find((s) => s.veil);
  assert.equal(sa.name, "Playera");
  assert.deepEqual(sa.chips, [["red", 500], ["17", 100]]);
  assert.equal(sa.staked, 600, "a seat's chips add up to its stake");
  assert.deepEqual(sb.chips, [["red", 200], ["d1", 300]]);
  assert.equal(sb.staked, 500);
  assert.notEqual(sb.name, "Playerb");
  assert.match(sb.seat, /^v[0-9a-f]{11}$/, "a masked seat's own id");
  const raw = JSON.stringify(v);
  for (const leak of ["Playerb", "playerb", "Frogb", '"b"', svc.uidHash("b")]) assert.ok(!raw.includes(leak), "no " + leak + " in the view");
  // the viewer's own seat id is the one the seats list shows; what they used this spin
  const me = await svc.meView(R, "b");
  assert.equal(me.seat, sb.seat);
  assert.deepEqual(me.used, { positions: 2, actions: 1, per_token: { red: 200, d1: 300 } });
  assert.equal(me.high_roller, false);
  assert.equal((await svc.meView(R, "c")).seat, null, "not seated");
  // the poll (Pepe's OBS board) gets the same masked view
  const polled = (await svc.poll(0, 0)).tables[R.id];
  assert.ok(!JSON.stringify(polled).includes("Playerb"));
  assert.deepEqual(polled.felt, v.felt);
  // spinning: the frozen set; a line queued now is not on the felt
  await tick(25000);
  expect(await act(R, "c", "bet", "black 900"));
  const spun = svc.publicView(R);
  assert.deepEqual(spun.felt, v.felt);
  const sc = spun.seats.find((s) => s.name === "Playerc");
  assert.deepEqual([sc.chips, sc.staked], [[], 0], "a queued line is private (me.pending)");
  assert.ok(!JSON.stringify([spun.felt, spun.seats, spun.totals, spun.log]).includes("black"));
  // the result: the landed chips stay up with each seat's net
  await tick(8000);
  const res = svc.publicView(R);
  assert.equal(R.eng.phase, "result");
  assert.deepEqual(res.felt, v.felt);
  const ra = res.seats.find((s) => s.name === "Playera");
  assert.equal(ra.staked, 600);
  assert.equal(ra.net, R.eng.net.a);
  assert.equal(typeof res.seats.find((s) => s.veil).net, "number");
  assert.equal(v.seats[0].net, undefined, "net only while the result is up");
  // the next spin opens empty (the queued line is charged then and shows)
  await tick(5000);
  const next = svc.publicView(R);
  assert.deepEqual(next.felt, [{ t: "black", n: 900, k: 1 }]);
});

test("O7: refusals carry a code and numbers (E_CAP, E_POS, E_SPIN, E_ACT, E_BANK); their texts are unchanged", async () => {
  await svc.setSetting("rl_max_positions", 2);
  await svc.setSetting("rl_max_lines", 2);
  await svc.setSetting("rl_max_spin", 60000);
  const R = await room("pad-e");
  const cap = await act(R, "a", "bet", "17 6000");
  assert.deepEqual([cap.code, cap.token, cap.cap, cap.have, cap.min], ["E_CAP", "17", 5000, 0, 100]);
  assert.equal(cap.reply, "The limit on 17 is 5,000 PAT, minimum 100.");
  expect(await act(R, "a", "bet", "17 4000"));
  const more = await act(R, "a", "bet", "17 2000");
  assert.deepEqual([more.code, more.have, more.cap], ["E_CAP", 4000, 5000]);
  const pos = await act(R, "a", "bet", "red 100 black 100");
  assert.deepEqual([pos.code, pos.max], ["E_POS", 2]);
  assert.equal(pos.reply, "That line exceeds your per-spin limit.");
  expect(await act(R, "b", "bet", "red 50000"));
  const spin = await act(R, "b", "bet", "black 20000");
  assert.deepEqual([spin.code, spin.max, spin.have], ["E_SPIN", 60000, 50000]);
  assert.equal(spin.reply, "That line exceeds your per-spin limit.");
  expect(await act(R, "a", "bet", "black 100"));
  const acts = await act(R, "a", "bet", "17 100");
  assert.deepEqual([acts.code, acts.max], ["E_ACT", 2]);
  assert.equal(acts.reply, "You've reached the action limit this spin.");
  assert.equal((await act(R, "a", "undo")).code, "E_ACT");
  await svc.setSetting("rl_spin_cap", 100);
  const bank = await act(R, "c", "bet", "red 100");
  assert.equal(bank.code, "E_BANK");
  assert.equal(typeof bank.more, "number");
  assert.match(bank.reply, /^🏦 The wheel can/);
  // the limits verb (now on the web too) reads the same lim(T)
  await svc.setSetting("rl_spin_cap", 2000000);
  const lim = expect(await act(R, "c", "limits"));
  assert.match(lim.reply, /^Minimum 100 PAT, straight up to [\d,]+, per spin 60,000\.$/);
  assert.equal(lim.max_spin, 60000);
  assert.ok(require("../casino/routes").WEB_VERBS.has("limits"));
});

test("D4: Host Tools on a web wheel - push (up to 6 rooms, not where roulette is off), advertise, stream, close; the lobby isn't pushable", async (t) => {
  const api = await server(t);
  const W = svc.getTable(expect(await openWeb("a")).table);
  const L = lobby();
  svc.noteRooms([
    { id: "pad-p", name: "Pad P", games: { bj: true, holdem: true, roulette: true } },
    { id: "pad-q", name: "Pad Q", games: { bj: true, holdem: true, roulette: false } },
    { id: "pad-r", name: "Pad R" },
    { id: "pad-t", name: "Pad T", games: { roulette: true } },
  ]);
  // the lobby stays on the web (D4)
  assert.match((await api("/api/casino/t/" + L.id + "/push", "a", { room: "pad-p" })).body.reply, /lobby wheel stays on the web/);
  // only its host or an admin moves it
  assert.match((await api("/api/casino/t/" + W.id + "/push", "b", { room: "pad-p" })).body.reply, /host or an admin/);
  // a room whose roulette toggle is off: refused (Pepe would drop every line there); the view greys it
  const tv = await api("/api/casino/t/" + W.id, "a");
  const q = tv.body.rooms.find((r) => r.id === "pad-q");
  assert.equal(q.off, true);
  assert.deepEqual(q.games, { bj: true, holdem: true, roulette: false });
  assert.equal(tv.body.rooms.find((r) => r.id === "pad-p").off, false);
  assert.equal(tv.body.rooms.find((r) => r.id === "pad-r").off, false, "an older Pepe's room (no flags) is as before");
  assert.equal((await api("/api/casino/t/" + W.id + "/push", "a", { room: "pad-q" })).body.reply, "Roulette is off in that room.");
  // pushed: it plays there now (its events reach the room), the view names the room
  const pushed = await api("/api/casino/t/" + W.id + "/push", "a", { room: "pad-p" });
  assert.equal(pushed.body.ok, true);
  assert.deepEqual(svc.roomsOf(W), ["pad-p"]);
  const text = JSON.parse((await rows("SELECT data FROM casino_events WHERE table_id=? AND kind='pushed'", [W.id]))[0].data).text;
  assert.match(text, /^🛞 Playera's roulette wheel is playing in this room now — !rl red 500 to bet \(min 100 PAT a bet, up to 100,000 PAT per player a spin\)/);
  assert.equal(svc.publicView(W).room_name, "Pad P");
  // one open table per room across games: a room wheel's room can't take it
  await room("pad-t");
  assert.match((await api("/api/casino/t/" + W.id + "/push", "a", { room: "pad-t" })).body.reply, /already has a casino table/);
  // an admin may push it too
  await sql("UPDATE users SET class='Admin' WHERE userId='d'");
  assert.equal((await api("/api/casino/t/" + W.id + "/push", "d", { room: "pad-r" })).body.ok, true);
  assert.deepEqual(svc.roomsOf(W), ["pad-p", "pad-r"]);
  // advertise: in the view's adverts; not where roulette is off
  svc.noteRooms([{ id: "pad-u", name: "Pad U", games: { roulette: true } }]);
  assert.equal((await api("/api/casino/t/" + W.id + "/advertise", "a", { room: "pad-q" })).body.reply, "Roulette is off in that room.");
  assert.equal((await api("/api/casino/t/" + W.id + "/advertise", "a", { room: "pad-u" })).body.ok, true);
  assert.deepEqual(svc.publicView(W).adverts, [{ id: "pad-u", name: "Pad U" }]);
  assert.match(JSON.parse((await rows("SELECT data FROM casino_events WHERE table_id=? AND kind='advert'", [W.id]))[0].data).text, /^📣 🛞 Roulette at Playera's wheel/);
  // the bot act route's own note of a room (no flags) keeps the poll's flags
  svc.noteRooms([{ id: "pad-q", name: "Pad Q" }], { keepGames: true });
  assert.equal(svc.freshRooms("roulette").find((r) => r.id === "pad-q").off, true);
  // stream: its host may (not pinned: the 5-minute idle drop applies)
  const s = await api("/api/casino/t/" + W.id + "/stream", "a", { on: true });
  assert.equal(s.body.ok, true);
  assert.equal(svc.S.stream.table, W.id);
  assert.ok(!svc.S.stream.pin);
  svc.S.stream.ts = W.last_activity = h.time();
  await tick(5 * 60 * 1000 + 1000);
  assert.equal(svc.S.stream.table, null, "no spin in 5 minutes: off the stream");
  // back to web-only, then its host closes it
  assert.equal((await api("/api/casino/t/" + W.id + "/push", "a", { room: null })).body.ok, true);
  assert.deepEqual(svc.roomsOf(W), []);
  svc.S.rate.clear();
  expect(await act(W, "a", "end"));
  assert.equal(W.status, "closed");
  assert.match((await act(L, "a", "end")).reply, /lobby wheel stays open/);
});

test("D7: an admin-pinned wheel stays on Pepe's stream past the idle drop; a lobby rotation hands the slot and the pin to its successor", async () => {
  const L = lobby();
  const admin = { ...actor("a"), admin: true };
  const on = expect(await svc.stream(L.id, true, admin, false, true));
  assert.equal(on.pinned, true);
  assert.match(on.reply, /Pinned/);
  assert.equal(svc.S.stream.pin, true);
  await tick(6 * 60 * 1000);
  assert.equal(svc.S.stream.table, L.id, "pinned: no idle drop");
  // across a restart (the slot is saved with the pin)
  const L2 = await h.restart(L.id);
  assert.equal(svc.S.stream.pin, true);
  assert.equal(svc.S.stream.table, L2.id);
  // the lobby rotates (a day): its successor takes the slot, the pin, the house slot - and the old page follows it
  await tick(25 * 3600 * 1000);
  const N = lobby();
  assert.ok(N && N.id !== L2.id);
  assert.equal(L2.status, "closed");
  assert.equal(L2.successor, N.id);
  assert.equal(N.slot, "main");
  assert.equal(svc.S.stream.table, N.id);
  assert.equal(svc.S.stream.pin, true);
  // taken off: the pin goes with it; an admin's {pin: false} is an ordinary place (the idle drop applies)
  expect(await svc.stream(N.id, false, admin, false));
  assert.ok(!svc.S.stream.pin);
  const plain = expect(await svc.stream(N.id, true, admin, false, false));
  assert.equal(plain.pinned, undefined);
  await tick(6 * 60 * 1000);
  assert.equal(svc.S.stream.table, null);
  // a non-admin can't put the lobby up at all (D4)
  assert.equal((await svc.stream(N.id, true, actor("b"), false)).ok, false);
});

test("contract 3: the casino lobby lists every open wheel in the shared row shape, behind the audience gate; home shows busy wheels", async (t) => {
  const api = await server(t);
  await highRoller("b");
  const L = lobby(),
    R = await room("pad-l"),
    H = svc.getTable(expect(await openWeb("b", true)).table);
  expect(await act(R, "a", "bet", "red 300"));
  await tick(25000);
  await tick(8000);
  await tick(5000);
  expect(await act(R, "c", "bet", "17 200"));
  const byId = Object.fromEntries(svc.lobby().map((r) => [r.id, r]));
  for (const T of [L, R, H]) {
    const row = byId[T.id];
    assert.ok(row, "listed");
    for (const k of ["id", "game", "host", "room", "room_name", "rooms", "adverts", "url", "on_stream", "phase", "players", "max_seats", "high_stakes", "theme",
                     "round_no", "min_bet", "max_bet", "max_straight", "lobby", "slot", "deadline", "land_at", "staked", "last"])
      assert.ok(k in row, k);
    assert.equal(row.game, "roulette");
    assert.equal(row.theme, "classic");
  }
  assert.equal(byId[L.id].host, "Pepe");
  assert.equal(byId[L.id].slot, "main");
  assert.equal(byId[R.id].host, "Playera");
  assert.deepEqual(byId[R.id].rooms, [{ id: "pad-l", name: "pad-l" }]);
  assert.equal(byId[R.id].staked, 200);
  assert.equal(byId[R.id].deadline, R.dl.bet);
  assert.deepEqual(byId[R.id].last, [R.eng.history[0].number]);
  assert.equal(byId[H.id].high_stakes, true);
  assert.deepEqual([byId[H.id].min_bet, byId[H.id].max_bet, byId[H.id].max_straight], [1000, 500000, 25000]);
  // Pepe's poll rows (contract 5)
  const pepe = Object.fromEntries(svc.RL.openList().map((r) => [r.id, r]));
  for (const k of ["tier", "high_stakes", "min_bet", "max_straight", "max_spin", "players", "phase", "deadline", "land_at", "rooms", "room_name", "lobby", "slot"])
    assert.ok(k in pepe[H.id], k);
  assert.equal(pepe[H.id].tier, "hr");
  // the route: rows only while roulette is open to this viewer (staff mode: a member gets none, staff do); j.roulette stays
  await svc.setSetting("casino_roulette", "staff");
  const member = (await api("/api/casino/lobby", "c")).body;
  assert.equal(member.tables.filter((x) => x.game === "roulette").length, 0);
  assert.equal(member.roulette.on, false);
  assert.equal((await api("/api/casino/lobby?rl=1", "c")).body.tables.filter((x) => x.game === "roulette").length, 0, "shut: none, asked or not");
  const staff = (await api("/api/casino/lobby?rl=1", "a")).body;
  assert.equal(staff.tables.filter((x) => x.game === "roulette").length, 3);
  assert.equal(staff.roulette.on, true);
  // (review) a page that doesn't ask (today's lobby script draws every row that isn't Hold'em as a Blackjack card): no wheel rows -
  // the wheels are in `roulette` as before
  const older = (await api("/api/casino/lobby", "a")).body;
  assert.equal(older.tables.filter((x) => x.game === "roulette").length, 0);
  assert.equal(older.roulette.on, true);
  assert.ok(older.roulette.wheels.length >= 3);
  assert.equal((await api("/api/casino/bj/lobby?rl=1", "a")).body.tables.filter((x) => x.game === "roulette").length, 3, "the old path alias too");
  assert.ok(staff.roulette.wheels.length >= 3);
  assert.equal(staff.limits.roulette.hr.min_bet, 1000);
  // home (the same box for everyone): only while roulette is open to everyone, only a wheel with people on it
  await svc.setSetting("casino_roulette", "everyone");
  const home = require("../home");
  const st = await home.stats();
  const listed = (st.tables || []).filter((x) => x.game === "Roulette");
  assert.deepEqual(listed.map((x) => x.id), [R.id]);
  assert.equal(listed[0].href, "/casino/roulette/t/" + R.id);
  assert.deepEqual(listed[0].seats.sort(), ["Playera", "Playerc"]);
});

test("D1 (review): a room wheel moved back to the web is its host's web wheel - never a second one, whoever moves it", async (t) => {
  const api = await server(t);
  await sql("UPDATE users SET class='Admin' WHERE userId='d'");
  svc.noteRooms([{ id: "pad-x", name: "Pad X" }, { id: "pad-y", name: "Pad Y" }, { id: "pad-v", name: "Pad V" }]);
  // "!rl start" in a room, then Host Tools' "back to the web": a web open is refused then (it names that wheel)
  const R1 = svc.getTable(expect(await openRoom("a", "pad-x")).table);
  assert.equal(R1.web, false);
  const back = await api("/api/casino/t/" + R1.id + "/push", "a", { room: null });
  assert.equal(back.body.ok, true);
  assert.equal(back.body.reply, "The table is web-only now.");
  assert.equal(R1.web, true, "its host's web wheel from now on");
  const web = await api("/api/casino/open", "a", { game: "roulette", idem: "rv-open-1" });
  assert.equal(web.status, 409);
  assert.match(web.body.reply, /already have a roulette wheel open/);
  assert.equal(web.body.table, R1.id);
  // pushed into a room again it stays their web wheel (as one opened on the web does)
  expect(await svc.push(R1.id, "pad-y", actor("a")));
  assert.equal((await api("/api/casino/open", "a", { game: "roulette", idem: "rv-open-2" })).status, 409);
  // a second room wheel can't go back to the web while the first is there: not "web only", not by removing its last room, not by an admin
  const R2 = svc.getTable(expect(await openRoom("a", "pad-x")).table);
  assert.equal((await svc.push(R2.id, null, actor("a"))).reply, "You already have a roulette wheel on the web — close it first.");
  assert.equal((await svc.push(R2.id, "pad-x", actor("a"), "remove")).reply, "You already have a roulette wheel on the web — close it first.");
  assert.equal((await api("/api/casino/t/" + R2.id + "/push", "d", { room: null })).body.reply, "Its host already has a roulette wheel on the web — close one first.");
  assert.deepEqual(svc.roomsOf(R2), ["pad-x"], "it stays in its room");
  assert.equal(R2.web, false);
  // with two rooms, removing one that isn't its last is fine
  expect(await svc.push(R2.id, "pad-v", actor("a")));
  expect(await svc.push(R2.id, "pad-v", actor("a"), "remove"));
  assert.deepEqual(svc.roomsOf(R2), ["pad-x"]);
  // the first one closed, the second may go back to the web - and is then the one
  svc.S.rate.clear();
  expect(await act(R1, "a", "end"));
  assert.equal(R1.status, "closed");
  expect(await svc.push(R2.id, "pad-x", actor("a"), "remove"));
  assert.equal(R2.web, true);
  assert.equal((await openWeb("a")).ok, false);
  // a wheel on the web with no rooms and no web flag (an older build's room wheel moved back) counts too
  const R3 = svc.getTable(expect(await openRoom("c", "pad-w")).table);
  Object.assign(R3, { rooms: [], room: null, web: false });
  const c = await openWeb("c");
  assert.equal(c.ok, false);
  assert.equal(c.table, R3.id);
  // nobody ends up with two on the web
  for (const uid of ["a", "c"]) assert.equal(wheels().filter((w) => !w.lobby && w.host.uid === uid && (w.web || !svc.roomsOf(w).length)).length, 1, uid);
});

test("(review) the view cache never serves a rolled-back step's view as a later state (svc.viewKey: rev + generation)", async (t) => {
  const api = await server(t);
  const R = await room("pad-k");
  expect(await act(R, "a", "bet", "red 500"));
  // b's bet saves inside its transaction and then throws: a view built in that window shows b's uncharged line under rev N+1
  let inside = null;
  const grab = () => {
    if (!inside) inside = { key: svc.viewKey(R), rev: R.rev, felt: svc.publicView(R).felt };
  };
  svc.S.waiters.add(grab); // (save's wake runs it synchronously, inside the transaction)
  svc.S.hooks.crash = "rl:answer";
  const failed = await act(R, "b", "bet", "17 1000");
  svc.S.hooks.crash = null;
  svc.S.waiters.delete(grab);
  assert.equal(failed.ok, false);
  assert.ok(inside, "a view was built inside the transaction");
  assert.ok(inside.felt.some((f) => f.t === "17"), "it showed b's uncharged line");
  assert.equal(await cash("b"), 500000, "b was never charged");
  assert.equal(R.rev, inside.rev - 1, "rolled back: the rev went back");
  assert.notEqual(svc.viewKey(R), inside.key, "rolled back: never that key");
  // the next real step hands out the same rev again - under another key
  expect(await act(R, "c", "bet", "black 300"));
  assert.equal(R.rev, inside.rev, "the same rev again");
  assert.notEqual(svc.viewKey(R), inside.key, "a rev handed out again is a new key");
  const v = (await api("/api/casino/t/" + R.id, "d")).body.table;
  assert.deepEqual(v.felt.map((f) => f.t).sort(), ["black", "red"], "the charged lines only");
  // Pepe's poll builds its views in one locked step: none is of a step still in its transaction
  const polled = (await svc.poll(-1, 0)).tables[R.id];
  assert.deepEqual(polled.felt.map((f) => f.t).sort(), ["black", "red"]);
});

test("(review) Pepe's poll never draws a step still in its transaction: its views are built under the casino lock", async () => {
  const R = await room("pad-j");
  expect(await act(R, "a", "bet", "red 500"));
  await svc.RL.bankRefresh(R); // (fresh: the poll's own bank refresh answers at once)
  h.move(3000); // (the poll's veil refresh is due: it asks who is incognito - and b's bet starts right then)
  let step = null,
    inTx;
  const saved = new Promise((ok) => (inTx = ok));
  h.veil._hooks.kind = async () => {
    if (!step) {
      step = true;
      svc.S.waiters.add(() => inTx()); // (b's save wakes it, inside the transaction)
      svc.S.hooks.crash = "rl:answer";
      step = act(R, "b", "bet", "17 1000");
      await saved; // the poll goes on while b's bet is saved and not yet committed (it then rolls back)
    }
    return null;
  };
  const polled = (await svc.poll(-1, 0)).tables[R.id];
  const failed = await step;
  svc.S.hooks.crash = null;
  assert.equal(failed.ok, false, "b's bet rolled back");
  assert.equal(await cash("b"), 500000);
  assert.deepEqual(polled.felt, [{ t: "red", n: 500, k: 1 }], "never b's uncharged line");
  assert.equal(polled.rev, R.rev);
});

test("(review) someone unseated turning incognito (a web wheel's host) is masked on the very next view, though no rev changed", async (t) => {
  const api = await server(t);
  const W = svc.getTable(expect(await openWeb("b")).table);
  const first = (await api("/api/casino/t/" + W.id, "c")).body.table;
  assert.equal(first.host, "Playerb");
  const rev = W.rev;
  h.veil._hooks.kind = async (keys) => (Array.isArray(keys) && keys.includes("u:b") ? "incognito" : null);
  h.move(5000); // (a veil refresh re-reads at most every 2 s)
  const t0 = Date.now();
  const next = (await api("/api/casino/t/" + W.id, "c")).body.table;
  assert.ok(Date.now() - t0 < 1000, "within the cache's second");
  assert.equal(W.rev, rev, "nothing saved");
  assert.notEqual(next.host, "Playerb");
  assert.ok(!JSON.stringify(next).includes("Playerb"), "the cached view with the name is not served");
});

test("D7 (review): an admin's stream pins a wheel only when asked ({pin: true}); a plain one keeps the idle drop, so the queue moves", async (t) => {
  const api = await server(t);
  await sql("UPDATE users SET class='Admin' WHERE userId='d'");
  const L = lobby();
  const W = svc.getTable(expect(await openWeb("b")).table);
  const on = (await api("/api/casino/t/" + L.id + "/stream", "d", { on: true })).body;
  assert.equal(on.ok, true);
  assert.equal(on.pinned, undefined);
  assert.ok(!svc.S.stream.pin, "not pinned");
  assert.equal((await api("/api/casino/t/" + W.id + "/stream", "b", { on: true })).body.queued, 1);
  svc.S.stream.ts = L.last_activity = h.time();
  await tick(5 * 60 * 1000 + 1000);
  assert.equal(svc.S.stream.table, W.id, "the idle lobby left the slot: the queued wheel has it");
  // asked for: pinned, it stays past the idle drop
  const pinned = (await api("/api/casino/t/" + L.id + "/stream", "d", { on: true, override: true, pin: true })).body;
  assert.equal(pinned.pinned, true);
  assert.equal(svc.S.stream.pin, true);
  await tick(6 * 60 * 1000);
  assert.equal(svc.S.stream.table, L.id);
});

test("(review) rules.bank_straight is never an old figure: null once 10 s old; Pepe's poll works it out itself", async (t) => {
  const api = await server(t);
  const R = await room("pad-bk");
  const v1 = (await api("/api/casino/t/" + R.id, "c")).body.table;
  assert.equal(v1.rules.bank_straight, 5000, "the wheel's straight cap: the bank has room");
  // the bank shrinks (another wheel's book, the House, an admin's cap) while nobody views this wheel on the web
  await svc.setSetting("rl_spin_cap", 35000);
  h.move(60 * 1000);
  assert.equal(svc.publicView(R).rules.bank_straight, null, "an old figure is not shown");
  const polled = (await svc.poll(-1, 0)).tables[R.id];
  assert.equal(polled.rules.bank_straight, 1000, "the poll's own read-only refresh");
  assert.equal(svc.publicView(R).rules.bank_straight, 1000);
});
