// achsocial.js — 1.99pa: the site-side achievements for everyday site actions (side=web, counted here from the site's own
// tables): 💬 the feed (posts, comments, upvotes from other people), follows, polls, tips (to / from different people, 1,000+
// PAT each), boosting someone else's pad, a banner booking, and 🎨 cosmetics (equipped, full slots, a legendary, the
// collection).
//
// Same rules as the 1.99mt feature achievements (achievements.js FEATURE_METRICS):
//   * the module where the action happens calls achievements.poke(userId) (feedstore post / comment / vote, follows, the tip
//     transfer's existing checkWeb, boosts, banner approval, cosmetics equip / grant, polls save / sync);
//   * nothing counts until this group's own quiet backfill has run (achievement_meta 'social_backfill_1'): everyone whose
//     history already earns one gets the badge QUIETLY (no XP, PAT or announcement); only what happens after it is announced.
// Anti-farming: upvotes, followers and tips never count your own account or a known alt (welcome_bonus.dup_of either way);
// tips count DIFFERENT people, at least TIP_MIN PAT each; a poll counts as yours once 3+ OTHER people voted in it.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const METRICS = ["posts", "comments", "likes_recv", "following", "followers", "polls_made", "poll_votes", "tip_people", "tip_fans",
  "boost_pads", "banners", "cos_equipped", "cos_profile_full", "cos_gtf_full", "cos_legendary", "cos_owned"];
const TIP_MIN = 1000;            // a tip below this never counts (a 1-PAT tip isn't generosity)
const POLL_VOTERS = 3;           // other people who must vote before a poll you started counts
const WEB = "🌐";                // polls.js: a web vote / web-started poll is "🌐<username>"
const FLAG = "social_backfill_1";

const A = () => require("./achievements");
const one = async (sql, p) => { const r = await getQuery(sql, p).catch(() => []); return Number((r[0] && Object.values(r[0])[0]) || 0) || 0; };
const low = (s) => String(s || "").trim().toLowerCase();

/** This account and its known alts (welcome_bonus.dup_of, both ways) - never counted as "someone else". */
async function selfSet(userId) {
  const ids = new Set([String(userId)]);
  for (const r of await getQuery("SELECT userId, dup_of FROM welcome_bonus WHERE userId = ? OR dup_of = ?", [userId, userId]).catch(() => [])) {
    if (r.userId) ids.add(String(r.userId));
    if (r.dup_of) ids.add(String(r.dup_of));
  }
  return ids;
}

/** The names this account votes / starts polls under (its Camfrog login, and 🌐username on the web). */
async function pollKeys(userId) {
  const u = (await getQuery("SELECT username, camfrogUsername FROM users WHERE userId = ?", [userId]).catch(() => []))[0];
  if (!u) return [];
  return [u.camfrogUsername, u.username ? WEB + u.username : null].filter(Boolean).map(low);
}

function pollVotes(p) {
  const out = new Set();
  for (const list of Object.values((p && p.votes) || {})) for (const n of list || []) out.add(low(n));
  return out;
}

async function pollMetrics(userId) {
  const keys = await pollKeys(userId);
  if (!keys.length) return { polls_made: 0, poll_votes: 0 };
  let made = 0, voted = 0;
  for (const r of await getQuery("SELECT data FROM polls").catch(() => [])) {
    let p;
    try { p = JSON.parse(r.data); } catch (e) { continue; }
    const v = pollVotes(p);
    if (keys.some((k) => v.has(k))) voted++;
    if (keys.includes(low(p.creator)) && [...v].filter((n) => !keys.includes(n)).length >= POLL_VOTERS) made++;
  }
  return { polls_made: made, poll_votes: voted };
}

async function cosmeticMetrics(userId) {
  let C;
  try { C = require("./cosmetics"); } catch (e) { return {}; }
  const eq = await getQuery(`SELECT e.kind, c.item_id FROM user_cosmetic_equips e JOIN user_cosmetics c ON c.id = e.inv_id
                             WHERE e.user_id = ? AND c.user_id = e.user_id`, [userId]).catch(() => []);
  const kinds = new Set(eq.map((r) => r.kind));
  const cat = C.catalog ? (C.catalog() || []) : [];
  const kindsOf = (group) => Array.from(new Set(cat.map((i) => i.kind))).filter((k) => (group === "gtf") === k.startsWith("gtf_"));
  const full = (ks) => ks.length > 0 && ks.every((k) => kinds.has(k));
  return {
    cos_equipped: eq.length ? 1 : 0,
    cos_profile_full: full(kindsOf("profile")) ? 1 : 0,
    cos_gtf_full: full(kindsOf("gtf")) ? 1 : 0,
    cos_legendary: eq.some((r) => { const it = C.byId(r.item_id); return it && it.rarity === "legendary"; }) ? 1 : 0,
    cos_owned: await one("SELECT COUNT(DISTINCT item_id) FROM user_cosmetics WHERE user_id = ?", [userId]),
  };
}

/** The social metrics for one account (0 for a table this database doesn't have). */
async function metrics(userId) {
  if (String(userId) === "pepe-bot") return {};                  // Pepe's own feed account (feedstore PEPE_ID) earns nothing
  const me = await selfSet(userId);
  const mine = Array.from(me);
  const notMe = (col) => `${col} NOT IN (${mine.map(() => "?").join(",")})`;
  const tips = async (type, sign) => one(`SELECT COUNT(DISTINCT counterparty) FROM transactions WHERE userId = ? AND type = ?
                                          AND ${sign} * points >= ? AND counterparty IS NOT NULL AND ${notMe("counterparty")}`,
                                         [userId, type, TIP_MIN, ...mine]);
  return {
    posts: await one(`SELECT COUNT(*) FROM feed_posts WHERE author_id = ? AND deleted_at IS NULL AND crosspost_of IS NULL`, [userId]),
    comments: await one("SELECT COUNT(*) FROM feed_comments WHERE author_id = ? AND deleted_at IS NULL", [userId]),
    likes_recv: await one(`SELECT COUNT(*) FROM feed_votes v JOIN feed_posts p ON p.id = v.post_id
                           WHERE p.author_id = ? AND p.deleted_at IS NULL AND v.value > 0 AND ${notMe("v.user_id")}`, [userId, ...mine]),
    following: await one(`SELECT COUNT(*) FROM follows WHERE follower = ? AND target_kind = 'user' AND ${notMe("target_id")}`, [userId, ...mine]),
    followers: await one(`SELECT COUNT(*) FROM follows WHERE target_kind = 'user' AND target_id = ? AND ${notMe("follower")}`, [userId, ...mine]),
    ...(await pollMetrics(userId)),
    tip_people: await tips("tip sent", -1),
    tip_fans: await tips("tip received", 1),
    boost_pads: await one("SELECT COUNT(DISTINCT room_id) FROM room_flow_ledger WHERE kind = 'boost' AND payer_id = ? AND COALESCE(owner_self, 0) = 0", [userId]),
    banners: await one("SELECT COUNT(*) FROM banner_bookings WHERE user_id = ? AND status = 'approved'", [userId]),
    ...(await cosmeticMetrics(userId)),
  };
}

// Once: quietly give these achievements to everyone whose history already earned them - badge only (no XP, PAT or
// announcement). Candidates = every account that appears in one of the tables the metrics read.
let backfilling = null;
function backfill() {
  if (!backfilling) {
    backfilling = (async () => {
      await A().ready;
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      const done = await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [FLAG]);
      if (done.length) return { done: true, already: true, given: 0 };
      const ach = A().list().filter((a) => a.side === "web" && METRICS.includes(a.metric));
      const SRC = [
        "SELECT author_id AS u FROM feed_posts", "SELECT author_id AS u FROM feed_comments", "SELECT follower AS u FROM follows",
        "SELECT target_id AS u FROM follows WHERE target_kind = 'user'", "SELECT userId AS u FROM transactions WHERE type IN ('tip sent', 'tip received')",
        "SELECT payer_id AS u FROM room_flow_ledger WHERE kind = 'boost'", "SELECT user_id AS u FROM banner_bookings WHERE status = 'approved'",
        "SELECT user_id AS u FROM user_cosmetics", "SELECT user_id AS u FROM user_cosmetic_equips",
      ];
      const ids = new Set();
      for (const q of SRC) for (const r of await getQuery(q).catch(() => [])) if (r.u) ids.add(String(r.u));
      // polls: their creators / voters by name -> accounts
      for (const r of await getQuery("SELECT data FROM polls").catch(() => [])) {
        let p; try { p = JSON.parse(r.data); } catch (e) { continue; }
        for (const n of [p.creator, ...pollVotes(p)]) { const id = await userIdForName(n); if (id) ids.add(id); }
      }
      const known = new Set((await getQuery("SELECT userId FROM users").catch(() => [])).map((r) => r.userId));
      const given = [];
      for (const id of ids) {
        if (!known.has(id)) continue;
        const m = await metrics(id);
        for (const a of ach) {
          if ((m[a.metric] || 0) < (a.threshold || 1)) continue;
          const r = await A().award({ userId: id }, a.id, null, { silent: true });
          if (r.ok && r.awarded) given.push({ userId: id, badgeId: a.id });
        }
      }
      const by = {};
      for (const x of given) by[x.badgeId] = (by[x.badgeId] || 0) + 1;
      const users = new Set(given.map((x) => x.userId)).size;
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES (?, ?)",
                     [FLAG, JSON.stringify({ at: new Date().toISOString(), candidates: ids.size, users, given: given.length, by })]);
      console.log(`[achievements] social backfill: ${given.length} badge(s) given quietly to ${users} account(s) (${ids.size} candidate(s)) ${JSON.stringify(by)}`);
      return { done: true, given: given.length, users, candidates: ids.size, by, list: given };
    })().catch((e) => { backfilling = null; throw e; });
  }
  return backfilling;
}

async function userIdForName(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  if (n.startsWith(WEB)) {
    const r = await getQuery("SELECT userId FROM users WHERE LOWER(username) = LOWER(?)", [n.slice(WEB.length)]).catch(() => []);
    return r[0] ? String(r[0].userId) : null;
  }
  const r = await getQuery(`SELECT userId FROM users WHERE LOWER(camfrogUsername) = LOWER(?)
                            ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [n]).catch(() => []);
  return r[0] ? String(r[0].userId) : null;
}

// polls: poke each voter once per poll, and the creator once 3+ other people voted (cheap: polls are saved on every vote)
const pollSeen = new Map();          // poll id -> Set of names already poked
function pokePoll(p) {
  return Promise.resolve().then(async () => {
    if (!p || !p.id) return;
    const seen = pollSeen.get(p.id) || new Set();
    if (!pollSeen.has(p.id)) { pollSeen.set(p.id, seen); if (pollSeen.size > 200) pollSeen.delete(pollSeen.keys().next().value); }
    const v = pollVotes(p);
    const names = [...v];
    if ([...v].filter((n) => n !== low(p.creator)).length >= POLL_VOTERS) names.push(low(p.creator) + "\u0000creator");
    for (const n of names) {
      if (seen.has(n)) continue;
      seen.add(n);
      const id = await userIdForName(n.split("\u0000")[0]);
      if (id) await A().checkWeb(id);         // 1.99py: awaited here (the save never waits for this; a test can)
    }
  }).catch(() => {});
}

if (!process.env.NODE_TEST_CONTEXT) {
  const kick = setTimeout(() => backfill().catch((e) => console.error("[achievements] social backfill:", e.message)), 100e3);
  if (kick.unref) kick.unref();
}

module.exports = { METRICS, TIP_MIN, POLL_VOTERS, metrics, backfill, pokePoll, userIdForName, FLAG };
