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
// Stored in donation_promo_settings, key "donations_mode": JSON {mode, ever_on, on_since}. get() reads the database every time and is
// what every decision uses; cached() is the last value read, for the sync readers (the banner, the donate card). A missing row, an
// unreadable value or a failed read is "perks": never more than today's behaviour by accident.
//   ever_on    the switch has been "on" at least once, so PAT donations exist: the public pages stop saying "never" (wasOn()). A damaged
//              row doesn't lose it: the audit log and donation_credits say the same
//   on_since   when it last became "on": a crypto transfer mined before that was sent under the earlier state (donationpromo.seenTerms)
// Who may change it: POST /api/admin/donations/mode (donationpromo.register): a Pepe owner + the password step-up, audited. The request
// names the state the owner was looking at (from): anything else is refused as stale, never last-writer-wins.
//
// ROLLING THE SITE BACK BELOW 1.99aor while PAT quotes are open loses them (the older build ignores the quote). First set "perks" and
// wait out the open quotes (31 minutes card, 2 hours crypto). Anything settled by the older build meanwhile is listed on the admin card
// (donationpromo.modeState: rollback); refunds it ignored have to be reconciled against Stripe for that window.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const MODES = Object.freeze(["on", "perks", "off"]);
const DEFAULT_MODE = "perks";
const KEY = "donations_mode";
const AUDIT = "donation_mode";

let clock = () => Date.now();
const blank = (over = {}) => ({ mode: DEFAULT_MODE, ever_on: false, on_since: null, updated: null, actor: null, readable: true, ...over });
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
  const on_since = Number(v && v.on_since) || (mode === "on" ? Number(r.updated) || null : null);
  return { mode, ever_on: mode === "on" || !!(v && v.ever_on), on_since, updated: Number(r.updated) || null, actor: r.actor || null, readable: true };
}
/** Has the switch ever been on, by the records that outlive a damaged settings row? */
async function everOnOnRecord() {
  const looks = [["SELECT 1 AS x FROM admin_audit WHERE action = ? AND json_extract(detail, '$.after') = 'on' LIMIT 1", [AUDIT]], ["SELECT 1 AS x FROM donation_credits LIMIT 1", []]];
  for (const [sql, args] of looks) {
    try { if ((await getQuery(sql, args))[0]) return true; } catch (e) { /* that table isn't there yet */ }
  }
  return false;
}

/** The switch as stored NOW: {mode, ever_on, on_since, updated, actor, readable}. Never throws: anything wrong reads as "perks". */
async function get() {
  let st;
  try {
    const r = (await getQuery("SELECT value, updated, actor FROM donation_promo_settings WHERE key = ?", [KEY]))[0];
    st = parseRow(r);
    if (!st.readable) st.ever_on = await everOnOnRecord();
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) st = blank();
    else { warn(e && e.message); st = blank({ readable: false, ever_on: cache.ever_on }); }
  }
  cache = st;
  return st;
}
const mode = async () => (await get()).mode;
/** The last value read (sync). Before the first read: "perks". */
const cached = () => ({ ...cache });
const cachedMode = () => cache.mode;
/** Perks or paused, but donations have given PAT: a quoted donation can still be paid out, so "never" would be false. */
const wasOn = (st = cache) => st.mode !== "on" && !!st.ever_on;

const ensure = () => runQuery("CREATE TABLE IF NOT EXISTS donation_promo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, actor TEXT)");

/**
 * The owner's change (the route has already checked owner + step-up). One transaction: the row + its audit row.
 * from = the state the owner was looking at: another one now is refused (409 "stale"), so an old tab can't undo a newer change.
 */
async function set(admin, next, note = null, { from } = {}) {
  if (!MODES.includes(next)) throw Object.assign(new Error("Pick on, perks or off."), { status: 400, refuse: true });
  await ensure();
  await require("./adminaudit").init();                  // before the tx (never a memoized init inside one)
  const why = note ? String(note).replace(/\s+/g, " ").trim().slice(0, 200) : null;
  let changed = false, before = null;
  const out = await tx(async () => {
    const cur = await get();
    before = cur.mode;
    if (from !== undefined && from !== cur.mode) throw Object.assign(new Error("stale"), { status: 409, refuse: true, code: "stale" });
    if (cur.readable && cur.mode === next) return cur;
    changed = true;
    const at = clock(), who = admin.username || admin.userId;
    const ever = cur.ever_on || next === "on" || (await everOnOnRecord());
    const on_since = next === "on" ? (cur.mode === "on" && cur.on_since ? cur.on_since : at) : cur.on_since;
    await runQuery(`INSERT INTO donation_promo_settings (key, value, updated, actor) VALUES (?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor`,
                   [KEY, JSON.stringify({ mode: next, ever_on: ever, on_since }), at, who]);
    await require("./adminaudit").record({ userId: admin.userId, username: admin.username }, AUDIT, null, { before, after: next, at }, why);
    return { mode: next, ever_on: ever, on_since, updated: at, actor: who, readable: true };
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

module.exports = { MODES, DEFAULT_MODE, KEY, AUDIT, DESCRIBE, get, mode, cached, cachedMode, wasOn, set, history, ensure,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { cache = blank(); warned = false; } };
