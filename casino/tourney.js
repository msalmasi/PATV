// casino/tourney.js — 🏁 Sit & Go tournaments for Hold'em (hand-off 22, phase 1, 1.99alz; docs/casino-backend.md "Sit & Go").
//
// A sit & go IS one Hold'em table (casino/holdem.js, game "holdem") with a `tourney` block on it, so the table page, the action bar,
// pre-moves, the time bank, the stream slot, Pepe's poll + OBS board, the veil masks and the fairness proofs work as at a cash table.
// What is the tournament's own (this file):
//   * REGISTRATION: the creator picks the seats (2-9), the buy-in (a fixed list: casino_settings sng_buyins), turbo and "start at N"
//     (N >= 2: a 60 s countdown once N are in), and is registered. It starts when full (or when the countdown runs out); nobody
//     registers after the start (no late registration, rebuys or add-ons in phase 1). Leaving before the start refunds in full. One
//     that hasn't started REG_MINS after it opened is called off, every entry refunded.
//   * THE MONEY: an entry = ONE escrow hold of buy-in + fee (kind TNY, a site service's - escrow/ledger.js SERVICE_KINDS - never
//     Pepe's), refused when the wallet can't cover it; leaving / an admin's cancel / the call-off = refundInTx (in full, the fee too);
//     the finish = ONE settleInTx: the prizes to the finishers + one fee leg ["jackpot", fee x entrants] to the House, paying out
//     exactly what is held (never less: settleInTx would keep the rest). Each move is ONE dbUtils.tx together with its escrow_moves
//     journal row (seen / record, keyed tny:<table>:<user>:enter:<n> / :refund:<n>, tny:<table>:finish, tny:<table>:cancel) and the
//     table's own saved state (service save): the PAT and the state that says it moved commit or roll back together.
//   * TOURNAMENT CHIPS are not PAT: SNG.STACK each, no buy-in, no cash-out, no rake, never an idle / host close.
//   * THE CLOCK: the level table (sng_levels, then x1.5 rounded) at sng_level_mins a level (turbo: sng_turbo_mins), applied between
//     hands only. Absolute while the site runs; a restart gives the running level (and a countdown / the registration hour) the time it
//     had left at the table's last save - the clock pauses while no hand can be dealt, the site being down included.
//   * BUST-OUTS: a player out of chips is placed - several on one hand: the bigger stack at the start of that hand places higher; equal
//     starting stacks share their places' prizes, rounded down, the odd PAT one each to the higher places in the hand's odd-chip order
//     (clockwise from the button: the engine's own rule for a split pot) - stood up with no cash-out, and gets a room line.
//   * SITTING OUT = being blinded away: a seat sitting out when a hand is dealt is dealt in and checks or folds at once; a tournament seat
//     is never stood up (the cash tables' sit-out limit and idle close never reach it). !sitout during a hand starts with the next one
//     (that hand is still the player's, as at a cash table), and a seat that is out never spends its time bank (review).
//   * THE BUTTON moves on clockwise when the button busts (afterHand moves it back to the nearest seat still in before the busted seat
//     goes; hmengine.stand drops a stood-up button and startHand would give it to the first seat - the blinds would jump back).
//   * A RESTART resumes from the saved state (recover): a hand's bust-outs are placed again from the start stacks saved when it was
//     dealt (the places are idempotent), a pending payout re-runs under its one key (seen = done: nothing pays twice). A running
//     sit & go between hands with nothing scheduled, or with one stack left (a hand's wrap-up threw part-way), is wrapped up again by
//     the tick (tick -> "wrap": holdem.js wrapUp; once a minute while it keeps failing) - restart or not.
//   * CREATE is idempotent per act key (casino_actions) and, past that, a create by the same account for the same sit & go within
//     DUP_MS of opening one (a reply lost to a restart, a double click) answers with that one instead of opening a second.
//   * SWITCHED OFF (or staff only, for a member): !sng / help / info say so (an entrant still sees theirs; leaving always works).
// Rewards: a sit & go hand earns no casino achievements / drops / win XP / gang rep (service.js hmRewards) - tournament prizes are the
// payout. Ships dark: casino_settings casino_sng off | staff | everyone (default off); Hold'em on the site (hm_enabled) must be on too.
// Phase 2 (scheduled multi-table tournaments, guarantees after H2b) is not here.
"use strict";
const H = require("./hmengine");
const V = require("./veil");
const { amt } = require("./holdem");

const SNG = Object.freeze({ STACK: 1500, MIN_SEATS: 2, MAX_SEATS: 9, COUNTDOWN_SECS: 60, REG_MINS: 60, LINGER_MS: 15 * 60e3, MAX_OPEN_PER: 3,
                            RETRY_MS: 60e3, DUP_MS: 120e3, BANDS: Object.freeze([[2, 3], [4, 6], [7, 9]]) });
const AUDIENCES = Object.freeze(["off", "staff", "everyone"]);
const DEFAULTS = Object.freeze({
  casino_sng: "off", sng_fee_pct: 10, sng_buyins: "1000,5000,25000,100000", sng_payouts: "100|65,35|50,30,20",
  sng_levels: "10/20,15/30,25/50,50/100,75/150,100/200,150/300,200/400,300/600,400/800,600/1200,800/1600,1000/2000",
  sng_level_mins: 5, sng_turbo_mins: 3,
});
const SETTING_KEYS = Object.freeze(Object.keys(DEFAULTS));

// ── the settings (pure: service.js loadSettings / setSetting) ──
const intIn = (v, lo, hi) => { const s = String(v == null ? "" : v).trim(); if (!/^\d+$/.test(s)) return null; const n = Number(s); return n >= lo && n <= hi ? n : null; };
/** "1000,5000,25k" -> [1000, 5000, 25000] (1-8 whole buy-ins of 100..1e9 PAT, ascending, no repeats) | null */
function parseBuyins(v) {
  const parts = String(v == null ? "" : v).split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 8) return null;
  const out = parts.map((x) => amt(x));
  if (out.some((n) => !Number.isSafeInteger(n) || n < 100 || n > 1e9)) return null;
  const s = Array.from(new Set(out)).sort((a, b) => a - b);
  return s.length === out.length ? s : null;
}
/** "100|65,35|50,30,20" -> [[100], [65, 35], [50, 30, 20]]: one list per field band (2-3, 4-6, 7-9), whole percentages, highest
 *  first, summing to 100, never more places than the band's smallest field | null */
function parsePayouts(v) {
  const bands = String(v == null ? "" : v).split("|").map((b) => b.trim());
  if (bands.length !== SNG.BANDS.length) return null;
  const out = [];
  for (let i = 0; i < bands.length; i++) {
    const ps = bands[i].split(",").map((x) => intIn(x, 1, 100));
    if (!ps.length || ps.length > SNG.BANDS[i][0] || ps.some((p) => p === null)) return null;
    if (ps.some((p, j) => j > 0 && p > ps[j - 1])) return null;
    if (ps.reduce((a, b) => a + b, 0) !== 100) return null;
    out.push(ps);
  }
  return out;
}
/** "10/20,15/30,..." -> [[10, 20], [15, 30], ...] (1-40 levels, 1 <= sb < bb, the big blind rising every level) | null */
function parseLevels(v) {
  const parts = String(v == null ? "" : v).split(",").map((x) => x.trim()).filter(Boolean);
  if (!parts.length || parts.length > 40) return null;
  const out = [];
  for (const p of parts) {
    const m = /^(\d+)\/(\d+)$/.exec(p);
    if (!m) return null;
    const sb = Number(m[1]), bb = Number(m[2]);
    if (!(sb >= 1 && sb < bb && bb <= 1e9)) return null;
    if (out.length && (bb <= out[out.length - 1][1] || sb < out[out.length - 1][0])) return null;
    out.push([sb, bb]);
  }
  return out;
}
/** a setting's stored text, normalised, or throws (the admin sees the message) */
function checkSetting(key, value) {
  const v = String(value == null ? "" : value).trim();
  if (key === "casino_sng") { if (!AUDIENCES.includes(v)) throw new Error("Sit & Go: off, staff or everyone"); return v; }
  if (key === "sng_fee_pct") { const n = intIn(v, 0, 50); if (n === null) throw new Error("the Sit & Go fee is a whole percentage, 0-50"); return String(n); }
  if (key === "sng_buyins") { const l = parseBuyins(v); if (!l) throw new Error("buy-ins: 1-8 different whole amounts of 100 PAT or more, comma-separated"); return l.join(","); }
  if (key === "sng_payouts") {
    const p = parsePayouts(v);
    if (!p) throw new Error("payouts: three lists for 2-3 | 4-6 | 7-9 players (e.g. 100|65,35|50,30,20), each highest first and summing to 100");
    return p.map((b) => b.join(",")).join("|");
  }
  if (key === "sng_levels") { const l = parseLevels(v); if (!l) throw new Error("levels: sb/bb pairs, comma-separated, the big blind rising every level"); return l.map((x) => x.join("/")).join(","); }
  if (key === "sng_level_mins" || key === "sng_turbo_mins") { const n = intIn(v, 1, 60); if (n === null) throw new Error("level minutes: 1-60"); return String(n); }
  throw new Error("unknown setting");
}
/** the casino_settings rows -> the Sit & Go settings (a bad stored value reads as its default) */
function readSettings(kv) {
  const out = {};
  for (const k of SETTING_KEYS) {
    let v;
    try { v = kv[k] === undefined || kv[k] === null ? String(DEFAULTS[k]) : checkSetting(k, kv[k]); } catch (e) { v = String(DEFAULTS[k]); }
    out[k] = typeof DEFAULTS[k] === "number" ? Number(v) : v;
  }
  return out;
}
function config(st) {
  return { buyins: parseBuyins(st.sng_buyins) || parseBuyins(DEFAULTS.sng_buyins), fee_pct: Number.isInteger(st.sng_fee_pct) ? st.sng_fee_pct : DEFAULTS.sng_fee_pct,
           payouts: parsePayouts(st.sng_payouts) || parsePayouts(DEFAULTS.sng_payouts), levels: parseLevels(st.sng_levels) || parseLevels(DEFAULTS.sng_levels),
           level_mins: st.sng_level_mins || DEFAULTS.sng_level_mins, turbo_mins: st.sng_turbo_mins || DEFAULTS.sng_turbo_mins };
}

// ── pure arithmetic ──
/** after the level table: each big blind x1.5, rounded to its two leading digits (2,000 -> 3,000 -> 4,500 -> 6,800 -> 10,000), sb = bb / 2 */
function niceUp(bb) {
  const x = bb * 1.5;
  const unit = Math.pow(10, Math.max(0, Math.floor(Math.log10(x)) - 1));
  const r = Math.round(x / unit) * unit;
  return r > bb ? r : bb + unit;
}
/** the [sb, bb] of level i (0-based) of a sit & go's snapshot */
function levelAt(t, i) {
  const L = t.levels;
  if (i < L.length) return L[i];
  let bb = L[L.length - 1][1];
  for (let j = L.length - 1; j < i; j++) bb = niceUp(bb);
  return [Math.max(1, Math.floor(bb / 2)), bb];
}
const bandFor = (payouts, n) => payouts[Math.max(0, SNG.BANDS.findIndex(([lo, hi]) => n >= lo && n <= hi))];
/** the prize of each paid place: floor(pool x pct / 100), whatever that leaves over (< a PAT per place) to 1st - always sums to the pool */
function prizeTable(pool, pcts) {
  const out = pcts.map((p) => Math.floor((pool * p) / 100));
  out[0] += pool - out.reduce((a, b) => a + b, 0);
  return out;
}
const ord = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const kShort = (n) => (n >= 1e6 && n % 1e5 === 0 ? `${n / 1e6}M` : n >= 1e3 && n % 100 === 0 ? `${n / 1e3}K` : String(n));
const mmss = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

function install(core) {
  const { S, clock, save, emit, userRow, R, fmt, link, roomsOf, roomList, streamGone, runQuery, loadSettings, HM } = core;
  const ESC = () => require("../escrow/ledger");
  const SP = () => require("../siteperms");
  const dbTx = (fn) => require("../dbUtils").tx(fn);
  const NEXT_SECS = HM.HC.NEXT_SECS;
  const isSng = (T) => !!(T && T.game === "holdem" && T.tourney && (T.tourney.kind || "sng") === "sng");   // (h22 phase 2: never a scheduled tournament's table)
  const open = () => Array.from(S.tables.values()).filter((T) => isSng(T) && T.status === "open");
  const short = (T) => T.id.slice(0, 6);
  const refOf = (T) => `TNY-${T.id}`;
  const entrantOf = (T, uid) => T.tourney.entrants.find((x) => x.uid === String(uid)) || null;
  const placedOf = (T, uid) => T.tourney.places.find((p) => p.uid === String(uid)) || null;
  const realName = (T, uid, fb) => ((T.players[uid] || {}).name || fb || "someone");
  const lobbyUrl = () => link({ id: "x", game: "holdem" }).replace(/\/t\/x$/, "");
  const isStaff = (u) => { try { return SP().atLeast(u, "staff") || SP().can(u, "casino.admin"); } catch (e) { return false; } };
  const isAdmin = (u) => { try { return SP().can(u, "casino.admin"); } catch (e) { return false; } };
  const prizeText = (prizes) => prizes.map((p, i) => `${ord(i + 1)} ${fmt(p)}`).join(" · ") + " PAT";
  /** registrations of `uid` in sit & gos that haven't started */
  const openFor = (uid) => open().filter((T) => T.tourney.status === "registering" && entrantOf(T, uid)).length;
  // (review) a start-at-N countdown that is running (N are in) finishes before the registration hour's call-off
  const counting = (t) => !!(t.countdown_at && t.start_at && t.entrants.length >= t.start_at);
  // (review) a running sit & go between hands with nothing scheduled - or one stack left - is wrapped up again (a hand's wrap-up threw
  // part-way: a failed write after its proof). wrapAt: not before (ms) - once a minute while it keeps failing; never saved.
  const wrapAt = new Map();
  const stalled = (T, now) => {
    const e = T.eng;
    return !e.hand_active && !T.dl.turn && (!T.dl.next || H.seatedWithChips(e).length <= 1) && !((wrapAt.get(T.id) || 0) > now);
  };
  async function prep() { await ESC().init(); await require("../ledger").ensure(); }
  function closeState(T) {
    T.status = "closed";
    T.closed_at = clock();
    T.dl = { turn: null, next: null, idle: null };
    T.turn = null;
  }
  const keep = (T) => JSON.stringify({ tourney: T.tourney, host: T.host, status: T.status, closed_at: T.closed_at, dl: T.dl, turn: T.turn });
  function restore(T, snap) { Object.assign(T, JSON.parse(snap)); }

  /** who may enter now (null = yes): Hold'em on the site + the switch (+ staff), an account, not casino-banned */
  async function gate(actor) {
    const st = await loadSettings();
    if (!st.hm_enabled) return "🃏 Hold'em on the site is switched off right now.";
    if ((st.casino_sng || "off") === "off") return "🏁 Sit & Gos are switched off right now.";
    const u = await userRow(actor.uid);
    if (!u) return "no account found";
    if (u.casino_banned) return "🚫 you're banned from the casino.";
    if (st.casino_sng === "staff" && !isStaff(u)) return "🏁 Sit & Gos are open to staff only for now.";
    return null;
  }

  /** (review) null = Sit & Gos are on for this actor; else why not - the switch, staff only, Hold'em off (list / help / info say so) */
  async function shut(actor) {
    const st = await loadSettings();
    if (!st.hm_enabled) return "🃏 Hold'em on the site is switched off right now.";
    const aud = st.casino_sng || "off";
    if (aud === "off") return "🏁 Sit & Gos are switched off right now.";
    if (aud === "staff") {
      const u = actor && actor.uid ? await userRow(actor.uid) : null;
      if (!u || !isStaff(u)) return "🏁 Sit & Gos are open to staff only for now.";
    }
    return null;
  }

  function remember(T, actor) {
    const uid = String(actor.uid), prev = T.players[uid] || {};
    T.players[uid] = { name: actor.name || prev.name || actor.username, username: actor.username || prev.username || null,
                       camfrog: actor.camfrog || prev.camfrog || null, via: actor.via || prev.via || "web", iph: actor.iph || prev.iph || null,
                       room: actor.room || prev.room || null };
    V.enter(T, actor);              // a veiled entrant is masked before any line names them (seated at the start)
  }

  // ── the entry: hold + journal + the table's state, one transaction ──
  async function enter(T, actor) {
    const t = T.tourney, uid = String(actor.uid);
    const amount = t.buyin + t.fee;
    const gen = (t.gens[uid] || 0) + 1;
    const key = `tny:${T.id}:${uid}:enter:${gen}`, ref = refOf(T);
    await prep();
    const snap = keep(T), prevP = T.players[uid] ? JSON.stringify(T.players[uid]) : null;
    try {
      await dbTx(async () => {
        if (await ESC().seen(key)) throw Object.assign(new Error("key seen"), { code: "E_SEEN" });
        const account = await ESC().accountFor({ userId: uid });
        const h = await ESC().holdInTx({ key, hid: null, account, amount, ref, reason: "sit & go entry", cp: `sit & go ${short(T)}`, via: "site", casino: true });
        t.gens[uid] = gen;
        remember(T, actor);
        t.entrants.push({ uid, name: T.players[uid].name, gen, hid: h.hid, amount, at: clock() });
        await save(T);
        await ESC().record(key, { op: "hold", ref, amount, via: "casino", result: { ok: true, hid: h.hid } });
      });
    } catch (e) {
      restore(T, snap);
      if (prevP) T.players[uid] = JSON.parse(prevP); else delete T.players[uid];
      if (e && e.code === "E_SEEN") { T.tourney.gens[uid] = gen; return R(false, "that didn't go through — try again."); }
      if (e && e.code === "E_INSUFFICIENT_PAT") {
        const u = await userRow(uid);
        return R(false, `can't register: insufficient PAT (need ${fmt(amount)}, you have ${fmt(u ? u.points_balance : 0)})`);
      }
      if (e && e.code === "E_CASINO_BANNED") return R(false, "🚫 you're banned from the casino.");
      console.error(`[casino] sit & go ${T.id}: entry for ${uid} failed:`, e && e.message ? e.message : e);
      return R(false, "can't register right now — nothing was charged.");
    }
    return R(true, "ok");
  }

  // ── create / register / unregister ──
  const USAGE = (c) => `usage: !sng new <seats 2-9> <buy-in: ${c.buyins.map(kShort).join(" / ")}> [turbo] [at N]  e.g. !sng new 6 ${kShort(c.buyins[0])}`;
  function parseNew(args, c) {
    const toks = (args || []).map((x) => String(x == null ? "" : x).trim().toLowerCase()).filter(Boolean);
    let size = null, buyin = null, turbo = false, at = null;
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      let m;
      if (tk === "turbo") { turbo = true; continue; }
      if (tk === "at" || tk === "@") { const n = toks[++i]; at = /^\d+$/.test(n || "") ? Number(n) : NaN; continue; }
      if ((m = /^(?:at|@)=?(\d+)$/.exec(tk))) { at = Number(m[1]); continue; }
      if (size === null && (m = /^(\d)(?:-?max|-?seats?)?$/.exec(tk))) { size = Number(m[1]); continue; }
      if (buyin === null && Number.isFinite(amt(tk))) { buyin = amt(tk); continue; }
      return { error: USAGE(c) };
    }
    if (size === null || buyin === null) return { error: USAGE(c) };
    if (size < SNG.MIN_SEATS || size > SNG.MAX_SEATS) return { error: `a Sit & Go has ${SNG.MIN_SEATS}-${SNG.MAX_SEATS} seats.` };
    if (!c.buyins.includes(buyin)) return { error: `the buy-in is one of ${c.buyins.map(fmt).join(", ")} PAT.` };
    if (at !== null && !(Number.isInteger(at) && at >= SNG.MIN_SEATS && at <= size)) return { error: `"at N" starts it once N are in: 2 to ${size}.` };
    return { size, buyin, turbo, at: at === size ? null : at };
  }

  async function create(actor, args, room) {
    const bad = await gate(actor);
    if (bad) return R(false, bad);
    const st = await loadSettings();
    const c = config(st);
    const p = parseNew(args, c);
    if (p.error) return R(false, p.error);
    // (review) the same create again by the same account within DUP_MS (its reply lost to a restart, a double click - under a new key
    // casino_actions can't see it) is the one just opened: never a second sit & go, never a second hold
    const dup = open().find((x) => x.tourney.status === "registering" && String(x.host.uid) === String(actor.uid) && entrantOf(x, actor.uid) &&
                                   x.tourney.size === p.size && x.tourney.buyin === p.buyin && !!x.tourney.turbo === !!p.turbo &&
                                   (x.tourney.start_at || null) === (p.at || null) && clock() - x.tourney.created < SNG.DUP_MS);
    if (dup) return R(true, `🏁 you opened this Sit & Go a moment ago — you're registered (#${short(dup)}): ${link(dup)}`, { table: dup.id });
    const tables = Array.from(S.tables.values()).filter((x) => x.status === "open" && !(x.tourney && x.tourney.kind === "mtt"));   // (h22 phase 2: MTT tables don't count)
    if (room && tables.some((x) => roomsOf(x).includes(room))) return R(false, "a table is already open here — finish it first, or open the sit & go on the web.");
    if (st.max_tables > 0 && tables.length >= st.max_tables) return R(false, `the casino has ${tables.length} tables open already.`);
    if (openFor(actor.uid) >= SNG.MAX_OPEN_PER) return R(false, `you're in ${SNG.MAX_OPEN_PER} sit & gos that haven't started yet — that's the most at once.`);
    const T = HM.newTable(actor, room, c.levels[0][0], c.levels[0][1], false, { tourney: true });
    const now = clock();
    T.tourney = { v: 1, id: T.id, status: "registering", size: p.size, start_at: p.at, turbo: p.turbo, buyin: p.buyin, fee: Math.floor((p.buyin * c.fee_pct) / 100),
                  fee_pct: c.fee_pct, stack: SNG.STACK, levels: c.levels, level_ms: (p.turbo ? c.turbo_mins : c.level_mins) * 60000, payouts: c.payouts,
                  created: now, expires_at: now + SNG.REG_MINS * 60000, countdown_at: null, entrants: [], gens: {}, field: null, prizes: [],
                  started_at: null, level: 0, level_ends_at: null, hand_start: null, places: [], settle: null, finished_at: null, cancelled: null };
    V.enter(T, actor);
    const r = await enter(T, actor);              // the creator's entry; the table exists only if it went through (same transaction)
    if (!r.ok) return r;
    S.tables.set(T.id, T);
    const t = T.tourney;
    await emit(T, "opened", `🏁 ${T.players[actor.uid].name} opened a ${t.size}-seat Sit & Go — entry ${fmt(t.buyin)} + ${fmt(t.fee)} PAT, ${fmt(t.stack)} chips, ` +
               `blinds up every ${t.level_ms / 60000} min${t.turbo ? " (turbo)" : ""}; starts ${t.start_at ? `at ${t.start_at} players` : "when full"}. ` +
               `!sng join ${short(T)} — or on the web: ${link(T)}`, { client_seed: T.client_seed, url: link(T), sng: "opened" });
    await save(T);
    return R(true, `🏁 Sit & Go open — you're registered (${fmt(t.buyin + t.fee)} PAT held; all of it back if you leave before it starts).`,
             { table: T.id, quiet: !!room });
  }

  async function register(T, actor) {
    const t = T.tourney;
    if (t.status !== "registering") return R(false, t.status === "running" ? "🏁 this sit & go is under way — registration closed when it started." : "🏁 this sit & go is over.", { table: T.id });
    if (entrantOf(T, actor.uid)) return R(true, "you're already registered.", { table: T.id });
    const bad = await gate(actor);
    if (bad) return R(false, bad, { table: T.id });
    if (t.entrants.length >= t.size) return R(false, "it's full.", { table: T.id });
    // the cash tables' entry rule (holdem.js seatChecks) over everyone registered
    const why = await HM.seatChecks(T, actor, t.entrants.map((x) => x.uid), t.size);
    if (why) return R(false, why, { table: T.id });
    if (openFor(actor.uid) >= SNG.MAX_OPEN_PER) return R(false, `you're in ${SNG.MAX_OPEN_PER} sit & gos that haven't started yet — that's the most at once.`, { table: T.id });
    const r = await enter(T, actor);
    if (!r.ok) return Object.assign(r, { table: T.id });
    const tt = T.tourney;
    await emit(T, "line", `📝 ${T.players[String(actor.uid)].name} is in the Sit & Go (${tt.entrants.length}/${tt.size}).`, { sng: "register" });
    await afterEntry(T);
    await save(T);
    const here = actor.via === "room" && actor.room && roomsOf(T).includes(actor.room);
    const where = actor.via === "room" && !here ? ` It plays ${roomsOf(T).length ? "in another room and " : ""}on the web: ${link(T)}` : "";
    // (review) never quiet: the room's line doesn't say what was held - the player hears it (an entry can be a bare !sit at its table)
    return R(true, `you're registered — ${fmt(tt.buyin + tt.fee)} PAT held (all of it back if you leave before it starts).${where}`, { table: T.id });
  }

  async function afterEntry(T) {
    const t = T.tourney, n = t.entrants.length;
    if (n >= t.size) return start(T);
    if (t.start_at && n >= t.start_at && !t.countdown_at) {
      t.countdown_at = clock() + SNG.COUNTDOWN_SECS * 1000;
      await emit(T, "line", `⏳ ${n} in — the Sit & Go starts in ${SNG.COUNTDOWN_SECS} s (or as soon as it's full). !sng join ${short(T)}`, { sng: "countdown" });
    }
    return null;
  }

  async function unregister(T, actor) {
    const t = T.tourney, uid = String(actor.uid);
    const x = entrantOf(T, uid);
    if (!x) return R(false, "you're not registered for this sit & go.", { table: T.id });
    if (t.status !== "registering") return R(false, "🏁 it has started — tournament players can't leave or cash out. !sitout to sit out (you'll be blinded until you're back).", { table: T.id });
    const key = `tny:${T.id}:${uid}:refund:${x.gen}`, ref = refOf(T);
    await prep();
    const snap = keep(T);
    let stopped = false;
    try {
      await dbTx(async () => {
        if (!(await ESC().seen(key))) {
          await ESC().refundInTx({ key, hid: x.hid, reason: "sit & go refund" });
          await ESC().record(key, { op: "refund", ref, amount: x.amount, via: "casino", result: { ok: true, why: "unregister" } });
        }
        t.entrants = t.entrants.filter((e) => e.uid !== uid);
        if (t.countdown_at && t.entrants.length < (t.start_at || Infinity)) { t.countdown_at = null; stopped = true; }
        if (T.host.uid === uid && t.entrants.length) T.host = { uid: t.entrants[0].uid, name: realName(T, t.entrants[0].uid, t.entrants[0].name) };
        if (!t.entrants.length) { t.status = "cancelled"; t.cancelled = { at: clock(), why: "empty", by: null }; closeState(T); }
        await save(T);
      });
    } catch (e) {
      restore(T, snap);
      console.error(`[casino] sit & go ${T.id}: refund for ${uid} failed:`, e && e.message ? e.message : e);
      return R(false, "couldn't unregister right now — your entry is safe; try again.", { table: T.id });
    }
    const name = realName(T, uid, x.name);
    await emit(T, "line", `↩️ ${name} left the Sit & Go — entry refunded (${t.entrants.length}/${t.size}).`, { sng: "unregister" });
    if (stopped) await emit(T, "line", `⏳ Countdown stopped — the Sit & Go waits for ${t.start_at} players.`, { sng: "countdown" });
    if (T.status === "closed") {
      await emit(T, "closed", "🏁 Sit & Go called off — nobody's registered.", { reason: "empty" });
      streamGone(T.id);
    }
    await save(T);
    const here = actor.via === "room" && actor.room && roomsOf(T).includes(actor.room);
    return R(true, `you're out — ${fmt(x.amount)} PAT back.`, { table: T.id, quiet: !!here });
  }

  // ── the start ──
  async function start(T) {
    if (S.hooks.crash === "sng:start") throw new Error("test crash before the start");     // tests only
    const t = T.tourney, e = T.eng;
    const n = t.entrants.length;
    t.status = "running";
    t.field = n;
    t.started_at = clock();
    t.countdown_at = null;
    t.prizes = prizeTable(t.buyin * n, bandFor(t.payouts, n));
    for (const x of t.entrants) H.sit(e, x.uid, realName(T, x.uid, x.name), t.stack);   // registration order; the first seat deals first
    t.level = 0;
    t.level_ends_at = clock() + t.level_ms;
    [e.sb, e.bb] = levelAt(t, 0);
    T.dl = { turn: null, next: clock() + NEXT_SECS * 1000, idle: null };
    T.last_activity = clock();
    await save(T);
    await emit(T, "sng", `🏁 Sit & Go #${short(T)} is on — ${n} players, ${fmt(t.stack)} chips each, blinds ${fmt(e.sb)}/${fmt(e.bb)} going up every ` +
               `${t.level_ms / 60000} min. Prizes: ${prizeText(t.prizes)}. First hand in ${NEXT_SECS} s. ${link(T)}`, { sng: "start" });
    return null;
  }

  // ── the hooks holdem.js calls ──
  /** just before a hand is dealt: the level's blinds, and every stack it starts with (bust-outs are placed by them) */
  function beforeHand(T) {
    const t = T.tourney, e = T.eng;
    [e.sb, e.bb] = levelAt(t, t.level || 0);
    t.hand_start = { no: e.hand_no + 1, stacks: Object.fromEntries(H.seatedWithChips(e).map((k) => [k, e.chips[k]])),
                     // (review) the seats sitting out as it's dealt: only they check / fold at once this hand (!sitout mid-hand = the next one)
                     out: H.seatedWithChips(e).filter((k) => !!(T.qol && T.qol[k] && T.qol[k].out)) };
  }
  /** (review) whether `uid` checks / folds at once in the hand being played: out when it was dealt (or timed out twice since) */
  const outAtDeal = (T, uid) => !!(T.tourney.hand_start && (T.tourney.hand_start.out || []).includes(uid));
  /** (review) two timeouts in a row sat `uid` out mid-hand: away - the rest of this hand checks / folds at once too */
  function outNow(T, uid) {
    const hs = T.tourney.hand_start;
    if (hs && !(hs.out || []).includes(uid)) hs.out = (hs.out || []).concat([uid]);
  }

  /** the busted seats of the hand that just ended -> places (+ their lines); `out` is placed together */
  function placeBatch(T, out) {
    const t = T.tourney, e = T.eng;
    const startStacks = (t.hand_start && t.hand_start.stacks) || {};
    const ring = e.players.length ? e.players : e.seats;
    const bi = ring.indexOf(e.button);
    const oddChip = (k) => { const i = ring.indexOf(k); return i < 0 ? ring.length : (i - bi - 1 + ring.length * 2) % ring.length; };
    const st = (k) => Number(startStacks[k]) || 0;
    const sorted = out.slice().sort((a, b) => st(b) - st(a) || oddChip(a) - oddChip(b));
    let place = H.seatedWithChips(e).length + 1;
    const lines = [];
    for (let i = 0; i < sorted.length;) {
      let j = i;
      while (j < sorted.length && st(sorted[j]) === st(sorted[i])) j++;
      const group = sorted.slice(i, j), n = group.length;
      let pot = 0;
      for (let p = place; p < place + n; p++) pot += t.prizes[p - 1] || 0;
      const share = Math.floor(pot / n), rem = pot - share * n;
      group.forEach((uid, g) => {
        const prize = share + (g < rem ? 1 : 0), name = realName(T, uid, uid);
        t.places.push({ uid, name, shown: V.masked(T, uid) ? V.nameOf(T, uid, name) : null, place: place + g, prize, tied: n > 1 ? [place, place + n - 1] : null, hand: e.hand_no });
        lines.push(`🏁 ${name} finished ${ord(place + g)}${n > 1 ? " (tied on chips)" : ""}${prize ? ` — ${fmt(prize)} PAT` : ""}.`);
      });
      place += n;
      i = j;
    }
    return lines;
  }

  /** a hand is over (holdem.js afterHand, after its proof): place the busted, then the next hand - or the finish */
  async function afterHand(T) {
    if (S.hooks.crash === "sng:place") throw new Error("test crash before the places");     // tests only
    const t = T.tourney, e = T.eng;
    if (t.status !== "running") return save(T);
    const out = e.seats.filter((k) => !((e.chips[k] || 0) > 0) && !placedOf(T, k));
    const lines = out.length ? placeBatch(T, out) : [];
    // (review) a busted button: the button goes back to the nearest seat before it that's still in, so the next hand moves it on
    // clockwise (hmengine.stand drops a stood-up button, and startHand would then give it to the first seat: the blinds jump back)
    if (out.includes(e.button)) {
      const n = e.seats.length, i = e.seats.indexOf(e.button);
      for (let s = 1; s < n; s++) {
        const k = e.seats[(i - s + n) % n];
        if (!out.includes(k) && (e.chips[k] || 0) > 0) { e.button = k; break; }
      }
    }
    for (const k of out) {
      try { H.stand(e, k); } catch (err) { /* not seated */ }
      HM.forgetSeat(T, k);
    }
    t.hand_start = null;
    wrapAt.delete(T.id);
    if (H.seatedWithChips(e).length <= 1) {
      for (const l of lines) await emit(T, "sng", l, { sng: "bust" });
      return finish(T);
    }
    T.dl.next = clock() + NEXT_SECS * 1000;
    await save(T);
    for (const l of lines) await emit(T, "sng", l, { sng: "bust" });
    await save(T);
    return null;
  }

  // ── the finish: ONE settle ──
  function settlePlan(T) {
    const t = T.tourney;
    const held = t.entrants.reduce((s, x) => s + x.amount, 0);
    const payouts = t.places.filter((p) => p.prize > 0).map((p) => ({ userId: p.uid, amount: p.prize, reason: "sit & go prize", cp: `sit & go ${short(T)}` }));
    const fee = t.fee * t.entrants.length;
    return { key: `tny:${T.id}:finish`, ref: refOf(T), hids: t.entrants.map((x) => x.hid), payouts, fee, fees: fee > 0 ? [["jackpot", fee]] : [], held,
             out: payouts.reduce((s, p) => s + p.amount, 0) + fee };
  }
  async function finish(T) {
    const t = T.tourney, e = T.eng;
    for (const w of H.seatedWithChips(e)) {
      if (placedOf(T, w)) continue;
      const name = realName(T, w, w);
      t.places.push({ uid: w, name, shown: V.masked(T, w) ? V.nameOf(T, w, name) : null, place: 1, prize: t.prizes[0] || 0, tied: null, hand: e.hand_no });
    }
    t.status = "settling";
    t.settle = { key: `tny:${T.id}:finish`, at: clock(), retry_at: null };
    T.dl = { turn: null, next: null, idle: null };
    T.turn = null;
    await save(T);
    if (S.hooks.crash === "sng:settle") throw new Error("test crash before the settle");     // tests only
    return settleNow(T);
  }
  /** pay a finished sit & go (again after a restart: a payout already committed under its key is only marked done). -> true | false */
  async function settleNow(T) {
    const t = T.tourney;
    const plan = settlePlan(T);
    if (plan.out !== plan.held || t.places.length !== t.entrants.length) {
      console.error(`[casino] sit & go ${T.id}: the payout plan doesn't add up (${plan.out} out of ${plan.held} held, ${t.places.length} places) - NOT paid`);
      if (t.settle) t.settle.retry_at = clock() + SNG.RETRY_MS;
      return false;
    }
    await prep();
    const snap = keep(T);
    let fresh = false;
    try {
      await dbTx(async () => {
        if (!(await ESC().seen(plan.key))) {
          const r = await ESC().settleInTx({ key: plan.key, hids: plan.hids, payouts: plan.payouts, fees: plan.fees, ref: plan.ref });
          if (r.kept !== 0) throw new Error(`the settle would keep ${r.kept}`);
          await ESC().record(plan.key, { op: "settle", ref: plan.ref, amount: r.held, via: "casino",
                                         result: { ok: true, held: r.held, fee: plan.fee, paid: plan.payouts.map((p) => [p.userId, p.amount]) } });
          fresh = true;
        }
        t.status = "finished";
        t.finished_at = clock();
        if (t.settle) t.settle.done = clock();
        closeState(T);
        await save(T);
      });
    } catch (e) {
      restore(T, snap);
      if (T.tourney.settle) T.tourney.settle.retry_at = clock() + SNG.RETRY_MS;
      console.error(`[casino] sit & go ${T.id}: the payout didn't go through (${e && e.message ? e.message : e}) - tried again in a minute`);
      return false;
    }
    const top = t.places.slice().sort((a, b) => a.place - b.place);
    if (fresh) {
      await emit(T, "sng", `🏆 ${top[0].name} wins the Sit & Go — ${fmt(top[0].prize)} PAT!`, { sng: "won" });
      await emit(T, "sng", `🏁 Results: ${top.filter((p) => p.prize > 0).map((p) => `${ord(p.place)} ${p.name} ${fmt(p.prize)}`).join(" · ")} PAT. ` +
                 `${fmt(plan.fee)} PAT of entry fees to the House. ${link(T)}`, { sng: "finished" });
      await emit(T, "closed", "🏁 The Sit & Go is over — the table is closed.", { reason: "finished" });
    }
    await save(T);
    streamGone(T.id);
    return true;
  }

  // ── cancel (an admin) / the registration hour: everyone back in full ──
  async function refundAll(T, why, by) {
    const t = T.tourney, ref = refOf(T);
    await prep();
    const snap = keep(T);
    let back = 0;
    try {
      await dbTx(async () => {
        if (await ESC().seen(`tny:${T.id}:finish`)) throw new Error("already paid out");
        for (const x of t.entrants) {
          const rk = `tny:${T.id}:${x.uid}:refund:${x.gen}`;
          if (await ESC().seen(rk)) continue;
          await ESC().refundInTx({ key: rk, hid: x.hid, reason: why === "cancelled" ? "sit & go cancelled" : "sit & go refund" });
          await ESC().record(rk, { op: "refund", ref, amount: x.amount, via: "casino", result: { ok: true, why } });
          back += x.amount;
        }
        const ck = `tny:${T.id}:cancel`;
        if (!(await ESC().seen(ck))) await ESC().record(ck, { op: "refund", ref, amount: back, via: "casino", result: { ok: true, why, by: by || null, entrants: t.entrants.length } });
        t.status = "cancelled";
        t.cancelled = { at: clock(), why, by: by || null };
        t.settle = null;
        closeState(T);
        await save(T);
      });
    } catch (e) {
      restore(T, snap);
      console.error(`[casino] sit & go ${T.id}: ${why} - the refunds didn't go through:`, e && e.message ? e.message : e);
      return null;
    }
    // a hand cut short is void: its seed is revealed all the same (the fairness record of a hand that never finished)
    if (T.hand) {
      await runQuery("UPDATE casino_rounds SET server_seed = ?, shoe = ?, revealed = ? WHERE table_id = ? AND round_no = ?",
                     [T.hand.seed, JSON.stringify(T.hand.deck), clock(), T.id, T.hand.no]).catch(() => {});
      T.hand = null;
    }
    await emit(T, "sng", why === "cancelled" ? "🛑 The Sit & Go was cancelled by an admin — every entry refunded in full (buy-in and fee)."
                                           : `⌛ The Sit & Go didn't start within ${SNG.REG_MINS} minutes — called off, every entry refunded in full.`, { sng: "cancelled" });
    await emit(T, "closed", "🏁 Sit & Go table closed.", { reason: why });
    await save(T);
    streamGone(T.id);
    return { back, n: t.entrants.length };
  }
  async function cancel(T, actor, reason) {
    const u = await userRow(actor.uid);
    if (!u || !isAdmin(u)) return R(false, "🏁 only an admin with the casino capability can cancel a sit & go.", { table: T.id });
    const t = T.tourney;
    if (T.status !== "open" || !["registering", "running", "settling"].includes(t.status)) return R(false, "🏁 this sit & go is already over.", { table: T.id });
    const was = t.status;
    const r = await refundAll(T, "cancelled", u.username);
    if (!r) return R(false, "couldn't cancel it right now — nothing was refunded; try again.", { table: T.id });
    try {
      await require("../adminaudit").record({ userId: u.userId, username: u.username }, "casino_sng_cancel", null,
                                            { sng: T.id, status: was, entrants: r.n, refunded: r.back }, reason ? String(reason).slice(0, 200) : null);
    } catch (e) { console.error("[casino] sit & go cancel audit:", e && e.message ? e.message : e); }
    console.log(`[casino] sit & go ${T.id} cancelled by ${u.username}: ${r.n} entr${r.n === 1 ? "y" : "ies"}, ${r.back} PAT refunded`);
    return R(true, `cancelled — ${r.n} entr${r.n === 1 ? "y" : "ies"} refunded in full (${fmt(r.back)} PAT).`, { table: T.id });
  }

  // ── the clock (holdem.js tick / due) ──
  async function tick(T) {
    const t = T.tourney, now = clock();
    if (t.status === "registering") {
      if (t.expires_at && now >= t.expires_at && !counting(t)) {
        if (!(await refundAll(T, "expired", null))) T.tourney.expires_at = clock() + SNG.RETRY_MS;   // (tried again in a minute, not every tick)
        return "done";
      }
      if (t.countdown_at && now >= t.countdown_at) {
        t.countdown_at = null;
        if (t.start_at && t.entrants.length >= t.start_at) await start(T);
        else await save(T);
      }
      return "done";
    }
    if (t.status === "settling") {
      if (!t.settle || !t.settle.retry_at || now >= t.settle.retry_at) await settleNow(T);
      return "done";
    }
    if (t.status !== "running") return "done";
    let up = 0;
    while (t.level_ends_at && now >= t.level_ends_at) { t.level += 1; t.level_ends_at += t.level_ms; up += 1; }
    if (up) {
      const [sb, bb] = levelAt(t, t.level);
      await emit(T, "line", `⬆️ Blinds up — level ${t.level + 1}: ${fmt(sb)}/${fmt(bb)}${T.eng.hand_active ? " from the next hand" : ""}.`, { sng: "level" });
      await save(T);
    }
    if (stalled(T, now)) {        // (review) holdem.js wrapUp: the last hand's wrap-up again (the places, then the next hand or the finish)
      wrapAt.set(T.id, now + SNG.RETRY_MS);
      console.log(`[casino] sit & go ${T.id}: between hands with nothing scheduled - wrapping the last hand up again`);
      return "wrap";
    }
    return null;
  }
  function due(T) {
    const t = T.tourney, now = clock();
    if (t.status === "registering") return !!((t.expires_at && now >= t.expires_at && !counting(t)) || (t.countdown_at && now >= t.countdown_at));
    if (t.status === "settling") return !t.settle || !t.settle.retry_at || now >= t.settle.retry_at;
    return t.status === "running" && ((!!t.level_ends_at && now >= t.level_ends_at) || stalled(T, now));
  }

  /** after a restart (holdem.js recover): "done" = handled here; null = a running sit & go - holdem.js resumes its hand / turn / next */
  async function recover(T) {
    const t = T.tourney, now = clock(), base = Math.min(now, Number(T.updated) || now);
    if (t.status === "registering") {
      if (t.countdown_at) t.countdown_at = now + Math.max(0, t.countdown_at - base);
      if (t.expires_at) t.expires_at = now + Math.max(0, t.expires_at - base);
      if (t.entrants.length >= t.size) await start(T);
      else await save(T);
      return "done";
    }
    if (t.status === "settling") {
      console.log(`[casino] sit & go ${T.id}: finishing its payout after a restart`);
      await settleNow(T);
      return "done";
    }
    if (t.status !== "running") {
      if (T.status === "open") { closeState(T); await save(T); }
      return "done";
    }
    while (t.level_ends_at && base >= t.level_ends_at) { t.level += 1; t.level_ends_at += t.level_ms; }
    if (t.level_ends_at) t.level_ends_at = now + (t.level_ends_at - base);
    return null;
  }

  // ── the table's own verbs (holdem.js run, before the cash-table verbs) ──
  async function tableVerb(T, actor, verb, args) {
    const t = T.tourney;
    switch (verb) {
      case "sit": case "buyin": case "buy": case "join": case "register": {
        if (t.status !== "registering") return R(false, "🏁 this sit & go is under way — you can watch.", { table: T.id });
        // (review) an amount typed out of cash-table habit (!sit 2000) never becomes an entry: only the buy-in or the whole entry does
        const typed = args && args[0] != null ? String(args[0]).trim() : "";
        const a = typed ? amt(typed) : null;
        if (a !== null && a !== t.buyin && a !== t.buyin + t.fee) {
          return R(false, `🏁 this table is a Sit & Go: the entry is ${fmt(t.buyin + t.fee)} PAT (${fmt(t.buyin)} + a ${fmt(t.fee)} fee to the House), the same for ` +
                          `everyone — !sit with no amount (or !sng join ${short(T)}) registers you.`, { table: T.id });
        }
        return register(T, actor);
      }
      case "stand": case "leave": case "cashout": case "unregister":
        return t.status === "registering" ? unregister(T, actor)
          : R(false, "🏁 tournament chips aren't PAT — they can't be cashed out. !sitout to sit out (you'll be blinded until you're back).", { table: T.id });
      case "end": case "close": case "stop":
        return R(false, "🏁 a sit & go isn't closed like a cash table — an admin can cancel it (every entry refunded in full).", { table: T.id });
      case "deal": case "next": case "go":
        return R(false, "🏁 the sit & go deals by itself.", { table: T.id });
      case "status": case "": case "table": case "info": case "show":
        return R(true, infoText(T), { table: T.id });
      case "help": case "rules": case "how":
        return R(true, HELP);
      default:
        return null;
    }
  }

  // ── texts ──
  const HELP = "🏁 Sit & Go — !sng lists them; !sng new <seats 2-9> <buy-in> [turbo] [at N] opens one (you're registered); !sng join [id] / " +
               "!sng leave [id] (a full refund before it starts); !sng info [id]. Everyone pays the same entry (buy-in + a fee to the House) and gets " +
               `${fmt(SNG.STACK)} tournament chips (not PAT); the blinds go up every few minutes; a bust-out is out; the top finishers share the prize pool. ` +
               "At the table: !check !call !bet !raise !allin !fold, !sitout / !sitin (sitting out = blinded, never cashed out).";
  function listText(only) {
    const all = only || open();
    if (!all.length) return "🏁 No Sit & Go is open. Start one: !sng new <seats 2-9> <buy-in> [turbo] [at N] — e.g. !sng new 6 1k.";
    return "🏁 Sit & Gos: " + all.slice(0, 8).map((T) => {
      const t = T.tourney;
      return `#${short(T)} ${t.size}-seat ${kShort(t.buyin)}+${kShort(t.fee)}${t.turbo ? " turbo" : ""} — ` +
             (t.status === "registering" ? `${t.entrants.length}/${t.size} in (!sng join ${short(T)})`
              : t.status === "running" ? `level ${t.level + 1}, ${H.seatedWithChips(T.eng).length} left` : "paying out");
    }).join(" | ") + ` · ${lobbyUrl()}`;
  }
  function infoText(T) {
    const t = T.tourney, e = T.eng;
    const head = `🏁 Sit & Go #${short(T)} — ${t.size} seats, entry ${fmt(t.buyin)} + ${fmt(t.fee)} PAT fee, ${fmt(t.stack)} chips, blinds up every ` +
                 `${t.level_ms / 60000} min${t.turbo ? " (turbo)" : ""}`;
    if (t.status === "registering") {
      const names = t.entrants.map((x) => realName(T, x.uid, x.name)).join(", ");
      return `${head}; starts ${t.start_at ? `at ${t.start_at} players (a ${SNG.COUNTDOWN_SECS} s countdown)` : "when full"}. Registered ${t.entrants.length}/${t.size}: ` +
             `${names}. Prizes if full: ${prizeText(prizeTable(t.buyin * t.size, bandFor(t.payouts, t.size)))}. ${link(T)}`;
    }
    if (t.status === "running") {
      const [sb, bb] = levelAt(t, t.level), left = Math.max(0, Math.ceil((t.level_ends_at - clock()) / 1000));
      return `${head}. Level ${t.level + 1}: blinds ${fmt(sb)}/${fmt(bb)}, next level in ${mmss(left)}. ${H.seatedWithChips(e).length} of ${t.field} left. ` +
             `Prizes: ${prizeText(t.prizes)}. ${link(T)}`;
    }
    if (t.status === "settling") return `${head}. It's over — paying out the prizes now.`;
    if (t.status === "finished") {
      const top = t.places.slice().sort((a, b) => a.place - b.place).filter((p) => p.prize > 0);
      return `${head}. Finished: ${top.map((p) => `${ord(p.place)} ${p.name} ${fmt(p.prize)}`).join(" · ")} PAT.`;
    }
    return `${head}. Cancelled — every entry refunded in full.`;
  }
  /** a push / advert announcement (service.js) */
  function howText(T) {
    const t = T.tourney;
    return t.status === "registering"
      ? `a ${t.size}-seat Sit & Go (entry ${fmt(t.buyin + t.fee)} PAT, ${t.entrants.length}/${t.size} in) — !sng join ${short(T)} to register`
      : `a Sit & Go under way (level ${t.level + 1}) — watch it`;
  }

  // ── views ──
  function view(T) {
    const t = T.tourney, e = T.eng, now = clock();
    const n = t.status === "registering" ? t.entrants.length : t.field || t.entrants.length;
    const lvl = t.level || 0, [sb, bb] = levelAt(t, lvl), [nsb, nbb] = levelAt(t, lvl + 1);
    const running = t.status === "running";
    return {
      id: T.id, short: short(T), status: t.status, size: t.size, field: t.field, start_at: t.start_at, turbo: !!t.turbo, buyin: t.buyin, fee: t.fee,
      entry: t.buyin + t.fee, stack: t.stack, level_mins: t.level_ms / 60000, registered: t.entrants.length,
      // names only, each as the table's veil shows them (casino/veil.js) - never an account id or a hold id
      entrants: t.entrants.map((x) => ({ name: V.nameOf(T, x.uid, realName(T, x.uid, x.name)) })),
      countdown_at: t.status === "registering" ? t.countdown_at : null, expires_at: t.status === "registering" ? t.expires_at : null,
      // (review) the countdown in seconds on the site's clock (Pepe's OBS board counts from this, not from his own clock)
      countdown_secs_left: t.status === "registering" && t.countdown_at ? Math.max(0, Math.ceil((t.countdown_at - now) / 1000)) : null,
      level: lvl + 1, sb, bb, next_sb: nsb, next_bb: nbb, level_ends_at: running ? t.level_ends_at : null,
      level_secs_left: running && t.level_ends_at ? Math.max(0, Math.ceil((t.level_ends_at - now) / 1000)) : null,
      players_left: running || t.status === "settling" ? H.seatedWithChips(e).length : t.status === "finished" ? 1 : null,
      pool: t.buyin * n, fee_total: t.fee * n,
      prizes: t.status === "registering" ? prizeTable(t.buyin * t.size, bandFor(t.payouts, t.size)) : t.prizes.slice(),
      places: t.places.slice().sort((a, b) => a.place - b.place).map((p) => ({ place: p.place, name: p.shown || V.nameOf(T, p.uid, p.name), prize: p.prize, tied: !!p.tied })),
      cancelled: t.status === "cancelled" ? (t.cancelled && t.cancelled.why) || "cancelled" : null,     // "cancelled" (an admin) | "expired" | "empty"
    };
  }
  /** `u` = the viewer's user row (service.js meView). can_register (review): the table page offers Register only to who may enter now
   *  (the switch + staff only + a casino ban, as gate() - the cash tables' entry rule still decides at the click) */
  function meView(T, uid, u) {
    const t = T.tourney, p = uid ? placedOf(T, uid) : null, reg = !!(uid && entrantOf(T, uid));
    const st = S.settings || {}, aud = st.casino_sng || "off";
    const can = !!(uid && u && !reg && t.status === "registering" && t.entrants.length < t.size && st.hm_enabled && aud !== "off" &&
                   !u.casino_banned && (aud === "everyone" || isStaff(u)));
    return { registered: reg, can_register: can, place: p ? p.place : null, prize: p ? p.prize : null };
  }
  function row(T, uid) {
    const v = view(T);
    const w = v.places.find((p) => p.place === 1);
    return { id: T.id, short: v.short, url: link(T), host: V.hostName(T), status: v.status, size: v.size, field: v.field, registered: v.registered, start_at: v.start_at,
             turbo: v.turbo, buyin: v.buyin, fee: v.fee, entry: v.entry, stack: v.stack, level_mins: v.level_mins, countdown_at: v.countdown_at, expires_at: v.expires_at,
             level: v.level, sb: v.sb, bb: v.bb, players_left: v.players_left, prizes: v.prizes, winner: w ? w.name : null,
             me: !!(uid && entrantOf(T, uid)), rooms: roomList(T), on_stream: S.stream.table === T.id };
  }
  /** the lobby's Sit & Go block: the switch, what the create sheet offers, open sit & gos (+ the ones that just ended, for their results) */
  async function lobby(uid) {
    const st = await loadSettings();
    const c = config(st);
    const on = !!st.hm_enabled && (st.casino_sng || "off") !== "off";
    let can = false;
    if (uid && on) {
      const u = await userRow(uid);
      can = !!u && !u.casino_banned && (st.casino_sng === "everyone" || isStaff(u));
    }
    const t = clock();
    const list = Array.from(S.tables.values()).filter((T) => isSng(T) && (T.status === "open" || (T.closed_at && t - T.closed_at < SNG.LINGER_MS)))
      .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || (a.created || 0) - (b.created || 0)).map((T) => row(T, uid));
    return { on, audience: st.casino_sng || "off", can_create: can, sizes: [2, 3, 4, 5, 6, 7, 8, 9], buyins: c.buyins, fee_pct: c.fee_pct, payouts: c.payouts,
             level_mins: c.level_mins, turbo_mins: c.turbo_mins, stack: SNG.STACK, countdown_secs: SNG.COUNTDOWN_SECS, reg_mins: SNG.REG_MINS, list };
  }
  /** every open sit & go, short (Pepe's poll) */
  function openList() { return open().map((T) => row(T, null)); }

  // ── the !sng commands (service.js run, game "sng"; the same for the web and Pepe) ──
  const ALIAS = { create: "new", open: "new", start: "new", make: "new", register: "join", reg: "join", enter: "join", in: "join",
                  unregister: "leave", unreg: "leave", out: "leave", quit: "leave", show: "info", status: "info", table: "info", ls: "list", rules: "help", how: "help" };
  function find(idArg, opts, actor, verb) {
    const all = open();
    const q = String(idArg || "").trim().toLowerCase().replace(/^#/, "");
    if (q) {
      if (!/^[0-9a-f]{4,10}$/.test(q)) return { err: "that isn't a sit & go id — !sng lists them." };
      const hits = all.filter((T) => T.id.startsWith(q));
      if (hits.length === 1) return { T: hits[0] };
      return { err: hits.length ? "more than one sit & go starts with that — give more of its id." : "no open sit & go with that id — !sng lists them." };
    }
    const here = (opts.table && all.find((T) => T.id === opts.table)) || (opts.room && all.find((T) => roomsOf(T).includes(opts.room))) || null;
    if (verb === "leave") {
      // (review) your own registration first: the room's sit & go only when you're in it (or aren't in any)
      const mine = all.filter((T) => entrantOf(T, actor.uid));
      if (here && mine.includes(here)) return { T: here };
      const reg = mine.filter((T) => T.tourney.status === "registering");
      if (reg.length === 1) return { T: reg[0] };
      if (reg.length > 1) return { err: "which one? " + reg.slice(0, 6).map((T) => `!sng leave ${short(T)}`).join(" · ") };
      if (here) return { T: here };
      return { err: "you're not registered for a sit & go that hasn't started." };
    }
    if (here) return { T: here };
    let pool = all;
    if (verb === "join") pool = all.filter((T) => T.tourney.status === "registering");
    if (verb === "leave") pool = all.filter((T) => T.tourney.status === "registering" && entrantOf(T, actor.uid));
    if (pool.length === 1) return { T: pool[0] };
    if (!pool.length) return { err: verb === "leave" ? "you're not registered for a sit & go that hasn't started." : "no Sit & Go is open — start one: !sng new <seats 2-9> <buy-in>." };
    return { err: "which one? " + pool.slice(0, 6).map((T) => `!sng ${verb} ${short(T)}`).join(" · ") };
  }
  async function run(actor, verb, args, opts) {
    opts = opts || {};
    verb = String(verb || "").toLowerCase();
    verb = ALIAS[verb] !== undefined ? ALIAS[verb] : verb;
    args = (Array.isArray(args) ? args : []).map((x) => String(x == null ? "" : x));
    // (review) switched off (or staff only, for a member): help / the list / info say so - an entrant still sees theirs (and can leave)
    if (verb === "help") { const no = await shut(actor); return no ? R(false, no) : R(true, HELP); }
    if (verb === "" || verb === "list") {
      if (args[0] && /^#?[0-9a-f]{4,10}$/i.test(args[0])) verb = "info";
      else {
        const no = await shut(actor);
        if (!no) return R(true, listText());
        const mine = open().filter((T) => entrantOf(T, actor.uid));
        return mine.length ? R(true, listText(mine)) : R(false, no);
      }
    }
    if (verb === "new") return create(actor, args, opts.room || null);
    if (!["join", "leave", "info", "cancel"].includes(verb)) return R(false, "unknown !sng option — try: !sng, !sng new, !sng join, !sng leave, !sng info.");
    const f = find(args[0], opts, actor, verb);
    if ((verb === "join" || verb === "info") && !(f.T && entrantOf(f.T, actor.uid))) { const no = await shut(actor); if (no) return R(false, no); }
    if (f.err) return R(false, f.err);
    if (verb === "join") return register(f.T, actor);
    if (verb === "leave") return unregister(f.T, actor);
    if (verb === "info") return R(true, infoText(f.T), { table: f.T.id });
    return cancel(f.T, actor, args.slice(1).join(" "));
  }

  return { SNG, HELP, run, tableVerb, beforeHand, afterHand, tick, due, recover, view, meView, lobby, openList, howText, infoText, settlePlan, settleNow, isSng,
           outAtDeal, outNow, levelAt: (t, i) => levelAt(t, i) };
}

module.exports = { install, SNG, DEFAULTS, SETTING_KEYS, AUDIENCES, checkSetting, readSettings, parseBuyins, parsePayouts, parseLevels, prizeTable, levelAt, niceUp };
