// Train 3a (owner answer 1, 2026-11-07: "Poker timeout rule ok"): the hand-off 21 timeout rule ships live, so for its first
// 7 days a player's first Hold'em buy-in carries a one-time notice of it (casino/notices.js): a website player gets it as
// `notice` (the table page shows it, translated - js.casino.rule_timeout), a Camfrog player as a PM from Pepe. Its words are
// checked against what casino/holdem.js does (60 s + the time bank, check-or-fold, two in a row, the sit-out limit).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-notice-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "casino", "hmengine"));
const svc = require(path.join(repo, "casino", "service"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;
const funding = require(path.join(repo, "funding"));

const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
let NOW = T0;
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const key = () => `notice-key-${++k}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const ann = mk("u1", "Ann", { camfrog: "AnnCF", via: "room" });
const bob = mk("u2", "Bob", { iph: "ip-b" });
const dan = mk("u4", "Dan");
const eve = mk("u5", "Eve");
const fay = mk("u6", "Fay");
const A = (who, verb, args, opts) => svc.act(who, verb, args || [], Object.assign({ game: "holdem" }, opts || {}), key());
const bal = async (uid) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
const TEXT = (mins) => "🆕 New rule: if your timer and time bank run out you check (or fold if you can't check). Two timeouts in a row sit " +
  `you out. Sitting out for ${mins} minute${mins === 1 ? "" : "s"} cashes you out.`;

async function fresh({ wipeNotices = true } = {}) {
  svc.stop();
  svc.S.hooks.deck = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  if (wipeNotices) await runQuery("DELETE FROM casino_notice_seen").catch(() => {});
  for (const u of ["u1", "u2", "u4", "u5", "u6"]) await runQuery("UPDATE users SET points_balance = 100000, casino_banned = 0 WHERE userId = ?", [u]);
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  funding.sync({});
  await svc.boot({ tick: false });
  await svc.setSetting("hm_enabled", "1", "test");
  await svc.setSetting("bj_enabled", "1", "test");
}
async function table(host = dan) {
  const r = await A(host, "start", ["25/50"], { room: null });
  assert.ok(r.ok, r.reply);
  return r.table;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const [id, u, d, cf] of [["u1", "ann", "Ann", "AnnCF"], ["u2", "bob", "Bob", null], ["u4", "dan", "Dan", null], ["u5", "eve", "Eve", null], ["u6", "fay", "Fay", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 100000)", [id, u, d, cf]);
  }
  await funding.init();
});
test.after(() => svc.stop());

test("a website player's first Hold'em buy-in in the first 7 days carries the notice - once", async () => {
  NOW = T0;
  await fresh();
  const tid = await table();
  const r = await A(bob, "sit", ["2000"], { table: tid });
  assert.ok(r.ok, r.reply);
  assert.equal(r.reply, "you bought in for 2,000.", "the reply itself is unchanged");
  assert.equal(r.quiet, true, "the website keeps its quiet reply (the page shows the notice)");
  assert.deepEqual(r.notice, { id: "hm_timeout", mins: 10, text: TEXT(10) });
  const again = await A(bob, "sit", ["500"], { table: tid });
  assert.ok(again.ok);
  assert.equal(again.notice, undefined, "a top-up: not again");
  const t2 = await table(eve);
  const other = await A(bob, "sit", ["2000"], { table: t2 });
  assert.equal(other.notice, undefined, "another table: not again (once per player)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_notice_seen WHERE userId = 'u2' AND notice = 'hm_timeout'"))[0].n, 1);
});

test("a Camfrog player gets it as a PM from Pepe - once", async () => {
  NOW = T0;
  await fresh();
  const tid = await table();
  const r = await A(ann, "sit", ["2000"], { table: tid });
  assert.ok(r.ok, r.reply);
  assert.equal(r.reply, "you bought in for 2,000. " + TEXT(10));
  assert.equal(r.pm, true, "privately (Pepe PMs a pm reply)");
  assert.ok(!r.quiet, "not quiet - Pepe says it");
  const again = await A(ann, "sit", ["100"], { table: tid });
  assert.equal(again.reply, "you bought in for 100.");
  assert.equal(again.quiet, true);
  assert.equal(again.pm, undefined);
});

test("only in the first 7 days after the first start with it - a restart doesn't move the window", async () => {
  NOW = T0;
  await fresh();
  const from = (await getQuery("SELECT value FROM casino_settings WHERE key = 'notice_from:hm_timeout'"))[0];
  assert.ok(from && Number(from.value) === T0, "the window starts at the first boot with the rule");
  NOW = T0 + 3 * DAY;
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(Number((await getQuery("SELECT value FROM casino_settings WHERE key = 'notice_from:hm_timeout'"))[0].value), T0);
  const tid = await table();
  NOW = T0 + 7 * DAY - 1000;
  assert.ok((await A(eve, "sit", ["2000"], { table: tid })).notice, "day 7, a second before the end: shown");
  NOW = T0 + 7 * DAY;
  const late = await A(fay, "sit", ["2000"], { table: tid });
  assert.ok(late.ok);
  assert.equal(late.notice, undefined, "from day 7 on: never");
  assert.equal(late.quiet, true);
});

test("the minutes follow the sit-out limit set on /admin/games", async () => {
  NOW = T0;
  await fresh();
  await svc.setSetting("hm_sitout_mins", "15", "test");
  const tid = await table();
  assert.deepEqual((await A(bob, "sit", ["2000"], { table: tid })).notice, { id: "hm_timeout", mins: 15, text: TEXT(15) });
  await svc.setSetting("hm_sitout_mins", "1", "test");
  assert.equal((await A(eve, "sit", ["2000"], { table: tid })).notice.text, TEXT(1), "1 minute");
});

test("what it says is what the table does", async () => {
  NOW = T0;
  await fresh();
  const tid = await table(ann);
  for (const p of [ann, bob, dan]) assert.ok((await A(p, "sit", ["2000"], { table: tid })).ok);
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  const T = svc.getTable(tid), move = (p, v, a = []) => { svc.S.rate.clear(); return A(p, v, a, { table: tid }); };
  const who = (uid) => [ann, bob, dan].find((p) => p.uid === uid);
  // "if your timer and time bank run out ... fold if you can't check": 60 s, then the bank, then a fold (a bet to call)
  let u = H.currentActor(T.eng);
  assert.ok(H.toCall(T.eng, u) > 0);
  await later(60);
  assert.ok(T.turn && T.turn.bank_started && !T.eng.folded.includes(u), "after 60 s the time bank runs");
  await later(T.qol[u].bank + 1);
  assert.ok(T.eng.folded.includes(u) && T.eng.seats.includes(u), "then a fold - the seat is kept");
  assert.equal(T.qol[u].timeouts, 1);
  const first = u;
  // "... you check": the next timeout with nothing to call is a check
  while (T.eng.hand_active && T.eng.street === 0) { const x = H.currentActor(T.eng); await move(who(x), H.toCall(T.eng, x) ? "call" : "check"); }
  u = H.currentActor(T.eng);
  assert.equal(H.toCall(T.eng, u), 0);
  T.qol[u].bank = 0;
  await later(61);
  assert.ok(!T.eng.folded.includes(u) && T.eng.players.includes(u), "a timeout with nothing to call checks");
  // "Two timeouts in a row sit you out": the same player times out again in the next hand, nothing in between
  while (T.eng.hand_active) { const x = H.currentActor(T.eng); await move(who(x), H.toCall(T.eng, x) ? "call" : "check"); }
  assert.equal(T.qol[first].timeouts, 1, "still one: it hasn't acted since");
  assert.equal(T.qol[first].out, false, "one timeout: still playing");
  await later(15);
  assert.ok(T.eng.hand_active && T.eng.players.includes(first), "the next hand deals it in");
  while (H.currentActor(T.eng) !== first) { const x = H.currentActor(T.eng); await move(who(x), H.toCall(T.eng, x) ? "call" : "check"); }
  assert.equal(T.qol[first].bank, 0, "its time bank is spent");
  await later(61);
  assert.equal(T.qol[first].out, true, "the second timeout in a row: sitting out");
  assert.ok(T.eng.seats.includes(first), "...still seated");
  while (T.eng.hand_active) { const x = H.currentActor(T.eng); await move(who(x), H.toCall(T.eng, x) ? "call" : "check"); }
  // "Sitting out for 10 minutes cashes you out"
  T.dl.next = null;
  const stack = T.eng.chips[first], before = await bal(first);
  await later(9 * 60);
  assert.ok(T.eng.seats.includes(first), "9 minutes: still seated");
  await later(61);
  assert.ok(!T.eng.seats.includes(first), "10 minutes sitting out: cashed out");
  assert.equal(await bal(first), before + stack, "the stack paid back as PAT");
});

test("the table page shows it, translated; it is Hold'em's only", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const v = en["js.casino.rule_timeout"];
  assert.ok(v && typeof v === "object", "a plural string (one / other)");
  assert.equal(v.other.replace("{count}", "10"), TEXT(10), "the page's English = Pepe's words");
  assert.equal(v.one.replace("{count}", "1"), TEXT(1));
  const hm = fs.readFileSync(path.join(repo, "public", "js", "casinohm.js"), "utf8");
  assert.match(hm, /j\.notice/, "casinohm.js reads the sit answer's notice");
  assert.match(hm, /T\("rule_timeout"/, "...and shows its translated line");
  const ui = fs.readFileSync(path.join(repo, "public", "js", "casino-ui.js"), "utf8");
  assert.match(ui, /function note\(/, "casino-ui.js has the notice box");
  const top = fs.readFileSync(path.join(repo, "views", "partials", "casino-top.ejs"), "utf8");
  assert.match(top, /id="cz-note"/, "the box is on the table page");
  const bj = fs.readFileSync(path.join(repo, "casino", "service.js"), "utf8");
  assert.ok(!/notices\.take\(/.test(bj), "blackjack never shows it");
});
