// supportpage.js — the /support page's optional extras (UI only; no money logic): an admin-set monthly goal meter, the
// all-time total raised, and a "recent supporters" list. ALL OFF by default (admin switches on /admin/crypto).
// The numbers come from the donation mint claims both rails already write (reserve_claims flow "mint:donation",
// meta.usd_cents: Stripe "don-*", crypto "cdon-*"). Recent supporters show as "someone" unless that member opted in
// (support_prefs.show_name, their own checkbox on /support). Amounts are never shown next to a name - only a tier word.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DEFAULTS = Object.freeze({ goal_on: false, goal_usd: 0, total_on: false, recent_on: false });
const S = { ...DEFAULTS };
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS support_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, actor TEXT)");
      await runQuery("CREATE TABLE IF NOT EXISTS support_prefs (user_id TEXT PRIMARY KEY, show_name INTEGER NOT NULL DEFAULT 0, updated INTEGER)");
      for (const r of await getQuery("SELECT key, value FROM support_settings")) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) continue;
        try { S[r.key] = JSON.parse(r.value); } catch (e) { /* keep default */ }
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const get = () => ({ ...S });
const clean = {
  goal_on: (v) => !!v, total_on: (v) => !!v, recent_on: (v) => !!v,
  goal_usd: (v) => { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1e7) throw Object.assign(new Error("The goal is a whole number of dollars (0 to 10,000,000)."), { refuse: true }); return n; },
};
/** Admin: patch the switches. {_bools:[names]} lists the checkboxes on the form (unchecked = absent). -> {changed} */
async function set(patch, actor) {
  await init();
  const p = { ...(patch || {}) };
  for (const b of Array.isArray(p._bools) ? p._bools : []) if (b in clean && !(b in p)) p[b] = false;
  const changed = [];
  for (const [k, v] of Object.entries(p)) {
    if (!(k in clean)) continue;
    const nv = clean[k](v);
    if (JSON.stringify(nv) === JSON.stringify(S[k])) continue;
    S[k] = nv; changed.push(k);
    await runQuery("INSERT INTO support_settings (key, value, updated, actor) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor",
      [k, JSON.stringify(nv), Date.now(), String(actor || "")]);
  }
  if (changed.length) console.log(`[support] settings changed by ${actor}: ${changed.join(", ")}`);
  return { changed, settings: get() };
}
async function showName(userId) {
  await init();
  const r = (await getQuery("SELECT show_name FROM support_prefs WHERE user_id = ?", [String(userId)]))[0];
  return !!(r && r.show_name);
}
async function setShowName(userId, on) {
  await init();
  await runQuery("INSERT INTO support_prefs (user_id, show_name, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET show_name = excluded.show_name, updated = excluded.updated",
    [String(userId), on ? 1 : 0, Date.now()]);
  return { show_name: !!on };
}

const centsOf = (meta) => { try { return Math.max(0, Math.floor(Number(JSON.parse(meta || "{}").usd_cents) || 0)); } catch (e) { return 0; } };
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
/** The tier word for an amount (the page's preset names), so a named supporter never shows an exact amount. */
function tierOf(cents) { const d = cents / 100; return d >= 50 ? "t50" : d >= 25 ? "t25" : d >= 10 ? "t10" : "t5"; }

/** What the page shows, honouring the switches. now = ms (tests). */
async function pageData(now = Date.now()) {
  await init();
  const out = { goal: null, total: null, recent: null };
  if (!S.goal_on && !S.total_on && !S.recent_on) return out;
  await require("./funding").init().catch(() => {});
  if (S.goal_on && S.goal_usd > 0) {
    const d = new Date(now), start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const rows = await getQuery("SELECT meta FROM reserve_claims WHERE flow = 'mint:donation' AND created >= ?", [sqlTime(start)]);
    const cents = rows.reduce((a, r) => a + centsOf(r.meta), 0);
    out.goal = { usd: Math.floor(cents / 100), goal: S.goal_usd, pct: Math.min(100, Math.round((cents / (S.goal_usd * 100)) * 100)), month: start };
  }
  if (S.total_on) {
    const rows = await getQuery("SELECT userId, meta FROM reserve_claims WHERE flow = 'mint:donation'");
    out.total = { usd: Math.floor(rows.reduce((a, r) => a + centsOf(r.meta), 0) / 100), supporters: new Set(rows.map((r) => r.userId)).size };
  }
  if (S.recent_on) {
    const rows = await getQuery(`SELECT c.userId, c.meta, c.created, p.show_name, u.username, u.displayname FROM reserve_claims c
        LEFT JOIN support_prefs p ON p.user_id = c.userId LEFT JOIN users u ON u.userId = c.userId
        WHERE c.flow = 'mint:donation' ORDER BY c.created DESC LIMIT 8`);
    out.recent = rows.map((r) => ({
      name: r.show_name && r.username ? (r.displayname || r.username) : null,
      username: r.show_name && r.username ? r.username : null,
      tier: tierOf(centsOf(r.meta)),
      at: Date.parse(String(r.created).replace(" ", "T") + "Z") || null,
    }));
  }
  return out;
}

/** The viewer's newest card donation credited in the last `withinMs` (the thank-you after Stripe's redirect). */
async function latestCard(userId, now = Date.now(), withinMs = 60 * 60 * 1000) {
  if (!userId) return null;
  await require("./funding").init().catch(() => {});
  const r = (await getQuery(`SELECT amount, meta, created FROM reserve_claims WHERE flow = 'mint:donation' AND userId = ? AND claimId LIKE 'don-%'
      AND created >= ? ORDER BY created DESC LIMIT 1`, [String(userId), sqlTime(now - withinMs)]))[0];
  return r ? { pat: Number(r.amount) || 0, usd: centsOf(r.meta) / 100 } : null;
}

module.exports = { init, get, set, showName, setShowName, pageData, latestCard, tierOf, DEFAULTS };
