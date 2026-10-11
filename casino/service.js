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

// ── the rules (Pepe's BJ_* constants) ──
const C = {
  MIN_BET: 100, MAX_BET: 10000, MAX_SEATS: 6, DECKS: 6,
  OPEN_SECS: 30, BET_SECS: 10, INS_SECS: 18, ACT_SECS: 30,
  MISS_LIMIT: 3, AFK_LIMIT: 3, COVER_MULT: 2,
  MAX_TABLES: 4, LOG_KEEP: 40, EVENT_KEEP_MS: 48 * 3600 * 1000, ROOM_FRESH_MS: 90 * 1000,
  CLOSED_LINGER_MS: 30 * 1000, TICK_MS: 250,
};
const HIGH_ROLLER = "high roller";
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");
const now = () => Date.now();

const S = {
  tables: new Map(),           // id -> table (open, plus closed ones lingering for the page)
  rooms: new Map(),            // room id -> {id, name, ts}: rooms Pepe serves with the backend on (his poll heartbeat)
  waiters: new Set(),          // pending long-polls
  settings: { bj_enabled: null, max_tables: C.MAX_TABLES },
  settingsAt: 0,
  tick: null,
  booted: null,
  lastSeq: 0,
  hooks: { now },              // tests override the clock
  rate: new Map(),             // uid -> [timestamps]
};
const clock = () => S.hooks.now();

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

// ── settings (casino_settings; tools/casino-settings.js) ──
async function loadSettings(force) {
  if (!force && clock() - S.settingsAt < 10000 && S.settings.bj_enabled !== null) return S.settings;
  await ensure();
  const rows = await getQuery("SELECT key, value FROM casino_settings");
  const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  S.settings = {
    // default: on for staging, off for prod
    bj_enabled: kv.bj_enabled === undefined ? !!process.env.STAGING : kv.bj_enabled === "1",
    max_tables: Number.isFinite(Number(kv.max_tables)) && Number(kv.max_tables) > 0 ? Math.min(20, Number(kv.max_tables)) : C.MAX_TABLES,
  };
  S.settingsAt = clock();
  return S.settings;
}
async function setSetting(key, value, actor) {
  if (!["bj_enabled", "max_tables"].includes(key)) throw new Error("unknown setting");
  await ensure();
  const v = key === "bj_enabled" ? (value === true || value === "1" || value === "on" || value === "true" ? "1" : "0")
                                 : String(Math.max(1, Math.min(20, Math.trunc(Number(value)) || C.MAX_TABLES)));
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
  const data = Object.assign({ text: text || "" }, extra || {});
  const r = await runQuery("INSERT INTO casino_events (table_id, room, ts, kind, data) VALUES (?, ?, ?, ?, ?)",
                           [T.id, T.room || null, ts, kind, JSON.stringify(data)]);
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
function newTableObject(host, room) {
  const id = crypto.randomBytes(5).toString("hex");
  return {
    id, game: "bj", status: "open", room: room || null, host: { uid: host.uid, name: host.name }, created: clock(),
    client_seed: fair.newClientSeed(), eng: E.newTable({ numDecks: C.DECKS, minBet: C.MIN_BET, maxBet: C.MAX_BET, hitSoft17: true }),
    players: {}, escrowed: {}, autobet: [], lastbet: {}, pending: {}, missed: {}, afk: {}, hr: {},
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
    const hr = !!T.hr[uid];
    const amt = hr ? amt0 : Math.min(amt0, T.eng.max_bet);
    if (!T.eng.seats.includes(uid) || amt < T.eng.min_bet || !p) continue;
    if (!(await cover(T, amt)).ok) continue;
    const r = await stake(T, uid, amt, "bet", "blackjack bet", () => {
      E.placeBet(T.eng, uid, p.name, amt, hr);
      T.lastbet[uid] = amt;
    });
    await emit(T, "line", r.ok ? `✅ ${p.name} is in for ${fmt(amt)}.` : `⚠️ ${p.name}'s queued bet didn't go through — ${r.msg}.`);
  }
  T.pending = {};
  const secs = first ? C.OPEN_SECS : C.BET_SECS;
  T.dl.bet = clock() + secs * 1000;
  const ab = T.autobet.length && !first ? " (autobet players are in automatically)" : "";
  await emit(T, "betting", `🃏 Betting open — !bet ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}. Dealing in ${secs}s (or !bj deal).${ab}`,
             { round_no: n, commitment: T.round.commitment, secs });
  await save(T);
}

async function placeAutobets(T) {
  for (const uid of T.autobet.slice()) {
    if (!T.eng.seats.includes(uid)) { T.autobet = T.autobet.filter((k) => k !== uid); continue; }
    if (uid in T.eng.bets) continue;
    const hr = !!T.hr[uid];
    const amt = hr ? (T.lastbet[uid] || 0) : Math.min(T.lastbet[uid] || 0, T.eng.max_bet);
    const p = T.players[uid];
    if (!p || amt < T.eng.min_bet) continue;
    if (!(await cover(T, amt)).ok) continue;
    const r = await stake(T, uid, amt, "bet", "blackjack autobet", () => E.placeBet(T.eng, uid, p.name, amt, hr));
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
  if (S.hooks.crash === "settle") throw new Error("test crash mid-settle");          // tests only
  const net = lostTotal - profit;
  await emit(T, "settle", `🏁 Pepe ${d.value}${dtag} — ` + summ.join(" | "), {
    round_no: n, dealer: d,
    results: ev.results.map((r) => ({ name: r.name, camfrog: (T.players[r.key] || {}).camfrog || null, total_bet: r.total_bet,
                                      total_payout: r.total_payout, hands: r.hands.map((h) => ({ outcome: h.outcome, bet: h.bet, is_bj: h.is_bj })) })),
  });
  if (net) await emit(T, "line", `🏦 House ${net > 0 ? "wins" : "pays out"} ${fmt(Math.abs(net))} PAT this round ${net > 0 ? "into" : "from"} the casino jackpot.`);
  // the last round on the felt, and the reveal
  T.last_round = {
    round_no: n, dealer: d,
    players: ev.results.map((r) => ({ name: r.name, net: r.total_payout - r.total_bet, total_bet: r.total_bet, total_payout: r.total_payout,
      insurance: r.insurance, hands: r.hands.map((h) => ({ cards: h.cards, value: h.value, bet: h.bet, payout: h.payout,
      net: h.payout - h.bet, outcome: h.outcome, is_bj: h.is_bj, doubled: h.doubled, split: h.from_split })) })),
  };
  await runQuery("UPDATE casino_rounds SET server_seed = ?, shoe = ?, results = ?, revealed = ? WHERE table_id = ? AND round_no = ?",
                 [T.round.seed, JSON.stringify(T.eng.shoe), JSON.stringify(T.last_round), clock(), T.id, n]);
  await emit(T, "reveal", "", { round_no: n, commitment: T.round.commitment, server_seed: T.round.seed, client_seed: T.client_seed });
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
  // housekeeping: old events
  if (Math.random() < 0.002) runQuery("DELETE FROM casino_events WHERE ts < ?", [clock() - C.EVENT_KEEP_MS]).catch(() => {});
}

// ── boot & recovery ──
async function recover(T) {
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
  wake();
}

// ── the commands (one per verb; the same for web and room players) ──
// actor: {uid, name, username, camfrog, via: "web"|"room", iph, admin}
// quiet: the room already sees it as a public line - Pepe doesn't @-reply it (the web shows it as a status)
const R = (ok, reply, extra) => Object.assign({ ok, reply }, extra || {});

async function cmdStart(actor, room) {
  const st = await loadSettings();
  if (!st.bj_enabled) return R(false, "🂠 Blackjack on the site is switched off right now.");
  const open = Array.from(S.tables.values()).filter((t) => t.status === "open");
  if (room && open.some((t) => t.room === room)) return R(false, "a blackjack table is already open — !bet to play.");
  if (open.length >= st.max_tables) return R(false, `the casino has ${open.length} tables open already — join one at /casino/blackjack.`);
  const T = newTableObject(actor, room);
  S.tables.set(T.id, T);
  await save(T);
  await emit(T, "opened", `🂠 ${actor.name} opened a Blackjack table — Pepe deals! 6-deck shoe, blackjack pays 3:2, dealer hits soft 17. ` +
             `Bets ${fmt(C.MIN_BET)}–${fmt(C.MAX_BET)} PAT.`, { client_seed: T.client_seed });
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
                           camfrog: actor.camfrog || prev.camfrog || null, via: actor.via || prev.via || "web", iph: actor.iph || prev.iph || null };
}

async function cmdBet(T, actor, amount) {
  amount = Math.trunc(Number(String(amount == null ? "" : amount).replace(/,/g, "")));
  if (!Number.isFinite(amount) || amount <= 0) return R(false, `usage: !bet <amount>  (${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)})`);
  const bad = await seatChecks(T, actor);
  if (bad) return R(false, bad);
  const hr = await isHighRoller(actor.uid);
  T.hr[actor.uid] = hr;
  if (amount < T.eng.min_bet || (amount > T.eng.max_bet && !hr)) {
    return R(false, `bet must be ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)} (High Rollers have no cap — see !prizes).`);
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
    E.placeBet(T.eng, actor.uid, p.name, amount, hr);
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
  const hr = await isHighRoller(actor.uid);
  T.hr[actor.uid] = hr;
  let amount = null;
  if (arg && !["on", "yes"].includes(arg)) {
    amount = Math.trunc(Number(arg));
    if (!Number.isFinite(amount) || amount <= 0) return R(false, "usage: !autobet [amount|off]");
    if (amount < T.eng.min_bet || (amount > T.eng.max_bet && !hr)) return R(false, `autobet amount must be ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)} (High Rollers have no cap).`);
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
  let msg = `🂠 Blackjack ${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)} — ${T.eng.phase}. Players: ` + (seats.join(", ") || "none");
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

/** Run one command on a table (or open one). verb + args as typed after !bj. -> {ok, reply, table?} */
async function run(actor, verb, args, opts) {
  opts = opts || {};
  verb = String(verb || "").toLowerCase();
  const alias = { open: "start", new: "start", go: "deal", wager: "bet", auto: "autobet", rebet: "autobet", close: "end", stop: "end",
                  quit: "leave", insure: "insurance", stay: "stand", dd: "double", table: "status", info: "status", show: "status",
                  rules: "help", how: "help", "": "status" };
  verb = alias[verb] !== undefined ? alias[verb] : verb;
  if (verb === "help") return R(true, HELP);
  if (actor.uid && !rateOk(actor.uid)) return R(false, "slow down a little.");
  if (["start", "bet", "autobet"].includes(verb)) {
    const u = await userRow(actor.uid);
    if (u && u.casino_banned) return R(false, "🚫 you're banned from the casino.");
  }
  if (verb === "start") return cmdStart(actor, opts.room || null);
  const T = opts.table ? S.tables.get(opts.table) : null;
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
    case "status": return R(true, statusText(T));
    case "end": return cmdEnd(T, actor);
    default: return R(false, "unknown !blackjack option — try: start, bet, hit, stand, double, split, status.");
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

/** Push a table to a Camfrog room (or back to web-only with room = null). Host or admin. */
async function push(tableId, room, actor) {
  await boot();
  return locked(async () => {
    const T = S.tables.get(tableId);
    if (!T || T.status !== "open") return R(false, "That table has closed.");
    if (actor.uid !== T.host.uid && !actor.admin) return R(false, "Only the table's host or an admin can move it.");
    if (room) {
      const r = S.rooms.get(room);
      if (!r || clock() - r.ts > C.ROOM_FRESH_MS) return R(false, "Pepe isn't in that room with the casino on right now.");
      if (Array.from(S.tables.values()).some((t) => t.status === "open" && t.room === room && t.id !== T.id)) return R(false, "That room already has a blackjack table.");
      T.room = room;
      await emit(T, "pushed", `🂠 A Blackjack table from publicaccess.tv is now playing in this room — hosted by ${T.host.name}. ` +
                 `!bet <amount> to sit in (${fmt(T.eng.min_bet)}–${fmt(T.eng.max_bet)}).`, { room_name: r.name });
    } else {
      const was = T.room;
      await emit(T, "unpushed", "🂠 This blackjack table went back to the website — play on at publicaccess.tv/casino/blackjack.");
      T.room = null;
      if (!was) return R(true, "It was already web-only.");
    }
    await save(T);
    return R(true, room ? "Announced in the room." : "The table is web-only now.");
  });
}

// ── views ──
function publicView(T) {
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
    room: T.room, room_name: room ? room.name : T.room, host: T.host.name, round_no: e.round_no,
    min_bet: e.min_bet, max_bet: e.max_bet, max_seats: C.MAX_SEATS, decks: e.num_decks, act_secs: C.ACT_SECS,
    client_seed: T.client_seed, commitment: T.round ? T.round.commitment : null, commit_round: T.round ? T.round.no : null,
    dealer, seats, turn, bet_deadline: T.dl.bet, ins_deadline: T.dl.ins,
    last_round: ["betting", "idle", "done"].includes(e.phase) || T.status === "closed" ? T.last_round : null,
    log: T.log.slice(-20),
  };
}

async function meView(T, uid) {
  if (!uid) return null;
  const u = await userRow(uid);
  if (!u) return null;
  const e = T ? T.eng : null;
  const cur = e ? E.currentHand(e) : null;
  return {
    name: u.displayname || u.username, balance: Number(u.points_balance) || 0, banned: !!u.casino_banned, admin: u.class === "Admin",
    high_roller: await isHighRoller(uid),
    seat: T && e.seats.includes(uid) ? uidHash(uid) : null,
    host: !!T && T.host.uid === uid,
    bet: e ? e.bets[uid] || 0 : 0, pending: T ? T.pending[uid] || 0 : 0, autobet: !!T && T.autobet.includes(uid),
    lastbet: T ? T.lastbet[uid] || 0 : 0, my_turn: !!cur && cur.key === uid,
    can_insure: !!e && e.phase === "insurance" && (e.bets[uid] || 0) > 0 && !(uid in e.insurance),
  };
}

function lobby() {
  return Array.from(S.tables.values()).filter((t) => t.status === "open").map((T) => {
    const room = T.room ? S.rooms.get(T.room) : null;
    return { id: T.id, host: T.host.name, phase: T.eng.phase, players: T.eng.seats.length, max_seats: C.MAX_SEATS,
             min_bet: T.eng.min_bet, max_bet: T.eng.max_bet, room: T.room, room_name: room ? room.name : T.room, round_no: T.eng.round_no };
  });
}

const getTable = (id) => S.tables.get(id) || null;
const tableForRoom = (room) => Array.from(S.tables.values()).find((t) => t.status === "open" && t.room === room) || null;

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

/** Events after `after` for tables in a room (Pepe's), waiting up to waitMs for the first one. */
async function poll(after, waitMs) {
  await boot();
  // a client with no cursor yet (or one from another database - a staging refresh) starts from now: no replay
  if (Number(after) < 0 || Number(after) > S.lastSeq) {
    const tables = {};
    for (const T of S.tables.values()) if (T.room) tables[T.id] = publicView(T);
    return { cursor: S.lastSeq, events: [], tables };
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
  const tables = {};
  for (const T of S.tables.values()) if (T.room) tables[T.id] = publicView(T);
  return { cursor: events.length ? events[events.length - 1].seq : Math.max(after, S.lastSeq), events, tables };
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

module.exports = {
  C, S, boot, stop, act, run, push, poll, noteRooms, freshRooms, lobby, publicView, meView, getTable, tableForRoom,
  loadSettings, setSetting, fairRecord, tickOnce, ipHash, locked, ensure, HELP,
};
