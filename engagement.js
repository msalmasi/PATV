// engagement.js — POSTS COUNT AS ACTIVITY (2026-10-12, the user: incentives reward activity THROUGH pad vaults). The site
// half of Pepe's activity top-up pool and the profile-pad recipe (camfrog-bot pepe_padtopup.py). A post earns by the
// ENGAGEMENT IT GETS FROM OTHERS, never by volume:
//
//   * who counts: an upvote, a comment or a 💸 boost upvote from a DISTINCT account that is >= 7 days old, level >= 2,
//     verified or linked (email, Discord, Twitch or a Camfrog name), not archived, not flagged by the welcome dedupe
//     (dup_of), not the author, and not the author's alt (a shared browser / Camfrog / Discord / Twitch / email key in
//     welcome_keys, or a dup_of either way). Pepe's posts earn nothing.
//   * one engager on one post that day: vote_w (an upvote) + comment_w (one or more comments) + boostWeight(the PAT they
//     boosted it with that day), times their RING WEIGHT (below).
//   * a post's score = min(post_cap, sqrt(sum of its engagers)); an author's score in a pad = min(author_cap, the sum of
//     their posts' scores that day). sqrt + the caps = one viral post can't take everything.
//   * an engager's score in a pad (the profile recipe's participants) = min(engager_cap, sqrt(what they gave its posts)).
//   * LIKE-RINGS: pair reciprocity over the last ring_days (30). interactions I(v->a) = posts of a that v upvoted or
//     commented on. v and a are MUTUAL when both I(v->a) and I(a->v) are >= ring_min. reciprocity r = min/max of the two;
//     v's ring share c = the part of all v's interactions that went to mutual partners. A vote from v to a mutual partner
//     weighs max(ring_floor, 1 - r * c): a ring of accounts that only vote for each other -> ring_floor (0.1); a normal
//     member who also votes for a friend who votes back -> ~1.
//   * PLUGGABLE: setVoteWeight(fn) / setBoostWeight(fn) (the user may still price upvotes; 2026-10-12: upvotes stay free).
//   * the pad a post lives in = feed_posts.home_pad (a profile post: the profile pad user:<id>).
//
// BOOST UPVOTES (the user, 2026-10-12): an upvote that is also a small tip to the author - min boost_min (100) PAT,
// quick amounts boost_quick. It is the existing post-tip money path (posttips.tip, kind "boost": no cut, keyed), and it is
// also the booster's normal upvote. It counts EXTRA through boostWeight (diminishing, capped) - only from qualified
// accounts, never the author or their alts (the same rules as above). `boost_enabled`: ON by default (prod included, the
// user 2026-10-12); a saved engagement_cfg can still switch it off.
//
//   POST /api/g/recipe/engagement  (bot token) {day, start, end} -> {ok, day, cfg, pads: {pad id: {authors: {userId:
//        score}, engagers: {userId: score}, posts, raw}}, stats: {...}, posts: [debug rows]}
//   POST /api/feed/posts/:id/boost {amount, idempotency_key} -> {ok, vote, score, ups, downs, boosts: {n, total}, balance}
//   POST /api/g/recipe/engagement/seed  STAGING ONLY (bot token): the rehearsal's users / posts / votes / comments / boosts
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DAY_MS = 86400000;
const DEFAULTS = Object.freeze({
  min_age_days: 7, min_level: 2,
  vote_w: 1, comment_w: 2,
  post_cap: 6, author_cap: 12, engager_cap: 6,
  ring_days: 30, ring_min: 2, ring_floor: 0.1,
  boost_enabled: true,           // 2026-10-12 (the user): ON everywhere, prod included (null = staging only)
  boost_min: 100, boost_k: 1, boost_cap: 5, boost_quick: [100, 500, 1000],
});
let CFG = { ...DEFAULTS };
let clock = () => Date.now();
const ALT_KINDS = ["dev", "cf", "discord", "twitch", "email"];

/** The default vote weight: a counted upvote is vote_w, anything else 0. fn({voterId, authorId, postId, value, cfg}). */
const defaultVoteWeight = (v) => (Number(v.value) > 0 ? Number(v.cfg.vote_w) : 0);
/** The default boost weight: boost_k * sqrt(amount / boost_min), at most boost_cap; below the minimum nothing. */
const defaultBoostWeight = (amount, cfg) => {
  const a = Number(amount) || 0;
  if (a < cfg.boost_min) return 0;
  return Math.min(cfg.boost_cap, cfg.boost_k * Math.sqrt(a / cfg.boost_min));
};
let voteWeight = defaultVoteWeight;
let boostWeight = defaultBoostWeight;
function setVoteWeight(fn) { voteWeight = typeof fn === "function" ? fn : defaultVoteWeight; }
function setBoostWeight(fn) { boostWeight = typeof fn === "function" ? fn : defaultBoostWeight; }

function config() {
  const c = { ...CFG };
  if (c.boost_enabled === null || c.boost_enabled === undefined) c.boost_enabled = !!process.env.STAGING;
  return c;
}
function setConfig(o) {
  const n = { ...CFG };
  for (const [k, v] of Object.entries(o || {})) {
    if (!(k in DEFAULTS)) continue;
    if (k === "boost_enabled") n[k] = v === null ? null : !!v;
    else if (k === "boost_quick") n[k] = (Array.isArray(v) ? v : []).map((x) => Math.floor(Number(x))).filter((x) => x > 0).slice(0, 5);
    else if (Number.isFinite(Number(v))) n[k] = Number(v);
  }
  CFG = n;
  return config();
}
async function loadConfig() {
  try {
    const raw = await require("./feedstore").kvGet("engagement_cfg");
    if (raw) setConfig(JSON.parse(raw));
  } catch (e) { /* the defaults */ }
  return config();
}
async function saveConfig(o) {
  const c = setConfig(o);
  const store = {};
  for (const k of Object.keys(DEFAULTS)) store[k] = CFG[k];
  await require("./feedstore").kvSet("engagement_cfg", JSON.stringify(store));
  return c;
}

const ageDays = (created, t) => {
  const s = String(created || "");
  const ms = /^\d+$/.test(s) ? Number(s) : Date.parse(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
  return Number.isFinite(ms) ? (t - ms) / DAY_MS : 0;
};

async function chunked(ids, fn, size = 400) {
  const list = [...new Set(ids)].filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(...(await fn(list.slice(i, i + size))));
  return out;
}
const qs = (a) => a.map(() => "?").join(",");

/** {userId: {ok, why}} - the engagement gates (age, level, verified / linked, archived, dup_of). */
async function qualified(ids, t = clock(), C = config()) {
  const rows = await chunked(ids, async (part) => {
    try {
      return await getQuery(`SELECT userId, level, created_at, archived_at, isEmailVerified, discordId, twitchId, camfrogUsername FROM users
                             WHERE userId IN (${qs(part)})`, part);
    } catch (e) {
      return getQuery(`SELECT userId, level, created_at, NULL AS archived_at, isEmailVerified, discordId, twitchId, camfrogUsername FROM users
                       WHERE userId IN (${qs(part)})`, part);
    }
  });
  const dups = new Set();
  try {
    const d = await chunked(ids, (part) => getQuery(`SELECT userId FROM welcome_bonus WHERE dup_of IS NOT NULL AND dup_of != '' AND userId IN (${qs(part)})`, part));
    for (const r of d) dups.add(r.userId);
  } catch (e) { /* no welcome table */ }
  const by = new Map(rows.map((r) => [r.userId, r]));
  const out = {};
  for (const id of ids) {
    const u = by.get(id);
    if (!u) out[id] = { ok: false, why: "no account" };
    else if (u.archived_at) out[id] = { ok: false, why: "archived" };
    else if (ageDays(u.created_at, t) < C.min_age_days) out[id] = { ok: false, why: "younger than 7 days" };
    else if ((Number(u.level) || 0) < C.min_level) out[id] = { ok: false, why: "below level 2" };
    else if (!(Number(u.isEmailVerified) === 1 || u.discordId || u.twitchId || u.camfrogUsername)) out[id] = { ok: false, why: "not verified" };
    else if (dups.has(id)) out[id] = { ok: false, why: "flagged as an alt" };
    else out[id] = { ok: true };
  }
  return out;
}

/** Set of "a|b" (both orders) for accounts that share a device / identity key or are linked by dup_of. */
async function altPairs(ids) {
  const out = new Set();
  const add = (a, b) => { if (a && b && a !== b) { out.add(a + "|" + b); out.add(b + "|" + a); } };
  if (ids.length < 2) return out;
  try {
    const rows = await chunked(ids, (part) => getQuery(`SELECT a.userId AS u1, b.userId AS u2 FROM welcome_keys a JOIN welcome_keys b ON a.k = b.k AND a.userId != b.userId
                                                        WHERE a.kind IN (${qs(ALT_KINDS)}) AND a.userId IN (${qs(part)})`, [...ALT_KINDS, ...part]));
    const set = new Set(ids);
    for (const r of rows) if (set.has(r.u2)) add(r.u1, r.u2);
  } catch (e) { /* no keys table */ }
  try {
    const rows = await chunked(ids, (part) => getQuery(`SELECT userId, dup_of FROM welcome_bonus WHERE dup_of IN (${qs(part)}) OR userId IN (${qs(part)})`, [...part, ...part]));
    for (const r of rows) if (r.dup_of) add(r.userId, r.dup_of);
  } catch (e) { /* no welcome table */ }
  return out;
}

/** Pair reciprocity over the window -> weight(voter, author). Pure on the interaction counts (exported for tests). */
function ringModel(inter, C = config()) {
  // inter: Map "v|a" -> n (distinct posts of a that v upvoted / commented on)
  const outTot = new Map(), mutual = new Map();
  const get = (v, a) => inter.get(v + "|" + a) || 0;
  for (const [k, n] of inter) {
    const [v] = k.split("|");
    outTot.set(v, (outTot.get(v) || 0) + n);
  }
  for (const [k, n] of inter) {
    const [v, a] = k.split("|");
    const back = get(a, v);
    if (n >= C.ring_min && back >= C.ring_min) {
      if (!mutual.has(v)) mutual.set(v, new Map());
      mutual.get(v).set(a, Math.min(n, back) / Math.max(n, back));
    }
  }
  const share = new Map();
  for (const [v, m] of mutual) {
    let s = 0;
    for (const a of m.keys()) s += get(v, a);
    share.set(v, s / Math.max(1, outTot.get(v) || 0));
  }
  const weight = (v, a) => {
    const m = mutual.get(v);
    if (!m || !m.has(a)) return 1;
    return Math.max(C.ring_floor, 1 - m.get(a) * (share.get(v) || 0));
  };
  return { weight, mutualPairs: [...mutual.values()].reduce((s, m) => s + m.size, 0) / 2 };
}

async function interactions(ids, from, to) {
  const inter = new Map();
  if (!ids.length) return inter;
  const add = (v, a, n) => { if (v && a && v !== a) inter.set(v + "|" + a, (inter.get(v + "|" + a) || 0) + Number(n || 0)); };
  // both ends must be in the day's cast (every reciprocity this day can need)
  const rows = await chunked(ids, async (part) => {
    const set = new Set(ids);
    const v = await getQuery(`SELECT v.user_id AS v, p.author_id AS a, COUNT(*) AS n FROM feed_votes v JOIN feed_posts p ON p.id = v.post_id
                              WHERE v.value = 1 AND COALESCE(v.updated, v.created) >= ? AND COALESCE(v.updated, v.created) < ? AND v.user_id IN (${qs(part)})
                              GROUP BY v.user_id, p.author_id`, [from, to, ...part]);
    const c = await getQuery(`SELECT c.author_id AS v, p.author_id AS a, COUNT(DISTINCT c.post_id) AS n FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
                              WHERE c.deleted_at IS NULL AND c.created >= ? AND c.created < ? AND c.author_id IN (${qs(part)})
                              GROUP BY c.author_id, p.author_id`, [from, to, ...part]);
    return v.concat(c).filter((r) => set.has(r.a));
  });
  for (const r of rows) add(r.v, r.a, r.n);
  return inter;
}

const isPepeId = (id) => { try { return require("./feedstore").isPepe(id); } catch (e) { return false; } };

/**
 * The day's engagement per pad. `start` / `end` (ms) = Pepe's local day; else the UTC day.
 */
async function score({ day, start, end } = {}, t = clock()) {
  const C = config();
  const from = Number.isFinite(Number(start)) && Number(start) > 0 ? Number(start) : Date.parse(String(day) + "T00:00:00Z");
  const to = Number.isFinite(Number(end)) && Number(end) > from ? Number(end) : from + DAY_MS;
  if (!Number.isFinite(from)) return { ok: false, error: "bad day" };
  await require("./feedstore").init();
  await require("./posttips").ready();
  const live = "p.deleted_at IS NULL AND p.hidden_at IS NULL AND p.purged_at IS NULL";
  const votes = await getQuery(`SELECT v.post_id, v.user_id AS eid, v.value, p.author_id, p.home_pad FROM feed_votes v JOIN feed_posts p ON p.id = v.post_id
                                WHERE v.value = 1 AND v.w = 1 AND COALESCE(v.updated, v.created) >= ? AND COALESCE(v.updated, v.created) < ? AND ${live}`, [from, to]);
  const comms = await getQuery(`SELECT DISTINCT c.post_id, c.author_id AS eid, p.author_id, p.home_pad FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
                                WHERE c.deleted_at IS NULL AND c.created >= ? AND c.created < ? AND ${live}`, [from, to]);
  const boosts = await getQuery(`SELECT b.post_id, b.sender_id AS eid, SUM(b.amount) AS amount, p.author_id, p.home_pad FROM post_tips b JOIN feed_posts p ON p.id = b.post_id
                                 WHERE b.kind = 'boost' AND b.created >= ? AND b.created < ? AND ${live} GROUP BY b.post_id, b.sender_id`, [from, to]);
  // (post, engager) -> {pad, author, vote, comment, boost}
  const cell = new Map();
  const at = (r) => {
    const k = r.post_id + "|" + r.eid;
    if (!cell.has(k)) cell.set(k, { post: r.post_id, eid: r.eid, author: r.author_id, pad: r.home_pad || null, vote: 0, comment: false, boost: 0 });
    return cell.get(k);
  };
  for (const r of votes) at(r).vote = Number(r.value);
  for (const r of comms) at(r).comment = true;
  for (const r of boosts) at(r).boost += Number(r.amount) || 0;
  const stats = { cells: cell.size, self: 0, alt: 0, unqualified: 0, pepe: 0, no_pad: 0, counted: 0, ring_downweighted: 0, ring_lost: 0, mutual_pairs: 0,
                  why: {} };
  const cast = [...new Set([...cell.values()].flatMap((c) => [c.eid, c.author]))];
  const Q = await qualified(cast, t, C);
  const alts = await altPairs(cast);
  const ring = ringModel(await interactions(cast, to - C.ring_days * DAY_MS, to), C);
  stats.mutual_pairs = ring.mutualPairs;
  const postRaw = new Map();       // post -> {pad, author, raw, n}
  const engRaw = new Map();        // pad|engager -> raw
  for (const c of cell.values()) {
    if (c.eid === c.author) { stats.self++; continue; }
    if (isPepeId(c.author)) { stats.pepe++; continue; }
    if (!c.pad) { stats.no_pad++; continue; }
    if (alts.has(c.eid + "|" + c.author)) { stats.alt++; continue; }
    const q = Q[c.eid];
    if (!q || !q.ok) { stats.unqualified++; stats.why[q ? q.why : "no account"] = (stats.why[q ? q.why : "no account"] || 0) + 1; continue; }
    let raw = (c.vote > 0 ? Number(voteWeight({ voterId: c.eid, authorId: c.author, postId: c.post, value: c.vote, cfg: C })) || 0 : 0)
            + (c.comment ? C.comment_w : 0) + (c.boost > 0 ? Number(boostWeight(c.boost, C)) || 0 : 0);
    if (!(raw > 0)) continue;
    const w = ring.weight(c.eid, c.author);
    if (w < 1) { stats.ring_downweighted++; stats.ring_lost += raw * (1 - w); }
    raw *= w;
    stats.counted++;
    const p = postRaw.get(c.post) || { pad: c.pad, author: c.author, raw: 0, n: 0, ringw: 0 };
    p.raw += raw; p.n += 1; p.ringw += w;
    postRaw.set(c.post, p);
    const ek = c.pad + "|" + c.eid;
    engRaw.set(ek, (engRaw.get(ek) || 0) + raw);
  }
  const pads = {};
  const pad = (id) => (pads[id] = pads[id] || { authors: {}, engagers: {}, posts: 0, raw: 0 });
  const debug = [];
  for (const [post, p] of postRaw) {
    const s = Math.min(C.post_cap, Math.sqrt(p.raw));
    const P = pad(p.pad);
    P.posts += 1; P.raw += p.raw;
    P.authors[p.author] = (P.authors[p.author] || 0) + s;
    if (debug.length < 200) debug.push({ post, pad: p.pad, author: p.author, engagers: p.n, raw: Math.round(p.raw * 100) / 100, score: Math.round(s * 1000) / 1000,
                                         ring_w: Math.round((p.ringw / Math.max(1, p.n)) * 100) / 100 });
  }
  // the author must pass the same gates to earn (a young / alt-flagged account's posts pay nobody)
  for (const [id, P] of Object.entries(pads)) {
    for (const a of Object.keys(P.authors)) {
      if (!Q[a] || !Q[a].ok) { delete P.authors[a]; stats.author_unqualified = (stats.author_unqualified || 0) + 1; continue; }
      P.authors[a] = Math.round(Math.min(C.author_cap, P.authors[a]) * 1000) / 1000;
    }
    P.raw = Math.round(P.raw * 100) / 100;
    pads[id] = P;
  }
  for (const [k, raw] of engRaw) {
    const i = k.indexOf("|");
    const P = pad(k.slice(0, i));
    P.engagers[k.slice(i + 1)] = Math.round(Math.min(C.engager_cap, Math.sqrt(raw)) * 1000) / 1000;
  }
  stats.ring_lost = Math.round(stats.ring_lost * 100) / 100;
  return { ok: true, day: day || null, start: from, end: to, cfg: C, pads, stats, posts: debug };
}

// ── boost upvotes ──
class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

/** Boost totals per post: Map id -> {n, total}. */
async function boostsFor(ids) { return require("./posttips").forPosts(ids, { kind: "boost" }); }

/**
 * A boost upvote: the booster's normal upvote + a post tip of `amount` (kind "boost", no cut). The upvote first (nothing
 * moves when the vote is refused); the tip is keyed by the client's key.
 */
async function boost({ user, postId, amount, key }) {
  const C = config();
  if (!C.boost_enabled) throw new Refuse(404, "Boost upvotes aren't on.");
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const n = require("./public/js/patamount").parse(amount);
  if (!Number.isFinite(n)) throw new Refuse(400, "Use a number like 100, 500 or 1k.");
  if (n < C.boost_min) throw new Refuse(400, `A boost is at least ${C.boost_min.toLocaleString("en-US")} PAT.`);
  const store = require("./feedstore");
  const PT = require("./posttips");
  const r = await store.getRow(String(postId || ""));
  if (!r) throw new Refuse(404, "No such post.");
  if (r.author_id === user.userId) throw new Refuse(400, "You can't boost your own post.");
  await PT.ready();
  // a replayed key: the tip already went through - answer it again, never vote / tip twice
  const had = key ? (await getQuery("SELECT amount FROM post_tips WHERE ref = ?", [key]))[0] : null;
  let v;
  const cur = (await getQuery("SELECT value FROM feed_votes WHERE post_id = ? AND user_id = ?", [r.id, user.userId]))[0];
  if (!cur || Number(cur.value) !== 1) v = await store.vote(user, r.id, 1);
  if (!had) await PT.tip({ sender: user, postId: r.id, amount: n, key, kind: "boost",
                           notice: { title: `${user.username} boosted your post with PAT ${n.toLocaleString("en-US")}`, body: r.title ? `On "${String(r.title).slice(0, 60)}"` : "" } });
  const row = await store.getRow(r.id);
  let balance = null;
  try { balance = Number((await getQuery("SELECT points_balance FROM users WHERE userId = ?", [user.userId]))[0].points_balance); } catch (e) { balance = null; }
  return { ok: true, amount: n, replay: !!had, vote: 1, score: v ? v.score : row.score, ups: v ? v.ups : row.ups, downs: v ? v.downs : row.downs,
           boosts: (await boostsFor([r.id])).get(r.id) || { n: 0, total: 0 }, balance };
}

// ── STAGING ONLY: the rehearsal seed (users, pads, posts, votes, comments, boosts, watch minutes) ──
async function seed(b) {
  if (!process.env.STAGING) throw new Refuse(403, "staging only");
  const t = clock();
  const out = { users: 0, posts: 0, votes: 0, comments: 0, boosts: 0, keys: 0, pads: 0, watch: 0 };
  const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const at = Number(b.at) || t;
  const rooms = require("./rooms");
  await rooms.init();
  for (const u of (Array.isArray(b.users) ? b.users : []).slice(0, 200)) {
    const id = String(u.id || "").slice(0, 40);
    if (!/^rh[-_][A-Za-z0-9_-]{1,36}$/.test(id)) continue;          // rehearsal accounts only
    await runQuery(`INSERT INTO users (userId, username, password, points_balance, camfrogUsername, level, created_at, isEmailVerified, avatar)
                    VALUES (?, ?, 'x', 0, ?, ?, ?, ?, '/public/img/avatar.png') ON CONFLICT(userId) DO UPDATE SET level = excluded.level, created_at = excluded.created_at,
                    camfrogUsername = excluded.camfrogUsername, isEmailVerified = excluded.isEmailVerified`,
                   [id, id, u.camfrog || null, u.level != null ? Number(u.level) : 3, iso(t - (u.age_days != null ? Number(u.age_days) : 30) * DAY_MS), u.verified === false ? 0 : 1]);
    out.users++;
    if (u.profile) await rooms.ensureProfile(id).catch(() => null);
    if (u.device) {
      try {
        await runQuery("INSERT OR IGNORE INTO welcome_keys (k, userId, kind, created) VALUES (?, ?, 'dev', ?)", ["dev:rh-" + String(u.device).slice(0, 20), id, t]);
        out.keys++;
      } catch (e) { /* no table */ }
    }
  }
  for (const p of (Array.isArray(b.pads) ? b.pads : []).slice(0, 10)) {
    const id = String(p.id || "");
    if (!/^Rehearsal[A-Za-z0-9]{0,20}\.Room$/.test(id)) continue;
    await rooms.addRoom(id, p.title || id, "rehearsal");
    if (p.owner) await rooms.setOwner(id, p.owner, "rehearsal");
    out.pads++;
  }
  const store = require("./feedstore");
  await store.init();
  for (const p of (Array.isArray(b.posts) ? b.posts : []).slice(0, 200)) {
    const id = String(p.id || "");
    if (!/^rhp[A-Za-z0-9]{1,20}$/.test(id)) continue;
    await runQuery(`INSERT OR IGNORE INTO feed_posts (id, author_id, title, body, created, home_pad, global) VALUES (?, ?, ?, ?, ?, ?, 1)`,
                   [id, String(p.author), String(p.title || "rehearsal post"), "", at - 3600e3, String(p.pad)]);
    await runQuery("INSERT OR IGNORE INTO feed_post_rooms (post_id, room_id, created) VALUES (?, ?, ?)", [id, String(p.pad), at - 3600e3]);
    out.posts++;
    for (const v of (Array.isArray(p.votes) ? p.votes : []).slice(0, 200)) {
      const when = Number(v.at) || at;
      await runQuery(`INSERT INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)
                      ON CONFLICT(post_id, user_id) DO UPDATE SET value = 1, w = 1, updated = excluded.updated`, [id, String(v.user || v), when, when]);
      out.votes++;
    }
    for (const c of (Array.isArray(p.comments) ? p.comments : []).slice(0, 200)) {
      const cid = "rhc" + Math.random().toString(36).slice(2, 12);
      await runQuery("INSERT INTO feed_comments (id, post_id, author_id, body, created) VALUES (?, ?, ?, 'rehearsal comment', ?)", [cid, id, String(c.user || c), Number(c.at) || at]);
      out.comments++;
    }
    for (const x of (Array.isArray(p.boosts) ? p.boosts : []).slice(0, 50)) {
      // a boost as the post_tips row only (no PAT moves in a seed): the rehearsal's score input
      await require("./posttips").ready();
      await runQuery(`INSERT OR IGNORE INTO post_tips (post_id, sender_id, recipient_id, amount, kind, ref, created) VALUES (?, ?, ?, ?, 'boost', ?, ?)`,
                     [id, String(x.user), String(p.author), Math.floor(Number(x.amount) || 0), "rhb-" + id + "-" + x.user, Number(x.at) || at]);
      out.boosts++;
    }
    await store.recountPost(id).catch(() => null);
  }
  for (const w of (Array.isArray(b.watch) ? b.watch : []).slice(0, 100)) {
    try {
      await runQuery(`INSERT INTO econ_watch (day, stream, room_id, streamer_id, viewer_id, secs, muted_secs, beats, status) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'ok')
                      ON CONFLICT DO NOTHING`, [String(w.day), "slot:rh" + String(w.streamer).slice(-12), String(w.room), String(w.streamer), String(w.viewer), Number(w.secs) || 0]);
      out.watch++;
    } catch (e) { out.watch_error = e.message; }
  }
  if (b.cleanup) {
    for (const tbl of [["feed_votes", "post_id"], ["feed_comments", "post_id"], ["post_tips", "post_id"], ["feed_post_rooms", "post_id"], ["feed_posts", "id"]]) {
      await runQuery(`DELETE FROM ${tbl[0]} WHERE ${tbl[1]} LIKE 'rhp%'`).catch(() => null);
    }
    out.cleaned = true;
  }
  return out;
}

function register(app, { isBotToken, addUser, idemBegin }) {
  loadConfig().catch(() => null);
  app.post("/api/g/recipe/engagement", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await score({ day: b.day, start: b.start, end: b.end })); } catch (e) { console.error("[engagement]", e); res.status(500).json({ ok: false, error: "server_error" }); }
  });
  app.post("/api/g/recipe/engagement/seed", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    if (!process.env.STAGING) return res.status(403).json({ ok: false, error: "staging only" });
    try { res.json({ ok: true, seeded: await seed(b) }); } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });
  app.get("/api/feed/boost/config", (req, res) => {
    const C = config();
    res.json({ ok: true, enabled: !!C.boost_enabled, min: C.boost_min, quick: C.boost_quick });
  });
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  app.post("/api/feed/posts/:id/boost", addUser, async (req, res) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const u = req.user;
    if (!u || !u.userId || !u.username) return res.status(401).json({ ok: false, error: "Sign in first." });
    req.body = req.body || {};
    const raw = req.body.idempotency_key || req.get("Idempotency-Key");
    const key = raw ? `boost:${u.username}:${String(raw).slice(0, 64)}` : null;
    req.body.idempotency_key = key ? "postboost:" + key : undefined;
    const idem = idemBegin ? await idemBegin(req, res, "postboost") : { replay: false, done: () => {}, fail: () => {} };
    if (idem.replay) return;
    try {
      const out = await boost({ user: u, postId: String(req.params.id || "").slice(0, 32), amount: req.body.amount, key });
      idem.done(200, out);
      res.json(out);
    } catch (e) {
      idem.fail();
      const st = e && e.refuse && e.status ? e.status : 500;
      if (st === 500) console.error("[boost]", e);
      res.status(st).json({ ok: false, error: st === 500 ? "The boost didn't go through - nothing was sent." : e.message });
    }
  });
}

module.exports = { score, qualified, altPairs, ringModel, interactions, boost, boostsFor, seed, register, config, setConfig, loadConfig, saveConfig,
                   setVoteWeight, setBoostWeight, defaultVoteWeight, defaultBoostWeight, DEFAULTS, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
