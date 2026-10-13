// 1.99ur: markets, betting pools and polls belong to PADS (padlinks.js). The pad is a column next to each JSON row: filled
// from the record's pad (the website's picker) or its chat room (id, slug or a pad's exact title - the bad rows hold display
// names), never overwritten by a later mirror write, NULL = site-wide. Polls: one running poll per pad. The create forms'
// extra words (pad:<id>, until:<unix s>, tz:<zone>) and the admins' close bounds (mktcfg.js).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-pads-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
process.env.STAGING = "1";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const padlinks = require(path.join(repo, "padlinks"));
const markets = require(path.join(repo, "markets"));
const mktcfg = require(path.join(repo, "mktcfg"));

const T = Date.now();
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await rooms.init();
  await runQuery(`INSERT OR IGNORE INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated)
                  VALUES ('DRAMA_CENTRAL', 'drama-central', 'Drama Central', 'none', 'camfrog', ?, ?),
                         ('patv:quiz', 'quiz-night', 'Quiz Night', 'none', 'site', ?, ?)`, [T, T, T, T]);
  await rooms.loadCache();
});

const row = async (id) => (await getQuery("SELECT pad, data FROM markets WHERE id = ?", [id]))[0];

test("a market's pad comes from its pad, else its room (id / slug / exact title); none = site-wide", async () => {
  await padlinks.ready();
  assert.equal(padlinks.resolve({ room: "DRAMA_CENTRAL" }), "DRAMA_CENTRAL");
  assert.equal(padlinks.resolve({ room: "PepeLab" }), "PepeBeta.Room", "the display name (= the pad's slug) of PepeBeta.Room");
  assert.equal(padlinks.resolve({ room: "Quiz Night" }), "patv:quiz", "a pad's exact title");
  assert.equal(padlinks.resolve({ room: "drama-central" }), "DRAMA_CENTRAL", "a slug");
  assert.equal(padlinks.resolve({ room: "NoSuchRoom" }), null);
  assert.equal(padlinks.resolve({ room: "" }), null);
  assert.equal(padlinks.resolve({ pad: "patv:quiz", room: "DRAMA_CENTRAL" }), "patv:quiz", "a picked pad beats the room");
  assert.equal(padlinks.resolve({ pad: "quiz-night" }), "patv:quiz", "a pad by its slug");
  assert.deepEqual(padlinks.view("patv:quiz"), { id: "patv:quiz", slug: "quiz-night", title: "Quiz Night", url: "/p/quiz-night" });
  assert.equal(padlinks.view(null), null);
  assert.equal(padlinks.fromParam("quiz-night"), "patv:quiz");
  assert.equal(padlinks.fromParam("none"), "");
  assert.equal(padlinks.fromParam(""), null);
});

test("storeRow fills the pad column once and a later mirror write never changes it", async () => {
  const m = { id: 901, question: "Will it rain?", options: ["Yes", "No"], status: "open", closes: T / 1000 + 3600, room: "DRAMA_CENTRAL", bets: [] };
  await markets.storeRow(markets.cleanMarket(m));
  assert.equal((await row(901)).pad, "DRAMA_CENTRAL");
  // the pad was re-keyed (padrekey moves the column); the engine's next write still says the old room
  await runQuery("UPDATE markets SET pad = 'patv:quiz' WHERE id = 901");
  await markets.storeRow(markets.cleanMarket({ ...m, status: "closed" }));
  const r = await row(901);
  assert.equal(r.pad, "patv:quiz");
  assert.equal(JSON.parse(r.data).status, "closed");
  // a picked pad is kept in the JSON too
  await markets.storeRow(markets.cleanMarket({ ...m, id: 902, pad: "patv:quiz", room: null, tz: "America/New_York" }));
  const r2 = await row(902);
  assert.equal(r2.pad, "patv:quiz");
  assert.equal(JSON.parse(r2.data).tz, "America/New_York");
  // an unknown room: site-wide until it resolves
  await markets.storeRow(markets.cleanMarket({ ...m, id: 903, room: "Camfrog" }));
  assert.equal((await row(903)).pad, null);
  assert.equal(markets.cleanMarket({ ...m, tz: "Not/AZone" }).tz, undefined);
});

test("the create forms' words: pad:, until:, tz: (pad:none = site-wide)", () => {
  const t = markets.createTokens("Will it snow? judge @pepe options a/b pad:patv:quiz until:1791654775 tz:Europe/London");
  assert.deepEqual(t, { pad: "patv:quiz", until: 1791654775, tz: "Europe/London", text: "Will it snow? judge @pepe options a/b" });
  assert.equal(markets.createTokens("x pad:none").pad, "");
  assert.equal(markets.createTokens("x tz:Bad/Zone").tz, null);
  assert.equal(markets.createTokens("no words here").pad, null);
});

test("close bounds: default 1 hour .. 90 days, admin-set within 5 min .. 365 days", async () => {
  mktcfg._reset();
  assert.deepEqual(await mktcfg.get(), { close_min_secs: 3600, close_max_secs: 90 * 86400 });
  assert.equal(await mktcfg.checkClose(7200), null);
  assert.match(await mktcfg.checkClose(600), /between 1 hour and 90 days/);
  assert.match(await mktcfg.checkClose(91 * 86400), /between/);
  await mktcfg.set({ close_min_secs: 60, close_max_secs: 400 * 86400 });
  assert.deepEqual(await mktcfg.get(), { close_min_secs: 300, close_max_secs: 365 * 86400 });
  await mktcfg.set({ close_min_secs: 3600, close_max_secs: 90 * 86400 });
});

test("polls: one running poll per pad; chat finds its room's pad's poll, else a site-wide one", async () => {
  const polls = require(path.join(repo, "polls"));
  await runQuery("CREATE TABLE IF NOT EXISTS polls_meta (key TEXT PRIMARY KEY, value TEXT)");
  await runQuery("INSERT INTO polls_meta (key, value) VALUES ('enabled', 'true'), ('live', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  const a = await polls.act("create", { question: "Best snack", options: ["chips", "fruit"], creator: "ann", room: "DRAMA_CENTRAL" }, "camfrog");
  assert.ok(a.ok, a.msg);
  assert.equal(a.poll.pad, "DRAMA_CENTRAL");
  const busy = await polls.act("create", { question: "Again", options: ["x", "y"], creator: "bob", room: "DRAMA_CENTRAL" }, "camfrog");
  assert.equal(busy.code, "busy");
  const b = await polls.act("create", { question: "Quiz tonight", options: ["yes", "no"], creator: "cat", pad: "patv:quiz" }, "web");
  assert.ok(b.ok, "another pad can run its own poll");
  const g = await polls.act("create", { question: "Site wide", options: ["1", "2"], creator: "dan", pad: "" }, "web");
  assert.ok(g.ok, "and so can the site-wide group");
  assert.equal((await getQuery("SELECT pad FROM polls WHERE id = ?", [g.poll.id]))[0].pad, null);
  // chat in DRAMA_CENTRAL votes on DRAMA_CENTRAL's poll; a room with no poll of its own falls back to the site-wide one
  const v = await polls.act("vote", { voter: "eve", option: 2, room: "DRAMA_CENTRAL" }, "camfrog");
  assert.equal(v.poll.id, a.poll.id);
  const w = await polls.act("vote", { voter: "fay", option: 1, room: "plant_based_chatting" }, "camfrog");
  assert.equal(w.poll.id, g.poll.id);
  // the website names its poll
  const x = await polls.act("vote", { voter: "gus", option: 1, poll_id: b.poll.id }, "web");
  assert.equal(x.poll.id, b.poll.id);
  const e = await polls.act("end", { by: "cat", poll_id: b.poll.id }, "web");
  assert.ok(e.ok);
  assert.equal((await polls.act("vote", { voter: "hal", option: 1, poll_id: b.poll.id }, "web")).code, "ended");
});

// ── the pages: pad on cards, ?pad= filter, voided hidden by default, the create forms' pad picker + close picker ──
test("the lists: pads on the cards, ?pad= filters, voided ones hidden unless ?void=1; /polls/<id>; the pad page's card", async () => {
  const express = require("express");
  const cookieParser = require("cookie-parser");
  const tz = require(path.join(repo, "tz"));
  await runQuery("INSERT OR IGNORE INTO users (userId, username, camfrogUsername, class, points_balance) VALUES ('u1', 'ann', 'ann_cf', 'pleb', 100000)");
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(tz.middleware(() => null));
  const addUser = (req, res, next) => { req.user = req.get("x-user") ? { userId: req.get("x-user"), username: "ann" } : null; next(); };
  markets.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  require(path.join(repo, "wagers")).register(app, { isBotToken: (t) => t === "bot-token", addUser });
  require(path.join(repo, "polls")).register(app, { isBotToken: (t) => t === "bot-token", addUser });
  require(path.join(repo, "actions")).register(app, { isBotToken: (t) => t === "bot-token", addUser });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const get = async (p, user) => (await fetch(base + p, { headers: user ? { "x-user": user } : {} })).text();
  try {
    const now = Math.floor(Date.now() / 1000);
    const lm = (id, extra) => ({ id, model: "lmsr", question: `Market ${id}?`, options: ["Yes", "No"], b: 50000, volume: 1000, q: { Yes: 0, No: 0 },
                                 status: "open", creator: "ann_cf", judge: "bob", created: now - 60, closes: now + 7200, positions: {}, trades: [], history: [], ...extra });
    await markets.storeRow(markets.cleanMarket(lm(911, { room: "DRAMA_CENTRAL" })));
    await markets.storeRow(markets.cleanMarket(lm(912, { pad: "patv:quiz", tz: "Asia/Tokyo" })));
    await markets.storeRow(markets.cleanMarket(lm(913, { room: "DRAMA_CENTRAL", status: "void", void_reason: "test", paid_out: { at: now, total: 0, result: "void test" } })));
    await markets.storeRow(markets.cleanMarket({ id: 914, model: "pool", question: "Pool 914?", options: ["a", "b"], status: "open", creator: "ann_cf", judge: "bob",
                                                 created: now - 60, closes: now + 7200, pad: "patv:quiz", bets: [] }));
    await markets.storeRow(markets.cleanMarket({ id: 915, model: "pool", question: "Pool 915?", options: ["a", "b"], status: "void", creator: "ann_cf", judge: "bob",
                                                 created: now - 600, closes: now - 60, ended: now, pad: "patv:quiz", bets: [] }));
    let h = await get("/markets");
    assert.match(h, /Market 911\?/);
    assert.match(h, /Market 912\?/);
    assert.doesNotMatch(h, /Market 913\?/, "a voided market is hidden by default");
    assert.match(h, /Show voided \(1\)/);
    assert.match(h, /📍<\/span> Quiz Night/);
    h = await get("/markets?void=1");
    assert.match(h, /Market 913\?/);
    h = await get("/markets?pad=quiz-night");
    assert.match(h, /Market 912\?/);
    assert.doesNotMatch(h, /Market 911\?/);
    assert.match(h, /Showing <a href="\/p\/quiz-night">Quiz Night<\/a> only/);
    h = await get("/markets?pad=quiz-night", "u1");
    assert.match(h, /<option value="patv:quiz" selected>Quiz Night<\/option>/, "the create form defaults to the pad you came from");
    assert.match(h, /data-close-pick data-min-secs="3600" data-max-secs="7776000"/);
    h = await get("/markets/912");
    assert.match(h, /pad <a class="pad-link" href="\/p\/quiz-night">Quiz Night<\/a>/);
    assert.match(h, /Market time: .*GMT\+9 \(Asia\/Tokyo\)/);
    h = await get("/markets/911");
    assert.match(h, /pad <a class="pad-link" href="\/p\/drama-central">Drama Central<\/a>/);
    // pools on /wagers
    h = await get("/wagers");
    assert.match(h, /Pool 914\?/);
    assert.doesNotMatch(h, /Pool 915\?/);
    h = await get("/wagers?void=1&pad=quiz-night");
    assert.match(h, /Pool 915\?/);
    // polls: the permalink and the filter
    const polls = await getQuery("SELECT id, pad FROM polls");
    const quiz = polls.find((p) => p.pad === "patv:quiz");
    h = await get("/polls/" + quiz.id);
    assert.match(h, /This poll/);
    assert.match(h, /Quiz tonight\?/);
    assert.equal((await fetch(base + "/polls/nope_123")).status, 404);
    h = await get("/polls?pad=drama-central");
    assert.match(h, /Best snack\?/);
    assert.doesNotMatch(h, /Quiz tonight\?/);
    // the pad page's card
    const pb = await require(path.join(repo, "padbets")).forPad("patv:quiz");
    assert.deepEqual(pb.markets.map((m) => m.id), [912]);
    assert.deepEqual(pb.pools.map((m) => m.id).filter((id) => id > 910), [914], "(901 / 902 above are old-style rows: pools)");
    assert.ok(!pb.pools.some((m) => m.id === 915), "the voided pool isn't listed");
    // the create form: the pad + a picked close go to Pepe as words; a pad nobody knows / a close out of bounds are refused
    const act = async (body) => {
      const r = await fetch(base + "/act", { method: "POST", redirect: "manual", headers: { "x-user": "u1", "content-type": "application/x-www-form-urlencoded" },
                                             body: new URLSearchParams(body).toString() });
      return decodeURIComponent(String(r.headers.get("location") || ""));
    };
    const until = now + 3 * 86400;
    let loc = await act({ kind: "cmd", cmd: "market", a0: "new", a1: "Will it snow?", a3: "judge @bob", a4: "closes 1d", pad: "patv:quiz",
                          until: String(until), tz: "Europe/Paris", back: "/markets" });
    assert.match(loc, /Sent to Pepe/);
    const q = (await getQuery("SELECT args FROM pepe_actions ORDER BY id DESC LIMIT 1"))[0];
    assert.deepEqual(JSON.parse(q.args), ["market", "new", "Will it snow?", "judge @bob", "until:" + until, "tz:Europe/Paris", "pad:patv:quiz"]);
    loc = await act({ kind: "cmd", cmd: "market", a0: "new", a1: "Will it hail?", a3: "judge @bob", pad: "no-such-pad", back: "/markets" });
    assert.match(loc, /can't post to that pad/);
    loc = await act({ kind: "cmd", cmd: "market", a0: "new", a1: "Will it hail?", a3: "judge @bob", until: String(now + 600), back: "/markets" });
    assert.match(loc, /between 1 hour and 90 days/);
    loc = await act({ kind: "cmd", cmd: "market", a0: "new", a1: "Will it fog?", a3: "judge @bob", pad: "", back: "/markets" });
    assert.deepEqual(JSON.parse((await getQuery("SELECT args FROM pepe_actions ORDER BY id DESC LIMIT 1"))[0].args).slice(-1), ["pad:none"],
                     "site-wide is said out loud (Pepe then ignores the room the creator happens to be in)");
  } finally {
    server.close();
  }
});
