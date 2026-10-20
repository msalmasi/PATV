// supporter.js — 1.99mv: 💚 Supporter perks for people who donated to PATV (card via Stripe, or crypto: both land as a
// "mint:donation" reserve_claims row - stripebilling.js / cryptopay.js). User-approved 2026-10-11.
//
// What a donor gets (nothing to claim, nothing to buy):
//   * the automatic "Supporter" FLAIR (padflair.js) in every pad where they have no flair of the pad's own, with a tier
//     look by lifetime total - 🥉 bronze (any donation), 🥈 silver ($25+), 🥇 gold ($100+) - and a chip on their profile
//   * the 💡 Supporter achievement (cf_donor, + 🌟 Gold Supporter at $100: cf_donor_100), which unlock two cosmetics for
//     good: the "Supporter Gold" name colour and the "Supporter Halo" avatar ring (cosmetics.json unlock)
// A donation's hook calls onDonation(userId) (the cache + the achievement check); everything else reads the cache.
"use strict";
const { getQuery } = require("./dbUtils");

const TIERS = [                                          // highest first; usd = lifetime total, whole dollars
  { id: "gold", min: 100, emoji: "🥇", color: "#ffd740" },
  { id: "silver", min: 25, emoji: "🥈", color: "#cfd8dc" },
  { id: "bronze", min: 0, emoji: "🥉", color: "#d7894a" },
];
const SQL = `SELECT r.userId AS userId, u.username AS username, COUNT(*) AS n, COALESCE(SUM(json_extract(r.meta, '$.usd_cents')), 0) AS cents
             FROM reserve_claims r LEFT JOIN users u ON u.userId = r.userId
             WHERE r.flow = 'mint:donation' AND r.amount > 0 AND r.userId IS NOT NULL`;
let BY_ID = new Map(), BY_NAME = new Map(), loaded = null;

function tierOf(usd) { return TIERS.find((t) => usd >= t.min) || TIERS[TIERS.length - 1]; }
function view(row) {
  const usd = Math.floor((Number(row.cents) || 0) / 100);
  const t = tierOf(usd);
  return { userId: row.userId, username: row.username || null, donations: Number(row.n) || 0, usd, tier: t.id, emoji: t.emoji, color: t.color };
}

/** (Re)load every donor - at boot, and after a donation (one account: refresh). */
async function reload() {
  const rows = await getQuery(`${SQL} GROUP BY r.userId`).catch(() => []);
  const a = new Map(), n = new Map();
  for (const r of rows) { const v = view(r); a.set(String(v.userId), v); if (v.username) n.set(v.username.toLowerCase(), v); }
  BY_ID = a; BY_NAME = n;
  return a.size;
}
function init() { if (!loaded) loaded = reload().catch((e) => { loaded = null; console.error("[supporter] load:", e.message); return 0; }); return loaded; }
async function refresh(userId) {
  const r = (await getQuery(`${SQL} AND r.userId = ? GROUP BY r.userId`, [String(userId)]).catch(() => []))[0];
  if (!r) return null;
  const v = view(r);
  const old = BY_ID.get(String(userId));
  if (old && old.username) BY_NAME.delete(old.username.toLowerCase());
  BY_ID.set(String(userId), v);
  if (v.username) BY_NAME.set(v.username.toLowerCase(), v);
  return v;
}

/** A confirmed donation was credited (Stripe or crypto): the cache, then the achievements (which unlock the cosmetics). */
async function onDonation(userId) {
  if (!userId) return null;
  await init();
  const v = await refresh(userId).catch(() => null);
  try { require("./achievements").poke(userId); } catch (e) { /* never blocks a donation */ }
  return v;
}

/** Is this account a supporter? (sync, cached) -> {usd, tier, emoji, color, donations} | null */
function supporterSync(userId) { if (!loaded) init(); return userId ? BY_ID.get(String(userId)) || null : null; }
function supporterByName(name) { if (!loaded) init(); return name ? BY_NAME.get(String(name).toLowerCase()) || null : null; }

/** S1 Q5b: these accounts' tiers read from the database now - the chat hub's looks (userlook.buildLooks) are built when they
 *  post, so never from the boot cache. -> Map(userId -> view) for the donors among them */
async function tiersFor(userIds) {
  const ids = [...new Set([...(userIds || [])].filter(Boolean).map(String))];
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = await getQuery(`${SQL} AND r.userId IN (${part.map(() => "?").join(",")}) GROUP BY r.userId`, part).catch(() => []);
    for (const r of rows) out.set(String(r.userId), view(r));
  }
  return out;
}

/** The automatic flair for a tier (padflair.js shape; never stored, never assignable). */
const FLAIRS = {};
function flair(v) {
  if (!v) return null;
  if (!FLAIRS[v.tier]) {
    const c = require("./padflair").cleanColor(v.color) || { hex: v.color, ink: "#111" };
    FLAIRS[v.tier] = { id: 0, name: "Supporter", color: c.hex, ink: c.ink, emoji: v.emoji, self: false, auto: "supporter", tier: v.tier };
  }
  return FLAIRS[v.tier];
}

/** The /support page's perks block. */
function perks() {
  return { tiers: TIERS.slice().reverse().map((t) => ({ id: t.id, min: t.min, emoji: t.emoji, color: t.color })),
           cosmetics: ["nc_supporter", "ad_supporter"], achievements: ["cf_donor", "cf_donor_100"] };
}

module.exports = { init, reload, refresh, onDonation, supporterSync, supporterByName, flair, tierOf, perks, tiersFor, TIERS };
