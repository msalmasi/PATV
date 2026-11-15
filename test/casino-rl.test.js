"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const h = require("./fixtures/casino-rl-harness");
const { svc, sql, rows, act, cash, held, total, room, lobby, tick, expect, fair, actor, repo } = h;
test.before(h.initialize);
test.beforeEach(h.fresh);
test.after(() => svc.stop());

test("an open wheel commits before bets, pays the whole book once, conceals the seed until reveal", async () => {
  const T = await room(),
    n = T.eng.round_no,
    opening = await total(),
    seed = T.round.seed,
    p = fair.spinPocket(seed, T.client_seed, n);
  assert.equal((await svc.fairRecord(T.id, n)).server_seed, null);
  const spots = require("../casino/rlengine").positions;
  const winners = Object.values(spots).filter((b) => b.nums.includes(p));
  for (const batch of [winners.slice(0, 6), winners.slice(6)])
    if (batch.length) expect(await act(T, "a", "bet", batch.map((x) => x.token + " 100").join(" ")));
  const lost = (p + 1) % 37;
  expect(await act(T, "b", "bet", lost + " 500"));
  expect(await act(T, "c", "bet", p + " 300"));
  const debits = await held();
  assert.ok(debits > 0);
  assert.equal(await total(), opening);
  assert.equal((await act(T, "a", "go")).ok, false);
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  assert.equal(svc.publicView(T).spin.number, p);
  for (const x of [svc.publicView(T), await svc.poll(0, 0), await svc.fairRecord(T.id, n)])
    assert.ok(!JSON.stringify(x).includes(seed));
  assert.equal((await act(T, "b", "undo")).ok, false);
  expect(await act(T, "b", "bet", "red 200"));
  assert.equal(await cash("b"), 499500);
  expect(await act(T, "b", "clear"));
  assert.equal(await held(), debits);
  const results = require("../casino/rlengine").settle(T.eng.book, p);
  await tick(8000);
  assert.equal(T.eng.phase, "result");
  assert.equal(await total(), opening);
  assert.equal(await held(), 0);
  assert.equal((await svc.fairRecord(T.id, n)).verified, true);
  for (const [uid, r] of Object.entries(results)) assert.equal(await cash(uid), 500000 + r.net);
  assert.equal((await svc.meView(T, "c")).net, 10500);
  const legs = await rows("SELECT amount FROM jackpot_rakes WHERE spinId=?", ["crl:" + T.id + ":s1"]);
  assert.equal(
    legs.reduce((n, r) => n + r.amount, 0),
    -Object.values(results).reduce((n, r) => n + r.net, 0),
  );
  assert.equal(
    (await rows("SELECT n FROM casino_ach_counts WHERE userId='c' AND metric='rl_straight_wins'"))[0].n,
    1,
  );
  expect(await act(T, "b", "rebet"));
  assert.equal(await cash("b"), 499500);
  await tick(5000);
  assert.equal(T.eng.round_no, 2);
  assert.equal(await cash("b"), 499000);
  expect(await act(T, "a", "end"));
  assert.equal(await cash("b"), 499500);
  assert.equal((await svc.fairRecord(T.id, 2)).verified, true);
});

test("one room, switch narrowing, dispatch, host authority and lobby rotation", async () => {
  assert.equal(svc.S.settings.hm_enabled, false);
  assert.equal(svc.S.settings.bj_enabled, false);
  const L = lobby();
  await svc.setSetting("max_tables", 1);
  const T = await room();
  assert.equal((await act(null, "b", "start", null, { room: "b", via: "room", game: "roulette" })).ok, false);
  for (const game of ["bj", "holdem"])
    assert.match(
      (await svc.act(actor("b", "room"), "start", [], { game, room: T.room, table: T.id }, "start-" + game))
        .reply,
      /roulette/i,
    );
  for (const verb of ["hit", "deal", "fold", "stand", "leave", "double", "split", "autobet", "sit"])
    assert.equal((await act(T, "b", verb, "100")).ok, false);
  for (const verb of ["bet", "stand", "leave", "fold", "hit"])
    assert.match(
      (
        await svc.act(
          actor("b", "room"),
          verb,
          ["500"],
          { table: T.id, room: T.room, game: null },
          "game-less-" + verb,
        )
      ).reply,
      /!rl/,
    );
  assert.equal((await svc.push(L.id, "pad-a", actor("a"))).ok, false);
  assert.equal((await svc.advertise(L.id, "pad-a", actor("a"), true)).ok, false);
  assert.equal((await svc.stream(L.id, true, actor("b"), false)).ok, false);
  expect(await svc.stream(L.id, true, { ...actor("a"), admin: true }, false));
  svc.S.rate.clear();
  expect(await act(T, "b", "bet", "red 100"));
  expect(await act(T, "b", "go"));
  expect(await act(T, "b", "bet", "black 500"));
  await svc.setSetting("casino_roulette", "staff");
  assert.equal((await svc.RL.lobby("b")).on, false);
  assert.equal((await svc.RL.lobby("a")).on, true);
  await tick(8000);
  const after = await cash("b");
  await tick(5000);
  assert.equal(await cash("b"), after);
  assert.equal(T.eng.pending.b, undefined);
  await svc.setSetting("casino_roulette", "everyone");
  const empty = await svc.meView(L, "a");
  assert.ok(empty.notice);
  assert.equal((await svc.meView(L, "a")).notice, null);
  await tick(25 * 3600000);
  assert.ok(lobby());
  assert.notEqual(lobby().id, L.id);
  assert.equal(T.status, "closed");
  assert.ok((await svc.fairRecord(L.id, 1)).verified);
  await tick(7 * 86400000);
  assert.ok((await svc.meView(lobby(), "d")).notice);
  assert.equal(await require("../casino/notices").take("hm_timeout", "d", h.time(), {}), null);
  await svc.setSetting("casino_roulette", "off");
  await tick(1);
  assert.equal(lobby(), undefined);
});

test("liability shared across wheels, undo can be refused, caps and linked accounts checked", async () => {
  const L = lobby(),
    T = await room();
  await svc.setSetting("rl_spin_cap", 3500);
  expect(await act(T, "a", "bet", "17 100"));
  assert.match((await act(L, "b", "bet", "3 200")).reply, /bank|take/i);
  expect(await act(T, "b", "bet", "18 100"));
  assert.match((await act(T, "a", "bet", "17 200")).reply, /take/);
  await svc.setSetting("rl_spin_cap", 3400);
  assert.match((await act(T, "b", "clear")).reply, /rides/);
  assert.equal(await held(), 200);
  expect(await act(T, "a", "end"));
  assert.equal(await held(), 0);
  await sql("UPDATE jackpot_rakes SET amount=5000000 WHERE jackpotId='seed'");
  assert.match((await act(L, "b", "bet", "red 100")).reply, /bank.*closed/);
  await sql("UPDATE jackpot_rakes SET amount=25000000 WHERE jackpotId='seed'");
  await svc.setSetting("rl_spin_cap", 2000000);
  const key = "same-roulette-bet";
  const first = expect(await act(L, "a", "bet", "red 500", { key }));
  const second = expect(await act(L, "a", "bet", "red 500", { key }));
  assert.equal(first.reply, second.reply);
  assert.equal(await cash("a"), 499500);
  await sql("INSERT INTO welcome_bonus (userId,dup_of) VALUES ('b','a')");
  assert.match((await act(L, "b", "bet", "black 100")).reply, /linked/);
  await svc.setSetting("rl_max_positions", 1);
  assert.match((await act(L, "a", "bet", "black 100")).reply, /limit/);
  await svc.setSetting("rl_max_players", 1);
  assert.match((await act(L, "c", "bet", "black 100")).reply, /player limit/);
  await sql("UPDATE users SET casino_banned=1 WHERE userId='a'");
  for (const verb of ["bet", "rebet", "clear", "undo", "go", "end"])
    assert.match((await act(L, "a", verb, "black 100")).reply, /banned/i);
  assert.equal(await cash("a"), 499500);
  await sql("UPDATE users SET casino_banned=0");
  svc.S.rate.clear();
  expect(await act(L, "a", "undo", null, { key: "same-undo-key" }));
  expect(await act(L, "a", "undo", null, { key: "same-undo-key" }));
  assert.equal(await cash("a"), 500000);
});

test("all position families, including zero trios and first four, pay a real wallet", async () => {
  const positions = require("../casino/rlengine").positions;
  const byKind = new Map(Object.values(positions).map((p) => [p.kind, p]));
  for (const [kind, spot] of byKind) {
    const T = await room(kind);
    let seed;
    for (let nonce = 0; ; nonce++) {
      seed = String(nonce).padStart(64, "0");
      if (spot.nums.includes(fair.spinPocket(seed, T.client_seed, 1))) break;
    }
    T.round.seed = seed;
    T.round.commitment = fair.commitment(seed);
    await sql("UPDATE casino_rounds SET commitment=? WHERE table_id=? AND round_no=1", [
      T.round.commitment,
      T.id,
    ]);
    const wallet = await cash("a");
    expect(await act(T, "a", "bet", spot.token + " 100"));
    expect(await act(T, "a", "go"));
    await tick(8000);
    assert.equal(await cash("a"), wallet + 100 * spot.odds, kind);
    expect(await act(T, "a", "end"));
    await tick(5000);
  }
});

test("masked winners remain private; real room players see their own room name; retired wheels reveal their commitment", async () => {
  const T = await room(),
    before = await total(),
    p = fair.spinPocket(T.round.seed, T.client_seed, 1);
  const place = (uid, via) =>
    svc.act(
      { ...actor(uid, via), veil: "out" },
      "bet",
      [p + " 100"],
      { table: T.id, room: T.room, game: "roulette" },
      "veiled-bet-" + uid,
    );
  h.veil._reset();
  h.veil._hooks.kind = async () => "out";
  expect(await place("b", "web"));
  expect(await place("c", "room"));
  await tick(25000);
  await tick(8000);
  const raw = (await rows("SELECT data FROM casino_events WHERE table_id=? AND kind='result'", [T.id]))[0].data;
  assert.ok(raw.includes("Playerc"));
  assert.ok(!raw.includes("Playerb"));
  const outs = [
    svc.publicView(T),
    (await svc.poll(0, 0)).tables[T.id],
    await svc.fairRecord(T.id, 1),
    await svc.RL.lobby("b"),
  ];
  for (const out of outs) {
    assert.ok(!JSON.stringify(out).includes("Playerb"));
    assert.ok(!JSON.stringify(out).includes("Playerc"));
  }
  assert.equal(await total(), before);
  const L = lobby();
  for (let i = 0; i < 35; i++) h.veil.enter(L, { ...actor("guest" + i), veil: null });
  const refused = await act(L, "d", "bet", "red 100");
  assert.match(refused.reply, /full for now/i);
  await tick(10);
  assert.equal(L.status, "closed");
  assert.notEqual(lobby().id, L.id);
  assert.equal((await svc.fairRecord(L.id, 1)).verified, true);
  for (const type of ["roulette bet", "roulette payout", "roulette refund (undo)"])
    assert.equal(require("../history").describe({ type }).cat, "casino");
  assert.equal(
    require("../jackpotflows").classify({ spinId: "crl:local:s1", amount: 100 }, new Set()).name,
    "casino tables",
  );
});

test("limits cap the accumulated position, complete spin and action count; same IP is a private flag", async () => {
  const T = await room(),
    before = await total();
  for (const uid of ["b", "c"])
    expect(
      await svc.act(
        { ...actor(uid), iph: "shared" },
        "bet",
        ["red 100"],
        { table: T.id },
        "same-address-" + uid,
      ),
    );
  assert.equal(T.multi.length, 1);
  assert.ok(!JSON.stringify(svc.publicView(T)).includes("shared"));
  expect(await act(T, "a", "bet", "17 5000"));
  assert.match((await act(T, "a", "bet", "17 100")).reply, /5,000/);
  expect(await act(T, "d", "bet", "red 50000 black 50000"));
  assert.match((await act(T, "d", "bet", "odd 100")).reply, /per-spin limit/);
  await svc.setSetting("rl_max_lines", 2);
  expect(await act(T, "b", "bet", "red 100"));
  assert.match((await act(T, "b", "clear")).reply, /action limit/);
  let hit = false;
  for (let i = 0; i < 16; i++) if (!(await act(T, "c", "status")).ok) hit = true;
  assert.ok(hit);
  assert.equal(await total(), before);
});

test("when switched off, the current spin pays at its landing, then the wheel closes", async () => {
  const T = await room();
  expect(await act(T, "b", "bet", "red 500"));
  const before = await total();
  await svc.setSetting("casino_roulette", "off");
  assert.equal((await act(T, "b", "bet", "black 100")).ok, false);
  await tick(25000);
  assert.equal(T.eng.phase, "spinning");
  assert.equal(await held(), 500);
  await tick(8000);
  assert.equal(T.eng.phase, "result");
  assert.equal(await held(), 0);
  await tick(5000);
  assert.equal(T.status, "closed");
  assert.equal(await total(), before);
  const refunds = await rows("SELECT * FROM transactions WHERE type LIKE 'roulette refund%'");
  assert.equal(refunds.length, 0);
});

test("legacy tables still identify themselves; roulette bets cannot reach a card game", async () => {
  await svc.setSetting("bj_enabled", "1");
  await svc.setSetting("hm_enabled", "1");
  for (const game of ["bj", "holdem"]) {
    const T = expect(
      await svc.act(
        actor("a", "room"),
        "start",
        game === "holdem" ? ["25/50"] : [],
        { room: game, game },
        "open-cards-" + game,
      ),
    );
    const out = await svc.act(
      actor("a", "room"),
      "bet",
      ["red 500"],
      { table: T.table, room: game, game: "roulette" },
      "wrong-game-" + game,
    );
    assert.equal(out.ok, false);
    assert.match(out.reply, game === "bj" ? /blackjack/i : /hold'em/i);
  }
  assert.equal(await held(), 0);
});

test("HTTP capability gate, private views, room lookup, single-argument bet and replay", async (t) => {
  const express = require("express"),
    app = express(),
    routes = require("../casino/routes");
  app.use(express.json());
  app.set("views", require("node:path").join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = (q, r, next) => {
    const id = q.get("x-test-user");
    q.user = id ? { userId: id, username: "player" + id } : null;
    next();
  };
  routes.register(app, { isBotToken: (x) => x === "localtest", addUser });
  const srv = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => srv.once("listening", resolve));
  t.after(() => srv.close());
  const api = async (p, user, b) =>
    fetch("http://127.0.0.1:" + srv.address().port + p, {
      method: b ? "POST" : "GET",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "fetch",
        "x-test-user": user || "",
        "x-forwarded-for": user === "a" ? "192.0.2.10" : "192.0.2.11",
      },
      body: b ? JSON.stringify(b) : undefined,
    });
  const T = await room("test-room"),
    path = "/api/casino/t/" + T.id;
  const post = (b) => api(path + "/act", "b", b).then((x) => x.json());
  expect(
    await post({
      verb: "bet",
      bets: [
        { b: "17", a: "100" },
        { b: "red", a: "500" },
      ],
      idem: "web-case-01",
    }),
  );
  expect(
    await post({
      verb: "bet",
      bets: [
        { b: "17", a: "100" },
        { b: "red", a: "500" },
      ],
      idem: "web-case-01",
    }),
  );
  assert.equal(await cash("b"), 499400);
  assert.equal((await post({ verb: "bet", bets: [{ b: "17 500", a: "100" }], idem: "bad-bet-01" })).ok, false);
  const cf = {
    password: "localtest",
    username: "playera",
    game: "roulette",
    room: T.room,
    verb: "bet",
    args: ["black 100 d1 100 17 100"],
    idem: "bot-case-01",
  };
  const bot = (b) => api("/api/casino/bot/act", null, b);
  expect(await (await bot(cf)).json());
  expect(await (await bot(cf)).json());
  assert.equal(await cash("a"), 499700);
  assert.equal((await bot({ ...cf, channel: "telegram" })).status, 403);
  const poll = async (games) =>
    (await api("/api/casino/bot/poll", null, { password: "localtest", after: 0, games })).json();
  const before = await poll(),
    cap = await poll(["roulette"]);
  assert.ok(!before.roulette);
  assert.ok(!before.tables[T.id]);
  assert.ok(!before.events.some((e) => e.data?.game === "roulette"));
  assert.equal(cap.tables[T.id].game, "roulette");
  assert.ok(cap.events.some((e) => e.data?.game === "roulette"));
  assert.ok(cap.lobby.roulette.endsWith("/casino/roulette"));
  assert.ok(cap.roulette.some((w) => w.id === T.id));
  assert.equal((await api("/casino/roulette", "b")).status, 302);
  assert.ok((await (await api("/api/casino/roulette/pad/site-only", "b")).json()).table === lobby().id);
  await svc.setSetting("casino_roulette", "staff");
  assert.equal((await api(path, "b")).status, 404);
  assert.equal((await api("/api/casino/roulette/pad/site-only", "b")).status, 404);
  const view = await (await api(path, "a")).json();
  assert.ok(view.ok, JSON.stringify(view));
  assert.equal(view.me.lines.length, 1);
  assert.equal(view.me.staked, 300);
  assert.ok(!JSON.stringify(view.table).includes(T.round.seed));
});
test("receipt for a three-player spin against the pinned fair seed", async () => {
  const T = await room("offline-example");
  T.client_seed = "00112233aabbccdd";
  T.round.seed = "0123456789abcdef".repeat(4);
  T.round.commitment = fair.commitment(T.round.seed);
  await sql("UPDATE casino_rounds SET client_seed=?, commitment=? WHERE table_id=? AND round_no=1", [
    T.client_seed,
    T.round.commitment,
    T.id,
  ]);
  const opening = await total();
  expect(await act(T, "a", "bet", "black 500 27 100"));
  expect(await act(T, "b", "bet", "red 500 0 100"));
  expect(await act(T, "c", "bet", "black 300"));
  const stakes = await held();
  await tick(25000);
  await tick(8000);
  assert.equal(T.last_round.number, 27);
  const wallets = await rows(
    "SELECT userId,points_balance FROM users WHERE userId IN ('a','b','c') ORDER BY userId",
  );
  assert.deepEqual(
    wallets.map((r) => r.points_balance),
    [503000, 500400, 499700],
  );
  const legs = await rows("SELECT amount FROM jackpot_rakes WHERE spinId=? ORDER BY amount", [
    "crl:" + T.id + ":s1",
  ]);
  assert.deepEqual(
    legs.map((r) => r.amount),
    [-3400, 300],
  );
  const payouts = (await rows("SELECT SUM(points) AS n FROM transactions WHERE type='roulette payout'"))[0].n;
  assert.equal(payouts + 300 - 3400, stakes);
  assert.equal(await total(), opening);
  console.log(
    "Wheel receipt:",
    JSON.stringify({
      pocket: 27,
      stakes,
      payouts,
      house_in: 300,
      house_out: 3400,
      wallets,
      before: opening,
      after: await total(),
    }),
  );
});

test("a reward outage cannot delay a paid spin; stale seats leave before queued lines start the next spin", async (t) => {
  const rewards = require("../casino/rewards");
  t.mock.method(rewards, "rouletteSpin", async () => {
    throw new Error("test reward outage");
  });
  const T = lobby(),
    before = await total();
  expect(await act(T, "a", "bet", "red 500"));
  expect(await act(T, "b", "bet", "black 500"));
  await tick(25000);
  expect(await act(T, "b", "bet", "red 100"));
  await tick(8000);
  assert.equal(T.eng.phase, "result");
  assert.equal(await total(), before);
  await tick(11 * 60000);
  assert.equal(T.eng.phase, "betting");
  assert.deepEqual(T.eng.seats, ["b"]);
  assert.equal(await held(), 100);
  assert.equal(await total(), before);
});

test("concurrent admin settings cannot leave an invalid roulette limit pair", async () => {
  const changes = await Promise.allSettled([
    svc.setSetting("rl_min_bet", 4000, "qa-a"),
    svc.setSetting("rl_max_straight", 2000, "qa-b"),
  ]);
  assert.deepEqual(
    changes.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  const { rl_min_bet, rl_max_straight } = await svc.loadSettings(true);
  assert.equal(rl_min_bet, 4000);
  assert.equal(rl_max_straight, 5000);
  assert.equal((await rows("SELECT actor FROM casino_settings WHERE key='rl_min_bet'"))[0].actor, "qa-a");
});
