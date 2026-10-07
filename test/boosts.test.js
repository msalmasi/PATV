// Offline tests for 🚀 pad boosts (1.99ee: boosts.js, frontroom.boostPoints / rank / decide, rooms.trending):
// featuring is earned - boosts feed the front-page ranking (sqrt, capped, relative to the pad's own
// activity, decaying with a 1 h half-life, nothing for a quiet pad, never sooner than the 30-minute hold)
// and their PAT is routed as a "room flow": the booster is debited once (idempotent ref), half goes to the
// Federal Reserve as a claim (the Fort Knox half), half is held in the pad's room-vault escrow.
//   NODE_PATH=G:/PATV/node_modules node --test test/boosts.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "boosts-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const FR = require(path.join(repo, "frontroom"));
const B = require(path.join(repo, "boosts"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));

const MIN = 60 * 1000;
let T = Date.UTC(2026, 9, 7, 18, 0, 0);
const adv = (ms) => { T += ms; };
rooms._setClock(() => T); B._setClock(() => T); S._setClock(() => T);
const START = 1000000;
const PLANT = "plant_based_chatting", HOUSE = "PepeFrog.Room";

let n = 0;
async function mkUser(extra = {}) {
  const id = "b" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, discordUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, 'pleb')`, [id, extra.username || "booster" + n, extra.username || "Booster " + n, extra.bal != null ? extra.bal : START, extra.camfrog || null, extra.discord || null]);
  return { userId: id, username: extra.username || "booster" + n };
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
// a summary row with measured activity (what bridge.summary + roomactivity give); quiet = minutes since the last line
const row = (id, a = {}, boost) => ({ id, live: true, count: (a.people || 0) + 1, boost, quiet: a.quiet || 0,
  act: { chatters: a.chatters || 0, lines: a.lines || 0, micMin: a.mic || 0, people: a.people || 0, lastAt: T - (a.quiet || 0) * MIN } });

let owner;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  owner = await mkUser({ username: "pb", camfrog: "foamy1111", discord: "plantbaked" });
  await S.init();
  await rooms.init();
  await B.init();
  for (const id of ["DRAMA_CENTRAL", "Quiet.Room"]) await rooms.addRoom(id, null, "test");
  await rooms.setOwner(PLANT, "foamy1111", "test");
});

// ── scoring (pure) ──
test("boost points: k·sqrt(active PAT), capped at 25, never more than half the pad's own activity", () => {
  const b = FR.DEFAULTS.boost;
  assert.deepEqual({ k: b.k, cap: b.cap, rel: b.rel, half_min: b.half_min, on: b.on }, { k: 0.1, cap: 25, rel: 0.5, half_min: 60, on: true });
  assert.equal(FR.boostPoints(10000, 100, false), 10, "10k PAT -> +10");
  assert.equal(FR.boostPoints(40000, 100, false), 20, "4x the PAT -> only 2x the points (sqrt)");
  assert.equal(FR.boostPoints(62500, 100, false), 25);
  assert.equal(FR.boostPoints(10000000, 100, false), 25, "the cap: 10M PAT is still +25");
  assert.equal(FR.boostPoints(10000000, 12, false), 6, "never more than half a quiet-ish pad's activity score (12 -> 6)");
  assert.equal(FR.boostPoints(10000000, 0, false), 0, "no activity at all -> no boost");
  assert.equal(FR.boostPoints(10000000, 80, true), 0, "a dead pad (no chat / mic for dead_min) -> no boost");
  assert.equal(FR.boostPoints(0, 80, false), 0);
  assert.equal(FR.boostPoints(50000, 80, false, { ...b, on: false }), 0, "switched off");
  const c = FR.cleanCfg({ boost_k: "0.2", boost_cap: 9999, boost_on: false, boost_half_min: 1 });
  assert.deepEqual(c.boost, { k: 0.2, cap: 1000, rel: 0.5, half_min: 5, on: false }, "clamped admin settings");
  assert.deepEqual(FR.cleanCfg({}).boost, { k: 0.1, cap: 25, rel: 0.5, half_min: 60, on: true }, "an old stored config gets the defaults");
});

test("decay: a boost halves every hour; the split is 50/50 (odd PAT to Fort Knox), all Fort Knox when the owner pays", () => {
  const t0 = 1_000_000_000;
  assert.equal(B.activePat([{ amount: 10000, created: t0 }], t0), 10000);
  assert.equal(Math.round(B.activePat([{ amount: 10000, created: t0 }], t0 + 60 * MIN)), 5000);
  assert.equal(Math.round(B.activePat([{ amount: 10000, created: t0 }], t0 + 120 * MIN)), 2500);
  assert.equal(Math.round(B.activePat([{ amount: 8000, created: t0 }, { amount: 4000, created: t0 + 60 * MIN }], t0 + 60 * MIN)), 8000);
  assert.equal(B.activePat([{ amount: 5000, created: t0 + MIN }], t0), 0, "a future row counts nothing");
  assert.deepEqual(B.split(1001, false), { fortknox: 501, room_vault: 500 });
  assert.deepEqual(B.split(1000, true), { fortknox: 1000, room_vault: 0 });
});

test("rank: boost adds to the score with its own column; a quiet pad's boost is ignored", () => {
  const cfg = FR.cleanCfg({});
  const r = FR.rank([row("A", { chatters: 5, lines: 40, mic: 4, people: 10 }, 40000),            // 41 + 20
                     row("B", { chatters: 6, lines: 50, mic: 6, people: 12 }),                     // 24 + 12.5 + 9 + 6 = 51.5
                     row("Dead", { people: 30, quiet: 30 }, 1e9)], cfg, T);                         // 15, dead
  assert.deepEqual(r.map((x) => [x.id, x.score, x.boost]), [["A", 61, 20], ["B", 51.5, 0], ["Dead", 15, 0]]);
  assert.deepEqual(r[0].parts.boost, { n: 40000, w: 0.1, pts: 20 });
  assert.equal(r[0].activity, 41);
});

async function fresh() {
  await runQuery("DELETE FROM rooms_kv WHERE key IN ('front_auto', 'front_cfg')");
  await rooms._reloadAuto();
  await rooms.setFront("auto", "test");
  adv(12 * 60 * MIN);                    // earlier tests' boosts have long decayed (and left the 8 h window) - nothing deleted
  B.clearCache();
}
async function step(rows, mins = 1) { adv(mins * MIN); for (const r of rows) r.act.lastAt = T - (r.quiet || 0) * MIN; return (await rooms.frontRoom(rows)).id; }

test("a boost tips a close race - only after the 30-minute hold (the dwell), and only through the 1.25x clear-lead rule", async () => {
  await fresh();
  const cur = { chatters: 5, lines: 40, mic: 4, people: 10 };        // 41
  const chal = { chatters: 5, lines: 36, mic: 4, people: 8 };        // 39: close behind
  assert.equal(await step([row("DRAMA_CENTRAL", cur), row("Quiet.Room", chal)]), "DRAMA_CENTRAL");
  const fan = await mkUser();
  await B.boost(fan, "Quiet.Room", { amount: 62500, ref: ref() });     // +19.5 (half of 39), < the 25 cap
  for (let m = 1; m < 30; m++) assert.equal(await step([row("DRAMA_CENTRAL", cur), row("Quiet.Room", chal)]), "DRAMA_CENTRAL", `minute ${m}: held`);
  const st = await rooms.frontStatus();
  const q = st.auto.ranked.find((x) => x.id === "Quiet.Room");
  assert.ok(q.boost > 18 && q.boost < 20, "the boost (decayed ~30 min) shows in the ranking: " + q.boost);
  assert.ok(st.auto.lead && st.auto.lead.id === "Quiet.Room", "it leads by >= 1.25x thanks to the boost");
  assert.equal(await step([row("DRAMA_CENTRAL", cur), row("Quiet.Room", chal)]), "Quiet.Room", "after the hold it switches");
  const after = await rooms.frontStatus();
  assert.match(after.auto.reason, /clear lead: .* · incl\. 🚀 boost \+\d/, "the 'picked because' reason names the boost");
});

test("money can't carry a quiet or dead pad: a huge boost on a near-empty pad loses to a busy one; a dead pad can't win at all", async () => {
  await fresh();
  const busy = { chatters: 8, lines: 80, mic: 10, people: 20 };      // 32 + 20 + 15 + 10 = 77
  const tiny = { chatters: 1, lines: 4, people: 3 };                  // 4 + 1 + 1.5 = 6.5
  const whale = await mkUser({ bal: 50000000 });
  await B.boost(whale, "Quiet.Room", { amount: 1000000, ref: ref() });
  assert.equal(await step([row("DRAMA_CENTRAL", busy), row("Quiet.Room", tiny)]), "DRAMA_CENTRAL");
  const q = (await rooms.frontStatus()).auto.ranked.find((x) => x.id === "Quiet.Room");
  assert.equal(q.boost, 3.25, "1M PAT is worth half of 6.5 here");
  // the busy pad goes quiet; the boosted pad is dead too: no switch to a dead pad, whatever was spent
  await fresh();
  await B.boost(whale, "Quiet.Room", { amount: 1000000, ref: ref() });
  assert.equal(await step([row("DRAMA_CENTRAL", busy), row("Quiet.Room", { people: 6, quiet: 30 })]), "DRAMA_CENTRAL");
  adv(31 * MIN);
  for (let i = 0; i < 4; i++) {
    assert.equal(await step([row("DRAMA_CENTRAL", { chatters: 1, lines: 2, people: 2 }), row("Quiet.Room", { people: 6, quiet: 45 })]), "DRAMA_CENTRAL");
  }
  const d = (await rooms.frontStatus()).auto.ranked.find((x) => x.id === "Quiet.Room");
  assert.equal(d.dead, true); assert.equal(d.boost, 0, "a dead pad's boost counts nothing");
  // nothing but a boost (no people, no chat): can't be the first pick either
  await fresh();
  await B.boost(whale, "Quiet.Room", { amount: 1000000, ref: ref() });
  assert.equal(await step([row("DRAMA_CENTRAL", { chatters: 1, lines: 1, people: 1 }), row("Quiet.Room", {})]), "DRAMA_CENTRAL");
});

test("boost money: debit + 50/50 route (Reserve claim + room-vault escrow), the ledger balances", async () => {
  const u = await mkUser();
  const r = await B.boost(u, PLANT, { amount: 5001, ref: ref() });
  assert.deepEqual([r.dup, r.amount, r.fortknox, r.room_vault, r.owner_self], [false, 5001, 2501, 2500, false]);
  assert.equal(await bal(u.userId), START - 5001);
  const tx = await getQuery("SELECT points, type FROM transactions WHERE userId = ?", [u.userId]);
  assert.deepEqual(tx.map((x) => x.points), [-5001]); assert.match(tx[0].type, /boost p\//);
  const row1 = (await getQuery("SELECT * FROM room_flow_ledger WHERE payer_id = ?", [u.userId]))[0];
  assert.deepEqual([row1.kind, row1.room_id, row1.amount, row1.fortknox, row1.room_vault, row1.via, row1.migrated_fk, row1.migrated_rv],
                   ["boost", PLANT, 5001, 2501, 2500, "web", null, null], "recorded with room, amount and booster for E-1 / E-3");
  const claim = await getQuery("SELECT flow, amount, settled FROM reserve_claims WHERE userId = ? AND flow = 'boost'", [u.userId]);
  assert.deepEqual(claim.map((c) => [c.flow, c.amount, c.settled]), [["boost", -2501, 0]], "Pepe's funding tick credits it to his Reserve");
  // conservation: what left the wallet = the Reserve claim + the escrow
  assert.equal(START - (await bal(u.userId)), -claim[0].amount + row1.room_vault);
  const esc = await B.escrow();
  assert.ok(esc.rooms.find((x) => x.room_id === PLANT).room_vault >= 2500);
  // the owner boosting his own pad: all of it to the Fort Knox half
  const o = await B.boost(owner, PLANT, { amount: 2000, ref: ref() });
  assert.deepEqual([o.fortknox, o.room_vault, o.owner_self], [2000, 0, true]);
});

test("idempotent: the same ref twice (a double click) charges once; refusals move nothing", async () => {
  const u = await mkUser();
  const k = ref();
  const [x, y] = await Promise.all([B.boost(u, PLANT, { amount: 3000, ref: k }), B.boost(u, PLANT, { amount: 3000, ref: k })]);
  assert.deepEqual([x.dup, y.dup].sort(), [false, true]);
  const z = await B.boost(u, PLANT, { amount: 3000, ref: k });
  assert.equal(z.dup, true);
  assert.equal(await bal(u.userId), START - 3000, "charged exactly once");
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM reserve_claims WHERE userId = ? AND flow = 'boost'", [u.userId]))[0].c, 1);
  // another user may reuse the same client ref: refs are per user
  const v = await mkUser();
  assert.equal((await B.boost(v, PLANT, { amount: 3000, ref: k })).dup, false);
  // refusals
  const poor = await mkUser({ bal: 50 });
  await assert.rejects(B.boost(poor, PLANT, { amount: 100, ref: ref() }), (e) => e.status === 402);
  await assert.rejects(B.boost(u, PLANT, { amount: 99, ref: ref() }), (e) => e.status === 400, "below the minimum");
  await assert.rejects(B.boost(u, PLANT, { amount: 5000, ref: "bad ref!" }), (e) => e.status === 400);
  await assert.rejects(B.boost(u, "patv:lounge", { amount: 5000, ref: ref() }), (e) => e.status === 400 && /Camfrog pads/.test(e.message), "a site pad can't be on the front page");
  await assert.rejects(B.boost(null, PLANT, { amount: 5000, ref: ref() }), (e) => e.status === 401);
  assert.equal(await bal(poor.userId), 50); assert.equal(await bal(u.userId), START - 3000);
  // the money switch
  await B.setConfig({ pay: false }, "test");
  try { await assert.rejects(B.boost(u, PLANT, { amount: 5000, ref: ref() }), (e) => e.status === 403); }
  finally { await B.setConfig({ pay: true }, "test"); }
  assert.equal(await bal(u.userId), START - 3000);
});

test("status: the Stage card line - PAT and boosters in the last hour; the boost decays out", async () => {
  adv(12 * 60 * MIN);
  B.clearCache();
  const [a, b] = [await mkUser(), await mkUser()];
  await B.boost(a, "DRAMA_CENTRAL", { amount: 1000, ref: ref() });
  await B.boost(b, "DRAMA_CENTRAL", { amount: 4000, ref: ref() });
  B.clearCache();
  let st = await B.status("DRAMA_CENTRAL");
  assert.deepEqual([st.last_hour, st.boosters, st.active], [5000, 2, 5000]);
  adv(61 * MIN); B.clearCache();
  st = await B.status("DRAMA_CENTRAL");
  assert.equal(st.last_hour, 0, "older than an hour: not in the line"); assert.ok(st.active > 2400 && st.active < 2500, "but still half active");
  const stage = await S.roomStage("DRAMA_CENTRAL");
  assert.equal(stage.boost.active, st.active, "roomStage carries it for the pad page");
});

test("trending: the automatic pick and the runners-up (live, not dead) with their boost", async () => {
  await fresh();
  const u = await mkUser();
  await B.boost(u, "Quiet.Room", { amount: 10000, ref: ref() });
  await step([row("DRAMA_CENTRAL", { chatters: 8, lines: 80, people: 20 }), row("Quiet.Room", { chatters: 3, lines: 20, people: 6 }),
              row(PLANT, { chatters: 1, lines: 2, people: 2, quiet: 40 })]);
  const t = await rooms.trending();
  assert.equal(t.front.id, "DRAMA_CENTRAL");
  assert.deepEqual(t.runners.map((r) => [r.id, Math.round(r.boost)]), [["Quiet.Room", 10]], "the dead pad isn't trending");
  assert.ok(t.runners[0].slug);
});

test("HTTP: web boost (JSON only, signed in, double click safe) and Pepe's !boost endpoint (linked Camfrog login)", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  const u = await mkUser({ camfrog: "chatfan" });
  const users = { [u.userId]: u };
  const addUser = (req, res, next) => { const id = req.headers["x-test-user"]; req.user = id ? users[id] || null : null; next(); };
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const J = (url, body, user, ct = "application/json") => fetch(base + url, { method: "POST", headers: { "Content-Type": ct, ...(user ? { "x-test-user": user } : {}) },
    body: ct === "application/json" ? JSON.stringify(body || {}) : String(body) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  try {
    let r = await J("/api/rooms/plant-based-chatting/boost", { amount: 1000, ref: "web-ref-0001" });
    assert.equal(r.status, 401);
    r = await J("/api/rooms/plant-based-chatting/boost", "amount=1000", u.userId, "application/x-www-form-urlencoded");
    assert.equal(r.status, 415, "a cross-site form can't boost");
    const b0 = await bal(u.userId);
    const [r1, r2] = await Promise.all([J("/api/rooms/plant-based-chatting/boost", { amount: 1000, ref: "web-ref-0001" }, u.userId),
                                        J("/api/rooms/plant-based-chatting/boost", { amount: 1000, ref: "web-ref-0001" }, u.userId)]);
    assert.equal(r1.status, 200); assert.equal(r2.status, 200);
    assert.deepEqual([r1.j.dup, r2.j.dup].sort(), [false, true]);
    assert.equal(await bal(u.userId), b0 - 1000, "one charge for a double click");
    assert.ok(r1.j.boost.last_hour >= 1000);
    const g = await fetch(base + "/api/rooms/plant-based-chatting/boost", { headers: { "x-test-user": u.userId } }).then((x) => x.json());
    assert.equal(g.ok, true); assert.equal(g.balance, b0 - 1000);
    // Pepe
    r = await J("/api/rooms/boost", { password: "nope", room: PLANT, by: "chatfan", amount: 500, ref: "pepe-ref-0001" });
    assert.equal(r.status, 403);
    r = await J("/api/rooms/boost", { password: "bot", room: PLANT, by: "ChatFan", amount: 500, ref: "pepe-ref-0001" });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.match(r.j.message, /boosted with 500 PAT/);
    r = await J("/api/rooms/boost", { password: "bot", room: PLANT, by: "chatfan", amount: 500, ref: "pepe-ref-0001" });
    assert.equal(r.j.dup, true, "a re-sent !boost charges nothing");
    assert.equal(await bal(u.userId), b0 - 1500);
    const via = await getQuery("SELECT via FROM room_flow_ledger WHERE ref = ?", ["boost:" + u.userId + ":pepe-ref-0001"]);
    assert.equal(via[0].via, "chat");
    r = await J("/api/rooms/boost", { password: "bot", room: PLANT, by: "nobody_linked", amount: 500, ref: "pepe-ref-0002" });
    assert.equal(r.j.ok, false); assert.match(r.j.message, /link your Camfrog name/);
    r = await J("/api/rooms/boost", { password: "bot", room: PLANT, by: "chatfan", amount: 5, ref: "pepe-ref-0003" });
    assert.equal(r.j.ok, false); assert.match(r.j.message, /between/);
    r = await J("/api/rooms/boost", { password: "bot", room: "No.Such.Room", by: "chatfan", amount: 500, ref: "pepe-ref-0004" });
    assert.equal(r.j.ok, false);
    // admin switch is staff-only
    r = await J("/api/boost/admin", { pay: false }, u.userId);
    assert.equal(r.status, 403);
  } finally { srv.close(); }
});

test("conservation: every boost's PAT is in the Reserve claims or the room-vault escrow - nothing created or destroyed", async () => {
  const fk = -(await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims WHERE flow IN ('boost','stage_slot')"))[0].t;
  const rv = (await getQuery("SELECT COALESCE(SUM(room_vault),0) AS t FROM room_flow_ledger"))[0].t;
  const held = (await getQuery("SELECT COALESCE(SUM(held),0) AS t FROM stage_slots WHERE settled = 0"))[0].t;
  const ledger = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM room_flow_ledger"))[0].t;
  assert.ok(ledger > 0);
  assert.equal(fk + rv, ledger, "each row splits exactly into its two halves");
  // every wallet movement in this file is a boost debit: they net to exactly what was routed
  const moved = (await getQuery("SELECT COALESCE(SUM(points),0) AS t FROM transactions"))[0].t;
  assert.equal(moved, -(fk + rv) - held, "the wallets lost exactly what was routed");
  const wallets = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS b FROM users"))[0].b;
  const initial = (await getQuery("SELECT COUNT(*) AS n FROM users"))[0].n * START - (START - 50) + (50000000 - START);   // one 50-PAT user, one 50M whale
  assert.equal(wallets + fk + rv + held, initial, "wallets + Reserve claims + escrow = what everyone started with");
});

test("pages: the Pads guide shows Trending (front pick + runners-up with their boost), no paid featuring copy anywhere", async () => {
  const ejs = require("ejs");
  const html = await ejs.renderFile(path.join(repo, "views", "rooms.ejs"), {
    user: null, signedIn: false, staff: false, owned: [], pepe: { active: false },
    rows: [{ id: "DRAMA_CENTRAL", slug: "drama-central", title: "DRAMA", live: true, bridged: true, count: 20, micCount: 1, slot_count: 1, now: [], next: [],
             trend: { rank: 1, front: true, score: 62, boost: 0 } },
           { id: "Quiet.Room", slug: "quiet-room", title: "Quiet", live: true, bridged: true, count: 6, micCount: 0, slot_count: 1, now: [], next: [],
             trend: { rank: 2, front: false, score: 30, boost: 9.9 } }] });
  assert.match(html, /id="trending"/);
  assert.match(html, /📺 On the front page/); assert.match(html, /Trending #1/); assert.match(html, /🚀 \+9\.9/);
  assert.match(html, /href="\/p\/quiet-room#boost"/);
  for (const v of ["rooms.ejs", "stageBook.ejs", "home.ejs", "padSettings.ejs", "economy.ejs"]) {
    const src = fs.readFileSync(path.join(repo, "views", v), "utf8");
    assert.doesNotMatch(src, /★ Get featured|Get featured<\/b>|feature=1|Paid featuring costs/, v + " has no paid-featuring copy");
  }
});
