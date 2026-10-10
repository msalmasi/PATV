// supplyhistory.js — a daily record of the PAT supply (1.99jw, Economy v3: "moderately inflationary" made measurable).
//
// supply_snapshot keeps only Pepe's latest pools. Every POST /api/stats/supply now also upserts TODAY's (UTC) row here:
//   supply_history  day (YYYY-MM-DD, UTC, PRIMARY KEY), ts (ms, the last update), total, circulating,
//                   layers (JSON {layerKey: amount}), fed (the Federal Reserve, vault:reserve), band (JSON - Pepe's Fed
//                   band {fed, floor, ceiling, action}), mints (JSON {source: amount} - Pepe's mint journal for that day),
//                   burns (PAT burned that UTC day, burns.js), mtd_inflation_pct (total vs the first row of the UTC month, %)
// Pepe's supply body carries `monetary`: {band, mints: {"YYYY-MM-DD": {source: amount}} (last 7 days), mtd: {source:
// {minted, cap}} (cap -1 = unlimited), month: "YYYY-MM"}. Today's mints come from mints[today]; the previous 7 days'
// rows that exist get their mints patched from the same map (a mint journaled after midnight is still counted).
//   GET /api/admin/econ/supply-history?days=90   (Admin) the rows + the last pushed monetary block (band, mtd)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const SOURCES = ["issuance", "floor", "admin", "loan", "restore", "donation", "seed", "cutover"];
const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const state = { monetary: null, at: 0 };          // the last `monetary` Pepe pushed with the supply
let now = () => Date.now();

let readyP = null;
function init() {
  if (!readyP) {
    readyP = runQuery(`CREATE TABLE IF NOT EXISTS supply_history (
        day TEXT PRIMARY KEY, ts INTEGER, total INTEGER, circulating INTEGER, layers TEXT, fed INTEGER, band TEXT, mints TEXT,
        burns INTEGER, mtd_inflation_pct REAL)`).catch((e) => { readyP = null; throw e; });
  }
  return readyP;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const int = (v) => { const n = Number(v); return v !== null && v !== "" && typeof v !== "boolean" && Number.isFinite(n) ? Math.floor(n) : null; };
const key = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9_:-]/g, "").slice(0, 32);

/** {source: amount} -> clean (amounts >= 0, at most 20 sources) */
function cleanMap(o) {
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o).slice(0, 20)) {
    const n = int(v);
    const kk = key(k);
    if (kk && n !== null) out[kk] = Math.max(0, n);
  }
  return out;
}

/** Pepe's supply `monetary` block -> clean, or null when absent / not an object. */
function cleanMonetary(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const b = x.band && typeof x.band === "object" ? x.band : null;
  const mints = {};
  if (x.mints && typeof x.mints === "object" && !Array.isArray(x.mints)) {
    for (const [d, m] of Object.entries(x.mints).slice(0, 40)) if (DAY_RE.test(d)) mints[d] = cleanMap(m);
  }
  const mtd = {};
  if (x.mtd && typeof x.mtd === "object" && !Array.isArray(x.mtd)) {
    for (const [k, v] of Object.entries(x.mtd).slice(0, 20)) {
      const kk = key(k);
      if (!kk || !v || typeof v !== "object") continue;
      const cap = int(v.cap);
      mtd[kk] = { minted: Math.max(0, int(v.minted) || 0), cap: cap === null || cap < 0 ? -1 : cap };
    }
  }
  return {
    band: b ? { fed: int(b.fed), floor: int(b.floor), ceiling: int(b.ceiling), action: b.action == null ? null : String(b.action).slice(0, 40) } : null,
    mints, mtd, month: typeof x.month === "string" && /^\d{4}-\d{2}$/.test(x.month) ? x.month : null,
  };
}

/**
 * Upsert today's row from a patSupply() result (after the snapshot was saved) and Pepe's monetary block (may be null:
 * then today's band / mints are kept as they were). -> the row written.
 */
async function record(supply, monetary) {
  await init();
  const t = now();
  const day = dayOf(t);
  const M = monetary === undefined ? null : monetary;
  if (M) { state.monetary = M; state.at = t; }
  const total = Math.floor(Number(supply && supply.total) || 0);
  const circulating = Math.floor(Number(supply && supply.circulating) || 0);
  const layers = {};
  for (const l of (supply && supply.layers) || []) layers[l.key] = Math.floor(Number(l.amount) || 0);
  const fedRow = ((supply && supply.rows) || []).find((r) => r.key === "vault:reserve");
  const fed = fedRow ? Math.floor(Number(fedRow.amount) || 0) : null;
  const start = Date.parse(day + "T00:00:00Z");
  let burns = 0;
  try { burns = await require("./burns").burnedBetween(start, start + DAY_MS); } catch (e) { burns = 0; }
  const first = (await getQuery("SELECT total FROM supply_history WHERE day >= ? AND day < ? ORDER BY day LIMIT 1", [day.slice(0, 7) + "-01", day]))[0];
  const base = first ? Number(first.total) || 0 : 0;
  const mtd = base > 0 ? Math.round(((total - base) / base) * 100 * 10000) / 10000 : 0;
  const band = M && M.band ? JSON.stringify(M.band) : null;
  const mints = M ? JSON.stringify(M.mints[day] || {}) : null;
  await runQuery(`INSERT INTO supply_history (day, ts, total, circulating, layers, fed, band, mints, burns, mtd_inflation_pct)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(day) DO UPDATE SET ts = excluded.ts, total = excluded.total, circulating = excluded.circulating,
                    layers = excluded.layers, fed = COALESCE(excluded.fed, supply_history.fed), band = COALESCE(excluded.band, supply_history.band),
                    mints = COALESCE(excluded.mints, supply_history.mints), burns = excluded.burns, mtd_inflation_pct = excluded.mtd_inflation_pct`,
                 [day, t, total, circulating, JSON.stringify(layers), fed, band, mints, burns, mtd]);
  // a mint Pepe journaled for one of the previous 7 days (late, or after this site's last push that day)
  if (M) {
    for (const [d, m] of Object.entries(M.mints)) {
      if (d === day || d > day || Date.parse(d + "T00:00:00Z") < start - 7 * DAY_MS) continue;
      await runQuery("UPDATE supply_history SET mints = ? WHERE day = ?", [JSON.stringify(m), d]);
    }
  }
  return { day, total, circulating, fed, burns, mtd_inflation_pct: mtd };
}

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };

/** The last `days` days of rows, oldest first. */
async function history(days = 90) {
  await init();
  const n = Math.max(1, Math.min(730, Math.floor(Number(days)) || 90));
  const since = dayOf(now() - (n - 1) * DAY_MS);
  const rows = await getQuery("SELECT * FROM supply_history WHERE day >= ? ORDER BY day", [since]);
  return rows.map((r) => ({ day: r.day, ts: r.ts, total: r.total, circulating: r.circulating, layers: parse(r.layers) || {}, fed: r.fed,
                            band: parse(r.band), mints: parse(r.mints) || {}, burns: r.burns || 0, mtd_inflation_pct: r.mtd_inflation_pct || 0 }));
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[supplyhistory] init:", e.message));
  app.get("/api/admin/econ/supply-history", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      const me = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!me || me.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
      res.json({ ok: true, rows: await history(req.query.days), monetary: state.monetary, pushedAt: state.at || null, sources: SOURCES });
    } catch (e) {
      console.error("[supplyhistory]", e.message);
      res.status(500).json({ ok: false, error: "failed" });
    }
  });
}

module.exports = { init, record, history, register, cleanMonetary, state, SOURCES, _setClock: (fn) => { now = fn || (() => Date.now()); } };
