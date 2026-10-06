// royalties.js — room-owner royalties (1.99bi): an incentive for owners to build their rooms up.
//
// A room owner earns a share of the PAT spent in their room:
//   stage   stage_pct % of what people PAY for stage time in the room (paid featuring + priced slots),
//           accrued when the slot settles (mainstage.end, same transaction)
//   spend   spend_pct % of the PAT spent on Pepe's paid chat commands in the room (!ask, !imagine, ...);
//           Pepe reports it in batches (POST /api/rooms/royalties/spend, bot token, idempotent refs)
// The owner's own spending never earns them anything, house rooms (Pepe's) and unowned rooms accrue
// nothing. Accruing moves NO money: it's a ledger line. Money moves only at RELEASE.
//
// Release: once per period (period_days, default weekly, periods start Monday 00:00 UTC) the Federal
// Reserve pays what's pending - but only if the room was ACTIVE enough that period (min_active_days
// days with >= active_minutes minutes bridged live and a peak of >= active_peak people; tracked by
// rooms.noteActivity from the bridge). Paid via funding.fundPayout(flow "room_owner"): a reserve_claims
// row Pepe settles from his Reserve - the same path as level-up rewards. Capped at cap_per_period per
// room per period (the rest waits for the next release). A missed threshold carries the balance
// over; anything still unpaid keep_periods periods after it was earned is forfeited (stays in the
// Reserve). If the Reserve can't cover it, the release is retried on the next tick.
//
//   royalty_ledger   id, room_id, owner_user_id, kind (accrue | release | forfeit), source, base,
//                    amount (>= 0), period, ref (unique: idempotency), created, detail
//   royalty_runs     (room_id, owner_user_id, period) -> outcome (released | missed | nothing | unfunded), amount
//   royalty_config   key/value (admin-tunable on /rooms/admin)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DEFAULTS = {
  enabled: true,
  stage_pct: 20,            // % of paid stage time in the room
  spend_pct: 10,            // % of Pepe's paid chat commands used in the room
  period_days: 7,
  min_active_days: 3,       // days in the period the room must be active
  active_minutes: 60,       // ...a day counts when the room was bridged live this long
  active_peak: 3,           // ...and had at least this many people at once
  cap_per_period: 2000000,  // most one room pays out per period
  keep_periods: 4,          // unpaid accruals older than this many periods are forfeited
};
const EPOCH = Date.UTC(2026, 0, 5);      // a Monday: periods start Monday 00:00 UTC
const TICK_MS = 10 * 60 * 1000;

let clock = () => Date.now();
const now = () => clock();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS royalty_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
        source TEXT, base INTEGER, amount INTEGER NOT NULL, period INTEGER NOT NULL, ref TEXT, created INTEGER NOT NULL, detail TEXT)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS royalty_ledger_ref ON royalty_ledger (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS royalty_ledger_room ON royalty_ledger (room_id, owner_user_id, period)");
      await runQuery(`CREATE TABLE IF NOT EXISTS royalty_runs (
        room_id TEXT NOT NULL, owner_user_id TEXT NOT NULL, period INTEGER NOT NULL, outcome TEXT NOT NULL, amount INTEGER, at INTEGER,
        PRIMARY KEY (room_id, owner_user_id, period))`);
      await runQuery("CREATE TABLE IF NOT EXISTS royalty_config (key TEXT PRIMARY KEY, value TEXT)");
      await loadConfig();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let CONFIG = { ...DEFAULTS };
function cleanConfig(c) {
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const int = (v, lo, hi, d) => Math.floor(num(v, lo, hi, d));
  return {
    enabled: c.enabled === true || c.enabled === "true" || c.enabled === 1 || c.enabled === "1" || c.enabled === "on",
    stage_pct: Math.round(num(c.stage_pct, 0, 50, DEFAULTS.stage_pct) * 100) / 100,
    spend_pct: Math.round(num(c.spend_pct, 0, 50, DEFAULTS.spend_pct) * 100) / 100,
    period_days: int(c.period_days, 1, 31, DEFAULTS.period_days),
    min_active_days: int(c.min_active_days, 0, 31, DEFAULTS.min_active_days),
    active_minutes: int(c.active_minutes, 0, 1440, DEFAULTS.active_minutes),
    active_peak: int(c.active_peak, 0, 1000, DEFAULTS.active_peak),
    cap_per_period: int(c.cap_per_period, 0, 1e12, DEFAULTS.cap_per_period),
    keep_periods: int(c.keep_periods, 1, 52, DEFAULTS.keep_periods),
  };
}
async function loadConfig() {
  const rows = await getQuery("SELECT key, value FROM royalty_config");
  const c = { ...DEFAULTS };
  for (const r of rows) { try { if (r.key in DEFAULTS) c[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  CONFIG = cleanConfig(c);
  return CONFIG;
}
async function setConfig(patch, actor) {
  await init();
  const next = cleanConfig({ ...CONFIG, ...(patch || {}) });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO royalty_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
  try { await require("./rooms").event(null, "royalty_config", actor, JSON.stringify(next)); } catch (e) { /* audit only */ }
  return CONFIG;
}
const config = () => ({ ...CONFIG });

const periodMs = () => CONFIG.period_days * 86400000;
const periodOf = (t) => Math.floor((t - EPOCH) / periodMs());
const periodStart = (p) => EPOCH + p * periodMs();

/** The owner's share for a source (pure). */
function share(source, base, C = CONFIG) {
  const pct = source === "stage" ? C.stage_pct : source === "spend" ? C.spend_pct : 0;
  return Math.max(0, Math.floor((Math.max(0, Math.floor(Number(base) || 0)) * pct) / 100));
}

/** Accrue the owner's share of `base` PAT spent in a room. Safe inside a caller's transaction (it
 *  only reads the rooms cache and writes one row). Returns the amount accrued (0 = nothing). */
async function accrue({ room_id, source, base, payer, ref, detail, at }) {
  await init();
  if (!CONFIG.enabled || !room_id || !ref) return 0;
  const R = require("./rooms").getCached(room_id);
  if (!R || !R.owner || R.owner_kind !== "user") return 0;            // house / unowned rooms: nothing
  if (payer && payer === R.owner.userId) return 0;                      // your own spending doesn't pay you
  const amount = share(source, base);
  if (amount <= 0) return 0;
  const t = at || now();
  const r = await runQuery(`INSERT OR IGNORE INTO royalty_ledger (room_id, owner_user_id, kind, source, base, amount, period, ref, created, detail)
                            VALUES (?, ?, 'accrue', ?, ?, ?, ?, ?, ?, ?)`,
                           [room_id, R.owner.userId, source, Math.floor(Number(base) || 0), amount, periodOf(t), String(ref).slice(0, 160), t,
                            detail ? String(detail).slice(0, 200) : null]);
  return r && r.changes ? amount : 0;
}

/** Pepe's batch of chat-command spending: [{room, amount, login, cmd, ref}]. Returns how many accrued. */
async function spendBatch(items) {
  await init();
  const rooms = require("./rooms");
  await rooms.init();
  let n = 0;
  const payers = new Map();
  for (const it of (Array.isArray(items) ? items : []).slice(0, 500)) {
    if (!it || typeof it !== "object") continue;
    const room = String(it.room || "").slice(0, 128), ref = String(it.ref || "").slice(0, 120);
    const amount = Math.floor(Number(it.amount) || 0);
    if (!room || !ref || amount <= 0 || amount > 1e8) continue;
    const login = String(it.login || "").trim().toLowerCase().slice(0, 40);
    let payer = null;
    if (login) {
      if (!payers.has(login)) {
        let row = null;
        try { row = (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = ? LIMIT 1", [login]))[0]; } catch (e) { row = null; }
        payers.set(login, row ? row.userId : null);
      }
      payer = payers.get(login);
    }
    const at = Number(it.ts) > 1e12 && Number(it.ts) < now() + 60000 ? Math.floor(Number(it.ts)) : now();
    if (await accrue({ room_id: room, source: "spend", base: amount, payer, ref: "spend:" + ref, at,
                       detail: `!${String(it.cmd || "command").replace(/[^\w-]/g, "").slice(0, 20)}${login ? " by " + login : ""}` })) n++;
  }
  return n;
}

async function sums(roomId, ownerId, upTo) {
  const q = upTo == null
    ? await getQuery(`SELECT kind, COALESCE(SUM(amount),0) AS t FROM royalty_ledger WHERE room_id = ? AND owner_user_id = ? GROUP BY kind`, [roomId, ownerId])
    : await getQuery(`SELECT kind, COALESCE(SUM(amount),0) AS t FROM royalty_ledger WHERE room_id = ? AND owner_user_id = ? AND (kind != 'accrue' OR period <= ?) GROUP BY kind`, [roomId, ownerId, upTo]);
  const o = { accrue: 0, release: 0, forfeit: 0 };
  for (const r of q) o[r.kind] = Number(r.t) || 0;
  return o;
}

/** Days in period p the room counted as active. */
async function activeDays(roomId, p) {
  const rooms = require("./rooms");
  const rows = await rooms.activity(roomId, periodStart(p), periodStart(p + 1));
  return rows.filter((d) => d.minutes >= CONFIG.active_minutes && d.peak >= CONFIG.active_peak).length;
}

/** Process the period that just closed for every room/owner with something pending. */
async function releaseTick() {
  await init();
  if (!CONFIG.enabled) return [];
  const funding = require("./funding");
  const rooms = require("./rooms");
  const t = now();
  const P = periodOf(t) - 1;
  const out = [];
  const pairs = await getQuery("SELECT DISTINCT room_id, owner_user_id FROM royalty_ledger WHERE kind = 'accrue' AND period <= ?", [P]);
  for (const { room_id: room, owner_user_id: owner } of pairs) {
    const run = (await getQuery("SELECT outcome FROM royalty_runs WHERE room_id = ? AND owner_user_id = ? AND period = ?", [room, owner, P]))[0];
    if (run && run.outcome !== "unfunded") continue;
    const R = rooms.getCached(room);
    const title = (R && R.title) || room;
    // forfeit what's been waiting too long (oldest first: releases always pay the oldest)
    const old = await sums(room, owner, P - CONFIG.keep_periods);
    const stale = old.accrue - old.release - old.forfeit;
    if (stale > 0) {
      await runQuery(`INSERT OR IGNORE INTO royalty_ledger (room_id, owner_user_id, kind, source, amount, period, ref, created, detail)
                      VALUES (?, ?, 'forfeit', 'expiry', ?, ?, ?, ?, ?)`,
                     [room, owner, stale, P, `forfeit:${room}:${owner}:${P}`, t, `unpaid for ${CONFIG.keep_periods} periods`]);
    }
    const s = await sums(room, owner, P);
    const pending = s.accrue - s.release - s.forfeit;
    const setRun = (outcome, amount) => runQuery(`INSERT INTO royalty_runs (room_id, owner_user_id, period, outcome, amount, at) VALUES (?, ?, ?, ?, ?, ?)
                                                  ON CONFLICT(room_id, owner_user_id, period) DO UPDATE SET outcome = excluded.outcome, amount = excluded.amount, at = excluded.at`,
                                                 [room, owner, P, outcome, amount, t]);
    if (pending <= 0) { await setRun("nothing", 0); out.push({ room, owner, outcome: "nothing" }); continue; }
    const days = await activeDays(room, P);
    if (days < CONFIG.min_active_days) {
      await setRun("missed", 0);
      require("./rooms").notify(owner, { kind: "room", title: `Royalties for ${title} carried over`,
        body: `${title} was active on ${days} of the ${CONFIG.min_active_days} days needed last period, so ${pending.toLocaleString("en-US")} PAT waits for a busier one (unpaid royalties expire after ${CONFIG.keep_periods} periods).`,
        link: R ? `/rooms/${encodeURIComponent(R.slug)}/manage#royalties` : "/inbox", ref: `roy-miss:${room}:${P}`, pm: false }).catch(() => {});
      out.push({ room, owner, outcome: "missed", days });
      continue;
    }
    const amount = CONFIG.cap_per_period > 0 ? Math.min(pending, CONFIG.cap_per_period) : pending;
    const paid = await funding.fundPayout(owner, amount, "room_owner", `room owner royalties: ${title}`);
    if (!paid) {
      if (!run) {
        require("./rooms").notify(owner, { kind: "room", title: `Royalties for ${title} are delayed`,
          body: `The Federal Reserve can't cover ${amount.toLocaleString("en-US")} PAT right now - it's paid as soon as it can.`,
          link: R ? `/rooms/${encodeURIComponent(R.slug)}/manage#royalties` : "/inbox", ref: `roy-late:${room}:${P}`, pm: false }).catch(() => {});
      }
      await setRun("unfunded", amount);
      out.push({ room, owner, outcome: "unfunded", amount });
      continue;
    }
    await runQuery(`INSERT OR IGNORE INTO royalty_ledger (room_id, owner_user_id, kind, source, amount, period, ref, created, detail)
                    VALUES (?, ?, 'release', 'reserve', ?, ?, ?, ?, ?)`,
                   [room, owner, amount, P, `release:${room}:${owner}:${P}`, t, `${days} active days`]);
    await setRun("released", amount);
    require("./rooms").notify(owner, { kind: "room", title: `+${amount.toLocaleString("en-US")} PAT room royalties for ${title}`,
      body: `Paid by the Federal Reserve for last period (${days} active days).` + (pending > amount ? ` ${(pending - amount).toLocaleString("en-US")} PAT over the cap waits for the next release.` : ""),
      link: R ? `/rooms/${encodeURIComponent(R.slug)}/manage#royalties` : "/wallet", ref: `roy-paid:${room}:${P}` }).catch(() => {});
    out.push({ room, owner, outcome: "released", amount });
  }
  return out;
}

/** What the owner dashboard shows for one room + owner. */
async function status(roomId, ownerId) {
  await init();
  const t = now();
  const P = periodOf(t);
  const all = await sums(roomId, ownerId);
  const thisP = await getQuery(`SELECT source, COALESCE(SUM(amount),0) AS t, COALESCE(SUM(base),0) AS b FROM royalty_ledger
                                WHERE room_id = ? AND owner_user_id = ? AND kind = 'accrue' AND period = ? GROUP BY source`, [roomId, ownerId, P]);
  const bySrc = { stage: 0, spend: 0 };
  for (const r of thisP) bySrc[r.source] = Number(r.t) || 0;
  const recent = await getQuery(`SELECT kind, source, base, amount, period, created, detail FROM royalty_ledger WHERE room_id = ? AND owner_user_id = ?
                                 ORDER BY id DESC LIMIT 20`, [roomId, ownerId]);
  const runs = await getQuery("SELECT period, outcome, amount, at FROM royalty_runs WHERE room_id = ? AND owner_user_id = ? ORDER BY period DESC LIMIT 8", [roomId, ownerId]);
  return {
    config: config(), period: { index: P, start: periodStart(P), end: periodStart(P + 1) },
    this_period: { stage: bySrc.stage, spend: bySrc.spend, total: bySrc.stage + bySrc.spend },
    pending: all.accrue - all.release - all.forfeit, paid: all.release, forfeited: all.forfeit, earned: all.accrue,
    active_days: await activeDays(roomId, P), active_days_needed: CONFIG.min_active_days,
    next_release: periodStart(P + 1), recent, runs,
  };
}

/** Admin overview: every room/owner with anything on the ledger. */
async function overview() {
  await init();
  return getQuery(`SELECT room_id, owner_user_id, SUM(CASE WHEN kind='accrue' THEN amount ELSE 0 END) AS earned,
                   SUM(CASE WHEN kind='release' THEN amount ELSE 0 END) AS paid, SUM(CASE WHEN kind='forfeit' THEN amount ELSE 0 END) AS forfeited
                   FROM royalty_ledger GROUP BY room_id, owner_user_id ORDER BY earned DESC LIMIT 100`);
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => releaseTick().catch((e) => console.error("[royalties] tick:", e.message)), TICK_MS);
  timer.unref();
  setTimeout(() => releaseTick().catch((e) => console.error("[royalties] tick:", e.message)), 60 * 1000).unref();
}

module.exports = {
  init, accrue, spendBatch, releaseTick, status, overview, setConfig, config, share, periodOf, periodStart, activeDays, start, DEFAULTS, EPOCH,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
