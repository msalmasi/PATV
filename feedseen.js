// feedseen.js - 1.99ex: "seen" state for the feed's "N new" badges, per ACCOUNT (not per browser).
//
// Read posts in one browser and they're no longer new in another. Signed-in members' seen state lives here;
// signed-out visitors keep the old localStorage value (public/js/pad-tabs.js). When someone signs in, the page
// merges their local value by taking the max (the client POSTs it; the server only ever moves `upto` forward).
//
//   feed_seen   user_id, scope, upto (ms: everything posted up to here is seen), updated (ms)  PK (user_id, scope)
//
// Scopes (SCOPE_RE): "pad:<room id>" (a pad's Feed tab), "all" (/feed All), "following" (/feed Following),
// "profile:<username>" (a profile's posts). Only the pad Feed tab shows a badge today; the others are stored
// for the same rule so a badge there reads the same table.
//
//   GET  /api/feed/seen?scopes=a,b      -> {ok, seen: {scope: upto}}       (signed in)
//   POST /api/feed/seen {scope, upto}   -> {ok, upto}  (same-site, JSON, X-Requested-With: fetch; signed in)
// The remembered last TAB stays per browser (a decision, not an oversight) - only read/seen state is here.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const SCOPE_RE = /^(?:all|following|pad:[A-Za-z0-9][A-Za-z0-9._:~\-]{0,127}|profile:[A-Za-z0-9_.\-]{1,40})$/;
const MAX_SCOPES = 20;
let NOW = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_seen (
        user_id TEXT NOT NULL, scope TEXT NOT NULL, upto INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, scope))`);
    })().catch((e) => { console.error("[feedseen] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

const cleanScope = (s) => { const v = String(s == null ? "" : s).trim(); return SCOPE_RE.test(v) ? v : null; };
const padScope = (roomId) => cleanScope("pad:" + String(roomId || ""));

/** {scope: upto} for one member (scopes without a row are left out). */
async function get(userId, scopes) {
  const S = [...new Set((scopes || []).map(cleanScope).filter(Boolean))].slice(0, MAX_SCOPES);
  if (!userId || !S.length) return {};
  await init();
  const rows = await getQuery(`SELECT scope, upto FROM feed_seen WHERE user_id = ? AND scope IN (${S.map(() => "?").join(",")})`, [String(userId), ...S]);
  const out = {};
  for (const r of rows) out[r.scope] = Number(r.upto) || 0;
  return out;
}
/** One scope's upto, or null. */
async function one(userId, scope) {
  const s = cleanScope(scope);
  if (!userId || !s) return null;
  const m = await get(userId, [s]);
  return Object.prototype.hasOwnProperty.call(m, s) ? m[s] : null;
}
/** Move a member's `upto` forward (never back; never past now). -> the stored upto, or null for a bad scope / time. */
async function mark(userId, scope, upto) {
  const s = cleanScope(scope);
  const t = Math.floor(Number(upto));
  if (!userId || !s || !Number.isFinite(t) || t <= 0) return null;
  await init();
  const at = Math.min(t, NOW() + 60e3);          // a little clock skew is fine; the future isn't
  await runQuery(`INSERT INTO feed_seen (user_id, scope, upto, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id, scope) DO UPDATE SET upto = MAX(feed_seen.upto, excluded.upto), updated = excluded.updated`,
                 [String(userId), s, at, NOW()]);
  return (await getQuery("SELECT upto FROM feed_seen WHERE user_id = ? AND scope = ?", [String(userId), s]))[0].upto;
}

function register(app, { addUser }) {
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  app.get("/api/feed/seen", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, seen: await get(req.user.userId, String(req.query.scopes || "").split(",")) }); } catch (e) {
      console.error("[feedseen] get:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  app.post("/api/feed/seen", addUser, async (req, res) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const b = req.body || {};
      const upto = await mark(req.user.userId, b.scope, b.upto);
      if (upto === null) return res.status(400).json({ ok: false, error: "Bad scope." });
      res.json({ ok: true, upto });
    } catch (e) {
      console.error("[feedseen] mark:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, get, one, mark, register, cleanScope, padScope, SCOPE_RE, _setClock: (fn) => { NOW = fn; } };
