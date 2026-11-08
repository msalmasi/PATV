// casino/mtt.js — 🏆 SCHEDULED MULTI-TABLE Hold'em tournaments (hand-off 22 phase 2, 1.99??; docs/casino-backend.md
// "Scheduled tournaments (MTT)"). Built on phase 1 (casino/tourney.js, the Sit & Go): the same money rules (decisions 1-11 of the
// brief), the same engine (casino/hmengine.js, unchanged), the same table code (casino/holdem.js) - every MTT table is an ordinary
// Hold'em table with a tourney block {kind: "mtt"} that service.js's router sends here.
//
//   * SCHEDULE (admins only): a tournament row (casino_mtt) with its JSON state M; registration opens at reg_opens_at (the structure and
//     the money are frozen then, the seating draw's seed is committed), it starts at start_at with >= min_entries, else it is cancelled
//     with every entry refunded in full (the fee too).
//   * THE MONEY (escrow, kind TNY - a site service's): an entry = ONE hold of buy-in + fee (key tny:<tid>:<uid>:enter:<gen>), a refund =
//     refundInTx (tny:<tid>:<uid>:refund:<gen>), the finish = ONE settleInTx of every hold: the prizes + ONE fee leg to the House
//     (tny:<tid>:finish). Each is ONE dbUtils.tx with its escrow_moves row, the entry row, the tournament's state and every table touched.
//     Tournament chips are not PAT. Guarantees / freerolls: casino/mttbudget.js (the incentive budget, only from H2b; never the House,
//     the Fed or a player's PAT) - the overlay is paid after the settle, separately.
//   * PLAY: one level clock for every table (casino/mttseat.js + mttpay.js are the pure rules). Each table runs its BOUNDARY before every
//     hand (beforeDeal): the clock's blinds, a disqualification, the final table, breaking, balancing, hand-for-hand, arrivals with the
//     blind planner, chip conservation. A bust-out is placed by its bust batch (handEnd). Moves are transit records (M.transit) until the
//     target table's next boundary seats them.
//   * RESTARTS: every mutation is one transaction with a full-replacement restore of M and every table it touched if it throws; recover()
//     resumes from what committed (section 27 of the spec: register, start, hands, moves, busts, finish, overlay, cancel, post steps).
// Ships dark: casino_settings casino_mtt off | staff | everyone (default off); Hold'em on the site (hm_enabled) must be on too.
"use strict";
const crypto = require("crypto");
const H = require("./hmengine");
const V = require("./veil");
const SEAT = require("./mttseat");
const PAY = require("./mttpay");
const BUD = require("./mttbudget");
const TNCFG = require("./tourney");
const { amt } = require("./holdem");

const ID_RE = /^m[0-9a-f]{9}$/;
const AUDIENCES = Object.freeze(["off", "staff", "everyone"]);
const OPEN = Object.freeze(["scheduled", "registering", "running", "finishing", "settled"]);
const MTT = Object.freeze({ RECHECK_MS: 10e3, BEAT_MS: 30e3, RETRY_MS: 60e3, OVERLAY_RETRY_MS: 5 * 60e3, OWED_MS: 7 * 86400e3, RESULT_MS: 15 * 60e3,
                            LINGER_MS: 30 * 60e3, SEEN_WEB_MS: 5 * 60e3, SEEN_ROOM_MS: 30 * 60e3, OP_GAP_MS: 2000, MAX_DELAY_MS: 6 * 3600e3,
                            MAX_ROOMS: 6, VIEW_MS: 1000, REMIND_EVERY_MS: 30e3, ROOM_FRESH_MS: 90e3, LB_MS: 60e3, PAGE: 50 });
const SNG_LADDER = TNCFG.DEFAULTS.sng_levels;
const DEFAULTS = Object.freeze({
  casino_mtt: "off", mtt_guarantees: "off", mtt_fee_pct: 10, mtt_buyins: "1000,5000,25000,100000", mtt_table_size: 9, mtt_start_chips: 1500,
  mtt_level_mins: 5, mtt_turbo_mins: 3, mtt_levels: SNG_LADDER, mtt_next_secs: 6, mtt_late_levels: 4, mtt_break_slack: 3, mtt_reentry_cap: 1,
  mtt_max_field: 180, mtt_min_entries: 6, mtt_max_running: 2, mtt_max_open_reg: 6, mtt_reg_open_hours: 24, mtt_start_grace_mins: 30,
  mtt_payouts_small: "100|65,35|50,30,20", mtt_paid_pct: 15, mtt_curve_exp: "0.9", mtt_min_paid: 3, mtt_overlay_cap: 100000,
  mtt_overlay_week_cap: 500000, mtt_budget_group: "roomgames", mtt_freeroll_min_level: 3, mtt_freeroll_min_age_days: 7, mtt_remind_mins: 15,
  mtt_points_min_field: 6, mtt_ach_min_field: 10, mtt_stream_final: "take", mtt_presence: "on", mtt_room_entrants_max: 20,
  mtt_room_lines_per_min: 6, mtt_discord: "off", mtt_discord_channel: "", mtt_discord_role: "", mtt_discord_kinds: "starting,winner",
});
const SETTING_KEYS = Object.freeze(Object.keys(DEFAULTS));
const NUMS = { mtt_fee_pct: [0, 50], mtt_start_chips: [500, 100000], mtt_level_mins: [1, 60], mtt_turbo_mins: [1, 60], mtt_next_secs: [2, 15],
               mtt_late_levels: [0, 20], mtt_break_slack: [0, 9], mtt_reentry_cap: [0, 3], mtt_max_field: [10, 500], mtt_min_entries: [2, 50],
               mtt_max_running: [1, 5], mtt_max_open_reg: [1, 20], mtt_reg_open_hours: [0, 168], mtt_start_grace_mins: [5, 240], mtt_paid_pct: [5, 30],
               mtt_min_paid: [2, 5], mtt_overlay_cap: [0, 999999], mtt_overlay_week_cap: [0, 999999999], mtt_freeroll_min_level: [0, 100],
               mtt_freeroll_min_age_days: [0, 365], mtt_remind_mins: [1, 120], mtt_points_min_field: [2, 50], mtt_ach_min_field: [2, 100],
               mtt_room_entrants_max: [0, 180], mtt_room_lines_per_min: [1, 30] };
const ENUMS = { casino_mtt: AUDIENCES, mtt_guarantees: ["off", "on"], mtt_table_size: ["6", "9"], mtt_budget_group: BUD.GROUPS, mtt_stream_final: ["take", "queue", "off"],
                mtt_presence: ["on", "off"], mtt_discord: ["off", "on"] };
const DISCORD_KINDS = ["reg_open", "starting", "final", "winner"];
const intIn = (v, lo, hi) => { const s = String(v == null ? "" : v).trim(); if (!/^\d+$/.test(s)) return null; const n = Number(s); return n >= lo && n <= hi ? n : null; };

/** a setting's stored text, normalised, or throws (the admin sees the message) */
function checkMttSetting(key, value) {
  const v = String(value == null ? "" : value).trim();
  if (/h2b/i.test(String(key))) throw new Error("the H2b date is a code constant, not a setting");
  if (ENUMS[key]) { if (!ENUMS[key].includes(v)) throw new Error(`${key}: one of ${ENUMS[key].join(", ")}`); return v; }
  if (NUMS[key]) { const n = intIn(v.replace(/,/g, ""), NUMS[key][0], NUMS[key][1]); if (n === null) throw new Error(`${key}: a whole number ${NUMS[key][0]}-${NUMS[key][1]}`); return String(n); }
  if (key === "mtt_buyins") { const l = TNCFG.parseBuyins(v); if (!l) throw new Error("buy-ins: 1-8 different whole amounts of 100 PAT or more, comma-separated"); return l.join(","); }
  if (key === "mtt_levels") { const l = TNCFG.parseLevels(v); if (!l) throw new Error("levels: sb/bb pairs, comma-separated, the big blind rising every level"); return l.map((x) => x.join("/")).join(","); }
  if (key === "mtt_payouts_small") {
    const p = TNCFG.parsePayouts(v);
    if (!p) throw new Error("small-field payouts: three lists for 2-3 | 4-6 | 7-9 entries (e.g. 100|65,35|50,30,20), each highest first and summing to 100");
    return p.map((b) => b.join(",")).join("|");
  }
  if (key === "mtt_curve_exp") { if (!/^\d(\.\d{1,2})?$/.test(v) || Number(v) < 0.3 || Number(v) > 1.5) throw new Error("the curve exponent: 0.3-1.5"); return String(Number(v)); }
  if (key === "mtt_discord_channel" || key === "mtt_discord_role") { if (v && !/^\d{15,22}$/.test(v)) throw new Error("a Discord id (15-22 digits) or empty"); return v; }
  if (key === "mtt_discord_kinds") {
    const ks = v.split(",").map((x) => x.trim()).filter(Boolean);
    if (ks.some((k) => !DISCORD_KINDS.includes(k)) || new Set(ks).size !== ks.length) throw new Error(`Discord posts: a comma list of ${DISCORD_KINDS.join(", ")}`);
    return ks.join(",");
  }
  throw new Error("unknown setting");
}
/** the casino_settings rows -> the MTT settings (a bad stored value reads as its default) */
function readMttSettings(kv) {
  const out = {};
  for (const k of SETTING_KEYS) {
    let v;
    try { v = kv[k] === undefined || kv[k] === null ? String(DEFAULTS[k]) : checkMttSetting(k, kv[k]); } catch (e) { v = String(DEFAULTS[k]); }
    out[k] = typeof DEFAULTS[k] === "number" ? Number(v) : v;
  }
  return out;
}

// ── pure helpers ──
const ord = (n) => n + ((n % 100 >= 11 && n % 100 <= 13) ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
const kShort = (n) => (n >= 1e6 && n % 1e5 === 0 ? `${n / 1e6}M` : n >= 1e3 && n % 100 === 0 ? `${n / 1e3}K` : String(n));
const cleanTitle = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const levelAt = (M, i) => TNCFG.levelAt({ levels: M.structure.levels }, i);
/** ET wall clock (America/New_York) of an instant -> {y, m, d, h, mi} */
function etParts(ms) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}
/** "2026-11-15T20:00" read as ET -> ms UTC | null */
function parseEt(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return require("../onairqueue").wallMs(y, mo, d, h, mi);
}
/** add `days` calendar days at the same ET wall time (a series keeps 8:00 PM ET across DST) */
function addEtDays(ms, days) {
  const p = etParts(ms);
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return require("../onairqueue").wallMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), p.h, p.mi);
}
const etText = (ms) => {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms)) + " ET"; }
  catch (e) { return new Date(ms).toISOString(); }
};
/** the structure + money a tournament would freeze with these settings */
function snapshotOf(d, st) {
  const levels = TNCFG.parseLevels(st.mtt_levels) || TNCFG.parseLevels(SNG_LADDER);
  const level_ms = (d.kind === "turbo" ? st.mtt_turbo_mins : st.mtt_level_mins) * 60000;
  const structure = { kind: d.kind === "turbo" ? "turbo" : "standard", start_chips: d.start_chips, level_ms, levels, late_levels: d.late_levels,
                      reentry_max: d.reentry_max, table_size: d.table_size, max_entries: d.max_entries, min_entries: d.min_entries,
                      next_secs: st.mtt_next_secs, break_slack: st.mtt_break_slack };
  const est = PAY.estimate(structure, d.max_entries, TNCFG.levelAt);
  structure.est_ms = est.est_ms;
  structure.bound_ms = est.bound_ms;
  const freeroll = d.buyin === 0;
  const money = { buyin: d.buyin, fee: freeroll ? 0 : Math.floor((d.buyin * st.mtt_fee_pct) / 100), fee_pct: freeroll ? 0 : st.mtt_fee_pct, guarantee: d.guarantee || 0,
                  freeroll, group: st.mtt_budget_group, overlay_cap: st.mtt_overlay_cap, small_pcts: TNCFG.parsePayouts(st.mtt_payouts_small) || TNCFG.parsePayouts(DEFAULTS.mtt_payouts_small),
                  paid_pct: st.mtt_paid_pct, exp: Number(st.mtt_curve_exp), min_paid: st.mtt_min_paid };
  return { structure, money };
}

function install(core) {
  const { S, clock, save, emitRaw, userRow, R, fmt, siteBase, runQuery, getQuery, streamGone, streamTake, loadSettings, HM, freshRooms, wake } = core;
  const ESC = () => require("../escrow/ledger");
  const SP = () => require("../siteperms");
  const dbTx = (fn) => require("../dbUtils").tx(fn);
  S.mtts = S.mtts || new Map();
  S.mttSeen = S.mttSeen || new Map();
  S.mttSeenRoom = S.mttSeenRoom || new Map();
  S.scene = S.scene || { held: false, at: 0 };
  const opAt = new Map();                // uid -> last MTT op (2 s gap)
  const lineQ = new Map();               // room -> {sent: [ts], q: [text]} (best effort; lost on restart)
  const viewCache = new Map();           // `${id}:${rev}` -> {at, v}
  const lbCache = new Map();             // period -> {at, v}
  const stoppedLogged = new Set();
  let lastRemind = 0;

  // tests only: S.hooks.crash = "<name>" throws there once per call (a crash at that cut point); S.hooks.crashed lists where it fired
  const crash = (name) => {
    if (S.hooks.crash !== name) return;
    S.hooks.crashed = (S.hooks.crashed || []).concat([name]);
    throw Object.assign(new Error("test crash " + name), { crash: true });
  };
  const ref = (M) => `TNY-${M.id}`;
  const url = (M) => `${siteBase()}/casino/holdem/mtt/${M.id}`;
  const tableUrl = (T) => `${siteBase()}/casino/holdem/t/${T.id}`;
  const isStaff = (u) => { try { return SP().atLeast(u, "staff") || SP().can(u, "casino.admin"); } catch (e) { return false; } };
  const isAdmin = (u) => { try { return SP().can(u, "casino.admin"); } catch (e) { return false; } };
  const ownerOf = async (u) => { try { return await require("../staffroles").ownerOf(u, "econ.backend_cutover"); } catch (e) { return null; } };
  const log = (M, msg) => console.log(`[mtt] ${M ? M.id + " #" + M.no + " " : ""}${msg}`);
  const kindFor = async (uid, p) => { try { return await V.kindForUid(String(uid), p ? { via: p.via, camfrog: p.camfrog } : null); } catch (e) { return "unknown"; } };
  const veiledKind = (k) => k === "incognito" || k === "out" || k === "unknown";
  const alert = async (M, kind, title, body) => {
    try { await require("../opsalerts").alert({ source: "casino_mtt", ref: `${M.id}:${kind}`, title, body }); } catch (e) { console.error("[mtt] opsalert:", e && e.message); }
  };
  async function mlog(M, kind, data, key) {
    try {
      await runQuery("INSERT OR IGNORE INTO casino_mtt_log (tid, ts, kind, key, data) VALUES (?, ?, ?, ?, ?)", [M.id, clock(), kind, key || null, JSON.stringify(data || {})]);
    } catch (e) { console.error("[mtt] log:", e && e.message); }
  }

  // ── tables + migrations ──
  let readyP = null;
  function ensure() {
    if (readyP) return readyP;
    readyP = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS casino_mtt (
        id TEXT PRIMARY KEY, no INTEGER UNIQUE NOT NULL, series TEXT, status TEXT NOT NULL, title TEXT NOT NULL, start_at INTEGER NOT NULL,
        reg_opens_at INTEGER NOT NULL, buyin INTEGER NOT NULL, fee INTEGER NOT NULL, guarantee INTEGER NOT NULL DEFAULT 0, max_entries INTEGER NOT NULL,
        min_entries INTEGER NOT NULL, table_size INTEGER NOT NULL, state TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, created INTEGER,
        created_by_user_id TEXT, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS casino_mtt_status ON casino_mtt (status, start_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS casino_mtt_entries (
        tid TEXT NOT NULL, user_id TEXT NOT NULL, gen INTEGER NOT NULL, entry_no INTEGER, state TEXT NOT NULL, amount INTEGER NOT NULL,
        hold_id TEXT, enter_key TEXT UNIQUE, refund_key TEXT UNIQUE, via TEXT, room TEXT, remind INTEGER NOT NULL DEFAULT 0,
        veiled INTEGER NOT NULL DEFAULT 0, bust_seq INTEGER, bust_stack INTEGER, bust_table_no INTEGER, bust_oc INTEGER, dq INTEGER NOT NULL DEFAULT 0,
        place INTEGER, prize INTEGER NOT NULL DEFAULT 0, overlay INTEGER NOT NULL DEFAULT 0, overlay_due INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0, created INTEGER, updated INTEGER, PRIMARY KEY (tid, user_id, gen))`);
      await runQuery("CREATE INDEX IF NOT EXISTS casino_mtt_entries_user ON casino_mtt_entries (user_id, tid)");
      await runQuery("CREATE INDEX IF NOT EXISTS casino_mtt_entries_state ON casino_mtt_entries (tid, state)");
      await runQuery(`CREATE TABLE IF NOT EXISTS casino_mtt_points (
        tid TEXT NOT NULL, user_id TEXT NOT NULL, gen INTEGER, place INTEGER, entries INTEGER, points INTEGER NOT NULL DEFAULT 0, cashed INTEGER NOT NULL DEFAULT 0,
        won INTEGER NOT NULL DEFAULT 0, period TEXT, veiled INTEGER NOT NULL DEFAULT 0, created INTEGER, PRIMARY KEY (tid, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS casino_mtt_points_period ON casino_mtt_points (period, user_id)");
      await runQuery("CREATE TABLE IF NOT EXISTS casino_mtt_watch (tid TEXT NOT NULL, user_id TEXT NOT NULL, created INTEGER, PRIMARY KEY (tid, user_id))");
      await runQuery(`CREATE TABLE IF NOT EXISTS casino_mtt_reminders (
        ref TEXT PRIMARY KEY, tid TEXT, user_id TEXT, kind TEXT, channel TEXT, due_at INTEGER, sent_at INTEGER, dropped TEXT, data TEXT, created INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS casino_mtt_reminders_due ON casino_mtt_reminders (sent_at, due_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS casino_mtt_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tid TEXT, ts INTEGER, kind TEXT, key TEXT UNIQUE, data TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS casino_mtt_log_tid ON casino_mtt_log (tid, id)");
      // later column additions: PRAGMA table_info + ALTER TABLE inside dbUtils.tx (the reminders' data column)
      const cols = await getQuery("PRAGMA table_info(casino_mtt_reminders)");
      if (!cols.some((c) => c.name === "data")) await dbTx(() => runQuery("ALTER TABLE casino_mtt_reminders ADD COLUMN data TEXT"));
    })().catch((e) => { readyP = null; throw e; });
    return readyP;
  }

  // ── persistence of M ──
  async function saveMtt(M) {
    M.rev = (M.rev || 0) + 1;
    M.updated = clock();
    await runQuery(`UPDATE casino_mtt SET status = ?, title = ?, start_at = ?, reg_opens_at = ?, buyin = ?, fee = ?, guarantee = ?, max_entries = ?, min_entries = ?,
                    table_size = ?, state = ?, rev = ?, updated = ? WHERE id = ?`,
                   [M.status, M.title, M.start_at, M.reg_opens_at, M.money.buyin, M.money.fee, M.money.guarantee, M.structure.max_entries, M.structure.min_entries,
                    M.structure.table_size, JSON.stringify(M), M.rev, M.updated, M.id]);
    wake();
  }
  const replaceObj = (o, json) => { for (const k of Object.keys(o)) delete o[k]; Object.assign(o, JSON.parse(json)); };
  /**
   * ONE transaction for a mutation of M (and the tables it touches): fn(ctx) mutates in memory (ctx.touch(T) BEFORE changing a table,
   * ctx.created for a new one) and writes its rows; then every touched / new table and M are saved in the same transaction. If anything
   * throws, M and every touched table are restored by FULL replacement (the same objects: S.tables / S.mtts keep them) and a new table never
   * reaches S.tables. Post-commit work (kicks, lines, notices) is the caller's, after this returns.
   */
  async function txn(label, M, fn) {
    const t0 = Date.now();
    const mSnap = M ? JSON.stringify(M) : null;
    const snaps = new Map();
    const ctx = { touch: (T) => { if (T && !snaps.has(T)) snaps.set(T, JSON.stringify(T)); return T; }, created: [], kicks: new Set(), lines: [], after: [] };
    let out;
    try {
      out = await dbTx(async () => {
        const r = await fn(ctx);
        crash(`mtt:${label}:in-tx`);
        for (const T of snaps.keys()) await save(T);
        for (const T of ctx.created) await save(T);
        if (M) await saveMtt(M);
        return r;
      });
    } catch (e) {
      if (e && e.crash) S.hooks.lastRestore = { label, m: mSnap, t: Array.from(snaps.entries()).map(([T, s2]) => [T, s2]), created: ctx.created.map((T) => T.id) };
      try {
        if (M) replaceObj(M, mSnap);
        for (const [T, s] of snaps) replaceObj(T, s);
        if (e && e.crash && S.hooks.lastRestore) S.hooks.lastRestore.after = { m: M ? JSON.stringify(M) : null, t: Array.from(snaps.keys()).map((T) => JSON.stringify(T)) };
      } catch (re) {
        console.error(`[mtt] ${M ? M.id : "-"}: the restore after a failed ${label} failed:`, re && re.message);
        e.restoreFailed = true;
      }
      throw e;
    }
    for (const T of ctx.created) S.tables.set(T.id, T);
    const ms = Date.now() - t0;
    if (ms >= 250) console.log(`[tx] mtt ${label} ${ms} ms`);
    (S.mttTxMs = S.mttTxMs || {})[label] = ms;               // (the last duration per kind: the admin page, the timing tests)
    ctx.ms = ms;
    return Object.assign(ctx, { out });
  }
  async function afterCommit(label, fn) {
    try { crash(`mtt:${label}:after-commit`); await fn(); } catch (e) { if (!e || !e.crash) console.error(`[mtt] after ${label}:`, e && e.message ? e.message : e); }
  }

  // ── reads ──
  const entriesOf = (tid, where = "", args = []) => getQuery(`SELECT * FROM casino_mtt_entries WHERE tid = ?${where ? " AND " + where : ""} ORDER BY created, user_id, gen`, [tid].concat(args));
  const entryOf = async (tid, uid, states) => (await getQuery(`SELECT * FROM casino_mtt_entries WHERE tid = ? AND user_id = ? AND state IN (${states.map(() => "?").join(",")}) ORDER BY gen DESC LIMIT 1`,
                                                              [tid, String(uid)].concat(states)))[0] || null;
  const tableRec = (M, T) => M.tables.find((r) => r.id === T.id) || null;
  const liveRecs = (M) => M.tables.filter((r) => r.state === "live" || r.state === "breaking");
  const liveTables = (M) => liveRecs(M).map((r) => S.tables.get(r.id)).filter(Boolean);
  const tableByNo = (M, no) => { const r = M.tables.find((x) => x.no === no); return r ? S.tables.get(r.id) || null : null; };
  const seatedOf = (T) => H.seatedWithChips(T.eng);
  const inbound = (M, no) => Object.values(M.transit || {}).filter((x) => x.to_no === no).length;
  function layout(M) {
    return M.tables.map((r) => {
      const T = S.tables.get(r.id);
      return { no: r.no, state: r.state, final: !!r.final, opened_level: r.opened_level, seated: T && r.state !== "closed" ? seatedOf(T).length : 0, inbound: inbound(M, r.no) };
    });
  }
  const paidOf = (M, E) => PAY.paid(E, M.money);
  function chipsInPlay(M) {
    let n = 0;
    for (const T of liveTables(M)) {
      const e = T.eng;
      for (const k of e.seats) n += (e.chips[k] || 0) + (e.hand_active ? e.contrib[k] || 0 : 0);
    }
    for (const x of Object.values(M.transit || {})) n += x.chips || 0;
    return n;
  }
  function whereIs(M, uid) {
    uid = String(uid);
    for (const T of liveTables(M)) if (T.eng.seats.includes(uid)) return { T, no: T.tourney.no };
    const tr = (M.transit || {})[uid];
    if (tr) return { transit: tr, no: tr.to_no, T: tableByNo(M, tr.to_no) };
    return null;
  }

  // ── the clock ──
  function advanceClock(M, now) {
    const c = M.clock;
    if (!c || M.status !== "running") return 0;
    let up = 0;
    while (!c.paused_at && now >= c.level_ends_at && up < 500) { c.level += 1; c.level_started_at = c.level_ends_at; c.level_ends_at += M.structure.level_ms; up++; }
    return up;
  }
  const blindsNow = (M) => levelAt(M, M.clock ? M.clock.level : 0);

  // ── kick / hold ──
  function kick(T) {
    if (!T || T.status !== "open") return;
    const held = !!T.tourney.hold;
    T.tourney.hold = null;
    if (!T.eng.hand_active && (held || !T.dl.next)) T.dl.next = clock();
  }
  function hold(T, h) {
    const changed = T.tourney.hold !== h;
    T.tourney.hold = h;
    return { deal: false, hold: h, changed };
  }

  // ── lines (room announcements, a per-room budget) ──
  function roomsFor(M, uid) {
    const fresh = new Set((freshRooms() || []).map((r) => r.id));
    if (uid) {
      const p = M.people[uid];
      return p && p.via === "room" && p.room && fresh.has(p.room) ? [p.room] : [];
    }
    return (M.rooms || []).filter((r) => fresh.has(r));
  }
  async function sayIn(M, rooms, text, extra) {
    if (!rooms.length || !text) return;
    const per = (S.settings && S.settings.mtt_room_lines_per_min) || DEFAULTS.mtt_room_lines_per_min;
    const t = clock();
    for (const r of rooms) {
      const q = lineQ.get(r) || { sent: [], q: [] };
      q.sent = q.sent.filter((x) => t - x < 60e3);
      if (q.sent.length < per) {
        q.sent.push(t);
        await emitRaw(M.id, r, "mtt", Object.assign({ text, rooms: [r], tid: M.id, no: M.no, url: url(M) }, extra || {}));
      } else if (q.q.length < 40) q.q.push({ tid: M.id, no: M.no, text, extra: extra || null, bust: !!(extra && extra.bust) });
      lineQ.set(r, q);
    }
  }
  /** the queued lines (merged bust lines first) as the budget frees up */
  async function flushLines() {
    const t = clock();
    for (const [r, q] of lineQ) {
      q.sent = q.sent.filter((x) => t - x < 60e3);
      const per = (S.settings && S.settings.mtt_room_lines_per_min) || DEFAULTS.mtt_room_lines_per_min;
      while (q.q.length && q.sent.length < per) {
        let item = q.q.shift();
        if (item.bust) {
          const more = [item].concat(q.q.filter((x) => x.bust && x.tid === item.tid));
          q.q = q.q.filter((x) => !(x.bust && x.tid === item.tid));
          if (more.length > 1) {
            const M = S.mtts.get(item.tid);
            item = { tid: item.tid, no: item.no, text: `🏁 ${more.length} more players out${M ? ` (${M.live_n} left)` : ""}.`, extra: null };
          }
        }
        q.sent.push(t);
        await emitRaw(item.tid, r, "mtt", Object.assign({ text: item.text, rooms: [r], tid: item.tid, no: item.no }, item.extra || {}));
      }
      if (!q.q.length && !q.sent.length) lineQ.delete(r);
    }
  }
  const say = (M, text, extra) => sayIn(M, roomsFor(M, null), text, extra);
  /** a person's name on an MTT-level surface: "someone" while veiled now (any kind); a room player's Camfrog name, else the site name */
  async function nameFor(M, uid, opts) {
    const p = M.people[uid] || {};
    if (veiledKind(await kindFor(uid, p))) return "someone";
    return opts && opts.web ? p.name || "someone" : (p.via === "room" && p.camfrog ? p.camfrog : p.name || "someone");
  }

  // ── switch / access ──
  async function audienceFor(actor) {
    const st = await loadSettings();
    if (!st.hm_enabled) return { ok: false, why: "🃏 Hold'em on the site is switched off right now." };
    const aud = st.casino_mtt || "off";
    if (aud === "off") return { ok: false, why: "Tournaments aren't open yet." };
    if (aud === "staff") {
      const u = actor && actor.uid ? await userRow(actor.uid) : null;
      if (!u || !isStaff(u)) return { ok: false, why: "Tournaments aren't open yet." };
    }
    return { ok: true };
  }
  /** an active entry: held | playing, or a result less than 15 minutes old */
  async function activeEntry(M, uid) {
    if (!uid) return null;
    const rows = await getQuery("SELECT * FROM casino_mtt_entries WHERE tid = ? AND user_id = ? ORDER BY gen DESC", [M.id, String(uid)]);
    const t = clock();
    return rows.find((r) => r.state === "held" || r.state === "playing" || ((r.state === "busted" || r.state === "spent") && t - (r.updated || 0) < MTT.RESULT_MS)) || null;
  }
  async function canSee(M, uid) {
    const a = await audienceFor(uid ? { uid } : null);
    if (a.ok) return true;
    return !!(uid && (await activeEntry(M, uid)));
  }

  // ── create / edit (admins) ──
  async function nextNo() {
    const r = (await getQuery("SELECT value FROM casino_settings WHERE key = 'mtt_seq'"))[0];
    const n = (Number(r && r.value) || 0) + 1;
    await runQuery(`INSERT INTO casino_settings (key, value, updated, actor) VALUES ('mtt_seq', ?, ?, 'casino')
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated`, [String(n), clock()]);
    return n;
  }
  /** the form -> a validated draft (throws {status: 400, message}) */
  function parseForm(b, st, now, gate) {
    const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
    const title = cleanTitle(b.title);
    if (title.length < 3 || title.length > 60) bad("The title is 3-60 characters.");
    const start_at = Number.isFinite(Number(b.start_at)) && Number(b.start_at) > 1e12 ? Math.floor(Number(b.start_at)) : parseEt(b.start);
    if (!start_at) bad("Pick a start date and time (ET).");
    if (start_at < now + 10 * 60e3) bad("The start is at least 10 minutes from now.");
    if (start_at > now + 30 * 86400e3) bad("The start is at most 30 days from now.");
    let reg = b.reg_opens != null && b.reg_opens !== "" ? parseEt(b.reg_opens) : Number.isFinite(Number(b.reg_opens_at)) && Number(b.reg_opens_at) > 1e12 ? Math.floor(Number(b.reg_opens_at)) : null;
    if (reg == null) reg = Math.max(now, start_at - st.mtt_reg_open_hours * 3600e3);
    if (reg < now - 60e3 || reg > start_at) bad("Registration opens between now and the start.");
    reg = Math.max(now, reg);
    const buyins = TNCFG.parseBuyins(st.mtt_buyins) || TNCFG.parseBuyins(DEFAULTS.mtt_buyins);
    const buyin = Math.floor(Number(b.buyin));
    if (!(buyin === 0 || buyins.includes(buyin))) bad(`The buy-in is one of ${buyins.map(fmt).join(", ")} PAT${gate.ok ? " (or 0: a freeroll)" : ""}.`);
    if (buyin === 0 && !gate.ok) bad(`Freerolls need the guarantee budget - ${BUD.gateText(gate.why)}.`);
    const kind = b.structure === "turbo" ? "turbo" : "standard";
    const start_chips = b.start_chips == null || b.start_chips === "" ? st.mtt_start_chips : intIn(b.start_chips, 500, 100000);
    if (start_chips === null) bad("Starting chips: 500-100,000.");
    const table_size = b.table_size == null || b.table_size === "" ? st.mtt_table_size : Number(b.table_size);
    if (![6, 9].includes(table_size)) bad("Tables are 6- or 9-handed.");
    const max_entries = b.max_entries == null || b.max_entries === "" ? Math.min(180, st.mtt_max_field) : intIn(b.max_entries, 2, st.mtt_max_field);
    const min_entries = b.min_entries == null || b.min_entries === "" ? Math.min(st.mtt_min_entries, max_entries || 2) : intIn(b.min_entries, 2, 500);
    if (max_entries === null) bad(`Max entries: up to ${st.mtt_max_field}.`);
    if (min_entries === null || min_entries > max_entries) bad("Min entries: 2 up to the max.");
    const late_levels = b.late_levels == null || b.late_levels === "" ? st.mtt_late_levels : intIn(b.late_levels, 0, 20);
    if (late_levels === null) bad("Late registration: 0-20 levels.");
    let reentry_max = b.reentry_max == null || b.reentry_max === "" ? 0 : intIn(b.reentry_max, 0, st.mtt_reentry_cap);
    if (reentry_max === null) bad(`Re-entries: 0-${st.mtt_reentry_cap}.`);
    if (buyin === 0) reentry_max = 0;
    const guarantee = b.guarantee == null || b.guarantee === "" ? 0 : intIn(String(b.guarantee).replace(/,/g, ""), 0, 1e9);
    if (guarantee === null) bad("The guarantee is a whole number of PAT.");
    if (guarantee > 0 && !gate.ok) bad(`Guarantees: ${BUD.gateText(gate.why)}.`);
    if (buyin === 0 && !(guarantee > 0)) bad("A freeroll needs a guarantee (its whole prize pool).");
    const rooms = (Array.isArray(b.rooms) ? b.rooms : String(b.rooms || "").split(",")).map((x) => String(x).trim().slice(0, 64)).filter(Boolean);
    if (rooms.length > MTT.MAX_ROOMS) bad(`At most ${MTT.MAX_ROOMS} announcement rooms.`);
    const repeat = ["daily", "weekly"].includes(b.repeat) ? b.repeat : "none";
    const count = repeat === "none" ? 1 : intIn(b.count == null ? 1 : b.count, 1, 8);
    if (count === null) bad("Repeat 1-8 times.");
    return { title, start_at, reg_opens_at: reg, buyin, kind, start_chips, table_size, max_entries, min_entries, late_levels, reentry_max, guarantee,
             rooms: Array.from(new Set(rooms)), repeat, count };
  }
  /** play windows [start, start + bound] of the open tournaments (and `extra` instances already validated in this create) */
  async function windows(extra, notId) {
    const rows = await getQuery("SELECT id, start_at, state FROM casino_mtt WHERE status IN ('scheduled','registering','running','finishing')");
    const out = [];
    for (const r of rows) {
      if (r.id === notId) continue;
      let st; try { st = JSON.parse(r.state); } catch (e) { continue; }
      out.push({ id: r.id, from: r.start_at, to: r.start_at + (st.structure ? st.structure.bound_ms : 0), money: st.money, structure: st.structure, overlay: st.finish && st.finish.overlay });
    }
    return out.concat(extra || []);
  }
  const maxOverlay = (d) => (d.guarantee > 0 ? Math.max(0, d.guarantee - d.min_entries * d.buyin) : 0);
  /** a guarantee's checks (17.2) - every week the play window touches; `others` = the windows so far */
  async function guaranteeChecks(d, snap, others, st, now) {
    const bad = (m) => { throw Object.assign(new Error(m), { status: 400 }); };
    const G = d.guarantee;
    if (!(G > 0)) return;
    const pd = PAY.paid(d.max_entries, snap.money);
    if (G < 1000 || G < 10 * pd) bad(`A guarantee is at least 1,000 PAT and 10 PAT per paid place (${fmt(Math.max(1000, 10 * pd))}).`);
    const X = maxOverlay(d);
    if (X > st.mtt_overlay_cap) bad(`The most it could add (${fmt(X)} PAT) is over the overlay cap (${fmt(st.mtt_overlay_cap)} PAT).`);
    const budget = await BUD.groupBudget(st.mtt_budget_group);
    if (st.mtt_overlay_week_cap > budget) bad(`The weekly overlay cap is over the ${st.mtt_budget_group} budget (${fmt(budget)} PAT).`);
    const from = d.start_at, to = d.start_at + snap.structure.bound_ms;
    const weeks = await BUD.weeksTouched(from, to);
    const cur = await BUD.weekOf(now);
    for (const w of weeks) {
      const touching = others.filter((o) => o.money && o.money.guarantee > 0 && !(o.overlay && o.overlay.state === "paid") && o.from < w.end && o.to >= w.start);
      const sum = touching.reduce((s, o) => s + maxOverlay({ guarantee: o.money.guarantee, min_entries: o.structure.min_entries, buyin: o.money.buyin }), 0);
      if (sum + X > st.mtt_overlay_week_cap) bad(`The guarantees of the week from ${new Date(w.start).toISOString().slice(0, 10)} could add ${fmt(sum + X)} PAT - over the weekly cap (${fmt(st.mtt_overlay_week_cap)}).`);
      if (w.start === cur.start) {
        const room = await BUD.headroom(st.mtt_budget_group, d.start_at + snap.structure.est_ms);
        if (room === null || room - sum < X) bad("This week's incentive budget can't cover the guarantee.");
      }
    }
  }
  function newM(id, no, d, snap, admin, series) {
    return { id, no, series: series || null, status: "scheduled", title: d.title, created_by_user_id: admin.userId, created: clock(), start_at: d.start_at,
             reg_opens_at: d.reg_opens_at, delay_ms: 0, structure: snap.structure, money: snap.money, rooms: d.rooms, stream: S.settings.mtt_stream_final || "take",
             stream_off_by: null, people: {}, seed: { draw_seed: null, draw_commit: null, revealed_at: null }, clock: null, reg_n: 0, entries_n: 0, live_n: 0,
             total_chips: 0, bust_seq: 0, late_open: false, late_closed_at: null, paid: null, plan_bp: null, tables: [], next_no: 1, transit: {},
             h4h: { on: false, round: 0, batch: null, started: false, lines: [] }, final: null, paused: null, dq: {}, finish: null, cancel: null,
             post: { points: false, ach: false, notices: false, stream: false, discord: false, seed: false, reminders_purged: false },
             alerts: { gate_reg_open: false, overlay_risk: false }, said: {}, rev: 0 };
  }
  async function create(admin, body) {
    await ensure();
    const st = await loadSettings(true);
    const now = clock();
    const gate = await BUD.createGate(now, st);
    const d0 = parseForm(body || {}, st, now, gate);
    const series = d0.count > 1 ? "s" + crypto.randomBytes(4).toString("hex") : null;
    const made = [];
    await dbTx(async () => {
      const extra = [];
      for (let i = 0; i < d0.count; i++) {
        const shift = (ms) => (i === 0 ? ms : addEtDays(ms, d0.repeat === "daily" ? i : 7 * i));
        const d = Object.assign({}, d0, { start_at: shift(d0.start_at), reg_opens_at: i === 0 ? d0.reg_opens_at : Math.max(now, shift(d0.start_at) - (d0.start_at - d0.reg_opens_at)) });
        const snap = snapshotOf(d, st);
        const others = await windows(extra);
        const overlapping = others.filter((o) => o.from < d.start_at + snap.structure.bound_ms && o.to > d.start_at);
        if (overlapping.length >= st.mtt_max_running) throw Object.assign(new Error(`${etText(d.start_at)}: ${st.mtt_max_running} tournaments already play then (mtt_max_running).`), { status: 400 });
        await guaranteeChecks(d, snap, others, st, now);
        const id = "m" + crypto.randomBytes(5).toString("hex").slice(0, 9);
        const no = await nextNo();
        const M = newM(id, no, d, snap, admin, series);
        await runQuery(`INSERT INTO casino_mtt (id, no, series, status, title, start_at, reg_opens_at, buyin, fee, guarantee, max_entries, min_entries, table_size, state, rev,
                        created, created_by_user_id, updated) VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
                       [id, no, series, M.title, M.start_at, M.reg_opens_at, M.money.buyin, M.money.fee, M.money.guarantee, M.structure.max_entries,
                        M.structure.min_entries, M.structure.table_size, JSON.stringify(M), now, admin.userId, now]);
        await runQuery("INSERT INTO casino_mtt_log (tid, ts, kind, data) VALUES (?, ?, 'created', ?)", [id, now, JSON.stringify({ by: admin.userId })]);
        made.push(M);
        extra.push({ id, from: M.start_at, to: M.start_at + M.structure.bound_ms, money: M.money, structure: M.structure, overlay: null });
      }
    });
    for (const M of made) { S.mtts.set(M.id, M); log(M, `created by ${admin.userId}`); }
    await audit(admin, "create", made.map((M) => M.id).join(","), null, { title: d0.title, n: made.length, start_at: d0.start_at, buyin: d0.buyin, guarantee: d0.guarantee });
    return { ok: true, ids: made.map((M) => M.id), nos: made.map((M) => M.no) };
  }
  async function audit(admin, action, tid, before, after, reason) {
    try {
      await require("../adminaudit").record({ userId: admin.userId, username: admin.username }, `casino_mtt_${action}`, null, { tid, before: before || null, after: after || null },
                                            reason ? String(reason).slice(0, 200) : null);
    } catch (e) { console.error("[mtt] audit:", e && e.message); }
  }
  async function edit(admin, M, body) {
    const st = await loadSettings(true);
    const now = clock();
    const before = { title: M.title, rooms: M.rooms, start_at: M.start_at, max: M.structure.max_entries };
    if (M.status === "scheduled") {
      const gate = await BUD.createGate(now, st);
      const merged = Object.assign({ title: M.title, start_at: M.start_at, reg_opens_at: M.reg_opens_at, buyin: M.money.buyin, structure: M.structure.kind,
                                     start_chips: M.structure.start_chips, table_size: M.structure.table_size, max_entries: M.structure.max_entries,
                                     min_entries: M.structure.min_entries, late_levels: M.structure.late_levels, reentry_max: M.structure.reentry_max,
                                     guarantee: M.money.guarantee, rooms: M.rooms }, body || {}, { repeat: "none" });
      if (body && body.start) delete merged.start_at;
      if (body && body.reg_opens) delete merged.reg_opens_at;
      const d = parseForm(merged, st, now, gate);
      const snap = snapshotOf(d, st);
      const others = await windows([], M.id);
      if (others.filter((o) => o.from < d.start_at + snap.structure.bound_ms && o.to > d.start_at).length >= st.mtt_max_running) throw Object.assign(new Error("Too many tournaments play then (mtt_max_running)."), { status: 400 });
      await guaranteeChecks(d, snap, others, st, now);
      await txn("edit", M, async () => {
        Object.assign(M, { title: d.title, start_at: d.start_at, reg_opens_at: d.reg_opens_at, rooms: d.rooms, structure: snap.structure, money: snap.money });
      });
    } else if (["registering", "running"].includes(M.status)) {
      const t = body && body.title != null ? cleanTitle(body.title) : M.title;
      if (t.length < 3 || t.length > 60) throw Object.assign(new Error("The title is 3-60 characters."), { status: 400 });
      const rooms = body && body.rooms != null ? (Array.isArray(body.rooms) ? body.rooms : String(body.rooms).split(",")).map((x) => String(x).trim().slice(0, 64)).filter(Boolean) : M.rooms;
      if (rooms.length > MTT.MAX_ROOMS) throw Object.assign(new Error(`At most ${MTT.MAX_ROOMS} announcement rooms.`), { status: 400 });
      await txn("edit", M, async () => { M.title = t; M.rooms = Array.from(new Set(rooms)); });
    } else throw Object.assign(new Error("It can't be edited now."), { status: 409 });
    await audit(admin, "edit", M.id, before, { title: M.title, rooms: M.rooms, start_at: M.start_at, max: M.structure.max_entries });
    return { ok: true };
  }

  // ── registration opens ──
  async function openReg(M, now) {
    const st = await loadSettings();
    if ((st.casino_mtt || "off") === "off" || !st.hm_enabled) return false;
    const regging = Array.from(S.mtts.values()).filter((x) => x.status === "registering").length;
    if (regging >= st.mtt_max_open_reg) return false;
    if (M.money.guarantee > 0 || M.money.freeroll) {
      const g = await BUD.createGate(now, st);
      if (!g.ok) {
        if (!M.alerts.gate_reg_open) {
          M.alerts.gate_reg_open = true;
          await saveMtt(M);
          await alert(M, "gate", `Tournament #${M.no}: the guarantee can't open registration`, `The create gate says ${g.why}; it stays scheduled and is cancelled at its start if nothing changes.`);
          await mlog(M, "gate failed at reg open", { why: g.why });
        }
        return false;
      }
    }
    const d = { kind: M.structure.kind, start_chips: M.structure.start_chips, late_levels: M.structure.late_levels, reentry_max: M.structure.reentry_max,
                table_size: M.structure.table_size, max_entries: M.structure.max_entries, min_entries: M.structure.min_entries, buyin: M.money.buyin, guarantee: M.money.guarantee };
    const snap = snapshotOf(d, st);
    await txn("regopen", M, async () => {
      M.structure = snap.structure;
      M.money = snap.money;
      M.seed = { draw_seed: SEAT.newSeed(), draw_commit: null, revealed_at: null };
      M.seed.draw_commit = SEAT.commitOf(M.seed.draw_seed);
      M.status = "registering";
      M.stream = st.mtt_stream_final;
      await runQuery("INSERT INTO casino_mtt_log (tid, ts, kind, data) VALUES (?, ?, 'reg open', ?)", [M.id, now, JSON.stringify({ commit: M.seed.draw_commit })]);
    });
    log(M, "reg open");
    await afterCommit("regopen", async () => {
      await say(M, `🏆 Registration is open for tournament #${M.no} "${M.title}" - ${etText(M.start_at)}, ${buyinText(M)}${M.money.guarantee ? `, 🛡 ${fmt(M.money.guarantee)} PAT guaranteed` : ""}. !mtt join ${M.no} · ${url(M)}`);
      const w = await getQuery("SELECT user_id FROM casino_mtt_watch WHERE tid = ?", [M.id]);
      for (const r of w) await queueReminder(M, r.user_id, "reg_open", "inbox", now);
      await discord(M, "reg_open");
    });
    return true;
  }
  const buyinText = (M) => (M.money.freeroll ? "freeroll" : `${fmt(M.money.buyin)} + ${fmt(M.money.fee)} PAT`);

  // ── reminders + notices (opt-in; existing paths) ──
  async function queueReminder(M, uid, kind, channel, due, extra) {
    const rref = `mtt:${M.id}:${uid}:${kind}${extra && extra.rev != null ? ":" + extra.rev : ""}${channel === "pepe" ? ":pm" : ""}`;
    await runQuery(`INSERT OR IGNORE INTO casino_mtt_reminders (ref, tid, user_id, kind, channel, due_at, sent_at, dropped, data, created) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
                   [rref, M.id, String(uid), kind, channel, due, JSON.stringify(extra || {}), clock()]);
    // (review) one turned off ("remind off") and on again is re-armed - INSERT OR IGNORE alone kept the dropped row and queued nothing
    await runQuery("UPDATE casino_mtt_reminders SET dropped = NULL, due_at = ?, data = ? WHERE ref = ? AND sent_at IS NULL AND dropped = 'off'",
                   [due, JSON.stringify(extra || {}), rref]);
    return rref;
  }
  function noticeText(M, kind, data) {
    data = data || {};
    if (kind === "reg_open") return { title: `🏆 Registration is open: #${M.no} ${M.title}`, body: `It starts ${etText(M.start_at)}. ${buyinText(M)}.` };
    if (kind === "starting") return { title: `🏆 #${M.no} ${M.title} starts soon`, body: `It starts ${etText(M.start_at)} - be at your seat (you're never stood up; sitting out only blinds you away).` };
    if (kind === "late_closing") return { title: `🏆 Late registration for #${M.no} closes soon`, body: "" };
    if (kind === "cancelled") return { title: `🏆 #${M.no} ${M.title} was cancelled`, body: `#${M.no} was cancelled - your entry (${fmt(data.amount || 0)} PAT) is back in your wallet.${data.why ? ` (${data.why})` : ""}` };
    if (kind === "result") return { title: `🏆 #${M.no} ${M.title}: you finished ${ord(data.place || 0)}`, body:
      `${data.prize ? `${fmt(data.prize)} PAT${data.overlay ? ` (+ ${fmt(data.overlay)} PAT guaranteed part${data.delayed ? " - delayed" : ""})` : ""} - ` : ""}${data.points ? `${fmt(data.points)} leaderboard points. ` : ""}Thanks for playing.` };
    if (kind === "removed") return { title: `🏆 #${M.no}: you were removed`, body: "You were removed - casino ban. Your entry is back in your wallet." };
    if (kind === "delayed") return { title: `🏆 #${M.no} ${M.title} was moved`, body: `It now starts ${etText(M.start_at)}.` };
    if (kind === "pm_start") return { title: "", body: data.text || "" };
    return { title: `🏆 #${M.no}`, body: "" };
  }
  async function processReminders() {
    const t = clock();
    const rows = await getQuery("SELECT * FROM casino_mtt_reminders WHERE sent_at IS NULL AND dropped IS NULL AND due_at <= ? AND channel = 'inbox' ORDER BY due_at LIMIT 200", [t]);
    for (const r of rows) {
      const M = S.mtts.get(r.tid) || (await loadOne(r.tid));
      let drop = null;
      let data = {};
      try { data = JSON.parse(r.data || "{}"); } catch (e) { data = {}; }
      if (!M) drop = "gone";
      else if (r.kind === "starting" && (M.status !== "registering" || (data.start_at && data.start_at !== M.start_at))) drop = M.status === "cancelled" ? "cancelled" : M.status !== "registering" ? "started" : "re-dated";
      else if (r.kind === "reg_open" && M.status !== "registering") drop = "not registering";
      if (drop) { await runQuery("UPDATE casino_mtt_reminders SET dropped = ? WHERE ref = ?", [drop, r.ref]); continue; }
      const n = noticeText(M, r.kind, data);
      await dbTx(async () => {
        const c = await runQuery("UPDATE casino_mtt_reminders SET sent_at = ? WHERE ref = ? AND sent_at IS NULL", [t, r.ref]);
        if (!c || c.changes !== 1) return;
        await require("../inbox").addSafe(r.user_id, { kind: "tourney", title: n.title, body: n.body, link: `/casino/holdem/mtt/${M.id}`, ref: r.ref });
      });
    }
  }
  async function notice(M, uid, kind, data) {
    const n = noticeText(M, kind, data);
    try { await require("../inbox").addSafe(String(uid), { kind: "tourney", title: n.title, body: n.body, link: `/casino/holdem/mtt/${M.id}`, ref: `mtt:${M.id}:${uid}:${kind}${data && data.gen ? ":" + data.gen : ""}` }); }
    catch (e) { console.error("[mtt] notice:", e && e.message); }
  }

  // ── Discord (channel announcements; fire and forget after commit, once per (tid, kind)) ──
  async function discord(M, kind, extra) {
    const st = S.settings || {};
    if (st.mtt_discord !== "on" || !st.mtt_discord_channel || !core.discordBridge) return;
    if (!String(st.mtt_discord_kinds || "").split(",").includes(kind)) return;
    const key = `discord:${M.id}:${kind}`;
    const done = await getQuery("SELECT 1 FROM casino_mtt_log WHERE key = ?", [key]);
    if (done.length) return;
    await mlog(M, "discord", { kind }, key);
    const body = { channel_id: st.mtt_discord_channel, kind, title: M.title.slice(0, 60), no: M.no, start_at: M.start_at, buyin: M.money.buyin, fee: M.money.fee,
                   guarantee: M.money.guarantee, url: `https://publicaccess.tv/casino/holdem/mtt/${M.id}` };
    if (kind === "starting" && st.mtt_discord_role) body.role_id = st.mtt_discord_role;
    if (kind === "winner" && extra && extra.winner) body.winner = String(extra.winner).slice(0, 40);
    Promise.resolve().then(() => core.discordBridge("/casino/tourney", body)).catch((e) => console.error("[mtt] discord:", e && e.message));
  }

  // ── registration ──
  async function gates(actor, M) {
    const a = await audienceFor(actor);
    if (!a.ok) return a.why;
    return null;
  }
  /** register / late registration / re-entry (one transaction) */
  async function register(actor, M, opts) {
    opts = opts || {};
    const uid = String(actor.uid);
    const now = clock();
    await ensure();
    await ESC().init(); await require("../ledger").ensure();
    await clockTick(M, now);
    const why = await gates(actor, M);
    if (why) return R(false, why);
    if (!(M.status === "registering" || (M.status === "running" && M.late_open))) return R(false, M.status === "running" ? `Registration is closed.` : "Registration is closed.");
    if (!(await ESC().live())) return R(false, "Tournaments open once the PAT escrow is live on this site.");
    const u = await userRow(uid);
    if (!u) return R(false, "no account found");
    if (u.casino_banned) return R(false, "🚫 you're banned from the casino.");
    const st = await loadSettings();
    const late = M.status === "running";
    const mine = await getQuery("SELECT * FROM casino_mtt_entries WHERE tid = ? AND user_id = ? ORDER BY gen DESC", [M.id, uid]);
    const cur = mine.find((r) => r.state === "held" || r.state === "playing");
    if (cur) return R(true, "You're already in.");
    if (mine.some((r) => r.dq)) return R(false, "You were disqualified from this tournament.");          // (review: never a re-entry after a DQ)
    const used = mine.filter((r) => r.entry_no != null).length;
    if (late && used > 0 && used - 1 >= M.structure.reentry_max) return R(false, M.structure.reentry_max ? "No re-entries left." : "This one has no re-entries.");
    if (late ? M.entries_n >= M.structure.max_entries : M.reg_n >= M.structure.max_entries) return R(false, "It's full.");
    if (actor.via === "room") {
      const n = (await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_entries WHERE tid = ? AND via = 'room' AND state IN ('held','playing')", [M.id]))[0].n;
      if (n >= st.mtt_room_entrants_max) return R(false, `This one is web-only for more players: ${url(M)}`);
    }
    // anti-collusion over every non-refunded entry of this tournament (the cash tables' rule: dup-linked / same-address accounts)
    const others = (await getQuery("SELECT DISTINCT user_id FROM casino_mtt_entries WHERE tid = ? AND state <> 'refunded' AND user_id <> ?", [M.id, uid])).map((r) => r.user_id);
    const pseudo = { players: M.people, multi: [], eng: { seats: [] } };
    const sw = await HM.seatChecks(pseudo, actor, others, Infinity);
    if (sw) {
      if (pseudo.multi.length) await mlog(M, "same-address refused", { uid });
      if (/linked/.test(sw)) return R(false, "An account linked to yours is already in this tournament.");
      if (/connection/.test(sw)) return R(false, "Another account from your connection is already in this tournament.");
      return R(false, sw);
    }
    if (M.money.freeroll) {
      const auto = await require("../autoaccount").isAutoAccount(uid).catch(() => false);
      const row = (await getQuery("SELECT * FROM users WHERE userId = ?", [uid]))[0] || {};
      const level = Number(row.level) || 0;
      const born = Number(row.created_ms) || (row.createdAt ? Date.parse(String(row.createdAt).replace(" ", "T") + (/Z$/.test(String(row.createdAt)) ? "" : "Z")) : NaN) ||
                   (row.created ? Date.parse(row.created) : NaN);
      const age = Number.isFinite(born) ? (now - born) / 86400e3 : 0;
      if (auto || level < st.mtt_freeroll_min_level || age < st.mtt_freeroll_min_age_days) {
        return R(false, `Freerolls are for members with level ${st.mtt_freeroll_min_level}+ and an account at least ${st.mtt_freeroll_min_age_days} days old.`);
      }
    }
    const t = opAt.get(uid) || 0;
    if (now - t < MTT.OP_GAP_MS && !opts.admin) return R(false, "Slow down a little.");
    opAt.set(uid, now);
    const veil = await kindFor(uid, { via: actor.via, camfrog: actor.camfrog });
    const amount = M.money.buyin + M.money.fee;
    let answer = null, target = null;
    try {
      const ctx = await txn("register", M, async (c) => {
        const g = (await getQuery("SELECT MAX(gen) AS g FROM casino_mtt_entries WHERE tid = ? AND user_id = ?", [M.id, uid]))[0];
        const gen = (Number(g && g.g) || 0) + 1;
        const ekey = `tny:${M.id}:${uid}:enter:${gen}`;
        let hid = null;
        if (amount > 0) {
          if (await ESC().seen(ekey)) throw Object.assign(new Error("key seen"), { code: "E_SEEN" });
          const account = await ESC().accountFor({ userId: uid });
          const h = await ESC().holdInTx({ key: ekey, hid: null, account, amount, ref: ref(M), reason: "tournament entry", cp: `tournament #${M.no}`, via: "site", casino: true });
          hid = h.hid;
          await ESC().record(ekey, { op: "hold", ref: ref(M), amount, via: "casino", result: { ok: true, hid, tid: M.id, gen } });
        }
        M.people[uid] = { name: actor.name || (M.people[uid] || {}).name || u.displayname || u.username, username: u.username, camfrog: actor.camfrog || u.camfrogUsername || null,
                          via: actor.via || "web", room: actor.room || null, iph: actor.iph || (M.people[uid] || {}).iph || null };
        let entryNo = null;
        if (late) {
          entryNo = ++M.entries_n;
          M.gens = M.gens || {};
          M.gens[uid] = gen;
          M.live_n += 1;
          M.total_chips += M.structure.start_chips;
          const lt = SEAT.lateTarget(layout(M), M.structure.table_size);
          let no;
          if (lt.no) no = lt.no;
          else if (lt.unbreak) { const r = M.tables.find((x) => x.no === lt.unbreak); r.state = "live"; no = r.no; c.lines.push(`break cleared ${no}`); }
          else no = newTableInTx(M, c, "late").tourney.no;
          M.transit[uid] = { gen, chips: M.structure.start_chips, to_no: no, from_no: null, since: now, why: "late",
                             qol: { bank: Math.min(st.hm_timebank_secs, st.hm_timebank_max), hands: 0, timeouts: 0, out: false } };
          target = no;
          await lateCheckInTx(M, now, c);
        } else M.reg_n += 1;
        await runQuery(`INSERT INTO casino_mtt_entries (tid, user_id, gen, entry_no, state, amount, hold_id, enter_key, via, room, remind, veiled, created, updated)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                       [M.id, uid, gen, entryNo, late ? "playing" : "held", amount, hid, amount > 0 ? ekey : null, actor.via || "web", actor.room || null,
                        opts.remind ? 1 : 0, veiledKind(veil) ? 1 : 0, now, now]);
        if (opts.remind && !late) await queueReminder(M, uid, "starting", "inbox", M.start_at - st.mtt_remind_mins * 60e3, { start_at: M.start_at });
        const head = mine.some((r) => r.entry_no != null) ? "You're back in" : "You're in";
        answer = R(true, amount > 0
          ? `${head} #${M.no} (${fmt(M.money.buyin)} + ${fmt(M.money.fee)} PAT held; ${late ? "it's under way - prizes are paid when it ends" : "all of it back if you unregister before it starts"}).${late ? ` You'll be seated at table ${target} in a moment.` : ""}`
          : `${head} #${M.no} (a freeroll - nothing held).${late ? ` You'll be seated at table ${target} in a moment.` : ""}`, { mtt: M.id, gen });
        if (opts.act_key) {
          await runQuery("INSERT OR IGNORE INTO casino_actions (key, table_id, userId, response, created) VALUES (?, ?, ?, ?, ?)", [opts.act_key, M.id, uid, JSON.stringify(answer), now]);
        }
        log(M, `${mine.some((r) => r.entry_no != null) ? "re-entry" : "registered"} ${uid} gen ${gen} key ${amount > 0 ? ekey : "(freeroll)"}`);
      });
      await afterCommit("register", async () => {
        for (const l of ctx.lines) log(M, l);
        for (const T of ctx.created) T.dl.next = clock();
        if (target) kick(tableByNo(M, target));
        await afterLateClose(M, ctx);
      });
    } catch (e) {
      if (e && e.code === "E_INSUFFICIENT_PAT") {
        const u2 = await userRow(uid);
        return R(false, `Not enough PAT for this entry (need ${fmt(amount)}, you have ${fmt(u2 ? u2.points_balance : 0)}).`);
      }
      if (e && e.code === "E_CASINO_BANNED") return R(false, "🚫 you're banned from the casino.");
      if (e && e.crash) throw e;
      console.error(`[mtt] ${M.id}: register ${uid} failed:`, e && e.message ? e.message : e);
      return R(false, "Couldn't register right now - nothing was charged.");
    }
    return answer;
  }
  async function unregister(actor, M, opts) {
    opts = opts || {};
    const uid = String(actor.uid);
    await ESC().init();
    if (M.status !== "registering") {
      const e = await entryOf(M.id, uid, ["held", "playing"]);
      if (e && M.status === "running") return R(false, "It has started - you're in; sitting out only blinds you away.");
      return R(false, e ? "It can't be left now." : "You're not registered for this one.");
    }
    const e = await entryOf(M.id, uid, ["held"]);
    if (!e) return R(false, "You're not registered for this one.");
    let answer = null;
    try {
      await txn("unregister", M, async () => {
        await refundEntryInTx(M, e, opts.admin ? "refunded by an admin" : "unregister");
        M.reg_n = Math.max(0, M.reg_n - 1);
        await runQuery("UPDATE casino_mtt_reminders SET dropped = 'unregistered' WHERE tid = ? AND user_id = ? AND sent_at IS NULL AND dropped IS NULL", [M.id, uid]);
        answer = R(true, e.amount > 0 ? `You're out of #${M.no} - ${fmt(e.amount)} PAT back.` : `You're out of #${M.no}.`, { mtt: M.id });
        if (opts.act_key) await runQuery("INSERT OR IGNORE INTO casino_actions (key, table_id, userId, response, created) VALUES (?, ?, ?, ?, ?)", [opts.act_key, M.id, uid, JSON.stringify(answer), clock()]);
        log(M, `unregistered ${uid} gen ${e.gen}`);
      });
      await afterCommit("unregister", async () => { if (opts.admin) await notice(M, uid, "cancelled", { amount: e.amount, why: "an admin refunded your entry", gen: e.gen }); });
    } catch (err) {
      if (err && err.crash) throw err;
      console.error(`[mtt] ${M.id}: unregister ${uid} failed:`, err && err.message ? err.message : err);
      return R(false, "Couldn't unregister right now - your entry is safe; try again.");
    }
    return answer;
  }
  /** in the caller's tx: an entry's hold back to its wallet (once: the refund key, seen()) and the entry refunded */
  async function refundEntryInTx(M, e, why) {
    const rk = `tny:${M.id}:${e.user_id}:refund:${e.gen}`;
    if (e.amount > 0 && e.hold_id && !(await ESC().seen(rk))) {
      await ESC().refundInTx({ key: rk, hid: e.hold_id, reason: "tournament refund" });
      await ESC().record(rk, { op: "refund", ref: ref(M), amount: e.amount, via: "casino", result: { ok: true, why } });
    }
    await runQuery("UPDATE casino_mtt_entries SET state = 'refunded', refund_key = ?, updated = ? WHERE tid = ? AND user_id = ? AND gen = ? AND state IN ('held','playing')",
                   [e.amount > 0 ? rk : null, clock(), M.id, e.user_id, e.gen]);
  }
  async function remind(actor, M, on, opts) {
    const uid = String(actor.uid);
    // (review) only before the start: a running / finished one has nothing to remind of (its watch row answered "we'll tell you when it opens")
    if (!["scheduled", "registering"].includes(M.status)) return R(false, M.status === "running" ? `#${M.no} has already started - nothing to remind you of.` : `#${M.no} is over.`);
    if (opts && opts.telegram != null) {
      try { const TG = require("../telegram"); if (await TG.linkOf(uid)) await TG.setPrefs(uid, { tourney: !!opts.telegram }); } catch (e) { console.error("[mtt] telegram pref:", e && e.message); }
    }
    const e = await entryOf(M.id, uid, ["held", "playing"]);
    const st = await loadSettings();
    if (e) {
      await runQuery("UPDATE casino_mtt_entries SET remind = ? WHERE tid = ? AND user_id = ? AND gen = ?", [on ? 1 : 0, M.id, uid, e.gen]);
      if (on && M.status === "registering") await queueReminder(M, uid, "starting", "inbox", M.start_at - st.mtt_remind_mins * 60e3, { start_at: M.start_at, rev: M.delay_ms ? M.rev : undefined });
      if (!on) await runQuery("UPDATE casino_mtt_reminders SET dropped = 'off' WHERE tid = ? AND user_id = ? AND kind = 'starting' AND sent_at IS NULL", [M.id, uid]);
      return R(true, on ? `🔔 You'll get a reminder ${st.mtt_remind_mins} min before #${M.no} starts.` : "🔕 No reminder for this one.");
    }
    if (on) {
      await runQuery("INSERT OR IGNORE INTO casino_mtt_watch (tid, user_id, created) VALUES (?, ?, ?)", [M.id, uid, clock()]);
      if (M.status === "registering") await queueReminder(M, uid, "starting", "inbox", M.start_at - st.mtt_remind_mins * 60e3, { start_at: M.start_at });
    } else {
      await runQuery("DELETE FROM casino_mtt_watch WHERE tid = ? AND user_id = ?", [M.id, uid]);
      await runQuery("UPDATE casino_mtt_reminders SET dropped = 'off' WHERE tid = ? AND user_id = ? AND sent_at IS NULL", [M.id, uid]);
    }
    return R(true, on ? `🔔 We'll tell you when #${M.no} opens and before it starts.` : "🔕 Reminders off for this one.");
  }

  // ── late registration close (in the caller's tx) ──
  function lateDue(M) {
    if (!M.late_open) return false;
    return M.clock.level >= M.structure.late_levels || M.entries_n >= M.structure.max_entries || M.live_n <= paidOf(M, M.entries_n) + 1;
  }
  async function lateCheckInTx(M, now, c) {
    if (!lateDue(M)) return false;
    M.late_open = false;
    M.late_closed_at = now;
    M.paid = paidOf(M, M.entries_n);
    M.plan_bp = PAY.planBp(M.entries_n, M.money);
    c.lateClosed = true;
    const live = liveRecs(M);
    if (live.length === 1 && !Object.keys(M.transit).length && !M.final) {
      const T = S.tables.get(live[0].id);
      if (T) markFinalInPlace(M, T, c);
    }
    h4hCheck(M, c);
    return true;
  }
  async function afterLateClose(M, c) {
    if (!c || !c.lateClosed) return;
    const P = M.money.buyin * M.entries_n, O = Math.max(0, M.money.guarantee - P);
    log(M, `late closed E=${M.entries_n} pool=${P} paid=${M.paid} overlay=${O}`);
    await mlog(M, "late closed", { E: M.entries_n, pool: P, paid: M.paid, overlay: O });
    await say(M, `⏰ Late registration for #${M.no} is closed: ${fmt(M.entries_n)} entries, ${M.money.guarantee ? `${fmt(Math.max(P, M.money.guarantee))} PAT (guaranteed)` : `${fmt(P)} PAT`} in prizes, ${M.paid} paid places.`);
    if (O > 0 && !M.alerts.overlay_risk) {
      const g = await BUD.spendGate(clock());
      const room = g.ok ? await BUD.headroom(M.money.group, clock()) : null;
      if (!g.ok || room === null || room < O) {
        M.alerts.overlay_risk = true;
        await saveMtt(M);
        await alert(M, "overlay", `Tournament #${M.no}: the guaranteed part (${fmt(O)} PAT) is at risk`, `spend gate ${g.ok ? "ok" : g.why}; headroom ${room == null ? "?" : fmt(room)}.`);
        await mlog(M, "overlay at risk", { O, why: g.ok ? "headroom" : g.why });
      }
    }
    if (c.finalFormed) await afterFinal(M, c.finalFormed);
    if (c.h4h) await h4hLines(M, c.h4h);
  }

  // ── hand-for-hand ──
  function h4hCheck(M, c) {
    const k = liveRecs(M).length;
    if (!M.h4h.on && !M.late_open && M.paid != null && k >= 2 && M.live_n === M.paid + 1) {
      M.h4h = { on: true, round: M.h4h.round || 0, batch: null, started: false, lines: [], since: clock(), pend: [] };
      if (c) c.h4h = "on";
      return "on";
    }
    if (M.h4h.on && (M.live_n <= M.paid || k === 1 || M.final)) {
      const lines = M.h4h.lines || [];
      // (review) the round's batch is KEPT: the first bust of a bubble round turns hand-for-hand off, and the round's hands still running at
      // the other tables bust into the same batch (handEnd picks it by the hand's h4h_round) - ranked by their starting stacks, not by
      // which table finished first; pend = the round's busted, announced once every table of the round has finished its hand
      M.h4h = { on: false, round: M.h4h.round, batch: M.h4h.started ? M.h4h.batch : null, started: false, lines: [], pend: M.h4h.pend || [] };
      if (c) { c.h4h = "off"; c.h4hLines = (c.h4hLines || []).concat(lines); }
      for (const T of liveTables(M)) if (T.tourney.hold === "h4h") { if (c) c.kicks.add(T); }
      return "off";
    }
    return null;
  }
  async function h4hLines(M, what, c) {
    if (what === "on") { log(M, "h4h on"); await say(M, `🫧 #${M.no} is on the bubble - hand-for-hand: every table plays one hand at a time until someone is out.`); }
    if (what === "off") { log(M, "h4h off"); }
    const lines = (c && c.h4hLines) || [];
    if (lines.length) await say(M, lines.join(" "));
  }

  // ── a new table (in the caller's tx; S.tables only after the commit) ──
  function newTableInTx(M, c, why) {
    const [sb, bb] = blindsNow(M);
    const no = M.next_no++;
    const T = HM.newTable({ uid: "mtt:" + M.id, name: `Tournament #${M.no}` }, null, sb, bb, false, { tourney: true });
    T.tourney = { kind: "mtt", id: M.id, no, final: false, hold: null, arrived: {}, last: null, start: null, bust_done: null, h4h_dealt: null };
    T.dl = { turn: null, next: null, idle: null };
    M.tables.push({ no, id: T.id, state: "live", final: false, opened_level: why === "start" ? null : M.clock ? M.clock.level : 0, opened_at: clock() });
    c.created.push(T);
    c.newTables = (c.newTables || []).concat([T]);
    return T;
  }
  /** seat `uid` at T with `chips` (+ the QoL it carried), in the caller's tx */
  function seatAt(M, T, uid, chips, qol, veil) {
    const p = M.people[uid] || { name: uid };
    T.players[uid] = { name: p.name, username: p.username || null, camfrog: p.camfrog || null, via: p.via || "web", iph: p.iph || null, room: p.room || null };
    V.enter(T, { uid, name: p.name, via: p.via, veil: veil === undefined ? undefined : veil }, { sitting: true });
    H.sit(T.eng, uid, p.name, chips);
    const q = HM.qos(T, uid);
    if (qol) Object.assign(q, { bank: qol.bank, hands: qol.hands || 0, timeouts: qol.timeouts || 0, out: !!qol.out, since: null, back: null });
    T.tourney.arrived[uid] = T.eng.hand_no;
  }
  /** take `uid` off T into transit (no PAT), in the caller's tx */
  function leaveInTx(M, T, uid, toNo, why) {
    const e = T.eng;
    const q = (T.qol || {})[uid] || {};
    const chips = e.chips[uid] || 0;
    const gen = (M.gens || {})[uid] || null;
    HM.forgetSeat(T, uid);
    try { H.stand(e, uid); } catch (err) { /* not seated */ }
    M.transit[uid] = { gen, chips, to_no: toNo, from_no: T.tourney.no, since: clock(), why, qol: { bank: q.bank != null ? q.bank : 0, hands: q.hands || 0, timeouts: q.timeouts || 0, out: !!q.out } };
  }
  function closeTableInTx(M, T, c) {
    c.touch(T);
    T.status = "closed";
    T.closed_at = clock();
    T.dl = { turn: null, next: null, idle: null };
    T.turn = null;
    T.tourney.hold = "closed";
    const r = tableRec(M, T);
    if (r) r.state = "closed";
    c.closed = (c.closed || []).concat([T]);
  }
  function markFinalInPlace(M, T, c) {
    c.touch(T);
    T.tourney.final = true;
    const r = tableRec(M, T);
    if (r) r.final = true;
    M.final = { formed_at: clock(), table_id: T.id, user_ids: seatedOf(T).slice(), in_place: true };
    if (M.h4h.on) h4hCheck(M, c);
    c.finalFormed = T;
  }

  // ── the start ──
  async function start(M, why) {
    const now = clock();
    const st = await loadSettings();
    await ESC().init(); await require("../ledger").ensure();
    const held = await entriesOf(M.id, "state = 'held'");
    const banned = [], ok = [];
    for (const e of held) {
      const u = await userRow(e.user_id);
      if (!u || u.casino_banned) banned.push(e); else ok.push(e);
    }
    if (ok.length < M.structure.min_entries) return cancel(M, "not enough players", null);
    const E = ok.length;
    const ids = ok.map((e) => `${e.user_id}:${e.gen}`);
    const order = SEAT.drawOrder(M.seed.draw_seed, "start", ids).map((k) => k.split(":")[0]);
    const groups = SEAT.startSplit(order, M.structure.table_size);
    const absent = new Set();
    if (st.mtt_presence === "on" && S.mttBoot) {
      for (const e of ok) {
        const p = M.people[e.user_id] || {};
        const seenAt = p.via === "room" ? S.mttSeenRoom.get(e.user_id) : S.mttSeen.get(e.user_id);
        const win = p.via === "room" ? MTT.SEEN_ROOM_MS : MTT.SEEN_WEB_MS;
        // after a restart the map is empty: everyone counts as present (fail open) until the window has passed since the boot
        if (now - S.mttBoot < win) continue;
        if (!seenAt || now - seenAt > win) absent.add(e.user_id);
      }
    }
    const veils = {};
    for (const uid of order) veils[uid] = await kindFor(uid, M.people[uid]);
    const ctx = await txn("start", M, async (c) => {
      for (const e of banned) await refundEntryInTx(M, e, "casino ban");
      const entryNo = new Map(ok.map((e, i) => [e.user_id, i + 1]));
      for (const e of ok) await runQuery("UPDATE casino_mtt_entries SET state = 'playing', entry_no = ?, updated = ? WHERE tid = ? AND user_id = ? AND gen = ?",
                                         [entryNo.get(e.user_id), now, M.id, e.user_id, e.gen]);
      M.gens = Object.fromEntries(ok.map((e) => [e.user_id, e.gen]));
      M.entries_n = E; M.live_n = E; M.reg_n = E;
      M.total_chips = E * M.structure.start_chips;
      M.clock = { level: 0, level_started_at: now, level_ends_at: now + M.structure.level_ms, paused_at: null, pause_ms: 0, beat: now, gaps: [] };
      M.late_open = M.structure.late_levels > 0 && E < M.structure.max_entries;
      for (const g of groups) {
        const T = newTableInTx(M, c, "start");
        for (const uid of g) {
          seatAt(M, T, uid, M.structure.start_chips, null, veils[uid]);
          if (absent.has(uid)) { const q = HM.qos(T, uid); q.out = true; q.since = null; }
        }
        T.eng.button = null;
        await HM.commitNext(T);
      }
      M.status = "running";
      if (!M.late_open) {
        M.paid = paidOf(M, E); M.plan_bp = PAY.planBp(E, M.money); M.late_closed_at = now;
        if (groups.length === 1) markFinalInPlace(M, c.created[0], c);
      } else await lateCheckInTx(M, now, c);
      await runQuery("INSERT INTO casino_mtt_log (tid, ts, kind, data) VALUES (?, ?, 'start', ?)", [M.id, now, JSON.stringify({ E, tables: groups.length, absent: absent.size, banned: banned.length })]);
      c.absent = absent;
    });
    log(M, `start E=${E} tables=${groups.length} absent=${absent.size}`);
    for (const T of ctx.created) T.dl.next = now + M.structure.next_secs * 1000;
    await afterCommit("start", async () => {
      for (const e of banned) await notice(M, e.user_id, "removed", { gen: e.gen });
      const P = M.money.buyin * E;
      await say(M, `🏆 Tournament #${M.no} "${M.title}" has started: ${fmt(E)} entries at ${groups.length} table${groups.length === 1 ? "" : "s"}, ${M.money.guarantee ? `🛡 ${fmt(Math.max(P, M.money.guarantee))} PAT guaranteed` : `${fmt(P)} PAT in prizes`}. ${url(M)}`);
      for (const T of ctx.created) {
        for (const uid of seatedOf(T)) {
          const p = M.people[uid] || {};
          if (p.via !== "room") continue;
          const text = `🏆 Tournament #${M.no} has started - you're at table ${T.tourney.no}${ctx.absent.has(uid) ? " (sitting out until you type !sitin)" : ""}. ${tableUrl(T)}`;
          await queueReminder(M, uid, "pm_start", "pepe", now, { text, table: T.id });
        }
      }
      await discord(M, "starting");
      if (ctx.finalFormed) await afterFinal(M, ctx.finalFormed);
      await afterLateClose(M, ctx);
    });
    return true;
  }

  // ── cancel / void ──
  async function cancel(M, reason, by, opts) {
    opts = opts || {};
    const now = clock();
    await ESC().init(); await require("../ledger").ensure();
    if (!["scheduled", "registering", "running"].includes(M.status) && !(opts.void && M.status === "finishing")) return { ok: false, why: "state" };
    const rows = await entriesOf(M.id, "state IN ('held','playing','busted')");
    let back = 0, n = 0;
    const cut = [];
    try {
      const ctx = await txn(opts.void ? "void" : "cancel", M, async (c) => {
        if (await ESC().seen(`tny:${M.id}:finish`)) throw Object.assign(new Error("already settled"), { code: "E_SETTLED" });
        for (const e of rows) {
          const rk = `tny:${M.id}:${e.user_id}:refund:${e.gen}`;
          if (e.amount > 0 && e.hold_id) {
            const h = (await getQuery("SELECT state FROM escrow_holds WHERE id = ?", [e.hold_id]))[0];
            if (h && h.state === "held" && !(await ESC().seen(rk))) {
              await ESC().refundInTx({ key: rk, hid: e.hold_id, reason: "tournament refund" });
              await ESC().record(rk, { op: "refund", ref: ref(M), amount: e.amount, via: "casino", result: { ok: true, why: reason } });
              back += e.amount;
            }
          }
          await runQuery("UPDATE casino_mtt_entries SET state = 'refunded', refund_key = ?, updated = ? WHERE tid = ? AND user_id = ? AND gen = ?",
                         [e.amount > 0 ? rk : null, now, M.id, e.user_id, e.gen]);
          n += 1;
        }
        const ck = `tny:${M.id}:cancel`;
        if (!(await ESC().seen(ck))) await ESC().record(ck, { op: "refund", ref: ref(M), amount: back, via: "casino", result: { ok: true, why: reason, by: by || null, n } });
        for (const T of liveTables(M)) { if (T.eng.hand_active || T.hand) cut.push(T); closeTableInTx(M, T, c); }
        M.transit = {};
        await runQuery("UPDATE casino_mtt_reminders SET dropped = 'cancelled' WHERE tid = ? AND sent_at IS NULL AND dropped IS NULL", [M.id]);
        M.status = "cancelled";
        M.cancel = { by: by || null, reason, at: now };
        if (M.finish) M.finish.state = "voided";
        M.seed.revealed_at = now;
        await runQuery("INSERT INTO casino_mtt_log (tid, ts, kind, data) VALUES (?, ?, ?, ?)", [M.id, now, opts.void ? "void" : "cancel", JSON.stringify({ reason, by, refunds: n, total: back })]);
      });
      log(M, `${opts.void ? "void" : "cancel"} (${reason}) refunds=${n} total=${back}`);
      await afterCommit("cancel", async () => {
        for (const T of cut) {
          if (T.hand) {
            await runQuery("UPDATE casino_rounds SET server_seed = ?, shoe = ?, revealed = ? WHERE table_id = ? AND round_no = ?",
                           [T.hand.seed, JSON.stringify(T.hand.deck), clock(), T.id, T.hand.no]).catch(() => {});
            T.hand = null;
            await save(T);
          }
        }
        for (const T of ctx.closed || []) streamGone(T.id);
        for (const e of rows) await notice(M, e.user_id, "cancelled", { amount: e.amount, why: reason, gen: e.gen });
        await say(M, `🛑 Tournament #${M.no} "${M.title}" was cancelled (${reason}) - every entry was refunded in full.`);
      });
    } catch (e) {
      if (e && e.crash) throw e;
      console.error(`[mtt] ${M.id}: cancel failed:`, e && e.message ? e.message : e);
      return { ok: false, why: e && e.code === "E_SETTLED" ? "settled" : "failed" };
    }
    return { ok: true, n, back };
  }

  // ── the boundary pipeline (holdem.js beginHand -> ROUTE.beforeDeal, under the casino's mutex) ──
  async function beforeDeal(T) {
    const M = S.mtts.get(T.tourney.id);
    if (!M) {
      if (!stoppedLogged.has(T.id)) { stoppedLogged.add(T.id); console.error(`[mtt] table ${T.id}: its tournament ${T.tourney.id} isn't loaded - stopped`); }
      return hold(T, "stopped");
    }
    if (T.status !== "open") return { deal: false, hold: "closed" };
    if (wrapPending(T)) return hold(T, "wait");               // (review) the last hand's wrap-up first (tableTick "wrap")
    const now = clock();
    advanceClock(M, now);
    if (M.status !== "running") return hold(T, "stopped");
    if (M.paused) return hold(T, "pause");
    const rec = tableRec(M, T);
    if (!rec || rec.state === "closed") return hold(T, "closed");
    try {
      // 1. a disqualification queued for a seat here
      for (const uid of Object.keys(M.dq || {})) {
        if (M.dq[uid].applied) continue;
        if (T.eng.seats.includes(uid)) await applyDq(M, uid);
      }
      if (M.status !== "running") return hold(T, "stopped");
      // 2. the final table
      const lay = layout(M);
      if (SEAT.finalDue(M.late_open, M.live_n, lay, M.structure.table_size) && !M.final) {
        hold(T, "final");
        if (allHeld(M, ["final"])) return await formFinal(M, T);
        return { deal: false, hold: "final" };
      }
      if (!M.late_open && !M.final && liveRecs(M).length === 1 && !Object.keys(M.transit).length) {
        const ctx = await txn("finalmark", M, async (c) => markFinalInPlace(M, T, c));
        await afterFinal(M, T, ctx);
      }
      // 3. breaking, 4. balancing (not while hand-for-hand is on)
      if (!M.h4h.on) {
        const br = await breakStep(M, T);
        if (br) return br;
        await balanceStep(M, T);
      }
      // 5. hand-for-hand
      if (M.h4h.on) {
        if (!M.h4h.started || T.tourney.h4h_dealt === M.h4h.round) {
          hold(T, "h4h");
          if (allHeld(M, ["h4h", "wait"])) return await startRound(M, T);
          return { deal: false, hold: "h4h" };
        }
      }
      // 6. arrivals + the blind plan (arrivals seated since the last deal still take the big blind first: T.tourney.pending)
      const pl = await arrivals(M, T);
      // 7. the blinds of the clock (8. fewer than two players: wait)
      const e = T.eng;
      const [sb, bb] = blindsNow(M);
      e.bb = bb;
      e.sb = sb;
      if (seatedOf(T).length < 2) {
        const h = hold(T, "wait");
        if (M.h4h.on && M.h4h.started && allHeld(M, ["h4h", "wait"])) return await startRound(M, T);
        return h;
      }
      e.seats = pl.ring.concat(e.seats.filter((k) => !pl.ring.includes(k)));
      e.button = pl.fresh ? (e.button && pl.ring.includes(e.button) && T.tourney.last ? e.button : null) : pl.button;
      T.tourney.dead_pending = !!pl.deadSb;
      if (pl.deadSb) e.sb = 0;
      // 9. chip conservation
      const inPlay = chipsInPlay(M);
      if (inPlay !== M.total_chips) {
        await systemPause(M, `chips ${inPlay} != ${M.total_chips} at table ${T.tourney.no}`);
        e.sb = sb;
        return hold(T, "pause");
      }
      // 10. the start record (pre-blind stacks) - extended by dealt() once the engine has posted the blinds
      T.tourney.start = { hand_no: e.hand_no + 1, stacks: Object.fromEntries(seatedOf(T).map((k) => [k, e.chips[k]])) };
      T.tourney.hold = null;
      return { deal: true };
    } catch (err) {
      if (err && err.crash) throw err;
      console.error(`[mtt] ${M.id} table ${T.tourney.no}: the boundary failed:`, err && err.message ? err.message : err);
      return hold(T, err && err.restoreFailed ? "stopped" : "wait");
    }
  }
  /** every live table between hands and held with one of `kinds` (a table that can't deal - fewer than two players, no hand - counts) */
  function allHeld(M, kinds) {
    for (const T of liveTables(M)) {
      if (T.eng.hand_active || T.hand) return false;
      if (kinds.includes(T.tourney.hold)) continue;
      if (seatedOf(T).length < 2 && !inbound(M, T.tourney.no) && T.tourney.hold) continue;
      return false;
    }
    return true;
  }
  /** 6. seat the transit aimed at T (one transaction) -> the blind plan for the next hand */
  async function arrivals(M, T) {
    const no = T.tourney.no;
    const list = Object.entries(M.transit || {}).filter(([, x]) => x.to_no === no).sort((a, b) => a[1].since - b[1].since || (a[0] < b[0] ? -1 : 1));
    const seated = seatedOf(T);
    const pend = (T.tourney.pending || []).filter((u) => seated.includes(u));
    const base = seated.filter((u) => !pend.includes(u));
    const incoming = pend.concat(list.map(([u]) => u));
    const pl = SEAT.blindPlan(base, T.tourney.last, incoming);
    if (!list.length) return pl;
    const veils = {};
    for (const [uid] of list) veils[uid] = await kindFor(uid, M.people[uid]);
    const ctx = await txn("arrival", M, async (c) => {
      c.touch(T);
      for (const [uid, x] of list) {
        seatAt(M, T, uid, x.chips, x.qol, veils[uid]);
        delete M.transit[uid];
        c.lines.push(`seated ${uid} at table ${no} (${x.why})`);
      }
      T.eng.seats = pl.ring.concat(T.eng.seats.filter((k) => !pl.ring.includes(k)));
      T.tourney.pending = incoming;
    });
    for (const l of ctx.lines) log(M, l);
    return pl;
  }
  /** 3. breaking (TDA: the shortest table; re-checked at the breaker's own boundary) -> a hold answer when T broke, else null */
  async function breakStep(M, T) {
    const rec = tableRec(M, T);
    const slack = M.late_open ? M.structure.break_slack : 0;
    const lay = layout(M);
    const cond = SEAT.shouldBreak(M.live_n, lay, M.structure.table_size, slack);
    if (rec.state === "breaking") {
      if (!cond) {
        await txn("break", M, async () => { rec.state = "live"; });
        log(M, `break cleared ${rec.no}`);
        return null;
      }
      return breakTable(M, T);
    }
    if (cond && !M.tables.some((r) => r.state === "breaking")) {
      const no = SEAT.breaker(lay, { lateOpen: M.late_open, level: M.clock.level });
      if (no == null) return null;
      const target = tableByNo(M, no);
      await txn("break", M, async () => {
        const r = M.tables.find((x) => x.no === no);
        r.state = "breaking";
        // transit aimed at the breaker goes elsewhere
        for (const x of Object.values(M.transit)) {
          if (x.to_no !== no) continue;
          const t2 = SEAT.minTable(layout(M), no);
          if (t2) x.to_no = t2.no;
        }
      });
      if (no === T.tourney.no) return breakTable(M, T);
      kick(target);
    }
    return null;
  }
  async function breakTable(M, T) {
    const players = seatedOf(T);
    const keys = players.map((u) => `${u}:${(M.gens || {})[u] || 1}`).sort();
    const order = SEAT.drawOrder(M.seed.draw_seed, `break:${T.tourney.no}:${players.length}`, keys).map((k) => k.split(":")[0]);
    const lay = layout(M);
    const plan = SEAT.assignBreak(order, lay, T.tourney.no);
    if (!plan) return hold(T, "wait");
    const ctx = await txn("break", M, async (c) => {
      c.touch(T);
      for (const [uid, no] of plan) { leaveInTx(M, T, uid, no, "break"); c.kicks.add(tableByNo(M, no)); }
      closeTableInTx(M, T, c);
    });
    log(M, `break table ${T.tourney.no}`);
    await afterCommit("break", async () => {
      for (const K of ctx.kicks) kick(K);
      for (const K of ctx.closed || []) streamGone(K.id);
      const to = Array.from(new Set(plan.map((p) => p[1]))).sort((a, b) => a - b);
      await say(M, `🔀 Table ${T.tourney.no} of #${M.no} is broken - its players move to table${to.length === 1 ? "" : "s"} ${to.join(", ")}.`);
      for (const [uid, no] of plan) await sayIn(M, roomsFor(M, uid), `🔀 @${await nameFor(M, uid)}, you're moving to table ${no} (#${M.no}).`);
    });
    return { deal: false, hold: "closed" };
  }
  /** 4. balancing: while T is a fullest table and tables differ by 2+, the player due the big blind next moves to the shortest table */
  async function balanceStep(M, T) {
    const moves = [];
    const lay0 = layout(M);
    if (SEAT.balanceTarget(lay0, T.tourney.no) == null) return;
    const ctx = await txn("move", M, async (c) => {
      c.touch(T);
      for (let guard = 0; guard < 20; guard++) {
        const lay = layout(M);
        const to = SEAT.balanceTarget(lay, T.tourney.no);
        if (to == null) break;
        const order = SEAT.bbOrder(seatedOf(T), T.tourney.last);
        const mover = order.find((u) => (T.tourney.arrived[u] == null ? -1 : T.tourney.arrived[u]) < T.eng.hand_no);
        if (!mover) break;
        leaveInTx(M, T, mover, to, "balance");
        moves.push([mover, to]);
        c.kicks.add(tableByNo(M, to));
      }
    });
    for (const [uid, to] of moves) log(M, `move ${uid} ${T.tourney.no}->${to} (balance)`);
    await afterCommit("move", async () => {
      for (const K of ctx.kicks) kick(K);
      for (const [uid, to] of moves) await sayIn(M, roomsFor(M, uid), `🔀 @${await nameFor(M, uid)}, you're moving to table ${to} (#${M.no}).`);
    });
  }
  /** formFinal: every live table between hands, late registration closed, everyone fits one table -> a new table, a fresh draw */
  async function formFinal(M, T) {
    const people = [];
    for (const L of liveTables(M)) for (const uid of seatedOf(L)) people.push({ uid, chips: L.eng.chips[uid], qol: Object.assign({}, (L.qol || {})[uid] || {}) });
    for (const [uid, x] of Object.entries(M.transit || {})) people.push({ uid, chips: x.chips, qol: x.qol });
    const keys = people.map((p) => `${p.uid}:${(M.gens || {})[p.uid] || 1}`).sort();
    const order = SEAT.drawOrder(M.seed.draw_seed, "final", keys).map((k) => k.split(":")[0]);
    const byUid = Object.fromEntries(people.map((p) => [p.uid, p]));
    const veils = {};
    for (const uid of order) veils[uid] = await kindFor(uid, M.people[uid]);
    let F = null;
    const ctx = await txn("final", M, async (c) => {
      for (const L of liveTables(M)) {
        c.touch(L);
        for (const uid of seatedOf(L).slice()) { HM.forgetSeat(L, uid); try { H.stand(L.eng, uid); } catch (e) { /* not seated */ } }
        closeTableInTx(M, L, c);
      }
      M.transit = {};
      F = newTableInTx(M, c, "final");
      F.tourney.final = true;
      tableRec(M, F).final = true;
      for (const uid of order) seatAt(M, F, uid, byUid[uid].chips, byUid[uid].qol, veils[uid]);
      F.eng.button = null;
      await HM.commitNext(F);
      M.final = { formed_at: clock(), table_id: F.id, user_ids: order.slice(), in_place: false };
      if (M.h4h.on) h4hCheck(M, c);
      c.finalFormed = F;
    });
    log(M, `final formed (${order.length} players, redrawn)`);
    F.dl.next = clock() + M.structure.next_secs * 1000;
    await afterCommit("final", async () => {
      for (const K of ctx.closed || []) streamGone(K.id);
      await afterFinal(M, F, ctx);
    });
    return { deal: false, hold: "closed" };
  }
  async function afterFinal(M, F) {
    await say(M, `🏆 Final table of #${M.no}: ${seatedOf(F).length} players. ${tableUrl(F)}`);
    await mlog(M, "final", { table: F.id, in_place: !!(M.final && M.final.in_place) });
    await discord(M, "final");
    if (M.stream !== "off" && !M.stream_off_by) {
      const r = await streamTake(F, M.stream, null, M);
      if (r && r.line) await say(M, r.line);
    }
  }
  /** hand-for-hand: every table between hands - the next round (one hand at each table), the round's busts share one batch */
  async function startRound(M, T) {
    if (M.live_n <= M.paid) {
      const ctx = await txn("h4h", M, async (c) => { h4hCheck(M, c); });
      for (const L of liveTables(M)) kick(L);
      await h4hLines(M, "off", ctx);
      return { deal: false, hold: null };
    }
    const ctx = await txn("h4h", M, async (c) => {
      const lines = M.h4h.lines || [];
      M.h4h.round += 1;
      M.h4h.batch = ++M.bust_seq;
      M.h4h.started = true;
      M.h4h.lines = [];
      c.h4hLines = lines;
      for (const L of liveTables(M)) { c.touch(L); L.tourney.hold = null; L.dl.next = clock() + M.structure.next_secs * 1000; }
    });
    log(M, `h4h round ${M.h4h.round}`);
    await afterCommit("h4h", async () => { if (ctx.h4hLines && ctx.h4hLines.length) await say(M, ctx.h4hLines.join(" ")); });
    // balance between rounds (tables held: the moves land at the next boundaries)
    for (const L of liveTables(M)) { if (SEAT.balanceTarget(layout(M), L.tourney.no) != null) await balanceStep(M, L); }
    return { deal: false, hold: null };
  }
  async function systemPause(M, why) {
    if (M.paused) return;
    await txn("pause", M, async () => { M.paused = { by: "system", at: clock(), why }; M.clock.paused_at = clock(); });
    console.error(`[mtt] ${M.id} #${M.no} INVARIANT ${why} - paused`);
    await mlog(M, "invariant", { why });
    await alert(M, "invariant", `Tournament #${M.no} paused: ${why}`, "No PAT moved; every table holds. Check the tables, then resume or void and refund.");
  }

  // ── dealt / the hand's end (holdem.js) ──
  function dealt(T, events) {
    const M = S.mtts.get(T.tourney.id);
    const e = T.eng;
    const st = T.tourney.start || { hand_no: e.hand_no, stacks: {} };
    const dead = !!T.tourney.dead_pending;
    Object.assign(st, { hand_no: e.hand_no, button: e.button, sb_key: e.sb_key, bb_key: e.bb_key, order: e.players.slice(), dead_sb: dead,
                        h4h_round: M && M.h4h.on && M.h4h.started ? M.h4h.round : null, out: e.players.filter((k) => !!(T.qol && T.qol[k] && T.qol[k].out)) });
    T.tourney.start = st;
    T.tourney.last = { hand_no: e.hand_no, button: e.button, sb_key: e.sb_key, bb_key: e.bb_key, order: e.players.slice() };
    if (st.h4h_round != null) T.tourney.h4h_dealt = st.h4h_round;
    T.tourney.dead_pending = false;
    T.tourney.pending = [];
    if (M) {
      const [sb] = blindsNow(M);
      e.sb = sb;
      if (dead && Array.isArray(events)) {
        const hs = events.find((x) => x.t === "hand_start");
        if (hs) hs.sb = sb;
        const i = events.findIndex((x) => x.t === "blind" && x.kind === "SB" && !x.amount);
        if (i >= 0) events.splice(i, 1);
      }
    }
  }
  const outAtDeal = (T, uid) => !!(T.tourney.start && (T.tourney.start.out || []).includes(uid));
  function outNow(T, uid) { const s = T.tourney.start; if (s && !(s.out || []).includes(uid)) s.out = (s.out || []).concat([uid]); }

  async function handEnd(T, ev) {
    const M = S.mtts.get(T.tourney.id);
    const e = T.eng;
    if (!M) return save(T);
    if (T.tourney.bust_done === e.hand_no) return save(T);
    crash("mtt:handend:before-wrapup");
    const now = clock();
    const busted = e.seats.filter((k) => !((e.chips[k] || 0) > 0));
    const st = T.tourney.start || {};
    const veils = {};
    for (const uid of busted) veils[uid] = await kindFor(uid, M.people[uid]);
    const rows = {};
    for (const uid of busted) rows[uid] = await entryOf(M.id, uid, ["playing"]);
    let seq = null;
    // (review) a hand dealt in a hand-for-hand round busts into the round's batch - also after the round's first bust turned it off
    const roundHand = st.h4h_round != null && st.h4h_round === M.h4h.round && !!M.h4h.batch;
    const ctx = await txn("handend", M, async (c) => {
      c.touch(T);
      advanceClock(M, now);
      if (busted.length) {
        seq = roundHand ? M.h4h.batch : ++M.bust_seq;
        if (roundHand) M.h4h.pend = (M.h4h.pend || []).concat(busted);
        const order = st.order || e.players || [];
        const n = order.length, bi = order.indexOf(st.button);
        for (const uid of busted) {
          const i = order.indexOf(uid);
          const oc = i < 0 ? n : (i - bi - 1 + 2 * n) % n;
          const r = rows[uid];
          if (r) await runQuery(`UPDATE casino_mtt_entries SET state = 'busted', bust_seq = ?, bust_stack = ?, bust_table_no = ?, bust_oc = ?, veiled = MAX(veiled, ?), updated = ?
                                 WHERE tid = ? AND user_id = ? AND gen = ? AND state = 'playing'`,
                                 [seq, Number((st.stacks || {})[uid]) || 0, T.tourney.no, oc, veiledKind(veils[uid]) ? 1 : 0, now, M.id, uid, r.gen]);
          HM.forgetSeat(T, uid);
          try { H.stand(e, uid); } catch (err) { /* not seated */ }
          c.lines.push(`bust ${uid} gen ${r ? r.gen : "?"} seq ${seq} stack ${(st.stacks || {})[uid] || 0} table ${T.tourney.no}`);
        }
        M.live_n -= busted.length;
        await lateCheckInTx(M, now, c);
        if (!c.lateClosed) h4hCheck(M, c);
      }
      // (tests: "mtt:handend:running-live1" = an older build's commit without the finishing flag - recovery sets it)
      if (M.live_n === 1 && M.status === "running" && S.hooks.crash !== "mtt:handend:running-live1") {
        M.status = "finishing";
        M.finish = { state: "pending", key: `tny:${M.id}:finish`, retry_at: null, tries: 0 };
        c.finishing = true;
      }
      T.tourney.bust_done = e.hand_no;
      T.dl.next = c.finishing ? null : now + M.structure.next_secs * 1000;
      T.tourney.hold = null;
    });
    for (const l of ctx.lines) log(M, l);
    wrapAt.delete(T.id);
    await afterCommit("handend", async () => {
      // (review) a round's bust lines wait until every table of the round has finished its hand (the places are known only then)
      if (roundHand) { if (!roundOpen(M, st.h4h_round)) await flushRound(M); }
      else if (busted.length) await bustLines(M, busted, seq);
      await afterLateClose(M, ctx);
      if (ctx.h4h && !ctx.lateClosed) await h4hLines(M, ctx.h4h, ctx);
      for (const K of ctx.kicks) kick(K);
    });
    if (ctx.finishing) await finish(M);
  }
  /** a hand of round `round` still running at some live table */
  const roundOpen = (M, round) => liveTables(M).some((L) => L.eng.hand_active && L.tourney.start && L.tourney.start.h4h_round === round);
  /** the round is over everywhere: its busted (M.h4h.pend) announced with their places, once */
  async function flushRound(M) {
    const uids = (M.h4h && M.h4h.pend) || [];
    if (!uids.length) return;
    M.h4h.pend = [];
    await saveMtt(M);
    await bustLines(M, uids, M.h4h.batch);
  }
  async function bustLines(M, uids, seq) {
    const t = clock();
    if (M.late_open || M.paid == null) {
      for (const uid of uids) {
        const nm = await nameFor(M, uid);
        const text = `🏁 @${nm} is out (${fmt(M.live_n)} left).`;
        await sayIn(M, roomsFor(M, uid), text, { bust: true });
      }
      return;
    }
    // places are known: the batch is complete
    const pr = await projectedPlaces(M, seq);
    for (const g of pr) {
      if (g.dq) continue;                                         // (review) a disqualified entry in the batch keeps its place, no line
      const names = [];
      for (const uid of g.uids) names.push(await nameFor(M, uid));
      const range = g.from === g.to ? ord(g.from) : `${ord(g.from)}-${ord(g.to)}`;
      const each = g.uids.length > 1 ? " each" : "";
      const text = g.uids.length > 1
        ? `🏁 ${names.join(" and ")} finish tied ${range}${g.amount ? ` - ${fmt(g.amount)} PAT${each}, paid at the end` : ""}.`
        : `🏁 @${names[0]} finished ${range}${g.amount ? ` - ${fmt(g.amount)} PAT, paid at the end` : ""}.`;
      if (M.h4h.on) { M.h4h.lines = (M.h4h.lines || []).concat([text]); continue; }
      for (const uid of g.uids) await sayIn(M, roomsFor(M, uid), text, { bust: true });
      await say(M, text, { bust: true });
    }
    void t;
  }
  /** the places of one bust batch, known once late registration is closed -> [{uids, from, to, amount (each, escrow + overlay)}] */
  async function projectedPlaces(M, seq) {
    const rows = await entriesOf(M.id, "bust_seq = ? AND entry_no IS NOT NULL", [seq]);
    const higher = (await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_entries WHERE tid = ? AND entry_no IS NOT NULL AND (state = 'playing' OR bust_seq > ?)", [M.id, seq]))[0].n;
    const P = M.money.buyin * M.entries_n, O = Math.max(0, M.money.guarantee - P);
    const esc = PAY.split(P, M.plan_bp), ovl = PAY.split(O, M.plan_bp);
    const amounts = esc.map((x, i) => x + (ovl[i] || 0));
    const groups = new Map();
    for (const r of rows) { const k = r.bust_stack; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    const out = [];
    let place = higher + 1;
    for (const k of Array.from(groups.keys()).sort((a, b) => b - a)) {
      const g = groups.get(k).sort(PAY.ocCmp);
      const pot = g.reduce((s, _r, i) => s + (amounts[place + i - 1] || 0), 0);
      out.push({ uids: g.map((r) => r.user_id), from: place, to: place + g.length - 1, amount: Math.floor(pot / g.length), dq: g.every((r) => !!r.dq) });
      place += g.length;
    }
    return out;
  }

  // ── disqualification (before the money) ──
  async function applyDq(M, uid) {
    const now = clock();
    const r = await entryOf(M.id, uid, ["playing"]);
    if (!r) { await txn("dq", M, async () => { delete M.dq[uid]; }); return; }
    const w = whereIs(M, uid);
    if (w && w.T && w.T.eng.hand_active && w.T.eng.seats.includes(uid)) return;     // at the next boundary of their table
    // (review) re-checked when it is applied: a DQ queued during a hand is never applied once the bubble has burst (the admin decides)
    if (!M.late_open && M.paid != null && M.live_n <= M.paid) {
      const q = M.dq[uid] || {};
      await txn("dq", M, async () => { delete M.dq[uid]; });
      log(M, `dq ${uid} dropped (past the bubble)`);
      await mlog(M, "dq dropped", { uid, by: q.by || null, reason: q.reason || null });
      await alert(M, "dq_dropped", `Tournament #${M.no}: a disqualification was NOT applied - the bubble burst first`,
                  `Queued by ${q.by || "?"} (${String(q.reason || "")}) during a hand; the player is in the money now and keeps playing. Pause the tournament and decide.`);
      return;
    }
    const ctx = await txn("dq", M, async (c) => {
      let chips = 0;
      if (w && w.T && w.T.eng.seats.includes(uid)) {
        c.touch(w.T);
        chips = w.T.eng.chips[uid] || 0;
        HM.forgetSeat(w.T, uid);
        try { H.stand(w.T.eng, uid); } catch (e) { /* not seated */ }
      } else if (M.transit[uid]) { chips = M.transit[uid].chips; delete M.transit[uid]; }
      M.total_chips -= chips;
      // (review) during a hand-for-hand round: the round's batch with stack 0 - below every bust of that round (never the bubble prize)
      const seq = M.h4h.on && M.h4h.started && M.h4h.batch ? M.h4h.batch : ++M.bust_seq;
      await runQuery("UPDATE casino_mtt_entries SET state = 'busted', dq = 1, bust_seq = ?, bust_stack = 0, bust_table_no = ?, bust_oc = 0, updated = ? WHERE tid = ? AND user_id = ? AND gen = ? AND state = 'playing'",
                     [seq, w ? w.no : 0, now, M.id, uid, r.gen]);
      M.live_n -= 1;
      M.dq[uid].applied = now;
      await lateCheckInTx(M, now, c);
      if (!c.lateClosed) h4hCheck(M, c);
      if (M.live_n === 1) { M.status = "finishing"; M.finish = { state: "pending", key: `tny:${M.id}:finish`, retry_at: null, tries: 0 }; c.finishing = true; }
    });
    log(M, `dq ${uid}`);
    await afterCommit("dq", async () => {
      await mlog(M, "dq", { uid, by: M.dq[uid].by, reason: M.dq[uid].reason });
      await alert(M, "dq", `Tournament #${M.no}: a player was disqualified`, String(M.dq[uid].reason || ""));
      await afterLateClose(M, ctx);
    });
    if (ctx.finishing) await finish(M);
  }

  // ── the finish: ONE escrow settle ──
  async function finishPlan(M) {
    const all = await entriesOf(M.id);
    const counted = all.filter((e) => e.entry_no != null && e.state !== "refunded");
    const E = M.entries_n;
    const why = [];
    if (M.paused && M.paused.by === "system") why.push("E_PAUSED");
    const playing = counted.filter((e) => e.state === "playing");
    if (playing.length !== 1) why.push("E_NOT_ONE_LEFT");
    const w = playing[0];
    if (w) {
      const at = whereIs(M, w.user_id);
      const chips = at ? (at.T && at.T.eng.seats.includes(w.user_id) ? at.T.eng.chips[w.user_id] : at.transit ? at.transit.chips : 0) : 0;
      if (chips !== M.total_chips) why.push("E_CHIPS");
    }
    if (S.hooks.crash === "mtt:finish:invariant") why.push("E_CHIPS");          // (tests: an injected chip mismatch)
    if (counted.length !== E) why.push("E_ENTRIES");
    if (counted.some((e) => e.state !== "playing" && (e.state !== "busted" || e.bust_seq == null))) why.push("E_BUSTS");
    const placed = PAY.places(counted.map((e) => ({ key: `${e.user_id}:${e.gen}`, bust_seq: e.bust_seq, bust_stack: e.bust_stack, bust_table_no: e.bust_table_no, bust_oc: e.bust_oc, winner: e.state === "playing" })));
    const seenPlaces = placed.map((p) => p.place).sort((a, b) => a - b);
    if (seenPlaces.length !== E || seenPlaces.some((p, i) => p !== i + 1)) why.push("E_PLACES");
    const holds = counted.filter((e) => e.hold_id);
    let heldSum = 0;
    for (const e of holds) {
      const h = (await getQuery("SELECT state, amount FROM escrow_holds WHERE id = ?", [e.hold_id]))[0];
      if (!h || h.state !== "held") why.push("E_HOLD_STATE");
      else heldSum += Number(h.amount);
    }
    const P = M.money.buyin * E, F = M.money.fee * E, O = Math.max(0, M.money.guarantee - P);
    if (heldSum !== P + F) why.push("E_MTT_CONSERVATION");
    if (await ESC().seen(`tny:${M.id}:cancel`)) why.push("E_CANCELLED");
    if (holds.length > 2000) why.push("E_TOO_MANY");
    const bp = M.plan_bp || PAY.planBp(E, M.money);
    const esc = PAY.award(placed, PAY.split(P, bp)), ovl = PAY.award(placed, PAY.split(O, bp));
    const rows = placed.map((p) => {
      const e = counted.find((x) => `${x.user_id}:${x.gen}` === p.key);
      return { e, user_id: e.user_id, gen: e.gen, place: p.place, tied: p.tied, escrow: esc.get(p.key) || 0, overlay: ovl.get(p.key) || 0 };
    });
    const sum = rows.reduce((s, r) => s + r.escrow, 0);
    if (sum !== P) why.push("E_SPLIT");
    return { why: Array.from(new Set(why)), rows, P, F, O, E, holds, heldSum };
  }
  async function finish(M) {
    if (M.status !== "finishing") return false;
    const now = clock();
    await ESC().init(); await require("../ledger").ensure();
    const st = await loadSettings();
    const plan = await finishPlan(M);
    if (plan.why.length) {
      const code = plan.why[0];
      M.finish = Object.assign(M.finish || {}, { retry_at: now + MTT.RETRY_MS, tries: ((M.finish && M.finish.tries) || 0) + 1, last_code: code });
      await saveMtt(M);
      console.error(`[mtt] ${M.id} #${M.no} finish refused ${code} (retry ${M.finish.tries})`);
      await mlog(M, "finish refused", { codes: plan.why, tries: M.finish.tries });
      if (!(M.alerts.finish_codes || []).includes(code)) {
        M.alerts.finish_codes = (M.alerts.finish_codes || []).concat([code]);
        await alert(M, "finish", `Tournament #${M.no}: the finish didn't settle (${code})`, "Nothing was paid. It is tried again every minute; the owner's void-and-refund is the way out.");
      }
      return false;
    }
    const key = `tny:${M.id}:finish`;
    const period = new Date(now).toISOString().slice(0, 7);
    const ptsOk = plan.E >= st.mtt_points_min_field;
    const best = new Map();                         // uid -> the best row (points: the best entry per player)
    for (const r of plan.rows) { const b = best.get(r.user_id); if (!b || r.place < b.place) best.set(r.user_id, r); }
    // (review) a player disqualified from this tournament earns no leaderboard points (no points row) for any of their entries
    for (const r of plan.rows) if (r.e.dq) best.delete(r.user_id);
    let fresh = false;
    try {
      const ctx = await txn("finish", M, async (c) => {
        if (!(await ESC().seen(key))) {
          if (plan.holds.length) {
            const payouts = plan.rows.filter((r) => r.escrow > 0).map((r) => ({ userId: r.user_id, amount: r.escrow, reason: "tournament prize", cp: `tournament #${M.no}` }));
            const res = await ESC().settleInTx({ key, hids: plan.holds.map((e) => e.hold_id), ref: ref(M), max: 2000, fees: plan.F > 0 ? [["jackpot", plan.F]] : [], payouts });
            if (res.kept !== 0 || res.held !== plan.P + plan.F) throw Object.assign(new Error(`settle kept ${res.kept} / held ${res.held}`), { code: "E_MTT_CONSERVATION" });
            await ESC().record(key, { op: "settle", ref: ref(M), amount: res.held, via: "casino", result: { ok: true, held: res.held, fee: plan.F, paid: payouts.map((p) => [p.userId, p.amount]) } });
          } else {
            await ESC().record(key, { op: "settle", ref: ref(M), amount: 0, via: "casino", result: { ok: true, freeroll: true } });
          }
          fresh = true;
        }
        for (const r of plan.rows) {
          const pts = ptsOk && best.get(r.user_id) === r ? PAY.points(r.place, plan.E) : 0;
          await runQuery("UPDATE casino_mtt_entries SET state = 'spent', place = ?, prize = ?, overlay_due = ?, points = ?, updated = ? WHERE tid = ? AND user_id = ? AND gen = ?",
                         [r.place, r.escrow, r.overlay, pts, now, M.id, r.user_id, r.gen]);
        }
        if (ptsOk) {
          for (const r of best.values()) {
            const n = plan.rows.filter((x) => x.user_id === r.user_id).length;
            await runQuery(`INSERT INTO casino_mtt_points (tid, user_id, gen, place, entries, points, cashed, won, period, veiled, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(tid, user_id) DO UPDATE SET place = excluded.place, points = excluded.points, cashed = excluded.cashed, won = excluded.won`,
                           [M.id, r.user_id, r.gen, r.place, n, PAY.points(r.place, plan.E), r.escrow + r.overlay > 0 ? 1 : 0, r.place === 1 ? 1 : 0, period,
                            plan.rows.some((x) => x.user_id === r.user_id && x.e.veiled) ? 1 : 0, now]);
          }
        }
        M.post.points = true;
        for (const T of liveTables(M)) closeTableInTx(M, T, c);
        M.transit = {};
        M.finish = { state: "settled", key, retry_at: null, tries: (M.finish && M.finish.tries) || 0, settled_at: now, pool: plan.P, fee_total: plan.F,
                     payouts: plan.rows.map((r) => ({ user_id: r.user_id, gen: r.gen, place: r.place, escrow: r.escrow, overlay: r.overlay, tied: r.tied })),
                     overlay: plan.O > 0 ? { amount: plan.O, state: "pending", key: `tny:${M.id}:overlay`, attempt: 0, first_try_at: now, tries: 0, last_code: null, paid_at: null, forfeited: [] } : null };
        M.status = "settled";
        M.seed.revealed_at = now;
      });
      log(M, `finish pool=${plan.P} fee=${plan.F} prizes=${plan.rows.reduce((s, r) => s + r.escrow, 0)} key=${key}`);
      log(M, "settle ok");
      void ctx;
    } catch (e) {
      M.finish = Object.assign(M.finish || {}, { retry_at: now + MTT.RETRY_MS, tries: ((M.finish && M.finish.tries) || 0) + 1, last_code: e && e.code ? e.code : "E_TX" });
      await saveMtt(M).catch(() => {});
      console.error(`[mtt] ${M.id} #${M.no} finish refused ${M.finish.last_code} (retry ${M.finish.tries}): ${e && e.message}`);
      await mlog(M, "finish refused", { code: M.finish.last_code, msg: e && e.message });
      return false;
    }
    void fresh;
    await afterCommit("finish", async () => { await afterSettle(M); });
    return true;
  }
  async function afterSettle(M) {
    if (M.finish && M.finish.overlay && M.finish.overlay.state === "pending") await payOverlay(M);
    await postSteps(M);
  }

  // ── the overlay (guaranteed part): after the settle, separately; the budget service only ──
  async function payOverlay(M) {
    const ov = M.finish.overlay;
    const now = clock();
    if (!ov || ov.state !== "pending") return;
    if (now - ov.first_try_at >= MTT.OWED_MS) {
      await txn("overlay", M, async () => { ov.state = "owed"; ov.last_code = ov.last_code || "expired"; });
      log(M, `overlay owed (${ov.last_code})`);
      await alert(M, "owed", `Tournament #${M.no}: the guaranteed part (${fmt(ov.amount)} PAT) is owed`, "Pending for 7 days - an owner can retry it from the admin page.");
      return;
    }
    ov.tries += 1;
    ov.next_at = now + MTT.OVERLAY_RETRY_MS;
    const g = await BUD.spendGate(now);
    if (!g.ok) { ov.last_code = g.why; await saveMtt(M); log(M, `overlay pending (${g.why})`); return; }
    const room = await BUD.headroom(M.money.group, now);
    if (room === null || room < ov.amount) { ov.last_code = "headroom"; await saveMtt(M); log(M, "overlay pending (headroom)"); return; }
    const ledger = require("../ledger");
    const legs = [], forfeited = [];
    for (const p of M.finish.payouts) {
      if (!(p.overlay > 0)) continue;
      const uid = await ledger.resolveUserId(p.user_id).catch(() => null);
      if (!uid) { forfeited.push({ user_id: p.user_id, amount: p.overlay }); continue; }
      legs.push({ userId: uid, amount: p.overlay, entry: p });
    }
    const key = ov.attempt ? `tny:${M.id}:overlay:a${ov.attempt}` : `tny:${M.id}:overlay`;
    try {
      await txn("overlay", M, async () => {
        const r = await BUD.payInTx({ key, group: M.money.group, legs, ref: ref(M), why: `tournament #${M.no} guarantee`, no: M.no, now });
        if (r.ok) {
          for (const l of legs) await runQuery("UPDATE casino_mtt_entries SET overlay = ?, overlay_due = 0, updated = ? WHERE tid = ? AND user_id = ? AND gen = ?",
                                               [l.amount, now, M.id, l.entry.user_id, l.entry.gen]);
          for (const f of forfeited) await runQuery("UPDATE casino_mtt_entries SET overlay_due = 0, updated = ? WHERE tid = ? AND user_id = ? AND overlay_due > 0", [now, M.id, f.user_id]);
          ov.state = "paid"; ov.paid_at = now; ov.forfeited = forfeited; ov.key_used = key;
        } else if (r.terminal) {
          ov.state = "owed"; ov.last_code = r.code;
        }
      });
      for (const f of forfeited) await mlog(M, "overlay leg forfeited", { uid: f.user_id, amount: f.amount });
      log(M, `overlay ${ov.state}${ov.state === "owed" ? ` (${ov.last_code})` : ""} forfeited=${forfeited.length}`);
      if (ov.state === "owed") await alert(M, "owed", `Tournament #${M.no}: the guaranteed part is owed (${ov.last_code})`, "The budget service refused it - an owner can retry it from the admin page.");
    } catch (e) {
      if (e && e.crash) throw e;
      M.finish.overlay.last_code = (e && e.code) || "error";
      await saveMtt(M).catch(() => {});
      log(M, `overlay pending (${M.finish.overlay.last_code})`);
    }
  }
  async function overlayRetry(admin, M) {
    const ov = M.finish && M.finish.overlay;
    if (!ov || ov.state !== "owed") return { ok: false, status: 409, error: "Only an owed guaranteed part can be retried." };
    await txn("overlay", M, async () => { ov.attempt += 1; ov.state = "pending"; ov.first_try_at = clock(); ov.tries = 0; ov.last_code = null; });
    await audit(admin, "overlay_retry", M.id, null, { attempt: ov.attempt });
    await payOverlay(M);
    return { ok: true, state: ov.state };
  }

  // ── post steps (each once: its own flag after its keyed work; a failing one never stops the others) ──
  async function postSteps(M) {
    const st = await loadSettings();
    const steps = [
      ["ach", async () => {
        if (M.entries_n < st.mtt_ach_min_field) return;
        const rows = await entriesOf(M.id, "state = 'spent'");
        const best = new Map();
        for (const r of rows) { const b = best.get(r.user_id); if (!b || r.place < b.place) best.set(r.user_id, r); }
        for (const r of rows) if (r.dq) best.delete(r.user_id);                  // (review) no achievements from a tournament you were disqualified from
        const R2 = require("./rewards");
        const twoTables = M.entries_n > M.structure.table_size;
        for (const r of best.values()) {
          if (r.prize + r.overlay + r.overlay_due > 0) await R2.siteCount(`mtt:${M.id}:${r.user_id}:cash`, r.user_id, "mtt_cashes", 1);
          if (r.place === 1) await R2.siteCount(`mtt:${M.id}:${r.user_id}:win`, r.user_id, "mtt_wins", 1);
          if (twoTables && M.final && (M.final.user_ids || []).includes(r.user_id)) await R2.siteCount(`mtt:${M.id}:${r.user_id}:final`, r.user_id, "mtt_final_tables", 1);
        }
      }],
      ["notices", async () => {
        const rows = await entriesOf(M.id, "state = 'spent'");
        const owed = M.finish && M.finish.overlay && M.finish.overlay.state !== "paid";
        for (const r of rows) await notice(M, r.user_id, "result", { place: r.place, prize: r.prize, overlay: r.overlay || r.overlay_due, delayed: owed && r.overlay_due > 0, points: r.points, gen: r.gen });
        const top = rows.filter((r) => r.place <= 3).sort((a, b) => a.place - b.place);
        const parts = [];
        for (const r of top) parts.push(`${ord(r.place)} ${await nameFor(M, r.user_id)} ${fmt(r.prize + (r.overlay || r.overlay_due))}`);
        if (top.length) await say(M, `🏆 ${await nameFor(M, top[0].user_id)} wins tournament #${M.no} "${M.title}"! ${parts.join(" · ")} PAT. ${url(M)}`);
      }],
      ["stream", async () => { for (const r of M.tables) streamGone(r.id); }],
      ["discord", async () => {
        const w = (M.finish.payouts || []).find((p) => p.place === 1);
        const veiled = w ? veiledKind(await kindFor(w.user_id, M.people[w.user_id])) || (await getQuery("SELECT veiled FROM casino_mtt_entries WHERE tid = ? AND user_id = ? AND gen = ?", [M.id, w.user_id, w.gen]))[0].veiled : true;
        await discord(M, "winner", { winner: !veiled && w ? (M.people[w.user_id] || {}).name : null });
      }],
      ["seed", async () => { /* revealed in the settle (seed.revealed_at): the view shows it from now on */ }],
      ["reminders_purged", async () => { await runQuery("UPDATE casino_mtt_reminders SET dropped = 'finished' WHERE tid = ? AND sent_at IS NULL AND dropped IS NULL AND kind <> 'result'", [M.id]); }],
    ];
    for (const [flag, fn] of steps) {
      if (M.post[flag]) continue;
      try {
        crash(`mtt:post:${flag}`);
        if (flag === "notices") crash("mtt:post:mid");
        await fn();
        M.post[flag] = true;
        await saveMtt(M);
      } catch (e) {
        if (e && e.crash) throw e;
        console.error(`[mtt] ${M.id} post step ${flag}:`, e && e.message ? e.message : e);
      }
    }
    const ovDone = !M.finish.overlay || ["paid", "owed"].includes(M.finish.overlay.state);
    if (M.status === "settled" && ovDone && Object.values(M.post).every(Boolean)) {
      M.status = "done";
      M.done_at = clock();
      await saveMtt(M);
      log(M, "done");
    }
  }

  // ── pause / resume / start now / delay / raise max / DQ / refund entry / stream (admins) ──
  async function pause(M, by, on) {
    if (M.status !== "running") return { ok: false, status: 409, error: "Only a running tournament can be paused." };
    const now = clock();
    if (on) {
      if (M.paused) return { ok: true, already: true };
      await txn("pause", M, async () => { M.paused = { by, at: now, why: "admin" }; M.clock.paused_at = now; });
      return { ok: true };
    }
    if (!M.paused) return { ok: true, already: true };
    await txn("pause", M, async () => {
      const d = now - (M.clock.paused_at || now);
      M.clock.level_ends_at += d; M.clock.pause_ms += d; M.clock.paused_at = null; M.paused = null;
    });
    for (const T of liveTables(M)) if (["pause", "wait", null, undefined].includes(T.tourney.hold)) kick(T);
    return { ok: true };
  }
  async function delay(admin, M, minutes) {
    const ms = Math.floor(Number(minutes)) * 60e3;
    if (M.status !== "registering" && M.status !== "scheduled") return { ok: false, status: 409, error: "Only before the start." };
    if (!(ms > 0) || (M.delay_ms || 0) + ms > MTT.MAX_DELAY_MS) return { ok: false, status: 400, error: "Up to 6 hours in all." };
    const before = M.start_at;
    await txn("delay", M, async () => {
      M.start_at += ms; M.delay_ms = (M.delay_ms || 0) + ms;
      if (M.reg_opens_at > clock()) M.reg_opens_at += ms;
      await runQuery("UPDATE casino_mtt_reminders SET dropped = 're-dated' WHERE tid = ? AND kind = 'starting' AND sent_at IS NULL AND dropped IS NULL", [M.id]);
    });
    const st = await loadSettings();
    const ent = await entriesOf(M.id, "state = 'held'");
    for (const e of ent) {
      await notice(M, e.user_id, "delayed", { gen: M.rev });
      if (e.remind) await queueReminder(M, e.user_id, "starting", "inbox", M.start_at - st.mtt_remind_mins * 60e3, { start_at: M.start_at, rev: M.rev });
    }
    for (const w of await getQuery("SELECT user_id FROM casino_mtt_watch WHERE tid = ?", [M.id])) {
      await queueReminder(M, w.user_id, "starting", "inbox", M.start_at - st.mtt_remind_mins * 60e3, { start_at: M.start_at, rev: M.rev });
    }
    await audit(admin, "delay", M.id, { start_at: before }, { start_at: M.start_at });
    await say(M, `⏳ Tournament #${M.no} now starts ${etText(M.start_at)}.`);
    return { ok: true, start_at: M.start_at };
  }
  async function raiseMax(admin, M, n) {
    const st = await loadSettings();
    n = Math.floor(Number(n));
    if (M.status !== "registering" && M.status !== "scheduled") return { ok: false, status: 409, error: "Only before the start." };
    if (!(n > M.structure.max_entries) || n > st.mtt_max_field) return { ok: false, status: 400, error: `More than now, up to ${st.mtt_max_field}.` };
    if (M.money.guarantee > 0) {
      try { await guaranteeChecks({ guarantee: M.money.guarantee, max_entries: n, min_entries: M.structure.min_entries, buyin: M.money.buyin, start_at: M.start_at },
                                  { structure: M.structure, money: M.money }, await windows([], M.id), st, clock()); }
      catch (e) { return { ok: false, status: 400, error: e.message }; }
    }
    const before = M.structure.max_entries;
    await txn("max", M, async () => { M.structure.max_entries = n; });
    await audit(admin, "max", M.id, { max_entries: before }, { max_entries: n });
    return { ok: true };
  }
  async function dq(admin, M, uid, reason) {
    if (M.status !== "running") return { ok: false, status: 409, error: "Only while it runs." };
    if (!M.late_open && M.paid != null && M.live_n <= M.paid) return { ok: false, status: 409, error: "past the bubble - pause the tournament and decide" };
    const e = await entryOf(M.id, uid, ["playing"]);
    if (!e) return { ok: false, status: 404, error: "Not playing." };
    await txn("dq", M, async () => { M.dq[uid] = { by: admin.userId, reason: String(reason || "").slice(0, 200), at: clock() }; });
    await audit(admin, "dq", M.id, null, { entry: `${uid}:${e.gen}` }, reason);
    const w = whereIs(M, uid);
    if (!w || !w.T || !w.T.eng.hand_active) await applyDq(M, uid);
    return { ok: true };
  }
  async function streamCmd(admin, M, on) {
    const F = M.final ? S.tables.get(M.final.table_id) : null;
    const T = F && F.status === "open" ? F : liveTables(M)[0];
    if (!T) return { ok: false, status: 409, error: "No table to stream." };
    if (on) {
      await txn("stream", M, async () => { M.stream_off_by = null; });
      const r = await streamTake(T, "take", admin.username || "admin", M);
      if (r && r.line) await say(M, r.line);
    } else {
      await txn("stream", M, async () => { M.stream_off_by = admin.userId; });
      for (const r of M.tables) streamGone(r.id);
    }
    await audit(admin, "stream", M.id, null, { on: !!on });
    return { ok: true };
  }

  // ── the tick (service.js tickOnce, under the mutex) ──
  async function clockTick(M, now) {
    if (M.status !== "running") return;
    const up = advanceClock(M, now);
    if (up) {
      const [sb, bb] = blindsNow(M);
      log(M, `level ${M.clock.level + 1} ${sb}/${bb}`);
    }
    if (lateDue(M)) {
      const ctx = await txn("late", M, async (c) => { await lateCheckInTx(M, now, c); });
      await afterCommit("late", async () => { await afterLateClose(M, ctx); for (const K of ctx.kicks) kick(K); });
    } else if (up || now - (M.clock.beat || 0) >= MTT.BEAT_MS) {
      M.clock.beat = now;
      await saveMtt(M);
    }
  }
  async function tickOne(M, now) {
    if (M.status === "scheduled") {
      if (now >= M.start_at) { await txn("cancel", M, async () => { M.status = "cancelled"; M.cancel = { by: null, reason: M.alerts.gate_reg_open ? "guarantee unavailable at registration" : "registration never opened", at: now }; }); log(M, "cancel (never opened) refunds=0 total=0"); return; }
      if (now >= M.reg_opens_at) await openReg(M, now);
      return;
    }
    if (M.status === "registering") {
      const st = await loadSettings();
      if (!M.said.soon && now >= M.start_at - 15 * 60e3 && now < M.start_at) {
        M.said.soon = true; await saveMtt(M);
        await say(M, `⏰ Tournament #${M.no} "${M.title}" starts in 15 minutes - ${fmt(M.reg_n)} registered. !mtt join ${M.no} · ${url(M)}`);
        for (const e of await entriesOf(M.id, "state = 'held' AND remind = 1 AND via = 'room'")) {
          await queueReminder(M, e.user_id, "pm_starting", "pepe", now, { text: `⏰ Tournament #${M.no} starts in 15 minutes. ${url(M)}` });
        }
      }
      if (now >= M.start_at) {
        if ((st.casino_mtt || "off") === "off" || !st.hm_enabled) { await cancel(M, "tournaments are switched off", null); return; }
        const late = now - M.start_at > st.mtt_start_grace_mins * 60e3;
        if (late) { await cancel(M, "the site was down at the start time", null); return; }
        await start(M, "clock");
      }
      return;
    }
    if (M.status === "running") {
      await clockTick(M, now);
      if (M.live_n === 1 && M.status === "running") {
        await txn("finishing", M, async () => { M.status = "finishing"; M.finish = { state: "pending", key: `tny:${M.id}:finish`, retry_at: null, tries: 0 }; });
        await finish(M);
        return;
      }
      // the final table keeps Pepe's stream slot while it holds (pause / wait)
      if (M.final) { const F = S.tables.get(M.final.table_id); if (F && F.status === "open" && F.tourney.hold) F.last_activity = now; }
      // a safety re-check: a held table with nothing scheduled gets its boundary again every RECHECK_MS (the pipeline is idempotent)
      for (const T of liveTables(M)) {
        if (!T.eng.hand_active && !T.dl.turn && !T.dl.next && T.status === "open") T.dl.next = now + (wrapPending(T) ? 0 : MTT.RECHECK_MS);
      }
      return;
    }
    if (M.status === "finishing") { if (!M.finish || !M.finish.retry_at || now >= M.finish.retry_at) await finish(M); return; }
    if (M.status === "settled") {
      const ov = M.finish && M.finish.overlay;
      if (ov && ov.state === "pending" && (!ov.next_at || now >= ov.next_at)) await payOverlay(M);
      await postSteps(M);
      return;
    }
    if ((M.status === "done" || M.status === "cancelled") && now - (M.done_at || (M.cancel && M.cancel.at) || M.updated || 0) > MTT.LINGER_MS) S.mtts.delete(M.id);
  }
  async function tick() {
    const now = clock();
    for (const M of Array.from(S.mtts.values())) {
      try { await tickOne(M, now); } catch (e) { if (e && e.crash) throw e; console.error(`[mtt] ${M.id} tick:`, e && e.message ? e.message : e); }
    }
    if (now - lastRemind >= MTT.REMIND_EVERY_MS) {
      lastRemind = now;
      try { await processReminders(); } catch (e) { console.error("[mtt] reminders:", e && e.message); }
    }
    try { await flushLines(); } catch (e) { console.error("[mtt] lines:", e && e.message); }
  }
  /** is anything due? (cheap; tickOnce calls tick() under the mutex only then) */
  function due() {
    const now = clock();
    if (now - lastRemind >= MTT.REMIND_EVERY_MS) return true;
    for (const [, q] of lineQ) if (q.q.length) return true;
    for (const M of S.mtts.values()) {
      if (M.status === "scheduled" && (now >= M.reg_opens_at || now >= M.start_at)) return true;
      if (M.status === "registering" && (now >= M.start_at - 15 * 60e3)) return true;
      if (M.status === "running") {
        if (M.clock && (now >= M.clock.level_ends_at || now - (M.clock.beat || 0) >= MTT.BEAT_MS)) return true;
        if (M.live_n === 1) return true;
        for (const T of liveTables(M)) if (!T.eng.hand_active && !T.dl.turn && !T.dl.next) return true;
      }
      if (M.status === "finishing" || M.status === "settled") return true;
      if ((M.status === "done" || M.status === "cancelled") && now - (M.done_at || (M.cancel && M.cancel.at) || M.updated || 0) > MTT.LINGER_MS) return true;
    }
    return false;
  }

  // ── table hooks (the router) ──
  // (review) a hand that ended but whose wrap-up (handEnd) never committed - its transaction threw (a transient database error) after
  // holdem.js had revealed the hand - is wrapped up again by the tick (holdem.js wrapUp: "wrap"), at once and then once a minute while it
  // keeps failing; beforeDeal never deals that table on first (a 0-chip seat placed later would outrank the busts in between)
  const wrapAt = new Map();                                   // table id -> not before (ms); in memory
  const wrapPending = (T) => { const e = T.eng; return !e.hand_active && e.hand_no > 0 && T.tourney.bust_done !== e.hand_no; };
  function tableTick(T) {
    if (T.status !== "open") return "done";
    const M = S.mtts.get(T.tourney.id);
    if (!M) return "done";
    if ((M.status === "running" || M.status === "finishing") && wrapPending(T)) {
      const now = clock();
      if ((wrapAt.get(T.id) || 0) <= now) {
        wrapAt.set(T.id, now + MTT.RETRY_MS);
        console.log(`[mtt] ${M.id} #${M.no} table ${T.tourney.no}: hand #${T.eng.hand_no} ended without its wrap-up - wrapping it up again`);
        return "wrap";
      }
    }
    return null;
  }
  const tableDue = () => false;
  function noDealNext(T) {
    if (T.status !== "open") return null;
    if (T.dl.next) return T.dl.next;
    return clock() + MTT.RECHECK_MS;
  }
  const beforeHand = () => null;
  /** after a restart, before the hand resumes (holdem.js recover): "done" = nothing to resume here */
  async function recoverTable(T) {
    const M = S.mtts.get(T.tourney.id);
    if (!M) { T.tourney.hold = "stopped"; console.error(`[mtt] table ${T.id}: tournament ${T.tourney.id} isn't open - stopped`); return "done"; }
    if (!["running", "finishing"].includes(M.status) || T.status !== "open") return "done";
    return null;
  }
  async function tableVerb(T, actor, verb) {
    switch (verb) {
      case "sit": case "buyin": case "buy": case "join": case "register":
        return R(false, `🏆 this is a table of tournament #${(S.mtts.get(T.tourney.id) || {}).no || "?"} - it seats its players itself. !mtt join to register.`, { table: T.id });
      case "stand": case "leave": case "cashout": case "unregister":
        return R(false, "🏆 tournament chips aren't PAT - they can't be cashed out. !sitout to sit out (you'll be blinded until you're back).", { table: T.id });
      case "end": case "close": case "stop":
        return R(false, "🏆 Tournament tables are run by the tournament.", { table: T.id });
      case "deal": case "next": case "go":
        return R(false, "🏆 the tournament deals by itself.", { table: T.id });
      case "status": case "": case "table": case "info": case "show": {
        const M = S.mtts.get(T.tourney.id);
        return R(true, M ? infoText(M) : "🏆 a tournament table.", { table: T.id });
      }
      case "help": case "rules": case "how": return R(true, HELP);
      default: return null;
    }
  }

  // ── recovery (service.boot: after the open tables are recovered) ──
  async function loadAll() {
    await ensure();
    S.mtts.clear();
    const rows = await getQuery("SELECT state FROM casino_mtt WHERE status NOT IN ('done','cancelled') OR updated > ?", [clock() - MTT.LINGER_MS]);
    const now = clock();
    for (const r of rows) {
      let M;
      try { M = JSON.parse(r.state); } catch (e) { continue; }
      S.mtts.set(M.id, M);
      // the clock pauses while the site is down (phase 1's rule): shifted by the gap since the last beat - BEFORE any table's recovery
      // wraps a hand up (a restart never blinds anyone up; it costs at most the <= 30 s since the last beat)
      if ((M.status === "running" || M.status === "finishing") && M.clock) {
        const gap = Math.max(0, now - (M.clock.beat || now));
        if (gap > 0) {
          M.clock.level_ends_at += gap;
          if (M.clock.paused_at) M.clock.paused_at += gap;
          M.clock.gaps = (M.clock.gaps || []).concat([{ at: now, ms: gap }]).slice(-20);
          M.clock.beat = now;
          console.log(`[mtt] ${M.id} clock moved ${Math.round(gap / 1000)}s for the restart`);
        }
      }
    }
    S.mttBoot = now;
    S.mttSeen.clear(); S.mttSeenRoom.clear();
    return S.mtts.size;
  }
  async function loadOne(id) {
    if (!ID_RE.test(String(id || ""))) return null;
    await ensure();
    const r = (await getQuery("SELECT state FROM casino_mtt WHERE id = ?", [id]))[0];
    if (!r) return null;
    try { return JSON.parse(r.state); } catch (e) { return null; }
  }
  async function recoverAll() {
    const now = clock();
    for (const M of Array.from(S.mtts.values())) {
      try { await recoverOne(M, now); } catch (e) { if (e && e.crash) throw e; console.error(`[mtt] ${M.id} recover:`, e && e.message ? e.message : e); }
    }
  }
  async function recoverOne(M, now) {
    const repairs = [];
    if (M.status === "running" || M.status === "finishing") {
      // invariant: every playing entry exactly once seated at a live table or in transit; every seat a playing entry; chips add up
      const playing = (await entriesOf(M.id, "state = 'playing'")).map((e) => e.user_id);
      const seen = new Map();
      for (const r of liveRecs(M)) {
        const T = S.tables.get(r.id);
        if (!T) { repairs.push(`table ${r.no} missing`); continue; }
        for (const k of T.eng.seats) seen.set(k, (seen.get(k) || 0) + 1);
      }
      for (const k of Object.keys(M.transit || {})) seen.set(k, (seen.get(k) || 0) + 1);
      for (const k of playing) if (seen.get(k) !== 1) repairs.push(`entry ${k} seated ${seen.get(k) || 0}x`);
      for (const [k] of seen) if (!playing.includes(k)) repairs.push(`seat ${k} without a playing entry`);
      if (M.status === "running" && chipsInPlay(M) !== M.total_chips) repairs.push(`chips ${chipsInPlay(M)} != ${M.total_chips}`);
      await saveMtt(M);
      if (repairs.length && M.status === "running") await systemPause(M, repairs.join("; "));
      // transit re-queued: kick the targets; tables never dealt are released
      for (const x of Object.values(M.transit || {})) kick(tableByNo(M, x.to_no));
      for (const T of liveTables(M)) if (!T.eng.hand_active && !T.dl.next) T.dl.next = now + M.structure.next_secs * 1000;
      if (M.status === "running" && M.live_n === 1) {
        await txn("finishing", M, async () => { M.status = "finishing"; M.finish = { state: "pending", key: `tny:${M.id}:finish`, retry_at: null, tries: 0 }; });
      }
    }
    if (M.status === "registering" && now >= M.start_at) {
      const st = await loadSettings();
      if (now - M.start_at > st.mtt_start_grace_mins * 60e3) await cancel(M, "the site was down at the start time", null);
    }
    if (M.status === "cancelled") for (const r of M.tables) { const T = S.tables.get(r.id); if (T && T.status === "open") { const ctx = await txn("cancel", M, async (c) => closeTableInTx(M, T, c)); for (const K of ctx.closed || []) streamGone(K.id); } }
    console.log(`[mtt] ${M.id} recover status=${M.status} gap=${M.clock && M.clock.gaps && M.clock.gaps.length ? M.clock.gaps[M.clock.gaps.length - 1].ms : 0} transit=${Object.keys(M.transit || {}).length} repairs=${repairs.join("|") || "none"}`);
  }

  // ── views ──
  function prizeTable(M) {
    const E = M.status === "registering" || M.status === "scheduled" ? Math.max(M.reg_n, M.structure.min_entries) : M.entries_n;
    const bp = M.plan_bp || PAY.planBp(E, M.money);
    const P = M.money.buyin * E, O = Math.max(0, M.money.guarantee - P);
    const a = PAY.split(P, bp), b = PAY.split(O, bp);
    return a.map((x, i) => x + (b[i] || 0));
  }
  function publicView(M) {
    const ck = `${M.id}:${M.rev}:${Math.floor(clock() / MTT.VIEW_MS)}`;
    const hit = viewCache.get(ck);
    if (hit) return hit;
    const s = M.structure, m = M.money;
    const lvl = M.clock ? M.clock.level : 0, [sb, bb] = levelAt(M, lvl), [nsb, nbb] = levelAt(M, lvl + 1);
    const lateDepth = (() => { const [, lbb] = levelAt(M, Math.max(0, s.late_levels - 1)); return lbb ? Math.floor(s.start_chips / lbb) : null; })();
    const E = M.entries_n || M.reg_n;
    const P = m.buyin * E;
    const held = (M.h4h.on && liveTables(M).filter((T) => T.eng.hand_active).map((T) => T.tourney.no)) || [];
    const done = M.status === "done" || M.status === "cancelled" || M.status === "settled";
    const v = {
      id: M.id, no: M.no, title: M.title, status: M.status, start_at: M.start_at, reg_opens_at: M.reg_opens_at, est_ms: s.est_ms, est_end: M.start_at + s.est_ms,
      structure: { kind: s.kind, start_chips: s.start_chips, level_mins: s.level_ms / 60000, late_levels: s.late_levels, late_depth_bb: lateDepth, reentry_max: s.reentry_max,
                   table_size: s.table_size, levels: Array.from({ length: Math.max(s.levels.length, Math.min(40, (lvl + 6))) }, (_, i) => levelAt(M, i)) },
      buyin: m.buyin, fee: m.fee, entry: m.buyin + m.fee, guarantee: m.guarantee, freeroll: !!m.freeroll, registered: M.status === "registering" ? M.reg_n : E,
      max_entries: s.max_entries, min_entries: s.min_entries, entries: M.entries_n, players_left: M.live_n,
      level: lvl + 1, sb, bb, next_sb: nsb, next_bb: nbb, next_level_at: M.status === "running" && M.clock && !M.clock.paused_at ? M.clock.level_ends_at : null,
      paused: !!M.paused, pause_why: M.paused ? (M.paused.by === "system" ? "system" : "admin") : null,
      late_open: !!M.late_open, late_until_level: s.late_levels, avg_stack: M.live_n ? Math.floor(M.total_chips / M.live_n) : null,
      prize_pool: Math.max(P, m.guarantee), pool_escrow: P, paid: M.paid != null ? M.paid : paidOf(M, Math.max(E, s.min_entries)), prizes: prizeTable(M), projected: !!M.late_open || M.paid == null,
      h4h: !!M.h4h.on, h4h_waiting: held, tables_left: liveRecs(M).length, final: !!M.final, final_table: M.final ? M.final.table_id : null,
      draw_commit: M.seed ? M.seed.draw_commit : null, seed: done && M.seed && M.seed.revealed_at ? M.seed.draw_seed : null,
      overlay: M.finish && M.finish.overlay ? { amount: M.finish.overlay.amount, state: M.finish.overlay.state } : null,
      cancelled: M.status === "cancelled" ? (M.cancel && M.cancel.reason) || "cancelled" : null, url: `/casino/holdem/mtt/${M.id}`,
    };
    viewCache.set(ck, v);
    if (viewCache.size > 400) viewCache.delete(viewCache.keys().next().value);
    return v;
  }
  async function results(M) {
    if (!["settled", "done"].includes(M.status)) return null;
    const rows = await getQuery("SELECT * FROM casino_mtt_entries WHERE tid = ? AND state = 'spent' ORDER BY place", [M.id]);
    const out = [];
    for (const r of rows) {
      const p = (M.finish.payouts || []).find((x) => x.user_id === r.user_id && x.gen === r.gen) || {};
      const name = r.veiled ? "someone" : await nameFor(M, r.user_id, { web: true });
      out.push({ place: r.place, name, prize: r.prize, overlay: r.overlay || r.overlay_due, overlay_state: M.finish.overlay ? M.finish.overlay.state : null, tied: !!p.tied, points: r.points });
    }
    return out;
  }
  async function players(M, page) {
    const rows = await getQuery("SELECT * FROM casino_mtt_entries WHERE tid = ? AND entry_no IS NOT NULL AND state <> 'refunded'", [M.id]);
    const list = [];
    for (const r of rows) {
      const w = r.state === "playing" ? whereIs(M, r.user_id) : null;
      const stack = w ? (w.T && w.T.eng.seats.includes(r.user_id) ? w.T.eng.chips[r.user_id] + (w.T.eng.hand_active ? w.T.eng.contrib[r.user_id] || 0 : 0) : w.transit ? w.transit.chips : 0) : 0;
      list.push({ r, stack, table_no: w ? w.no : null });
    }
    const pre = M.status === "registering" ? await entriesOf(M.id, "state = 'held'") : [];
    for (const r of pre) list.push({ r, stack: M.structure.start_chips, table_no: null });
    list.sort((a, b) => (a.r.state === "playing" || a.r.state === "held" ? 0 : 1) - (b.r.state === "playing" || b.r.state === "held" ? 0 : 1) || b.stack - a.stack ||
                        (a.r.place || 9e9) - (b.r.place || 9e9) || (b.r.bust_seq || 0) - (a.r.bust_seq || 0));
    const pg = Math.max(1, Math.floor(Number(page) || 1));
    const slice = list.slice((pg - 1) * MTT.PAGE, pg * MTT.PAGE);
    const out = [];
    for (const x of slice) {
      const name = x.r.veiled ? "someone" : await nameFor(M, x.r.user_id, { web: true });
      out.push({ name, stack: x.stack, table_no: x.table_no, status: x.r.state, place: x.r.place || null, prize: x.r.state === "spent" ? x.r.prize + (x.r.overlay || x.r.overlay_due) : null });
    }
    return { page: pg, pages: Math.max(1, Math.ceil(list.length / MTT.PAGE)), total: list.length, rows: out };
  }
  function tablesView(M) {
    return M.tables.filter((r) => r.state !== "closed").map((r) => {
      const T = S.tables.get(r.id);
      const seats = T ? seatedOf(T) : [];
      return { no: r.no, id: r.id, players: seats.length, biggest: seats.length ? Math.max(...seats.map((k) => T.eng.chips[k] || 0)) : 0, final: !!r.final,
               hold: T ? T.tourney.hold || (T.eng.hand_active ? null : "between") : "missing", breaking: r.state === "breaking", hand_no: T ? T.eng.hand_no : 0,
               in_hand: !!(T && T.eng.hand_active) };
    });
  }
  async function meFor(M, uid) {
    if (!uid) return null;
    uid = String(uid);
    const rows = await getQuery("SELECT * FROM casino_mtt_entries WHERE tid = ? AND user_id = ? ORDER BY gen DESC", [M.id, uid]);
    const cur = rows.find((r) => r.state === "held" || r.state === "playing") || null;
    const used = rows.filter((r) => r.entry_no != null).length;
    const w = cur && cur.state === "playing" ? whereIs(M, uid) : null;
    const T = w ? w.T : null;
    const stack = w ? (T && T.eng.seats.includes(uid) ? T.eng.chips[uid] : w.transit ? w.transit.chips : 0) : null;
    let rank = null;
    if (stack != null) {
      let better = 0;
      for (const L of liveTables(M)) for (const k of seatedOf(L)) if (k !== uid && (L.eng.chips[k] || 0) > stack) better++;
      for (const [k, x] of Object.entries(M.transit || {})) if (k !== uid && x.chips > stack) better++;
      rank = better + 1;
    }
    const st = await loadSettings();
    const aud = await audienceFor({ uid });
    const regOpen = M.status === "registering" && M.reg_n < M.structure.max_entries;
    const lateOpen = M.status === "running" && M.late_open && M.entries_n < M.structure.max_entries;
    const watch = (await getQuery("SELECT 1 FROM casino_mtt_watch WHERE tid = ? AND user_id = ?", [M.id, uid])).length > 0;
    // the inline "also on Telegram" toggle: shown to someone with Telegram linked whose 🏆 pref is off (opt-in, telegram_prefs)
    let tg = null, tgLinked = false;
    try { const TG = require("../telegram"); tgLinked = !!(await TG.linkOf(uid)); tg = tgLinked ? await TG.wants(uid, "tourney") : null; } catch (e) { tg = null; }
    const last = rows[0] || null;
    void st;
    return { registered: !!cur, state: cur ? cur.state : last ? last.state : null, gen: cur ? cur.gen : null, entries_used: used,
             can_register: !!(aud.ok && !cur && (regOpen || (lateOpen && used === 0))),
             can_reenter: !!(aud.ok && !cur && lateOpen && used > 0 && used - 1 < M.structure.reentry_max),
             table_id: T && T.status === "open" ? T.id : null, table_no: w ? w.no : null, stack, rank, moved_to: w && w.transit ? w.transit.to_no : null,
             remind: !!(cur ? cur.remind : watch), watching: watch, telegram_linked: tgLinked, telegram_tourney: tg, place: last && last.place ? last.place : null,
             prize: last && last.state === "spent" ? last.prize : null, overlay: last && last.state === "spent" ? last.overlay || last.overlay_due : null, points: last ? last.points : null };
  }
  function lobbyRow(M) {
    const v = publicView(M);
    return { id: M.id, no: M.no, title: M.title, status: M.status, start_at: M.start_at, est_ms: v.est_ms, buyin: v.buyin, fee: v.fee, guarantee: v.guarantee, freeroll: v.freeroll,
             registered: v.registered, max_entries: v.max_entries, structure: { kind: v.structure.kind, start_chips: v.structure.start_chips, level_mins: v.structure.level_mins,
             reentry_max: v.structure.reentry_max, late_levels: v.structure.late_levels }, late_open: v.late_open, level: v.level, players_left: v.players_left,
             entries: v.entries, final_table: v.final_table, url: v.url, prize_pool: v.prize_pool };
  }
  async function lobby(uid) {
    await ensure();
    const st = await loadSettings();
    const aud = await audienceFor(uid ? { uid } : null);
    const now = clock();
    const all = Array.from(S.mtts.values());
    const mine = [];
    if (uid) {
      for (const r of await getQuery("SELECT DISTINCT tid FROM casino_mtt_entries WHERE user_id = ? AND state IN ('held','playing')", [String(uid)])) {
        const M = S.mtts.get(r.tid);
        if (M) mine.push(M.id);
      }
    }
    const show = (M) => aud.ok || mine.includes(M.id);
    // (review) "Take me to my table": a seated entrant's own table (or the one they're moving to)
    const myTable = (M) => { if (!mine.includes(M.id)) return {}; const w = whereIs(M, uid); return w && w.T && w.T.status === "open" ? { my_table: w.T.id } : {}; };
    const rows = (l) => l.filter(show).sort((a, b) => a.start_at - b.start_at).map((M) => Object.assign(lobbyRow(M), { me: mine.includes(M.id) }, myTable(M)));
    const recent = (await getQuery("SELECT state FROM casino_mtt WHERE status = 'done' ORDER BY updated DESC LIMIT 10")).map((r) => { try { return JSON.parse(r.state); } catch (e) { return null; } }).filter(Boolean);
    return { mtt_on: aud.ok, audience: st.casino_mtt || "off", can_register: aud.ok && !!uid,
             upcoming: rows(all.filter((M) => M.status === "scheduled" && M.start_at < now + 7 * 86400e3)),
             registering: rows(all.filter((M) => M.status === "registering")),
             running: rows(all.filter((M) => ["running", "finishing", "settled"].includes(M.status))),
             recent: aud.ok ? recent.map((M) => lobbyRow(M)) : [], mine };
  }
  async function leaderboard(period, page) {
    period = /^\d{4}-\d{2}$/.test(String(period || "")) ? String(period) : "all";
    const pg = Math.max(1, Math.floor(Number(page) || 1));
    const ck = period;
    const hit = lbCache.get(ck);
    let all;
    if (hit && clock() - hit.at < MTT.LB_MS) all = hit.v;
    else {
      const rows = await getQuery(`SELECT user_id, SUM(points) AS pts, SUM(won) AS wins, SUM(cashed) AS cashes, MAX(created) AS last FROM casino_mtt_points
                                   WHERE veiled = 0${period === "all" ? "" : " AND period = ?"} GROUP BY user_id ORDER BY pts DESC, wins DESC, cashes DESC, last ASC LIMIT 500`,
                                   period === "all" ? [] : [period]);
      all = [];
      for (const r of rows) {
        const k = await kindFor(r.user_id, null);
        if (veiledKind(k)) continue;                   // veiled now: omitted entirely (no "someone" row), the ranks recomputed
        const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [r.user_id]))[0];
        if (!u) continue;
        all.push({ name: u.displayname || u.username, points: r.pts, wins: r.wins, cashes: r.cashes });
      }
      all.forEach((x, i) => { x.rank = i + 1; });
      lbCache.set(ck, { at: clock(), v: all });
    }
    return { period, page: pg, pages: Math.max(1, Math.ceil(all.length / MTT.PAGE)), rows: all.slice((pg - 1) * MTT.PAGE, pg * MTT.PAGE) };
  }
  async function veiledPoints(uid) {
    const r = (await getQuery("SELECT COALESCE(SUM(points),0) AS n FROM casino_mtt_points WHERE user_id = ? AND veiled = 1", [String(uid)]))[0];
    return Number(r.n) || 0;
  }

  // ── the table view's tourney block (ROUTE.view / meView) ──
  function view(T) {
    const M = S.mtts.get(T.tourney.id);
    if (!M) return { kind: "mtt", id: T.tourney.id, table_no: T.tourney.no, hold: "stopped" };
    const lvl = M.clock ? M.clock.level : 0, [sb, bb] = levelAt(M, lvl);
    const waiting = M.h4h.on ? liveTables(M).filter((L) => L.eng.hand_active).map((L) => L.tourney.no) : [];
    const E = M.entries_n;
    return { kind: "mtt", id: M.id, no: M.no, name: M.title, table_no: T.tourney.no, tables_left: liveRecs(M).length, final: !!T.tourney.final,
             players_left: M.live_n, entries: E, avg_stack: M.live_n ? Math.floor(M.total_chips / M.live_n) : null, level: lvl + 1, sb, bb,
             next_level_at: M.clock && !M.clock.paused_at ? M.clock.level_ends_at : null,
             // (the seconds left on the site's clock when this view was built: Pepe's OBS board counts down from it, not from his own clock)
             level_secs_left: M.clock && !M.clock.paused_at ? Math.max(0, Math.ceil((M.clock.level_ends_at - clock()) / 1000)) : null,
             late_open: !!M.late_open, paid: M.paid, prize_pool: Math.max(M.money.buyin * E, M.money.guarantee),
             guarantee: M.money.guarantee, h4h: !!M.h4h.on, h4h_waiting_table: waiting.length ? waiting[0] : null, hold: T.tourney.hold || null, paused: !!M.paused,
             dead_sb: !!(T.eng.hand_active && T.tourney.start && T.tourney.start.dead_sb), status: M.status, url: `/casino/holdem/mtt/${M.id}` };
  }
  function meView(T, uid) {
    const M = S.mtts.get(T.tourney.id);
    if (!M || !uid) return { registered: false };
    uid = String(uid);
    const w = whereIs(M, uid);
    let rank = null, moved = null;
    if (w) {
      const stack = w.T && w.T.eng.seats.includes(uid) ? w.T.eng.chips[uid] : w.transit ? w.transit.chips : 0;
      let better = 0;
      for (const L of liveTables(M)) for (const k of seatedOf(L)) if (k !== uid && (L.eng.chips[k] || 0) > stack) better++;
      rank = better + 1;
      if (!T.eng.seats.includes(uid)) moved = w.T && w.T.id !== T.id && w.T.status === "open" ? { no: w.no, id: w.T.id } : { no: w.no, id: null };
    }
    S.mttSeen.set(uid, clock());
    // (review) a busted / finished entrant's result (the table page's results card): the place and prize once it has settled, else "out"
    let result = null;
    if (!w && M.people[uid]) {
      const ps = ((M.finish && M.finish.payouts) || []).filter((p) => p.user_id === uid).sort((a, b) => a.place - b.place);
      if (ps.length) result = { place: ps[0].place, prize: (ps[0].escrow || 0) + (ps[0].overlay || 0), tied: !!ps[0].tied, final: true };
      else if (M.status === "running" || M.status === "finishing") result = { out: true, late_open: !!M.late_open };
    }
    return { registered: !!w, mtt_rank: rank, moved_to: moved, result };
  }

  // ── Pepe: the private part (hole cards, turn prompts, notice PMs for room players seated at MTT tables, in their own room) ──
  async function privateMtt() {
    const fresh = new Set((freshRooms() || []).map((r) => r.id));
    const out = [];
    for (const M of S.mtts.values()) {
      if (M.status !== "running" && M.status !== "finishing") continue;
      for (const T of liveTables(M)) {
        const e = T.eng;
        if (!e.hand_active) continue;
        for (const k of e.players) {
          const p = T.players[k] || {};
          if (p.via !== "room" || !p.camfrog || !p.room || !fresh.has(p.room)) continue;
          const cf = String(p.camfrog).toLowerCase();
          if (!e.folded.includes(k) && e.hole[k]) out.push({ kind: "cards", key: `${T.id}:${e.hand_no}:${cf}`, camfrog: p.camfrog, room: p.room, table: T.id, hand_no: e.hand_no, cards: e.hole[k].slice() });
          if (H.currentActor(e) === k && T.turn && T.turn.uid === k) {
            const tc = H.toCall(e, k), minTo = e.current_bet > 0 ? e.current_bet + e.min_raise : e.bb;
            const text = `🃏 #${M.no} · table ${T.tourney.no} - your turn: stack ${fmt(e.chips[k])}, to call ${fmt(tc)}, pot ${fmt(H.pot(e))}` +
                         `${e.board.length ? ", board " + H.cardsStr(e.board) : ""} - ${tc ? "!call" : "!check"} · !raise <to ≥${fmt(minTo)}> · !allin · !fold (60 s)`;
            out.push({ kind: "turn", key: `${T.id}:${e.hand_no}:${T.turn.token}`, camfrog: p.camfrog, room: p.room, table: T.id, hand_no: e.hand_no, text });
          }
        }
      }
    }
    // notices (start / 15 minutes): claimed when included (at most once)
    const rows = await getQuery("SELECT * FROM casino_mtt_reminders WHERE channel = 'pepe' AND sent_at IS NULL AND dropped IS NULL AND due_at <= ? ORDER BY due_at LIMIT 50", [clock()]);
    for (const r of rows) {
      const M = S.mtts.get(r.tid);
      const p = M && M.people[r.user_id];
      let data = {};
      try { data = JSON.parse(r.data || "{}"); } catch (e) { data = {}; }
      const room = p && p.via === "room" && p.room && fresh.has(p.room) ? p.room : null;
      const allowed = room ? await require("../inbox").pmAllowed(r.user_id, "tourney").catch(() => true) : false;
      const c = await runQuery("UPDATE casino_mtt_reminders SET sent_at = ?, dropped = ? WHERE ref = ? AND sent_at IS NULL", [clock(), room && allowed ? null : room ? "pm off" : "not in a room", r.ref]);
      if (!c || c.changes !== 1 || !room || !allowed) continue;
      out.push({ kind: "notice", key: r.ref, camfrog: p.camfrog, room, table: data.table || null, hand_no: null, text: String(data.text || "").slice(0, 300) });
    }
    return out;
  }
  function noteScene(sc) {
    if (sc && typeof sc === "object") S.scene = { held: !!sc.held, at: clock() };
  }
  const sceneHeld = () => !!(S.scene && S.scene.held && clock() - (S.scene.at || 0) < 60e3);

  // ── texts ──
  const HELP = "🏆 Scheduled tournaments - !mtt lists the next ones; !mtt info <no>; !mtt join <no> (registers, late-registers or re-enters); !mtt leave <no> " +
               "(a full refund before it starts); !mtt remind <no> [off]; !mtt me (your table, stack and place); !mtt top <no>. Everyone gets the same tournament " +
               "chips (not PAT); one clock raises the blinds at every table; tables are balanced and broken as players bust; prizes are paid when it ends. " +
               "At your table: !check !call !bet !raise !allin !fold, !sitout / !sitin (sitting out only blinds you away - you're never stood up).";
  function listLine(M) {
    return `🏆 #${M.no} ${M.title} - ${etText(M.start_at)} - ${M.money.freeroll ? "freeroll" : `${kShort(M.money.buyin)}+${kShort(M.money.fee)} PAT`} - ` +
           `${M.status === "running" ? `running, level ${(M.clock ? M.clock.level : 0) + 1}, ${M.live_n} left${M.late_open ? " (late reg open)" : ""}` : `${M.reg_n}/${M.structure.max_entries}`}` +
           `${M.money.guarantee ? ` - 🛡 ${kShort(M.money.guarantee)} GTD` : ""} - !mtt join ${M.no}`;
  }
  function infoText(M) {
    const s = M.structure;
    const [sb, bb] = blindsNow(M);
    const head = `🏆 #${M.no} "${M.title}" - ${etText(M.start_at)}; ${buyinText(M)}; ${fmt(s.start_chips)} chips, ${s.kind} (${s.level_ms / 60000} min levels), ` +
                 `${s.table_size}-max, late reg ${s.late_levels} levels${s.reentry_max ? `, re-entry x${s.reentry_max}` : ""}${M.money.guarantee ? `, 🛡 ${fmt(M.money.guarantee)} PAT guaranteed` : ""}`;
    if (M.status === "scheduled") return `${head}. Registration opens ${etText(M.reg_opens_at)}. ${url(M)}`;
    if (M.status === "registering") return `${head}. ${fmt(M.reg_n)}/${fmt(s.max_entries)} registered (min ${s.min_entries}). !mtt join ${M.no} · ${url(M)}`;
    if (M.status === "running") return `${head}. Level ${M.clock.level + 1}: ${fmt(sb)}/${fmt(bb)}; ${fmt(M.live_n)} of ${fmt(M.entries_n)} left at ${liveRecs(M).length} table(s)${M.paused ? " (paused)" : ""}${M.h4h.on ? " - hand-for-hand" : ""}. ${url(M)}`;
    if (M.status === "cancelled") return `${head}. Cancelled - every entry refunded in full.`;
    return `${head}. It's over - ${url(M)}`;
  }

  // ── the !mtt commands (service.js run, game "mtt"; the web and Pepe) ──
  const ALIAS = { "": "list", ls: "list", schedule: "list", status: "info", show: "info", register: "join", reg: "join", enter: "join", reenter: "join", in: "join",
                  unregister: "leave", unreg: "leave", out: "leave", standings: "top", rules: "help", how: "help" };
  async function findM(arg, actor) {
    const q = String(arg || "").trim().replace(/^#/, "");
    if (/^\d{1,7}$/.test(q)) {
      const n = Number(q);
      const M = Array.from(S.mtts.values()).find((x) => x.no === n);
      if (M) return M;
      const r = (await getQuery("SELECT state FROM casino_mtt WHERE no = ?", [n]))[0];
      if (r) { try { return JSON.parse(r.state); } catch (e) { return null; } }
      return null;
    }
    if (ID_RE.test(q)) return S.mtts.get(q) || (await loadOne(q));
    if (!q && actor) {
      const mine = await getQuery("SELECT DISTINCT tid FROM casino_mtt_entries WHERE user_id = ? AND state IN ('held','playing')", [String(actor.uid)]);
      if (mine.length === 1) return S.mtts.get(mine[0].tid) || null;
    }
    return null;
  }
  async function run(actor, verb, args, opts) {
    opts = opts || {};
    await ensure();
    verb = String(verb || "").toLowerCase();
    verb = ALIAS[verb] !== undefined ? ALIAS[verb] : verb;
    args = (Array.isArray(args) ? args : []).map((x) => String(x == null ? "" : x)).slice(0, 2);
    if (actor && actor.via === "room" && actor.uid) S.mttSeenRoom.set(String(actor.uid), clock());
    const aud = await audienceFor(actor);
    if (verb === "help") return aud.ok ? R(true, HELP) : R(false, aud.why);
    if (verb === "list") {
      const list = Array.from(S.mtts.values()).filter((M) => ["registering", "running", "scheduled"].includes(M.status)).sort((a, b) => a.start_at - b.start_at);
      if (!aud.ok) {
        const mine = [];
        for (const M of list) if (await activeEntry(M, actor && actor.uid)) mine.push(M);
        return mine.length ? R(true, mine.slice(0, 5).map(listLine).join(" | ")) : R(false, aud.why);
      }
      if (!list.length) return R(true, "🏆 No tournaments scheduled - check back soon.");
      return R(true, list.slice(0, 5).map(listLine).join(" | ") + ` · ${siteBase()}/casino/holdem#mtt`);
    }
    if (verb === "me") {
      const rows = await getQuery("SELECT * FROM casino_mtt_entries WHERE user_id = ? AND (state IN ('held','playing') OR updated > ?) ORDER BY updated DESC LIMIT 5", [String(actor.uid), clock() - MTT.RESULT_MS]);
      if (!rows.length) return R(true, "You're not in a tournament right now. !mtt lists them.", { pm: true });
      const parts = [];
      for (const r of rows) {
        const M = S.mtts.get(r.tid);
        if (!M) continue;
        if (r.state === "held") parts.push(`#${M.no}: registered - starts ${etText(M.start_at)}`);
        else if (r.state === "playing") {
          const w = whereIs(M, actor.uid);
          const stack = w ? (w.T && w.T.eng.seats.includes(String(actor.uid)) ? w.T.eng.chips[String(actor.uid)] : w.transit ? w.transit.chips : 0) : 0;
          parts.push(`#${M.no}: table ${w ? w.no : "?"}, stack ${fmt(stack)}, level ${M.clock.level + 1}, ${M.live_n} left${w && w.T ? ` - ${tableUrl(w.T)}` : ""}`);
        } else if (r.place) parts.push(`#${M.no}: finished ${ord(r.place)}${r.prize ? ` - ${fmt(r.prize)} PAT` : ""}`);
        else parts.push(`#${M.no}: out`);
      }
      return R(true, parts.join(" | ") || "You're not in a tournament right now.", { pm: true });
    }
    if (["pause", "resume", "cancel"].includes(verb)) {
      const u = actor && actor.uid ? await userRow(actor.uid) : null;
      if (!u || !isAdmin(u)) return R(false, "🏆 only an admin with the casino capability can do that.");
      const M = await findM(args[0], null);
      if (!M) return R(false, "No such tournament - !mtt lists them.");
      if (verb === "cancel") {
        if (String(args[1] || "").toLowerCase() !== "confirm") return R(false, `To cancel #${M.no} and refund everyone: !mtt cancel ${M.no} confirm`);
        const r = await cancel(M, "cancelled by an admin", u.username);
        if (r.ok) await audit(u, "cancel", M.id, { status: "?" }, { refunds: r.n, total: r.back }, "chat");
        return r.ok ? R(true, `#${M.no} cancelled - ${r.n} entr${r.n === 1 ? "y" : "ies"} refunded in full (${fmt(r.back)} PAT).`) : R(false, `#${M.no} can't be cancelled now (${r.why}).`);
      }
      const r = await pause(M, u.username, verb === "pause");
      if (r.ok) await audit(u, verb, M.id, null, null, "chat");
      return r.ok ? R(true, `#${M.no} ${verb === "pause" ? "paused - every table holds after its hand" : "resumed"}.`) : R(false, r.error);
    }
    const M = await findM(args[0], actor);
    if (!M) return R(false, args[0] ? "No such tournament - !mtt lists them." : "Which one? !mtt lists them (e.g. !mtt join 12).");
    const visible = aud.ok || (await activeEntry(M, actor && actor.uid));
    if (!visible) return R(false, aud.why);
    if (verb === "info") return R(true, infoText(M));
    if (verb === "top") {
      const ps = await players(M, 1);
      const top = ps.rows.filter((x) => x.status === "playing").slice(0, 5).map((x, i) => `${i + 1}. ${x.name} ${fmt(x.stack)}`);
      return R(true, `🏆 #${M.no}: ${M.live_n} left. ${top.join(" · ") || "no stacks yet"}`);
    }
    if (verb === "join") return register(actor, M, { remind: String(args[1] || "").toLowerCase() === "remind", act_key: opts.act_key });
    if (verb === "leave") return unregister(actor, M, { act_key: opts.act_key });
    if (verb === "remind") return remind(actor, M, String(args[1] || "").toLowerCase() !== "off", { telegram: opts.telegram });
    return R(false, "unknown !mtt option - try: !mtt, !mtt info <no>, !mtt join <no>, !mtt leave <no>, !mtt remind <no>, !mtt me, !mtt top <no>.");
  }

  // ── the admin entry points (routes.js; each under the casino's mutex) ──
  async function admin(op, actor, M, body) {
    body = body || {};
    const u = await userRow(actor.uid);
    if (!u || !isAdmin(u)) return { ok: false, status: 403, error: "Casino admins only." };
    const me = { userId: u.userId, username: u.username };
    if (op === "create") return create(me, body);
    if (!M) return { ok: false, status: 404, error: "No such tournament." };
    if (op === "edit") return edit(me, M, body);
    if (op === "cancel") {
      if (body.confirm !== true) return { ok: false, status: 400, error: "Confirm the cancel." };
      if (!["scheduled", "registering", "running"].includes(M.status)) return { ok: false, status: 409, error: M.status === "finishing" ? "It's finishing - only the owner's void and refund applies now." : "It can't be cancelled now." };
      const before = M.status;
      const r = await cancel(M, String(body.reason || "cancelled by an admin").slice(0, 120), me.username);
      if (r.ok) await audit(me, "cancel", M.id, { status: before }, { refunds: r.n, total: r.back }, body.reason);
      return r.ok ? { ok: true, refunds: r.n, total: r.back } : { ok: false, status: 409, error: r.why };
    }
    if (op === "void") {
      if (!(await ownerOf(me))) return { ok: false, status: 403, error: require("../staffroles").OWNER_ONLY };
      if (body.confirm !== true || !String(body.reason || "").trim()) return { ok: false, status: 400, error: "Type the confirm and a reason." };
      if (M.status !== "finishing") return { ok: false, status: 409, error: "Void and refund is only for a tournament stuck finishing." };
      const r = await cancel(M, String(body.reason).slice(0, 120), me.username, { void: true });
      if (r.ok) await audit(me, "void", M.id, { status: "finishing" }, { refunds: r.n, total: r.back }, body.reason);
      return r.ok ? { ok: true, refunds: r.n, total: r.back } : { ok: false, status: 409, error: r.why === "settled" ? "It has already settled." : r.why };
    }
    if (op === "pause" || op === "resume") { const r = await pause(M, me.username, op === "pause"); if (r.ok) await audit(me, op, M.id); return r; }
    if (op === "start") {
      if (M.status !== "registering" || M.reg_n < M.structure.min_entries) return { ok: false, status: 409, error: `Start now needs registration open and at least ${M.structure.min_entries} in.` };
      await start(M, "admin");
      await audit(me, "start", M.id, { status: "registering" }, { status: M.status });
      return { ok: M.status === "running", status: M.status === "running" ? 200 : 409 };
    }
    if (op === "delay") return delay(me, M, body.minutes);
    if (op === "max") return raiseMax(me, M, body.max_entries);
    if (op === "stream") return streamCmd(me, M, body.on !== false);
    if (op === "overlay-retry") {
      if (!(await ownerOf(me))) return { ok: false, status: 403, error: require("../staffroles").OWNER_ONLY };
      return overlayRetry(me, M);
    }
    if (op === "refund" || op === "dq") {
      const list = await entriesOf(M.id);
      const n = Math.floor(Number(body.n));
      const e = list[n - 1];
      if (!e) return { ok: false, status: 404, error: "No such entry." };
      if (op === "refund") {
        if (M.status !== "registering" || e.state !== "held") return { ok: false, status: 409, error: "Only a held entry before the start." };
        const r = await unregister({ uid: e.user_id }, M, { admin: true });
        await audit(me, "refund_entry", M.id, null, { entry: n });
        return { ok: r.ok, error: r.ok ? null : r.reply };
      }
      return dq(me, M, e.user_id, body.reason);
    }
    return { ok: false, status: 400, error: "Unknown action." };
  }
  async function adminView(M) {
    const rows = await entriesOf(M.id);
    const v = publicView(M);
    const slow = M.h4h.on ? v.h4h_waiting : [];
    return Object.assign({}, v, {
      series: M.series, rooms: M.rooms, stream: M.stream, stream_off: !!M.stream_off_by, scene_held: sceneHeld(), slowest_table: slow[0] || null, tables: tablesView(M),
      finish: M.finish ? { state: M.finish.state, tries: M.finish.tries, last_code: M.finish.last_code || null, overlay: M.finish.overlay ? { amount: M.finish.overlay.amount, state: M.finish.overlay.state, tries: M.finish.overlay.tries, last_code: M.finish.overlay.last_code } : null } : null,
      entries: rows.map((e, i) => ({ n: i + 1, name: (M.people[e.user_id] || {}).name || "?", via: e.via, state: e.state, gen: e.gen, entry_no: e.entry_no, place: e.place, prize: e.prize, dq: !!e.dq })),
    });
  }
  async function adminList() {
    await ensure();
    const rows = await getQuery("SELECT state FROM casino_mtt ORDER BY start_at DESC LIMIT 200");
    return rows.map((r) => { try { return JSON.parse(r.state); } catch (e) { return null; } }).filter(Boolean).map((M) => Object.assign(lobbyRow(S.mtts.get(M.id) || M), {
      est_end: M.start_at + M.structure.est_ms, overlay: M.finish && M.finish.overlay ? M.finish.overlay.state : null, scene_held: sceneHeld(), cancelled: M.cancel ? M.cancel.reason : null }));
  }
  async function logOf(M) {
    return (await getQuery("SELECT ts, kind, data FROM casino_mtt_log WHERE tid = ? ORDER BY id DESC LIMIT 200", [M.id])).map((r) => ({ ts: r.ts, kind: r.kind, data: (() => { try { return JSON.parse(r.data); } catch (e) { return null; } })() }));
  }
  /** the admin card's gate line */
  async function gateState() {
    const st = await loadSettings();
    const g = await BUD.spendGate(clock());
    return { switch: st.mtt_guarantees, spend: g.ok ? "available" : g.why, text: g.ok ? (st.mtt_guarantees === "on" ? "available" : BUD.gateText("switch_off")) : BUD.gateText(g.why) };
  }
  /** the async part of a setting's check (the weekly overlay cap <= the group's budget) */
  async function checkAsync(key, value) {
    if (key === "mtt_overlay_week_cap") {
      const st = await loadSettings();
      const b = await BUD.groupBudget(st.mtt_budget_group);
      if (Number(value) > b) throw new Error(`the weekly overlay cap is at most the ${st.mtt_budget_group} budget (${fmt(b)} PAT/week)`);
    }
  }
  /** web presence (the MTT / table pages poll) */
  const seen = (uid) => { if (uid) S.mttSeen.set(String(uid), clock()); };

  return { MTT, HELP, ensure, loadAll, loadOne, recoverAll, tick, due, run, register, unregister, remind, start, cancel, finish, payOverlay, postSteps, pause,
           beforeDeal, dealt, handEnd, afterHand: handEnd, beforeHand, noDealNext, tick_: tableTick, tableTick, due_: tableDue, recoverTable, tableVerb, view, meView,
           outAtDeal, outNow, publicView, results, players, tablesView, meFor, lobby, leaderboard, veiledPoints, admin, adminView, adminList, logOf, gateState,
           checkAsync, privateMtt, noteScene, sceneHeld, seen, canSee, activeEntry, infoText, chipsInPlay, whereIs, liveTables, layout, entriesOf, saveMtt, applyDq,
           _lineQ: lineQ, _txn: txn };
}

module.exports = { install, MTT, DEFAULTS, SETTING_KEYS, AUDIENCES, ID_RE, checkMttSetting, readMttSettings, snapshotOf, parseEt, addEtDays, etParts, etText };
