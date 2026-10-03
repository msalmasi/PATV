// achievements.js — Camfrog achievements (Pepe 1.64).
//
// The catalog lives in achievements.json (badge id, name, emoji, description, the metric Pepe counts
// and its threshold, XP and PAT). On start every achievement is upserted into the badges table
// (points = XP, plus a `pat` column), so they show on profiles like any other badge.
//
// Pepe counts the activity in Camfrog and calls POST /api/g/achievement when a threshold is crossed;
// this awards the badge once, adds the XP (which can level the user up), and pays the PAT out of the
// vault the "achievements" payout row names (the Federal Reserve) - skipped if it can't cover it.
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");
const funding = require("./funding");

const CATALOG_FILE = path.join(__dirname, "achievements.json");
let catalog = [];
try {
  catalog = (JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8")).achievements || []);
} catch (e) {
  console.error("[achievements] catalog:", e.message);
}
const byId = Object.fromEntries(catalog.map((a) => [a.id, a]));
const iconFor = (a) => `/public/img/badges/ach/${a.id}.png`;

const ready = (async () => {
  try { await runQuery("ALTER TABLE badges ADD COLUMN pat INTEGER DEFAULT 0"); } catch (e) { /* exists */ }
  for (const a of catalog) {
    await runQuery(
      `INSERT INTO badges (badgeId, name, description, icon, points, requirement, pat) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(badgeId) DO UPDATE SET name = excluded.name, description = excluded.description,
         icon = excluded.icon, points = excluded.points, requirement = excluded.requirement, pat = excluded.pat`,
      [a.id, a.name, a.desc, iconFor(a), a.xp || 0, `Camfrog: ${a.metric} ≥ ${a.threshold}`, a.pat || 0]);
  }
  // One-off backfill: accounts that linked Camfrog before achievements existed get "Frog Bridge"
  // quietly - the badge only, no XP or PAT (it would land as a wave of Reserve payouts and level-ups).
  if (byId.cf_linked) {
    await runQuery(
      `INSERT OR IGNORE INTO user_badges (userId, badgeId)
       SELECT userId, 'cf_linked' FROM users
       WHERE camfrogUsername IS NOT NULL AND camfrogUsername != '' AND username NOT LIKE 'CF%'`);
  }
  console.log(`[achievements] ${catalog.length} achievements seeded`);
})().catch((e) => console.error("[achievements] seed:", e));

async function findUser({ userId, camfrogUsername, username }) {
  if (userId) {
    const r = await getQuery("SELECT userId, username FROM users WHERE userId = ?", [userId]);
    if (r.length) return r[0];
  }
  const name = camfrogUsername || username;
  if (!name) return null;
  const r = await getQuery(
    `SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?) OR LOWER(username) = LOWER(?)
     ORDER BY CASE WHEN LOWER(camfrogUsername) = LOWER(?) THEN 0 ELSE 1 END,
              CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [name, name, name]);
  return r.length ? r[0] : null;
}

// Award one achievement. `silent` (backfill) gives the badge without XP or PAT.
async function award(who, badgeId, updateLevel, { silent = false } = {}) {
  await ready;
  const a = byId[badgeId];
  if (!a) return { ok: false, error: "unknown achievement" };
  const user = await findUser(who);
  if (!user) return { ok: false, error: "no such user" };
  const ins = await runQuery("INSERT OR IGNORE INTO user_badges (userId, badgeId) VALUES (?, ?)", [user.userId, badgeId]);
  if (!ins || !ins.changes) return { ok: true, awarded: false, already: true };
  if (silent) return { ok: true, awarded: true, silent: true, name: a.name, xp: 0, pat: 0 };
  let levelUp = null;
  if (a.xp && typeof updateLevel === "function") {
    try { levelUp = await updateLevel(user.userId, a.xp); } catch (e) { console.error("[achievements] xp:", e.message); }
  }
  const patPaid = a.pat ? await funding.fundPayout(user.userId, a.pat, "achievements", `Achievement: ${a.name}`) : false;
  return { ok: true, awarded: true, id: a.id, name: a.name, emoji: a.emoji, desc: a.desc, tier: a.tier,
           xp: a.xp || 0, pat: a.pat || 0, patPaid, levelUp, username: user.username };
}

function list() {
  return catalog.map((a) => ({ ...a, icon: iconFor(a) }));
}

module.exports = { award, list, ready };
