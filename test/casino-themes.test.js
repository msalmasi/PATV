// Hand-off 20 (owner 2026-11-04, NL-5: "poker table themes (western saloon)"): the card tables' themes - presentation only.
//   * the registry (casino/themes.js): classic (the default) + the western saloon; parseThemeWord; the casino_themes switch
//     (off | staff | everyone, default off): who may pick (the lobby's flag per viewer), themeOf = classic whenever it's off
//   * a table carries its theme for its whole life: !holdem start with the theme word in any position (and with hr), an unknown
//     word refused with the list, POST /api/casino/open {theme}, publicView / the lobby rows say it, a restart keeps it
//   * the dealer's flavour lines: one when a saloon table opens, one on a showdown pot of 50 big blinds or more (never two in a
//     hand, never on classic), the variants rotate, every amount in them is PAT
//   * the pages: a saloon table loads the theme's CSS, art and sound script; a classic table page carries none of it; the CSS
//     is scoped under .cz-theme-saloon, original art only (inline SVG / gradients, no external URL, nothing over 30 KB)
//   * the opt-in sound cues (public/js/casino-sound.js): off by default, nothing before a click, storage / WebAudio failures safe
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-themes.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-themes-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "casino", "hmengine"));
const E = require(path.join(repo, "casino", "bjengine"));
const svc = require(path.join(repo, "casino", "service"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;   // (nobody is veiled here - test/casino-veil.test.js is about veils)
const funding = require(path.join(repo, "funding"));
const themes = require(path.join(repo, "casino", "themes"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

let NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
svc.S.hooks.now = () => NOW;
let k = 0;
const key = () => `th-key-${++k}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const ann = mk("u1", "Ann", { camfrog: "AnnCF", via: "room" });
const bob = mk("u2", "Bob");
const hil = mk("u3", "Hil");                    // a High Roller
const boss = mk("a1", "Boss");                  // a site Admin (casino.admin)
const A = (who, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], Object.assign({ game: "holdem" }, opts || {}), key()); };
const deck = (prefix) => { svc.S.hooks.deck = () => prefix.concat(E.makeShoe(1).filter((c) => !prefix.includes(c))); };
const events = async (tid) => (await getQuery("SELECT kind, data FROM casino_events WHERE table_id = ? ORDER BY seq", [tid])).map((r) => ({ kind: r.kind, ...JSON.parse(r.data) }));
const cowboy = (evs) => evs.filter((e) => e.kind === "line" && /^🤠/.test(e.text || ""));
const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, n) => (v[n] != null ? v[n] : m));
const variants = (ev, v) => themes.THEMES.saloon.lines[ev].map((kk) => fill(EN[kk], v));

async function fresh(mode) {
  svc.stop();
  svc.S.hooks.deck = null;
  svc.S.hooks.shoe = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  for (const u of ["u1", "u2", "u3", "a1"]) await runQuery("UPDATE users SET points_balance = 100000000, casino_banned = 0 WHERE userId = ?", [u]);
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  funding.sync({});
  await svc.boot({ tick: false });
  await svc.setSetting("hm_enabled", "1", "test");
  await svc.setSetting("bj_enabled", "1", "test");
  if (mode) await svc.setSetting("casino_themes", mode, "test");
}
async function open(who, args) {
  const r = await A(who, "start", args, { room: null });
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}
/** heads-up: the player to act goes all-in, the other calls (a full-board showdown) */
async function allIn(tid) {
  const T = svc.getTable(tid);
  let first = true;
  while (T.eng.hand_active) {
    const k2 = H.currentActor(T.eng);
    const who = k2 === "u1" ? ann : bob;
    const r = await A(who, first ? "allin" : "call", [], { table: tid });
    assert.ok(r.ok, r.reply);
    first = false;
  }
}
async function checkDown(tid) {
  const T = svc.getTable(tid);
  while (T.eng.hand_active) {
    const k2 = H.currentActor(T.eng);
    const r = await A(k2 === "u1" ? ann : bob, H.toCall(T.eng, k2) ? "call" : "check", [], { table: tid });
    assert.ok(r.ok, r.reply);
  }
}
const CHOP = ["Kh", "Qh", "Ks", "Qs", "2c", "3d", "4h", "5s", "6c"];          // both play the board's straight: a split pot (two awards)
const ACES = ["As", "Ah", "Ks", "Kh", "2c", "7d", "9h", "3s", "4c"];

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const [id, u, d, cf, cls] of [["u1", "ann", "Ann", "AnnCF", "pleb"], ["u2", "bob", "Bob", null, "pleb"], ["u3", "hil", "Hil", null, "pleb"], ["a1", "boss", "Boss", null, "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 100000000)", [id, u, d, cf, cls]);
  }
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('u3', 'High Roller')");
  await funding.init();
});
test.after(() => svc.stop());

// ── A: the registry ──
test("registry: classic is the default, the saloon is free (unlock reserved), every name and line is in en.json", () => {
  const T0 = themes.THEMES;
  assert.deepEqual(Object.keys(T0), ["classic", "saloon"]);
  assert.equal(T0.classic.default, true);
  assert.ok(!T0.saloon.default);
  assert.equal(themes.DEFAULT, "classic");
  for (const th of Object.values(T0)) {
    assert.equal(typeof th.id, "string");
    assert.equal(th.unlock, null, th.id + ": free for now (Question 1) - the unlock field is reserved");
    assert.ok(Array.isArray(th.games) && th.games.includes("holdem"), th.id + ": plays Hold'em");
    assert.equal(typeof EN[th.name], "string", th.id + ": its name is an en.json key");
    assert.ok(Array.isArray(th.sound));
    for (const [ev, keys] of Object.entries(th.lines)) for (const kk of keys) assert.equal(typeof EN[kk], "string", `${th.id} ${ev}: ${kk}`);
  }
  assert.deepEqual(T0.classic.lines, {}, "classic: no flavour");
  assert.deepEqual(T0.classic.sound, [], "classic: no sound");
  assert.ok(T0.saloon.lines.open.length >= 3 && T0.saloon.lines.open.length <= 4, "3-4 open variants");
  assert.ok(T0.saloon.lines.pot.length >= 3 && T0.saloon.lines.pot.length <= 4, "3-4 big-pot variants");
  for (const kk of T0.saloon.lines.pot) assert.match(EN[kk], /\{pot\} PAT/, kk + ": the amount is PAT");
  for (const kk of [...T0.saloon.lines.open, ...T0.saloon.lines.pot]) {
    assert.doesNotMatch(EN[kk], /\b(money|cash|currency|dollars?)\b/i, kk + ": PAT is points");
    assert.ok(EN[kk].length <= 140, kk + ": short");
  }
  assert.deepEqual(T0.saloon.sound.slice().sort(), ["bell", "card", "chip"]);
  // en.json: the new keys sit with the casino keys, never at the end of the file
  const keys = Object.keys(EN);
  const at = keys.indexOf(T0.saloon.lines.open[0]);
  assert.ok(at > keys.indexOf("casino.lobby_title") && at < keys.length - 50, "next to the casino keys");
});

test("parseThemeWord: a theme id in any case, nothing else", () => {
  for (const [w, id] of [["saloon", "saloon"], ["SALOON", "saloon"], [" Saloon ", "saloon"], ["classic", "classic"]]) assert.equal(themes.parseThemeWord(w), id, w);
  for (const w of ["vegas", "", null, undefined, "25/50", "hr", "💎", "__proto__", "constructor", "toString"]) assert.equal(themes.parseThemeWord(w), null, String(w));
});

test("the switch: off (default) / staff / everyone - who may pick, and themeOf is classic whenever it's off", () => {
  const T0 = { game: "holdem", theme: "saloon" };
  assert.equal(themes.mode({}), "off");
  assert.equal(themes.mode({ casino_themes: "maybe" }), "off", "a bad value = off");
  for (const v of [null, { admin: false }, { admin: true }]) assert.equal(themes.allowed(v, {}), false, "off: nobody picks");
  assert.equal(themes.allowed({ admin: true }, { casino_themes: "staff" }), true);
  assert.equal(themes.allowed({ admin: false }, { casino_themes: "staff" }), false);
  assert.equal(themes.allowed(null, { casino_themes: "staff" }), false);
  assert.equal(themes.allowed({ admin: false }, { casino_themes: "everyone" }), true);
  assert.equal(themes.allowed(null, { casino_themes: "everyone" }), false, "signed out: nobody opens a table");
  assert.equal(themes.themeOf(T0, {}), "classic");
  assert.equal(themes.themeOf(T0, { casino_themes: "off" }), "classic");
  assert.equal(themes.themeOf(T0, { casino_themes: "staff" }), "saloon", "staff: everyone SEES a staff-opened saloon table");
  assert.equal(themes.themeOf(T0, { casino_themes: "everyone" }), "saloon");
  assert.equal(themes.themeOf({ game: "holdem" }, { casino_themes: "everyone" }), "classic", "an old table without a theme = classic");
  assert.equal(themes.themeOf({ game: "holdem", theme: "vegas" }, { casino_themes: "everyone" }), "classic", "an unknown id = classic");
  assert.equal(themes.themeOf({ game: "holdem", theme: "__proto__" }, { casino_themes: "everyone" }), "classic");
  assert.equal(themes.themeOf(null, { casino_themes: "everyone" }), "classic");
});

test("settings: casino_themes is stored with the casino settings (default off) and only takes off / staff / everyone", async () => {
  await fresh();
  assert.equal((await svc.loadSettings(true)).casino_themes, "off");
  for (const v of ["staff", "everyone", "off"]) assert.equal((await svc.setSetting("casino_themes", v, "test")).casino_themes, v);
  await assert.rejects(svc.setSetting("casino_themes", "on", "test"), /off, staff or everyone/);
  await assert.rejects(svc.setSetting("casino_themes", "1", "test"), /off, staff or everyone/);
  const row = (await getQuery("SELECT value, actor FROM casino_settings WHERE key = 'casino_themes'"))[0];
  assert.deepEqual([row.value, row.actor], ["off", "test"], "audited like the others (who set it)");
  await runQuery("UPDATE casino_settings SET value = 'weird' WHERE key = 'casino_themes'");
  assert.equal((await svc.loadSettings(true)).casino_themes, "off", "a bad stored value reads off");
});

// ── B: a table carries its theme ──
test("!holdem start: the theme word in any position, with hr, the High Roller ladder; an unknown word is refused with the list", async () => {
  await fresh("everyone");
  const cases = [
    [ann, ["25/50", "saloon"], 25, 50, false], [ann, ["saloon", "10/20"], 10, 20, false], [ann, ["saloon"], 25, 50, false],
    [hil, ["hr", "saloon"], 100000, 200000, true], [hil, ["saloon", "hr"], 100000, 200000, true], [hil, ["250k/500k", "SALOON"], 250000, 500000, true],
  ];
  for (const [who, args, sb, bb, hr] of cases) {
    const r = await open(who, args);
    const T = svc.getTable(r.table);
    assert.deepEqual([T.theme, T.eng.sb, T.eng.bb, T.high_stakes], ["saloon", sb, bb, hr], args.join(" "));
    assert.equal(svc.publicView(T).theme, "saloon");
    assert.equal(svc.lobby().find((x) => x.id === T.id).theme, "saloon", "the lobby row says it");
    await A(who, "end", [], { table: T.id });
  }
  for (const args of [["25/50"], [], ["classic", "25/50"]]) {
    const r = await open(ann, args);
    assert.equal(svc.getTable(r.table).theme, "classic", "classic by default: " + args.join(" "));
    assert.equal(r.quiet, true, "no extra reply");
    await A(ann, "end", [], { table: r.table });
  }
  const before = svc.lobby().length;
  for (const args of [["25/50", "vegas"], ["vegas"], ["neon", "25/50"]]) {
    const r = await A(ann, "start", args, { room: null });
    assert.equal(r.ok, false, args.join(" "));
    assert.match(r.reply, /no table theme called "(vegas|neon)"/);
    assert.match(r.reply, /classic, saloon/, "the list of themes");
  }
  assert.equal(svc.lobby().length, before, "nothing opened");
  // the blinds' own errors are unchanged
  assert.match((await A(ann, "start", ["saloon", "50/25"], { room: null })).reply, /small < big/);
  assert.match((await A(ann, "start", ["99999/200000", "saloon"], { room: null })).reply, /High Roller tables play/);
  assert.match((await A(ann, "start", ["hr", "saloon"], { room: null })).reply, /High Roller tables are for High Rollers/);
  // the help mentions the theme word once
  assert.equal((svc.HM.HELP.match(/saloon/g) || []).length, 1);
});

test("the switch off: a theme word is ignored with a note (classic), other words as before; staff: only a casino admin picks", async () => {
  await fresh();
  let r = await open(ann, ["25/50", "saloon"]);
  assert.equal(r.reply, "themes aren't on yet - opening a classic table.");
  assert.notEqual(r.quiet, true, "Pepe tells the opener");
  assert.equal(svc.getTable(r.table).theme, "classic");
  await A(ann, "end", [], { table: r.table });
  r = await open(ann, ["saloon"]);
  assert.deepEqual([svc.getTable(r.table).eng.bb, svc.getTable(r.table).theme], [50, "classic"]);
  await A(ann, "end", [], { table: r.table });
  r = await open(ann, ["25/50", "vegas"]);
  assert.equal(r.quiet, true, "off: a stray word is ignored exactly as before themes");
  await A(ann, "end", [], { table: r.table });
  assert.match((await A(ann, "start", ["vegas"], { room: null })).reply, /^usage: !holdem start/, "off: the old usage answer");
  await svc.setSetting("casino_themes", "staff", "test");
  r = await open(ann, ["25/50", "saloon"]);
  assert.equal(r.reply, "table themes are staff-only for now - opening a classic table.");
  assert.equal(svc.getTable(r.table).theme, "classic");
  await A(ann, "end", [], { table: r.table });
  r = await open(boss, ["25/50", "saloon"]);
  assert.equal(svc.getTable(r.table).theme, "saloon", "a casino admin opens a saloon table");
  assert.equal(svc.publicView(svc.getTable(r.table)).theme, "saloon", "and everyone sees it as saloon");
  await A(boss, "end", [], { table: r.table });
});

test("a saloon table reads classic while the switch is off (view, lobby) and saloon again after; a restart keeps its theme", async () => {
  await fresh("everyone");
  const { table: tid } = await open(ann, ["25/50", "saloon"]);
  await svc.setSetting("casino_themes", "off", "test");
  assert.equal(svc.publicView(svc.getTable(tid)).theme, "classic");
  assert.equal(svc.lobby().find((x) => x.id === tid).theme, "classic");
  assert.equal(svc.getTable(tid).theme, "saloon", "the table keeps its own theme");
  await svc.setSetting("casino_themes", "staff", "test");
  assert.equal(svc.publicView(svc.getTable(tid)).theme, "saloon");
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(svc.getTable(tid).theme, "saloon", "restart-safe: the table JSON keeps it");
  assert.equal(svc.publicView(svc.getTable(tid)).theme, "saloon");
  // an old table saved before themes (no theme field) reads classic
  const T = svc.getTable(tid);
  delete T.theme;
  assert.equal(svc.publicView(T).theme, "classic");
});

// ── E: the dealer's flavour lines ──
test("flavour: one line when a saloon table opens (a rotating variant, the blinds filled in), none on classic or while off", async () => {
  await fresh("everyone");
  const r = await open(ann, ["25/50", "saloon"]);
  const evs = await events(r.table);
  const at = evs.findIndex((e) => e.kind === "opened");
  assert.ok(at >= 0);
  const lines = cowboy(evs);
  assert.equal(lines.length, 1, "exactly one flavour line");
  assert.equal(evs[at + 1].text, lines[0].text, "right after the opened line");
  assert.ok(variants("open", { sb: "25", bb: "50" }).includes(lines[0].text), lines[0].text);
  const c = await open(bob, ["25/50"]);
  assert.equal(cowboy(await events(c.table)).length, 0, "classic: none");
  await svc.setSetting("casino_themes", "off", "test");
  await A(ann, "end", [], { table: r.table });
  await A(bob, "end", [], { table: c.table });
  const o = await open(ann, ["25/50", "saloon"]);
  assert.equal(cowboy(await events(o.table)).length, 0, "off: none");
  // rotation: each table's counter walks the variants (seeded by the table, so tables don't all start alike)
  const fake = { id: "00000000aa", game: "holdem", theme: "saloon" };
  const seen = [];
  for (let i = 0; i < 5; i++) seen.push(themes.line(fake, { casino_themes: "everyone" }, "open", { sb: "1", bb: "2" }));
  const all = variants("open", { sb: "1", bb: "2" });
  assert.equal(new Set(seen.slice(0, all.length)).size, all.length, "every variant before one repeats");
  assert.equal(seen[all.length], seen[0], "then round again");
  assert.equal(themes.line({ id: "00000000aa", game: "holdem", theme: "classic" }, { casino_themes: "everyone" }, "open", {}), null);
  assert.equal(themes.line(fake, { casino_themes: "off" }, "open", {}), null);
  assert.equal(themes.line(fake, { casino_themes: "everyone" }, "nope", {}), null);
});

test("flavour: one line on a showdown pot of 50 big blinds or more - a split pot too - none on smaller or uncontested pots, none on classic", async () => {
  await fresh("everyone");
  const { table: tid } = await open(ann, ["25/50", "saloon"]);
  for (const p of [ann, bob]) assert.ok((await A(p, "sit", ["2000"], { table: tid })).ok);
  const perHand = async () => {
    const evs = await events(tid);
    const out = [];
    let cur = null;
    for (const e of evs) {
      if (e.kind === "hand") { cur = []; out.push(cur); } else if (cur && e.kind === "line" && /^🤠/.test(e.text || "")) cur.push(e.text);
    }
    return out;
  };
  // hand 1 + 2: all-in 2,000 each = 4,000 (80 BB), a split (two awards) - one line each, two different variants
  for (let i = 0; i < 2; i++) {
    deck(CHOP);
    assert.ok((await A(ann, "deal", [], { table: tid })).ok);
    await allIn(tid);
    assert.equal(svc.getTable(tid).last_round.winners.length, 2, "a split pot");
  }
  let hands = await perHand();
  assert.deepEqual(hands.map((h) => h.length), [1, 1], "one line per big pot, never one per award");
  assert.notEqual(hands[0][0], hands[1][0], "the variants rotate");
  const pots = variants("pot", { name: "NAME", pot: "POT" }).map((v) => new RegExp("^" + v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("NAME", "(Ann|Bob)").replace("POT", "[0-9,]+") + "$"));
  for (const h of hands) assert.ok(pots.some((re) => re.test(h[0])), h[0] + " (a half after the 2% rake, in PAT)");
  assert.match(hands[0][0], / 1,960 PAT /, "hand 1: 4,000 less the 80 rake, split");
  // hand 3: checked down (100 = 2 BB): none; hand 4: uncontested: none
  deck(ACES);
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  await checkDown(tid);
  deck(ACES);
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  const T = svc.getTable(tid);
  const k2 = H.currentActor(T.eng);
  assert.ok((await A(k2 === "u1" ? ann : bob, "fold", [], { table: tid })).ok);
  hands = await perHand();
  assert.deepEqual(hands.map((h) => h.length), [1, 1, 0, 0]);
  // classic: an 80 BB showdown says nothing extra
  const c = await open(hil, ["25/50"]);
  for (const p of [hil, boss]) assert.ok((await A(p, "sit", ["2000"], { table: c.table })).ok);
  deck(CHOP);
  assert.ok((await A(hil, "deal", [], { table: c.table })).ok);
  const TC = svc.getTable(c.table);
  let first = true;
  while (TC.eng.hand_active) { const kk = H.currentActor(TC.eng); assert.ok((await A(kk === "u3" ? hil : boss, first ? "allin" : "call", [], { table: c.table })).ok); first = false; }
  assert.equal(cowboy(await events(c.table)).length, 0);
});

test("flavour (review 13): the 50 BB limit is pinned - 49 BB at a showdown says nothing, exactly 50 BB (rake included) one line, a big pot won uncontested none", async () => {
  await fresh("everyone");
  const { table: tid } = await open(ann, ["25/50", "saloon"]);                 // bb = 50: 50 big blinds = 2,500 chips
  for (const p of [ann, bob]) assert.ok((await A(p, "sit", ["10000"], { table: tid })).ok);
  const T = svc.getTable(tid);
  const turn = async (verb, args) => { const kk = H.currentActor(T.eng); const r = await A(kk === "u1" ? ann : bob, verb, args || [], { table: tid }); assert.ok(r.ok, verb + ": " + r.reply); };
  const potLines = async () => cowboy(await events(tid)).filter((e) => / PAT pot/.test(e.text)).map((e) => e.text);
  const hand = async (to, finish) => {
    deck(ACES);
    assert.ok((await A(ann, "deal", [], { table: tid })).ok);
    await turn("raise", [String(to)]);                                         // heads-up: the button opens, the big blind calls
    await turn("call");
    await finish();
  };
  // 49 big blinds (1,225 each = 2,450) to a showdown: none
  await hand(1225, () => checkDown(tid));
  assert.equal(T.last_round.uncontested, false);
  assert.equal(T.last_round.pot, 2450);
  assert.deepEqual(await potLines(), [], "49 BB: no line");
  // exactly 50 big blinds (1,250 each = 2,500: 2,450 to the winner + the 50 rake) to a showdown: one line
  await hand(1250, () => checkDown(tid));
  assert.equal(T.last_round.pot, 2500);
  assert.equal(T.last_round.rake, 50, "the 2% rake counts toward the pot");
  let lines = await potLines();
  assert.equal(lines.length, 1, "50 BB: the line");
  assert.match(lines[0], / 2,450 PAT pot/, "the winner's take, in PAT");
  // 80 big blinds won without a showdown (the flop bet is folded to): none
  await hand(2000, async () => { await turn("bet", ["500"]); await turn("fold"); });
  assert.equal(T.last_round.uncontested, true);
  assert.ok(T.last_round.pot >= 4000, "a pot of " + T.last_round.pot);
  lines = await potLines();
  assert.equal(lines.length, 1, "uncontested: no line, however big");
});

// ── C + D: the lobby flag, POST /api/casino/open, the pages ──
test("HTTP: the lobby's picker flag per viewer, POST /api/casino/open {theme}, the pages load the theme only for a themed table", async () => {
  await fresh();
  const express = require("express");
  const routes = require(path.join(repo, "casino", "routes"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const users = { u1: { userId: "u1" }, u2: { userId: "u2" }, a1: { userId: "a1" } };
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); });
  routes.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const hd = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, uid ? { "x-test-user": uid } : {});
  const get = async (url, uid) => (await fetch(base + url, { headers: hd(uid) })).json();
  const page = async (url, uid) => (await fetch(base + url, { headers: hd(uid) })).text();
  const post = async (body, uid) => (await fetch(base + "/api/casino/open", { method: "POST", headers: hd(uid), body: JSON.stringify(body) })).json();
  try {
    const flag = async (uid) => ((await get("/api/casino/lobby", uid)).themes || {}).pick;
    for (const u of [null, "u1", "a1"]) assert.equal(await flag(u), false, "off: nobody - " + u);
    await svc.setSetting("casino_themes", "staff", "test");
    assert.deepEqual([await flag(null), await flag("u1"), await flag("a1")], [false, false, true], "staff: the casino admin only");
    await svc.setSetting("casino_themes", "everyone", "test");
    assert.deepEqual([await flag(null), await flag("u1"), await flag("a1")], [false, true, true], "everyone: every signed-in viewer");
    const lob = await get("/api/casino/lobby", "u1");
    assert.deepEqual(lob.themes.list.map((t) => t.id), ["classic", "saloon"]);
    assert.ok(lob.themes.list.every((t) => Array.isArray(t.games)));
    // open from the web with a theme; the lobby row and the table view say it
    const o = await post({ game: "holdem", blinds: "10/20", theme: "saloon", idem: "th-open-hm-0001" }, "u1");
    assert.ok(o.ok, JSON.stringify(o));
    assert.equal(svc.getTable(o.table).theme, "saloon");
    assert.equal((await get(`/api/casino/t/${o.table}`, "u2")).table.theme, "saloon");
    assert.equal((await get("/api/casino/lobby", "u2")).tables.find((t) => t.id === o.table).theme, "saloon");
    const c = await post({ game: "holdem", blinds: "10/20", idem: "th-open-hm-0002" }, "u2");
    assert.ok(c.ok, JSON.stringify(c));
    assert.equal(svc.getTable(c.table).theme, "classic");
    // the saloon page: the theme's CSS, its art (a template) and the sound cues; the classic page: none of it
    const THEMED = ["/public/css/casino-themes.css?v=", 'id="cz-theme-saloon"', "/public/js/casino-sound.js?v="];
    let html = await page(`/casino/holdem/t/${o.table}`, "u2");
    for (const s of THEMED) assert.ok(html.includes(s), "saloon page: " + s);
    html = await page(`/casino/holdem/t/${c.table}`, "u2");
    for (const s of THEMED) assert.ok(!html.includes(s), "classic page: no " + s);
    await svc.setSetting("casino_themes", "off", "test");
    html = await page(`/casino/holdem/t/${o.table}`, "u2");
    for (const s of THEMED) assert.ok(!html.includes(s), "switch off: the saloon table's page is classic - no " + s);
    // the lobby page carries the picker (filled by casino-ui.js when the flag says so)
    html = await page("/casino/holdem", "u1");
    assert.ok(html.includes('id="cz-themepick"') && html.includes('id="cz-themes"'));
  } finally { server.close(); }
});

// ── D: the files ──
test("files: the saloon CSS is scoped under .cz-theme-saloon, original art only (no external URL, nothing over 30 KB), reduced motion", () => {
  const css = rd("public", "css", "casino-themes.css");
  const part = rd("views", "partials", "casino-theme-saloon.ejs");
  const snd = rd("public", "js", "casino-sound.js");
  for (const [n, s] of [["css", css], ["partial", part], ["sound", snd]]) assert.ok(Buffer.byteLength(s) < 30 * 1024, n + " under 30 KB");
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(body, /@import/);
  for (const m of body.matchAll(/url\(\s*(["']?)([^"')]*)/g)) assert.match(m[2], /^data:image\/svg\+xml,/, "only inline SVG data: " + m[2].slice(0, 40));
  // no fetch from anywhere: the only http in the file is the SVG namespace inside its data: URIs
  assert.deepEqual([...new Set(body.match(/https?:\/\/[^\s'"%)]+/g) || [])], ["http://www.w3.org/2000/svg"]);
  // every rule is under the saloon scope (classic is untouched); @media / @supports inside, @keyframes named czs*
  const selectors = [];
  (function walk(src) {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (depth && j < src.length) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      const inner = src.slice(open + 1, j - 1);
      if (/^@(media|supports)/.test(head)) walk(inner);
      else if (/^@keyframes/.test(head)) assert.match(head, /^@keyframes czs/, head);
      else selectors.push(...head.split(",").map((s) => s.trim()));
      i = j;
    }
  })(body);
  assert.ok(selectors.length > 30);
  for (const s of selectors) assert.match(s, /^\.cz-theme-saloon(?:$|[\s.:#[>])/, "scoped: " + s);
  assert.match(body, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(body, /@media\s*\(max-width:\s*760px\)/, "the phone layout (a wood-panel background)");
  // the 💎 High Roller marks stay: the theme never restyles the 💎 chips
  assert.doesNotMatch(body.replace(/:not\(\.hrc\)/g, ""), /\.hrc\b/, "no rule restyles a 💎 chip");
  // the art: a template, inline SVG, no external href / src, the sign's words from en.json
  assert.match(part, /<template id="cz-theme-saloon">/);
  assert.match(part, /<svg[^>]*class="cz-scene-art"/);
  assert.match(part, /class="cz-sign"/);
  assert.match(part, /t\('casino\.theme_saloon_sign'\)/);
  assert.equal(EN["casino.theme_saloon_sign"], "Pepe's Saloon");
  assert.doesNotMatch(part.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, ""), /https?:|<image|href=|src=/i);
  assert.match(part, /aria-hidden="true"/, "decoration only");
});

// ── the h20 verify review's fixes ──
/** the CSS's rules: [{sel, decl: {prop: value}, media}] (one level of @media), comments dropped */
function cssRules(src) {
  const out = [];
  (function walk(s, media) {
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf("{", i);
      if (open < 0) break;
      const head = s.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (depth && j < s.length) { if (s[j] === "{") depth++; else if (s[j] === "}") depth--; j++; }
      const inner = s.slice(open + 1, j - 1);
      if (/^@media/.test(head)) walk(inner, head);
      else if (!/^@/.test(head)) {
        const decl = {};
        for (const d of inner.split(/;(?![^(]*\))/)) { const k = d.indexOf(":"); if (k > 0) decl[d.slice(0, k).trim()] = d.slice(k + 1).trim(); }
        for (const sel of head.split(",")) out.push({ sel: sel.trim(), decl, media: media || null });
      }
      i = j;
    }
  })(src.replace(/\/\*[\s\S]*?\*\//g, ""), null);
  return out;
}
const themeCss = () => cssRules(rd("public", "css", "casino-themes.css"));
const px = (v) => String(v || "0").trim().split(/\s+/).map((x) => parseFloat(x) || 0);
const sides = (v) => { const p = px(v); return [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]]; };   // top right bottom left

test("review 1-3: the saloon adds no height and moves nothing - classic's wrap padding, the signs out of the flow, the logo's space kept, blackjack's rail inside classic's box", () => {
  const R = themeCss();
  // Hold'em: the wrap keeps classic's padding at every width (the phone sign took 44 more px and pushed the felt under the dock)
  for (const r of R.filter((x) => /\.hm-wrap\b/.test(x.sel) && !/\.hm-wrap\s/.test(x.sel))) {
    assert.ok(!Object.keys(r.decl).some((k) => /^padding/.test(k)), `${r.media || ""} ${r.sel}: no padding (classic's stays)`);
  }
  // the felt's lettering keeps its place in the board's column (the board, pot and message stay where classic has them)
  const logo = R.filter((x) => x.sel === ".cz-theme-saloon .hm-logo");
  assert.ok(logo.length && logo.every((x) => x.decl.visibility === "hidden" && !("display" in x.decl)), "hm-logo: hidden, not removed");
  // the sign is out of the flow everywhere (Hold'em: on the felt between the top seats; blackjack: over its top rail)
  const sign = R.filter((x) => /\.cz-sign$/.test(x.sel));
  assert.ok(sign.find((x) => x.sel === ".cz-theme-saloon .cz-sign" && !x.media && x.decl.position === "absolute"), "the sign: position absolute");
  for (const x of sign) assert.ok(!x.decl.position || x.decl.position === "absolute", `${x.media || ""} ${x.sel}: stays absolute`);
  assert.ok(!sign.some((x) => "flex" in x.decl), "not a flex item any more");
  // phones (and, found while fixing, the narrow landscape felt to 960px - its board reaches the felt's top): the wall sign hangs in
  // the table's top row (beside "All tables") - absolute, above the wrap; the scene lets it out
  const phone = R.filter((x) => x.media && /max-width:\s*(760|960)px/.test(x.media));
  const wall = phone.find((x) => /\.cz-wallsign$/.test(x.sel) && x.decl.display === "block");
  assert.ok(wall && wall.decl.position === "absolute" && /^-\d/.test(wall.decl.top || ""), "the wall sign: absolute, above the wrap (top < 0): " + JSON.stringify(wall && wall.decl));
  assert.ok(/max-width:\s*960px/.test(wall.media), "to 960px: " + wall.media);
  assert.ok(/inset-inline-end/.test(Object.keys(wall.decl).join()), "at the row's end (logical side: RTL too), clear of the link");
  assert.ok(phone.some((x) => /\.cz-scene$/.test(x.sel) && x.decl.overflow === "visible"), "the scene doesn't clip it");
  assert.ok(phone.some((x) => /\.cz-sign$/.test(x.sel) && x.decl.display === "none" && x.media === wall.media), "and the felt's sign gives way there");
  // blackjack: the wood rail is a border, so the padding gives it back - border + padding = classic's padding on every side
  const view = rd("views", "casino-bj.ejs");
  const cls = (re) => sides((re.exec(view) || [])[1]);
  const classicDesk = cls(/\.felt\.bj \{ padding: ([^;]+);/);
  const classicPhone = cls(/@media \(max-width: 600px\) \{\s*\.felt\.bj \{[^}]*padding: ([^;]+);/);
  assert.deepEqual(classicDesk, [18, 16, 64, 16]);
  assert.deepEqual(classicPhone, [14, 10, 16, 10]);
  const bj = (media) => R.filter((x) => x.sel === ".cz-theme-saloon .felt.bj" && (media ? x.media && media.test(x.media) : !x.media));
  const box = (rules) => {
    let border = [0, 0, 0, 0], pad = null;
    for (const r of rules) {
      if (r.decl.border) border = sides(r.decl.border.match(/(\d+(?:\.\d+)?)px/)[1] + "px");
      if (r.decl["border-width"]) border = sides(r.decl["border-width"]);
      if (r.decl.padding) pad = sides(r.decl.padding);
    }
    return { border, pad };
  };
  const desk = box(bj(null));
  assert.ok(desk.pad, "the desktop rule sets the padding");
  assert.deepEqual(desk.border.map((b, i) => b + desk.pad[i]), classicDesk, "desktop: border + padding = classic");
  const ph = box(bj(null).concat(bj(/max-width:\s*600px/)));
  assert.deepEqual(ph.border.map((b, i) => b + ph.pad[i]), classicPhone, "phones: border + padding = classic");
});

test("review 6/7/12: a 💎 saloon table's rail turns gold; the rack's chips keep different colours; no chip rule can reach a 💎 chip", () => {
  const R = themeCss();
  const body = rd("public", "css", "casino-themes.css").replace(/\/\*[\s\S]*?\*\//g, "");
  // the rail's wood is one custom property (every rail layer reads it), and 💎 tables gild it
  const root = R.find((x) => x.sel === ".cz-theme-saloon" && x.decl["--sl-wood"]);
  assert.ok(root, "--sl-wood on the theme");
  assert.equal((body.match(/#4b2a14/g) || []).length, 1, "the wood gradient is written once (--sl-wood), every rail uses var(--sl-wood)");
  for (const r of R.filter((x) => /\.felt\.(hm|bj)$/.test(x.sel) && x.decl.background)) assert.match(r.decl.background, /var\(--sl-wood\)/, `${r.media || ""} ${r.sel}`);
  const hr = R.find((x) => /^\.cz-theme-saloon \.felt\.hr$/.test(x.sel) && x.decl["--sl-wood"]);
  assert.ok(hr, "💎: --sl-wood overridden on .felt.hr (Hold'em and blackjack)");
  assert.notEqual(hr.decl["--sl-wood"], root.decl["--sl-wood"]);
  assert.match(hr.decl["--sl-wood"], /#e8c45a/i, "gold in the 💎 rail (classic High Roller's --rail2)");
  // an empty seat's "Open seat" (cream #efe3c4, no plate) can sit on the rail at the oval's ends - on the gilded rail it needs its
  // own dark plate to stay AA (found while verifying the gold rail)
  const open = R.find((x) => x.sel === ".cz-theme-saloon .felt.hr .seat.empty .plate" && x.decl.background);
  assert.ok(open, "💎: the open seat's label gets a plate");
  const a = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(open.decl.background);
  assert.ok(a && Number(a[1]) + Number(a[2]) + Number(a[3]) < 90 && Number(a[4]) >= 0.75, "a dark plate: " + open.decl.background);
  // the bet rack: every clay chip its own colour (25K and Max were both black-and-gold)
  const faces = {};
  for (const r of R.filter((x) => /\.chip(\.\w+)?:not\(\.hrc\)$/.test(x.sel) && x.decl["--c"])) {
    const m = /\.chip(?:\.(\w+))?:not/.exec(r.sel);
    faces[m[1] || "base"] = r.decl["--c"].toLowerCase();
  }
  for (const k of ["base", "c500", "c1k", "c5k", "c25k", "cmax"]) assert.ok(faces[k], "a face for " + k + ": " + JSON.stringify(faces));
  assert.equal(new Set(Object.values(faces)).size, Object.keys(faces).length, "all different: " + JSON.stringify(faces));
  // review 12: a chip selector without :not(.hrc) would restyle the 💎 c100k / c500k / c1m / c5m chips - every one carries it
  const chipSels = R.map((x) => x.sel).filter((s) => /\.chip\b/.test(s));
  assert.ok(chipSels.length >= 6);
  for (const s of chipSels) assert.match(s, /\.chip(\.[\w-]+)*:not\(\.hrc\)/, "guarded: " + s);
});

test("review 4: the sign's lettering fits between its studs in every language (fitted when a translation is longer than the English)", () => {
  const ejs = require("ejs");
  const file = path.join(repo, "views", "partials", "casino-theme-saloon.ejs");
  const render = (sign) => ejs.render(fs.readFileSync(file, "utf8"), { i18nT: (kk) => (kk === "casino.theme_saloon_sign" ? sign : EN[kk] || kk) }, { filename: file });
  const texts = (html) => [...html.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ attrs: m[1], text: m[2],
    len: (/\btextLength="([\d.]+)"/.exec(m[1]) || [])[1], adj: (/\blengthAdjust="([^"]+)"/.exec(m[1]) || [])[1],
    fs: Number((/\bfont-size="([\d.]+)"/.exec(m[1]) || [])[1]), x: Number((/\bx="([\d.]+)"/.exec(m[1]) || [])[1]) }));
  // English (209 units between studs at 15 / 245): drawn as it is
  let t = texts(render(EN["casino.theme_saloon_sign"]));
  assert.equal(t.length, 2, "the desktop sign + the phones' wall sign");
  for (const x of t) { assert.equal(x.len, undefined, "English: no squeeze"); assert.equal(x.fs, 27); assert.equal(x.text, "Pepe's Saloon"); }
  // the reviewer's measured overflows (Georgia bold 27 + 1.5 spacing: 253-272 units) and a much longer one: fitted
  for (const s of ["Le saloon de Pepe", "El saloon de Pepe", "O Saloon do Pepe", "Il saloon di Pepe", "Das Saloon von Pepe am Ende der Straße"]) {
    t = texts(render(s));
    for (const x of t) {
      assert.equal(x.text, s);
      assert.ok(x.len && Number(x.len) <= 220 && Number(x.len) >= 200, s + ": textLength between the studs: " + x.len);
      assert.equal(x.adj, "spacingAndGlyphs", s);
      assert.equal(x.x, 130, "still centred");
      assert.ok(x.fs >= 16 && x.fs <= 27, s + ": font " + x.fs);
    }
  }
  assert.ok(texts(render("Das Saloon von Pepe am Ende der Straße"))[0].fs < 27, "a much longer one is also set smaller (not only squeezed)");
  // markup-safe: an entity in the string is measured as its character and kept as written
  t = texts(render("Pepe&#39;s Saloon"));
  assert.equal(t[0].text, "Pepe&#39;s Saloon");
  assert.equal(t[0].len, undefined, "&#39; counts as one apostrophe");
});

test("wiring: casinohm.js sets the theme in render through CZ.theme; the Hold'em page loads the theme files only for a theme; ?v= bumps", () => {
  const ui = rd("public", "js", "casino-ui.js"), hm = rd("public", "js", "casinohm.js"), view = rd("views", "casino-hm.ejs");
  assert.match(ui, /function theme\(t, at\)/);
  assert.match(ui, /window\.CZ = \{[^}]*\btheme\b/);
  assert.equal((hm.match(/CZ\.theme\(/g) || []).length, 1, "one call in render");
  assert.match(view, /<% if \(locals\.theme && theme !== 'classic'\) \{ %>/);
  assert.match(view, /casino-ui\.js\?v=12/);      // (rebased on h22 Sit & Go's casino-ui v10 / casinohm v11; h22 phase 2: v12, one above both sides' v11)
  assert.match(view, /casinohm\.js\?v=14/, "v13: the sign anchored on the felt (h20 verify review 3; v12 before the rebase on h22's v11); h22 phase 2: v14, one above themes' v13 / phase 2's v12");
  for (const v of ["casino-hm.ejs", "casino-bj.ejs"]) {
    assert.match(rd("views", v), /casino-themes\.css\?v=3/, v + ": the review's layout fixes");
    assert.match(rd("views", v), /casino-sound\.js\?v=2/, v + ": the toggle in the table's top row");
  }
  assert.match(rd("casino", "routes.js"), /theme: T \? themes\.themeOf\(T, st\) : "classic"/);
  // the admin view: one row, saved like the other Hold'em controls (no admin-panel.js change)
  const adm = rd("views", "admin", "games.ejs");
  assert.match(adm, /<select name="casino_themes">/);
  assert.match(adm, /querySelectorAll\('input\[name\], select\[name\]'\)/);
  for (const v of ["off", "staff", "everyone"]) assert.equal(typeof EN["casino.theme_switch_" + v], "string");
  // the lobby picker + the table's tag
  assert.match(rd("views", "partials", "casino-lobby.ejs"), /id="cz-themepick"/);
  assert.match(ui, /body\.theme = /);
});

test("strings: every js.casino.* default in casino-sound.js equals en.json", () => {
  const src = rd("public", "js", "casino-sound.js");
  let n = 0;
  for (const m of src.matchAll(/\bT\("([a-z0-9_]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    assert.equal(EN["js.casino." + m[1]], JSON.parse('"' + m[2] + '"'), m[1]);
    n++;
  }
  assert.ok(n >= 2);
  assert.doesNotMatch(src, /\bT\((?!")/, "literal keys");
});

// ── F: the opt-in sound cues ──
function soundRig(opts) {
  opts = opts || {};
  const made = [], listeners = {}, store = Object.assign({}, opts.seed || {});
  const el = (tag) => {
    const kids = [];
    const o = { tagName: tag, children: kids, attrs: {}, hidden: false, _text: "", className: "", dataset: {}, _l: {}, parentNode: null,
      get textContent() { return this._text + kids.map((c) => c.textContent).join(""); }, set textContent(v) { this._text = String(v); kids.length = 0; },
      get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; },
      setAttribute(a, v) { this.attrs[a] = String(v); }, getAttribute(a) { return this.attrs[a]; },
      appendChild(c) { kids.push(c); c.parentNode = this; return c; },
      insertBefore(c, ref) { const i = ref ? kids.indexOf(ref) : -1; if (i < 0) kids.push(c); else kids.splice(i, 0, c); c.parentNode = this; return c; },
      addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); }, click() { for (const fn of this._l.click || []) fn({}); },
      querySelector(sel) { return sel === ".back" ? kids.find((c) => c.className === "back") || null : null; } };
    return o;
  };
  // the page: the header bar (.cz-bar) and the table section (#cz-table: the "All tables" link, then the wrap)
  const bar = el("div"), table = el("section"), back = el("a"), wrapEl = el("div");
  back.className = "back";
  table.appendChild(back);
  table.appendChild(wrapEl);
  const document = { createElement: el,
    querySelector: (s) => (s === ".cz-bar" ? bar : /^#cz-table\s*>?\s*\.back$/.test(s) ? back : s === "#cz-table" ? table : null),
    getElementById: (id) => (id === "cz-table" ? table : null),
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); } };
  const localStorage = opts.storageThrows ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
                                         : { getItem: (kk) => (kk in store ? store[kk] : null), setItem: (kk, v) => { store[kk] = String(v); } };
  class FakeCtx {
    constructor() { if (opts.ctxThrows) throw new Error("NotAllowedError"); made.push(this); this.currentTime = 0; this.sampleRate = 8000; this.destination = {}; this.nodes = 0; this.state = "running"; }
    resume() { return Promise.resolve(); }
    _node() { this.nodes++; const n = { connect: (x) => x, start() {}, stop() {}, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 }, Q: { value: 0 },
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {}, value: 0 }, type: "" }; return n; }
    createOscillator() { return this._node(); } createGain() { return this._node(); } createBiquadFilter() { return this._node(); }
    createBufferSource() { return this._node(); } createBuffer(c, len) { return { getChannelData: () => new Float32Array(len) }; }
  }
  const window = { localStorage, AudioContext: opts.noAudio ? undefined : FakeCtx };
  Object.defineProperty(window, "localStorage", { get() { if (opts.storageGetterThrows) throw new Error("SecurityError"); return localStorage; } });
  const CZ = { T: (kk, d) => d, $: () => null };
  window.CZ = CZ;
  const ctx = { window, document, console, Math, Date, Float32Array, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(rd("public", "js", "casino-sound.js"), ctx);
  const gesture = () => { for (const fn of (listeners.pointerdown || []).concat(listeners.keydown || [])) fn({}); };
  // the toggle, wherever it went (review 1/3: the table's top row, right after "All tables" - never the page header)
  const toggle = () => table.children.find((c) => c.id === "cz-soundbtn") || bar.children.find((c) => c.id === "cz-soundbtn") || null;
  return { window, bar, table, back, made, store, gesture, toggle, S: window.CZSound };
}
const view = (pot, board, done) => ({ game: "holdem", hand_no: 3, phase: "flop", pot, board, last_round: done ? { hand_no: done } : null });

test("sound: off by default, a 🔇/🔊 toggle on a themed table only, remembered in cz-sound; nothing before a click; first state never plays", () => {
  const r = soundRig();
  assert.ok(r.S && typeof r.S.update === "function");
  r.S.update("classic", view(100, []));
  assert.equal(r.toggle(), null, "classic: no toggle");
  r.S.update("saloon", view(100, []));
  const btn = r.toggle();
  assert.ok(btn, "a themed table: the toggle");
  assert.equal(r.bar.children.length, 0, "review 1/3: not in the page header (an extra pill wrapped it onto another row)");
  assert.equal(r.back.nextSibling, btn, "the table's own top row, right after 'All tables'");
  assert.equal(btn.attrs["aria-pressed"], "false", "off by default");
  assert.equal(btn.hidden, false);
  r.S.update("saloon", view(300, ["As", "Kd", "2c"]));
  assert.equal(r.made.length, 0, "off: no AudioContext at all");
  btn.click();                                           // the click is the gesture
  assert.equal(btn.attrs["aria-pressed"], "true");
  assert.equal(r.store["cz-sound"], "1");
  assert.equal(r.made.length, 1, "the click (a gesture) opens the audio - WebKit wants it inside the click");
  assert.equal(r.made[0].nodes, 0, "turning it on makes no sound by itself");
  r.S.update("saloon", view(300, ["As", "Kd", "2c", "9h"]));
  assert.equal(r.made.length, 1, "one AudioContext");
  const n0 = r.made[0].nodes;
  assert.ok(n0 > 0, "a card is dealt: a cue");
  r.S.update("saloon", view(300, ["As", "Kd", "2c", "9h"]));
  assert.equal(r.made[0].nodes, n0, "the same state again (a poll): no cue");
  r.S.update("saloon", view(600, ["As", "Kd", "2c", "9h"]));
  assert.ok(r.made[0].nodes > n0, "a bet: the chip cue");
  btn.click();
  assert.equal(r.store["cz-sound"], "0");
  const n1 = r.made[0].nodes;
  r.S.update("saloon", view(600, ["As", "Kd", "2c", "9h", "3s"], 3));
  assert.equal(r.made[0].nodes, n1, "off again: silent");
  r.S.update("classic", view(600, []));
  assert.equal(btn.hidden, true, "back to classic (the switch went off): the toggle hides");
});

test("sound: remembered on - still nothing until the viewer clicks the page; storage and WebAudio failures are safe", () => {
  const stored = soundRig({ seed: { "cz-sound": "1" } });
  stored.S.update("saloon", view(100, []));
  const btn = stored.toggle();
  assert.equal(btn.attrs["aria-pressed"], "true", "remembered on");
  stored.S.update("saloon", view(100, ["As", "Kd", "2c"]));
  assert.equal(stored.made.length, 0, "no click on the page yet: silent (no AudioContext)");
  stored.gesture();
  stored.S.update("saloon", view(100, ["As", "Kd", "2c", "9h"]));
  assert.equal(stored.made.length, 1, "after a click: the audio opens");
  assert.ok(stored.made[0].nodes > 0, "and the cue plays");
  // storage blocked (a private window): off, and the toggle still works for this page
  for (const o of [{ storageThrows: true }, { storageGetterThrows: true }]) {
    const b = soundRig(o);
    assert.doesNotThrow(() => b.S.update("saloon", view(100, [])));
    const t = b.toggle();
    assert.equal(t.attrs["aria-pressed"], "false");
    assert.doesNotThrow(() => t.click());
    assert.equal(t.attrs["aria-pressed"], "true");
    assert.doesNotThrow(() => b.S.update("saloon", view(100, ["As", "Kd", "2c"])));
  }
  // no WebAudio at all: nothing breaks, nothing plays
  const n = soundRig({ noAudio: true });
  n.S.update("saloon", view(100, []));
  assert.doesNotThrow(() => { n.toggle().click(); n.S.update("saloon", view(100, ["As", "Kd", "2c"])); });
  assert.equal(n.made.length, 0);
  // an AudioContext that throws on construction: silent, no error
  const bad = soundRig({ ctxThrows: true });
  bad.S.update("saloon", view(100, []));
  assert.doesNotThrow(() => { bad.toggle().click(); bad.S.update("saloon", view(100, ["As", "Kd", "2c"])); });
});

// ── H (phase 2): the saloon on blackjack ──
const BJ = (who, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], Object.assign({ game: "bj" }, opts || {}), key()); };
test("blackjack: !bj start with the theme word (hr, any order), the view and lobby say it, one open line, an unknown word refused", async () => {
  assert.ok(themes.THEMES.saloon.games.includes("bj"), "the saloon is drawn for blackjack");
  assert.ok(themes.THEMES.saloon.lines.bj_open.length >= 3 && themes.THEMES.saloon.lines.bj_open.length <= 4);
  for (const kk of themes.THEMES.saloon.lines.bj_open) assert.match(EN[kk], /\{min\}.*\{max\} PAT/, kk);
  await fresh("everyone");
  for (const [who, args, hr] of [[ann, ["saloon"], false], [hil, ["hr", "saloon"], true], [hil, ["SALOON", "hr"], true]]) {
    const r = await BJ(who, "start", args, { room: null });
    assert.ok(r.ok, JSON.stringify(r));
    const T = svc.getTable(r.table);
    assert.deepEqual([T.theme, !!T.high_stakes], ["saloon", hr], args.join(" "));
    assert.equal(svc.publicView(T).theme, "saloon");
    assert.equal(svc.lobby().find((x) => x.id === T.id).theme, "saloon");
    const evs = await events(r.table);
    const lines = cowboy(evs);
    assert.equal(lines.length, 1, "one flavour line");
    assert.equal(evs[evs.findIndex((e) => e.kind === "opened") + 1].text, lines[0].text, "right after the opened line");
    assert.ok(variants("bj_open", { min: fmt(T.eng.min_bet), max: fmt(T.eng.max_bet) }).includes(lines[0].text), lines[0].text);
    await BJ(who, "end", [], { table: r.table });
  }
  const c = await BJ(ann, "start", [], { room: null });
  assert.equal(svc.getTable(c.table).theme, "classic");
  assert.equal(svc.publicView(svc.getTable(c.table)).theme, "classic");
  assert.equal(cowboy(await events(c.table)).length, 0, "classic: no flavour");
  await BJ(ann, "end", [], { table: c.table });
  const bad = await BJ(ann, "start", ["vegas"], { room: null });
  assert.equal(bad.ok, false);
  assert.match(bad.reply, /no table theme called "vegas" - themes: classic, saloon\./);
  assert.match((await BJ(ann, "start", ["hr", "saloon"], { room: null })).reply, /High Roller tables are for High Rollers/);
  assert.match((await BJ(ann, "start", ["500"], { room: null })).reply, /^usage: !blackjack start/, "the old usage answer");
  // the switch off: the word is dropped with the note, the table classic; a saloon table reads classic until it's back on
  const s = await BJ(ann, "start", ["saloon"], { room: null });
  await svc.setSetting("casino_themes", "off", "test");
  assert.equal(svc.publicView(svc.getTable(s.table)).theme, "classic");
  await BJ(ann, "end", [], { table: s.table });
  const o = await BJ(ann, "start", ["saloon"], { room: null });
  assert.equal(o.reply, "themes aren't on yet - opening a classic table.");
  assert.equal(svc.getTable(o.table).theme, "classic");
  // restart-safe
  await svc.setSetting("casino_themes", "everyone", "test");
  await BJ(ann, "end", [], { table: o.table });
  const k2 = await BJ(bob, "start", ["saloon"], { room: null });
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(svc.publicView(svc.getTable(k2.table)).theme, "saloon");
});
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");

test("blackjack page: the theme files only for a themed table; casinobj.js dresses it through CZ.theme; the saloon CSS covers .felt.bj", async () => {
  await fresh("everyone");
  const express = require("express");
  const routes = require(path.join(repo, "casino", "routes"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); });
  routes.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const hd = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, uid ? { "x-test-user": uid } : {});
  try {
    const o = await (await fetch(base + "/api/casino/open", { method: "POST", headers: hd("u1"), body: JSON.stringify({ game: "bj", theme: "saloon", idem: "th-open-bj-0001" }) })).json();
    assert.ok(o.ok, JSON.stringify(o));
    assert.equal(svc.getTable(o.table).theme, "saloon", "the web opens a saloon blackjack table");
    const c = await (await fetch(base + "/api/casino/open", { method: "POST", headers: hd("u2"), body: JSON.stringify({ game: "bj", idem: "th-open-bj-0002" }) })).json();
    const THEMED = ["/public/css/casino-themes.css?v=", 'id="cz-theme-saloon"', "/public/js/casino-sound.js?v="];
    let html = await (await fetch(base + `/casino/blackjack/t/${o.table}`, { headers: hd("u2") })).text();
    for (const s of THEMED) assert.ok(html.includes(s), "saloon page: " + s);
    html = await (await fetch(base + `/casino/blackjack/t/${c.table}`, { headers: hd("u2") })).text();
    for (const s of THEMED) assert.ok(!html.includes(s), "classic page: no " + s);
  } finally { server.close(); }
  const bjs = rd("public", "js", "casinobj.js"), view = rd("views", "casino-bj.ejs");
  assert.equal((bjs.match(/CZ\.theme\(/g) || []).length, 1, "one call in render");
  assert.match(view, /<% if \(locals\.theme && theme !== 'classic'\) \{ %>/);
  assert.match(view, /casinobj\.js\?v=9/);
  const css = rd("public", "css", "casino-themes.css");
  for (const s of [".cz-theme-saloon .felt.bj {", ".cz-theme-saloon .felt.bj::after", ".cz-theme-saloon .bj-shoe", ".cz-theme-saloon .felt.bj .cz-scene"]) assert.ok(css.includes(s), s);
});

// ── privacy: the flavour line names a winner the way the award lines do - a veiled (incognito) website player is masked ──
test("privacy: a veiled winner's big-pot line is masked like the award lines (the Camfrog line and the table log)", async () => {
  const V = require(path.join(repo, "casino", "veil"));
  const was = V._hooks.kind;
  V._hooks.kind = async (keys) => (keys.includes("u:u2") ? "incognito" : null);
  if (V._reset) V._reset();
  try {
    await fresh("everyone");
    // (fresh actor objects: svc.act remembers an actor's veil on the object, and the shared ones were read unveiled above)
    const ann2 = Object.assign({}, ann, { veil: undefined }), bob2 = Object.assign({}, bob, { veil: undefined });
    const { table: tid } = await open(ann2, ["25/50", "saloon"]);
    for (const p of [ann2, bob2]) assert.ok((await A(Object.assign({}, p), "sit", ["2000"], { table: tid })).ok);
    deck(["Ks", "Kh", "As", "Ah", "2c", "7d", "9h", "3s", "4c"]);           // Bob (the second seat) holds the aces and wins
    assert.ok((await A(Object.assign({}, ann2), "deal", [], { table: tid })).ok);
    const T = svc.getTable(tid);
    let first = true;
    while (T.eng.hand_active) {
      const k2 = H.currentActor(T.eng);
      assert.ok((await A(Object.assign({}, k2 === "u1" ? ann2 : bob2), first ? "allin" : "call", [], { table: tid })).ok);
      first = false;
    }
    const evs = await events(tid);
    const pot = cowboy(evs).filter((e) => /PAT pot/.test(e.text));
    assert.equal(pot.length, 1, "the big pot's line");
    const award = evs.find((e) => e.kind === "line" && /^🏆 .* wins /.test(e.text || ""));
    assert.ok(award && !/\bBob\b/.test(award.text), "the award line is masked: " + (award && award.text));
    assert.ok(!/\bBob\b/.test(pot[0].text), "and so is the flavour line: " + pot[0].text);
    assert.ok(!svc.getTable(tid).log.some((l) => /\bBob\b/.test(l.text)), "nothing in the table's log names him");
  } finally { V._hooks.kind = was; if (V._reset) V._reset(); }
});
