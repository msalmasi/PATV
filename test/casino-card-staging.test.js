"use strict";
// roulette2 WP1 (FAIR-1 for the card tables, decision D9): a staging refresh (deploy/refresh-staging-db.sh: VACUUM INTO, then
// deploy/keep-staging-tables.js on the copy) must never let staging play, or publish, a blackjack shoe / dealer hole card or a Hold'em deck /
// hole card prod is still playing. Prod has blackjack tables in the betting window, mid-round after insurance + split + double and mid-round on
// a real shoe, cash Hold'em tables between hands (the next hand's seed committed) and mid-hand, a running Sit & Go mid-hand and a registering
// one, and players who asked for their hole cards (!cards: the reply is cached in casino_actions). The copy - built the way prod's older
// refresh script builds it, a plain VACUUM INTO - keeps none of their seeds or cards (not even in its free pages); staging (its own process:
// test/fixtures/casino-card-staging-boot.js) boots 11 minutes later and retires every copy - every escrowed PAT back exactly once, nothing
// revealed, no table line, nothing playable - and a second boot changes nothing. Then the restart variants in this process (a decided round
// paid by its keys, the intents, the rake, a hand in play, a crash mid-retire, a refused credit), fair.js's (and the seating draw's) no-seed
// guard and the Hold'em cash-out fix (a refused credit kept the stack lost) - which never stops the table's clock (review): the seat sits out
// and its sit-out clock tries again, the hand's wrap-up and the other deadlines run on, and a table is never closed with a stack on it.
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-card-staging.test.js      (uses a temp DB)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "casino-card-staging-")));
delete process.env.STAGING;
const { runQuery: sql, getQuery: rows } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
const H = require(path.join(repo, "casino", "hmengine"));
const fair = require(path.join(repo, "casino", "fair"));
const money = require(path.join(repo, "casino", "money"));
const svc = require(path.join(repo, "casino", "service"));
const ESC = require(path.join(repo, "escrow", "ledger"));
const K = require(path.join(repo, "deploy", "keep-staging-tables"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;        // nobody is veiled here
require(path.join(repo, "casino", "rewards")).hooks.updateLevel = async () => {};
const funding = require(path.join(repo, "funding"));
const sqlite3 = require(require.resolve("sqlite3", { paths: [repo] }));

let NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const USERS = ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8", "u9", "u10"];
const who = (uid) => ({ uid, name: "Player" + uid, username: "player" + uid, camfrog: null, via: "web", iph: null, admin: false });
const act = (uid, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who(uid), verb, args || [], opts || {}, "card-stg-" + ++k); };
const ok = (r) => { assert.ok(r && r.ok, r && r.reply); return r; };
const bal = async (uid) => (await rows("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
const house = async () => (await rows("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const escrowHeld = async () => (await rows("SELECT COALESCE(SUM(amount),0) AS t FROM escrow_holds WHERE state = 'held'"))[0].t;
/** the PAT really at the open card tables (supply.js casinoHeld also counts the last hand's contributions between hands) */
function atTable(T) {
  if (!T || T.status !== "open") return 0;
  if (T.game === "holdem") {
    if (T.tourney) return 0;
    const e = T.eng;
    return Object.values(e.chips).reduce((s, v) => s + v, 0) + (e.hand_active ? Object.values(e.contrib).reduce((s, v) => s + v, 0) : 0);
  }
  return Object.values(T.escrowed || {}).reduce((s, v) => s + v, 0);
}
const dbHeld = async () => {
  let t = 0;
  for (const r of await rows("SELECT state FROM casino_tables WHERE status != 'closed'")) t += atTable(JSON.parse(r.state));
  return t;
};
const wallets = async () => (await rows("SELECT COALESCE(SUM(points_balance),0) AS t FROM users"))[0].t;
const total = async () => (await wallets()) + (await house()) + (await escrowHeld()) + (await dbHeld());
const events = async (id) => (await rows("SELECT kind FROM casino_events WHERE table_id = ? ORDER BY seq", [id])).map((r) => r.kind);
const revealed = async (id) => (await rows("SELECT round_no FROM casino_rounds WHERE table_id = ? AND revealed IS NOT NULL ORDER BY round_no", [id])).map((r) => r.round_no);
const txKeys = async (re) => (await rows("SELECT transactionId FROM transactions")).map((r) => r.transactionId).filter((x) => re.test(x));
const rowState = async (id) => { const r = (await rows("SELECT status, state FROM casino_tables WHERE id = ?", [id]))[0]; return { status: r.status, s: JSON.parse(r.state) }; };
/** the scrub's own statements (deploy/keep-staging-tables.js), on this database - what a refresh does to the copy */
const scrubHere = async () => { for (const s of K.CASINO_SCRUB) await sql(s.sql.replace(/\bmain\./g, "")).catch((e) => { if (!/no such table/.test(e.message)) throw e; }); };
async function restart(crash) {
  svc.stop();
  svc.S.hooks.crash = crash || null;
  svc.S.hooks.shoe = null;
  svc.S.hooks.deck = null;
  await svc.boot({ tick: false });
}

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null;
  svc.S.hooks.deck = null;
  svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings",
                   "escrow_holds", "escrow_moves", "escrow_meta", "casino_ach_counts", "casino_reward_done", "casino_notice_seen"]) {
    await sql(`DELETE FROM ${t}`).catch(() => {});
  }
  // (an account a failed test left deleted comes back - every test starts from the same ten)
  for (const id of USERS) await sql("INSERT OR IGNORE INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 100000)", [id, who(id).username, who(id).name]);
  await sql("UPDATE users SET points_balance = 100000, casino_banned = 0");
  await sql("DELETE FROM jackpot_rakes");
  await sql("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  funding.sync({});
  NOW += 3600e3;
  await svc.boot({ tick: false });
  for (const [kk, v] of [["bj_enabled", "1"], ["hm_enabled", "1"], ["casino_sng", "everyone"]]) await svc.setSetting(kk, v, "test");
}
const bj = async (uid) => ok(await act(uid, "start", [], { room: null })).table;
const hm = async (uid, blinds) => ok(await act(uid, "start", [blinds || "25/50"], { room: null, game: "holdem" })).table;
const hmAct = (uid, verb, tid, args) => act(uid, verb, args || [], { game: "holdem", table: tid });
const sng = async (uid) => ok(await act(uid, "new", ["2", "1k"], { game: "sng", room: null })).table;
const get = (id) => svc.getTable(id);
/** the cards dealt next at blackjack table `tid` start with `prefix` (one player: p, dealer up, p, dealer hole, then draws) */
function shoeFor(tid, prefix) {
  svc.S.hooks.shoe = (T, n) => (T.id === tid ? prefix.concat(E.makeShoe(6)) : fair.shuffleShoe(T.eng.num_decks, T.round.seed, T.client_seed, n));
}

test.before(async () => {
  await sql(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
             points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await sql(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
             timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await sql("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await sql("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await sql("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await sql("CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, points INTEGER, requirement TEXT, pat INTEGER DEFAULT 0)");
  for (const id of USERS) await sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 100000)", [id, who(id).username, who(id).name]);
  await funding.init();
  await ESC.init();
});
test.after(() => svc.stop());

/** a staging refresh. opts.plain: the copy built by a plain VACUUM INTO - prod's refresh-staging-db.sh one release behind staging (staging
 *  gets a release first) or rolled back past roulette2 WP1: stale row bytes stay in the copy's page slack, and only the keep step's rebuild
 *  (deploy/keep-staging-tables.js, from staging's checkout) clears them */
async function refresh(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-staging-"));
  const old = path.join(dir, "myapp.db"), copy = path.join(dir, "myapp.db.new");
  await new Promise((res, rej) => {
    const d = new sqlite3.Database(old, (e) => (e ? rej(e) : d.exec("CREATE TABLE staging_marker (k TEXT)", (e2) => d.close(() => (e2 ? rej(e2) : res())))));
  });
  // as deploy/refresh-staging-db.sh copies prod: secure_delete ON for the copy's build (else stale row bytes stay in its page slack)
  await sql(`PRAGMA secure_delete = ${opts && opts.plain ? "OFF" : "ON"}`);
  await sql(`VACUUM INTO '${copy.replace(/\\/g, "/")}'`);
  await sql("PRAGMA secure_delete = OFF");
  const out = execFileSync(process.execPath, [path.join(repo, "deploy", "keep-staging-tables.js"), old, copy], { encoding: "utf8" });
  fs.renameSync(old, old + ".previous");
  fs.renameSync(copy, old);
  return { dir, out, file: old };
}
/** console.error lines while fn runs */
async function capture(fn) {
  const lines = [], ce = console.error;
  console.error = (...a) => { lines.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); };
  try { await fn(); } finally { console.error = ce; }
  return lines;
}
const fileRows = async (file, q) => {
  const d = new sqlite3.Database(file);
  try { return await new Promise((res, rej) => d.all(q, (e, r) => (e ? rej(e) : res(r)))); } finally { await new Promise((res) => d.close(res)); }
};

test("FAIR-1 for cards: a staging refresh keeps no open card table's seed or cards; staging retires every copy unrevealed, quietly, every PAT back once - and a second boot changes nothing", async () => {
  await fresh();
  // a running sit & go mid-hand (a real deck) and a registering one
  const sA = await sng("u8");
  ok(await act("u9", "join", [sA], { game: "sng", room: null }));
  assert.equal(get(sA).tourney.status, "running");
  await later(16);
  assert.ok(get(sA).eng.hand_active, "the sit & go's first hand is in play");
  const sB = await sng("u10");
  // blackjack mid-round after insurance + split + double (a fixed shoe): Ace up, a pair of 8s
  const bB = await bj("u2");
  shoeFor(bB, ["8s", "Ah", "8d", "7c", "3h", "2c", "Th"]);
  ok(await act("u2", "bet", ["1000"], { table: bB }));
  ok(await act("u2", "deal", [], { table: bB }));
  assert.equal(get(bB).eng.phase, "insurance");
  ok(await act("u2", "insurance", [], { table: bB }));
  await later(19);                                                  // no dealer blackjack: play on
  ok(await act("u2", "split", [], { table: bB }));
  ok(await act("u2", "double", [], { table: bB }));                 // 8+3 doubles to 21; the second 8 (+2) is to act
  assert.equal(get(bB).eng.phase, "player");
  assert.deepEqual(get(bB).stakes.map((s) => s.op).sort(), ["dbl0", "ins", "spl0"], "the dealt bet left T.stakes at the deal; these stay");
  assert.equal(get(bB).escrowed.u2, 3500);
  svc.S.hooks.shoe = null;
  // blackjack mid-round on a REAL shoe (its seed's shuffle): rounds until one stops at a decision
  const bC = await bj("u3");
  for (let i = 0; i < 20 && !["player", "insurance"].includes(get(bC).eng.phase); i++) {
    if (get(bC).eng.phase !== "betting") await later(11);
    ok(await act("u3", "bet", ["2000"], { table: bC }));
    ok(await act("u3", "deal", [], { table: bC }));
  }
  assert.ok(["player", "insurance"].includes(get(bC).eng.phase), get(bC).eng.phase);
  // Hold'em between hands (the next hand's seed committed) and mid-hand (a real deck)
  const hA = await hm("u4");
  ok(await hmAct("u4", "sit", hA, ["2000"]));
  ok(await hmAct("u5", "sit", hA, ["2000"]));
  assert.ok(get(hA).next && get(hA).next.seed && !get(hA).eng.hand_active);
  const hB = await hm("u6");
  ok(await hmAct("u6", "sit", hB, ["3000"]));
  ok(await hmAct("u7", "sit", hB, ["3000"]));
  ok(await hmAct("u6", "deal", hB));
  assert.ok(get(hB).eng.hand_active && get(hB).hand && get(hB).hand.seed);
  // blackjack in the betting window with a bet
  const bA = await bj("u1");
  ok(await act("u1", "bet", ["1000"], { table: bA }));
  assert.equal(get(bA).eng.phase, "betting");
  // a closed blackjack table: its revealed seeds stay as they were
  const bX = await bj("u1");
  ok(await act("u1", "end", [], { table: bX }));
  assert.equal(get(bX).status, "closed");

  // roulette2 WP1 review: hole cards asked for (Pepe's !cards, the website's `cards`) - the reply is cached whole in casino_actions (the
  // idempotent replay): for the hand in play at a cash table and a sit & go, prod's hole cards
  const asked = [];
  for (const [uid, tid] of [["u6", hB], ["u7", hB], ["u8", sA], ["u9", sA]]) {
    const r = ok(await hmAct(uid, "cards", tid));
    const mine = "Your hand: " + H.cardsStr(get(tid).eng.hole[uid]);
    assert.ok(r.reply.includes(mine), r.reply);
    asked.push(mine);
  }
  assert.equal((await rows("SELECT COUNT(*) AS n FROM casino_actions WHERE response LIKE '%Your hand:%'"))[0].n, 4);
  const ids = [bA, bB, bC, hA, hB, sA, sB];
  const P = Object.fromEntries(ids.map((id) => [id, get(id)]));
  const secrets = {};
  for (const id of ids) {
    const T = P[id];
    secrets[id] = [T.round && T.round.seed, T.next && T.next.seed, T.hand && T.hand.seed].filter(Boolean);
  }
  for (const id of [bA, bB, bC, hA, hB, sA]) assert.ok(secrets[id].length, id + " has a committed seed");
  const deckBytes = [JSON.stringify(P[hB].hand.deck.slice(4, 30)).slice(1, -1), JSON.stringify(P[sA].hand.deck.slice(4, 30)).slice(1, -1),
                     JSON.stringify(P[bC].eng.shoe.slice(P[bC].eng.si, P[bC].eng.si + 30)).slice(1, -1)];
  const hole = P[bB].eng.dealer[1];
  assert.equal(hole, "7c");
  // what each player is owed back on staging: blackjack escrow, cash stacks (+ the hand in play), sit & go entries in full
  const owed = { u1: 1000, u2: 3500, u3: P[bC].escrowed.u3, u4: 2000, u5: 2000, u6: 3000, u7: 3000, u8: 1100, u9: 1100, u10: 1100 };
  assert.equal(owed.u3 >= 2000, true);
  const prodBal = Object.fromEntries(await Promise.all(USERS.map(async (u) => [u, await bal(u)])));
  const prodTotal = await total();
  const revealedProd = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await revealed(id)])));

  // (the copy built the way prod's older refresh script builds it - a plain VACUUM INTO: the keep step alone must leave no byte behind)
  const { dir, out, file } = await refresh({ plain: true });
  assert.match(out, /casino_tables scrubbed 7 \(cards\)/, out);
  assert.match(out, /casino_actions scrubbed 4 \(hole cards\)/, out);
  assert.match(out, /the copy rebuilt$/m, out);
  const bytes = fs.readFileSync(file).toString("latin1");
  for (const [id, list] of Object.entries(secrets)) for (const s of list) assert.ok(!bytes.includes(s), "the copy still holds a seed of " + id);
  for (const [i, d] of deckBytes.entries()) { const at = bytes.indexOf(d); assert.ok(at < 0, "the copy still holds cards to come (" + i + "): " + bytes.slice(Math.max(0, at - 300), at + 80).replace(/[^ -~]/g, ".")); }
  const buf = fs.readFileSync(file);
  for (const mine of asked) assert.ok(!buf.includes(Buffer.from(mine, "utf8")), "the copy still holds hole cards asked for: " + mine);
  assert.equal((await fileRows(file, "SELECT COUNT(*) AS n FROM casino_actions WHERE response LIKE '%Your hand:%'"))[0].n, 0);
  const copied = Object.fromEntries((await fileRows(file, "SELECT id, status, state FROM casino_tables")).map((r) => [r.id, { status: r.status, s: JSON.parse(r.state) }]));
  for (const id of ids) {
    const s = copied[id].s;
    assert.equal(s.copied, 1, id);
    assert.equal((s.round || {}).seed, undefined);
    assert.equal((s.next || {}).seed, undefined);
    assert.equal((s.hand || {}).seed, undefined);
    if (s.game === "bj") assert.deepEqual(s.eng.shoe, []);
    else { assert.deepEqual(s.eng.deck, []); assert.deepEqual(s.eng.hole, {}); if (s.hand) assert.deepEqual(s.hand.deck, []); }
  }
  assert.deepEqual(copied[bB].s.eng.dealer, ["Ah"], "the dealer's hole card is gone, the up card stays");
  assert.equal(copied[bB].s.round.commitment, P[bB].round.commitment, "the commitment stays (it is public)");
  assert.equal(copied[bX].s.copied, undefined, "a closed table is not touched");
  assert.equal(copied[bX].s.round.seed, get(bX).round.seed);

  const raw = execFileSync(process.execPath, [path.join(__dirname, "fixtures", "casino-card-staging-boot.js"), dir, ids.join(","), String(NOW)], { encoding: "utf8" });
  const st = JSON.parse(raw.trim().split("\n").pop());
  assert.deepEqual(st.loaded, [], "staging retires every copied card table at boot");
  assert.deepEqual(st.loaded2, [], "and a restart doesn't bring one back");
  for (const id of ids) assert.equal(st.statuses[id], "closed", id);
  assert.deepEqual(st.revealed, [], "nothing of a copied table is revealed on staging");
  assert.deepEqual(st.events, [], "no casino_events row for a copied table (staging's Pepe never posts into prod's rooms)");
  assert.equal(st.newRounds, 0, "no new round committed (or dealt) for a copied table");
  for (const id of ids) assert.ok(st.tries[id].every((x) => x === false), "nobody can play at copied table " + id);
  assert.equal(st.after, st.before, "staging's PAT is conserved");
  assert.equal(st.after2, st.after, "a second boot moves nothing");
  assert.equal(st.tx2, st.tx1, "a second boot credits nothing");
  assert.deepEqual(st.bal2, st.bal1);
  assert.equal(st.held, 0);
  for (const u of USERS) assert.equal(st.bal1[u], prodBal[u] + owed[u], u + ": everything escrowed came back, once");
  // prod is untouched: every table still open on the same seeds, nothing revealed
  for (const id of ids) {
    assert.equal(get(id).status, "open", id);
    assert.deepEqual([get(id).round && get(id).round.seed, get(id).next && get(id).next.seed, get(id).hand && get(id).hand.seed].filter(Boolean), secrets[id]);
    assert.deepEqual(await revealed(id), revealedProd[id]);
  }
  assert.equal(await total(), prodTotal);
});

test("the scrub is idempotent (refresh-staging-db.sh can run two lists) and touches open rows only", async () => {
  await fresh();
  const b = await bj("u1");
  ok(await act("u1", "bet", ["500"], { table: b }));
  const h = await hm("u2");
  const closed = await bj("u3");
  ok(await act("u3", "end", [], { table: closed }));
  const { file, dir } = await refresh();
  const again = execFileSync(process.execPath, [path.join(repo, "deploy", "keep-staging-tables.js"), file + ".previous", file], { encoding: "utf8" });
  assert.match(again, /casino_tables scrubbed 2 \(cards\)/);
  const got = Object.fromEntries((await fileRows(file, "SELECT id, state FROM casino_tables")).map((r) => [r.id, JSON.parse(r.state)]));
  assert.equal(got[b].copied, 1);
  assert.deepEqual(got[b].eng.dealer, []);
  assert.equal(got[h].copied, 1);
  assert.ok(got[h].next && got[h].next.commitment && !got[h].next.seed);
  assert.equal(got[closed].copied, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("restart variants: a copied blackjack round DECIDED before the copy is paid by its keys (never refunded on top); intents, stakes and the dealt bets back by key; closed unrevealed and quiet", async () => {
  // (1) settle pending: the payouts went out, the House legs didn't
  await fresh();
  let t = await bj("u1");
  shoeFor(t, ["Ts", "9h", "Qd", "7d", "Kc"]);                       // u1 20; Pepe 9+7 hits K = bust: u1 wins 1000
  ok(await act("u1", "bet", ["1000"], { table: t }));
  ok(await act("u1", "deal", [], { table: t }));
  const start = await total();
  svc.S.hooks.crash = "payouts";
  await act("u1", "stand", [], { table: t });
  assert.equal(get(t).round.settle, "pending");
  const ev0 = await events(t), rv0 = await revealed(t);
  await scrubHere();
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u1"), 101000, "paid once, by the round's own payout key");
  assert.equal((await txKeys(new RegExp(`^cbj:${t}:r1:u1:pay$`))).length, 1);
  assert.equal((await txKeys(/:refund$|:copy$/)).length, 0, "a decided round is never refunded");
  assert.equal(await house(), 10000000 - 1000, "the House leg went out by its key");
  assert.equal(await total(), start);
  assert.deepEqual(await events(t), ev0, "no event");
  assert.deepEqual(await revealed(t), rv0, "no reveal");
  assert.equal((await svc.fairRecord(t, 1)).server_seed, null);
  // (2) a charged stake caught in its intent + a stake in the betting window
  await fresh();
  t = await bj("u1");
  ok(await act("u1", "bet", ["700"], { table: t }));
  svc.stop();
  const ik = `cbj:${t}:r1:u2:bet:99`;
  assert.ok((await money.charge(ik, "u2", 300, "blackjack bet")).ok);
  await sql("UPDATE casino_tables SET state = json_set(state, '$.intent', json(?)) WHERE id = ?", [JSON.stringify({ key: ik, uid: "u2", amount: 300, op: "bet", ts: NOW }), t]);
  await scrubHere();
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u1"), 100000);
  assert.equal(await bal("u2"), 100000);
  assert.deepEqual((await txKeys(/:refund$/)).sort(), [`cbj:${t}:r1:u1:bet:1:refund`, ik + ":refund"].sort());
  assert.deepEqual(await revealed(t), []);
  // (3) mid-round after split / double / insurance: each stake by its refund key, the dealt bet by the copy key; a crash part-way and a
  //     re-run credit nothing twice; the copy that couldn't finish is out of play until then
  await fresh();
  t = await bj("u2");
  shoeFor(t, ["8s", "Ah", "8d", "7c", "3h", "2c", "Th"]);
  ok(await act("u2", "bet", ["1000"], { table: t }));
  ok(await act("u2", "deal", [], { table: t }));
  ok(await act("u2", "insurance", [], { table: t }));
  await later(19);
  ok(await act("u2", "split", [], { table: t }));
  ok(await act("u2", "double", [], { table: t }));
  assert.equal(await bal("u2"), 96500);
  const t0 = await total(), e0 = await events(t);
  await scrubHere();
  await restart("copy:refund");
  assert.equal(get(t), null, "a copy that couldn't be retired is out of play here");
  assert.equal((await rowState(t)).status, "open", "its row stays open (and copied): the next boot tries again");
  assert.equal((await rowState(t)).s.copied, 1);
  assert.equal((await act("u2", "hit", [], { table: t })).ok, false);
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u2"), 100000);
  assert.equal(await total(), t0);
  const keys = await txKeys(new RegExp(`^cbj:${t}:`));
  assert.equal(keys.filter((x) => /:refund$/.test(x)).length, 3, "the insurance, the split and the double, once each: " + keys.join(" "));
  assert.deepEqual(keys.filter((x) => /:copy$/.test(x)), [`cbj:${t}:r1:u2:copy`], "the dealt bet by the copy key, once");
  assert.deepEqual(await events(t), e0);
  assert.deepEqual(await revealed(t), []);
  const s = (await rowState(t)).s;
  assert.deepEqual([s.escrowed, s.stakes, s.eng.shoe, s.eng.dealer, s.eng.hands], [{}, [], [], [], []]);
  await restart();
  assert.equal(get(t), null, "a closed copy isn't loaded again");
  assert.equal(await bal("u2"), 100000);
  // (4) a refused refund (the account is gone): the table is NOT closed - it stays open in the database, out of play here, the stake held;
  //     once the account is back the next boot refunds it, once
  await fresh();
  t = await bj("u5");
  ok(await act("u5", "bet", ["900"], { table: t }));
  ok(await act("u6", "bet", ["400"], { table: t }));
  const t4 = await total();
  await scrubHere();
  const row5 = (await rows("SELECT * FROM users WHERE userId = 'u5'"))[0];
  await sql("DELETE FROM users WHERE userId = 'u5'");
  await restart();
  assert.equal(get(t), null, "out of play");
  const held4 = await rowState(t);
  assert.equal(held4.status, "open", "never closed with a stake it couldn't give back");
  assert.equal(held4.s.escrowed.u5, 900);
  await sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [row5.userId, row5.username, row5.displayname, row5.points_balance]);
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u5"), 100000);
  assert.equal(await bal("u6"), 100000);
  assert.equal(await total(), t4);
  assert.equal((await txKeys(/:refund$/)).length, 2, "each stake refunded once");
});

test("restart variants: a copied cash Hold'em table - the buy-in and cash-out intents, the rake owed, the hand in play void, every stack back by key, quiet; a refused credit keeps it open + out of play", async () => {
  // (1) mid-hand with a raise: everyone gets back what they put in
  await fresh();
  let t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["3000"]));
  ok(await hmAct("u2", "sit", t, ["3000"]));
  ok(await hmAct("u3", "sit", t, ["3000"]));
  ok(await hmAct("u1", "deal", t));
  const T = get(t);
  const a = H.currentActor(T.eng);
  ok(await hmAct(a, "raise", t, ["400"]));
  assert.ok(T.eng.hand_active && H.pot(T.eng) > 75);
  const n = T.hand.no, e0 = await events(t), start = await total();
  await scrubHere();
  await restart();
  assert.equal(get(t).status, "closed");
  for (const u of ["u1", "u2", "u3"]) assert.equal(await bal(u), 100000, u + ": the stack and what was in the pot");
  assert.equal(await total(), start);
  assert.equal((await txKeys(new RegExp(`^chm:${t}:.*:out:`))).length, 3);
  assert.deepEqual(await events(t), e0, "no line");
  assert.deepEqual(await revealed(t), [], "the hand in play is never revealed");
  assert.equal((await svc.fairRecord(t, n)).server_seed, null);
  const s = (await rowState(t)).s;
  assert.deepEqual([s.hand, s.next, s.replay, s.eng.hole, s.eng.deck, s.eng.board, s.eng.hand_active], [null, null, null, {}, [], [], false]);
  // (2) intents (a charged buy-in that never reached the table; a cash-out journalled, its credit already made) + the rake owed
  await fresh();
  t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["2000"]));
  ok(await hmAct("u2", "sit", t, ["2000"]));
  svc.stop();
  const buy = `chm:${t}:u3:buy:50`, out = `chm:${t}:u2:out:51`;
  assert.ok((await money.charge(buy, "u3", 1500, "holdem buy-in")).ok);
  assert.ok((await money.credit(out, "u2", 2000, "holdem cash-out")).ok);   // the cash-out credit went through; the table never saw it
  await sql("UPDATE casino_tables SET state = json_set(state, '$.intent', json(?), '$.rake_due', json(?), '$.eng.chips.u1', 1960) WHERE id = ?",
            [JSON.stringify({ kind: "out", key: out, uid: "u2", amount: 2000, ts: NOW }), JSON.stringify({ key: `chm:${t}:h1:rake`, n: 1, amount: 40 }), t]);
  const h0 = await house();
  await scrubHere();
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u2"), 100000, "the cash-out finished by its own key - never paid again");
  assert.equal(await bal("u1"), 100000 - 40, "the stack less the rake that had left it");
  assert.equal(await house(), h0 + 40, "the rake owed went to the House by its key");
  assert.equal(await bal("u3"), 100000 - 1500, "a buy-in intent is refunded only when it is the table's intent");
  // a buy-in caught in its intent
  await fresh();
  t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["2000"]));
  svc.stop();
  const buy2 = `chm:${t}:u3:buy:50`;
  assert.ok((await money.charge(buy2, "u3", 1500, "holdem buy-in")).ok);
  await sql("UPDATE casino_tables SET state = json_set(state, '$.intent', json(?)) WHERE id = ?", [JSON.stringify({ kind: "buy", key: buy2, uid: "u3", amount: 1500, ts: NOW }), t]);
  await scrubHere();
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u3"), 100000);
  assert.equal(await bal("u1"), 100000);
  // (3) a crash between two cash-outs, then a refused credit (the account is gone): the table stays open in the database and out of play,
  //     the stack where it was; once the account is back, the next boot finishes it - every stack paid exactly once
  await fresh();
  t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["2500"]));
  ok(await hmAct("u4", "sit", t, ["1500"]));
  const t0 = await total(), ev3 = await events(t);
  await scrubHere();
  await restart("copy:cashout");
  assert.equal(get(t), null);
  const row4 = (await rows("SELECT * FROM users WHERE userId = 'u4'"))[0];
  await sql("DELETE FROM users WHERE userId = 'u4'");
  await restart();
  assert.equal(get(t), null, "a refused credit: out of play, not closed");
  const left = await rowState(t);
  assert.equal(left.status, "open");
  assert.equal(left.s.eng.chips.u4, 1500, "the refused stack stays at the table");
  assert.equal(left.s.intent, null);
  await sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [row4.userId, row4.username, row4.displayname, row4.points_balance]);
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(await bal("u1"), 100000);
  assert.equal(await bal("u4"), 100000);
  assert.equal(await total(), t0);
  assert.equal((await txKeys(new RegExp(`^chm:${t}:u1:out:`))).length, 1, "u1's stack paid once across the crash");
  assert.deepEqual(await events(t), ev3, "no table line from the retire");
});

test("restart variants: a copied sit & go - running mid-hand, settling (decided, its one settle never ran) and registering - called off quietly, every entry back in full once", async () => {
  for (const at of ["running", "settling", "registering"]) {
    await fresh();
    const t = await sng("u1");
    if (at !== "registering") {
      ok(await act("u2", "join", [t], { game: "sng", room: null }));
      if (at === "settling") svc.S.hooks.deck = () => ["As", "Ah", "2c", "7d", "Ks", "Kh", "9h", "3s", "4c"].concat(E.makeShoe(1).filter((c) => !["As", "Ah", "2c", "7d", "Ks", "Kh", "9h", "3s", "4c"].includes(c)));
      await later(16);
      assert.ok(get(t).eng.hand_active);
      if (at === "settling") {
        svc.S.hooks.crash = "sng:settle";
        const T = get(t);
        for (let i = 0; i < 4 && T.eng.hand_active; i++) {
          const a = H.currentActor(T.eng);
          await hmAct(a, (T.eng.street_paid[a] || 0) + (T.eng.chips[a] || 0) > T.eng.current_bet ? "allin" : "call", t);
        }
        assert.equal(get(t).tourney.status, "settling", at);
      }
    }
    const start = await total(), e0 = await events(t), rv0 = await revealed(t);
    await scrubHere();
    await restart();
    const T = get(t);
    assert.equal(T.status, "closed", at);
    assert.equal(T.tourney.status, "cancelled", at);
    assert.equal(await bal("u1"), 100000, at);
    assert.equal(await bal("u2"), 100000, at);
    assert.equal(await escrowHeld(), 0, at);
    assert.equal(await total(), start, at + ": conserved");
    assert.equal((await rows("SELECT COUNT(*) AS n FROM escrow_moves WHERE key = ?", [`tny:${t}:finish`]))[0].n, 0, at + ": never settled");
    assert.deepEqual(await events(t), e0, at + ": no line");
    assert.deepEqual(await revealed(t), rv0, at + ": nothing revealed");
    assert.equal(T.hand, null);
    await restart();
    assert.equal(await bal("u1"), 100000, at + ": a second boot refunds nothing more");
  }
});

test("a copy marked by an older scrub (its seed gone, no `copied` flag) is retired all the same; a table that ISN'T a copy resumes as before", async () => {
  await fresh();
  const t = await bj("u1");
  ok(await act("u1", "bet", ["500"], { table: t }));
  const h = await hm("u2");
  ok(await hmAct("u2", "sit", h, ["2000"]));
  const live = await bj("u3");
  ok(await act("u3", "bet", ["800"], { table: live }));
  svc.stop();
  await sql("UPDATE casino_tables SET state = json_remove(state, '$.round.seed') WHERE id = ?", [t]);
  await sql("UPDATE casino_tables SET state = json_remove(state, '$.next.seed') WHERE id = ?", [h]);
  await restart();
  assert.equal(get(t).status, "closed");
  assert.equal(get(h).status, "closed");
  assert.equal(await bal("u1"), 100000);
  assert.equal(await bal("u2"), 100000);
  assert.equal(get(live).status, "open", "prod's own restart: the round resumes");
  assert.equal(get(live).escrowed.u3, 800);
  assert.ok(get(live).round.seed);
  assert.equal(await bal("u3"), 99200);
});

test("fair.js: a missing seed never deals - shuffleShoe / spinPocket / words throw on a falsy seed (the HMAC key was the text \"undefined\"); a real seed deals as before", async () => {
  for (const s of [undefined, null, "", 0]) {
    assert.throws(() => fair.shuffleShoe(6, s, "abc", 1), /no server seed/);
    assert.throws(() => fair.spinPocket(s, "abc", 1), /no server seed/);
    assert.throws(() => fair.words(s, "abc", 1), /no server seed/);
  }
  const seed = "ab".repeat(32);
  assert.equal(fair.shuffleShoe(6, seed, "abc", 7).join(","), fair.shuffleShoe(6, seed, "abc", 7).join(","));
  assert.equal(fair.shuffleShoe(6, seed, "abc", 7).length, 312);
  assert.equal(fair.verify({ server_seed: null }).ok, false);
  // (roulette2 WP1 review) the tournament seating draw too: Buffer.from("undefined", "hex") is an EMPTY HMAC key - a draw anyone can compute
  const SEAT = require(path.join(repo, "casino", "mttseat"));
  const ids = ["u3:1", "u1:1", "u2:1", "u4:1"];
  for (const s of [undefined, null, "", 0, "undefined", "zz", "ab", "ab".repeat(15) + "a"]) assert.throws(() => SEAT.drawOrder(s, "start", ids), /no draw seed/, String(s));
  assert.deepEqual(SEAT.drawOrder("ab".repeat(32), "start", ids), SEAT.drawOrder("ab".repeat(32), "start", ids.slice().reverse()));
  assert.deepEqual(SEAT.drawOrder(SEAT.newSeed(), "start", ids).sort(), ids.slice().sort());
  // the engine path: a scrubbed blackjack table that somehow was NOT retired fails closed - it can't deal
  await fresh();
  const t = await bj("u1");
  ok(await act("u1", "bet", ["500"], { table: t }));
  delete get(t).round.seed;
  const r = await act("u1", "deal", [], { table: t });
  assert.equal(r.ok, false);
  assert.equal(get(t).eng.phase, "betting", "no card was dealt");
});

test("the Hold'em cash-out fix: a refused credit keeps the stack at the table (it was stood up and lost); paid once when it can be", async () => {
  await fresh();
  const t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["2000"]));
  ok(await hmAct("u2", "sit", t, ["2000"]));
  const start = await total();
  const row = (await rows("SELECT * FROM users WHERE userId = 'u2'"))[0];
  await sql("DELETE FROM users WHERE userId = 'u2'");
  const r = await hmAct("u2", "stand", t);
  assert.equal(r.ok, false, "the cash-out didn't go through - and says so");
  assert.match(r.reply, /cash-out didn't go through .* chips stay at the table/, r.reply);
  const T = get(t);
  assert.ok(T.eng.seats.includes("u2"), "the seat is kept");
  assert.equal(T.qol.u2.out, true, "sitting out (never dealt in) - its sit-out clock tries again");
  assert.equal(T.eng.chips.u2, 2000, "and its stack");
  assert.equal(T.intent, null, "nothing for a restart to finish (the refused credit wrote nothing)");
  assert.equal((await rowState(t)).s.eng.chips.u2, 2000, "saved so");
  await sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [row.userId, row.username, row.displayname, row.points_balance]);
  ok(await hmAct("u2", "stand", t));
  assert.equal(await bal("u2"), 100000);
  assert.equal(await total(), start);
  assert.equal((await txKeys(new RegExp(`^chm:${t}:u2:out:`))).length, 1);
  // a restart finishing a journalled cash-out whose credit is refused keeps the stack too (it was stood up and lost)
  svc.stop();
  const key = `chm:${t}:u1:out:77`;
  await sql("UPDATE casino_tables SET state = json_set(state, '$.intent', json(?)) WHERE id = ?", [JSON.stringify({ kind: "out", key, uid: "u1", amount: 2000, ts: NOW }), t]);
  const row1 = (await rows("SELECT * FROM users WHERE userId = 'u1'"))[0];
  await sql("DELETE FROM users WHERE userId = 'u1'");
  await restart();
  assert.equal(get(t).status, "open");
  assert.ok(get(t).eng.seats.includes("u1"));
  assert.equal(get(t).eng.chips.u1, 2000);
  assert.equal(get(t).intent, null);
  assert.equal(get(t).qol.u1.out, true, "sitting out: never dealt in while its cash-out waits");
  await sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [row1.userId, row1.username, row1.displayname, row1.points_balance]);
  ok(await hmAct("u1", "stand", t));
  assert.equal(await bal("u1"), 100000);
});

// roulette2 WP1 review: a refused cash-out never stops a table's clock. It used to throw out of the tick's sit-out loop (every 250 ms, before
// the turn / next-hand / idle deadlines: a live hand never timed out), out of the hand's wrap-up (no next hand, `leaving` never cleared, and
// the player whose action ended the hand was told "something went wrong") and out of a close. Now the seat keeps its stack, sits out, and its
// sit-out clock tries again once per period.
const users = async (uid) => (await rows("SELECT * FROM users WHERE userId = ?", [uid]))[0];
const putBack = (row) => sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [row.userId, row.username, row.displayname, row.points_balance]);
const refusedLines = (lines, uid) => lines.filter((l) => new RegExp(`cash-out \\d+ to ${uid} refused`).test(l));
const thrown = (lines) => lines.filter((l) => /hold'em deadline|\[casino\] act:/.test(l));

test("the cash-out fix never stops the clock: a sat-out seat whose credit is refused keeps its stack, is tried again once per sit-out period (never every tick), and the hand in play still times out", async () => {
  await fresh();
  const t = await hm("u1");
  for (const u of ["u1", "u2", "u3"]) ok(await hmAct(u, "sit", t, ["2000"]));
  ok(await hmAct("u3", "sitout", t));
  const T = get(t);
  await later(570);                                                 // u3's 10-minute sit-out limit is 30 s away
  ok(await hmAct("u1", "deal", t));
  const n0 = T.eng.hand_no;
  assert.ok(T.eng.hand_active && !T.eng.players.includes("u3"));
  const start = await total();
  const row = await users("u3");
  await sql("DELETE FROM users WHERE userId = 'u3'");
  const errs = await capture(async () => { for (let i = 0; i < 180; i++) await later(1); });   // 3 minutes, a tick a second
  assert.deepEqual(thrown(errs), [], "no tick threw");
  assert.equal(refusedLines(errs, "u3").length, 1, "tried once when the sit-out limit ran out - not on every tick: " + errs.join(" | "));
  assert.ok(T.eng.hand_no > n0, "the hand in play timed out and the next one was dealt");
  assert.ok(T.eng.seats.includes("u3"), "the seat is kept");
  assert.equal(T.eng.chips.u3, 2000, "with its stack");
  assert.equal(T.qol.u3.out, true);
  assert.ok(T.dl.sitout.u3 > NOW, "its sit-out clock runs again");
  assert.equal((await rowState(t)).s.eng.chips.u3, 2000, "saved so");
  // the next period: the account is back, the cash-out goes through - once
  await putBack(row);
  for (let i = 0; i < 100; i++) await later(5);
  assert.ok(!T.eng.seats.includes("u3"), "cashed out by its sit-out clock");
  assert.equal(await bal("u3"), 100000);
  assert.equal((await txKeys(new RegExp(`^chm:${t}:u3:out:`))).length, 1);
  assert.equal(await total(), start);
});

test("the cash-out fix never stops the clock: a seat leaving after the hand whose credit is refused - the hand's wrap-up still runs (next hand scheduled, nobody told \"something went wrong\")", async () => {
  await fresh();
  const t = await hm("u1");
  for (const u of ["u1", "u2", "u3"]) ok(await hmAct(u, "sit", t, ["2000"]));
  ok(await hmAct("u1", "deal", t));
  const T = get(t);
  const n0 = T.eng.hand_no;
  ok(await hmAct("u3", "stand", t));                                // in the hand: cashed out when it ends
  assert.ok(T.eng.leaving.includes("u3"));
  const start = await total();
  const row = await users("u3");
  await sql("DELETE FROM users WHERE userId = 'u3'");
  const errs = await capture(async () => {
    for (let i = 0; i < 12 && T.eng.hand_active; i++) {
      const a = H.currentActor(T.eng);
      ok(await hmAct(a, H.toCall(T.eng, a) ? "fold" : "check", t));   // the action that ends the hand is answered ok
    }
  });
  assert.deepEqual(thrown(errs), []);
  assert.equal(refusedLines(errs, "u3").length, 1);
  assert.equal(T.eng.hand_active, false);
  assert.deepEqual(T.eng.leaving, [], "the leaving list is cleared");
  assert.ok(T.dl.next > NOW, "the next hand is scheduled");
  assert.ok(T.eng.seats.includes("u3") && T.eng.chips.u3 > 0, "the seat and its stack are kept");
  assert.equal(T.qol.u3.out, true);
  await later(16);
  assert.ok(T.eng.hand_active && T.eng.hand_no === n0 + 1, "the next hand is dealt");
  assert.ok(!T.eng.players.includes("u3"), "without the seat whose cash-out waits");
  // !stand again once the account is back: paid, once
  await putBack(row);
  const chips = T.eng.chips.u3;
  ok(await hmAct("u3", "stand", t));
  assert.ok(!T.eng.seats.includes("u3"));
  assert.equal(await bal("u3"), row.points_balance + chips);
  assert.equal((await txKeys(new RegExp(`^chm:${t}:u3:out:`))).length, 1);
  assert.equal(await total(), start);
});

test("the cash-out fix never closes a table with a stack on it: the host's !holdem end and the idle close leave a refused seat (sitting out) and the table open; it closes once that cash-out goes through", async () => {
  // the host closes it
  await fresh();
  let t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["2000"]));
  ok(await hmAct("u2", "sit", t, ["2000"]));
  let start = await total();
  let row = await users("u2");
  await sql("DELETE FROM users WHERE userId = 'u2'");
  let errs;
  let r;
  errs = await capture(async () => { r = await hmAct("u1", "end", t); });
  assert.deepEqual(thrown(errs), []);
  assert.equal(r.ok, false);
  assert.match(r.reply, /stays open/, r.reply);
  let T = get(t);
  assert.equal(T.status, "open");
  assert.deepEqual(T.eng.seats, ["u2"]);
  assert.equal(T.eng.chips.u2, 2000);
  assert.equal(T.qol.u2.out, true);
  assert.equal(await bal("u1"), 100000, "the host's own stack came back");
  assert.equal((await rowState(t)).status, "open");
  await putBack(row);
  for (let i = 0; i < 70; i++) await later(10);                     // its sit-out clock (10 minutes): the cash-out goes through
  assert.equal((await rowState(t)).status, "closed", "the last seat out closes it");
  assert.equal(await bal("u2"), 100000);
  assert.equal(await total(), start);
  // the 5-minute idle close
  await fresh();
  t = await hm("u1");
  ok(await hmAct("u1", "sit", t, ["2000"]));
  ok(await hmAct("u2", "sit", t, ["2000"]));
  start = await total();
  row = await users("u2");
  await sql("DELETE FROM users WHERE userId = 'u2'");
  errs = await capture(async () => { for (let i = 0; i < 40; i++) await later(10); });
  T = get(t);
  assert.deepEqual(thrown(errs), []);
  assert.equal(refusedLines(errs, "u2").length, 1, "tried once at the idle close, then by its sit-out clock: " + errs.join(" | "));
  assert.equal(T.status, "open");
  assert.deepEqual(T.eng.seats, ["u2"]);
  assert.equal(T.qol.u2.out, true);
  await putBack(row);
  for (let i = 0; i < 70; i++) await later(10);
  assert.equal((await rowState(t)).status, "closed");
  assert.equal(await bal("u2"), 100000);
  assert.equal(await total(), start);
});

test("the scrub blanks every cached `cards` reply - Pepe's !cards from a room and the website's, matched on the reply (any table_id): prod's hole cards never stay in the copy", async () => {
  await fresh();
  const roomie = (uid) => Object.assign(who(uid), { via: "room", camfrog: "TestFrog" + uid.slice(1), room: "RoomA" });
  // as Pepe's /bot/act does (casino/routes.js): the room's table found by the room, the key cf-<idem>
  const ract = (uid, verb, args) => { svc.S.rate.clear(); const T = svc.tableForRoom("RoomA"); return svc.act(roomie(uid), verb, args || [], { room: "RoomA", table: T ? T.id : null, game: "holdem" }, "cf-stg-" + ++k); };
  const t = ok(await ract("u1", "start", ["25/50"])).table;
  ok(await ract("u1", "sit", ["2000"]));
  ok(await ract("u2", "sit", ["2000"]));
  ok(await ract("u1", "deal"));
  const r = ok(await ract("u1", "cards"));
  const key = "cf-stg-" + k;
  const mine = "Your hand: " + H.cardsStr(get(t).eng.hole.u1);
  assert.ok(r.reply.includes(mine), r.reply);
  ok(await hmAct("u2", "cards", t));                                // the website's `cards`
  const theirs = "Your hand: " + H.cardsStr(get(t).eng.hole.u2);
  // a cached reply stored without its table (the statement never relies on table_id)
  const loose = "Your hand: " + H.cardsStr(["As", "Kd"]);
  await sql("INSERT INTO casino_actions (key, table_id, userId, response, created) VALUES ('cf-stg-loose', NULL, 'u3', ?, ?)", [JSON.stringify({ ok: true, reply: "🂠 " + loose + " | Board: —", pm: true }), NOW]);
  // and a cached reply that isn't JSON (never touched, never breaks the step)
  await sql("INSERT INTO casino_actions (key, table_id, userId, response, created) VALUES ('cf-stg-bad', NULL, 'u3', 'Your hand: x', ?)", [NOW]);
  const { file, dir } = await refresh();
  const buf = fs.readFileSync(file);
  for (const x of [mine, theirs, loose]) assert.ok(!buf.includes(Buffer.from(x, "utf8")), "the copy still holds " + x);
  const got = (await fileRows(file, `SELECT response FROM casino_actions WHERE key = '${key}'`))[0];
  assert.deepEqual(JSON.parse(got.response), { ok: true, reply: "", pm: true }, "the row stays, its reply blanked");
  assert.equal((await fileRows(file, "SELECT response FROM casino_actions WHERE key = 'cf-stg-bad'"))[0].response, "Your hand: x");
  // a second run (refresh-staging-db.sh can run two lists) changes nothing more
  const again = execFileSync(process.execPath, [path.join(repo, "deploy", "keep-staging-tables.js"), file + ".previous", file], { encoding: "utf8" });
  assert.match(again, /casino_actions scrubbed 0 \(hole cards\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});
