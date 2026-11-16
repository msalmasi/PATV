"use strict";
// roulette2 WP7 (FAIR-1 for raffles and the lotto): a staging refresh (deploy/refresh-staging-db.sh: VACUUM INTO, then
// deploy/keep-staging-tables.js on the copy) must never let staging draw, or publish, a raffle or a lotto draw prod is still selling: an
// OPEN raffle's server_seed with the tickets digest taken at its draw IS the winning ticket, and a lotto draw's (selling or closed) IS its
// numbers. "Prod" has open raffles of every kind (a community PAT prize with buyers, a shop-item prize, a custom prize nobody bought yet, a
// House raffle), one already drawn (its seed revealed), a lotto draw already paid and the next one selling with three buyers. The copy -
// built the way prod's older refresh script builds it, a plain VACUUM INTO - keeps none of the unrevealed seeds (not even in its free
// pages); staging (its own process: test/fixtures/raffle-lotto-staging-boot.js) boots 11 minutes later and retires every copy through its
// own refund path - every ticket and purchase back once by its key, the prize back, the lotto's pot and House shares back, nothing drawn or
// revealed, no raffle / lotto event or notice - and a second boot changes nothing. Then, in this process: a refused refund (an account that
// is gone) keeps the copy out of play (no ticket sold, never drawn or expired, no new lotto draw) until it can be retired, a crash mid-void,
// a CLOSED lotto draw, and the scrub run twice.
//   node --test test/raffle-lotto-staging.test.js      (uses a temp DB)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "raffle-lotto-staging-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.RAFFLES_NO_TIMER = "1";
const { runQuery: sql, getQuery: rows } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const P = require(path.join(repo, "pools"));
const EC = require(path.join(repo, "econstore"));
const ESC = require(path.join(repo, "escrow", "ledger"));
const SHOP = require(path.join(repo, "shop"));
const RF = require(path.join(repo, "raffles"));
const LE = require(path.join(repo, "lotto", "engine"));
const LS = require(path.join(repo, "lotto", "service"));
const fair = require(path.join(repo, "casino", "fair"));
const K = require(path.join(repo, "deploy", "keep-staging-tables"));
const funding = require(path.join(repo, "funding"));
const sqlite3 = require(require.resolve("sqlite3", { paths: [repo] }));

const DAY = 86400000;
let NOW = Date.UTC(2026, 10, 12, 16, 0, 0);          // a Thursday: the lotto draws on Sunday 21:00 ET
RF._setClock(() => NOW);
LS._S.hooks.now = () => NOW;
LS._S.hooks.updateLevel = async () => {};
const PEOPLE = ["maker", "ann", "bob", "cat", "dan", "boss"];
const U = (n) => "u_" + n;
const bal = async (uid) => ((await rows("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0] || {}).b;
const one = async (q, a) => Number((await rows(q, a || []))[0].n) || 0;
const total = async () => (await one("SELECT COALESCE(SUM(points_balance),0) AS n FROM users")) + (await one("SELECT COALESCE(SUM(amount),0) AS n FROM jackpot_rakes")) +
  (await one("SELECT COALESCE(SUM(amount),0) AS n FROM escrow_holds WHERE state = 'held'")) + (await one("SELECT COALESCE(SUM(amount),0) AS n FROM lotto_pot")) +
  (await one("SELECT COALESCE(SUM(balance),0) AS n FROM pools"));
const raffle = async (id) => (await rows("SELECT * FROM raffles WHERE id = ?", [id]))[0];
const drawRow = async (d) => (await rows("SELECT * FROM lotto_draws WHERE draw = ?", [d]))[0];
let n = 0;
const idem = () => "wp7idem" + String(++n).padStart(6, "0");
const mkRaffle = (who, o) => RF.create(U(who), Object.assign({ title: "Friday mega raffle", prize_kind: "pat", prize_amount: "10k", price: 1000, trigger: "target",
                                                              target: 50, min_tickets: 1, idem: idem() }, o || {}));
const buy = (who, id, qty) => RF.buy(U(who), { id, qty, idem: idem() });
const lottoBuy = (who, q) => LS.buy({ uid: U(who), name: who, via: "web" }, { quick: q }, "lt:wp7-" + idem());
/** the scrub's own statements (deploy/keep-staging-tables.js DRAW_SCRUB), on this database, limited to some rows - what a refresh does to the copy */
const scrubRaffle = (id) => sql(K.DRAW_SCRUB.find((s) => s.table === "raffles").sql.replace(/\bmain\./g, "") + " AND id = ?", [id]);
const scrubDraw = (d) => sql(K.DRAW_SCRUB.find((s) => s.table === "lotto_draws").sql.replace(/\bmain\./g, "") + " AND draw = ?", [d]);
async function capture(fn) {
  const lines = [], ce = console.error;
  console.error = (...a) => { lines.push(a.map((x) => (x && x.stack) || String(x)).join(" ")); };
  try { await fn(); } finally { console.error = ce; }
  return lines;
}
async function gone(uid) {
  const r = (await rows("SELECT * FROM users WHERE userId = ?", [uid]))[0];
  await sql("DELETE FROM users WHERE userId = ?", [uid]);
  return r;
}
async function back(r) {
  const cols = Object.keys(r);
  await sql(`INSERT INTO users (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => r[c]));
}

test.before(async () => {
  await sql(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
             points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, level INTEGER DEFAULT 0,
             created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, isEmailVerified INTEGER DEFAULT 0, email TEXT,
             extra_daily_spins INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await sql("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)");
  await sql("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await sql(`CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
             created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0, meta TEXT)`);
  await sql("CREATE TABLE IF NOT EXISTS welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await sql("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  for (const p of PEOPLE) {
    await sql(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, isEmailVerified, email)
               VALUES (?, ?, ?, 'x', ?, 10000000, ?, 1, ?)`, [U(p), p, p, p === "boss" ? "Admin" : "pleb", p === "boss" ? "bosscf" : p + "cf", p + "@example.com"]);
  }
  await sql("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES ('u_pb', 'pb', 'pb', 'x', 0)");     // the store owner
  await require(path.join(repo, "staffroles")).init();
  await sql("INSERT INTO pepe_roles (login, role, ts) VALUES ('bosscf', 'owner', 1)");
  await sql("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 'seed', NULL, 50000000)");
  await rooms.init();
  await P.init(); await EC.init(); await ESC.init();
  await P._setMeta("live", true); P._forgetLive();
  await sql("INSERT INTO pools (key, balance, updated) VALUES ('fortknox', 0, 0), ('reserve', 0, 0), ('mm', 0, 0)");
  await SHOP.ready;
  await sql("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('9c0aa228-e0c4-46dd-97cc-dc41a245bc05', 'PS5 Pro', 400000, 3)");
  await require(path.join(repo, "inbox")).ready;
  await funding.init();
  await RF.init();
  await RF.setConfig({ per_day: 100, open_max: 100 });
  await RF.setEnabled(true);
  await ESC.setMeta("live", true); ESC._forgetLive();
  await LS.boot({ tick: false });
  await LS.setSetting("lotto_backend", "1", "test");
  await LS.tick();                                          // draw #1 opens
});
test.after(() => LS.stop());

/** a staging refresh: the copy built by a plain VACUUM INTO (prod's refresh script a release behind: stale row bytes stay in its page slack
 *  - only the keep step's rebuild clears them), then the keep step (deploy/keep-staging-tables.js, its own process) on it */
async function refresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raffle-lotto-copy-"));
  const old = path.join(dir, "myapp.db"), copy = path.join(dir, "myapp.db.new");
  await new Promise((res, rej) => {
    const d = new sqlite3.Database(old, (e) => (e ? rej(e) : d.exec("CREATE TABLE staging_marker (k TEXT)", (e2) => d.close(() => (e2 ? rej(e2) : res())))));
  });
  await sql("PRAGMA secure_delete = OFF");
  await sql(`VACUUM INTO '${copy.replace(/\\/g, "/")}'`);
  const out = execFileSync(process.execPath, [path.join(repo, "deploy", "keep-staging-tables.js"), old, copy], { encoding: "utf8" });
  fs.renameSync(old, old + ".previous");
  fs.renameSync(copy, old);
  return { dir, out, file: old };
}
const fileRows = async (file, q) => {
  const d = new sqlite3.Database(file);
  try { return await new Promise((res, rej) => d.all(q, (e, r) => (e ? rej(e) : res(r)))); } finally { await new Promise((res) => d.close(res)); }
};

let OPEN = [];          // the open raffles of the end-to-end test (the restart variants below make their own)
test("FAIR-1 for raffles and the lotto: a staging refresh keeps no unrevealed seed; staging retires every copy through its own refund path - once, quietly, unrevealed", async () => {
  // prod: open raffles of every kind (and one drawn), the lotto's draw #1 paid and #2 selling
  const r1 = (await mkRaffle("maker", { prize_amount: "100k" })).id;                                    // a community PAT prize
  await buy("ann", r1, 2); await buy("bob", r1, 3);
  const r2 = (await mkRaffle("maker", { prize_kind: "item", prize_item: "9c0aa228-e0c4-46dd-97cc-dc41a245bc05", trigger: "date", draw_at: NOW + DAY,
                                        expires_at: NOW + 3 * DAY, target: undefined, min_tickets: 5 })).id;   // a shop item (its price held)
  await buy("ann", r2, 1);
  const r3 = (await mkRaffle("maker", { prize_kind: "custom", prize_text: "A custom avatar drawn by me" })).id;   // nobody bought yet
  const r4 = (await mkRaffle("boss", { house: true, prize_amount: "50k", price: 2000 })).id;          // a House raffle (the House pays at the draw)
  await buy("bob", r4, 1); await buy("cat", r4, 2);
  const r5 = (await mkRaffle("maker", { target: 2, prize_amount: "5k" })).id;                          // drawn: its seed is public
  await buy("dan", r5, 2);
  assert.equal((await raffle(r5)).status, "drawn");
  OPEN = [r1, r2, r3, r4];
  // the lotto: draw #1 bought into and paid (its seed revealed), draw #2 selling with three buyers
  await lottoBuy("ann", 3); await lottoBuy("bob", 2);
  assert.equal((await LS.forceDraw("test")).ok, true);
  assert.equal((await drawRow(1)).state, "paid");
  for (const [w, q] of [["ann", 4], ["bob", 1], ["cat", 2]]) assert.equal((await lottoBuy(w, q)).ok, true);
  const d2 = await drawRow(2);
  assert.equal(d2.state, "selling");
  const secrets = Object.fromEntries((await Promise.all(OPEN.map(raffle))).map((r) => [r.id, r.server_seed]));
  for (const s of Object.values(secrets)) assert.match(s, /^[0-9a-f]{64}$/);
  const lottoSecret = d2.server_seed;
  const revealedSeeds = [(await raffle(r5)).server_seed, (await drawRow(1)).server_seed];
  // what each one is owed back on staging: raffle tickets, the creators' prize holds; lotto draw #2's purchases in full
  const lottoCost = Object.fromEntries((await rows("SELECT userId, SUM(cost) AS c FROM lotto_purchases WHERE draw = 2 AND state = 'done' GROUP BY userId")).map((r) => [r.userId, r.c]));
  const owed = { u_ann: 2000 + 1000 + lottoCost.u_ann, u_bob: 3000 + 2000 + lottoCost.u_bob, u_cat: 4000 + lottoCost.u_cat, u_maker: 100000 + 400000, u_dan: 0, u_boss: 0 };
  const prodBal = Object.fromEntries(await Promise.all(PEOPLE.map(async (p) => [U(p), await bal(U(p))])));
  const prodTotal = await total();
  const stock0 = (await rows("SELECT quantity FROM prizes WHERE prizeId = '9c0aa228-e0c4-46dd-97cc-dc41a245bc05'"))[0].quantity;
  const pot0 = await LS.potBalance();
  const drawPot = await one("SELECT COALESCE(SUM(amount),0) AS n FROM lotto_pot WHERE moveId LIKE 'lt:wp7-%:pot'");
  NOW += 1000;

  const { dir, out, file } = await refresh();
  assert.match(out, /raffles scrubbed 4 \(raffle seeds\)/, out);
  assert.match(out, /lotto_draws scrubbed 1 \(lotto seeds\)/, out);
  assert.match(out, /the copy rebuilt$/m, out);
  const bytes = fs.readFileSync(file).toString("latin1");
  for (const [id, s] of Object.entries(secrets)) assert.ok(!bytes.includes(s), "the copy still holds the seed of raffle R" + id);
  assert.ok(!bytes.includes(lottoSecret), "the copy still holds the seed of lotto draw #2");
  for (const s of revealedSeeds) assert.ok(bytes.includes(s), "a revealed seed stays (prod published it at the draw)");
  const copied = Object.fromEntries((await fileRows(file, "SELECT id, status, server_seed, commitment FROM raffles")).map((r) => [r.id, r]));
  for (const id of OPEN) {
    assert.equal(copied[id].server_seed, "", "R" + id);
    assert.equal(copied[id].commitment, RF.commitmentOf(secrets[id]), "the commitment stays (it is public)");
  }
  assert.equal(copied[r5].server_seed, revealedSeeds[0], "a drawn raffle is untouched");
  const cd = Object.fromEntries((await fileRows(file, "SELECT draw, state, server_seed, flags FROM lotto_draws")).map((r) => [r.draw, r]));
  assert.equal(cd[2].server_seed, "");
  assert.equal(JSON.parse(cd[2].flags).copied, 1);
  assert.equal(cd[1].server_seed, revealedSeeds[1], "a paid draw is untouched");

  const raw = execFileSync(process.execPath, [path.join(__dirname, "fixtures", "raffle-lotto-staging-boot.js"), dir, OPEN.join(","), "2", String(NOW)], { encoding: "utf8" });
  const st = JSON.parse(raw.trim().split("\n").pop());
  assert.equal(st.bootRetired, true, "raffles' own boot (register) retires the copies");
  for (const id of OPEN) {
    assert.equal(st.raffles0[id].status, "removed", "staging retires copied raffle R" + id + " at boot");
    assert.match(st.raffles0[id].reason, /copy/);
    assert.equal(st.raffles0[id].digest, null, "never drawn");
    assert.equal(st.raffles0[id].winning_no, null);
    assert.equal(st.raffles2[id].status, "removed", "and a restart doesn't bring it back");
    assert.equal(st.revealed[id].seed, null, "nothing of a copied raffle is revealed on staging");
    for (const b of st.tries[id].buys) assert.deepEqual(b, { ok: false, code: "E_CLOSED" }, "nobody buys into copied raffle R" + id);
    assert.deepEqual(st.tries[id].draw, { drawn: false });
  }
  const sd2 = st.draws0.find((d) => d.draw === 2);
  assert.equal(sd2.state, "void", "staging voids the copied lotto draw at boot");
  assert.equal(sd2.seed, "");
  assert.equal(sd2.white, null, "never drawn");
  assert.equal(st.fair.server_seed, null, "its seed is never revealed");
  assert.equal(st.fair.white, null);
  const d3 = st.draws2.find((d) => d.draw === 3);
  assert.ok(d3 && d3.state === "selling", "a fresh draw of staging's own opens");
  assert.notEqual(d3.commitment, d2.commitment);
  assert.match(d3.seed, /^[0-9a-f]{64}$/);
  assert.equal(st.draws2.filter((d) => ["selling", "closed"].includes(d.state)).length, 1);
  assert.equal(st.info.draw, 3);
  assert.equal(d3.flags.copied, undefined);
  assert.deepEqual(st.events, [], "no raffle_events row for a copied raffle (staging's Pepe never announces it)");
  assert.deepEqual(st.lotto, [{ kind: "open", draw: 3 }], "no lotto event about the copied draw - only staging's own next draw opening");
  assert.equal(st.inbox, 0, "no notice");
  assert.equal(st.after, st.before, "staging's PAT is conserved");
  assert.equal(st.after2, st.after, "a second boot moves nothing");
  assert.equal(st.tx2, st.tx1, "a second boot credits nothing");
  assert.deepEqual(st.bal2, st.bal1);
  assert.equal(st.held, 0, "no raffle hold left");
  for (const p of PEOPLE) assert.equal(st.bal1[U(p)], prodBal[U(p)] + owed[U(p)], p + ": everything held came back, once");
  const lottoRefunds = st.refundKeys.filter((x) => /^lt:wp7-/.test(x));
  assert.equal(lottoRefunds.length, 3, "one refund per purchase of the copied draw, by its own key");
  // prod is untouched: its raffles open on the same seeds, its draw #2 selling on its seed
  for (const id of OPEN) {
    const r = await raffle(id);
    assert.equal(r.status, "open");
    assert.equal(r.server_seed, secrets[id]);
  }
  assert.equal((await drawRow(2)).server_seed, lottoSecret);
  assert.equal((await drawRow(2)).state, "selling");
  assert.equal(await total(), prodTotal);
  assert.equal(await LS.potBalance(), pot0);
  assert.ok(drawPot > 0 && stock0 >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a refused raffle refund (an account that is gone) keeps the copy open and OUT OF PLAY - no ticket, no draw, no expiry - until it can be retired, once", async () => {
  for (const id of OPEN) await RF.takedown(U("boss"), id, "test over");          // (prod's raffles of the test above: nothing else expires here)
  const r = (await mkRaffle("maker", { prize_amount: "20k", target: 3, expires_at: NOW + 2 * DAY })).id;
  await buy("dan", r, 1); await buy("ann", r, 1);
  const start = await total();
  const ev0 = await one("SELECT COALESCE(MAX(id),0) AS n FROM raffle_events");
  const inbox0 = await one("SELECT COUNT(*) AS n FROM inbox");
  const makerBal = await bal(U("maker")), annBal = await bal(U("ann"));
  await scrubRaffle(r);
  const danRow = await gone(U("dan"));
  const errs = await capture(async () => {
    const res = await RF.retireCopies();
    assert.equal(res.failed, 1);
    await RF.retireCopies();                                       // (logged once)
  });
  assert.equal(errs.filter((l) => l.includes(`R${r}:`) && l.includes("couldn't be retired")).length, 1, errs.join("\n"));
  assert.equal((await raffle(r)).status, "open", "rolled back: still open");
  assert.equal(await bal(U("ann")), annBal, "nothing of it moved");
  assert.equal(await total() + danRow.points_balance, start);
  // out of play: no ticket (the one that would reach the target and draw), no draw, no expiry even past it
  await assert.rejects(buy("cat", r, 1), (e) => e.code === "E_CLOSED");
  assert.deepEqual(await RF.draw(r), { drawn: false });
  assert.equal(await RF.maybeDraw(r), null);
  NOW += 3 * DAY;
  await capture(() => RF.tick());
  assert.equal((await raffle(r)).status, "open", "never expired with notices - only retired");
  assert.equal((await raffle(r)).tickets_digest, null);
  assert.throws(() => RF.winningNumber("", "digest", r, 2), /no server seed/, "fair.js's guard: no seed, no draw");
  // the account is back: the clock retires it - every ticket and the prize back, once, quietly
  await back(danRow);
  const danBal = await bal(U("dan"));
  await RF.tick();
  const row = await raffle(r);
  assert.equal(row.status, "removed");
  assert.equal(await bal(U("dan")), danBal + 1000);
  assert.equal(await bal(U("ann")), annBal + 1000);
  assert.equal(await bal(U("maker")), makerBal + 20000, "the prize hold back to the creator");
  assert.equal(await total(), start);
  await RF.tick();
  await RF.retireCopies();
  assert.equal(await bal(U("dan")), danBal + 1000, "once");
  assert.equal(await one("SELECT COUNT(*) AS n FROM raffle_events WHERE id > ?", [ev0]), 0, "no raffle event");
  assert.equal(await one("SELECT COUNT(*) AS n FROM inbox"), inbox0, "no notice");
  assert.equal((await RF.detail(r)).server_seed, undefined);
});

test("a copied lotto draw a refused refund holds up stays out of play (no sale, no close, no draw, no new draw); a crash mid-void; each purchase back once with its pot and House shares", async () => {
  // prod's own draw #2 (selling, three buyers) - the end-to-end test copied it; here THIS database is the copy
  const d = (await LS.info(null)).draw;
  const D0 = await drawRow(d);
  assert.equal(D0.state, "selling");
  const start = await total();
  const pot0 = await LS.potBalance();
  const house0 = await one("SELECT COALESCE(SUM(amount),0) AS n FROM jackpot_rakes");
  const purchases = await rows("SELECT key, userId, cost, pot FROM lotto_purchases WHERE draw = ? AND state = 'done' ORDER BY created, key", [d]);
  assert.ok(purchases.length >= 3);
  const shares = purchases.reduce((s, p) => s + p.pot, 0);
  const ev0 = await one("SELECT COALESCE(MAX(seq),0) AS n FROM lotto_events");
  const bals = Object.fromEntries(await Promise.all(PEOPLE.map(async (p) => [U(p), await bal(U(p))])));
  await scrubDraw(d);
  // the last buyer's account is gone: the purchases before it are refunded, the draw stays copied
  const last = purchases[purchases.length - 1];
  const gonerRow = await gone(last.userId);
  let errs = await capture(async () => { await LS.retireCopies(); await LS.tick(); });
  assert.equal(errs.filter((l) => l.includes(`draw #${d}:`) && l.includes("couldn't be voided")).length, 1, errs.join("\n"));
  assert.equal((await drawRow(d)).state, "selling", "still copied, not void");
  assert.equal((await LS.buy({ uid: U("dan"), name: "dan", via: "web" }, { quick: 1 }, "lt:wp7-x1")).code, "closed", "no ticket into a copy");
  assert.equal((await LS.forceDraw("test")).ok, false, "never drawn");
  assert.equal((await LS.info(null)).sales_open, false);
  NOW = (Number(D0.next_at) + 3600) * 1000;                        // past its close and its draw time
  errs = await capture(() => LS.tick());
  assert.equal((await drawRow(d)).state, "selling", "never closed or drawn here");
  assert.equal((await drawRow(d)).white, null);
  assert.equal(await one("SELECT COUNT(*) AS n FROM lotto_draws WHERE draw > ?", [d]), 0, "no new draw while the copy is in the way");
  assert.equal(await total() + gonerRow.points_balance, start);
  // the account is back - and the next tick crashes mid-void (the refund rolled back with its shares), then finishes
  await back(gonerRow);
  let crashed = 0;
  LS._S.hooks.crash = (at) => { if (at === "copy-refund" && !crashed++) throw new Error("test crash at " + at); };
  await capture(() => LS.tick());
  LS._S.hooks.crash = null;
  assert.equal(crashed, 1);
  assert.equal((await drawRow(d)).state, "selling");
  await LS.tick();
  const D = await drawRow(d);
  assert.equal(D.state, "void");
  assert.equal(JSON.parse(D.flags).void, "copy");
  for (const p of purchases) {
    assert.deepEqual((await rows("SELECT points FROM transactions WHERE transactionId = ?", [p.key + ":refund"])).map((x) => x.points), [p.cost], p.key + " refunded once");
    assert.equal((await rows("SELECT state FROM lotto_purchases WHERE key = ?", [p.key]))[0].state, "refunded");
  }
  for (const p of PEOPLE) {
    const want = bals[U(p)] + purchases.filter((x) => x.userId === U(p)).reduce((s, x) => s + x.cost, 0);
    assert.equal(await bal(U(p)), want, p);
  }
  assert.equal(await LS.potBalance(), pot0 - shares, "the pot gave back the shares it got");
  assert.equal(await one("SELECT COALESCE(SUM(amount),0) AS n FROM jackpot_rakes"), house0 - purchases.reduce((s, p) => s + p.cost - p.pot, 0), "and the House its own");
  assert.equal(await total(), start);
  const kinds = (await rows("SELECT kind, data FROM lotto_events WHERE seq > ?", [ev0])).map((r) => r.kind + ":" + JSON.parse(r.data).draw);
  assert.deepEqual(kinds, [`open:${d + 1}`], "nothing about the copy - only the next draw opening");
  assert.equal((await LS.fairRecord(d)).server_seed, null);
  // again: nothing moves
  await LS.tick(); await LS.retireCopies();
  LS.stop(); await LS.boot({ tick: false });
  assert.equal(await total(), start);
  for (const p of purchases) assert.equal(await one("SELECT COUNT(*) AS n FROM transactions WHERE transactionId = ?", [p.key + ":refund"]), 1);
});

test("a copied lotto draw whose sales had CLOSED (its tickets digest public, its seed not) is voided the same way, never drawn", async () => {
  const d = (await LS.info(null)).draw;
  for (const [w, q] of [["ann", 2], ["cat", 1]]) assert.equal((await lottoBuy(w, q)).ok, true);
  const D0 = await drawRow(d);
  NOW = (Number(D0.close_at) + 5) * 1000;
  await LS.tick();
  const C = await drawRow(d);
  assert.equal(C.state, "closed");
  assert.ok(C.tickets_digest);
  const seed = C.server_seed;
  const start = await total();
  const annBal = await bal(U("ann"));
  await scrubDraw(d);
  assert.throws(() => LE.drawNumbers("", C.tickets_digest, d), /no server seed/, "fair.js's guard: no seed, no numbers");
  NOW = (Number(D0.next_at) + 5) * 1000;                           // its draw time
  await LS.tick();
  const V = await drawRow(d);
  assert.equal(V.state, "void");
  assert.equal(V.white, null, "never drawn");
  assert.equal(V.server_seed, "");
  assert.notEqual(seed, "");
  assert.equal(await bal(U("ann")), annBal + 2 * (await LS.loadSettings()).price);
  assert.equal(await total(), start);
  assert.equal((await LS.fairRecord(d)).server_seed, null);
  assert.equal((await drawRow(d + 1)).state, "selling", "the next draw opens");
});

test("the scrub: only open raffles and unrevealed draws, can run twice (refresh-staging-db.sh runs prod's list and staging's), and a copy of an old prod without the tables is fine", async () => {
  assert.deepEqual(K.DRAW_SCRUB.map((s) => [s.table, s.what]), [["raffles", "raffle seeds"], ["lotto_draws", "lotto seeds"]]);
  assert.ok(K.CASINO_SCRUB.length === 4, "WP1's card / wheel list is untouched");
  const r = (await mkRaffle("maker", { prize_amount: "2k" })).id;
  const { dir, file } = await refresh();
  const again = execFileSync(process.execPath, [path.join(repo, "deploy", "keep-staging-tables.js"), file + ".previous", file], { encoding: "utf8" });
  assert.match(again, /raffles scrubbed 0 \(raffle seeds\)/, again);
  assert.match(again, /lotto_draws scrubbed 0 \(lotto seeds\)/, again);
  const got = (await fileRows(file, `SELECT status, server_seed FROM raffles WHERE id = ${r}`))[0];
  assert.deepEqual(got, { status: "open", server_seed: "" });
  const drawn = await fileRows(file, "SELECT server_seed FROM raffles WHERE status != 'open' AND tickets_digest IS NOT NULL");
  assert.ok(drawn.length && drawn.every((x) => /^[0-9a-f]{64}$/.test(x.server_seed)), "drawn raffles keep their (public) seed");
  fs.rmSync(dir, { recursive: true, force: true });
  // a copy without either table (an older prod): the keep step skips both
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "raffle-lotto-none-"));
  const a = path.join(d2, "a.db"), b = path.join(d2, "b.db");
  for (const f of [a, b]) await new Promise((res, rej) => { const x = new sqlite3.Database(f, (e) => (e ? rej(e) : x.exec("CREATE TABLE t (k TEXT)", (e2) => x.close(() => (e2 ? rej(e2) : res()))))); });
  const none = execFileSync(process.execPath, [path.join(repo, "deploy", "keep-staging-tables.js"), a, b], { encoding: "utf8" });
  assert.ok(!/raffles|lotto_draws/.test(none), none);
  fs.rmSync(d2, { recursive: true, force: true });
  assert.ok(fair);
});
