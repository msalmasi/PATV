// roomvaults.js — economy v2 E-3: ROOM VAULTS on the site (camfrog-bot docs/ECONOMY-V2.md 6.4, 7, 12; Pepe's
// pepe_roomvault.py, flag econ_room_vaults). Accumulate only: nothing pays out of a room vault here.
//
// The vaults live in Pepe (room:<room id> pools); the site shows them. Pepe posts his state every few minutes and
// right after a change:
//   POST /api/g/roomvaults/sync  (bot token) {on, cap, deposit_min, rate: {default, min, max}, total,
//                                 rooms: [{id, balance, days: {yyyy-mm-dd: {in, dep, mig, out, ovf}}, history: [...]}]}
//     -> {ok, settings: {room id: {rate, changed_at, changed_by}}}   (the owner's payout rate, stored for E-4)
//   GET  /api/rooms/:slug/vault       the pad page card's data (public)
//   POST /api/rooms/:slug/vault/rate  {rate}  the pad's owner (or site staff): the daily payout rate, 2-15%,
//                                     at most one change per 7 days (staff are not limited). STORED ONLY: Pepe's E-4
//                                     recipe will use it; nothing pays out yet.
//
// "Inflow" is what the room's own activity routed in (Pepe's room flows + the website's room halves). Deposits and the
// one-time escrow migration are shown on their own and NEVER count as inflow (doc 6.4).
//
//   room_vault_state     room_id PK, balance, days (JSON, Pepe's last 8 days), history (JSON, latest moves), updated
//   room_vault_meta      key/value: on, cap, total, synced (Pepe's last sync), deposit_min, rate bounds
//   room_vault_settings  room_id PK, rate, changed_at (ms), changed_by (userId)
//   room_vault_rate_log  room_id, rate, prev, by (userId), at - the audit trail of rate changes
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const RATE = Object.freeze({ default: 10, min: 2, max: 15 });
const RATE_EVERY_MS = 7 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
let clock = () => Date.now();
const now = () => clock();

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS room_vault_state (room_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0,
        days TEXT, history TEXT, updated INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS room_vault_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS room_vault_settings (room_id TEXT PRIMARY KEY, rate REAL NOT NULL,
        changed_at INTEGER, changed_by TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS room_vault_rate_log (room_id TEXT, rate REAL, prev REAL, by TEXT, at INTEGER)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : 0; };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function cleanDays(d) {
  const out = {};
  for (const [k, v] of Object.entries(d && typeof d === "object" ? d : {}).slice(0, 40)) {
    if (!DAY_RE.test(k) || !v || typeof v !== "object") continue;
    out[k] = { in: int(v.in), dep: int(v.dep), mig: int(v.mig), out: int(v.out), ovf: int(v.ovf), lp: int(v.lp) };   // lp: launchpad grants + owner match
  }
  return out;
}
const KINDS = ["flow", "site", "deposit", "migration", "refund", "challenge", "launch", "match"];   // launch / match: the launchpad
function cleanHistory(h) {
  return (Array.isArray(h) ? h : []).slice(0, 12).map((e) => ({
    ts: int(e && e.ts), kind: KINDS.includes(e && e.kind) ? e.kind : "flow",
    flow: String((e && e.flow) || "").replace(/[^A-Za-z0-9 _:-]/g, "").slice(0, 32),
    amount: int(e && e.amount), overflow: int(e && e.overflow),
  }));
}

async function metaGet() {
  await init();
  const m = {};
  for (const r of await getQuery("SELECT key, value FROM room_vault_meta")) { try { m[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  return m;
}
async function metaSet(m) {
  for (const [k, v] of Object.entries(m)) {
    await runQuery("INSERT INTO room_vault_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  }
}

/** Pepe's state -> the tables (the whole set replaces the old one: a room Pepe no longer lists is at 0). */
async function sync(body) {
  await init();
  const b = body || {};
  const rooms = (Array.isArray(b.rooms) ? b.rooms : []).slice(0, 2000);
  const t = now();
  await require("./boosts").tx(async () => {
    await runQuery("UPDATE room_vault_state SET balance = 0, updated = ?", [t]);
    for (const r of rooms) {
      const id = String((r && r.id) || "").slice(0, 120);
      if (!id) continue;
      await runQuery(`INSERT INTO room_vault_state (room_id, balance, days, history, updated) VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(room_id) DO UPDATE SET balance = excluded.balance, days = excluded.days, history = excluded.history, updated = excluded.updated`,
                     [id, Math.max(0, int(r.balance)), JSON.stringify(cleanDays(r.days)), JSON.stringify(cleanHistory(r.history)), t]);
    }
    await metaSet({ on: b.on === true, cap: int(b.cap) || null, total: Math.max(0, int(b.total)), synced: t,
                    deposit_min: int(b.deposit_min) || null });
  });
  return { settings: await settingsMap() };
}

async function settingsMap() {
  await init();
  const out = {};
  for (const r of await getQuery("SELECT room_id, rate, changed_at, changed_by FROM room_vault_settings")) {
    out[r.room_id] = { rate: Number(r.rate), changed_at: r.changed_at || null, changed_by: r.changed_by || null };
  }
  return out;
}

/** The pad page card. Days: Pepe's local days, the last 7 (today included). */
async function card(roomId, user, opts = {}) {
  await init();
  const id = String(roomId || "");
  const meta = await metaGet();
  const st = (await getQuery("SELECT balance, days, history, updated FROM room_vault_state WHERE room_id = ?", [id]))[0] || null;
  const set = (await getQuery("SELECT rate, changed_at, changed_by FROM room_vault_settings WHERE room_id = ?", [id]))[0] || null;
  let days = {};
  let history = [];
  try { days = st && st.days ? JSON.parse(st.days) : {}; } catch (e) { days = {}; }
  try { history = st && st.history ? JSON.parse(st.history) : []; } catch (e) { history = []; }
  const keys = Object.keys(days).sort().slice(-7);
  const sum = (f) => keys.reduce((s, k) => s + int((days[k] || {})[f]), 0);
  const t = now();
  const changedAt = set && set.changed_at ? Number(set.changed_at) : null;
  const nextChange = changedAt ? changedAt + RATE_EVERY_MS : null;
  const canSet = !!opts.canManage;
  const staff = !!opts.staff;
  return {
    live: meta.on === true, synced: meta.synced || null, cap: meta.cap || 50000000, deposit_min: meta.deposit_min || 1000,
    balance: st ? int(st.balance) : 0,
    inflow7: sum("in"), deposits7: sum("dep"), migrated7: sum("mig"), paid7: sum("out"), overflow7: sum("ovf"), launch7: sum("lp"),
    days: keys.map((k) => ({ day: k, in: int(days[k].in), dep: int(days[k].dep), mig: int(days[k].mig), out: int(days[k].out) })),
    history: history.slice(0, 8),
    rate: set ? Number(set.rate) : RATE.default, rate_default: !set, rate_changed: changedAt,
    rate_bounds: { min: RATE.min, max: RATE.max },
    can_set_rate: canSet, rate_locked_until: canSet && !staff && nextChange && nextChange > t ? nextChange : null,
  };
}

/** The owner (or staff) sets the payout rate: 2-15%, whole or half percent, once per 7 days (staff: any time). */
async function setRate(roomId, user, rate) {
  await init();
  const rooms = require("./rooms");
  const R = await rooms.get(String(roomId || ""));
  if (!R) throw new Refuse(404, "No such pad.");
  if (rooms.platformOf(R.id) !== "camfrog") throw new Refuse(400, "Only pads with a Camfrog room have a room vault.");
  if (!(await rooms.canManage(user, R.id))) throw new Refuse(403, "Only the pad's owner can set its payout rate.");
  const r = Math.round(Number(rate) * 2) / 2;
  if (!Number.isFinite(r) || r < RATE.min || r > RATE.max) throw new Refuse(400, `Pick a rate between ${RATE.min}% and ${RATE.max}%.`);
  const staff = rooms.isStaff(user);
  const t = now();
  return require("./boosts").tx(async () => {
    const cur = (await getQuery("SELECT rate, changed_at FROM room_vault_settings WHERE room_id = ?", [R.id]))[0] || null;
    if (cur && Number(cur.rate) === r) return { rate: r, changed: false };
    if (!staff && cur && cur.changed_at && t - Number(cur.changed_at) < RATE_EVERY_MS) {
      const d = Math.ceil((Number(cur.changed_at) + RATE_EVERY_MS - t) / DAY_MS);
      throw new Refuse(429, `The rate can change once a week - try again in ${d} day${d === 1 ? "" : "s"}.`);
    }
    await runQuery(`INSERT INTO room_vault_settings (room_id, rate, changed_at, changed_by) VALUES (?, ?, ?, ?)
                    ON CONFLICT(room_id) DO UPDATE SET rate = excluded.rate, changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
                   [R.id, r, t, user.userId]);
    await runQuery("INSERT INTO room_vault_rate_log (room_id, rate, prev, by, at) VALUES (?, ?, ?, ?, ?)",
                   [R.id, r, cur ? Number(cur.rate) : RATE.default, user.userId, t]);
    try { await rooms.event(R.id, "vault-rate", user.username || "", `${cur ? cur.rate : RATE.default}% -> ${r}%`); } catch (e) { /* audit only */ }
    return { rate: r, changed: true };
  });
}

/** The economy page: the total and the biggest vaults (only while live or once anything is in them). */
async function overview(limit = 10) {
  await init();
  const meta = await metaGet();
  const rows = await getQuery("SELECT room_id, balance, days FROM room_vault_state WHERE balance > 0 ORDER BY balance DESC LIMIT ?", [limit]);
  const rooms = require("./rooms");
  const out = [];
  for (const r of rows) {
    let days = {};
    try { days = JSON.parse(r.days || "{}"); } catch (e) { days = {}; }
    const keys = Object.keys(days).sort().slice(-7);
    const R = await rooms.get(r.room_id).catch(() => null);
    out.push({ room_id: r.room_id, title: R ? R.title : r.room_id, slug: R ? R.slug : null, balance: int(r.balance),
               inflow7: keys.reduce((s, k) => s + int(days[k].in), 0) });
  }
  return { live: meta.on === true, total: int(meta.total), cap: meta.cap || 50000000, rooms: out };
}

function register(app, { addUser, isBotToken }) {
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[roomvaults]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const resolve = (slug) => require("./roomsweb").resolveRoom(slug);
  app.post("/api/g/roomvaults/sync", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, ...(await sync(b)) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/vault", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await resolve(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const rooms = require("./rooms");
      const manage = await rooms.canManage(req.user, R.id);
      res.json({ ok: true, vault: await card(R.id, req.user, { canManage: manage, staff: rooms.isStaff(req.user) }) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/vault/rate", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.is("application/json")) throw new Refuse(415, "JSON only.");
      if (!req.user || !req.user.userId) throw new Refuse(401, "Sign in first.");
      const R = await resolve(req.params.slug);
      if (!R) throw new Refuse(404, "No such pad.");
      const r = await setRate(R.id, req.user, (req.body || {}).rate);
      const rooms = require("./rooms");
      res.json({ ok: true, ...r, vault: await card(R.id, req.user, { canManage: true, staff: rooms.isStaff(req.user) }) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, sync, settingsMap, card, setRate, overview, register, RATE, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
