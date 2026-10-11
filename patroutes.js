// patroutes.js — 1.99ne: a paid command's charge and its routing, recorded together.
//
// Pepe charges a paid command on the site (POST /api/wager/charge) and then routes the PAT into his pools by the PAT
// Routing table (pepe_routes._route_pat, turf_data.json). Those were two stores with nothing between them: a Pepe
// crash after the charge and before the routing - or a failed turf save - left the PAT out of the wallet and in no
// pool (an unrecorded burn).
//
// Now a charge that carries `route` ({flow, room, payer, item_sink}) and an idempotency key writes the wallet debit AND
// a route intent row (pat_route_intents, keyed by that idempotency key) in ONE database transaction - one entry group
// with a shared id. Pepe applies the routing and acks the key once his pool save holding it is on disk. Anything not
// acked is handed back to him (POST /api/pat/route-intents/pending, oldest first) and he applies it exactly once
// (his turf store remembers the keys he applied, in the same save as the pool credits). Amounts and destinations are
// Pepe's routing table, unchanged: the site only remembers WHAT has to be routed until it has been.
//
//   pat_route_intents  key (PK, = the charge's idempotency key), user_id, username, amount, flow, room, payer,
//                      item_sink, reason, txid, created (ms), routed_at (ms, NULL until Pepe acks)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const KEY_RE = /^[A-Za-z0-9_.:-]{8,120}$/;
const KEEP_MS = 30 * 86400000;            // acked intents are kept 30 days (audit trail), then pruned

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pat_route_intents (
        key TEXT PRIMARY KEY, user_id TEXT, username TEXT, amount INTEGER NOT NULL, flow TEXT NOT NULL, room TEXT,
        payer TEXT, item_sink TEXT, reason TEXT, txid TEXT, created INTEGER NOT NULL, routed_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pat_route_intents_open ON pat_route_intents (routed_at, created)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));

/** The `route` object of a charge request -> a clean {flow, room, payer, item_sink}, or null (not a routed charge). */
function cleanRoute(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const flow = str(r.flow, 64);
  if (!flow || !/^[A-Za-z0-9_:.-]+$/.test(flow)) return null;
  return { flow, room: str(r.room, 120), payer: str(r.payer, 80), item_sink: str(r.item_sink, 64) };
}

const validKey = (k) => KEY_RE.test(String(k || ""));

/** Record the intent INSIDE the caller's open transaction (right after the wallet debit). */
async function recordInTx(key, { userId, username, amount, reason, txid }, route) {
  await runQuery(`INSERT INTO pat_route_intents (key, user_id, username, amount, flow, room, payer, item_sink, reason, txid, created)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [String(key), userId || null, username || null, Math.floor(Number(amount)), route.flow, route.room, route.payer,
                  route.item_sink, reason ? String(reason).slice(0, 40) : null, txid || null, Date.now()]);
}

/**
 * The routed charge: debit the wallet (only if the balance covers it) and record the route intent, in ONE transaction
 * (mainstage's chain on the shared connection). -> ledger.post's result ({ok, transactionId} | {ok:false, code}).
 */
async function charge({ key, userId, username, amount, reason, counterparty, route }) {
  await init();
  const ledger = require("./ledger");
  return require("./mainstage")._tx(async () => {
    const d = await ledger.post(userId, -Math.floor(Number(amount)), reason, { requireCover: true, counterparty, source: "wager/charge" });
    if (d.ok) await recordInTx(key, { userId, username, amount, reason, txid: d.transactionId }, route);
    return d;
  });
}

/** Intents Pepe hasn't acked, created at least `olderMs` ago (the live path acks within seconds), oldest first. */
async function pending({ olderMs = 120000, limit = 100 } = {}) {
  await init();
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 100));
  const before = Date.now() - Math.max(0, Number(olderMs) || 0);
  return getQuery(`SELECT key, username, amount, flow, room, payer, item_sink, reason, created FROM pat_route_intents
                   WHERE routed_at IS NULL AND created <= ? ORDER BY created, rowid LIMIT ?`, [before, lim]);
}

/** Pepe applied these (and saved it): mark them routed. -> how many changed. */
async function ack(keys) {
  await init();
  let n = 0;
  const t = Date.now();
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 500)) {
    if (!validKey(k)) continue;
    const r = await runQuery("UPDATE pat_route_intents SET routed_at = ? WHERE key = ? AND routed_at IS NULL", [t, String(k)]);
    n += (r && r.changes) || 0;
  }
  if (Math.random() < 0.05) {
    runQuery("DELETE FROM pat_route_intents WHERE routed_at IS NOT NULL AND routed_at < ?", [t - KEEP_MS]).catch(() => {});
  }
  return n;
}

/** Admin / supply view: how much charged PAT is still waiting for Pepe to route it. */
async function unrouted() {
  await init();
  const r = await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t, MIN(created) AS oldest FROM pat_route_intents WHERE routed_at IS NULL");
  return { count: (r[0] && r[0].n) || 0, amount: (r[0] && r[0].t) || 0, oldest: (r[0] && r[0].oldest) || null };
}

function register(app, { isBotToken }) {
  app.post("/api/pat/route-intents/pending", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      res.json({ ok: true, intents: await pending({ olderMs: Number(b.older_s) >= 0 ? Number(b.older_s) * 1000 : 120000, limit: b.limit }) });
    } catch (e) {
      console.error("[patroutes] pending:", e.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });
  app.post("/api/pat/route-intents/ack", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      res.json({ ok: true, acked: await ack(b.keys) });
    } catch (e) {
      console.error("[patroutes] ack:", e.message);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });
}

module.exports = { init, cleanRoute, validKey, recordInTx, charge, pending, ack, unrouted, register };
