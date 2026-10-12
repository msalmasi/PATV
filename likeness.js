// likeness.js — likeness royalties + opt-outs (1.99qw; soundboards design S1, the user's decisions of 2026-10-11).
//
// When a paid command USES SOMEONE - their cam (!snap, !clip, !look, !camroast, a cam reference in !imagine / !video), their
// mic (!clipmic, the website's 🔊 Clip), their words (a chat quote), them as a roast target, or their cloned voice - that
// person (the SUBJECT) earns a cut of the price. Pepe carves the cut out of the PLATFORM legs of his routing split (never
// the pad owner's share; no PAT is created), deposits it in the likeness hold (his routing row likeness_hold: the Reserve,
// the incentive budget with the economy layers on) and reports it here (POST /api/likeness/sync, bot token). Cuts the
// SITE collects (a chat quote's 250 PAT, quotes.js) book their hold as an "lkhold:<flow>" deposit claim instead.
//
// Here every cut is booked HELD, per subject (an !imagine with two cam references splits it), then RELEASED daily: rows
// whose 24 h hold ended before the last 00:00 UTC are paid by the funding flow "likeness" (Pepe's website payout row -
// the Reserve, or the incentive budget's "royalties" group with the layers on: queued when the week's budget is short).
//
// ANTI-FARMING (applied when a cut is booked; what isn't paid stays in the hold - the platform keeps it):
//   * never to the payer themselves, nor between linked accounts (welcome_bonus dup_of either way, account_merges)
//   * the subject's account must be >= min_age_days old and level >= min_level (7 / 3)
//   * per payer -> subject pair: at most pair_day_cap a UTC day (25,000) - the rest is forfeited
//   * per subject: at most subject_day_cap RELEASED a day (250,000) - the rest stays held for the next days
//   * an opted-out subject earns nothing for that kind (Pepe refuses the command before charging anyway)
//   * staff can FREEZE a subject (an alt finding): nothing is released while frozen; "clawback" forfeits what's held
//
// OPT-OUTS (D4: everyone is opted IN - it's a public chatroom): likeness_prefs per account, kinds clips (mic clips + chat
// quotes), snaps (!snap + !clip), cam (!look, !camroast, cam references), roast, soundboard (your mic clips on
// soundboards). Set on /settings/likeness or with Pepe's `!likeness <kind> off` (POST /api/likeness/prefs/bot). Pepe
// gets the opted-out logins, the DM blocks between Camfrog-linked accounts and the cut % with every sync.
//
//   likeness_prefs    user_id, clips, snaps, cam, roast, soundboard (1 = allowed), updated
//   likeness_ledger   id, ref (unique), subject_user_id, subject_login, payer_user_id, payer_login, cmd, kind, flow, room_id,
//                     base, amount, status held|paying|paid|forfeit|void, reason, batch, created, release_after, released_at, day
//   likeness_frozen   user_id, by, reason, at
//   likeness_config   key/value (admin: /admin/likeness)
"use strict";
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = Object.freeze(["clips", "snaps", "cam", "roast", "soundboard"]);
const DEFAULT_PCT = Object.freeze({ clipmic: 40, quote: 40, clip: 40, snap: 40, look: 15, camroast: 15, roast: 10, imagine: 40, video: 40,
  voice: 30, voice_unlock: 20, sb_voice: 30, sb_mic: 30, sb_pack: 15 });
// which opt-out kind each command key belongs to (null = none: voices are opt-in by cloning)
const KIND_OF = Object.freeze({ clipmic: "clips", quote: "clips", clip: "snaps", snap: "snaps", look: "cam", camroast: "cam", imagine: "cam",
  video: "cam", roast: "roast", sb_mic: "soundboard", voice: null, voice_unlock: null, sb_voice: null, sb_pack: null });
const DEFAULTS = Object.freeze({
  enabled: true,
  hold_hours: 24,
  subject_day_cap: 250000,
  pair_day_cap: 25000,
  min_age_days: 7,
  min_level: 3,
  quote_price: 250,            // a chat quote (quotes.js) - 40% of it to the people quoted
  pct: DEFAULT_PCT,
});
const DAY = 24 * 3600 * 1000;
const TICK_MS = 10 * 60 * 1000;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const REF_RE = /^[\w:.\-]{1,160}$/;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const midnight = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }

let CONFIG = JSON.parse(JSON.stringify(DEFAULTS));
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS likeness_prefs (user_id TEXT PRIMARY KEY, clips INTEGER NOT NULL DEFAULT 1, snaps INTEGER NOT NULL DEFAULT 1,
        cam INTEGER NOT NULL DEFAULT 1, roast INTEGER NOT NULL DEFAULT 1, soundboard INTEGER NOT NULL DEFAULT 1, updated INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS likeness_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, subject_user_id TEXT,
        subject_login TEXT, payer_user_id TEXT, payer_login TEXT, cmd TEXT, kind TEXT, flow TEXT, room_id TEXT, base INTEGER, amount INTEGER NOT NULL,
        status TEXT NOT NULL, reason TEXT, batch TEXT, created INTEGER NOT NULL, release_after INTEGER, released_at INTEGER, day TEXT)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS likeness_ledger_ref ON likeness_ledger (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS likeness_ledger_subject ON likeness_ledger (subject_user_id, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS likeness_ledger_pair ON likeness_ledger (payer_user_id, subject_user_id, day)");
      await runQuery("CREATE TABLE IF NOT EXISTS likeness_frozen (user_id TEXT PRIMARY KEY, by TEXT, reason TEXT, at INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS likeness_config (key TEXT PRIMARY KEY, value TEXT)");
      await loadConfig();
      await recoverPaying();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── config ──
function cleanConfig(c) {
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };
  const x = c && typeof c === "object" ? c : {};
  const pct = {};
  for (const k of Object.keys(DEFAULT_PCT)) {
    const v = x.pct && x.pct[k] !== undefined ? Number(x.pct[k]) : DEFAULT_PCT[k];
    pct[k] = Number.isFinite(v) ? Math.min(k === "voice" ? 50 : 100, Math.max(0, Math.round(v * 100) / 100)) : DEFAULT_PCT[k];
  }
  return {
    enabled: x.enabled === undefined ? DEFAULTS.enabled : x.enabled !== false,
    hold_hours: num(x.hold_hours, 0, 24 * 14, DEFAULTS.hold_hours),
    subject_day_cap: num(x.subject_day_cap, 0, 1e9, DEFAULTS.subject_day_cap),
    pair_day_cap: num(x.pair_day_cap, 0, 1e9, DEFAULTS.pair_day_cap),
    min_age_days: num(x.min_age_days, 0, 365, DEFAULTS.min_age_days),
    min_level: num(x.min_level, 0, 1000, DEFAULTS.min_level),
    quote_price: num(x.quote_price, 0, 1e7, DEFAULTS.quote_price),
    pct,
  };
}
async function loadConfig() {
  const rows = await getQuery("SELECT key, value FROM likeness_config");
  const o = {};
  for (const r of rows) { try { o[r.key] = JSON.parse(r.value); } catch (e) { /* ignore a bad row */ } }
  CONFIG = cleanConfig(Object.assign({}, DEFAULTS, o));
  return CONFIG;
}
async function setConfig(patch, actor) {
  await init();
  const next = cleanConfig(Object.assign({}, CONFIG, patch || {}, { pct: Object.assign({}, CONFIG.pct, (patch && patch.pct) || {}) }));
  for (const [k, v] of Object.entries(next)) {
    await runQuery("INSERT INTO likeness_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  }
  CONFIG = next;
  console.log(`[likeness] config changed by ${actor || "?"}`);
  return CONFIG;
}
const config = () => CONFIG;
const pctOf = (key) => Number(CONFIG.pct[key] != null ? CONFIG.pct[key] : DEFAULT_PCT[key] || 0);

// ── accounts ──
async function userByLogin(login) {
  const l = low(login);
  if (!l || !LOGIN_RE.test(l)) return null;
  let C = false;
  try { C = (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { C = false; }
  return (await getQuery(`SELECT userId, username, camfrogUsername, level, created_at, class FROM users WHERE lower(camfrogUsername) = ? ${C ? "AND archived_at IS NULL" : ""}
                          ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [l]))[0] || null;
}
async function userById(id) {
  return id ? (await getQuery("SELECT userId, username, camfrogUsername, level, created_at, class FROM users WHERE userId = ?", [String(id)]))[0] || null : null;
}
const createdMs = (u) => {
  const v = u && u.created_at;
  if (v == null) return 0;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const t = Date.parse(String(v).replace(" ", "T") + (/[zZ+]/.test(String(v)) ? "" : "Z"));
  return Number.isFinite(t) ? t : 0;
};
/** Two accounts that are really one person: the same id, a dedupe link (welcome_bonus dup_of) or a merge. */
async function linked(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const q = async (sql, args) => { try { return (await getQuery(sql, args)).length > 0; } catch (e) { return false; } };
  return (await q("SELECT 1 FROM welcome_bonus WHERE (userId = ? AND dup_of = ?) OR (userId = ? AND dup_of = ?) LIMIT 1", [a, b, b, a]))
      || (await q("SELECT 1 FROM account_merges WHERE (old_id = ? AND new_id = ?) OR (old_id = ? AND new_id = ?) LIMIT 1", [a, b, b, a]));
}

// ── opt-outs ──
async function prefsOf(userId) {
  await init();
  const r = userId ? (await getQuery("SELECT * FROM likeness_prefs WHERE user_id = ?", [String(userId)]))[0] : null;
  const out = {};
  for (const k of KINDS) out[k] = !r || r[k] !== 0;
  return out;
}
async function setPrefs(userId, patch) {
  await init();
  if (!userId) throw new Refuse(401, "Sign in first.");
  const cur = await prefsOf(userId);
  for (const k of KINDS) if (patch && typeof patch[k] === "boolean") cur[k] = patch[k];
  await runQuery(`INSERT INTO likeness_prefs (user_id, clips, snaps, cam, roast, soundboard, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET clips = excluded.clips, snaps = excluded.snaps, cam = excluded.cam, roast = excluded.roast,
                  soundboard = excluded.soundboard, updated = excluded.updated`,
                 [String(userId), ...KINDS.map((k) => (cur[k] ? 1 : 0)), now()]);
  return cur;
}
async function allows(userId, kind) {
  if (!kind) return true;
  return (await prefsOf(userId))[kind] !== false;
}
/** {login: [kinds opted out]} for every Camfrog-linked account with an opt-out (Pepe's cache). */
async function optoutMap() {
  await init();
  const rows = await getQuery(`SELECT p.*, u.camfrogUsername AS cf FROM likeness_prefs p JOIN users u ON u.userId = p.user_id
                               WHERE u.camfrogUsername IS NOT NULL AND u.camfrogUsername != '' AND (p.clips = 0 OR p.snaps = 0 OR p.cam = 0 OR p.roast = 0 OR p.soundboard = 0)`);
  const out = {};
  for (const r of rows) {
    const off = KINDS.filter((k) => r[k] === 0);
    const l = low(r.cf);
    if (off.length && l) out[l] = [...new Set([...(out[l] || []), ...off])];
  }
  return out;
}
/** [[blocker_login, blocked_login]]: DM blocks between Camfrog-linked accounts (Pepe refuses likeness commands on a blocker). */
async function blockPairs() {
  try {
    const rows = await getQuery(`SELECT a.camfrogUsername AS a, b.camfrogUsername AS b FROM dm_blocks d JOIN users a ON a.userId = d.blocker_id
                                 JOIN users b ON b.userId = d.blocked_id
                                 WHERE a.camfrogUsername IS NOT NULL AND a.camfrogUsername != '' AND b.camfrogUsername IS NOT NULL AND b.camfrogUsername != '' LIMIT 20000`);
    return rows.map((r) => [low(r.a), low(r.b)]);
  } catch (e) { return []; }
}

// ── booking cuts ──
async function frozen(userId) {
  return userId ? (await getQuery("SELECT 1 FROM likeness_frozen WHERE user_id = ?", [String(userId)])).length > 0 : false;
}
/** Why `subject` can't earn this cut from `payerId` (null = it can). */
async function ineligible(subject, payerId, kind) {
  if (!subject) return "not a PATV account";
  if (payerId && (await linked(subject.userId, payerId))) return "self or a linked account";
  if (kind && !(await allows(subject.userId, kind))) return "opted out";
  if (CONFIG.min_age_days && now() - createdMs(subject) < CONFIG.min_age_days * DAY) return `account under ${CONFIG.min_age_days} days`;
  if (Number(subject.level || 0) < CONFIG.min_level) return `below level ${CONFIG.min_level}`;
  return null;
}
async function pairToday(payerId, subjectId, day) {
  if (!payerId) return 0;
  const r = await getQuery(`SELECT COALESCE(SUM(amount),0) AS t FROM likeness_ledger WHERE payer_user_id = ? AND subject_user_id = ? AND day = ?
                            AND status IN ('held','paying','paid')`, [payerId, subjectId, day]);
  return Number((r[0] || {}).t) || 0;
}
async function insertRow(row) {
  const r = await runQuery(`INSERT OR IGNORE INTO likeness_ledger (ref, subject_user_id, subject_login, payer_user_id, payer_login, cmd, kind, flow, room_id,
                            base, amount, status, reason, created, release_after, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [row.ref, row.subject_user_id || null, row.subject_login || null, row.payer_user_id || null, row.payer_login || null, row.cmd || null,
                            row.kind || null, row.flow || null, row.room_id || null, row.base || 0, row.amount, row.status, row.reason || null, row.created,
                            row.release_after || null, row.day]);
  return !!(r && r.changes);
}

/**
 * Book one cut (already in the hold): {ref, key, kind, flow, subjects: [logins], payer (login) | payerId, room, base, amount, ts}.
 * Safe inside a caller's transaction (only runQuery). Idempotent per ref. -> {held, forfeit, dup}
 */
async function book(it) {
  await init();
  const ref = String(it.ref || "").slice(0, 120);
  const amount = Math.floor(Number(it.amount) || 0);
  if (!REF_RE.test(ref) || amount <= 0 || amount > 1e9) return { held: 0, forfeit: 0, bad: true };
  if ((await getQuery("SELECT 1 FROM likeness_ledger WHERE ref = ? OR ref LIKE ? OR ref = ? LIMIT 1", [ref, ref + ":%", "void:" + ref])).length) return { held: 0, forfeit: 0, dup: true };
  const t = Number(it.ts) > 1e12 && Number(it.ts) < now() + 60000 ? Math.floor(Number(it.ts)) : now();
  const day = dayOf(t);
  const cmd = String(it.key || it.flow || "").replace(/[^\w-]/g, "").slice(0, 24) || "other";
  const kind = KINDS.includes(it.kind) ? it.kind : (KIND_OF[cmd] || null);
  const flow = String(it.flow || cmd).replace(/[^\w:-]/g, "").slice(0, 40);
  const room = it.room ? String(it.room).slice(0, 128) : null;
  const payerLogin = low(it.payer) || null;
  const payer = it.payerId ? await userById(it.payerId) : (payerLogin ? await userByLogin(payerLogin) : null);
  const payerId = payer ? payer.userId : (it.payerId || null);
  const logins = [...new Set((Array.isArray(it.subjects) ? it.subjects : []).map(low).filter((l) => LOGIN_RE.test(l)))].slice(0, 8);
  const base = Math.max(amount, Math.floor(Number(it.base) || 0));
  let held = 0, forfeit = 0;
  const common = { payer_user_id: payerId, payer_login: payerLogin, cmd, kind, flow, room_id: room, base, created: t, day };
  if (!logins.length || !CONFIG.enabled) {
    await insertRow(Object.assign({}, common, { ref: ref + ":0", amount, status: "forfeit", reason: CONFIG.enabled ? "no subject" : "likeness royalties off" }));
    return { held: 0, forfeit: amount };
  }
  const share = Math.floor(amount / logins.length);
  let dust = amount - share * logins.length;
  for (let i = 0; i < logins.length; i++) {
    let mine = share + (i === 0 ? dust : 0);
    if (i === 0) dust = 0;
    if (mine <= 0) continue;
    const s = await userByLogin(logins[i]);
    const why = await ineligible(s, payerId, kind);
    const rowBase = Object.assign({}, common, { subject_user_id: s ? s.userId : null, subject_login: logins[i] });
    if (why) {
      await insertRow(Object.assign({}, rowBase, { ref: `${ref}:${i}`, amount: mine, status: "forfeit", reason: why }));
      forfeit += mine;
      continue;
    }
    let ok = mine;
    if (CONFIG.pair_day_cap > 0 && payerId) ok = Math.max(0, Math.min(mine, CONFIG.pair_day_cap - (await pairToday(payerId, s.userId, day))));
    if (ok > 0) {
      await insertRow(Object.assign({}, rowBase, { ref: `${ref}:${i}`, amount: ok, status: "held", release_after: t + CONFIG.hold_hours * 3600 * 1000 }));
      held += ok;
    }
    if (mine - ok > 0) {
      await insertRow(Object.assign({}, rowBase, { ref: `${ref}:${i}:cap`, amount: mine - ok, status: "forfeit", reason: "daily pair cap" }));
      forfeit += mine - ok;
    }
  }
  return { held, forfeit };
}

/** A refunded charge: its held rows are voided (never released) and a later copy of the ref can't book again. */
async function voidRef(ref) {
  await init();
  const key = String(ref || "").slice(0, 120);
  if (!REF_RE.test(key)) return false;
  const r = await runQuery("UPDATE likeness_ledger SET status = 'void', reason = 'charge refunded' WHERE (ref = ? OR ref LIKE ?) AND status IN ('held','forfeit')", [key, key + ":%"]);
  await runQuery(`INSERT OR IGNORE INTO likeness_ledger (ref, amount, status, reason, created, day) VALUES (?, 0, 'void', 'charge refunded', ?, ?)`,
                 ["void:" + key, now(), dayOf(now())]);
  return !!(r && r.changes);
}

/** Pepe's batch -> the refs this site has (booked now, or before). */
async function syncBatch(items) {
  const accepted = [];
  for (const it of (Array.isArray(items) ? items : []).slice(0, 500)) {
    if (!it || typeof it !== "object" || !it.ref) continue;
    try {
      if (it.void) await voidRef(it.ref);
      else await book(it);
      accepted.push(String(it.ref));
    } catch (e) { console.error("[likeness] booking", it.ref, e.message); }
  }
  return accepted;
}

/**
 * A cut the SITE collected (inside the caller's transaction): the hold is a "lkhold:<flow>" deposit claim Pepe credits to his
 * likeness hold (or the site's pool while the pools are live), then booked like Pepe's. -> the cut amount (0 = none).
 */
async function siteCut({ key, flow, base, subjects, payerId, room, ref }) {
  await init();
  const pct = pctOf(key);
  const cut = Math.floor((Math.floor(Number(base) || 0) * pct) / 100);
  const subs = (subjects || []).map(low).filter((l) => LOGIN_RE.test(l));
  if (!CONFIG.enabled || cut <= 0 || !subs.length) return 0;
  const { v4: uuidv4 } = require("uuid");
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                 [uuidv4(), "lkhold:" + String(flow || key).replace(/[^\w-]/g, "").slice(0, 30), payerId || null, `likeness cut (held): ${key}`.slice(0, 120), -cut]);
  await book({ ref, key, flow: flow || key, subjects: subs, payerId, room, base, amount: cut });
  return cut;
}

// ── release (daily, after the hold) ──
async function recoverPaying() {
  const rows = await getQuery("SELECT DISTINCT batch, subject_user_id FROM likeness_ledger WHERE status = 'paying' AND batch IS NOT NULL");
  for (const r of rows) {
    const type = typeOf(r.batch);
    let paid = false;
    try {
      paid = (await getQuery("SELECT 1 FROM transactions WHERE userId = ? AND type = ? LIMIT 1", [r.subject_user_id, type])).length > 0
          || (await getQuery("SELECT 1 FROM reserve_claims WHERE userId = ? AND type = ? LIMIT 1", [r.subject_user_id, type])).length > 0;
    } catch (e) { paid = false; }
    await runQuery(`UPDATE likeness_ledger SET status = ?, released_at = CASE WHEN ? = 'paid' THEN ? ELSE released_at END WHERE batch = ? AND status = 'paying'`,
                   [paid ? "paid" : "held", paid ? "paid" : "held", now(), r.batch]);
    if (!paid) await runQuery("UPDATE likeness_ledger SET batch = NULL WHERE batch = ? AND status = 'held'", [r.batch]);
  }
}
const typeOf = (batch) => `🪞 likeness royalties (${batch})`;

let ticking = null;
async function releaseTick() {
  if (ticking) return ticking;
  ticking = (async () => {
    await init();
    if (!CONFIG.enabled) return [];
    const funding = require("./funding");
    const t = now();
    const cutoff = midnight(t);                      // rows whose hold ended before the last 00:00 UTC
    const today = dayOf(t);
    const out = [];
    const subs = await getQuery(`SELECT DISTINCT subject_user_id AS u FROM likeness_ledger WHERE status = 'held' AND subject_user_id IS NOT NULL
                                 AND release_after <= ?`, [cutoff]);
    for (const { u } of subs) {
      if (await frozen(u)) { out.push({ user: u, outcome: "frozen" }); continue; }
      const paidToday = Number(((await getQuery(`SELECT COALESCE(SUM(amount),0) AS t FROM likeness_ledger WHERE subject_user_id = ? AND status IN ('paid','paying')
                                                AND released_at >= ?`, [u, cutoff]))[0] || {}).t) || 0;
      let room = CONFIG.subject_day_cap > 0 ? CONFIG.subject_day_cap - paidToday : Infinity;
      if (room <= 0) { out.push({ user: u, outcome: "capped" }); continue; }
      const rows = await getQuery(`SELECT id, amount FROM likeness_ledger WHERE subject_user_id = ? AND status = 'held' AND release_after <= ? ORDER BY created, id`, [u, cutoff]);
      const ids = [];
      let total = 0;
      for (const r of rows) {
        if (total + r.amount > room) break;
        ids.push(r.id);
        total += r.amount;
      }
      if (!ids.length || total <= 0) { out.push({ user: u, outcome: "capped" }); continue; }
      if (funding.vaultFor("likeness") === "incentives") {
        const can = await funding.fundable("likeness");
        if (can < total && can >= 0) {
          // the week's budget is short: release what fits now (queued otherwise by fundPayout), oldest first
          let s = 0; const keep = [];
          for (const id of ids) { const a = rows.find((r) => r.id === id).amount; if (s + a > can) break; keep.push(id); s += a; }
          if (keep.length) { ids.length = 0; ids.push(...keep); total = s; }
        }
      }
      const batch = `lkr:${u}:${today}:${ids[0]}`;
      const mark = await runQuery(`UPDATE likeness_ledger SET status = 'paying', batch = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'held'`, [batch, ...ids]);
      if (!mark || mark.changes !== ids.length) {
        await runQuery("UPDATE likeness_ledger SET status = 'held', batch = NULL WHERE batch = ? AND status = 'paying'", [batch]);
        continue;
      }
      let r;
      try { r = await funding.fundPayoutEx(u, total, "likeness", typeOf(batch)); } catch (e) { r = { ok: false }; console.error("[likeness] release:", e.message); }
      if (!r || !r.ok) {
        await runQuery("UPDATE likeness_ledger SET status = 'held', batch = NULL WHERE batch = ? AND status = 'paying'", [batch]);
        out.push({ user: u, outcome: "unfunded", amount: total });
        continue;
      }
      await runQuery("UPDATE likeness_ledger SET status = 'paid', released_at = ? WHERE batch = ? AND status = 'paying'", [t, batch]);
      out.push({ user: u, outcome: r.queued ? "queued" : "paid", amount: total });
      try {
        await require("./inbox").addSafe(u, { kind: "system", title: `+${total.toLocaleString("en-US")} PAT likeness royalties`,
          body: r.queued ? "Owed for the times people used your cam, mic, words or voice - it lands as soon as the weekly incentive budget has room."
                         : "For the times people used your cam, mic, words or voice. See what earned it on /settings/likeness.",
          link: "/settings/likeness", ref: "lk-paid:" + batch });
      } catch (e) { /* a notice never blocks a payment */ }
    }
    return out;
  })().finally(() => { ticking = null; });
  return ticking;
}

// ── reads ──
async function status(userId) {
  await init();
  const sums = {};
  for (const r of await getQuery("SELECT status, COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM likeness_ledger WHERE subject_user_id = ? GROUP BY status", [userId])) {
    sums[r.status] = { amount: Number(r.t) || 0, n: r.n };
  }
  const recent = await getQuery(`SELECT cmd, kind, amount, status, reason, created, release_after, released_at, room_id FROM likeness_ledger
                                 WHERE subject_user_id = ? AND status != 'void' ORDER BY created DESC, id DESC LIMIT 30`, [userId]);
  const t = now();
  const nextMidnight = midnight(t) + DAY;
  return { prefs: await prefsOf(userId), frozen: await frozen(userId),
           held: (sums.held || { amount: 0 }).amount + (sums.paying || { amount: 0 }).amount, paid: (sums.paid || { amount: 0 }).amount,
           forfeit: (sums.forfeit || { amount: 0 }).amount, next_release: nextMidnight, recent, config: publicConfig() };
}
function publicConfig() {
  return { enabled: CONFIG.enabled, hold_hours: CONFIG.hold_hours, subject_day_cap: CONFIG.subject_day_cap, pair_day_cap: CONFIG.pair_day_cap,
           min_age_days: CONFIG.min_age_days, min_level: CONFIG.min_level, pct: CONFIG.pct, quote_price: CONFIG.quote_price };
}
async function adminSummary() {
  await init();
  const tot = {};
  for (const r of await getQuery("SELECT status, COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM likeness_ledger GROUP BY status")) tot[r.status] = { amount: Number(r.t) || 0, n: r.n };
  const top = await getQuery(`SELECT l.subject_user_id AS user_id, u.username, u.camfrogUsername AS camfrog,
                                     SUM(CASE WHEN l.status IN ('held','paying') THEN l.amount ELSE 0 END) AS held,
                                     SUM(CASE WHEN l.status = 'paid' THEN l.amount ELSE 0 END) AS paid,
                                     (SELECT 1 FROM likeness_frozen f WHERE f.user_id = l.subject_user_id) AS frozen
                              FROM likeness_ledger l LEFT JOIN users u ON u.userId = l.subject_user_id
                              WHERE l.subject_user_id IS NOT NULL GROUP BY l.subject_user_id ORDER BY held + paid DESC LIMIT 50`);
  const reasons = await getQuery("SELECT reason, COUNT(*) AS n, SUM(amount) AS t FROM likeness_ledger WHERE status = 'forfeit' GROUP BY reason ORDER BY t DESC LIMIT 20");
  const optouts = (await getQuery("SELECT COUNT(*) AS n FROM likeness_prefs WHERE clips = 0 OR snaps = 0 OR cam = 0 OR roast = 0 OR soundboard = 0"))[0].n;
  return { config: CONFIG, totals: tot, top, reasons, optouts };
}
async function freeze(userId, on, by, reason) {
  await init();
  if (on) await runQuery("INSERT OR REPLACE INTO likeness_frozen (user_id, by, reason, at) VALUES (?, ?, ?, ?)", [userId, by || null, String(reason || "").slice(0, 200), now()]);
  else await runQuery("DELETE FROM likeness_frozen WHERE user_id = ?", [userId]);
  return true;
}
/** Staff: forfeit everything still held for a subject (an alt finding). The PAT stays in the hold. -> amount */
async function clawback(userId, by, reason) {
  await init();
  const s = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM likeness_ledger WHERE subject_user_id = ? AND status = 'held'", [userId]))[0];
  await runQuery("UPDATE likeness_ledger SET status = 'forfeit', reason = ? WHERE subject_user_id = ? AND status = 'held'",
                 [`clawback by ${String(by || "staff").slice(0, 40)}: ${String(reason || "").slice(0, 120)}`, userId]);
  return Number((s || {}).t) || 0;
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[likeness] init:", e.message));
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "512kb" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code });
    console.error("[likeness]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const staff = (u) => !!u && ["Admin", "Moderator"].includes(u.class);

  // Pepe: cuts in, opt-outs / blocks / % out
  app.post("/api/likeness/sync", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      await init();
      const accepted = await syncBatch(b.items);
      res.json({ ok: true, accepted, optouts: await optoutMap(), blocks: await blockPairs(), pct: CONFIG.pct, on: CONFIG.enabled });
    } catch (e) { fail(res, e); }
  });
  // Pepe: !likeness <kind> off|on for a Camfrog login
  app.post("/api/likeness/prefs/bot", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const u = await userByLogin(b.camfrog);
      if (!u) return res.status(404).json({ ok: false, error: "no PATV account for that Camfrog name" });
      const kinds = (Array.isArray(b.kinds) ? b.kinds : [b.kind]).filter((k) => KINDS.includes(k));
      if (!kinds.length) return res.status(400).json({ ok: false, error: "kind?" });
      const patch = {};
      for (const k of kinds) patch[k] = b.on === true;
      res.json({ ok: true, prefs: await setPrefs(u.userId, patch) });
    } catch (e) { fail(res, e); }
  });
  // the viewer's own settings + earnings
  app.get("/api/likeness/me", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await status(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/likeness/prefs", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const b = req.body || {};
      const patch = {};
      for (const k of KINDS) if (typeof b[k] === "boolean") patch[k] = b[k];
      res.json({ ok: true, prefs: await setPrefs(req.user.userId, patch) });
    } catch (e) { fail(res, e); }
  });
  app.get("/settings/likeness", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/likeness"));
      res.set("Cache-Control", "private, no-store");
      const extra = {};
      try { extra.voice = await require("./voicestore").ownerSummary(req.user.userId); } catch (e) { extra.voice = null; }
      res.render("likeness", { user: req.user.username, st: await status(req.user.userId), kinds: KINDS, ...extra });
    } catch (e) { next(e); }
  });
  // staff
  app.get("/api/likeness/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!staff(req.user)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await adminSummary()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/likeness/admin", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || req.user.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    try {
      const b = req.body || {};
      if (b.config) await setConfig(b.config, req.user.username);
      if (b.freeze && b.freeze.user) await freeze(String(b.freeze.user), b.freeze.on !== false, req.user.username, b.freeze.reason);
      let clawed = null;
      if (b.clawback && b.clawback.user) clawed = await clawback(String(b.clawback.user), req.user.username, b.clawback.reason);
      if (b.release === true) await releaseTick();
      res.json({ ok: true, clawed, ...(await adminSummary()) });
    } catch (e) { fail(res, e); }
  });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => releaseTick().catch((e) => console.error("[likeness] tick:", e.message)), TICK_MS);
  if (timer.unref) timer.unref();
  setTimeout(() => releaseTick().catch((e) => console.error("[likeness] tick:", e.message)), 90 * 1000).unref();
}

module.exports = {
  KINDS, DEFAULT_PCT, KIND_OF, DEFAULTS, init, config, setConfig, pctOf, prefsOf, setPrefs, allows, optoutMap, blockPairs, book, voidRef, syncBatch,
  siteCut, releaseTick, status, adminSummary, freeze, clawback, register, start, userByLogin, linked, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
