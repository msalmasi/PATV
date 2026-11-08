// h22 phase 1 (1.99??): Sit & Go tournaments for Hold'em (casino/tourney.js) on the real casino service + the real escrow ledger,
// a fake clock and a temporary database:
//   * the switch casino_sng (off by default / staff / everyone), Hold'em itself must be on; the settings validated
//   * register / unregister / start when full / start at N with its 60 s countdown; the entry = ONE TNY escrow hold of buy-in + fee
//   * the cash tables' entry rule: dup-linked / same-address accounts refused, a wallet that can't cover = refused with nothing held
//   * full runs of 2 / 3 / 6 / 9 players with the blinds rising: places, the payout table, the House fee, PAT conservation, every
//     hold settled exactly once; heads-up (the button posts the small blind); level changes only between hands
//   * two bust-outs on one hand (more chips places higher; equal stacks split, the odd PAT to the higher place)
//   * a restart at every step (registration, the countdown, mid-level, before the places, before the settle, a lost final save)
//   * cancel by an admin (full refunds, fee included); never a cash-out of tournament chips, no rake; the web + bot routes
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-sng.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-sng-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "casino", "hmengine"));
const E = require(path.join(repo, "casino", "bjengine"));
const svc = require(path.join(repo, "casino", "service"));
const ESC = require(path.join(repo, "escrow", "ledger"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;   // nobody is veiled here (test/casino-veil.test.js is about veils)
const funding = require(path.join(repo, "funding"));

let NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const key = () => `sng-key-${++k}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const NAMES = ["Ann", "Bob", "Cat", "Dan", "Eve", "Fay", "Gus", "Hal", "Ivy"];
const P = NAMES.map((n, i) => mk("u" + (i + 1), n));
const [ann, bob, cat, dan, eve, fay] = P;
const ada = mk("ad", "Ada");                       // class Admin (the casino capability)
const sam = mk("st", "Sam");                       // class Staff
const byUid = Object.fromEntries(P.concat([ada, sam]).map((p) => [p.uid, p]));
const S = (who, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], Object.assign({ game: "sng", room: null }, opts || {}), key()); };
const A = (who, verb, args, tid) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], { game: "holdem", table: tid }, key()); };
const bal = async (uid) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const held = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM escrow_holds WHERE state = 'held'"))[0].t;
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS t FROM users"))[0].t;
const total = async () => (await wallets()) + (await house()) + (await held());
// the next hand's deck starts with these cards (in seat order: two each, then flop, turn, river); the rest of a deck follows
const deck = (prefix) => { svc.S.hooks.deck = () => prefix.concat(E.makeShoe(1).filter((c) => !prefix.includes(c))); };

async function fresh(opts = {}) {
  svc.stop();
  svc.S.hooks.deck = null;
  svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings",
                   "escrow_holds", "escrow_moves", "escrow_meta"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  await runQuery("UPDATE users SET points_balance = 100000, casino_banned = 0");
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  await runQuery("DELETE FROM user_roles");
  await runQuery("DELETE FROM welcome_bonus");
  funding.sync({});
  await svc.boot({ tick: false });
  await svc.setSetting("hm_enabled", "1", "test");
  if (opts.sng !== null) await svc.setSetting("casino_sng", opts.sng || "everyone", "test");
}
/** a sit & go opened by `who` (registered) -> its table id */
async function sng(who, args) {
  const r = await S(who, "new", args);
  assert.ok(r.ok, r.reply);
  assert.match(String(r.table), /^[0-9a-f]{10}$/);
  return r.table;
}
async function fill(tid, players) {
  for (const p of players) { const r = await S(p, "join", [tid]); assert.ok(r.ok, `${p.name}: ${r.reply}`); }
}
/** every player all-in (or calls when that's all they can do) until the sit & go is over; `policy` may say otherwise per actor.
 *  Between hands the clock runs `gap` seconds (the blinds rise as it goes). -> the big blinds seen */
async function playOut(tid, { gap = 16, policy = null, max = 3000 } = {}) {
  const T = svc.getTable(tid);
  const bbs = [];
  for (let i = 0; i < max && T.tourney.status === "running"; i++) {
    const e = T.eng;
    if (e.hand_active) {
      if (!bbs.length || bbs[bbs.length - 1] !== e.bb) bbs.push(e.bb);
      const a = H.currentActor(e);
      let verb = policy ? policy(T, a) : null;
      if (!verb) verb = (e.street_paid[a] || 0) + (e.chips[a] || 0) > e.current_bet ? "allin" : "call";
      const r = await A(byUid[a], verb, [], tid);
      assert.ok(r.ok, `${a} ${verb}: ${r.reply}`);
    } else {
      await later(gap);
    }
  }
  assert.equal(T.tourney.status, "finished", "the sit & go played to the end");
  return bbs;
}
const foldPolicy = (T, a) => (H.toCall(T.eng, a) ? "fold" : "check");
/** the money of a finished sit & go: every entry held once, spent once by the one settle, the prizes + the House fee */
async function checkFinished(tid, n, buyin, fee, prizes) {
  const T = svc.getTable(tid);
  const holds = await getQuery("SELECT * FROM escrow_holds WHERE ref = ?", [`TNY-${tid}`]);
  assert.equal(holds.length, n);
  assert.ok(holds.every((h) => h.kind === "TNY" && h.state === "spent" && h.done_key === `tny:${tid}:finish` && h.amount === buyin + fee));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${tid}:finish`]))[0].n, 1);
  const fees = await getQuery("SELECT amount FROM jackpot_rakes WHERE spinId = ?", [`escrow:TNY-${tid}`]);
  assert.deepEqual(fees.map((r) => r.amount), fee ? [fee * n] : []);
  const places = T.tourney.places.slice().sort((a, b) => a.place - b.place);
  assert.deepEqual(places.map((p) => p.place), Array.from({ length: n }, (_, i) => i + 1), "every entrant placed once");
  assert.equal(places.reduce((s, p) => s + p.prize, 0), buyin * n, "the whole pool is paid out");
  assert.equal(places[0].prize, prizes[0], "the winner's prize");
  for (const p of places) assert.equal(await bal(p.uid), 100000 - buyin - fee + p.prize, `${p.uid}: entry out, prize in`);
  assert.equal(T.status, "closed");
  return places;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const p of P) await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 100000)",
                                    [p.uid, p.username, p.name, p.uid === "u1" ? "AnnCF" : null]);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES ('ad', 'ada', 'Ada', 'x', 'Admin', 100000)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES ('st', 'sam', 'Sam', 'x', 'Staff', 100000)");
  await funding.init();
  await ESC.init();
});
test.after(() => svc.stop());

test("the switch: off by default; staff = staff only; everyone = anyone; Hold'em on the site must be on; the settings are validated", async () => {
  await fresh({ sng: null });
  assert.equal((await svc.loadSettings(true)).casino_sng, "off");
  let r = await S(ann, "new", ["3", "1k"]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /switched off/i);
  assert.equal(await held(), 0);
  await svc.setSetting("casino_sng", "staff", "test");
  r = await S(ann, "new", ["3", "1k"]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /staff/i);
  const tid = await sng(sam, ["3", "1k"]);
  assert.equal((await S(ann, "join", [tid])).ok, false, "staff only: a member can't register");
  await svc.setSetting("casino_sng", "everyone", "test");
  assert.ok((await S(ann, "join", [tid])).ok);
  // switched off again: no new entries - but leaving (a full refund) always works
  await svc.setSetting("casino_sng", "off", "test");
  assert.equal((await S(bob, "join", [tid])).ok, false);
  assert.ok((await S(ann, "leave", [tid])).ok);
  assert.equal(await bal("u1"), 100000);
  await svc.setSetting("casino_sng", "everyone", "test");
  await svc.setSetting("hm_enabled", "0", "test");
  r = await S(bob, "new", ["3", "1k"]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /Hold'em/);
  await svc.setSetting("hm_enabled", "1", "test");
  // the settings: validated, normalised, and a registering sit & go keeps the ones it opened with
  for (const [kk, v] of [["casino_sng", "maybe"], ["sng_fee_pct", "60"], ["sng_fee_pct", "x"], ["sng_buyins", "0,5000"], ["sng_buyins", ""],
                         ["sng_payouts", "100|60,30|50,30,20"], ["sng_payouts", "100|35,65|50,30,20"], ["sng_payouts", "100|65,35"],
                         ["sng_payouts", "50,50|65,35|50,30,20,0"], ["sng_levels", "20/10"], ["sng_levels", "10/20,10/20"], ["sng_levels", ""],
                         ["sng_level_mins", "0"], ["sng_turbo_mins", "61"]]) {
    await assert.rejects(svc.setSetting(kk, v, "test"), undefined, `${kk}=${v} refused`);
  }
  await svc.setSetting("sng_buyins", "2000, 10k", "test");
  await svc.setSetting("sng_fee_pct", "5", "test");
  const st = await svc.loadSettings(true);
  assert.equal(st.sng_buyins, "2000,10000");
  assert.equal(st.sng_fee_pct, 5);
  assert.equal(svc.getTable(tid).tourney.fee, 100, "an open sit & go keeps its entry");
  assert.equal((await S(bob, "new", ["3", "1k"])).ok, false, "1K isn't on the list any more");
  const t2 = await sng(bob, ["3", "2k"]);
  assert.equal(svc.getTable(t2).tourney.fee, 100, "5% of 2,000");
  assert.equal(await bal("u2"), 100000 - 2100);
});

test("register / unregister / start when full: ONE TNY hold of buy-in + fee each, a full refund before the start, 1,500 chips at 10/20", async () => {
  await fresh();
  const t0 = await total();
  const tid = await sng(ann, ["3", "1k"]);
  const T = svc.getTable(tid);
  assert.equal(T.game, "holdem");
  assert.equal(T.tourney.status, "registering");
  assert.equal(T.eng.rake, 0, "no rake at a tournament table");
  assert.equal(await bal("u1"), 100000 - 1100);
  const h = await getQuery("SELECT * FROM escrow_holds WHERE state = 'held'");
  assert.equal(h.length, 1);
  assert.equal(h[0].kind, "TNY");
  assert.equal(h[0].ref, `TNY-${tid}`);
  assert.equal(h[0].amount, 1100);
  assert.ok(ESC.isServiceKind("TNY"), "a site service's hold");
  assert.equal((await ESC.holdsHeld()).length, 0, "never in Pepe's mirror");
  assert.match((await S(ann, "join", [tid])).reply, /already/i);
  assert.equal(await bal("u1"), 98900, "registering again holds nothing more");
  assert.ok((await S(bob, "join", [tid])).ok);
  assert.ok((await S(bob, "leave", [tid])).ok);
  assert.equal(await bal("u2"), 100000, "unregister = the whole entry back, fee included");
  assert.ok((await S(bob, "join", [tid])).ok);
  assert.equal(await bal("u2"), 98900);
  const keys = (await getQuery("SELECT key FROM escrow_moves WHERE key LIKE ? ORDER BY rowid", [`tny:${tid}:u2:%`])).map((r) => r.key);
  assert.deepEqual(keys, [`tny:${tid}:u2:enter:1`, `tny:${tid}:u2:refund:1`, `tny:${tid}:u2:enter:2`], "a new registration is a new key, never the old one replayed");
  assert.equal(T.tourney.status, "registering");
  assert.ok((await S(cat, "join", [tid])).ok);
  assert.equal(T.tourney.status, "running", "full: it starts");
  assert.equal(T.tourney.field, 3);
  assert.deepEqual(T.eng.seats, ["u1", "u2", "u3"]);
  assert.deepEqual(T.eng.seats.map((u) => T.eng.chips[u]), [1500, 1500, 1500]);
  assert.deepEqual([T.eng.sb, T.eng.bb], [10, 20]);
  assert.deepEqual(T.tourney.prizes, [3000], "2-3 players: the winner takes it all");
  assert.equal(await total(), t0, "PAT conserved");
  assert.equal((await S(dan, "join", [tid])).ok, false, "registration closed");
  assert.equal((await S(ann, "leave", [tid])).ok, false, "no unregister once it started");
  assert.equal(await bal("u1"), 98900);
  // the last one out of a registering sit & go closes it
  const t2 = await sng(dan, ["4", "5k"]);
  assert.equal(await bal("u4"), 100000 - 5500);
  assert.ok((await S(dan, "leave", [t2])).ok);
  assert.equal(await bal("u4"), 100000);
  assert.equal(svc.getTable(t2).status, "closed");
  assert.equal(svc.getTable(t2).tourney.status, "cancelled");
});

test("start at N: a 60 s countdown once N are in, stopped when one leaves, started by the clock with the field it has", async () => {
  await fresh();
  const tid = await sng(ann, ["6", "1k", "at", "3"]);
  const T = svc.getTable(tid);
  assert.equal(T.tourney.start_at, 3);
  await fill(tid, [bob]);
  assert.equal(T.tourney.countdown_at, null);
  await fill(tid, [cat]);
  assert.equal(T.tourney.countdown_at, NOW + 60000);
  await later(30);
  assert.ok((await S(cat, "leave", [tid])).ok);
  assert.equal(T.tourney.countdown_at, null, "below N: the countdown stops");
  await later(60);
  assert.equal(T.tourney.status, "registering");
  await fill(tid, [cat]);
  assert.equal(T.tourney.countdown_at, NOW + 60000, "a fresh countdown");
  await fill(tid, [dan]);
  await later(59);
  assert.equal(T.tourney.status, "registering");
  await later(2);
  assert.equal(T.tourney.status, "running");
  assert.equal(T.tourney.field, 4);
  assert.equal(T.eng.seats.length, 4);
  assert.deepEqual(T.tourney.prizes, [2600, 1400], "4 entrants: 65 / 35 of 4,000");
  // a full field starts at once, countdown or not
  const t2 = await sng(eve, ["3", "1k", "at", "2"]);
  await fill(t2, [fay]);
  assert.ok(svc.getTable(t2).tourney.countdown_at);
  await fill(t2, [P[6]]);
  assert.equal(svc.getTable(t2).tourney.status, "running");
});

test("the cash tables' entry rule: linked and same-address accounts refused; a wallet that can't cover the entry = refused, nothing held; banned", async () => {
  await fresh();
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES ('u3', 'u1')");
  const tid = await sng(ann, ["6", "1k"]);
  let r = await S(cat, "join", [tid]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /linked/);
  assert.ok((await S(Object.assign({}, bob, { iph: "ip-b" }), "join", [tid])).ok);
  r = await S(Object.assign({}, fay, { iph: "ip-b" }), "join", [tid]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /connection/);
  await runQuery("UPDATE users SET points_balance = 1099 WHERE userId = 'u4'");
  const h0 = await held(), w0 = await wallets();
  r = await S(dan, "join", [tid]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /insufficient PAT \(need 1,100, you have 1,099\)/);
  assert.equal(await bal("u4"), 1099);
  assert.equal(await held(), h0);
  assert.equal(await wallets(), w0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE user_id = 'u4'"))[0].n, 0, "nothing held");
  assert.equal(svc.getTable(tid).tourney.entrants.length, 2);
  r = await S(dan, "new", ["3", "1k"]);
  assert.equal(r.ok, false, "a creator who can't cover the entry opens nothing");
  assert.equal(svc.lobby().length + svc.TN.openList().length, 1);
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = 'u5'");
  r = await S(eve, "join", [tid]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /banned/);
  for (const bad of [["10", "1k"], ["1", "1k"], ["3", "2k"], ["3"], ["3", "1k", "at", "9"]]) {
    assert.equal((await S(bob, "new", bad)).ok, false, "refused: " + bad.join(" "));
  }
});

test("a full 6-player sit & go: the blinds rise, places, 65 / 35, the House fee, PAT conservation to the PAT, each hold settled once", async () => {
  await fresh();
  const w0 = await wallets(), h0 = await house();
  const t0 = w0 + h0;
  const tid = await sng(ann, ["6", "1k"]);
  await fill(tid, P.slice(1, 6));
  const T = svc.getTable(tid);
  assert.equal(T.tourney.status, "running");
  const wReg = await wallets(), hReg = await house(), heldReg = await held();
  assert.deepEqual([w0 - wReg, heldReg, hReg - h0], [6600, 6600, 0]);
  // fold round to the big blind while the clock runs (a level every 5 minutes), then everyone all-in
  const bbs = await playOut(tid, { gap: 100, policy: (TT, a) => (TT.eng.bb < 50 ? foldPolicy(TT, a) : null) });
  assert.ok(bbs[0] === 20 && bbs.includes(30) && bbs.includes(50), "10/20 -> 15/30 -> 25/50: " + bbs.join(","));
  for (let i = 1; i < bbs.length; i++) assert.ok(bbs[i] > bbs[i - 1], "the blinds only go up");
  const places = await checkFinished(tid, 6, 1000, 100, [3900, 2100]);
  assert.equal(places.slice(1).reduce((s, p) => s + p.prize, 0), 2100, "2nd (or two tied for it) share 35%");
  const wEnd = await wallets(), hEnd = await house(), heldEnd = await held();
  assert.deepEqual([wEnd - w0, hEnd - h0, heldEnd], [-600, 600, 0]);
  assert.equal(wEnd + hEnd + heldEnd, t0, "PAT conservation: wallets + escrow + House before = after");
  console.log(`# CONSERVATION 6-player 1K: before wallets ${w0} house ${h0} held 0 = ${t0} | registered wallets ${wReg} house ${hReg} held ${heldReg} = ${wReg + hReg + heldReg} | finished wallets ${wEnd} house ${hEnd} held ${heldEnd} = ${wEnd + hEnd + heldEnd} | prizes ${places.map((p) => p.place + ":" + p.prize).join(" ")} fee 600`);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type LIKE 'holdem%'"))[0].n, 0, "no cash-table money moved");
  const lines = (await getQuery("SELECT data FROM casino_events WHERE table_id = ? ORDER BY seq", [tid])).map((r) => JSON.parse(r.data).text || "");
  assert.equal(lines.filter((l) => /^🏁 .+ finished \d/.test(l)).length, 5, "a room line per bust-out");
  assert.ok(lines.some((l) => /Blinds up/i.test(l)), "a line when the blinds go up");
  assert.ok(lines.some((l) => /wins the Sit & Go/.test(l)), "the winner's line");
});

test("2-, 3- and 9-player runs: the payout bands (100 / 100 / 50-30-20), conservation, heads-up = the button posts the small blind", async () => {
  for (const [n, buyin, prizes] of [[2, "1k", [2000]], [3, "5k", [15000]], [9, "1k", [4500, 2700, 1800]]]) {
    await fresh();
    const t0 = await total();
    const tid = await sng(P[0], [String(n), buyin]);
    await fill(tid, P.slice(1, n));
    const T = svc.getTable(tid);
    assert.deepEqual(T.tourney.prizes, prizes);
    if (n === 2) {
      await later(16);
      assert.equal(T.eng.hand_active, true);
      assert.equal(T.eng.sb_key, T.eng.button, "heads-up: the button is the small blind");
      assert.equal(H.currentActor(T.eng), T.eng.button, "and acts first preflop");
    }
    await playOut(tid, { gap: 60 });
    const b = n === 3 ? 5000 : 1000;
    await checkFinished(tid, n, b, b / 10, prizes);
    assert.equal(await total(), t0, `${n} players: PAT conserved`);
  }
});

test("level changes apply only between hands; the next level runs from when the last one ended; turbo = 3-minute levels", async () => {
  await fresh();
  const tid = await sng(ann, ["2", "1k"]);
  await fill(tid, [bob]);
  const T = svc.getTable(tid);
  const ends = T.tourney.level_ends_at;
  assert.equal(ends, NOW + 5 * 60000);
  await later(16);
  assert.equal(T.eng.hand_active, true);
  assert.equal(T.eng.bb, 20);
  const endAt = NOW + 1000;
  T.tourney.level_ends_at = endAt;                   // the level runs out in the middle of this hand
  await later(2);
  assert.equal(T.tourney.level, 1, "the clock moved to level 2");
  assert.equal(T.eng.bb, 20, "but this hand keeps its blinds");
  assert.ok(T.eng.hand_active);
  while (T.eng.hand_active) assert.ok((await A(byUid[H.currentActor(T.eng)], H.toCall(T.eng, H.currentActor(T.eng)) ? "call" : "check", [], tid)).ok);
  await later(16);
  assert.ok(T.eng.hand_active);
  assert.deepEqual([T.eng.sb, T.eng.bb], [15, 30], "the next hand plays level 2");
  assert.equal(T.tourney.level_ends_at, endAt + 5 * 60000, "level 2 runs 5 minutes from when level 1 ended");
  // turbo: 3-minute levels
  const t2 = await sng(cat, ["2", "1k", "turbo"]);
  await fill(t2, [dan]);
  assert.equal(svc.getTable(t2).tourney.level_ends_at, NOW + 3 * 60000);
});

test("two bust-outs on one hand: the bigger starting stack places higher; equal stacks split their places' prizes, the odd PAT to the higher place", async () => {
  // A covers three 1,000-chip all-ins with quad aces: B, C, D are out on the same hand
  const QUADS = ["As", "Ad", "7c", "2d", "8h", "3s", "9d", "4c", "Ah", "Ac", "Kd", "Qs", "Jh"];
  for (const [stacks, want] of [
    [{ u1: 3000, u2: 1000, u3: 1000, u4: 1000 }, { u1: [1, 2600], u2: [2, 467], u3: [3, 467], u4: [4, 466] }],     // equal: 1,400 / 3, the odd PAT up
    [{ u1: 3000, u2: 1200, u3: 900, u4: 900 }, { u1: [1, 2600], u2: [2, 1400], u3: [3, 0], u4: [4, 0] }],          // B started bigger: 2nd
  ]) {
    await fresh();
    const tid = await sng(ann, ["4", "1k"]);
    await fill(tid, [bob, cat, dan]);
    const T = svc.getTable(tid);
    Object.assign(T.eng.chips, stacks);                // (still 6,000 tournament chips in play)
    deck(QUADS);
    await later(16);
    assert.equal(T.eng.button, "u1", "hand 1: the first seat has the button; the odd-chip order runs B, C, D");
    await playOut(tid, { policy: (TT, a) => (a === "u1" ? "call" : null) });
    const got = Object.fromEntries(T.tourney.places.map((p) => [p.uid, [p.place, p.prize]]));
    assert.deepEqual(got, want);
    assert.equal(T.tourney.hand_start, null);
    await checkFinished(tid, 4, 1000, 100, [2600]);
  }
});

test("restart: after registration and mid-countdown nothing moves; mid-level the level keeps the time it had left; nothing pays twice", async () => {
  await fresh();
  const tid = await sng(ann, ["3", "1k"]);
  await fill(tid, [bob]);
  svc.stop();
  await svc.boot({ tick: false });
  let T = svc.getTable(tid);
  assert.equal(T.tourney.status, "registering");
  assert.equal(T.tourney.entrants.length, 2);
  assert.equal(await held(), 2200);
  assert.deepEqual([await bal("u1"), await bal("u2")], [98900, 98900], "nothing refunded, nothing taken twice");
  await fill(tid, [cat]);
  assert.equal(T.tourney.status, "running");
  // the countdown keeps the time it had left when the site went down
  const t2 = await sng(dan, ["5", "1k", "at", "2"]);
  await fill(t2, [eve]);
  svc.stop();
  NOW += 300 * 1000;                                 // five minutes down
  await svc.boot({ tick: false });
  const C = svc.getTable(t2);
  assert.equal(C.tourney.countdown_at - NOW, 60000);
  assert.equal(C.tourney.status, "registering");
  // mid-level, mid-hand: the hand and the level carry on
  T = svc.getTable(tid);
  await later(16);
  assert.ok(T.eng.hand_active);
  await A(byUid[H.currentActor(T.eng)], "call", [], tid);
  const left = T.tourney.level_ends_at - NOW;
  const hand = T.eng.hand_no;
  svc.stop();
  NOW += 600 * 1000;                                 // ten minutes down
  await svc.boot({ tick: false });
  T = svc.getTable(tid);
  assert.equal(T.tourney.level, 0, "no level passed while the site was down");
  assert.equal(T.tourney.level_ends_at - NOW, left, "the level keeps the time it had left");
  assert.ok(T.eng.hand_active && T.eng.hand_no === hand && T.dl.turn > NOW, "the hand carries on with a fresh clock for the actor");
  await playOut(tid);
  await checkFinished(tid, 3, 1000, 100, [3000]);
  const b = await Promise.all(["u1", "u2", "u3"].map(bal));
  svc.stop();
  await svc.boot({ tick: false });
  assert.deepEqual(await Promise.all(["u1", "u2", "u3"].map(bal)), b, "a restart after the finish changes nothing");
  assert.equal(svc.getTable(tid), null, "a finished sit & go isn't reloaded");
});

test("restart: a crash before the places are saved replays the same bust-outs; one before the settle pays once; a lost final save pays nothing more", async () => {
  await fresh();
  const t0 = await total();
  const tid = await sng(ann, ["3", "1k"]);
  await fill(tid, [bob, cat]);
  let T = svc.getTable(tid);
  Object.assign(T.eng.chips, { u1: 2500, u2: 1000, u3: 1000 });
  deck(["As", "Ad", "7c", "2d", "8h", "3s", "Ah", "Ac", "Kd", "Qs", "Jh"]);
  await later(16);
  svc.S.hooks.crash = "sng:place";                   // the hand ends, the site dies before the bust-outs are placed
  await playOut(tid, { max: 20, policy: (TT, a) => (a === "u1" ? "call" : null) }).catch(() => {});
  assert.ok(!T.tourney.places.length || T.tourney.status !== "finished");
  svc.S.hooks.crash = "sng:settle";                  // ... and on the way back up, again just before the payout
  svc.stop();
  await svc.boot({ tick: false });
  T = svc.getTable(tid);
  assert.ok(T, "still open: the payout hasn't happened");
  assert.equal(T.tourney.status, "settling");
  assert.deepEqual(T.tourney.places.map((p) => [p.uid, p.place]).sort(), [["u1", 1], ["u2", 2], ["u3", 3]], "B and C out on one hand: same start stacks, odd-chip order");
  assert.equal(await held(), 3300, "nothing paid yet");
  const saved = (await getQuery("SELECT state FROM casino_tables WHERE id = ?", [tid]))[0].state;
  svc.S.hooks.crash = null;
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(svc.getTable(tid).status, "closed");
  assert.equal(await bal("u1"), 100000 - 1100 + 3000);
  assert.equal(await total(), t0);
  // the settle committed, but say the table's final save was lost: the old "settling" state comes back at the next start
  await runQuery("UPDATE casino_tables SET status = 'open', state = ? WHERE id = ?", [saved, tid]);
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(svc.getTable(tid).tourney.status, "finished");
  assert.equal(await bal("u1"), 100000 - 1100 + 3000, "paid exactly once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes WHERE spinId = ?", [`escrow:TNY-${tid}`]))[0].n, 1, "the fee booked once");
  assert.equal(await total(), t0);
  await checkFinished(tid, 3, 1000, 100, [3000]);
});

test("cancel: an admin with the casino capability refunds every entry in full (fee included), registering or running; a member can't", async () => {
  await fresh();
  const t0 = await total();
  const tid = await sng(ann, ["4", "1k"]);
  await fill(tid, [bob]);
  let r = await S(bob, "cancel", [tid]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /admin/i);
  r = await S(Object.assign({}, bob, { admin: true }), "cancel", [tid]);
  assert.equal(r.ok, false, "Pepe's own admin flag isn't the site's casino capability");
  r = await S(ada, "cancel", [tid]);
  assert.ok(r.ok, r.reply);
  assert.deepEqual([await bal("u1"), await bal("u2")], [100000, 100000]);
  assert.equal(await held(), 0);
  assert.equal(svc.getTable(tid).tourney.status, "cancelled");
  assert.equal((await S(ada, "cancel", [tid])).ok, false, "only once");
  // running, mid-hand
  const t2 = await sng(cat, ["3", "1k"]);
  await fill(t2, [dan, eve]);
  await later(16);
  assert.ok(svc.getTable(t2).eng.hand_active);
  r = await S(ada, "cancel", [t2, "test"]);
  assert.ok(r.ok, r.reply);
  assert.deepEqual(await Promise.all(["u3", "u4", "u5"].map(bal)), [100000, 100000, 100000]);
  assert.equal(await total(), t0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE ref = ? AND state = 'refunded'", [`TNY-${t2}`]))[0].n, 3);
  assert.equal(svc.getTable(t2).status, "closed");
});

test("tournament chips never become PAT: no buy-in, cash-out, close or idle close; sitting out = blinded, never stood up; no rake", async () => {
  await fresh();
  const tid = await sng(ann, ["2", "1k"]);
  await fill(tid, [bob]);
  const T = svc.getTable(tid);
  for (const [who, verb, args] of [[ann, "stand"], [ann, "leave"], [ann, "cashout"], [ann, "sit", ["1000"]], [ann, "end"], [ann, "deal"]]) {
    const r = await A(who, verb, args || [], tid);
    assert.equal(r.ok, false, verb + " refused");
  }
  assert.ok((await A(ann, "sitout", [], tid)).ok);
  assert.ok((await A(bob, "sitout", [], tid)).ok);
  const hands = T.eng.hand_no;
  for (let i = 0; i < 40; i++) await later(16);         // ten minutes and more of everyone sitting out
  assert.ok(T.eng.hand_no > hands + 10, "hands keep coming with everyone sitting out");
  assert.deepEqual(T.eng.seats.sort(), ["u1", "u2"], "nobody stood up");
  assert.ok(!T.dl.idle, "never an idle close");
  assert.equal(T.eng.chips.u1 + T.eng.chips.u2, 3000);
  assert.ok((await A(ann, "sitin", [], tid)).ok);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type LIKE 'holdem%'"))[0].n, 0);
  assert.equal(await house(), 10000000, "no rake, no fee yet");
  assert.deepEqual([await bal("u1"), await bal("u2")], [98900, 98900]);
});

test("the web and Pepe: lobby block, create / register / unregister / cancel routes, the table view, BOT_VERBS, the poll's tourney block", async () => {
  await fresh();
  const express = require("express");
  const routes = require(path.join(repo, "casino", "routes"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const users = { u1: { userId: "u1", username: "ann" }, u2: { userId: "u2", username: "bob" }, ad: { userId: "ad", username: "ada" } };
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); });
  routes.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  // (each account from its own address, as in test/casino-ui.test.js - one address for two accounts is refused, like at a cash table)
  const ips = { u1: "10.0.0.1", u2: "10.0.0.2", ad: "10.0.0.9" };
  const hd = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", "x-forwarded-for": ips[uid] || "10.0.0.99" },
                                    uid ? { "x-test-user": uid } : {});
  const post = async (url, body, uid) => (await fetch(base + url, { method: "POST", headers: hd(uid), body: JSON.stringify(body) })).json();
  const get = async (url, uid) => (await fetch(base + url, { headers: hd(uid) })).json();
  try {
    for (const v of ["list", "new", "join", "leave", "info", "cancel", ""]) assert.ok(routes.BOT_VERBS.has(v), "BOT_VERBS: " + v);
    let j = await post("/api/casino/sng/new", { size: 3, buyin: 1000, turbo: true, start_at: null, idem: "sng-web-new-01" }, "u1");
    assert.ok(j.ok, JSON.stringify(j));
    const tid = j.table;
    assert.equal((await post("/api/casino/sng/new", { size: 3, buyin: 1000, idem: "sng-web-new-01" }, "u1")).replayed, true, "idempotent");
    assert.equal(await bal("u1"), 98900);
    j = await get("/api/casino/lobby", "u2");
    assert.equal(j.sng.on, true);
    assert.deepEqual(j.sng.buyins, [1000, 5000, 25000, 100000]);
    assert.equal(j.sng.fee_pct, 10);
    const row = j.sng.list.find((x) => x.id === tid);
    assert.ok(row && row.registered === 1 && row.size === 3 && row.turbo === true && row.entry === 1100 && row.me === false, JSON.stringify(row));
    assert.ok(!j.tables.some((t) => t.id === tid), "not a cash table in the lobby");
    assert.ok((await post(`/api/casino/sng/${tid}/register`, { idem: "sng-web-reg-02" }, "u2")).ok);
    assert.equal((await get("/api/casino/lobby", "u2")).sng.list.find((x) => x.id === tid).me, true);
    assert.ok((await post(`/api/casino/sng/${tid}/unregister`, { idem: "sng-web-unr-02" }, "u2")).ok);
    assert.equal(await bal("u2"), 100000);
    assert.equal((await post(`/api/casino/sng/${tid}/register`, { idem: "x" }, "u2")).ok, false, "a bad idem is refused");
    assert.equal((await post(`/api/casino/sng/${tid}/register`, { idem: "sng-web-reg-03" })).ok, false, "signed out");
    // the table view: the tourney block, names only (no account ids, no hold ids)
    const d = await get(`/api/casino/t/${tid}`, "u2");
    assert.equal(d.table.tourney.status, "registering");
    assert.deepEqual(d.table.tourney.entrants.map((x) => x.name), ["Ann"]);
    assert.ok(!/"u1"|"s\d+"/.test(JSON.stringify(d.table)), "no account or hold ids in the view");
    assert.equal(d.me.tourney.registered, false);
    // Pepe: !sng new in a room, !sng join (no id = the room's), the poll carries the board's tourney block
    const bot = (verb, args, who, extra) => post("/api/casino/bot/act", Object.assign({ password: "bot", username: who, name: who, room: "Lab", game: "sng", verb, args,
                                                                                         idem: "sng-bot-" + verb + "-" + who + "-" + (k++) }, extra || {}));
    j = await bot("new", ["2", "1k", "turbo"], "cat");
    assert.ok(j.ok, JSON.stringify(j));
    const rid = j.table;
    assert.equal(svc.getTable(rid).room, "Lab");
    j = await bot("join", [], "dan");
    assert.ok(j.ok, JSON.stringify(j));
    assert.equal(svc.getTable(rid).tourney.status, "running");
    j = await bot("", [], "dan");
    assert.ok(j.ok && /Sit & Go/i.test(j.reply), JSON.stringify(j));
    j = await bot("info", [rid.slice(0, 6)], "dan");
    assert.ok(j.ok && /Level 1/i.test(j.reply), j.reply);
    assert.equal((await bot("cancel", [rid], "dan")).ok, false);
    const poll = await post("/api/casino/bot/poll", { password: "bot", after: -1, wait: 0, rooms: [{ id: "Lab", name: "Lab" }] });
    const tb = poll.tables[rid].tourney;
    assert.ok(tb && tb.level === 1 && tb.sb === 10 && tb.bb === 20 && tb.players_left === 2 && tb.level_secs_left === 180 && tb.next_sb === 15, JSON.stringify(tb));
    assert.ok(Array.isArray(poll.sng) && poll.sng.some((x) => x.id === rid), "the poll lists the open sit & gos");
    // the admin's cancel route
    assert.equal((await post(`/api/casino/sng/${tid}/cancel`, { idem: "sng-web-can-01" }, "u2")).ok, false);
    j = await post(`/api/casino/sng/${tid}/cancel`, { idem: "sng-web-can-02", reason: "test" }, "ad");
    assert.ok(j.ok, JSON.stringify(j));
    assert.equal(await bal("u1"), 100000);
    // the settings route takes the new keys (an admin)
    assert.ok((await post("/api/casino/admin/settings", { key: "sng_turbo_mins", value: "2" }, "ad")).ok);
    assert.equal((await post("/api/casino/admin/settings", { key: "sng_payouts", value: "90|65,35|50,30,20" }, "ad")).ok, false);
    // the pages
    let html = await (await fetch(base + "/casino/holdem", { headers: hd("u1") })).text();
    for (const s of ['id="cz-sng"', 'id="cz-sngs"', 'id="cz-sngnew"', 'id="cz-sng-size"', 'id="cz-sng-go"']) assert.ok(html.includes(s), s);
    html = await (await fetch(base + `/casino/holdem/t/${rid}`, { headers: hd("u1") })).text();
    for (const s of ['id="cz-snghead"', 'id="cz-sngres"']) assert.ok(html.includes(s), s);
  } finally {
    server.close();
  }
});

test("Pepe's stream: a sit & go takes the stream slot like a cash table", async () => {
  await fresh();
  const tid = await sng(ann, ["2", "1k"]);
  const r = await svc.stream(tid, true, ann, false);
  assert.ok(r.ok, r.reply);
  assert.equal(svc.S.stream.table, tid);
  assert.equal(svc.publicView(svc.getTable(tid)).on_stream, true);
});

test("a registering sit & go that doesn't fill in an hour is called off: every entry back in full", async () => {
  await fresh();
  const tid = await sng(ann, ["6", "1k"]);
  await fill(tid, [bob]);
  await later(59 * 60);
  assert.equal(svc.getTable(tid).tourney.status, "registering");
  await later(61);
  assert.equal(svc.getTable(tid).tourney.status, "cancelled");
  assert.deepEqual([await bal("u1"), await bal("u2")], [100000, 100000]);
  assert.equal(await held(), 0);
});

test("escrow guard: the settle refuses to pay out less than it holds (never a silent 'kept')", async () => {
  await fresh();
  const tid = await sng(ann, ["2", "1k"]);
  await fill(tid, [bob]);
  const T = svc.getTable(tid);
  T.tourney.places = [{ uid: "u1", name: "Ann", place: 1, prize: 2000 }, { uid: "u2", name: "Bob", place: 2, prize: 0 }];
  const plan = svc.TN.settlePlan(T);
  assert.deepEqual([plan.held, plan.out, plan.fee], [2200, 2200, 200], "a whole plan: prizes + the fee = what's held");
  // tamper with the plan in memory: a prize short by one PAT must never settle (the rest would be "kept")
  T.tourney.places[0].prize = 1999;
  T.tourney.status = "settling";
  T.tourney.settle = { key: `tny:${tid}:finish`, at: NOW };
  assert.equal(await svc.TN.settleNow(T), false);
  assert.equal(await held(), 2200, "nothing moved");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${tid}:finish`]))[0].n, 0);
});
