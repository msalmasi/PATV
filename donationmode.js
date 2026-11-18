// donationmode.js — 1.99aor: THE donations switch (owner, 2026-11-18: the 1.99ans "perks only" state was temporary; bring PAT
// donations and promos back behind a switch, and let the owner pause donations from the admin panel).
//
//   on     a donation credits PAT at the configured rate, mints the incentive bonus, promos work, supporter perks too
//   perks  supporter perks only: no PAT, no bonus, no promo. THE DEFAULT, and the state at deploy (no row = perks)
//   off    donations are paused: no new card checkout, no crypto address on the page. Anything already paid or on its way is
//          still honoured and recorded
//
// The switch decides what NEW donations are offered. What a donor was shown is what they get (donationpromo.js: the terms are
// fixed when the checkout or the crypto quote is created), so moving it never changes a donation already quoted, and it never
// credits a past perks-only donation.
//
// Stored in donation_promo_settings, key "donations_mode": JSON {mode, ever_on}. get() reads the database every time and is what
// every decision uses; cached() is the last value read, for the sync readers (the banner, the donate card). A missing row, an
// unreadable value or a failed read is "perks": never more than today's behaviour by accident.
// Who may change it: POST /api/admin/donations/mode (donationpromo.register): a Pepe owner + the password step-up, audited.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const MODES = Object.freeze(["on", "perks", "off"]);
const DEFAULT_MODE = "perks";
const KEY = "donations_mode";
const AUDIT = "donation_mode";

let clock = () => Date.now();
const blank = (over = {}) => ({ mode: DEFAULT_MODE, ever_on: false, updated: null, actor: null, readable: true, ...over });
let cache = blank();
let warned = false;

const warn = (why) => {
  if (warned) return;
  warned = true;
  console.error(`[donations] the donations switch can't be read (${why}) - treated as "perks"`);
};
function parseRow(r) {
  if (!r) return blank();
  let v;
  try { v = JSON.parse(r.value); } catch (e) { warn("bad JSON"); return blank({ readable: false, updated: r.updated || null, actor: r.actor || null }); }
  const mode = typeof v === "string" ? v : v && typeof v === "object" ? v.mode : null;
  if (!MODES.includes(mode)) { warn("unknown value"); return blank({ readable: false, updated: r.updated || null, actor: r.actor || null }); }
  warned = false;
  return { mode, ever_on: mode === "on" || !!(v && v.ever_on), updated: Number(r.updated) || null, actor: r.actor || null, readable: true };
}

/** The switch as stored NOW: {mode, ever_on, updated, actor, readable}. Never throws: anything wrong reads as "perks". */
async function get() {
  let st;
  try {
    const r = (await getQuery("SELECT value, updated, actor FROM donation_promo_settings WHERE key = ?", [KEY]))[0];
    st = parseRow(r);
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) st = blank();
    else { warn(e && e.message); st = blank({ readable: false }); }
  }
  cache = st;
  return st;
}
const mode = async () => (await get()).mode;
/** The last value read (sync). Before the first read: "perks". */
const cached = () => ({ ...cache });
const cachedMode = () => cache.mode;

const ensure = () => runQuery("CREATE TABLE IF NOT EXISTS donation_promo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, actor TEXT)");

/** The owner's change (the route has already checked owner + step-up). One transaction: the row + its audit row. */
async function set(admin, next, note = null) {
  if (!MODES.includes(next)) throw Object.assign(new Error("Pick on, perks or off."), { status: 400, refuse: true });
  await ensure();
  await require("./adminaudit").init();                  // before the tx (never a memoized init inside one)
  const why = note ? String(note).replace(/\s+/g, " ").trim().slice(0, 200) : null;
  let changed = false, before = null;
  const out = await tx(async () => {
    const cur = await get();
    before = cur.mode;
    if (cur.readable && cur.mode === next) return cur;
    changed = true;
    const at = clock(), who = admin.username || admin.userId;
    const ever = cur.ever_on || next === "on";
    await runQuery(`INSERT INTO donation_promo_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                   [KEY, JSON.stringify({ mode: next, ever_on: ever }), at, who]);
    await require("./adminaudit").record({ userId: admin.userId, username: admin.username }, AUDIT, null, { before, after: next, at }, why);
    return { mode: next, ever_on: ever, updated: at, actor: who, readable: true };
  });
  cache = out;
  if (changed) console.log(`[donations] switch: ${before} -> ${next} by ${admin.username || admin.userId}`);
  return { ...out, changed, before };
}

const history = async (n = 20) => { try { return await require("./adminaudit").recent(AUDIT, n); } catch (e) { return []; } };

/** What the admin card says about each state. */
const DESCRIBE = Object.freeze({
  on: { label: "On", text: "Donations credit PAT at the configured rate and mint the incentive bonus, promotions work, and donors get the Supporter perks." },
  perks: { label: "Perks only", text: "Donations are accepted and give the Supporter perks. No PAT, no incentive bonus, no promotions." },
  off: { label: "Paused", text: "No new card checkouts and no crypto address on the page; the support pages say donations are paused. Anything already paid or on its way is still honoured and recorded." },
});

module.exports = { MODES, DEFAULT_MODE, KEY, AUDIT, DESCRIBE, get, mode, cached, cachedMode, set, history, ensure,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { cache = blank(); warned = false; } };
