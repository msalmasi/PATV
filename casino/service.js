// casino/service.js — the casino backend's table service: blackjack tables owned by the SITE (1.99lj).
// Design: docs/casino-backend.md. In short:
//
//   * A table is one JSON object (engine state from bjengine.js + seats, timers' deadlines, autobet, queued bets,
//     strikes, the round's secret seed, an intent journal) saved to casino_tables after EVERY change, so a restart
//     reloads it and the hand in progress carries on (boot()).
//   * Clients: the web (routes.js, signed-in PATV accounts) and Pepe (a thin client for Camfrog rooms: he relays a room
//     player's !bj command through actAs() and renders the events this service makes). Same rules for both, the
//     same table for both: a table can be web-only or PUSHED to a Camfrog room.
//   * Rules, timers and texts are Pepe's !bj (camfrog-bot frida-bot.py _bj_*), unchanged.
//   * Money: money.js, every movement by a deterministic key, the House = jackpot_rakes, Fed flash for a payout that
//     would take the House below its hard floor. A stake (bet / double / split / insurance) is journalled as an INTENT
//     before it is charged; boot() refunds a charged intent that never made it into the table.
//   * One mutex serialises every mutation (all tables). One 250 ms tick runs the deadlines.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("../dbUtils");
const E = require("./bjengine");
const fair = require("./fair");
const money = require("./money");
const rewards = require("./rewards");     // 1.99mj/1.99mw: every seat's achievements / drops / win XP / gang rep (rewards.js)

// ── the rules (Pepe's BJ_* constants) ──
// 1.99ov: the table maximum is 100,000 (was 10,000) and the High Roller role no longer lifts it. High Rollers get their own
// TABLES instead (T.high_stakes, 💎): bets HR_MIN_BET..HR_MAX_BET, only High Rollers open / sit / bet there, anyone watches.
// The four limits are casino_settings (bj_min_bet / bj_max_bet / bj_hr_min_bet / bj_hr_max_bet, tools/casino-settings.js);
// these are the defaults. A table keeps the limits it opened with. DROP_REF_BET: a natural's cosmetic-drop chance is
// full at this bet (rewards.js scale) - kept at the old 10,000 max so raising the cap didn't make drops rarer.
const C = {
  MIN_BET: 100, MAX_BET: 100000, HR_MIN_BET: 100000, HR_MAX_BET: 1000000, DROP_REF_BET: 10000, MAX_SEATS: 6, DECKS: 6,
  OPEN_SECS: 30, BET_SECS: 10, INS_SECS: 18, ACT_SECS: 30,
  MISS_LIMIT: 3, AFK_LIMIT: 3, COVER_MULT: 2,
  LOG_KEEP: 40, EVENT_KEEP_MS: 48 * 3600 * 1000, ROOM_FRESH_MS: 90 * 1000,
  CLOSED_LINGER_MS: 30 * 1000, TICK_MS: 250,
};
const HIGH_ROLLER = "high roller";
const HR_WORDS = ["hr", "high", "highroller", "high-roller", "vip", "💎"];
const HR_ONLY_OPEN = "💎 High Roller tables are for High Rollers (the role is in the prize store — !prizes). Anyone can watch one.";
const HR_ONLY_PLAY = "💎 this is a High Roller table: only High Rollers can play here (the role is in the prize store — !prizes). You can watch.";
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
const now = () => Date.now();

const S = {
  tables: new Map(),           // id -> table (open, plus closed ones lingering for the page)
  rooms: new Map(),            // room id -> {id, name, ts}: rooms Pepe serves with the backend on (his poll heartbeat)
  waiters: new Set(),          // pending long-polls
  settings: { bj_enabled: null, hm_enabled: null, max_tables: 0, bj_front: "auto", hm_front: "auto",
              bj_min_bet: C.MIN_BET, bj_max_bet: C.MAX_BET, bj_hr_min_bet: C.HR_MIN_BET, bj_hr_max_bet: C.HR_MAX_BET },
  stream: { table: null, by: null, ts: 0, queue: [] },   // 1.99lv: the ONE table on Pepe's stream + the FIFO queue
  settingsAt: 0,
  tick: null,
  booted: null,
  lastSeq: 0,
  hooks: { now },              // tests override the clock
  rate: new Map(),             // uid -> [timestamps]
};
const clock = () => S.hooks.now();

// ── links (1.99lv: a table's announcement in a room links its web page; a finished round links its proof) ──
function siteBase() {
  return String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv"))
    .replace(/\/+$/, "");
}
const dropLine = (name, it) => `🎁 ${name} found a cosmetic: ${it.name}${it.rarity ? " (" + String(it.rarity).toUpperCase() + ")" : ""}! ${siteBase()}/cosmetics`;
const link = (T) => `${siteBase()}/casino/${T.game === "holdem" ? "holdem" : "blackjack"}/t/${T.id}`;
const fairLink = (T, n) => `${siteBase()}/casino/fair/${T.id}/${n}`;

// ── the mutex ──
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ── tables ──
let readyP = null;
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_tables (
      id TEXT PRIMARY KEY, game TEXT NOT NULL, status TEXT NOT NULL, room TEXT, host TEXT, state TEXT NOT NULL,
      rev INTEGER DEFAULT 0, created INTEGER, updated INTEGER)`);
    await runQuery("CREATE INDEX IF NOT EXISTS casino_tables_status ON casino_tables (status)");
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, table_id TEXT NOT NULL, room TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
      data TEXT NOT NULL)`);
    await runQuery("CREATE INDEX IF NOT EXISTS casino_events_ts ON casino_events (ts)");
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_rounds (
      table_id TEXT NOT NULL, round_no INTEGER NOT NULL, commitment TEXT NOT NULL, server_seed TEXT, client_seed TEXT NOT NULL,
      num_decks INTEGER NOT NULL, shoe TEXT, players TEXT, results TEXT, created INTEGER, dealt INTEGER, revealed INTEGER,
      PRIMARY KEY (table_id, round_no))`);
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_actions (
      key TEXT PRIMARY KEY, table_id TEXT, userId TEXT, response TEXT, created INTEGER)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS casino_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)`);
    const m = await getQuery("SELECT MAX(seq) AS s FROM casino_events");
    S.lastSeq = (m[0] && m[0].s) || 0;
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

// ── settings (casino_settings; tools/casino-settings.js; /admin/games) ──
const FRONTS = ["auto", "patv", "pepe"];
// 1.99ol: which front end a game uses ("patv" | "pepe"); game = "bj" | "holdem". "auto" = the engine flag decides.
function frontOf(st, game) {
  const hm = game === "holdem";
  const f = st ? (hm ? st.hm_front : st.bj_front) : "auto";
  if (f === "patv" || f === "pepe") return f;
  return st && (hm ? st.hm_enabled : st.bj_enabled) ? "patv" : "pepe";
}
// the page a game's links go to; "lobby" = Pepe's /tables unless BOTH games use the PATV casino (then /casino/blackjack)
function frontPath(st, game) {
  if (game === "lobby") return frontOf(st, "bj") === "patv" && frontOf(st, "holdem") === "patv" ? "/casino/blackjack" : "/tables";
  const patv = frontOf(st, game) === "patv";
  return game === "holdem" ? (patv ? "/casino/holdem" : "/poker") : (patv ? "/casino/blackjack" : "/blackjack");
}
async function isSiteAdmin(uid) {
  if (!uid) return false;
  const r = await getQuery("SELECT class FROM users WHERE userId = ?", [uid]).catch(() => []);
  return !!(r[0] && r[0].class === "Admin");
}
async function loadSettings(force) {
  if (!force && clock() - S.settingsAt < 10000 && S.settings.bj_enabled !== null) return S.settings;
  await ensure();
  const rows = await getQuery("SELECT key, value FROM casino_settings");
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  S.settings = {
    // default: on for staging, off for prod
    bj_enabled: kv.bj_enabled === undefined ? !!process.env.STAGING : kv.bj_enabled === "1",
    // hold'em: the same default (staging on, prod off) - its own switch
    hm_enabled: kv.hm_enabled === undefined ? !!process.env.STAGING : kv.hm_enabled === "1",
    // 1.99lv (the user's D7): no site-wide limit by default (0); one table per room always
    max_tables: Number.isFinite(Number(kv.max_tables)) && Number(kv.max_tables) > 0 ? Math.trunc(Number(kv.max_tables)) : 0,
    // 1.99ol: the FRONT END each game's links and pages use (navbar, homepage, redirects) - "auto" follows the engine flag
    // above (the old behaviour), "patv" = /casino/<game>, "pepe" = Pepe's tables (/blackjack, /poker). Independent of the
    // engine flags and of each Camfrog room's `!casino backend on|off`.
    bj_front: FRONTS.includes(kv.bj_front) ? kv.bj_front : "auto",
    hm_front: FRONTS.includes(kv.hm_front) ? kv.hm_front : "auto",
  };
  // 1.99ov: blackjack limits (normal tables, then High Roller tables) - a bad pair falls back to the defaults
  const lim = (k, d) => (Number.isFinite(Number(kv[k])) && Number(kv[k]) >= 1 ? Math.trunc(Number(kv[k])) : d);
  let [mn, mx, hmn, hmx] = [lim("bj_min_bet", C.MIN_BET), lim("bj_max_bet", C.MAX_BET), lim("bj_hr_min_bet", C.HR_MIN_BET), lim("bj_hr_max_bet", C.HR_MAX_BET)];
  if (mn > mx) [mn, mx] = [C.MIN_BET, C.MAX_BET];
  if (hmn > hmx) [hmn, hmx] = [C.HR_MIN_BET, C.HR_MAX_BET];
  Object.assign(S.settings, { bj_min_bet: mn, bj_max_bet: mx, bj_hr_min_bet: hmn, bj_hr_max_bet: hmx });
  S.settingsAt = clock();
  return S.settings;
}
const LIMIT_KEYS = ["bj_min_bet", "bj_max_bet", "bj_hr_min_bet", "bj_hr_max_bet"];
async function setSetting(key, value, actor) {
  if (!["bj_enabled", "hm_enabled", "max_tables", "bj_front", "hm_front"].concat(LIMIT_KEYS).includes(key)) throw new Error("unknown setting");
  if (/_front$/.test(key) && !FRONTS.includes(String(value))) throw new Error("front end must be auto, patv or pepe");
  await ensure();
  if (LIMIT_KEYS.includes(key)) {
    const n = Math.trunc(Number(String(value).replace(/,/g, "")));
    if (!Number.isFinite(n) || n < 1 || n > 1e10) throw new Error("a bet limit must be a whole number of PAT");
    const cur = await loadSettings(true);
    const next = Object.assign({}, cur, { [key]: n });
    if (next.bj_min_bet > next.bj_max_bet || next.bj_hr_min_bet > next.bj_hr_max_bet) throw new Error("the minimum must not be above the maximum");
  }
  const v = /_front$/.test(key) ? String(value)
          : LIMIT_KEYS.includes(key) ? String(Math.trunc(Number(String(value).replace(/,/g, ""))))
          : key !== "max_tables" ? (value === true || value === "1" || value === "on" || value === "true" ? "1" : "0")
                                 : String(Math.max(0, Math.trunc(Number(value)) || 0));
  await runQuery(`INSERT INTO casino_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                 [key, v, clock(), actor ? String(actor).slice(0, 60) : null]);
  return loadSettings(true);
}

// ── persistence ──
async function save(T) {
  T.rev = (T.rev || 0) + 1;
  T.updated = clock();
  await runQuery(`INSERT INTO casino_tables (id, game, status, room, host, state, rev, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET status = excluded.status, room = excluded.room, state = excluded.state,
                    rev = excluded.rev, updated = excluded.updated`,
                 [T.id, T.game, T.status, T.room, T.host.uid, JSON.stringify(T), T.rev, T.created, T.updated]);
  wake();
}

// ── events (the cursor Pepe long-polls; public only) ──
async function emit(T, kind, text, extra) {
  const ts = clock();
  // 1.99ox: every room the table plays in hears it (an event can name its own rooms: a push / a room leaving)
  const rs = roomsOf(T);
  const data = Object.assign({ text: text || "" }, rs.length > 1 ? { rooms: rs } : {}, extra || {});
  const r = await runQuery("INSERT INTO casino_events (table_id, room, ts, kind, data) VALUES (?, ?, ?, ?, ?)",
                           [T.id, T.room || (Array.isArray(data.rooms) && data.rooms[0]) || null, ts, kind, JSON.stringify(data)]);
  if (r && r.id) S.lastSeq = Math.max(S.lastSeq, r.id);
  if (text) {
    T.log.push({ ts, text: String(text).slice(0, 240) });
    if (T.log.length > C.LOG_KEEP) T.log.splice(0, T.log.length - C.LOG_KEEP);
  }
  wake();
}
function wake() {
  for (const w of Array.from(S.waiters)) { S.waiters.delete(w); w(); }
}

// ── players ──
async function userRow(uid) {
  const r = await getQuery("SELECT userId, username, displayname, camfrogUsername, casino_banned, class, points_balance FROM users WHERE userId = ?", [uid]);
  return r[0] || null;
}
async function isHighRoller(uid) {
  const r = await getQuery("SELECT role FROM user_roles WHERE userId = ?", [uid]).catch(() => []);
  return r.some((x) => String(x.role).toLowerCase() === HIGH_ROLLER);
}
async function dupOf(uid) {
  const r = await getQuery("SELECT dup_of FROM welcome_bonus WHERE userId = ?", [uid]).catch(() => []);
  return (r[0] && r[0].dup_of) || null;
}
const ipHash = (ip) => (ip ? crypto.createHash("sha256").update("casino|" + String(ip)).digest("hex").slice(0, 16) : null);

function rateOk(uid) {
  const t = clock();
  const list = (S.rate.get(uid) || []).filter((x) => t - x < 2000);
  if (list.length >= 12) { S.rate.set(uid, list); return false; }
  list.push(t);
  S.rate.set(uid, list);
  return true;
}

// ── a new table ──
/** a blackjack table's limits: [min, max] for a normal or a 💎 High Roller table (the current settings) */
function bjLimits(high) {
  const st = S.settings;
  return high ? [st.bj_hr_min_bet || C.HR_MIN_BET, st.bj_hr_max_bet || C.HR_MAX_BET] : [st.bj_min_bet || C.MIN_BET, st.bj_max_bet || C.MAX_BET];
}
function newTableObject(host, room, high) {
  const id = crypto.randomBytes(5).toString("hex");
  const [minBet, maxBet] = bjLimits(high);
  return {
    id, game: "bj", status: "open", room: room || null, host: { uid: host.uid, name: host.name }, created: clock(),
    client_seed: fair.newClientSeed(), eng: E.newTable({ numDecks: C.DECKS, minBet, maxBet, hitSoft17: true }), high_stakes: !!high,
    players: {}, escrowed: {}, autobet: [], lastbet: {}, pending: {}, missed: {}, afk: {},
    empty_windows: 0, dl: { bet: null, ins: null, turn: null }, turn: null, turn_token: 0,
    round: null, intent: null, opno: 0, multi: [], log: [], last_round: null, rev: 0, closed_at: null,
  };
}

const nextRoundNo = (T) => T.eng.round_no + (["betting", "idle"].includes(T.eng.phase) ? 1 : 0);
const spinId = (T, n) => `cbj:${T.id}:r${n}`;
const opKey = (T, n, uid, op) => `cbj:${T.id}:r${n}:${uid}:${op}:${++T.opno}`;

// ── money steps (intent journal) ──
/** Charge a stake: journal the intent, charge by key, then apply(); on a failed charge -> {ok:false, msg}. */
async function stake(T, uid, amount, op, type, apply) {
  const n = nextRoundNo(T);
  const key = opKey(T, n, uid, op);
  T.intent = { key, uid, amount, op, ts: clock() };
  await save(T);
  const r = await money.charge(key, uid, amount, type);
  if (!r.ok) {
    T.intent = null;
    await save(T);
    if (r.code === "E_INSUFFICIENT") {
      const u = await userRow(uid);
      return { ok: false, msg: `insufficient PAT (need ${fmt(amount)}, you have ${fmt(u ? u.points_balance : 0)})` };
    }
    return { ok: false, msg: "charge failed" };
  }
  T.escrowed[uid] = (T.escrowed[uid] || 0) + amount;
  (T.stakes || (T.stakes = [])).push({ key, uid, amount, op, round: n });
  T.intent = null;
  apply();
  await save(T);
  return { ok: true };
}

/** Return every stake still held for `uid` (or everyone) in the CURRENT betting window. */
async function refundHeld(T, uid, why) {
  const keep = [];
  for (const s of T.stakes || []) {
    if (uid && s.uid !== uid) { keep.push(s); continue; }
    const r = await money.credit(s.key + ":refund", s.uid, s.amount, `blackjack refund (${why})`);
    if (!r.ok) { console.warn(`[casino] refund ${s.key} failed (${r.code}) - kept for retry`); keep.push(s); continue; }
    T.escrowed[s.uid] = Math.max(0, (T.escrowed[s.uid] || 0) - s.amount);
    if (!T.escrowed[s.uid]) delete T.escrowed[s.uid];
  }
  T.stakes = keep;
}

/** The House can cover this round if `extra` more is staked? (stakes x2 must fit; Pepe's _bj_cover) */
async function cover(T, extra) {
  const staked = Object.values(T.escrowed).reduce((s, v) => s + Number(v || 0), 0);
  const jp = await money.houseBalance();
  const room = Math.floor(jp / C.COVER_MULT) - staked;
  return { ok: extra <= room, room: Math.max(0, room) };
}

// ── the betting window ──
async function openRound(T, first) {
  T.dl = { bet: null, ins: null, turn: null };
  T.turn = null;
  E.openBetting(T.eng);
  T.escrowed = {};
  T.stakes = [];
  T.empty_windows = 0;
  // the round's seed is committed NOW, before anyone bets
  const n = T.eng.round_no + 1;
  const seed = fair.newServerSeed();
  T.round = { no: n, seed, commitment: fair.commitment(seed), settle: null };
  await runQuery(`INSERT OR REPLACE INTO casino_rounds (table_id, round_no, commitment, client_seed, num_decks, created)
                  VALUES (?, ?, ?, ?, ?, ?)`, [T.id, n, T.round.commitment, T.client_seed, T.eng.num_decks, clock()]);
  // bets queued during the last round are charged now
  for (const [uid, amt0] of Object.entries(T.pending)) {
    const p = T.players[uid];
    const amt = Math.min(amt0, T.eng.max_bet);
    if (!T.eng.seats.includes(uid) || amt < T.eng.min_bet || !p) continue;
    if (!(await cover(T, amt)).ok) continue;
    const r = await stake(T, uid, amt, "bet", "blackjack bet", () => {
      E.placeBet(T.eng, uid, p.name, amt);
      T.lastbet[uid] = amt;
    });
    await emit(T, "line", r.ok ? `✅ ${p.name} is in for ${fmt(amt)}.` : `⚠️ ${p.name}'s queued bet didn't go through — ${r.msg}.`);
  }
  T.pending = {};
  const secs = first ? C.OPEN_SECS : C.BET_SECS;
  T.dl.bet = clock() + secs * 1000;
  const ab = T.autobet.length && !first ? " (autobet players are in automatically)" : "";
  await advertRepeat(T);                  // 1.99pc: a round is about to start - remind the advertised rooms (rate-limited)
  await emit(T, "betting", `🃏 Betting open — !bet ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}. Dealing in ${secs}s (or !bj deal).${ab}`,
             { round_no: n, commitment: T.round.commitment, secs });
  await save(T);
}

async function placeAutobets(T) {
  for (const uid of T.autobet.slice()) {
    if (!T.eng.seats.includes(uid)) { T.autobet = T.autobet.filter((k) => k !== uid); continue; }
    if (uid in T.eng.bets) continue;
    const amt = Math.min(T.lastbet[uid] || 0, T.eng.max_bet);
    const p = T.players[uid];
    if (!p || amt < T.eng.min_bet) continue;
    if (!(await cover(T, amt)).ok) continue;
    const r = await stake(T, uid, amt, "bet", "blackjack autobet", () => E.placeBet(T.eng, uid, p.name, amt));
    if (!r.ok) {
      T.autobet = T.autobet.filter((k) => k !== uid);
      await emit(T, "line", `⚠️ ${p.name}'s autobet is off — ${r.msg}.`);
      continue;
    }
    await emit(T, "line", `🔁 ${p.name} auto-bets ${fmt(amt)}.`);
  }
}

function forget(T, uid) {
  for (const m of ["lastbet", "pending", "missed", "afk"]) delete T[m][uid];
  T.autobet = T.autobet.filter((k) => k !== uid);
}

async function beginRound(T) {
  if (T.eng.phase !== "betting") return false;
  await placeAutobets(T);
  if (!E.hasBet(T.eng)) return false;
  T.dl.bet = null;
  // strikes for seated players who sat this round out
  for (const k of T.eng.seats.slice()) {
    if (k in T.eng.bets) { T.missed[k] = 0; continue; }
    T.missed[k] = (T.missed[k] || 0) + 1;
    if (T.missed[k] >= C.MISS_LIMIT) {
      const name = (T.players[k] || {}).name || k;
      try { E.leave(T.eng, k); } catch (e) { /* not seated */ }
      forget(T, k);
      await emit(T, "line", `💤 ${name} left the table — no bet for ${C.MISS_LIMIT} rounds.`);
    }
  }
  const n = T.eng.round_no + 1;
  const shoe = S.hooks.shoe ? S.hooks.shoe(T, n) : fair.shuffleShoe(T.eng.num_decks, T.round.seed, T.client_seed, n);   // tests only
  let events;
  try {
    events = E.startRound(T.eng, shoe, T.round.commitment);
  } catch (e) {
    if (!(e instanceof E.BJError)) throw e;
    await emit(T, "line", `can't deal: ${e.message}`);
    return false;
  }
  T.stakes = [];        // the stakes are in play now: settle pays them out
  T.last_activity = clock();
  await runQuery("UPDATE casino_rounds SET dealt = ?, players = ? WHERE table_id = ? AND round_no = ?",
                 [clock(), JSON.stringify(T.eng.round_players.map((k) => ({ uid: k, name: (T.players[k] || {}).name, bet: T.eng.bets[k] }))),
                  T.id, n]);
  await render(T, events);
  return true;
}

// ── rendering engine events: texts, deadlines, settlement ──
function actedText(ev) {
  const a = ev.action;
  if (a === "hits" || a === "doubles") return `${ev.name} ${a} → ${E.cardsStr(ev.cards)} = ${ev.value}${ev.bust ? " — BUST!" : ""}`;
  if (a === "stands") return `${ev.name} stands on ${ev.value}`;
  if (a === "splits") return `${ev.name} splits ${E.cardsStr(ev.cards)}`;
  return `${ev.name} ${a}`;
}

async function render(T, events) {
  for (const ev of events) {
    const t = ev.t;
    if (t === "round_start") {
      T.last_round = null;
      await emit(T, "round", `🃏 Blackjack Round ${ev.round_no} — dealing.`, { round_no: ev.round_no, commitment: ev.commitment });
    } else if (t === "deal") {
      const parts = ev.hands.map((h) => `${h.name} ${E.cardsStr(h.cards)}=${h.value}${h.blackjack ? " BJ!" : ""}`);
      await emit(T, "deal", `🂠 Pepe shows ${E.cardStr(ev.dealer_up)} + 🂠  |  ` + parts.join(" · "));
    } else if (t === "insurance_offer") {
      T.dl.ins = clock() + C.INS_SECS * 1000;
      await emit(T, "insurance", `🛡️ Pepe shows an Ace — insurance open ${C.INS_SECS}s. !insurance (costs half your bet, pays 2:1 if Pepe has blackjack).`);
    } else if (t === "insurance_result") {
      if (!ev.dealer_bj) await emit(T, "line", "No dealer blackjack — play on.");
    } else if (t === "prompt") {
      const opts = ["!hit", "!stand"];
      if (ev.can_double) opts.push("!double");
      if (ev.can_split) opts.push("!split");
      const lbl = ev.num_hands > 1 ? ` (hand ${ev.hand_index + 1}/${ev.num_hands})` : "";
      T.turn_token += 1;
      T.turn = { uid: ev.who, hand_index: ev.hand_index, token: T.turn_token };
      T.dl.turn = clock() + C.ACT_SECS * 1000;
      const p = T.players[ev.who] || {};
      await emit(T, "prompt", `➡️ @${ev.name}${lbl}: ${E.cardsStr(ev.cards)} = ${ev.value}${ev.soft ? " soft" : ""}.  ${opts.join(" · ")}`,
                 { to: p.camfrog || null, uid_hash: uidHash(ev.who) });
    } else if (t === "acted") {
      await emit(T, "line", "• " + actedText(ev));
    } else if (t === "dealer_reveal") {
      T.dl.turn = null; T.turn = null;
      await emit(T, "line", `🂠 Pepe reveals ${E.cardsStr(ev.cards)} = ${ev.value}${ev.blackjack ? " — BLACKJACK" : ""}.`);
    } else if (t === "dealer_draw") {
      await emit(T, "line", `Pepe draws ${E.cardStr(ev.card)} → ${ev.value}.`);
    } else if (t === "settle") {
      T.round.settle = "pending";
      await save(T);
      await settle(T);
    } else if (t === "round_end") {
      await afterRound(T);
    }
  }
}
const uidHash = (uid) => crypto.createHash("sha256").update("seat|" + uid).digest("hex").slice(0, 12);

/** Pay a settled round. Every step is keyed, so running it again (recovery) changes nothing that was done. */
async function settle(T) {
  const ev = T.eng.results;
  const n = T.eng.round_no;
  const OUT = { blackjack: "BJ", win: "WIN", push: "PUSH", lose: "LOSS", bust: "BUST" };
  let lostTotal = 0, totalBet = 0, totalPaid = 0;
  const summ = [];
  for (const r of ev.results) {
    if (r.total_payout > 0) {
      const pr = await money.credit(`cbj:${T.id}:r${n}:${r.key}:pay`, r.key, r.total_payout, "blackjack payout");
      if (!pr.ok) console.error(`[casino] ${T.id} r${n}: payout ${r.total_payout} to ${r.key} failed (${pr.code})`);
    }
    lostTotal += r.lost; totalBet += r.total_bet; totalPaid += r.total_payout;
    const parts = r.hands.map((h) => `${h.value} ${OUT[h.outcome]}`);
    const ins = r.insurance ? (r.insurance.won ? " ins✔" : " ins✘") : "";
    const net = r.total_payout - r.total_bet;
    summ.push(`${r.name}: ${parts.join(", ")}${ins} (${net > 0 ? "+" + fmt(net) : net < 0 ? fmt(net) : "±0"})`);
  }
  const d = ev.dealer;
  const dtag = d.bust ? " BUST" : d.blackjack ? " BJ" : "";
  if (S.hooks.crash === "payouts") throw new Error("test crash after the payouts"); // tests only
  // the House: lost stakes in, the winners' profit out (flash first when it would go below its hard floor)
  const profit = Math.max(0, totalPaid - (totalBet - lostTotal));
  if (lostTotal > 0) await money.house(`cbj:${T.id}:r${n}:house+`, spinId(T, n), null, lostTotal);
  if (profit > 0) {
    const key = `cbj:${T.id}:r${n}:house-`;
    const fl = await money.flashCover(key, profit);
    await money.house(key, spinId(T, n), null, -profit);
    const left = await money.houseBalance();
    if (left < 0 && !fl.used) console.warn(`[casino] UNCOVERED ${T.id} r${n}: the House is at ${left} after paying ${profit} (no flash)`);
  }
  // 1.99mw: every seat's rewards (hands / naturals / natural drops / win XP / gang rep) on the site - keyed, so a re-run counts nothing twice
  const drops = await rewards.blackjackRound(T, n, ev.results, C.DROP_REF_BET);
  if (S.hooks.crash === "settle") throw new Error("test crash mid-settle");          // tests only
  const net = lostTotal - profit;
  await emit(T, "settle", `🏁 Pepe ${d.value}${dtag} — ` + summ.join(" | "), {
    round_no: n, dealer: d,
    // 1.99mw: no Camfrog names here any more - the site awards every seat (rewards.js), Pepe awards nothing for a backend round
    results: ev.results.map((r) => ({ name: r.name, total_bet: r.total_bet,
                                      total_payout: r.total_payout, hands: r.hands.map((h) => ({ outcome: h.outcome, bet: h.bet, is_bj: h.is_bj })) })),
  });
  if (net) await emit(T, "line", `🏦 House ${net > 0 ? "wins" : "pays out"} ${fmt(Math.abs(net))} PAT this round ${net > 0 ? "into" : "from"} the casino jackpot.`);
  for (const d of drops) await emit(T, "line", dropLine((T.players[d.uid] || {}).name || "someone", d.item));
  // the last round on the felt, and the reveal
  T.last_round = {
    round_no: n, dealer: d,
    players: ev.results.map((r) => ({ name: r.name, net: r.total_payout - r.total_bet, total_bet: r.total_bet, total_payout: r.total_payout,
      insurance: r.insurance, hands: r.hands.map((h) => ({ cards: h.cards, value: h.value, bet: h.bet, payout: h.payout,
      net: h.payout - h.bet, outcome: h.outcome, is_bj: h.is_bj, doubled: h.doubled, split: h.from_split })) })),
  };
  await runQuery("UPDATE casino_rounds SET server_seed = ?, shoe = ?, results = ?, revealed = ? WHERE table_id = ? AND round_no = ?",
                 [T.round.seed, JSON.stringify(T.eng.shoe), JSON.stringify(T.last_round), clock(), T.id, n]);
  await emit(T, "reveal", `🔐 Shuffle proof for round ${n}: ${fairLink(T, n)}`,
             { round_no: n, commitment: T.round.commitment, server_seed: T.round.seed, client_seed: T.client_seed });
  T.last_revealed = n;
  T.escrowed = {};
  T.stakes = [];        // this round's doubles / splits / insurance are paid out above - nothing is held any more
  T.round.settle = "done";
  await save(T);
}

async function afterRound(T) {
  for (const k of T.eng.leaving.slice()) {
    const name = (T.players[k] || {}).name || k;
    try { E.leave(T.eng, k); } catch (e) { /* gone */ }
    forget(T, k);
    await emit(T, "line", `🚪 ${name} left the table.`);
  }
  T.eng.leaving = [];
  if (!T.eng.seats.length) return closeTable(T, "everyone left");
  return openRound(T, false);
}

async function closeTable(T, reason) {
  await refundHeld(T, null, "table closed");
  T.status = "closed";
  T.closed_at = clock();
  T.dl = { bet: null, ins: null, turn: null };
  T.turn = null;
  await emit(T, "closed", `🂠 Blackjack table closed${reason ? " — " + reason : ""}.`, { reason: reason || null });
  await save(T);
  streamGone(T.id);
}

// ── deadlines ──
async function onBetDeadline(T) {
  T.dl.bet = null;
  if (T.eng.phase !== "betting") return;
  if (await beginRound(T)) return;
  T.empty_windows += 1;
  if (T.empty_windows >= 2) return closeTable(T, "no bets");
  T.dl.bet = clock() + C.BET_SECS * 1000;
  await emit(T, "line", `⏳ Nobody's betting — !bet in the next ${C.BET_SECS}s or the table closes.`);
  await save(T);
}

async function onInsDeadline(T) {
  T.dl.ins = null;
  if (T.eng.phase !== "insurance") return;
  await render(T, E.finishInsurance(T.eng));
  await save(T);
}

async function onTurnDeadline(T) {
  T.dl.turn = null;
  const cur = E.currentHand(T.eng);
  if (!cur || !T.turn || cur.key !== T.turn.uid) return;
  const uid = cur.key;
  const name = (T.players[uid] || {}).name || uid;
  T.afk[uid] = (T.afk[uid] || 0) + 1;
  const afk = T.afk[uid];
  if (afk >= C.AFK_LIMIT) {
    await emit(T, "line", `⏰ ${name} timed out ${afk}x — AFK: autobet off, leaving the table.`);
    T.autobet = T.autobet.filter((k) => k !== uid);
    try { E.leave(T.eng, uid); } catch (e) { /* not seated */ }
  } else {
    await emit(T, "line", `⏰ ${name} timed out — stands (${afk}/${C.AFK_LIMIT} before AFK removal).`);
  }
  T.turn = null;
  await render(T, E.act(T.eng, uid, "stand"));
  await save(T);
}

async function tickOnce() {
  const t = clock();
  for (const T of Array.from(S.tables.values())) {
    if (T.status !== "open") {
      if (T.closed_at && t - T.closed_at > C.CLOSED_LINGER_MS) S.tables.delete(T.id);
      continue;
    }
    if (T.game === "holdem") {
      if (!HM.due(T)) continue;
      await locked(async () => {
        if (T.status !== "open") return;
        try { await HM.tick(T); } catch (e) { console.error(`[casino] ${T.id} hold'em deadline:`, e); }
      });
      continue;
    }
    const due = (T.dl.bet && T.dl.bet <= t) ? "bet" : (T.dl.ins && T.dl.ins <= t) ? "ins" : (T.dl.turn && T.dl.turn <= t) ? "turn" : null;
    if (!due) continue;
    await locked(async () => {
      if (T.status !== "open") return;
      try {
        if (due === "bet" && T.dl.bet && T.dl.bet <= clock()) await onBetDeadline(T);
        else if (due === "ins" && T.dl.ins && T.dl.ins <= clock()) await onInsDeadline(T);
        else if (due === "turn" && T.dl.turn && T.dl.turn <= clock()) await onTurnDeadline(T);
      } catch (e) {
        console.error(`[casino] ${T.id} ${due} deadline:`, e);
      }
    });
  }
  await locked(() => streamTick()).catch((e) => console.error("[casino] stream:", e));
  // housekeeping: old events
  if (Math.random() < 0.002) runQuery("DELETE FROM casino_events WHERE ts < ?", [clock() - C.EVENT_KEEP_MS]).catch(() => {});
}

// ── boot & recovery ──
async function recover(T) {
  if (T.game === "holdem") return HM.recover(T);
  // a stake caught between its intent and the table: refund it if it was charged (nobody loses a stake to a crash)
  if (T.intent) {
    const it = T.intent;
    if (await money.isDone(it.key)) {
      const r = await money.credit(it.key + ":refund", it.uid, it.amount, "blackjack refund (restart)");
      console.log(`[casino] ${T.id}: stake ${it.key} interrupted by a restart - refunded (${r.ok ? "ok" : r.code})`);
    }
    T.intent = null;
  }
  // a settle that didn't finish: run it again (done steps are skipped by key)
  if (T.round && T.round.settle === "pending" && T.eng.results) {
    console.log(`[casino] ${T.id}: finishing round ${T.eng.round_no}'s settlement after a restart`);
    await settle(T);
    await afterRound(T);
    return;
  }
  // settled, but the next betting window never opened
  if (T.eng.phase === "done" && (!T.round || T.round.settle === "done")) {
    await afterRound(T);
    return;
  }
  // deadlines that ran out while we were down: a fresh full window (a player isn't timed out by our restart)
  const t = clock();
  const full = { bet: C.BET_SECS, ins: C.INS_SECS, turn: C.ACT_SECS };
  for (const k of Object.keys(full)) if (T.dl[k] && T.dl[k] < t + 1000) T.dl[k] = t + full[k] * 1000;
  // a live table with no deadline at all (shouldn't happen) gets the one its phase needs
  if (T.eng.phase === "betting" && !T.dl.bet) T.dl.bet = t + C.BET_SECS * 1000;
  if (T.eng.phase === "insurance" && !T.dl.ins) T.dl.ins = t + C.INS_SECS * 1000;
  if (T.eng.phase === "player" && !T.dl.turn) {
    const cur = E.currentHand(T.eng);
    if (cur) { T.turn = { uid: cur.key, hand_index: E.handIndex(T.eng, cur)[0], token: ++T.turn_token }; T.dl.turn = t + C.ACT_SECS * 1000; }
  }
  await save(T);
}

async function boot({ tick = true } = {}) {
  if (S.booted) return S.booted;
  S.booted = (async () => {
    await ensure();
    await loadSettings(true);
    await streamLoad();
    const rows = await getQuery("SELECT state FROM casino_tables WHERE status = 'open'");
    for (const r of rows) {
      let T;
      try { T = JSON.parse(r.state); } catch (e) { continue; }
      S.tables.set(T.id, T);
      await locked(() => recover(T)).catch((e) => console.error(`[casino] recover ${T.id}:`, e));
    }
    if (rows.length) console.log(`[casino] loaded ${rows.length} open table(s)`);
    if (tick && !S.tick) {
      let busy = false;
      S.tick = setInterval(() => {
        if (busy) return;
        busy = true;
        tickOnce().catch((e) => console.error("[casino] tick:", e)).finally(() => { busy = false; });
      }, C.TICK_MS);
      if (S.tick.unref) S.tick.unref();
    }
  })();
  return S.booted;
}
function stop() {
  if (S.tick) clearInterval(S.tick);
  S.tick = null;
  S.booted = null;
  S.tables.clear();
  S.stream = { table: null, by: null, ts: 0, queue: [] };
  wake();
}

// ── the commands (one per verb; the same for web and room players) ──
// actor: {uid, name, username, camfrog, via: "web"|"room", iph, admin}
// quiet: the room already sees it as a public line - Pepe doesn't @-reply it (the web shows it as a status)
const R = (ok, reply, extra) => Object.assign({ ok, reply }, extra || {});

async function cmdStart(actor, room, game, blinds) {
  const st = await loadSettings();
  if (game === "holdem" ? !st.hm_enabled : !st.bj_enabled) {
    return R(false, game === "holdem" ? "🃏 Hold'em on the site is switched off right now." : "🂠 Blackjack on the site is switched off right now.");
  }
  const open = Array.from(S.tables.values()).filter((t) => t.status === "open");
  const here = room ? open.find((t) => roomsOf(t).includes(room)) : null;      // one table per room (either game; 1.99ox: any attached room)
  if (here) {
    return R(false, here.game === "holdem" ? "a Hold'em table is already open here — !sit to join, or !holdem status."
                                           : "a blackjack table is already open — !bet to play.");
  }
  if (st.max_tables > 0 && open.length >= st.max_tables) return R(false, `the casino has ${open.length} tables open already — join one at /tables.`);
  if (game === "holdem") return HM.start(actor, room, blinds);
  // 1.99ov: "!bj start hr" (or the web's High Roller button) opens a 💎 High Roller table - High Rollers only
  const high = HR_WORDS.includes(String(blinds || "").toLowerCase());
  if (blinds && !high) return R(false, "usage: !blackjack start  (or !blackjack start hr for a 💎 High Roller table)");
  if (high && !(await isHighRoller(actor.uid))) return R(false, HR_ONLY_OPEN);
  const T = newTableObject(actor, room, high);
  S.tables.set(T.id, T);
  await save(T);
  await emit(T, "opened", `🂠 ${actor.name} opened a ${high ? "💎 High Roller " : ""}Blackjack table — Pepe deals! 6-deck shoe, blackjack pays 3:2, dealer hits soft 17. ` +
             `Bets ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)} PAT${high ? " (High Rollers only; anyone can watch)" : ""}. Play here or on the web: ${link(T)}`,
             { client_seed: T.client_seed, url: link(T), high_stakes: high });
  await openRound(T, true);
  return R(true, "table open.", { table: T.id, quiet: true });
}

async function seatChecks(T, actor) {
  const u = await userRow(actor.uid);
  if (!u) return "no account found";
  if (u.casino_banned) return "🚫 you're banned from the casino.";
  if (!T.eng.seats.includes(actor.uid)) {
    if (T.eng.seats.length >= C.MAX_SEATS) return `the table's full (${C.MAX_SEATS} seats).`;
    const mine = await dupOf(actor.uid);
    for (const k of T.eng.seats) {
      if (k === mine || (await dupOf(k)) === actor.uid || (mine && (await dupOf(k)) === mine)) return "an account linked to yours is already at this table.";
    }
    if (actor.iph) {
      const same = Object.entries(T.players).filter(([k, p]) => k !== actor.uid && p.iph && p.iph === actor.iph && T.eng.seats.includes(k));
      if (same.length) {
        T.multi.push({ ts: clock(), a: actor.uid, b: same[0][0] });
        if (T.multi.length > 20) T.multi.splice(0, T.multi.length - 20);
        console.warn(`[casino] ${T.id}: two accounts from one address at one table (${actor.uid}, ${same[0][0]}) - flagged`);
      }
    }
  }
  return null;
}

function remember(T, actor) {
  const prev = T.players[actor.uid] || {};
  T.players[actor.uid] = { name: actor.name || prev.name || actor.username, username: actor.username || prev.username || null,
                           camfrog: actor.camfrog || prev.camfrog || null, via: actor.via || prev.via || "web", iph: actor.iph || prev.iph || null,
                           room: actor.room || prev.room || null };
}

async function cmdBet(T, actor, amount) {
  amount = Math.trunc(Number(String(amount == null ? "" : amount).replace(/,/g, "")));
  if (!Number.isFinite(amount) || amount <= 0) return R(false, `usage: !bet <amount>  (${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)})`);
  const bad = await seatChecks(T, actor);
  if (bad) return R(false, bad);
  if (T.high_stakes && !(await isHighRoller(actor.uid))) return R(false, HR_ONLY_PLAY);
  if (amount < T.eng.min_bet || amount > T.eng.max_bet) {
    return R(false, `bet must be ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}.`);
  }
  remember(T, actor);
  const p = T.players[actor.uid];
  if (!["betting", "idle"].includes(T.eng.phase)) {
    T.pending[actor.uid] = amount;
    T.lastbet[actor.uid] = amount;
    E.sit(T.eng, actor.uid, p.name);
    await save(T);
    return R(true, `🪑 you're in for the next round — ${fmt(amount)} PAT (charged when betting opens). !bet again to change, !bj leave to cancel.`);
  }
  if (actor.uid in T.eng.bets) return R(false, `you've already bet ${fmt(T.eng.bets[actor.uid])} this round.`);
  const cv = await cover(T, amount);
  if (!cv.ok) return R(false, `🏦 the casino jackpot can't cover that bet right now — the most the table can take this round is ${fmt(cv.room)} PAT.`);
  const r = await stake(T, actor.uid, amount, "bet", "blackjack bet", () => {
    E.placeBet(T.eng, actor.uid, p.name, amount);
    T.lastbet[actor.uid] = amount;
    T.afk[actor.uid] = 0;
    T.missed[actor.uid] = 0;
    T.empty_windows = 0;
    if (!T.dl.bet && T.eng.phase === "betting") T.dl.bet = clock() + C.BET_SECS * 1000;
  });
  if (!r.ok) return R(false, `can't bet: ${r.msg}`);
  await emit(T, "line", `💰 ${p.name} bets ${fmt(amount)}.`);
  await save(T);
  return R(true, `you bet ${fmt(amount)}.`, { quiet: true });
}

async function cmdAutobet(T, actor, arg) {
  arg = String(arg == null ? "" : arg).toLowerCase().replace(/,/g, "");
  if (["off", "stop", "no", "0"].includes(arg)) {
    T.autobet = T.autobet.filter((k) => k !== actor.uid);
    await save(T);
    return R(true, "🔁 autobet OFF.");
  }
  const bad = await seatChecks(T, actor);
  if (bad) return R(false, bad);
  if (T.high_stakes && !(await isHighRoller(actor.uid))) return R(false, HR_ONLY_PLAY);
  let amount = null;
  if (arg && !["on", "yes"].includes(arg)) {
    amount = Math.trunc(Number(arg));
    if (!Number.isFinite(amount) || amount <= 0) return R(false, "usage: !autobet [amount|off]");
    if (amount < T.eng.min_bet || amount > T.eng.max_bet) return R(false, `autobet amount must be ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}.`);
  }
  if (amount === null) {
    amount = T.lastbet[actor.uid];
    if (!amount) return R(false, `bet once first, or set an amount: !autobet <${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}>.`);
  }
  remember(T, actor);
  T.lastbet[actor.uid] = amount;
  if (!T.autobet.includes(actor.uid)) T.autobet.push(actor.uid);
  E.sit(T.eng, actor.uid, T.players[actor.uid].name);
  await save(T);
  return R(true, `🔁 autobet ON — you'll auto-bet ${fmt(amount)} each round. !autobet off to stop.`);
}

async function cmdDeal(T) {
  if (T.eng.phase !== "betting") return R(false, "not in the betting phase right now.");
  if (!(await beginRound(T))) return R(false, "no bets yet — !bet <amount> first.");
  await save(T);
  return R(true, "dealing.", { quiet: true });
}

async function cmdAction(T, actor, action) {
  if (T.eng.phase !== "player") return R(false, "there's no blackjack decision open right now.");
  const cur = E.currentHand(T.eng);
  if (!cur || cur.key !== actor.uid) return R(false, "it's not your turn.");
  T.afk[actor.uid] = 0;
  let extra = 0;
  if (action === "double") {
    if (!E.canDouble(T.eng)) return R(false, "you can only double on a two-card hand.");
    extra = cur.bet;
  } else if (action === "split") {
    if (!E.canSplit(T.eng)) return R(false, "you can't split that hand.");
    extra = cur.bet;
  }
  if (extra) {
    const u = await userRow(actor.uid);
    if (u && u.casino_banned) return R(false, "🚫 you're banned from the casino.");
    if (!(await cover(T, extra)).ok) return R(false, `🏦 the casino jackpot can't cover a ${action} right now.`);
    const hi = T.eng.hand_ptr;
    const r = await stake(T, actor.uid, extra, action === "double" ? `dbl${hi}` : `spl${hi}`, `blackjack ${action}`, () => {});
    if (!r.ok) return R(false, `can't ${action}: ${r.msg}`);
  }
  let events;
  try {
    events = E.act(T.eng, actor.uid, action);
  } catch (e) {
    if (!(e instanceof E.BJError)) throw e;
    return R(false, `🚫 ${e.message}`);
  }
  T.dl.turn = null; T.turn = null;
  await render(T, events);
  await save(T);
  return R(true, "ok.", { quiet: true });
}

async function cmdInsurance(T, actor) {
  if (T.eng.phase !== "insurance") return R(false, "insurance isn't open.");
  if ((T.eng.bets[actor.uid] || 0) <= 0) return R(false, "you're not in this round.");
  if (actor.uid in T.eng.insurance) return R(false, "you already took insurance.");
  const amt = E.insuranceAmount(T.eng, actor.uid);
  if (amt <= 0) return R(false, "your bet's too small to insure.");
  const u = await userRow(actor.uid);
  if (u && u.casino_banned) return R(false, "🚫 you're banned from the casino.");
  if (!(await cover(T, amt)).ok) return R(false, "🏦 the casino jackpot can't cover insurance right now.");
  const r = await stake(T, actor.uid, amt, "ins", "blackjack insurance", () => E.takeInsurance(T.eng, actor.uid));
  if (!r.ok) return R(false, `can't insure: ${r.msg}`);
  await emit(T, "line", `🛡️ ${(T.players[actor.uid] || {}).name || actor.name} takes insurance (${fmt(amt)}).`);
  await save(T);
  return R(true, `insured for ${fmt(amt)}.`, { quiet: true });
}

async function cmdLeave(T, actor) {
  if (!T.eng.seats.includes(actor.uid)) {
    if (actor.uid in T.pending) { delete T.pending[actor.uid]; await save(T); return R(true, "your queued bet is cancelled."); }
    return R(false, "you're not at the table.");
  }
  if (E.leave(T.eng, actor.uid) === false) {
    T.autobet = T.autobet.filter((k) => k !== actor.uid);
    delete T.pending[actor.uid];
    await save(T);
    return R(true, "you'll leave once this round finishes.");
  }
  // between rounds: a bet already placed in this window goes back (Pepe's engine kept it - fixed here)
  await refundHeld(T, actor.uid, "left the table");
  const name = (T.players[actor.uid] || {}).name || actor.name;
  forget(T, actor.uid);
  await emit(T, "line", `🚪 ${name} left the blackjack table.`);
  if (!T.eng.seats.length) await closeTable(T, "table empty");
  else await save(T);
  return R(true, "you left the table.", { quiet: true });
}

function statusText(T) {
  const seats = T.eng.seats.map((k) => T.eng.names[k] || (T.players[k] || {}).name || k);
  let msg = `🂠 ${T.high_stakes ? "💎 High Roller " : ""}Blackjack ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)} — ${T.eng.phase}. Players: ` + (seats.join(", ") || "none");
  if (T.eng.phase === "betting") {
    const bets = Object.entries(T.eng.bets).map(([k, v]) => `${T.eng.names[k]} ${fmt(v)}`);
    msg += " | bets: " + (bets.join(", ") || "none yet");
  }
  return msg;
}

async function cmdEnd(T, actor) {
  if (actor.uid !== T.host.uid && !actor.admin) return R(false, "only the table starter or an admin can close it.");
  if (["insurance", "player", "dealer"].includes(T.eng.phase)) return R(false, "can't close mid-round — let it finish.");
  await closeTable(T, `closed by ${actor.name}`);
  return R(true, "table closed.", { quiet: true });
}

const HELP = "🂠 Blackjack — Pepe deals (6-deck, blackjack pays 3:2, dealer hits soft 17). !blackjack start opens a table; " +
             "!bet <amount> each round; then !hit, !stand, !double, !split, !insurance. Beat Pepe without going over 21.";

// 1.99pc: "!bj advertise <room>" / "!holdem unadvertise <room>" - the host advertises the table of this room elsewhere
const ADVERT_VERBS = ["advertise", "advert", "ad", "unadvertise", "unadvert"];
async function advertCmd(T, actor, verb, args) {
  if (!T) return R(false, "there's no casino table here to advertise.");
  const room = String((args || [])[0] || "").trim();
  if (!room) {
    const list = advertList(T).map((r) => r.name);
    return R(true, list.length ? `📣 advertised in ${list.join(", ")}. !bj advertise <room> / !bj unadvertise <room>.`
                               : "📣 usage: !bj advertise <room> (or !holdem advertise <room>) - Pepe posts this table's link there.");
  }
  return advertiseIn(T, room, actor, !verb.startsWith("un"));
}

/** Run one command on a table (or open one). verb + args as typed after !bj. -> {ok, reply, table?} */
async function run(actor, verb, args, opts) {
  opts = opts || {};
  verb = String(verb || "").toLowerCase();
  const alias = { open: "start", new: "start", go: "deal", wager: "bet", auto: "autobet", rebet: "autobet", close: "end", stop: "end",
                  quit: "leave", insure: "insurance", stay: "stand", dd: "double", table: "status", info: "status", show: "status",
                  rules: "help", how: "help", "": "status" };
  const game = opts.game === "holdem" ? "holdem" : opts.game === "bj" ? "bj" : null;
  const T = opts.table ? S.tables.get(opts.table) : null;
  const live = T && T.status === "open" ? T : null;
  // a Hold'em table here (or "!holdem ..."): its own verbs - the shared ones (!bet !stand !leave) mean the Hold'em ones
  if ((live && live.game === "holdem") || (!live && game === "holdem")) {
    if (live && game === "bj") return R(false, "a Hold'em table is running here — !holdem status.");
    if (["help", "rules", "how"].includes(verb)) return R(true, HM.HELP);
    if (actor.uid && !rateOk(actor.uid)) return R(false, "slow down a little.");
    if (["start", "open", "new", "sit", "buyin", "buy", "join"].includes(verb)) {
      const u = await userRow(actor.uid);
      if (u && u.casino_banned) return R(false, "🚫 you're banned from the casino.");
    }
    if (["start", "open", "new"].includes(verb)) return cmdStart(actor, opts.room || null, "holdem", args[0]);
    if (ADVERT_VERBS.includes(verb)) return advertCmd(live, actor, verb, args);
    if (!live) {
      return R(false, ["status", "", "table", "info", "show"].includes(verb) ? "no Hold'em table open. Start one: !holdem start 25/50."
                                                                             : "no table open — start one with !holdem start 25/50.");
    }
    return HM.run(live, actor, verb, args);
  }
  if (live && game === "holdem") return R(false, "a blackjack table is running here — !bj status.");
  if (ADVERT_VERBS.includes(verb)) return advertCmd(live, actor, verb, args);
  verb = alias[verb] !== undefined ? alias[verb] : verb;
  if (verb === "help") return R(true, HELP);
  if (actor.uid && !rateOk(actor.uid)) return R(false, "slow down a little.");
  if (["start", "bet", "autobet"].includes(verb)) {
    const u = await userRow(actor.uid);
    if (u && u.casino_banned) return R(false, "🚫 you're banned from the casino.");
  }
  if (verb === "start") return cmdStart(actor, opts.room || null, "bj", args[0]);
  if (verb === "fair") {
    return R(true, live && live.last_revealed ? `🔐 Shuffle proof for round ${live.last_revealed}: ${fairLink(live, live.last_revealed)}`
                                              : "🔐 No round finished at this table yet — each round's proof is posted when it ends.");
  }
  if (!T || T.status !== "open") {
    if (verb === "status") return R(false, "no blackjack table open. Start one: !blackjack start.");
    return R(false, "no blackjack table — start one with !blackjack start.");
  }
  switch (verb) {
    case "bet": return cmdBet(T, actor, args[0]);
    case "autobet": return cmdAutobet(T, actor, args[0]);
    case "deal": return cmdDeal(T);
    case "hit": case "stand": case "double": case "split": return cmdAction(T, actor, verb);
    case "insurance": return cmdInsurance(T, actor);
    case "leave": return cmdLeave(T, actor);
    case "status": return R(true, statusText(T) + ` | ${link(T)}`);
    case "end": return cmdEnd(T, actor);
    default: return R(false, "unknown !blackjack option — try: start, bet, hit, stand, double, split, status, fair.");
  }
}

/** The idempotent, serialised entry point. key: the caller's idempotency key (required). */
async function act(actor, verb, args, opts, key) {
  await boot();
  if (!key) return R(false, "missing idempotency key");
  key = String(key).slice(0, 120);
  return locked(async () => {
    const prev = await getQuery("SELECT response FROM casino_actions WHERE key = ?", [key]);
    if (prev.length) return Object.assign(JSON.parse(prev[0].response), { replayed: true });
    let out;
    try {
      out = await run(actor, verb, Array.isArray(args) ? args : [], opts);
    } catch (e) {
      console.error("[casino] act:", e);
      out = R(false, "something went wrong — nothing was charged.");
    }
    const tid = out.table || (opts && opts.table) || null;
    await runQuery("INSERT OR IGNORE INTO casino_actions (key, table_id, userId, response, created) VALUES (?, ?, ?, ?, ?)",
                   [key, tid, actor.uid || null, JSON.stringify(out), clock()]);
    return out;
  });
}

/** 1.99ox: cross-room play - a table plays in SEVERAL Camfrog rooms at once. T.rooms = [home, ...pushed] (T.room stays the
 *  home room = T.rooms[0], so everything that only needs "is it in a room" / the stream slot is unchanged). Still one
 *  table per room: a room can't be attached to two open tables. Events carry data.rooms = every attached room. */
const roomsOf = (T) => (Array.isArray(T.rooms) ? T.rooms : T.room ? [T.room] : []);
function setRooms(T, list) {
  T.rooms = Array.from(new Set(list.filter(Boolean)));
  T.room = T.rooms[0] || null;
}
const roomName = (id) => { const r = S.rooms.get(id); return r ? r.name : id; };
const MAX_ROOMS = 6;

/** Push a table to a Camfrog room. mode "add" (the default): attach one more room; "remove": detach that room;
 *  room = null: back to web-only (every room detached). Host or admin. */
async function push(tableId, room, actor, mode) {
  await boot();
  return locked(async () => {
    const T = S.tables.get(tableId);
    if (!T || T.status !== "open") return R(false, "That table has closed.");
    if (actor.uid !== T.host.uid && !actor.admin) return R(false, "Only the table's host or an admin can move it.");
    const cur = roomsOf(T);
    if (room && mode !== "remove") {
      if (cur.includes(room)) return R(true, "It's already playing there.", { rooms: cur });
      const r = S.rooms.get(room);
      if (!r || clock() - r.ts > C.ROOM_FRESH_MS) return R(false, "Pepe isn't in that room with the casino on right now.");
      if (Array.from(S.tables.values()).some((t) => t.status === "open" && t.id !== T.id && roomsOf(t).includes(room))) return R(false, "That room already has a casino table.");
      if (cur.length >= MAX_ROOMS) return R(false, `A table can play in up to ${MAX_ROOMS} rooms at once.`);
      setRooms(T, cur.concat([room]));
      const how = T.game === "holdem"
        ? `a ${T.high_stakes ? "💎 High Roller " : ""}No-Limit Hold'em table (${fmt(T.eng.sb)}/${fmt(T.eng.bb)}) — !sit <amount> to buy in (${fmt(T.min_buy)}–${fmt(T.max_buy)})`
        : `a ${T.high_stakes ? "💎 High Roller " : ""}Blackjack table — !bet <amount> to sit in (${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)})`;
      const also = cur.length ? ` Also playing in ${cur.map(roomName).join(", ")}.` : "";
      await emit(T, "pushed", `${T.game === "holdem" ? "🃏" : "🂠"} ${T.host.name}'s ${how}. It's playing in this room now, and on the web: ${link(T)}${also}`,
                 { room_name: r.name, url: link(T), rooms: [room] });
      if (cur.length) await emit(T, "line", `🐸 This table is now also playing in ${r.name} — players there sit at the same table.`, { rooms: cur });
    } else if (room) {
      if (!cur.includes(room)) return R(false, "It isn't playing in that room.");
      await emit(T, "unpushed", `This table left this room — play on at ${link(T)}`, { rooms: [room] });
      setRooms(T, cur.filter((x) => x !== room));
    } else {
      if (!cur.length) return R(true, "It was already web-only.");
      await emit(T, "unpushed", `This table went back to the website — play on at ${link(T)}`, { rooms: cur });
      setRooms(T, []);                       // 1.99pc: a web-only table keeps its place on Pepe's stream
    }
    await save(T);
    return R(true, room && mode !== "remove" ? "Announced in the room." : T.room ? "Room removed." : "The table is web-only now.", { rooms: roomsOf(T) });
  });
}

// ── views ──
/** [{id, name}] of every room a table plays in (home first) */
const roomList = (T) => roomsOf(T).map((id) => ({ id, name: roomName(id) }));

function bjView(T) {
  const e = T.eng;
  const hidden = ["insurance", "player"].includes(e.phase);
  const dCards = e.dealer.slice();
  const dealer = hidden && dCards.length
    ? { cards: [dCards[0]], down: 1, value: E.cardValue(dCards[0]), hidden: true, bust: false, blackjack: false }
    : (() => { const v = dCards.length ? E.handValue(dCards)[0] : 0; return { cards: dCards, down: 0, value: v, hidden: false, bust: v > 21, blackjack: E.isBlackjack(dCards) }; })();
  const cur = E.currentHand(e);
  const seats = e.seats.map((k) => {
    const p = T.players[k] || {};
    return {
      name: e.names[k] || p.name || "?", via: p.via || "web", bet: e.bets[k] || 0, pending: T.pending[k] || 0,
      insured: k in e.insurance, autobet: T.autobet.includes(k), turn: !!cur && cur.key === k, leaving: e.leaving.includes(k),
      host: k === T.host.uid, seat: uidHash(k),
      hands: e.hands.filter((h) => h.key === k).map((h) => {
        const [v, soft] = E.handValue(h.cards);
        return { cards: h.cards.slice(), value: v, soft, bet: h.bet, outcome: h.outcome, payout: e.phase === "done" ? h.payout : null,
                 is_bj: h.is_bj, doubled: h.doubled, split: h.from_split, current: h === cur };
      }),
    };
  });
  let turn = null;
  if (cur && T.turn) {
    const [idx, n] = E.handIndex(e, cur);
    turn = { name: e.names[cur.key], seat: uidHash(cur.key), hand_index: idx, num_hands: n, can_double: E.canDouble(e), can_split: E.canSplit(e), deadline: T.dl.turn };
  }
  const room = T.room ? S.rooms.get(T.room) : null;
  return {
    id: T.id, game: "bj", status: T.status, phase: T.status === "closed" ? "closed" : e.phase, rev: T.rev,
    room: T.room, room_name: room ? room.name : T.room, rooms: roomList(T), host: T.host.name, round_no: e.round_no,
    min_bet: e.min_bet, max_bet: e.max_bet, high_stakes: !!T.high_stakes, adverts: advertList(T), max_seats: C.MAX_SEATS, decks: e.num_decks, act_secs: C.ACT_SECS,
    client_seed: T.client_seed, commitment: T.round ? T.round.commitment : null, commit_round: T.round ? T.round.no : null,
    dealer, seats, turn, bet_deadline: T.dl.bet, ins_deadline: T.dl.ins,
    last_round: ["betting", "idle", "done"].includes(e.phase) || T.status === "closed" ? T.last_round : null,
    last_revealed: T.last_revealed || null, url: link(T), log: T.log.slice(-20),
  };
}

function publicView(T) {
  const v = T.game === "holdem" ? HM.publicView(T) : bjView(T);
  v.on_stream = S.stream.table === T.id;
  const qi = S.stream.queue.indexOf(T.id);
  v.stream_queue = qi >= 0 ? qi + 1 : null;
  return v;
}

async function meView(T, uid) {
  if (!uid) return null;
  const u = await userRow(uid);
  if (!u) return null;
  const base = { name: u.displayname || u.username, balance: Number(u.points_balance) || 0, banned: !!u.casino_banned, admin: u.class === "Admin" };
  if (T && T.game === "holdem") return Object.assign(base, await HM.meView(T, uid, u));
  const e = T ? T.eng : null;
  const cur = e ? E.currentHand(e) : null;
  return Object.assign(base, {
    high_roller: await isHighRoller(uid),
    seat: T && e.seats.includes(uid) ? uidHash(uid) : null,
    host: !!T && T.host.uid === uid,
    bet: e ? e.bets[uid] || 0 : 0, pending: T ? T.pending[uid] || 0 : 0, autobet: !!T && T.autobet.includes(uid),
    lastbet: T ? T.lastbet[uid] || 0 : 0, my_turn: !!cur && cur.key === uid,
    can_insure: !!e && e.phase === "insurance" && (e.bets[uid] || 0) > 0 && !(uid in e.insurance),
  });
}

function lobby() {
  return Array.from(S.tables.values()).filter((t) => t.status === "open").map((T) => {
    const room = T.room ? S.rooms.get(T.room) : null;
    const base = { id: T.id, host: T.host.name, room: T.room, room_name: room ? room.name : T.room, rooms: roomList(T), adverts: advertList(T), url: link(T), on_stream: S.stream.table === T.id };
    if (T.game === "holdem") return Object.assign(base, HM.lobbyRow(T));
    return Object.assign(base, { game: "bj", phase: T.eng.phase, players: T.eng.seats.length, max_seats: C.MAX_SEATS,
                                 min_bet: T.eng.min_bet, max_bet: T.eng.max_bet, round_no: T.eng.round_no, high_stakes: !!T.high_stakes });
  });
}

const getTable = (id) => S.tables.get(id) || null;
const tableForRoom = (room) => Array.from(S.tables.values()).find((t) => t.status === "open" && roomsOf(t).includes(room)) || null;

// ── Pepe's stream: ONE table on the OBS games overlay at a time (the user's D9) ──
// First come takes the slot; a later request joins a FIFO queue (with its place); an admin can override (the bumped
// table goes back to the HEAD of the queue). The slot is released when its table closes or goes back to web-only, or
// after STREAM_IDLE_MS with no round dealt; the next queued table (still open and still in a room) then takes it.
const STREAM_IDLE_MS = 5 * 60 * 1000;
async function streamSave() {
  await runQuery(`INSERT INTO casino_settings (key, value, updated, actor) VALUES ('stream_slot', ?, ?, 'casino')
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`, [JSON.stringify(S.stream), clock()]);
}
async function streamLoad() {
  try {
    const r = await getQuery("SELECT value FROM casino_settings WHERE key = 'stream_slot'");
    if (r[0]) {
      const v = JSON.parse(r[0].value);
      S.stream = { table: v.table || null, by: v.by || null, ts: Number(v.ts) || 0, queue: Array.isArray(v.queue) ? v.queue.slice(0, 50) : [] };
    }
  } catch (e) { /* a fresh database */ }
}
// 1.99pc: any open table can be on Pepe's stream - a web-only one too (the poll always carries the stream table)
const streamable = (id) => { const T = S.tables.get(id); return !!T && T.status === "open"; };
async function streamAdvance() {
  while (S.stream.queue.length) {
    const id = S.stream.queue.shift();
    if (!streamable(id)) continue;
    S.stream.table = id; S.stream.ts = clock(); S.stream.by = "queue";
    const T = S.tables.get(id);
    T.last_activity = Math.max(T.last_activity || 0, clock());
    await emit(T, "stream", `📺 This ${T.game === "holdem" ? "Hold'em" : "blackjack"} table is on Pepe's stream now.`, { on: true });
    break;
  }
  await streamSave();
}
/** a table closed / went web-only: free its slot (and its place in the queue) */
function streamGone(id) {
  S.stream.queue = S.stream.queue.filter((x) => x !== id);
  if (S.stream.table === id) {
    S.stream.table = null;
    streamAdvance().catch((e) => console.error("[casino] stream:", e));
  } else {
    streamSave().catch(() => {});
  }
}
async function streamTick() {
  const id = S.stream.table;
  if (id) {
    const T = S.tables.get(id);
    if (!streamable(id)) { S.stream.table = null; await streamAdvance(); return; }
    if (clock() - Math.max(T.last_activity || 0, S.stream.ts || 0) > STREAM_IDLE_MS) {
      S.stream.table = null;
      await emit(T, "stream", "📺 Off Pepe's stream — no round in 5 minutes.", { on: false });
      await streamAdvance();
    }
  } else if (S.stream.queue.length) {
    await streamAdvance();
  }
}
/** on: ask for the stream (host or admin; admins may override), off: leave it / the queue */
async function stream(tableId, on, actor, override) {
  await boot();
  return locked(async () => {
    const T = S.tables.get(tableId);
    if (!T || T.status !== "open") return R(false, "That table has closed.");
    if (actor.uid !== T.host.uid && !actor.admin) return R(false, "Only the table's host or an admin can put it on the stream.");
    if (!on) {
      const had = S.stream.table === T.id || S.stream.queue.includes(T.id);
      if (S.stream.table === T.id) await emit(T, "stream", "📺 Off Pepe's stream.", { on: false });
      streamGone(T.id);
      return R(true, had ? "Off the stream." : "It wasn't on the stream.");
    }
    if (S.stream.table === T.id) return R(true, "It's on the stream already.");
    const cur = S.stream.table && streamable(S.stream.table) ? S.tables.get(S.stream.table) : null;
    if (!cur) {
      S.stream.queue = S.stream.queue.filter((x) => x !== T.id);
      Object.assign(S.stream, { table: T.id, by: actor.name, ts: clock() });
      T.last_activity = Math.max(T.last_activity || 0, clock());
      await emit(T, "stream", `📺 This ${T.game === "holdem" ? "Hold'em" : "blackjack"} table is on Pepe's stream now.`, { on: true });
      await streamSave();
      return R(true, "It's on Pepe's stream.");
    }
    if (override && actor.admin) {
      S.stream.queue = [cur.id].concat(S.stream.queue.filter((x) => x !== T.id && x !== cur.id));
      Object.assign(S.stream, { table: T.id, by: actor.name + " (admin)", ts: clock() });
      T.last_activity = Math.max(T.last_activity || 0, clock());
      await emit(cur, "stream", "📺 An admin moved Pepe's stream to another table — this one is next in line.", { on: false });
      await emit(T, "stream", `📺 This ${T.game === "holdem" ? "Hold'em" : "blackjack"} table is on Pepe's stream now.`, { on: true });
      await streamSave();
      return R(true, "It's on Pepe's stream (override).");
    }
    if (!S.stream.queue.includes(T.id)) S.stream.queue.push(T.id);
    await streamSave();
    const pos = S.stream.queue.indexOf(T.id) + 1;
    return R(true, `Pepe's stream is showing ${cur.host.name}'s table — you're ${pos === 1 ? "next" : "number " + pos} in line.`, { queued: pos });
  });
}

// ── 1.99pc: ADVERTS - announce a table in Camfrog rooms without playing it there ──
// The host (or an admin) advertises a table in one or more of Pepe's casino rooms: Pepe posts ONE line there (game, host,
// stakes, free seats, 💎, the link) and repeats it when a round / hand is about to start, at most every 10 minutes per room
// per table. Nothing else goes to an advertised room - no gameplay events, no commands, no hole cards (that's push).
// Pepe checks each room's backend switch and game toggle before posting.
const ADVERT_REPEAT_MS = 10 * 60 * 1000;
const MAX_ADVERTS = 10;
const advertsOf = (T) => (Array.isArray(T.adverts) ? T.adverts : []);
const advertList = (T) => advertsOf(T).map((id) => ({ id, name: roomName(id) }));
function advertText(T) {
  const hm = T.game === "holdem";
  const stakes = hm ? `blinds ${fmt(T.eng.sb)}/${fmt(T.eng.bb)}` : `bets ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}`;
  const free = Math.max(0, (hm ? HM.HC.MAX_SEATS : C.MAX_SEATS) - T.eng.seats.length);
  return `📣 ${T.high_stakes ? "💎 High Roller " : ""}${hm ? "No-Limit Hold'em" : "Blackjack"} at ${T.host.name}'s table — ${stakes}, ` +
         `${free} seat${free === 1 ? "" : "s"} free${T.high_stakes ? " (High Rollers only)" : ""}. Play on the web: ${link(T)}`;
}
const roomFresh = (id) => { const r = S.rooms.get(id); return !!r && clock() - r.ts < C.ROOM_FRESH_MS; };
/** a room by id or display name (case-insensitive) among the rooms Pepe serves right now */
function findRoom(q) {
  q = String(q || "").trim().toLowerCase();
  if (!q) return null;
  const fresh = Array.from(S.rooms.values()).filter((r) => roomFresh(r.id));
  return fresh.find((r) => r.id.toLowerCase() === q) || fresh.find((r) => r.name.toLowerCase() === q) || null;
}
/** on: advertise the table in `room` (posts the line now); off: stop. Host or admin. */
async function advertiseIn(T, room, actor, on) {
  if (!T || T.status !== "open") return R(false, "That table has closed.");
  if (actor.uid !== T.host.uid && !actor.admin) return R(false, "Only the table's host or an admin can advertise it.");
  const r = findRoom(room) || (advertsOf(T).includes(room) ? { id: room, name: roomName(room) } : null);
  if (!r) return R(false, "Pepe isn't in that room with the casino on right now.");
  const cur = advertsOf(T);
  if (!on) {
    if (!cur.includes(r.id)) return R(false, "It isn't advertised there.");
    T.adverts = cur.filter((x) => x !== r.id);
    // 1.99se: the last post time stays - stop + advertise again can't re-post inside the 10 minutes (spam guard)
    await save(T);
    return R(true, `No more adverts in ${r.name}.`, { adverts: advertList(T) });
  }
  if (roomsOf(T).includes(r.id)) return R(false, "It's already playing in that room.");
  if (!cur.includes(r.id) && cur.length >= MAX_ADVERTS) return R(false, `A table can be advertised in up to ${MAX_ADVERTS} rooms.`);
  if (!cur.includes(r.id)) T.adverts = cur.concat([r.id]);
  // 1.99se: rate-limited - Pepe posts the line in a room at most once per ADVERT_REPEAT_MS per table (asking again, or
  // stop + advertise, inside that window only keeps the room on the list; the next round / hand reminds it when due)
  const last = (T.advert_ts || {})[r.id] || 0;
  if (clock() - last < ADVERT_REPEAT_MS) {
    await save(T);
    const mins = Math.max(1, Math.ceil((ADVERT_REPEAT_MS - (clock() - last)) / 60000));
    return R(true, `Advertised in ${r.name} — Pepe posted it there recently; the next reminder is in about ${mins} min.`, { adverts: advertList(T) });
  }
  T.advert_ts = Object.assign({}, T.advert_ts || {}, { [r.id]: clock() });
  await emit(T, "advert", advertText(T), { rooms: [r.id], url: link(T), game: T.game, high_stakes: !!T.high_stakes });
  await save(T);
  return R(true, `Advertised in ${r.name}.`, { adverts: advertList(T) });
}
async function advertise(tableId, room, actor, on) {
  await boot();
  return locked(() => advertiseIn(S.tables.get(tableId), room, actor, on));
}
/** a round / hand is about to start: repeat the advert in the rooms not reminded for 10 minutes */
async function advertRepeat(T) {
  const due = advertsOf(T).filter((id) => roomFresh(id) && !roomsOf(T).includes(id) && clock() - ((T.advert_ts || {})[id] || 0) >= ADVERT_REPEAT_MS);
  if (!due.length) return;
  T.advert_ts = Object.assign({}, T.advert_ts || {});
  for (const id of due) T.advert_ts[id] = clock();
  await emit(T, "advert", advertText(T), { rooms: due, url: link(T), game: T.game, high_stakes: !!T.high_stakes, repeat: true });
}

/** 1.99pc: every open table, short (Pepe lists them as links when someone asks for a game in chat) */
function openList() {
  return Array.from(S.tables.values()).filter((t) => t.status === "open").map((T) => {
    const hm = T.game === "holdem";
    return { id: T.id, game: hm ? "holdem" : "bj", host: T.host.name, high_stakes: !!T.high_stakes, url: link(T),
             players: T.eng.seats.length, max_seats: hm ? HM.HC.MAX_SEATS : C.MAX_SEATS,
             sb: hm ? T.eng.sb : null, bb: hm ? T.eng.bb : null, min_bet: hm ? null : T.eng.min_bet, max_bet: hm ? null : T.eng.max_bet,
             rooms: roomsOf(T) };
  });
}

// ── Pepe's long-poll ──
function noteRooms(rooms) {
  const t = clock();
  for (const r of Array.isArray(rooms) ? rooms.slice(0, 50) : []) {
    if (!r || typeof r !== "object") continue;
    const id = String(r.id || "").slice(0, 64);
    if (!/^[\w .'&!@#()\-]{1,64}$/.test(id)) continue;
    S.rooms.set(id, { id, name: String(r.name || id).replace(/[\u0000-\u001f]/g, " ").slice(0, 64), ts: t });
  }
}
function freshRooms() {
  const t = clock();
  return Array.from(S.rooms.values()).filter((r) => t - r.ts < C.ROOM_FRESH_MS).map((r) => ({ id: r.id, name: r.name,
    busy: !!tableForRoom(r.id) }));
}

function roomTables() {
  const tables = {}, priv = {};
  for (const T of S.tables.values()) {
    if (!roomsOf(T).length && S.stream.table !== T.id) continue;      // 1.99pc: + the stream table, wherever it plays
    tables[T.id] = publicView(T);
    if (T.game === "holdem") Object.assign(priv, HM.privateFor(T));
  }
  return { tables, private: priv };
}

/** Events after `after` for tables in a room (Pepe's), waiting up to waitMs for the first one. The `private` part
 *  (hole cards of room players, by Camfrog name) only ever goes to Pepe (bot token), never into an event. */
async function poll(after, waitMs) {
  await boot();
  // a client with no cursor yet (or one from another database - a staging refresh) starts from now: no replay
  if (Number(after) < 0 || Number(after) > S.lastSeq) {
    return Object.assign({ cursor: S.lastSeq, events: [], stream: S.stream.table }, roomTables());
  }
  after = Math.max(0, Math.trunc(Number(after) || 0));
  const read = () => getQuery("SELECT seq, table_id, room, ts, kind, data FROM casino_events WHERE seq > ? AND room IS NOT NULL ORDER BY seq LIMIT 200", [after]);
  let rows = await read();
  if (!rows.length && waitMs > 0) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(tm); S.waiters.delete(done); resolve(); };
      const tm = setTimeout(done, waitMs);
      S.waiters.add(done);
    });
    rows = await read();
  }
  const events = rows.map((r) => ({ seq: r.seq, table: r.table_id, room: r.room, ts: r.ts, kind: r.kind, data: JSON.parse(r.data) }));
  return Object.assign({ cursor: events.length ? events[events.length - 1].seq : Math.max(after, S.lastSeq), events, stream: S.stream.table },
                       roomTables());
}

async function fairRecord(tableId, round) {
  await ensure();
  const r = (await getQuery("SELECT * FROM casino_rounds WHERE table_id = ? AND round_no = ?", [tableId, Math.trunc(Number(round) || 0)]))[0];
  if (!r) return null;
  const rec = { table: r.table_id, round: r.round_no, commitment: r.commitment, client_seed: r.client_seed, num_decks: r.num_decks,
                server_seed: r.revealed ? r.server_seed : null, shoe: r.revealed && r.shoe ? JSON.parse(r.shoe) : null,
                results: r.revealed && r.results ? JSON.parse(r.results) : null, created: r.created, dealt: r.dealt, revealed: r.revealed };
  if (rec.server_seed) {
    const v = fair.verify({ commitment: rec.commitment, server_seed: rec.server_seed, client_seed: rec.client_seed, round: rec.round,
                            num_decks: rec.num_decks, shoe: rec.shoe });
    rec.verified = v.ok;
  }
  return rec;
}

// ── Hold'em (holdem.js) on the same core ──
const HM = require("./holdem").install({
  S, clock, save, emit, userRow, isHighRoller, dupOf, R, uidHash, fmt, link, fairLink, runQuery, streamGone, rewards, dropLine,
  roomsOf: (T) => roomsOf(T), roomList: (T) => roomList(T), advertList: (T) => advertList(T), advertRepeat: (T) => advertRepeat(T),
});

/** 1.99ov: the limits the lobby / pages show (blackjack normal + 💎 tables, the Hold'em blind cap + the High Roller ladder) */
function limits() {
  const [mn, mx] = bjLimits(false), [hmn, hmx] = bjLimits(true);
  return { bj: { min_bet: mn, max_bet: mx, hr_min_bet: hmn, hr_max_bet: hmx },
           holdem: { sb_cap: HM.HC.SB_CAP, bb_cap: HM.HC.BB_CAP, hr_ladder: HM.HC.HR_LADDER.map(([sb, bb]) => [sb, bb]) } };
}

module.exports = {
  C, S, HM, boot, limits, HR_WORDS, roomsOf, advertise, advertRepeat, openList, ADVERT_REPEAT_MS, stop, act, run, push, stream, poll, noteRooms, freshRooms, lobby, publicView, meView, getTable, tableForRoom,
  loadSettings, setSetting, FRONTS, frontOf, frontPath, isSiteAdmin, fairRecord, tickOnce, ipHash, locked, ensure, HELP, link, fairLink,
};
