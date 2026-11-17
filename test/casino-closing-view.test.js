// 1.99aoj review - a blackjack table that waits to close (a payout / refund it still owes: T.closing) says so, and owed items a rollback
// build closed into a table's saved row are found at boot. On a temp DB and in vms (invented accounts only):
//   * the server: the table's view and its lobby row carry `closing` (the frozen table's; a table in play: false)
//   * the lobby (public/js/casino-ui.js on the real partials): a closing table's card reads "Closing · settling a payout or refund" with
//     Watch only - no Join - and the hero's "open tables" / "players seated" leave it out
//   * the table page (public/js/casinobj.js in a vm, stub CZ): "This table is closing", no bet dock, no Deal, Leave kept; a table in play
//     still shows its dock
//   * owed.closedAudit at boot: a closed row whose saved owed holds an item that never landed is named in the log and in ONE ops alert;
//     an empty owed, a landed item, a redirected one and an open table are not
//   * the owed page's "Recent actions" help says which refusals are logged
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-closing-view.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-closing-view-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.PEPE_CONTROL_SECRET;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const svc = require(path.join(repo, "casino", "service"));
const OW = require(path.join(repo, "casino", "owed"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;        // nobody is veiled here
require(path.join(repo, "casino", "rewards")).hooks.updateLevel = async () => {};
const funding = require(path.join(repo, "funding"));
const { partial, page, flush, miniDom, rd } = require("./fixtures/casino-dom");

let NOW = Date.UTC(2026, 10, 17, 6, 0, 0);
svc.S.hooks.now = () => NOW;
let k = 0;
const ID = { ann: "p-ann-01", bob: "p-bob-02", adm: "p-adm-08" };
const mk = (uid, name) => ({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false });
const ann = mk(ID.ann, "Ann"), bob = mk(ID.bob, "Bob");
const boss = Object.assign(mk(ID.adm, "Adminy"), { admin: true });
const A = (who, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], opts || {}, "cv-" + ++k); };
const ok = (r) => { assert.ok(r && r.ok, r && (r.reply || r.error || JSON.stringify(r))); return r; };
const capture = async (fn) => {
  const errs = [], ce = console.error, cw = console.warn;
  console.error = (...a) => errs.push(a.join(" "));
  console.warn = (...a) => errs.push(a.join(" "));
  try { await fn(); } finally { console.error = ce; console.warn = cw; }
  return errs;
};
const alerts = [];
svc.S.hooks.opsAlert = async (a) => { alerts.push(a); return { admins: 1 }; };

async function fresh() {
  svc.stop();
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "casino_settings"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  await runQuery("DELETE FROM users");
  for (const [id, name, cls] of [[ID.ann, "Ann", "pleb"], [ID.bob, "Bob", "pleb"], [ID.adm, "Adminy", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, 100000)", [id, name.toLowerCase(), name, cls]);
  }
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  funding.sync({});
  alerts.length = 0;
  NOW += 3600e3;
  await svc.boot({ tick: false });
  for (const [kk, v] of [["bj_enabled", "1"], ["hm_enabled", "1"]]) await svc.setSetting(kk, v, "test");
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER,
                  created_at TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery("CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, points INTEGER, requirement TEXT, pat INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE classes (classId TEXT PRIMARY KEY, class TEXT)");
  await funding.init();
});
test.after(() => svc.stop());

/** Bob hosts, Ann bets 1500, her account goes, an admin closes the table: her refund is owed, the table waits to close (T.closing) */
async function closingTable() {
  const t = ok(await A(bob, "start", [], { room: null })).table;
  ok(await A(ann, "bet", ["1500"], { table: t }));
  await runQuery("DELETE FROM users WHERE userId = ?", [ID.ann]);
  await capture(async () => { assert.equal((await A(boss, "end", [], { table: t })).ok, false); });
  assert.ok(svc.getTable(t).closing, "the close waits for the owed refund");
  return t;
}

// ── the server ──
test("the view and the lobby row say `closing` for a table whose close waits for what it owes; a table in play says false", async () => {
  await fresh();
  const t = await closingTable();
  const other = ok(await A(boss, "start", [], { room: null })).table;
  const v = svc.publicView(svc.getTable(t));
  assert.equal(v.closing, true);
  assert.equal(v.status, "open");
  assert.equal(svc.publicView(svc.getTable(other)).closing, false);
  const rows = Object.fromEntries(svc.lobby().map((r) => [r.id, r]));
  assert.equal(rows[t].closing, true);
  assert.equal(rows[other].closing, false);
  // it still refuses a bet, as before (the page no longer offers one)
  assert.match((await A(bob, "bet", ["500"], { table: t })).reply, /closing/);
});

// ── the lobby ──
const NOWMS = 1800000000000;
const bjRow = (id, o) => Object.assign({ id, game: "bj", host: "Ann", room: null, rooms: [], adverts: [], phase: "betting", closing: false, players: 1, max_seats: 6,
  min_bet: 100, max_bet: 100000, round_no: 3, high_stakes: false, theme: "classic", proof: null, stream_queue: null }, o);
const LOBBY = (tables) => ({ roulette: { on: false, lobby: null, wheels: [] }, enabled: true, hm_enabled: true, tables, rooms: [], stream: null,
  me: { name: "Bob", balance: 5000, high_roller: false }, themes: { pick: false, list: [] }, now: NOWMS,
  limits: { bj: { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 1000000 }, holdem: { sb_cap: 5000, bb_cap: 10000, hr_ladder: [] } } });
async function lobbyPage(data) {
  const top = partial("casino-top", { game: "bj", tableId: null });
  const lob = partial("casino-lobby", { game: "bj", bjOn: true, hmOn: true });
  const P = page(`<main class="ds-page flow cz" id="cb" data-game="bj" data-table="" data-signed="1" data-user="bob">${top}${lob}</main>`, { "/api/casino/lobby": data });
  P.CZ.startLobby();
  await flush(); await flush();
  return P;
}

test("lobby: a closing table's card says so and offers Watch only; the hero's open tables / players seated leave it out", async () => {
  const P = await lobbyPage(LOBBY([bjRow("t1", { closing: true, players: 5, host: "Dan" }), bjRow("t2", { players: 2 })]));
  const cards = P.$("cz-tables").querySelectorAll("article");
  const card = (id) => cards.find((c) => c.getAttribute("data-id") === id);
  assert.match(card("t1").querySelector(".tcard-h small").textContent, /Blackjack · Closing · settling a payout or refund/);
  assert.doesNotMatch(card("t1").textContent, /Taking bets/);
  assert.deepEqual(card("t1").querySelectorAll(".acts a").map((a) => a.textContent.trim()), ["👁 Watch"], "no Join on a closing table");
  assert.match(card("t2").querySelector(".tcard-h small").textContent, /Taking bets/);
  assert.deepEqual(card("t2").querySelectorAll(".acts a").map((a) => a.textContent.trim()), ["Join", "👁 Watch"]);
  const stat = (id) => P.$(id).querySelector("b").textContent;
  assert.deepEqual([stat("cz-stat-tables"), stat("cz-stat-players")], ["1", "2"], "the closing table and its 5 seats are not counted");
});

// ── the table page ──
const IDS = ["cz-dealer", "cz-dval", "cz-seats", "cz-msg", "cz-fclock", "cz-meta", "cz-watchbar", "cz-dock", "cz-playbox", "cz-betbox", "cz-dclock", "cz-stake", "cz-stakelbl",
             "cz-limits", "cz-chips", "cz-bet", "cz-clear", "cz-custom-err", "cz-custom-go", "cz-custom-hint", "cz-rebet", "cz-auto", "cz-autooff", "cz-wait", "cz-deal",
             "cz-leave", "cz-histbtn"];
function tablePage() {
  const D = miniDom();
  const markup = `<main id="cb"><div id="cz-felt"></div>${IDS.map((id) => `<div id="${id}"></div>`).join("")}<form id="cz-custom"><input id="cz-custom-in"></form></main>`;
  for (const n of D.parse(markup)) D.body.appendChild(n);
  D.doc.dispatchEvent = () => true;
  const fill = (d, v) => String(d && typeof d === "object" ? (v && Number(v.count) === 1 ? d.one : d.other) : d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CZ = {
    $: (id) => D.doc.getElementById(id), T: (kk, d, v) => fill(d, v), esc, fmt: (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US"),
    short: (n) => String(n), signed: true, tableId: "abcdef0123", reduced: true,
    actor: () => async () => ({ ok: true }), wireHost() {}, startTable(render) { CZ.render = render; return () => {}; }, startLobby() {},
    armClock() {}, drawCards: () => 0, staticCards: () => "", avatarHTML: () => "", seatWho: (s, inner) => inner, stackHTML: () => "", net: () => "",
    pop() {}, announce() {}, theme() {}, loadHistory() {}, openSheet() {},
  };
  const ctx = { window: { CZ }, document: D.doc, location: { hash: "" }, console, setTimeout: () => 0, clearTimeout() {}, Date, Math, JSON, Number, String, Array, Object,
                CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; } };
  vm.createContext(ctx);
  vm.runInContext(rd("public", "js", "casinobj.js"), ctx, { filename: "casinobj.js" });
  return { $: CZ.$, render: (d) => CZ.render(d) };
}
const tview = (o) => ({
  table: Object.assign({ id: "abcdef0123", game: "bj", status: "open", phase: "betting", closing: false, rev: 4, room: null, rooms: [], host: "Bob", round_no: 2,
    min_bet: 100, max_bet: 100000, high_stakes: false, max_seats: 6, decks: 6, act_secs: 30, dealer: { cards: [], down: 0, value: 0 }, turn: null, bet_deadline: null,
    last_round: null, seats: [{ name: "Bob", seat: "s1", bet: 0, pending: 0, hands: [], host: true, via: "web" }] }, o),
  me: { name: "Bob", balance: 5000, banned: false, admin: false, high_roller: false, seat: "s1", host: true, bet: 0, pending: 0, autobet: false, lastbet: 500,
        my_turn: false, can_insure: false },
});

test("table page: a closing table says so and has no bet dock (no chips, Bet, Rebet, Autobet or Deal) - Leave stays; in play the dock is there", () => {
  const P = tablePage();
  P.render(tview());
  assert.match(P.$("cz-msg").textContent, /^Place your bets/);
  assert.equal(P.$("cz-betbox").hidden, false, "in play: the chips and Bet");
  assert.equal(P.$("cz-wait").hidden, true);
  P.render(tview({ closing: true }));
  assert.match(P.$("cz-msg").textContent, /^This table is closing/);
  assert.equal(P.$("cz-msg").querySelector("small").textContent, "It closes once a payout or refund it still owes goes through. No new bets or rounds until then.");
  assert.equal(P.$("cz-betbox").hidden, true, "no chips / Bet / Rebet / Autobet");
  assert.equal(P.$("cz-deal").hidden, true);
  assert.equal(P.$("cz-autooff").hidden, true);
  assert.equal(P.$("cz-wait").hidden, false);
  assert.equal(P.$("cz-wait").textContent, "This table is closing: it takes no new bets. You can still leave.");
  assert.equal(P.$("cz-leave").hidden, false, "leaving still works");
  assert.equal(P.$("cz-watchbar").hidden, true, "no 'place a bet below to take a seat'");
  // a watcher (no seat) is told the same, without the leave
  const W = tablePage();
  const v = tview({ closing: true });
  Object.assign(v.me, { seat: null, host: false });
  W.render(v);
  assert.equal(W.$("cz-wait").textContent, "This table is closing: it takes no new bets.");
  assert.equal(W.$("cz-betbox").hidden, true);
  assert.equal(W.$("cz-leave").hidden, true);
  assert.equal(W.$("cz-watchbar").hidden, true, "no 'You're watching. Place a bet below to take a seat.'");
  // (a view that still shows a bet in the window - the close refunds it - offers no Deal either)
  const D = tablePage();
  const vb = tview({ closing: true });
  vb.me.bet = 500;
  D.render(vb);
  assert.equal(D.$("cz-deal").hidden, true);
  assert.equal(W.$("cz-seats").querySelectorAll("[data-sit]").length, 0, "no 'Open seat: bet to sit' at a closing table");
  const X = tablePage();
  X.render(Object.assign(tview(), { me: v.me }));
  assert.equal(X.$("cz-seats").querySelectorAll("[data-sit]").length, 5, "in play: the five open seats offer it");
});

// ── owed items a rollback closed into a row ──
async function closedRow(id, game, owed, extra) {
  const T = Object.assign({ id, game, status: "closed", closed_at: NOW - 60000, owed }, extra || {});
  await runQuery("INSERT INTO casino_tables (id, game, status, room, host, state, rev, created, updated) VALUES (?, ?, ?, NULL, NULL, ?, 1, ?, ?)",
                 [id, game, T.status, JSON.stringify(T), NOW, NOW]);
}
const owedItem = (uid, amount, kind) => ({ uid, amount, round: 3, kind: kind || "payout", type: "blackjack payout", since: NOW - 7200e3, tries: 1, code: "E_NO_ACCOUNT", next: NOW });

test("boot: owed items a rollback build closed into a table's row are named once in the log and in one ops alert - landed / settled / empty ones are not", async () => {
  await fresh();
  await closedRow("c0ffee0001", "bj", { "cbj:c0ffee0001:r3:p-gone-1:pay": owedItem("p-gone-1", 2000), "cbj:c0ffee0001:r3:p-gone-2:refund": owedItem("p-gone-2", 600, "refund") });
  await closedRow("c0ffee0002", "holdem", { "chm:c0ffee0002:p-gone-3:buyin:refund": owedItem("p-gone-3", 3000, "refund") });
  await closedRow("c0ffee0003", "bj", {});                                                                   // nothing owed
  await closedRow("c0ffee0004", "bj", { "cbj:c0ffee0004:r1:p-ann-01:pay": owedItem(ID.ann, 900) });          // its credit landed
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('cbj:c0ffee0004:r1:p-ann-01:pay', ?, 'blackjack payout', 900)", [ID.ann]);
  await closedRow("c0ffee0005", "bj", { "cbj:c0ffee0005:r1:p-gone-4:pay": owedItem("p-gone-4", 700) });       // an owner wrote it off already
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('cbj:c0ffee0005:r1:p-gone-4:pay:writeoff', 'cbj:c0ffee0005:r1', 700)");
  await closedRow("c0ffee0006", "roulette", { "x:y": owedItem("p-gone-5", 50) });                            // (roulette keeps no T.owed)
  svc.stop();
  alerts.length = 0;
  const errs = await capture(() => svc.boot({ tick: false }));
  const line = errs.find((l) => l.includes("closed table(s) still hold"));
  assert.ok(line, errs.join("\n"));
  assert.match(line, /^\[casino\] 2 closed table\(s\) still hold 5,600 PAT owed that no build pays \(a rollback closed them\): c0ffee0001, c0ffee0002 - settle them by hand/);
  assert.equal(alerts.length, 1, "one ops alert");
  assert.equal(alerts[0].source, "casino_owed");
  assert.match(alerts[0].title, /^2 closed casino table\(s\) still hold 5,600 PAT owed$/);
  assert.match(alerts[0].body, /c0ffee0001, c0ffee0002\. Nothing retries or counts them/);
  assert.doesNotMatch(JSON.stringify(alerts[0]), /p-gone|p-ann/, "no account id in the alert");
  const ref = alerts[0].ref;
  assert.deepEqual((await OW.closedAudit({ alert: async () => {} })).map((x) => [x.table, x.game, x.n, x.amount]),
                   [["c0ffee0001", "bj", 2, 2600], ["c0ffee0002", "holdem", 1, 3000]]);
  // the next boot names the same set under the same ref (opsalerts.js files one alert per ref)
  svc.stop();
  alerts.length = 0;
  await capture(() => svc.boot({ tick: false }));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].ref, ref);
  // cleared by hand (the runbook's UPDATE): nothing to name
  await runQuery("UPDATE casino_tables SET state = json_remove(state, '$.owed') WHERE id IN ('c0ffee0001', 'c0ffee0002') AND status = 'closed'");
  svc.stop();
  alerts.length = 0;
  const errs2 = await capture(() => svc.boot({ tick: false }));
  assert.equal(alerts.length, 0);
  assert.ok(!errs2.some((l) => l.includes("closed table(s) still hold")), errs2.join("\n"));
});

test("boot: no closed row with anything owed - no log line, no alert (an open table's owed item is the tool's, not this audit's)", async () => {
  await fresh();
  await closingTable();                                     // an OPEN table holding an owed refund
  svc.stop();
  alerts.length = 0;
  const errs = await capture(() => svc.boot({ tick: false }));
  assert.equal(alerts.length, 0);
  assert.ok(!errs.some((l) => l.includes("closed table(s) still hold")), errs.join("\n"));
});

// ── the owed page's help ──
test("the owed page's Recent actions help says which refusals are in the admin log (the ones turned down before anything was tried are not)", () => {
  const v = rd("views", "admin", "casino-owed.ejs");
  const help = /<h2 id="owedRecentT">Recent actions<\/h2>\s*<p class="adm-help">([^<]*)<\/p>/.exec(v);
  assert.ok(help, "the help line under Recent actions");
  assert.doesNotMatch(help[1], /Every action on this page is in the admin log/, "a wrong password or a short reason never was");
  assert.match(help[1], /the ones whose credit was refused/);
  assert.match(help[1], /turned down before anything was tried \(no reason, a wrong password, an account that doesn't exist, can't be paid or must be confirmed first, a seat still in a hand, an item that changed since the page was drawn\) is answered beside the item and isn't logged/);
});
