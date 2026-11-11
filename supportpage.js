// supportpage.js — the /support page's optional extras (UI only; no money logic): an admin-set monthly goal meter, the
// all-time total raised, and a "recent supporters" list. ALL OFF by default (admin switches on /admin/crypto).
// The numbers come from every donation both rails recorded (donations.js, 1.99ans: the old "mint:donation" claims - Stripe
// "don-*", crypto "cdon-*" - plus the perks-only donation_usd_log rows; no PAT for dollars, nopat.js). Recent supporters show as "someone" unless that member opted in
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

/** The tier word for an amount (the page's preset names), so a named supporter never shows an exact amount. */
function tierOf(cents) { const d = cents / 100; return d >= 50 ? "t50" : d >= 25 ? "t25" : d >= 10 ? "t10" : "t5"; }

/** What the page shows, honouring the switches. now = ms (tests). */
async function pageData(now = Date.now()) {
  await init();
  const out = { goal: null, total: null, recent: null };
  if (!S.goal_on && !S.total_on && !S.recent_on) return out;
  const DON = require("./donations");
  await DON.init().catch(() => {});
  if (S.goal_on && S.goal_usd > 0) {
    const d = new Date(now), start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const cents = Number((await getQuery(`SELECT COALESCE(SUM(usd_cents), 0) AS c FROM ${DON.SQL} d WHERE d.at >= ?`, [start]))[0].c) || 0;
    out.goal = { usd: Math.floor(cents / 100), goal: S.goal_usd, pct: Math.min(100, Math.round((cents / (S.goal_usd * 100)) * 100)), month: start };
  }
  if (S.total_on) {
    const r = (await getQuery(`SELECT COALESCE(SUM(usd_cents), 0) AS c, COUNT(DISTINCT user_id) AS n FROM ${DON.SQL} d`))[0];
    out.total = { usd: Math.floor((Number(r.c) || 0) / 100), supporters: Number(r.n) || 0 };
  }
  if (S.recent_on) {
    const rows = await getQuery(`SELECT d.user_id, d.usd_cents, d.at, p.show_name, u.username, u.displayname FROM ${DON.SQL} d
        LEFT JOIN support_prefs p ON p.user_id = d.user_id LEFT JOIN users u ON u.userId = d.user_id
        ORDER BY d.at DESC LIMIT 8`);
    out.recent = rows.map((r) => ({
      name: r.show_name && r.username ? (r.displayname || r.username) : null,
      username: r.show_name && r.username ? r.username : null,
      tier: tierOf(Number(r.usd_cents) || 0),
      at: Number(r.at) || null,
    }));
  }
  return out;
}

/**
 * The viewer's newest card donation in the last `withinMs` (the thank-you after Stripe's redirect) -> {usd} | null.
 * 1.99ans: no PAT for dollars (nopat.js) - there's no PAT amount to show, only that it arrived (the perks are on).
 */
async function latestCard(userId, now = Date.now(), withinMs = 60 * 60 * 1000) {
  if (!userId) return null;
  const DON = require("./donations");
  await DON.init().catch(() => {});
  const r = (await getQuery(`SELECT usd_cents, at FROM ${DON.SQL} d WHERE d.user_id = ? AND d.via = 'card' AND d.at >= ? ORDER BY d.at DESC LIMIT 1`,
                            [String(userId), now - withinMs]))[0];
  return r ? { usd: (Number(r.usd_cents) || 0) / 100 } : null;
}

module.exports = { init, get, set, showName, setShowName, pageData, latestCard, tierOf, DEFAULTS };
