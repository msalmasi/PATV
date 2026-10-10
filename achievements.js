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
  // cosmetics unlocked by this achievement (idempotent; never blocks the award)
  require("./cosmetics").grantUnlocks(user.userId, { achievement: badgeId }).catch(() => {});
  if (silent) return { ok: true, awarded: true, silent: true, name: a.name, xp: 0, pat: 0 };
  let levelUp = null;
  if (a.xp && typeof updateLevel === "function") {
    try { levelUp = await updateLevel(user.userId, a.xp); } catch (e) { console.error("[achievements] xp:", e.message); }
  }
  // 1.99ga: fundPayout pays the account as it is now - if a !verify merge took this one away while the
  // award was in flight (2026-10-08: a 5,000 PAT payout logged against a deleted account, nobody paid),
  // the payout follows the merge; with no live account nothing is taken or logged
  const fr = a.pat ? await funding.fundPayout(user.userId, a.pat, "achievements", `Achievement: ${a.name}`) : false;
  const patPaid = fr === true;                // E-2: "queued" = owed by the incentive budget, paid by its queue
  const patQueued = fr === "queued";
  return { ok: true, awarded: true, id: a.id, name: a.name, emoji: a.emoji, desc: a.desc, tier: a.tier,
           xp: a.xp || 0, pat: a.pat || 0, patPaid, patQueued, levelUp, username: user.username };
}

// ── Website-awarded achievements: things only the website sees (wheel spins, tips, levels, roles).
const SPIN_WAGER = "('Wager: Gold Spin','Wager: Public Spin')";
const SPIN_WIN = "('Reward: Gold Spin','Reward: Public Spin','Jackpot Win','Jackpot Win (partial)','Jackpot Near Miss')";

let updateLevelFn = null;
function setUpdateLevel(fn) { updateLevelFn = fn; }

const feedReady = runQuery(`CREATE TABLE IF NOT EXISTS achievement_feed (
    id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, badgeId TEXT, patPaid INTEGER DEFAULT 0,
    created DATETIME DEFAULT CURRENT_TIMESTAMP, announced INTEGER DEFAULT 0)`).catch((e) => console.error("[achievements] feed:", e));

async function webMetrics(userId) {
  // a table this database doesn't have (a fresh install, a test) counts as 0 instead of failing the whole check
  const one = async (sql, p) => { const r = await getQuery(sql, p).catch(() => []); return (r[0] && Object.values(r[0])[0]) || 0; };
  // 1.99jv: 📼 Plex - linked a Plex account, on our server now, days on it in a row (plexmembers.js)
  let plex = {};
  try { plex = await require("./plexmembers").achMetrics(userId); } catch (e) { plex = {}; }
  const spent = await one(`SELECT COALESCE(SUM(-points),0) FROM transactions WHERE userId = ? AND type IN ${SPIN_WAGER}`, [userId]);
  const won = await one(`SELECT COALESCE(SUM(points),0) FROM transactions WHERE userId = ? AND type IN ${SPIN_WIN}`, [userId]);
  return {
    spins: await one("SELECT COUNT(*) FROM wheel_spins WHERE userId = ? AND result = 'SETTLED'", [userId]),
    spin_won: won,
    spin_lost: Math.max(0, spent - won),
    wheel_jackpots: await one("SELECT COUNT(*) FROM transactions WHERE userId = ? AND type IN ('Jackpot Win','Jackpot Win (partial)') AND points > 0", [userId]),
    tips_sent_pat: await one("SELECT COALESCE(SUM(-points),0) FROM transactions WHERE userId = ? AND type = 'tip sent'", [userId]),
    tips_recv_pat: await one("SELECT COALESCE(SUM(points),0) FROM transactions WHERE userId = ? AND type = 'tip received'", [userId]),
    level: await one("SELECT COALESCE(level,0) FROM users WHERE userId = ?", [userId]),
    role_high_roller: await one("SELECT COUNT(*) FROM user_roles WHERE userId = ? AND LOWER(role) = 'high roller'", [userId]),
    plex_linked: plex.plex_linked || 0,
    plex_member: plex.plex_member || 0,
    plex_days: plex.plex_days || 0,
  };
}

const checking = new Set();
// Award every website-side achievement this user now qualifies for, and queue it for Pepe to
// announce. Safe to call often; re-entrant calls (XP -> level-up -> check) are folded in.
async function checkWeb(userId) {
  if (!userId || checking.has(userId)) return;
  checking.add(userId);
  try {
    await ready; await feedReady;
    for (let pass = 0; pass < 3; pass++) {           // XP from one award can unlock a level one
      const m = await webMetrics(userId);
      let any = false;
      for (const a of catalog) {
        if (a.side !== "web" || (m[a.metric] || 0) < (a.threshold || 1)) continue;
        const r = await award({ userId }, a.id, updateLevelFn);
        if (r.ok && r.awarded) {
          any = true;
          await runQuery("INSERT INTO achievement_feed (userId, badgeId, patPaid) VALUES (?, ?, ?)",
                         [userId, a.id, r.patPaid ? 1 : 0]);
        }
      }
      if (!any) break;
    }
  } catch (e) {
    console.error("[achievements] checkWeb:", e.message);
  } finally {
    checking.delete(userId);
  }
}

async function feed() {
  await feedReady;
  const rows = await getQuery(`SELECT f.id, f.badgeId, f.patPaid, u.username, u.displayname, u.camfrogUsername
                               FROM achievement_feed f LEFT JOIN users u ON u.userId = f.userId
                               WHERE f.announced = 0 ORDER BY f.id LIMIT 20`);
  return rows.map((r) => {
    const a = byId[r.badgeId] || {};
    return { id: r.id, badgeId: r.badgeId, name: a.name, emoji: a.emoji, desc: a.desc, tier: a.tier,
             xp: a.xp || 0, pat: a.pat || 0, patPaid: !!r.patPaid,
             username: r.username, displayname: r.displayname, camfrogUsername: r.camfrogUsername };
  });
}

async function ackFeed(ids) {
  await feedReady;
  for (const id of (ids || []).slice(0, 50)) await runQuery("UPDATE achievement_feed SET announced = 1 WHERE id = ?", [Number(id)]);
}

// Once: quietly give existing players the website achievements their history already earned
// (badge only - no XP, PAT or announcement), so launch isn't a flood of payouts.
const webBackfill = (async () => {
  await ready;
  await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
  const done = await getQuery("SELECT v FROM achievement_meta WHERE k = 'web_backfill'");
  if (done.length) return;
  // (the 📼 Plex ones have their own quiet backfill, plexBackfill(), which also hands out their cosmetics)
  const web = catalog.filter((a) => a.side === "web" && !["plex_linked", "plex_member", "plex_days"].includes(a.metric));
  const users = await getQuery("SELECT userId FROM users");
  let n = 0;
  for (const u of users) {
    const m = await webMetrics(u.userId);
    for (const a of web) {
      if ((m[a.metric] || 0) >= (a.threshold || 1)) {
        const r = await runQuery("INSERT OR IGNORE INTO user_badges (userId, badgeId) VALUES (?, ?)", [u.userId, a.id]);
        n += (r && r.changes) || 0;
      }
    }
  }
  await runQuery("INSERT INTO achievement_meta (k, v) VALUES ('web_backfill', ?)", [new Date().toISOString()]);
  console.log(`[achievements] web backfill: ${n} badge(s) given quietly`);
})().catch((e) => console.error("[achievements] web backfill:", e));

// 1.99jv: once, quietly give the 📼 Plex achievements to the accounts that already qualify (linked Plex
// accounts, current members, the server owner) - badge + its cosmetic unlocks only: no XP, PAT or announcement.
// plexmembers.js runs it before its first achievement check, so nobody already linked gets a loud award.
const PLEX_METRICS = ["plex_linked", "plex_member", "plex_days"];
let plexBackfilling = null;
function plexBackfill() {
  if (!plexBackfilling) {
    plexBackfilling = (async () => {
      await ready;
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      const done = await getQuery("SELECT v FROM achievement_meta WHERE k = 'plex_backfill'");
      if (done.length) return { done: true, already: true, given: 0 };
      const plex = catalog.filter((a) => a.side === "web" && PLEX_METRICS.includes(a.metric));
      const users = await getQuery("SELECT DISTINCT user_id FROM plex_members WHERE user_id IS NOT NULL").catch(() => []);
      const given = [];
      for (const u of users) {
        const m = await require("./plexmembers").achMetrics(u.user_id);
        for (const a of plex) {
          if ((m[a.metric] || 0) < (a.threshold || 1)) continue;
          const r = await award({ userId: u.user_id }, a.id, null, { silent: true });
          if (r.ok && r.awarded) given.push({ userId: u.user_id, badgeId: a.id });
        }
      }
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES ('plex_backfill', ?)",
                     [JSON.stringify({ at: new Date().toISOString(), users: users.length, given: given.length })]);
      console.log(`[achievements] plex backfill: ${given.length} badge(s) given quietly to ${users.length} linked account(s)`);
      return { done: true, given: given.length, users: users.length, list: given };
    })().catch((e) => { plexBackfilling = null; throw e; });
  }
  return plexBackfilling;
}

function list() {
  return catalog.map((a) => ({ ...a, icon: iconFor(a) }));
}

module.exports = { award, list, ready, checkWeb, setUpdateLevel, feed, ackFeed, plexBackfill, PLEX_METRICS };
