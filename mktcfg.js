// mktcfg.js — 1.99ur: the admins' settings for prediction markets that every creator path shares.
//
//   close bounds   how soon / how far out a creator may set a market's close (a custom date on the web form, `closes 3d` or
//                  `closes 2026-11-03 18:00 ET` in chat). Default 1 hour .. 90 days; an admin can move them within 5 min .. 365 d.
//                  Enforced by capital/markets.js (site-owned markets), by Pepe for his own markets (he reads them from
//                  POST /api/markets/cfg every few minutes and falls back to the defaults) and checked on the web form first.
//
//   GET  /api/admin/markets-cfg   (admins)                      -> {ok, cfg, defaults, limits}
//   POST /api/admin/markets-cfg   (admins, same-site fetch JSON) {close_min_secs, close_max_secs} -> {ok, cfg}
//   POST /api/markets/cfg         (Pepe, bot token)               -> {ok, close_min_secs, close_max_secs}
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DEFAULTS = { close_min_secs: 3600, close_max_secs: 90 * 86400 };
const LIMITS = { min: 300, max: 365 * 86400 };

let ready = null;
function init() {
  if (!ready) ready = runQuery("CREATE TABLE IF NOT EXISTS markets_cfg (key TEXT PRIMARY KEY, value TEXT)").catch((e) => { ready = null; throw e; });
  return ready;
}

let cache = null, cacheAt = 0;
function clean(c) {
  const out = { ...DEFAULTS };
  const n = (v) => Math.floor(Number(v));
  if (c && Number.isFinite(n(c.close_min_secs))) out.close_min_secs = Math.max(LIMITS.min, Math.min(LIMITS.max, n(c.close_min_secs)));
  if (c && Number.isFinite(n(c.close_max_secs))) out.close_max_secs = Math.max(LIMITS.min, Math.min(LIMITS.max, n(c.close_max_secs)));
  if (out.close_max_secs < out.close_min_secs) out.close_max_secs = out.close_min_secs;
  return out;
}

/** The current settings {close_min_secs, close_max_secs} (cached 30 s). */
async function get() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  await init();
  const row = (await getQuery("SELECT value FROM markets_cfg WHERE key = 'cfg'"))[0];
  let raw = null;
  try { raw = row ? JSON.parse(row.value) : null; } catch (e) { raw = null; }
  cache = clean(raw);
  cacheAt = Date.now();
  return cache;
}

async function set(patch) {
  await init();
  const cur = await get();
  const next = clean({ ...cur, ...(patch || {}) });
  await runQuery("INSERT INTO markets_cfg (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  cache = next;
  cacheAt = Date.now();
  return next;
}

/** "1 hour" / "90 days" for messages. */
function human(secs) {
  secs = Math.max(0, Math.floor(Number(secs) || 0));
  if (secs % 86400 === 0 && secs >= 86400) return `${secs / 86400} day${secs === 86400 ? "" : "s"}`;
  if (secs % 3600 === 0 && secs >= 3600) return `${secs / 3600} hour${secs === 3600 ? "" : "s"}`;
  return `${Math.max(1, Math.round(secs / 60))} minute${secs === 60 ? "" : "s"}`;
}

/** null when `secs` (from now to the close) is inside the bounds, else the message to show. */
async function checkClose(secs) {
  const c = await get();
  if (!(secs >= c.close_min_secs) || secs > c.close_max_secs) {
    return `Trading can close between ${human(c.close_min_secs)} and ${human(c.close_max_secs)} from now.`;
  }
  return null;
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/markets/cfg", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, ...(await get()) }); } catch (e) { res.status(500).json({ ok: false, error: "server_error" }); }
  });
  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false }); return false; }
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || row.class !== "Admin") { res.status(403).json({ ok: false, error: "Admins only." }); return false; }
    return true;
  };
  app.get("/api/admin/markets-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    res.json({ ok: true, cfg: await get(), defaults: DEFAULTS, limits: LIMITS });
  });
  app.post("/api/admin/markets-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const b = req.body || {};
    const cfg = await set({ close_min_secs: b.close_min_secs, close_max_secs: b.close_max_secs });
    console.log(`[mktcfg] ${req.user.username || req.user.userId}: close ${cfg.close_min_secs}s .. ${cfg.close_max_secs}s`);
    res.json({ ok: true, cfg });
  });
}

module.exports = { register, get, set, checkClose, human, DEFAULTS, LIMITS, _reset: () => { cache = null; } };
