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
                   "escrow_holds", "escrow_moves", "escrow_meta", "admin_audit"]) {
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
  // (review) each cancel is in the admin log: who, which sit & go, how many entries, how much went back, the reason
  const audit = await getQuery("SELECT admin_id, action, detail, reason FROM admin_audit WHERE action = 'casino_sng_cancel' ORDER BY id");
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map((a) => a.admin_id), ["ad", "ad"]);
  assert.deepEqual(audit.map((a) => JSON.parse(a.detail)), [{ sng: tid, status: "registering", entrants: 2, refunded: 2200 },
                                                            { sng: t2, status: "running", entrants: 3, refunded: 3300 }]);
  assert.deepEqual(audit.map((a) => a.reason), [null, "test"]);
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
    // (review) ... never as a cash table in `open` (Pepe would list it twice), and the switch rides along (Pepe's off-site answer)
    assert.ok(Array.isArray(poll.open) && !poll.open.some((x) => x.id === rid || x.id === tid), "no sit & go in the poll's open cash tables");
    assert.equal(poll.sng_on, "everyone", "the poll carries the Sit & Go switch");
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

test("a call-off whose refunds fail is tried again a minute later (not on every tick), then refunds in full", async () => {
  await fresh();
  const tid = await sng(ann, ["6", "1k"]);
  const T = svc.getTable(tid);
  const hid = T.tourney.entrants[0].hid;
  T.tourney.entrants[0].hid = "s-missing";            // the refund can't find its hold: the whole call-off rolls back
  await later(60 * 60 + 1);
  assert.equal(T.tourney.status, "registering");
  assert.equal(T.tourney.expires_at, NOW + 60000, "tried again in a minute");
  assert.equal(await bal("u1"), 98900, "nothing moved");
  T.tourney.entrants[0].hid = hid;
  await later(61);
  assert.equal(T.tourney.status, "cancelled");
  assert.equal(await bal("u1"), 100000);
});

// ── h22 review (1.99??): what the review found, each pinned ──
const roomP = (p, r) => Object.assign({}, p, { via: "room", room: r || "Lab" });
const eventsOf = async (tid) => (await getQuery("SELECT kind, data FROM casino_events WHERE table_id = ? ORDER BY seq", [tid]))
  .map((r) => Object.assign({ kind: r.kind }, JSON.parse(r.data)));
const QUADS3 = ["As", "Ad", "7c", "2d", "8h", "3s", "Ah", "Ac", "Kd", "Qs", "Jh"];       // hand 1 of three: Ann (u1) holds quad aces
/** play the hand in progress to its end (the replies aren't checked - a test crash may answer "something went wrong") */
async function playHand(tid, policy) {
  const T = svc.getTable(tid);
  for (let i = 0; i < 60 && T.eng.hand_active; i++) {
    const a = H.currentActor(T.eng);
    let verb = policy ? policy(T, a) : null;
    if (!verb) verb = (T.eng.street_paid[a] || 0) + (T.eng.chips[a] || 0) > T.eng.current_bet ? "allin" : "call";
    await A(byUid[a], verb, [], tid);
  }
}

test("review: at a registering sit & go's table !sit registers (an amount that isn't the entry is refused), !stand unregisters, !holdem status / help / start are the sit & go's; a room player hears what's held", async () => {
  await fresh();
  const r0 = await S(roomP(ann), "new", ["3", "1k"], { room: "Lab" });
  assert.ok(r0.ok, r0.reply);
  const tid = r0.table, T = svc.getTable(tid);
  assert.equal(T.room, "Lab");
  const bobR = roomP(bob);
  let r = await A(bobR, "sit", ["2000"], tid);
  assert.equal(r.ok, false, "a cash-table buy-in isn't a sit & go entry");
  assert.match(r.reply, /Sit & Go/);
  assert.match(r.reply, /1,100 PAT/);
  for (const v of ["buyin", "buy", "join"]) assert.equal((await A(bobR, v, ["5000"], tid)).ok, false, `${v} 5000 refused`);
  assert.equal(await bal("u2"), 100000, "nothing held");
  assert.equal(T.tourney.entrants.length, 1);
  r = await A(bobR, "sit", ["1,000"], tid);          // the buy-in itself (or the whole entry) means the entry
  assert.ok(r.ok, r.reply);
  assert.ok(!r.quiet, "a room player is told what was held (the room line doesn't say it)");
  assert.match(r.reply, /1,100 PAT held/);
  assert.equal(await bal("u2"), 98900);
  r = await A(bobR, "stand", [], tid);
  assert.ok(r.ok, r.reply);
  assert.equal(await bal("u2"), 100000, "!stand before the start = the whole entry back");
  r = await A(bobR, "sit", [], tid);
  assert.ok(r.ok && !r.quiet && /1,100 PAT held/.test(r.reply), r.reply);
  r = await A(roomP(cat), "sit", ["1100"], tid);       // the whole entry typed out: also the entry - and it's full: it starts
  assert.ok(r.ok, r.reply);
  assert.equal(T.tourney.status, "running");
  const t2 = await sng(dan, ["4", "1k"]);
  r = await A(eve, "status", [], t2);
  assert.ok(r.ok);
  assert.match(r.reply, /Sit & Go #/);
  assert.match(r.reply, /Registered 1\/4/);
  r = await A(eve, "help", [], t2);
  assert.match(r.reply, /^🏁 Sit & Go/, "!holdem help at a sit & go's table is the sit & go's help");
  r = await svc.act(roomP(eve), "start", [], { game: "holdem", room: "Lab", table: tid }, key());
  assert.equal(r.ok, false);
  assert.match(r.reply, /Sit & Go/, "!holdem start in its room points at the sit & go, not '!sit to join'");
  assert.equal((await A(eve, "leave", [], t2)).ok, false, "not registered: nothing to leave");
});

test("review: a hand's wrap-up that throws after the last bust-out doesn't leave the sit & go running forever - in memory, and after a restart", async () => {
  for (const restart of [false, true]) {
    await fresh();
    const tid = await sng(ann, ["3", "1k"]);
    await fill(tid, [bob, cat]);
    let T = svc.getTable(tid);
    Object.assign(T.eng.chips, { u1: 2500, u2: 1000, u3: 1000 });
    deck(QUADS3);
    await later(16);
    assert.ok(T.eng.hand_active);
    svc.S.hooks.crash = "sng:place";                  // the hand's wrap-up throws (a failed write) after its proof, before the places
    await playHand(tid, (TT, a) => (a === "u1" ? "call" : null));
    assert.equal(T.eng.hand_active, false);
    assert.equal(T.tourney.status, "running");
    assert.equal(T.tourney.places.length, 0);
    if (restart) {
      await later(301);                               // a level goes up: the table is saved as it stands (hand over, nobody placed)
      svc.stop();
      svc.S.hooks.crash = null;
      await svc.boot({ tick: false });
      T = svc.getTable(tid);
      assert.ok(T && T.tourney.status === "running" && !T.hand, "the saved state: running, no hand, nobody placed");
    } else {
      svc.S.hooks.crash = null;
    }
    for (let i = 0; i < 8 && T.tourney.status !== "finished"; i++) await later(16);
    assert.equal(T.tourney.status, "finished", `${restart ? "after a restart" : "without a restart"}: the next tick places them and pays out`);
    await checkFinished(tid, 3, 1000, 100, [3000]);
  }
});

test("review: a create retried under a new key (a lost reply, a restart, a double click) doesn't open a second sit & go or hold the entry twice", async () => {
  await fresh();
  const tid = await sng(ann, ["6", "1k"]);
  let r = await S(ann, "new", ["6", "1k"]);
  assert.ok(r.ok, r.reply);
  assert.equal(r.table, tid, "the one just opened");
  assert.equal(await bal("u1"), 98900, "the entry is held once");
  assert.equal(svc.TN.openList().length, 1);
  svc.stop();
  await svc.boot({ tick: false });                    // the reply was lost to a restart
  r = await S(ann, "new", ["6", "1k"]);
  assert.equal(r.table, tid);
  assert.equal(await bal("u1"), 98900);
  const t2 = await sng(ann, ["6", "5k"]);             // a different sit & go is a new one
  assert.notEqual(t2, tid);
  await later(121);
  const t3 = await sng(ann, ["6", "1k"]);             // and the same one again a while later too
  assert.notEqual(t3, tid);
  assert.equal(await bal("u1"), 100000 - 1100 - 5500 - 1100);
});

test("review: when the button busts, the button moves on clockwise - the blinds never jump back to the first seat", async () => {
  await fresh();
  const tid = await sng(ann, ["4", "1k"]);
  await fill(tid, [bob, cat, dan]);
  const T = svc.getTable(tid);
  for (let h = 1; h <= 2; h++) {
    await later(16);
    assert.equal(T.eng.hand_no, h);
    await playHand(tid, foldPolicy);
  }
  // hand 3: Cat (u3) on the button goes all-in and loses to Ann (u1) in the big blind
  Object.assign(T.eng.chips, { u1: 2000, u2: 1500, u3: 500, u4: 2000 });
  deck(["As", "Ad", "7c", "2d", "8h", "3s", "9d", "4c", "Ah", "Kc", "Qd", "Js", "5h"]);
  await later(16);
  assert.deepEqual([T.eng.hand_no, T.eng.button, T.eng.sb_key, T.eng.bb_key], [3, "u3", "u4", "u1"]);
  await playHand(tid, (TT, a) => (a === "u3" ? "allin" : a === "u1" ? "call" : "fold"));
  assert.deepEqual(T.eng.seats, ["u1", "u2", "u4"], "Cat is out");
  svc.S.hooks.deck = null;
  await later(16);
  assert.deepEqual([T.eng.hand_no, T.eng.button, T.eng.sb_key, T.eng.bb_key], [4, "u4", "u1", "u2"],
                   "Dan has the button, Ann the small blind, Bob the big blind");
});

test("review: the odd PAT among tied bust-outs follows the hand's odd-chip order (clockwise from the button), not the seat order", async () => {
  await fresh();
  const tid = await sng(ann, ["4", "1k"]);
  await fill(tid, [bob, cat, dan]);
  const T = svc.getTable(tid);
  for (let h = 1; h <= 2; h++) { await later(16); await playHand(tid, foldPolicy); }
  // hand 3, Cat (u3) on the button with quad aces: Dan, Ann and Bob are all in with 1,000 each and all out
  Object.assign(T.eng.chips, { u1: 1000, u2: 1000, u3: 3000, u4: 1000 });
  deck(["7c", "2d", "8h", "3s", "As", "Ad", "9d", "4c", "Ah", "Ac", "Kd", "Qs", "Jh"]);
  await later(16);
  assert.equal(T.eng.button, "u3");
  await playOut(tid, { policy: (TT, a) => (a === "u3" ? "call" : null) });
  const got = Object.fromEntries(T.tourney.places.map((p) => [p.uid, [p.place, p.prize]]));
  assert.deepEqual(got, { u3: [1, 2600], u4: [2, 467], u1: [3, 467], u2: [4, 466] }, "Dan, Ann, Bob: after the button, clockwise");
  await checkFinished(tid, 4, 1000, 100, [2600]);
});

test("review: a start-at-N countdown running when the registration hour ends runs out - it starts, it isn't called off", async () => {
  await fresh();
  const tid = await sng(ann, ["6", "1k", "at", "4"]);
  const T = svc.getTable(tid);
  await fill(tid, [bob, cat]);
  await later(59 * 60 + 30);
  await fill(tid, [dan]);
  assert.equal(T.tourney.countdown_at, NOW + 60000);
  await later(31);                                    // the hour is up; the countdown has 29 s to go
  assert.equal(T.tourney.status, "registering", "not called off: its start rule is met");
  assert.equal(await held(), 4400);
  await later(30);
  assert.equal(T.tourney.status, "running");
  assert.equal(T.tourney.field, 4);
});

test("review: !sitout at a sit & go starts with the next hand (this hand is still yours); a seat that is out never burns its time bank", async () => {
  await fresh();
  let tid = await sng(ann, ["3", "1k"]);
  await fill(tid, [bob, cat]);
  let T = svc.getTable(tid);
  await later(16);
  assert.equal(H.currentActor(T.eng), "u1");
  let r = await A(cat, "sitout", [], tid);            // Cat, the big blind, sits out while Ann is to act
  assert.ok(r.ok);
  assert.match(r.reply, /next hand/);
  assert.ok((await A(ann, "raise", ["60"], tid)).ok);
  assert.ok((await A(bob, "fold", [], tid)).ok);
  assert.equal(H.currentActor(T.eng), "u3", "Cat still plays this hand: Ann's raise is hers to answer");
  assert.ok(!T.eng.folded.includes("u3"));
  assert.ok((await A(cat, "call", [], tid)).ok);
  for (let i = 0; i < 20 && T.eng.hand_active; i++) assert.ok((await A(byUid[H.currentActor(T.eng)], "check", [], tid)).ok);
  assert.equal(T.eng.hand_active, false);
  await later(16);
  assert.equal(T.eng.hand_no, 2);
  assert.equal(H.currentActor(T.eng), "u2");
  assert.ok((await A(bob, "call", [], tid)).ok);
  assert.ok(T.eng.folded.includes("u3"), "the next hand: sitting out, Cat's small blind folds at once");
  assert.equal(H.currentActor(T.eng), "u1");
  // sitting out on your own turn: the 60 s run out, then a check / fold - the time bank is kept for when you're back
  await fresh();
  tid = await sng(ann, ["3", "1k"]);
  await fill(tid, [bob, cat]);
  T = svc.getTable(tid);
  await later(16);
  assert.equal(H.currentActor(T.eng), "u1");
  const bank0 = T.qol.u1.bank;
  assert.ok(bank0 > 0);
  assert.ok((await A(ann, "sitout", [], tid)).ok);
  await later(61);
  assert.ok(T.eng.folded.includes("u1"), "Ann's clock ran out: she folds");
  assert.equal(T.qol.u1.bank, bank0, "her time bank is untouched");
  assert.ok(!(await eventsOf(tid)).some((ev) => /time bank/.test(ev.text || "")), "no time bank was used");
});

test("review: the view's countdown is also given in seconds on the site's clock (Pepe's board doesn't depend on his own clock)", async () => {
  await fresh();
  const tid = await sng(ann, ["6", "1k", "at", "2"]);
  await fill(tid, [bob]);
  await later(20);
  const v = svc.publicView(svc.getTable(tid)).tourney;
  assert.equal(v.countdown_at, NOW - 20000 + 60000);
  assert.equal(v.countdown_secs_left, 40);
  const v2 = svc.publicView(svc.getTable(await sng(cat, ["6", "1k"]))).tourney;
  assert.equal(v2.countdown_secs_left, null, "no countdown: null");
});

test("review: switched off (or staff only for a member), !sng / help / info say so - an entrant still sees theirs and can leave", async () => {
  await fresh();
  const tid = await sng(ann, ["3", "1k"]);
  await svc.setSetting("casino_sng", "off", "test");
  for (const [verb, args] of [["", []], ["list", []], ["help", []], ["info", [tid]], ["", [tid.slice(0, 6)]]]) {
    const r = await S(bob, verb, args);
    assert.match(r.reply, /switched off/, `${verb || "(none)"} ${args.join(" ")}: ${r.reply}`);
    assert.ok(!/!sng new/.test(r.reply), "no invitation to open one: " + r.reply);
  }
  let r = await S(ann, "info", [tid]);
  assert.ok(r.ok && /Sit & Go #/.test(r.reply), "an entrant sees theirs: " + r.reply);
  r = await S(ann, "", []);
  assert.ok(r.reply.includes(tid.slice(0, 6)), "...in the list too: " + r.reply);
  await svc.setSetting("casino_sng", "staff", "test");
  for (const verb of ["", "help"]) assert.match((await S(bob, verb, [])).reply, /staff/);
  assert.match((await S(sam, "", [])).reply, /Sit & Gos: #/);
  assert.match((await S(sam, "help", [])).reply, /^🏁 Sit & Go —/);
  await svc.setSetting("hm_enabled", "0", "test");
  assert.match((await S(sam, "", [])).reply, /Hold'em on the site is switched off/);
  await svc.setSetting("hm_enabled", "1", "test");
  await svc.setSetting("casino_sng", "off", "test");
  assert.ok((await S(ann, "leave", [tid])).ok, "leaving (a full refund) always works");
  assert.equal(await bal("u1"), 100000);
});

test("review: the table page offers Register only to who may enter (me.tourney.can_register); the lobby's Create only to who may open one", async () => {
  await fresh({ sng: "staff" });
  const tid = await sng(sam, ["3", "1k"]);
  const T = svc.getTable(tid);
  const mv = async (T2, uid) => (await svc.meView(T2, uid)).tourney;
  assert.equal((await mv(T, "u1")).can_register, false, "staff only: a member isn't offered Register");
  assert.equal((await mv(T, "ad")).can_register, true);
  assert.equal((await mv(T, "st")).can_register, false, "already registered");
  assert.equal((await svc.TN.lobby("u1")).can_create, false);
  assert.equal((await svc.TN.lobby("st")).can_create, true);
  assert.equal((await svc.TN.lobby(null)).can_create, false);
  await svc.setSetting("casino_sng", "everyone", "test");
  assert.equal((await mv(T, "u1")).can_register, true);
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = 'u4'");
  assert.equal((await mv(T, "u4")).can_register, false, "casino-banned");
  const t2 = await sng(cat, ["3", "1k"]);
  await fill(tid, [ann, bob]);
  assert.equal(T.tourney.status, "running");
  assert.equal((await mv(T, "u5")).can_register, false, "it has started");
  await svc.setSetting("casino_sng", "off", "test");
  assert.equal((await mv(svc.getTable(t2), "u5")).can_register, false, "switched off");
});

test("review: a full field whose start wasn't saved (the site died) starts after the restart; the reply never says nothing was charged", async () => {
  await fresh();
  const tid = await sng(ann, ["3", "1k"]);
  await fill(tid, [bob]);
  svc.S.hooks.crash = "sng:start";                  // the last entry commits, the site dies before the start is saved
  const r = await S(cat, "join", [tid]);
  svc.S.hooks.crash = null;
  assert.equal(r.ok, false);
  assert.ok(!/nothing was charged/.test(r.reply), "the entry went through - the reply doesn't say otherwise: " + r.reply);
  assert.equal(svc.getTable(tid).tourney.status, "registering");
  assert.equal(await bal("u3"), 98900);
  svc.stop();
  await svc.boot({ tick: false });
  const T = svc.getTable(tid);
  assert.equal(T.tourney.status, "running", "recover: a full field starts");
  assert.deepEqual(T.eng.seats, ["u1", "u2", "u3"]);
});

test("review: !sng leave with no id leaves your own sit & go when you aren't in the room's", async () => {
  await fresh();
  const r0 = await S(roomP(ann), "new", ["6", "1k"], { room: "Lab" });
  assert.ok(r0.ok, r0.reply);
  const tb = await sng(cat, ["6", "1k"]);
  assert.ok((await S(bob, "join", [tb])).ok);
  let r = await S(roomP(bob), "leave", [], { room: "Lab" });
  assert.ok(r.ok, r.reply);
  assert.equal(await bal("u2"), 100000);
  assert.equal(svc.getTable(tb).tourney.entrants.length, 1);
  assert.ok((await S(roomP(dan), "join", [], { room: "Lab" })).ok, "no id in the room = the room's");
  r = await S(roomP(dan), "leave", [], { room: "Lab" });
  assert.ok(r.ok, r.reply);
  assert.equal(svc.getTable(r0.table).tourney.entrants.length, 1);
});

test("review: one table per room - !sng new is refused in a room with an open cash table, nothing held", async () => {
  await fresh();
  svc.S.rate.clear();
  const r1 = await svc.act(roomP(dan), "start", ["25/50"], { game: "holdem", room: "Lab" }, key());
  assert.ok(r1.ok, r1.reply);
  const r = await S(roomP(ann), "new", ["3", "1k"], { room: "Lab" });
  assert.equal(r.ok, false);
  assert.match(r.reply, /already open here/);
  assert.equal(await bal("u1"), 100000);
  assert.equal(svc.TN.openList().length, 0);
});

test("review: no casino rewards on tournament chips - no achievement counts, reward rows or gang rep after a sit & go", async () => {
  await fresh();
  const count = async (t) => (await getQuery(`SELECT COUNT(*) AS n FROM ${t}`).catch(() => [{ n: 0 }]))[0].n;
  for (const t of ["casino_ach_counts", "casino_reward_done", "casino_rep_queue"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  const tid = await sng(ann, ["3", "1k"]);
  await fill(tid, [bob, cat]);
  await playOut(tid, { gap: 60 });
  await checkFinished(tid, 3, 1000, 100, [3000]);
  for (const t of ["casino_ach_counts", "casino_reward_done", "casino_rep_queue"]) assert.equal(await count(t), 0, t);
});

test("review: !sng new takes the forms Pepe passes through (6max, 9-seats, 1,000, 25K, @4, at=3) and refuses broken ones", async () => {
  await fresh();
  let tid = await sng(ann, ["6max", "25K", "@4"]);
  let t = svc.getTable(tid).tourney;
  assert.deepEqual([t.size, t.buyin, t.start_at, t.turbo], [6, 25000, 4, false]);
  tid = await sng(bob, ["9-seats", "1,000", "at=3", "turbo"]);
  t = svc.getTable(tid).tourney;
  assert.deepEqual([t.size, t.buyin, t.start_at, t.turbo], [9, 1000, 3, true]);
  tid = await sng(cat, ["3", "1k", "at", "3"]);
  assert.equal(svc.getTable(tid).tourney.start_at, null, "at N = the size: starts when full");
  for (const bad of [["6max", "1k", "@1"], ["6", "1k", "at"], ["6", "1k", "at=x"], ["10max", "1k"], ["6", "1k", "6"]]) {
    assert.equal((await S(dan, "new", bad)).ok, false, "refused: " + bad.join(" "));
  }
});

test("review: at most 3 sit & gos an account is in before they start; results stay in the lobby 15 minutes", async () => {
  await fresh();
  for (const b of ["1k", "5k", "25k"]) await sng(ann, ["6", b]);
  let r = await S(ann, "new", ["6", "100k"]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /3 sit & gos/);
  const t4 = await sng(bob, ["6", "1k"]);
  r = await S(ann, "join", [t4]);
  assert.equal(r.ok, false);
  assert.match(r.reply, /3 sit & gos/);
  assert.equal(await bal("u1"), 100000 - 1100 - 5500 - 27500);
  assert.ok((await S(ada, "cancel", [t4])).ok);
  let lb = await svc.TN.lobby(null);
  assert.ok(lb.list.some((x) => x.id === t4 && x.status === "cancelled"));
  await later(14 * 60);
  lb = await svc.TN.lobby(null);
  assert.ok(lb.list.some((x) => x.id === t4), "its result is still up after 14 minutes");
  await later(2 * 60);
  lb = await svc.TN.lobby(null);
  assert.ok(!lb.list.some((x) => x.id === t4), "gone after 15");
});

test("review: the admin Sit & Go card says when the Hold'em web front is Pepe's (the web lobby then redirects there)", async () => {
  const ejs = require("ejs");
  const casino = { hm_enabled: true, casino_sng: "staff", sng_fee_pct: 10, sng_buyins: "1000,5000", sng_payouts: "100|65,35|50,30,20", sng_levels: "10/20,15/30",
                   sng_level_mins: 5, sng_turbo_mins: 3 };
  const render = (front) => ejs.renderFile(path.join(repo, "views", "admin", "games.ejs"), { title: "Games", user: { username: "ada" }, isAdmin: true,
                                                                                             can: () => true, casino: Object.assign({ hm_front: front }, casino) });
  assert.ok((await render("pepe")).includes('id="sngFront"'), "front = pepe: the warning");
  for (const f of ["auto", "patv"]) assert.ok(!(await render(f)).includes('id="sngFront"'), `front = ${f}: no warning`);
});

test("review: the pages - no 'Post big blind now' at a sit & go, Register follows can_register / can_create, the Create button stays off while its request is out", () => {
  const hm = fs.readFileSync(path.join(repo, "public", "js", "casinohm.js"), "utf8");
  const ui = fs.readFileSync(path.join(repo, "public", "js", "casino-ui.js"), "utf8");
  assert.ok(/if \(t\.tourney\) for \(const id of \[[^\]]*"cz-postnow"[^\]]*\]\) \$\(id\)\.hidden = true/.test(hm), "cz-postnow hidden at a sit & go");
  assert.ok(/mt\.can_register/.test(hm), "the header's Register follows me.tourney.can_register");
  assert.ok(/sg\.can_create \? `<button type="button" class="cz-btn gold sm" data-sngact="register"/.test(ui), "the lobby card's Register follows can_create");
  assert.ok(/sngBusy/.test(ui) && /go\.disabled = sngBusy \|\|/.test(ui), "sngSheet keeps the Create button off while its POST is out");
});
