// boosts.js — 🚀 pad boosts and the "room flow" money route (1.99ee; replaces paid featuring).
//
// FEATURING IS EARNED. The homepage's front pad is the automatic fair ranking (frontroom.js); nobody
// can buy it. Anyone signed in can BOOST a pad with PAT instead (fans, the owner, a gang): every
// boost adds to the pad's boost score, which feeds that ranking (frontroom.boostPoints):
//
//     active  = sum of boost PAT, each decayed with a half-life of half_min (60 min)
//     points  = 0 when the pad is quiet (no human chat / mic for dead_min) or has no activity score
//             = min(cap, k * sqrt(active), rel * activity score)        k 0.1 · cap 25 · rel 0.5
//
// so 10k PAT = +10, 40k = +20, ~62.5k = the +25 cap, and never more than half of what the pad's own
// people are doing. Money can tip a close race (the switch rule needs a 1.25x lead), it can't carry
// a dead pad. No exclusive slots: any number of people can boost any pad at any time.
//
// WHERE THE PAT GOES (economy v2 "room flow", camfrog-bot docs/ECONOMY-V2.md 3.1 / 7.1, mapped onto
// what exists in phase E-0 - no new vault is created, nothing is minted or burned):
//   * the booster is debited (one transaction, idempotent by the client's ref);
//   * the FORT KNOX half (ceil 50%) is a negative reserve_claims row that Pepe's funding tick credits
//     (frida-bot _funding_tick). E-1 (Pepe's pepe_layers.py, flag econ_layers): while Pepe reports Fort
//     Knox as live on /api/g/funding-sync (funding.fortknoxLive()), the claim's flow is "fortknox:boost" /
//     "fortknox:stage_slot" and Pepe credits it to Fort Knox (ledger row fk_to = 'fortknox'); otherwise
//     the flow is "boost" / "stage_slot" and it lands in his Federal Reserve as Fort Knox's stand-in;
//   * the ROOM VAULT half (floor 50%) is HELD for that pad in the room-vault escrow below (it never
//     pays out from here) until E-3 opens real room vaults (`room:<id>`) and migrates it;
//   * the pad's owner boosting / paying in their own pad: 100% Fort Knox half (doc 7.1 - self-spend
//     never feeds your own vault). Gangs aren't known to the site yet (E-3+), so that rule waits.
// Stage SLOT fees (an owner may price their pad's slots; free by default) use the same route when
// the slot settles (mainstage.end) - the old 20% owner royalty accrual is not applied to them.
//
//   room_flow_ledger  one row per room-flow charge: ref (unique - idempotency), kind boost|slot_fee,
//                     room_id, payer id / name, amount, fortknox (sent to the Reserve), room_vault
//                     (held in escrow), via web|chat, created, detail, migrated (E-1 / E-3 fill it),
//                     fk_to (E-1: 'fortknox' = the half was booked straight into Fort Knox; NULL = the Reserve)
//     Fort Knox half still in the Reserve: SUM(fortknox) WHERE fk_to IS NULL AND migrated_fk IS NULL. E-1's
//       one-time move (Pepe "!econ fortknox migrate", dry run first) reads it from POST /api/g/fortknox-migration,
//       moves it Reserve -> Fort Knox, then POST /api/g/fortknox-migration/mark stamps migrated_fk on exactly
//       those rows (batch-keyed in fk_migrations, amount-checked, a replay is a no-op)
//     room vault escrow to move at E-3: SUM(room_vault) WHERE migrated_rv IS NULL  (per room_id)
//
// Flags (boost_config, admin): pay (on: PAT moves; off: boosting is refused, nothing charged) - the
// scoring switch is frontroom's cfg.boost.on.
"use strict";
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");

const DEFAULTS = Object.freeze({
  pay: true,
  min: 100,             // PAT per boost
  max: 1000000,
  per_hour: 30,         // boosts per user per hour
});
const HOUR = 3600 * 1000;
const KEEP_MS = 8 * HOUR;            // older boosts are < 0.4% at a 60-min half-life: ignored by the score
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

let clock = () => Date.now();
const now = () => clock();

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS room_flow_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, kind TEXT NOT NULL, room_id TEXT NOT NULL,
        payer_id TEXT, payer_name TEXT, amount INTEGER NOT NULL, fortknox INTEGER NOT NULL, room_vault INTEGER NOT NULL,
        owner_self INTEGER NOT NULL DEFAULT 0, via TEXT, created INTEGER NOT NULL, detail TEXT,
        migrated_fk INTEGER, migrated_rv INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS room_flow_ref ON room_flow_ledger (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS room_flow_room ON room_flow_ledger (kind, room_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS room_flow_payer ON room_flow_ledger (payer_id, created)");
      // E-1: where the Fort Knox half went (NULL = the Reserve, the pre-E-1 stand-in)
      try { await runQuery("ALTER TABLE room_flow_ledger ADD COLUMN fk_to TEXT"); } catch (e) { /* already there */ }
      await runQuery(`CREATE TABLE IF NOT EXISTS fk_migrations (batch TEXT PRIMARY KEY, max_id INTEGER NOT NULL,
        amount INTEGER NOT NULL, rows INTEGER NOT NULL, created INTEGER NOT NULL)`);
      await runQuery("CREATE TABLE IF NOT EXISTS boost_config (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (
        claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
        created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
      await loadConfig();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let CONFIG = { ...DEFAULTS };
function cleanConfig(c) {
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const on = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === 1 || v === "1" || v === "on");
  const o = {
    pay: on(c.pay, DEFAULTS.pay),
    min: int(c.min, 1, 1e9, DEFAULTS.min),
    max: int(c.max, 1, 1e12, DEFAULTS.max),
    per_hour: int(c.per_hour, 1, 1000, DEFAULTS.per_hour),
  };
  if (o.max < o.min) o.max = o.min;
  return o;
}
async function loadConfig() {
  const c = { ...DEFAULTS };
  for (const r of await getQuery("SELECT key, value FROM boost_config")) { try { if (r.key in DEFAULTS) c[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  CONFIG = cleanConfig(c);
  return CONFIG;
}
async function setConfig(patch, actor) {
  await init();
  const next = cleanConfig({ ...CONFIG, ...(patch || {}) });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO boost_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
  try { await require("./rooms").event(null, "boost-config", actor, JSON.stringify(next)); } catch (e) { /* audit only */ }
  return CONFIG;
}
const config = () => ({ ...CONFIG });

// ── the split (pure) ──
/** amount -> {fortknox, room_vault}: 50/50, the odd PAT to Fort Knox; all of it when the payer owns the pad. */
function split(amount, ownerSelf) {
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  if (ownerSelf) return { fortknox: a, room_vault: 0 };
  const room = Math.floor(a / 2);
  return { fortknox: a - room, room_vault: room };
}

// ── decay (pure) ──
/** Boost PAT still "active" at `t`: each boost halves every halfMin minutes. rows = [{amount, created}] */
function activePat(rows, t, halfMin = 60) {
  const hl = Math.max(1, Number(halfMin) || 60) * 60000;
  let s = 0;
  for (const r of rows || []) {
    const age = t - Number(r.created);
    if (!(age >= 0)) continue;
    s += Math.max(0, Number(r.amount) || 0) * Math.pow(0.5, age / hl);
  }
  return s;
}

/**
 * Book one room-flow charge INSIDE the caller's open transaction (the payer has already been
 * debited in it). Inserts the ledger row (unique ref: a replay throws, the transaction rolls back)
 * and the Reserve claim for the Fort Knox half. Returns the row.
 */
async function routeInTx({ ref, kind, room_id, payer_id, payer_name, amount, owner_self, via, detail, flow }) {
  const a = Math.floor(Number(amount) || 0);
  if (!(a > 0)) throw new Refuse(400, "Nothing to route.");
  const sp = split(a, owner_self);
  const t = now();
  // E-1: Fort Knox is live in Pepe -> book the half straight into it; else the Reserve (migrated later)
  const fk = sp.fortknox > 0 && require("./funding").fortknoxLive();
  await runQuery(`INSERT INTO room_flow_ledger (ref, kind, room_id, payer_id, payer_name, amount, fortknox, room_vault, owner_self, via, created, detail, fk_to)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [ref, kind, room_id, payer_id || null, payer_name || null, a, sp.fortknox, sp.room_vault, owner_self ? 1 : 0, via || "web", t,
                  detail ? String(detail).slice(0, 200) : null, fk ? "fortknox" : null]);
  if (sp.fortknox > 0) {
    // negative = the website collected it: Pepe's funding tick credits Fort Knox ("fortknox:<flow>") or, before
    // E-1 / with the layers off, his Federal Reserve as Fort Knox's stand-in
    const base = flow || kind;
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                   [uuidv4(), fk ? "fortknox:" + base : base, payer_id || null, `${kind === "boost" ? "boost" : "stage slot fee"} ${room_id}: Fort Knox half`.slice(0, 120), -sp.fortknox]);
  }
  return { ref, kind, room_id, payer_name: payer_name || null, amount: a, ...sp, owner_self: !!owner_self, created: t, fk_to: fk ? "fortknox" : null };
}

/** E-0 telemetry (econ.js): the charge as a "room" flow - best effort, after the commit. */
function telemetry(row, login, via) {
  try {
    const ref = String(row.ref).replace(/[^A-Za-z0-9_-]/g, "_").slice(-64);
    require("./econ").ingestCharges([{ ref, ts: row.created, room: row.room_id, flow: row.kind === "boost" ? "boost" : "stage_slot", kind: "room",
      payer: login || "", payer_kind: row.owner_self ? "owner" : "other", amount: row.amount, via: via === "chat" ? "chat" : "web" }]).catch(() => {});
  } catch (e) { /* telemetry only */ }
}

// one transaction at a time on the shared connection (mainstage's chain, so stage settles and boosts never interleave)
function tx(fn) { return require("./mainstage")._tx(fn); }

/**
 * Boost a pad. user = {userId, username}; opts = {amount, ref, via: web|chat}. Idempotent per (user, ref):
 * the same ref again returns the first boost with dup = true and charges nothing.
 */
async function boost(user, roomId, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in to boost a pad.");
  const C = CONFIG;
  if (!C.pay) throw new Refuse(403, "Boosting is switched off right now.");
  const rooms = require("./rooms");
  const R = await rooms.get(roomId);
  if (!R) throw new Refuse(404, "No such pad.");
  if (R.platform !== "camfrog") throw new Refuse(400, "Only Camfrog pads can be on the front page, so only they can be boosted.");
  const amount = Math.floor(Number(opts.amount));
  if (!Number.isFinite(amount) || amount < C.min || amount > C.max) {
    throw new Refuse(400, `Boost between ${C.min.toLocaleString("en-US")} and ${C.max.toLocaleString("en-US")} PAT.`);
  }
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = "boost:" + user.userId + ":" + rawRef;
  const via = opts.via === "chat" ? "chat" : "web";
  const ownerSelf = !!(R.owner && R.owner.userId === user.userId);
  const t = now();
  const out = await tx(async () => {
    const had = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = ?", [ref]))[0];
    if (had) return { dup: true, row: had };
    const n = await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger WHERE kind = 'boost' AND payer_id = ? AND created > ?", [user.userId, t - HOUR]);
    if (n[0].n >= C.per_hour) throw new Refuse(429, "You've boosted a lot this hour - try again later.");
    const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?", [amount, user.userId, amount]);
    if (!paid.changes) throw new Refuse(402, `A ${amount.toLocaleString("en-US")} PAT boost - you don't have enough.`);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                   [uuidv4(), user.userId, `🚀 boost p/${R.slug}`.slice(0, 120), -amount]);
    const row = await routeInTx({ ref, kind: "boost", room_id: R.id, payer_id: user.userId, payer_name: u.username, amount,
                                  owner_self: ownerSelf, via, flow: "boost", detail: `boost p/${R.slug}` });
    return { dup: false, row, username: u.username };
  });
  if (!out.dup) {
    telemetry(out.row, opts.login || out.username, via);
    try { await rooms.event(R.id, "boost", out.username, `${amount} PAT (${via}); Fort Knox ${out.row.fortknox}, room vault ${out.row.room_vault}`); } catch (e) { /* audit only */ }
  }
  const r = out.row;
  return { dup: out.dup, amount: r.amount, fortknox: r.fortknox, room_vault: r.room_vault, owner_self: !!r.owner_self, room: { id: R.id, slug: R.slug, title: R.title } };
}

// ── reads ──
let mapCache = { at: 0, rows: null };
/** Boosts of the last KEEP_MS (cached 15 s): [{room_id, amount, created, payer_id}] */
async function recent(t = now()) {
  await init();
  if (mapCache.rows && Math.abs(t - mapCache.at) < 15000) return mapCache.rows;
  const rows = await getQuery("SELECT room_id, amount, created, payer_id FROM room_flow_ledger WHERE kind = 'boost' AND created > ?", [t - KEEP_MS]);
  mapCache = { at: t, rows };
  return rows;
}
function clearCache() { mapCache = { at: 0, rows: null }; }
/** room id -> active (decayed) boost PAT */
async function activeMap(t = now(), halfMin = 60) {
  const by = new Map();
  for (const r of await recent(t)) { if (!by.has(r.room_id)) by.set(r.room_id, []); by.get(r.room_id).push(r); }
  const out = new Map();
  for (const [id, rows] of by) out.set(id, activePat(rows, t, halfMin));
  return out;
}
/** A pad's boost line for its Stage card: PAT and boosters in the last hour, active PAT now. */
async function status(roomId, t = now(), halfMin = 60) {
  const rows = (await recent(t)).filter((r) => r.room_id === roomId);
  const hour = rows.filter((r) => t - r.created <= HOUR && t >= r.created);
  return {
    last_hour: hour.reduce((s, r) => s + r.amount, 0),
    boosters: new Set(hour.map((r) => r.payer_id)).size,
    active: Math.round(activePat(rows, t, halfMin)),
    pay: CONFIG.pay, min: CONFIG.min, max: CONFIG.max,
  };
}
/** What's held for each pad's room vault (escrow, not yet migrated), the Fort Knox half still in the Reserve
 *  (fortknox: booked before E-1, not moved yet) and the half booked straight into Fort Knox (fortknox_direct). */
async function escrow() {
  await init();
  const rows = await getQuery(`SELECT room_id, SUM(CASE WHEN migrated_rv IS NULL THEN room_vault ELSE 0 END) AS room_vault,
                               SUM(CASE WHEN fk_to IS NULL AND migrated_fk IS NULL THEN fortknox ELSE 0 END) AS fortknox,
                               SUM(CASE WHEN fk_to = 'fortknox' OR migrated_fk IS NOT NULL THEN fortknox ELSE 0 END) AS fortknox_done,
                               SUM(amount) AS total, COUNT(*) AS n
                               FROM room_flow_ledger GROUP BY room_id ORDER BY room_vault DESC`);
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return { rooms: rows, room_vault: sum("room_vault"), fortknox: sum("fortknox"), fortknox_done: sum("fortknox_done"), total: sum("total") };
}

// ── E-1: the one-time move of the Fort Knox halves booked into the Reserve before Fort Knox existed ──
const FK_WHERE = "fk_to IS NULL AND migrated_fk IS NULL AND fortknox > 0";
/** What Pepe's "!econ fortknox migrate" would move: {amount, rows, max_id, pending_claims}. pending_claims =
 *  boost / slot-fee claims Pepe hasn't credited to his Reserve yet (the move waits for them). */
async function fkMigrationSummary() {
  await init();
  const r = (await getQuery(`SELECT COALESCE(SUM(fortknox), 0) AS amount, COUNT(*) AS rows, COALESCE(MAX(id), 0) AS max_id
                             FROM room_flow_ledger WHERE ${FK_WHERE}`))[0];
  const p = (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE settled = 0 AND flow IN ('boost', 'stage_slot')"))[0];
  return { amount: Number(r.amount) || 0, rows: Number(r.rows) || 0, max_id: Number(r.max_id) || 0, pending_claims: Number(p.n) || 0 };
}
/** Stamp migrated_fk on exactly the rows Pepe moved (id <= max_id, still unmoved), once per batch. The rows'
 *  sum must equal `amount` (what Pepe moved) or nothing is stamped. A replayed batch returns the first result. */
async function fkMigrationMark({ batch, max_id, amount }) {
  await init();
  const b = String(batch || "");
  const maxId = Math.floor(Number(max_id));
  const amt = Math.floor(Number(amount));
  if (!/^fkm[0-9]{1,12}$/.test(b) || !(maxId > 0) || !(amt > 0)) throw new Refuse(400, "bad batch");
  return tx(async () => {
    const had = (await getQuery("SELECT * FROM fk_migrations WHERE batch = ?", [b]))[0];
    if (had) {
      if (had.amount !== amt || had.max_id !== maxId) throw new Refuse(409, "that batch was marked with different numbers");
      return { dup: true, rows: had.rows, amount: had.amount };
    }
    const r = (await getQuery(`SELECT COALESCE(SUM(fortknox), 0) AS amount, COUNT(*) AS rows FROM room_flow_ledger WHERE id <= ? AND ${FK_WHERE}`, [maxId]))[0];
    if (Number(r.amount) !== amt) throw new Refuse(409, `amount mismatch: the ledger has ${r.amount}, Pepe moved ${amt}`);
    const t = now();
    const u = await runQuery(`UPDATE room_flow_ledger SET migrated_fk = ? WHERE id <= ? AND ${FK_WHERE}`, [t, maxId]);
    await runQuery("INSERT INTO fk_migrations (batch, max_id, amount, rows, created) VALUES (?, ?, ?, ?, ?)", [b, maxId, amt, u.changes || 0, t]);
    return { dup: false, rows: u.changes || 0, amount: amt };
  });
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  const jsonOnly = (req, res, next) => (req.is("application/json") ? next() : res.status(415).json({ ok: false, error: "JSON only." }));
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[boost]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong - nothing was charged." : e.message });
  };
  const resolve = (slug) => require("./roomsweb").resolveRoom(slug);
  app.get("/api/rooms/:slug/boost", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await resolve(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      let balance = null;
      if (req.user && req.user.userId) {
        const b = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0];
        balance = b ? b.points_balance : 0;
      }
      res.json({ ok: true, boost: await status(R.id), balance, owner: !!(R.owner && req.user && R.owner.userId === req.user.userId) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/boost", addUser, jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) throw new Refuse(401, "Sign in to boost a pad.");
      const R = await resolve(req.params.slug);
      if (!R) throw new Refuse(404, "No such pad.");
      const b = req.body || {};
      const r = await boost(req.user, R.id, { amount: b.amount, ref: b.ref, via: "web" });
      clearCache();
      res.json({ ok: true, ...r, boost: await status(R.id) });
    } catch (e) { fail(res, e); }
  });
  // Pepe: "!boost <amount>" typed in a Camfrog room -> that room's pad, paid by the typer's linked PATV account
  app.post("/api/rooms/boost", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try {
      const rooms = require("./rooms");
      const R = await rooms.get(String(b.room || ""));
      if (!R) return res.json({ ok: false, message: "this room has no pad on PATV yet" });
      const login = String(b.by || "").trim().toLowerCase().slice(0, 40);
      // the account linked to that Camfrog login: a real account ahead of a leftover automatic CF one (displaynames.findByCamfrog's rule)
      const u = login ? (await getQuery(`SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = ?
                                         ORDER BY (username GLOB 'CF[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]') ASC, rowid ASC LIMIT 1`, [login]))[0] : null;
      if (!u) return res.json({ ok: false, message: "link your Camfrog name to a PATV account first (publicaccess.tv, Edit profile)" });
      const r = await boost({ userId: u.userId, username: u.username }, R.id, { amount: b.amount, ref: b.ref, via: "chat", login });
      clearCache();
      const st = await status(R.id);
      res.json({ ok: true, dup: r.dup, message: `🚀 ${R.title} boosted with ${r.amount.toLocaleString("en-US")} PAT · ${st.last_hour.toLocaleString("en-US")} PAT in the last hour`,
                 amount: r.amount, last_hour: st.last_hour });
    } catch (e) {
      if (e && e.refuse) return res.json({ ok: false, message: e.message.replace(/\.$/, "") });
      console.error("[boost] bot:", e);
      res.json({ ok: false, message: "the website couldn't do that right now - nothing was charged" });
    }
  });
  // E-1 (bot only): the one-time Fort Knox move - Pepe reads the total, moves it, then has the rows stamped
  app.post("/api/g/fortknox-migration", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, ...(await fkMigrationSummary()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/g/fortknox-migration/mark", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, ...(await fkMigrationMark(b)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/boost/admin", addUser, jsonOnly, async (req, res) => {
    try {
      if (!require("./rooms").isStaff(req.user)) throw new Refuse(403, "Admins only.");
      res.json({ ok: true, config: await setConfig(req.body || {}, req.user.username) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/boost/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!require("./rooms").isStaff(req.user)) throw new Refuse(403, "Admins only.");
      await init();
      res.json({ ok: true, config: config(), escrow: await escrow() });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, config, setConfig, split, activePat, routeInTx, telemetry, boost, recent, activeMap, status, escrow, register, clearCache, Refuse, DEFAULTS,
  fkMigrationSummary, fkMigrationMark,
  _setClock: (fn) => { clock = fn || (() => Date.now()); clearCache(); },
};
