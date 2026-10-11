// achievements.js — Camfrog achievements (Pepe 1.64).
//
// The catalog lives in achievements.json (badge id, name, emoji, description, the metric Pepe counts
// and its threshold, XP and PAT). On start every achievement is upserted into the badges table
// (points = XP, plus a `pat` column), so they show on profiles like any other badge.
//
// Pepe counts the activity in Camfrog and calls POST /api/g/achievement when a threshold is crossed;
// this awards the badge once, adds the XP (which can level the user up), and pays the PAT through funding.fundPayout
// "achievements" (economy v2/v3: the incentive budget's achievements group; queued when the budget is short).
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
  // 1.99lk: 📨 Telegram - linked by the bridge's /start code or Sign in with Telegram (telegram.js). Counted only once the
  // quiet backfill has run, so nobody linked before it gets a loud award from an unrelated check (a spin, a tip)
  const tgBackfilled = await telegramBackfill().then(() => true, () => false);
  // 1.99lu: 🍀 Google - linked from Edit profile or by Sign in with Google (ssolinks.js sso_links); same rule as Telegram
  const googleBackfilled = await googleBackfill().then(() => true, () => false);
  // 1.99mt: the feature achievements (gifts, Support PATV, Play from Plex, streams, clips, ...) - same rule, their own backfill
  const featBackfilled = await featureBackfill().then(() => true, () => false);
  // (skipped once the account holds every one of them - checkWeb runs on every spin)
  const featIds = catalog.filter((a) => a.side === "web" && FEATURE_METRICS.includes(a.metric)).map((a) => a.id);
  const featHeld = featIds.length ? await one(`SELECT COUNT(*) FROM user_badges WHERE userId = ? AND badgeId IN (${featIds.map(() => "?").join(",")})`, [userId, ...featIds]) : 0;
  const feat = featBackfilled && featHeld < featIds.length ? await featureMetrics(userId).catch(() => ({})) : {};
  // 1.99nj: 📼 Plex on pads (plexpad.js) - 0 until its quiet backfill has run; `_quiet` = the same counted over plays from
  // before it (an achievement those alone earn is given quietly, see checkWeb). Skipped once every one of them is held.
  const PP = require("./plexpad");
  const ppIds = catalog.filter((a) => a.side === "web" && PP.METRICS.includes(a.metric)).map((a) => a.id);
  const ppHeld = ppIds.length ? await one(`SELECT COUNT(*) FROM user_badges WHERE userId = ? AND badgeId IN (${ppIds.map(() => "?").join(",")})`, [userId, ...ppIds]) : 0;
  const pp = ppIds.length && ppHeld < ppIds.length ? await PP.metrics(userId).catch(() => ({})) : {};
  // 1.99oz: 💬 feed / follows / polls / tips / boosts / banners / 🎨 cosmetics (achsocial.js) - same rule as the feature ones
  const SO = require("./achsocial");
  const soBackfilled = await SO.backfill().then(() => true, () => false);
  const soIds = catalog.filter((a) => a.side === "web" && SO.METRICS.includes(a.metric)).map((a) => a.id);
  const soHeld = soIds.length ? await one(`SELECT COUNT(*) FROM user_badges WHERE userId = ? AND badgeId IN (${soIds.map(() => "?").join(",")})`, [userId, ...soIds]) : 0;
  const so = soBackfilled && soHeld < soIds.length ? await SO.metrics(userId).catch(() => ({})) : {};
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
    telegram_linked: tgBackfilled ? Math.min(1, await one("SELECT COUNT(*) FROM telegram_links WHERE user_id = ?", [userId])) : 0,
    google_linked: googleBackfilled ? Math.min(1, await one("SELECT COUNT(*) FROM sso_links WHERE provider = 'google' AND user_id = ?", [userId])) : 0,
    ...Object.fromEntries(FEATURE_METRICS.map((k) => [k, feat[k] || 0])),
    ...Object.fromEntries(PP.METRICS.map((k) => [k, pp[k] || 0])),
    ...Object.fromEntries(SO.METRICS.map((k) => [k, so[k] || 0])),
    _quiet: pp._quiet || {},
  };
}

// Award every website-side achievement this user now qualifies for, and queue it for Pepe to
// announce. Safe to call often. 1.99oz: one check per user at a time; a call that arrives while one runs (a poke from another
// hook, XP -> level-up -> check) makes it run ONCE more afterwards - the running one may have read the tables before the change
// that call is about (it used to be dropped, so two hooks close together could miss an award).
const checking = new Map();       // userId -> { p, rerun }
function checkWeb(userId) {
  if (!userId) return Promise.resolve();
  const cur = checking.get(userId);
  if (cur) {
    if (!cur.rerun) cur.rerun = cur.p.then(() => checkWeb(userId));
    return cur.rerun;
  }
  const entry = { p: null, rerun: null };
  checking.set(userId, entry);
  entry.p = runCheck(userId).finally(() => { if (checking.get(userId) === entry) checking.delete(userId); });
  return entry.p;
}
async function runCheck(userId) {
  try {
    await ready; await feedReady;
    for (let pass = 0; pass < 3; pass++) {           // XP from one award can unlock a level one
      const m = await webMetrics(userId);
      let any = false;
      for (const a of catalog) {
        if (a.side !== "web" || (m[a.metric] || 0) < (a.threshold || 1)) continue;
        // 1.99nj: earned by history from before its quiet backfill alone (plays whose metadata only arrived later) = quiet too
        const quiet = !!(m._quiet && (m._quiet[a.metric] || 0) >= (a.threshold || 1));
        const r = await award({ userId }, a.id, updateLevelFn, { silent: quiet });
        if (r.ok && r.awarded) {
          any = true;
          if (!quiet) await runQuery("INSERT INTO achievement_feed (userId, badgeId, patPaid) VALUES (?, ?, ?)",
                                     [userId, a.id, r.patPaid ? 1 : 0]);
        }
      }
      if (!any) break;
    }
  } catch (e) {
    console.error("[achievements] checkWeb:", e.message);
  }
}

// 1.99mj: the casino backend counts blackjack hands / naturals and hold'em pots for players Pepe can't count (no Camfrog name
// on the seat, or a web-only table): the same "bot"-side achievements (cf_bj_*, cf_holdem_*), awarded once like any other,
// with XP / PAT and an announcement in Pepe's feed. `value` is the site's running count for that user and metric (1.99mw: every
// seat, web or Camfrog, plus Pepe's count so far as a base - casino/rewards.js).
async function awardCount(userId, metric, value) {
  if (!userId || !metric) return [];
  await ready; await feedReady;
  const out = [];
  for (const a of catalog) {
    if (a.metric !== metric || a.side === "web" || (Number(value) || 0) < (a.threshold || 1)) continue;
    const r = await award({ userId }, a.id, updateLevelFn);
    if (r.ok && r.awarded) {
      await runQuery("INSERT INTO achievement_feed (userId, badgeId, patPaid) VALUES (?, ?, ?)", [userId, a.id, r.patPaid ? 1 : 0]);
      out.push(r);
    }
  }
  return out;
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
  // (the 📼 Plex, 📨 Telegram and 🍀 Google ones have their own quiet backfills, which also hand out their cosmetics)
  const PLEX_METRICS_ = ["plex_linked", "plex_member", "plex_days"];
  const web = catalog.filter((a) => a.side === "web" && ![...PLEX_METRICS_, "telegram_linked", "google_linked", ...FEATURE_METRICS,
                                                         ...require("./plexpad").METRICS, ...require("./achsocial").METRICS].includes(a.metric));
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

// 1.99lk: once, quietly give 📨 Carrier Frog (cf_telegram_linked) to the accounts that already have Telegram linked (the
// bridge's /start code or Sign in with Telegram) - badge + its cosmetic unlock only: no XP, PAT or announcement. Runs before
// any Telegram achievement check (telegram.js saveLink, webMetrics), so only links made after it are announced.
const TG_METRICS = ["telegram_linked"];
let tgBackfilling = null;
function telegramBackfill() {
  if (!tgBackfilling) {
    tgBackfilling = (async () => {
      await ready;
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      const done = await getQuery("SELECT v FROM achievement_meta WHERE k = 'telegram_backfill'");
      if (done.length) return { done: true, already: true, given: 0 };
      const tg = catalog.filter((a) => a.side === "web" && TG_METRICS.includes(a.metric));
      // no telegram_links table (a fresh install / a test) = nobody linked yet
      const users = await getQuery("SELECT DISTINCT user_id FROM telegram_links WHERE user_id IS NOT NULL").catch(() => []);
      const given = [];
      for (const u of users) {
        for (const a of tg) {
          const r = await award({ userId: u.user_id }, a.id, null, { silent: true });
          if (r.ok && r.awarded) given.push({ userId: u.user_id, badgeId: a.id });
        }
      }
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES ('telegram_backfill', ?)",
                     [JSON.stringify({ at: new Date().toISOString(), users: users.length, given: given.length })]);
      console.log(`[achievements] telegram backfill: ${given.length} badge(s) given quietly to ${users.length} linked account(s)`);
      return { done: true, given: given.length, users: users.length, list: given };
    })().catch((e) => { tgBackfilling = null; throw e; });
  }
  return tgBackfilling;
}

// 1.99lu: once, quietly give 🍀 I'm Feeling Lucky (cf_google_linked) to the accounts that already have Google linked (Edit
// profile -> Connections, or Sign in with Google) - badge + its cosmetic unlock only: no XP, PAT or announcement. Runs before
// any Google achievement check (ssolinks.js addLink, webMetrics), so only links made after it are announced.
const GOOGLE_METRICS = ["google_linked"];
let googleBackfilling = null;
function googleBackfill() {
  if (!googleBackfilling) {
    googleBackfilling = (async () => {
      await ready;
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      const done = await getQuery("SELECT v FROM achievement_meta WHERE k = 'google_backfill'");
      if (done.length) return { done: true, already: true, given: 0 };
      const gl = catalog.filter((a) => a.side === "web" && GOOGLE_METRICS.includes(a.metric));
      // no sso_links table (a fresh install / a test) = nobody linked yet
      const users = await getQuery("SELECT DISTINCT user_id FROM sso_links WHERE provider = 'google' AND user_id IS NOT NULL").catch(() => []);
      const given = [];
      for (const u of users) {
        for (const a of gl) {
          const r = await award({ userId: u.user_id }, a.id, null, { silent: true });
          if (r.ok && r.awarded) given.push({ userId: u.user_id, badgeId: a.id });
        }
      }
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES ('google_backfill', ?)",
                     [JSON.stringify({ at: new Date().toISOString(), users: users.length, given: given.length })]);
      console.log(`[achievements] google backfill: ${given.length} badge(s) given quietly to ${users.length} linked account(s)`);
      return { done: true, given: given.length, users: users.length, list: given };
    })().catch((e) => { googleBackfilling = null; throw e; });
  }
  return googleBackfilling;
}

// ── 1.99mt: achievements for the recent features (gifts, Support PATV, 📼 Play from Plex, streaming, mic clips, translations,
// sticker packs, pads). All website-side: the site sees each action complete, so the module where it happens calls
// checkWeb(userId) (gifts.js record, stripebilling / cryptopay credit + wallet link, medialib settle, mediaqueue, mediarequests,
// mainstage goLive / autoFeature, micclip post, i18nfeedback accept, stickers buy / comp, padcreate, padconnect).
// FEATURE_METRICS are counted only once their own quiet backfill has run (featureBackfill, achievement_meta
// 'feature_backfill_1'), so nobody whose history already qualifies gets a loud award from an unrelated check.
const FEATURE_METRICS = ["gift_people", "gifts_received", "donations", "donated_usd", "wallet_linked", "plex_plays", "plex_binges",
  "plex_requests", "streams", "stream_featured", "mic_clips", "pepe_clips", "translations", "sticker_packs", "pads_made", "pads_connected"];
const PEPE_SUBJECT = "Pepe";              // micclip: Pepe's own TTS mic-ups are captured with subject "Pepe" (1.99md)

/** A durable "this happened" mark for metrics whose source row changes later (a slot that stops being featured). */
const marksReady = runQuery(`CREATE TABLE IF NOT EXISTS ach_marks (userId TEXT NOT NULL, mark TEXT NOT NULL, created INTEGER NOT NULL,
                                PRIMARY KEY (userId, mark))`).catch((e) => console.error("[achievements] marks:", e));
async function mark(userId, what) {
  if (!userId || !what) return false;
  await marksReady;
  const r = await runQuery("INSERT OR IGNORE INTO ach_marks (userId, mark, created) VALUES (?, ?, ?)", [String(userId), String(what).slice(0, 40), Date.now()]).catch(() => null);
  return !!(r && r.changes);
}

/** The feature metrics for one account (0 for a table this database doesn't have). */
async function featureMetrics(userId) {
  const one = async (sql, p) => { const r = await getQuery(sql, p).catch(() => []); return Number((r[0] && Object.values(r[0])[0]) || 0) || 0; };
  let g = {};
  try { g = await require("./gifts").achMetrics(userId); } catch (e) { g = {}; }
  await marksReady;
  const DON = "FROM reserve_claims WHERE flow = 'mint:donation' AND userId = ? AND amount > 0";
  return {
    gift_people: g.gift_people || 0,
    gifts_received: g.gifts_received || 0,
    donations: await one(`SELECT COUNT(*) ${DON}`, [userId]),
    donated_usd: Math.floor(await one(`SELECT COALESCE(SUM(json_extract(meta, '$.usd_cents')), 0) ${DON}`, [userId]) / 100),
    wallet_linked: Math.min(1, await one("SELECT COUNT(*) FROM crypto_wallets WHERE user_id = ?", [userId])),
    // 📼 a library play that actually went on air (queue plays share one slot)
    plex_plays: await one(`SELECT COUNT(*) FROM media_plays p JOIN stage_slots s ON s.id = p.slot_id
                           WHERE p.user_id = ? AND s.went_live IS NOT NULL`, [userId]),
    plex_binges: await one(`SELECT COUNT(*) FROM media_queues q JOIN stage_slots s ON s.id = q.slot_id
                            WHERE q.user_id = ? AND json_array_length(q.items) >= 3 AND s.went_live IS NOT NULL`, [userId]),
    plex_requests: await one("SELECT COUNT(*) FROM media_requests WHERE user_id = ? AND status IN ('approved', 'partial', 'available')", [userId]),
    // 🎥 your own stream on a stage (RTMP / browser / WHIP), not an embed or a 📼 library play
    streams: await one(`SELECT COUNT(*) FROM stage_slots WHERE userId = ? AND went_live IS NOT NULL
                        AND COALESCE(mode, 'stream') = 'stream' AND COALESCE(source, '') != 'library'`, [userId]),
    stream_featured: Math.min(1, await one("SELECT COUNT(*) FROM ach_marks WHERE userId = ? AND mark = 'stream_featured'", [userId])),
    // 🎙 mic clips you saved (chat !clipmic or the website's 🔊 Clip both post through micclip.js)
    mic_clips: await one(`SELECT COUNT(*) FROM feed_voices v JOIN feed_posts p ON p.id = v.post_id
                          WHERE p.author_id = ? AND v.removed_at IS NULL AND p.deleted_at IS NULL`, [userId]),
    pepe_clips: await one(`SELECT COUNT(*) FROM feed_voices v JOIN feed_posts p ON p.id = v.post_id JOIN media m ON m.id = v.media_id
                           WHERE p.author_id = ? AND v.removed_at IS NULL AND p.deleted_at IS NULL AND m.subject = ?`, [userId, PEPE_SUBJECT]),
    translations: await one("SELECT COUNT(*) FROM translation_suggestions WHERE userId = ? AND status = 'accepted'", [userId]),
    sticker_packs: await one("SELECT COUNT(DISTINCT pack_id) FROM user_sticker_packs WHERE user_id = ?", [userId]),
    pads_made: await one("SELECT COUNT(*) FROM rooms_registry WHERE created_by = ? AND origin = 'user' AND COALESCE(platform, '') != 'profile'", [userId]),
    pads_connected: await one("SELECT COUNT(*) FROM pad_connections WHERE requested_by = ? AND platform = 'camfrog' AND status = 'verified'", [userId]),
  };
}

// Once: quietly give the feature achievements to everyone whose history already earned them - badge only (no XP, PAT or
// announcement), like the launch backfill. Candidates = every account that appears in one of the tables the metrics read.
let featureBackfilling = null;
function featureBackfill() {
  if (!featureBackfilling) {
    featureBackfilling = (async () => {
      await ready;
      await marksReady;
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      const done = await getQuery("SELECT v FROM achievement_meta WHERE k = 'feature_backfill_1'");
      if (done.length) return { done: true, already: true, given: 0 };
      // 🎥 featured slots that are still marked featured: auto-featured, or featured by someone other than the streamer
      await runQuery(`INSERT OR IGNORE INTO ach_marks (userId, mark, created)
                      SELECT s.userId, 'stream_featured', COALESCE(s.went_live, 0) FROM stage_slots s LEFT JOIN rooms_registry r ON r.room_id = s.room_id
                      WHERE s.featured = 1 AND s.went_live IS NOT NULL AND COALESCE(s.mode, 'stream') = 'stream' AND COALESCE(s.source, '') != 'library'
                        AND (s.feature_by = 'auto' OR (s.feature_by = 'owner' AND COALESCE(r.owner_user_id, '') != s.userId))`).catch(() => {});
      const ach = catalog.filter((a) => a.side === "web" && FEATURE_METRICS.includes(a.metric));
      const SRC = [
        "SELECT giver_id AS u FROM gift_log", "SELECT recipient_id AS u FROM gift_log",
        "SELECT userId AS u FROM reserve_claims WHERE flow = 'mint:donation'", "SELECT user_id AS u FROM crypto_wallets",
        "SELECT user_id AS u FROM media_plays", "SELECT user_id AS u FROM media_queues", "SELECT user_id AS u FROM media_requests",
        "SELECT userId AS u FROM stage_slots WHERE went_live IS NOT NULL", "SELECT userId AS u FROM ach_marks",
        "SELECT author_id AS u FROM feed_posts WHERE id IN (SELECT post_id FROM feed_voices)",
        "SELECT userId AS u FROM translation_suggestions WHERE status = 'accepted'", "SELECT user_id AS u FROM user_sticker_packs",
        "SELECT created_by AS u FROM rooms_registry WHERE origin = 'user'", "SELECT requested_by AS u FROM pad_connections WHERE status = 'verified'",
      ];
      try { await require("./gifts").logBackfill(); } catch (e) { /* no gift tables yet */ }
      const ids = new Set();
      for (const q of SRC) for (const r of await getQuery(q).catch(() => [])) if (r.u) ids.add(String(r.u));
      const known = new Set((await getQuery("SELECT userId FROM users").catch(() => [])).map((r) => r.userId));
      const given = [];
      for (const id of ids) {
        if (!known.has(id)) continue;
        const m = await featureMetrics(id);
        for (const a of ach) {
          if ((m[a.metric] || 0) < (a.threshold || 1)) continue;
          const r = await award({ userId: id }, a.id, null, { silent: true });
          if (r.ok && r.awarded) given.push({ userId: id, badgeId: a.id });
        }
      }
      const by = {};
      for (const x of given) by[x.badgeId] = (by[x.badgeId] || 0) + 1;
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES ('feature_backfill_1', ?)",
                     [JSON.stringify({ at: new Date().toISOString(), candidates: ids.size, given: given.length, by })]);
      console.log(`[achievements] feature backfill: ${given.length} badge(s) given quietly (${ids.size} candidate account(s)) ${JSON.stringify(by)}`);
      return { done: true, given: given.length, candidates: ids.size, by, list: given };
    })().catch((e) => { featureBackfilling = null; throw e; });
  }
  return featureBackfilling;
}

// run it shortly after boot (once the modules whose tables it reads have made them), not only at the first check
if (!process.env.NODE_TEST_CONTEXT) {
  const kick = setTimeout(() => featureBackfill().catch((e) => console.error("[achievements] feature backfill:", e.message)), 90e3);
  if (kick.unref) kick.unref();
}

/** Fire-and-forget checkWeb for the feature hooks (never blocks or fails the action that called it). */
function poke(...userIds) {
  for (const u of userIds) if (u) Promise.resolve().then(() => checkWeb(String(u))).catch(() => {});
}

function list() {
  return catalog.map((a) => ({ ...a, icon: iconFor(a) }));
}

module.exports = { award, awardCount, list, ready, checkWeb, setUpdateLevel, feed, ackFeed, plexBackfill, PLEX_METRICS, telegramBackfill, TG_METRICS, googleBackfill, GOOGLE_METRICS,
                   featureBackfill, featureMetrics, FEATURE_METRICS, mark, poke, webMetrics };
