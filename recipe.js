// recipe.js — economy v2 E-4: the site half of Pepe's room-vault payout RECIPE (camfrog-bot pepe_recipe.py,
// docs/ECONOMY-V2.md 7.2 / 6.4 / 10, ECONOMY-V3 23.3). The epoch itself runs in Pepe (the room vaults are his pools);
// the site answers what only it knows, and credits the people Pepe pays:
//
//   POST /api/g/recipe/inputs  (bot token) {day, rooms: [{room, owner_login, logins: [...]}]}
//     -> {ok, rooms: [{room, active_days, owner: {userId} | null, streamers: [{userId, vwm, viewers}], people: {login:
//         {ok, userId, why}}}]}
//     active_days  days in the 7 ending `day` with >= 60 min bridged live and a peak of >= 3 people (doc 6.4)
//     streamers    VERIFIED watch-minutes on the room's stage that day (econ.js heartbeats: one session per account,
//                  consecutive beats with the server nonce, visible + playing + advancing; status 'ok' only - the
//                  streamer, their known alts and flagged viewers are already out), minus muted minutes, at most 120
//                  per viewer per streamer; only viewers whose account is >= 7 days old, level >= 2 and verified
//                  (email, Discord or Twitch). Pepe's own stream has no streamer to pay.
//     pad_days / owner_pad_days  (1.99uu) the connection-neutral equivalents of active_days / the owner's presence
//                  (+ pad_dates / owner_pad_dates, active_dates and active_any_days = |active_dates U pad_dates|, 1.99vm).
//                  A pad without a connected Camfrog room is measured on these alone; a CONNECTED pad (1.99vm, the user)
//                  qualifies on either place: a day counts when the room OR the pad was active, and an owner day when the
//                  owner was in the room OR active on the pad.
//                  Days in the 7 ending `day` (UTC):
//                    pad_days        >= 3 distinct QUALIFIED accounts (engagement.qualified: >= 7 days old, level >= 2,
//                                    verified / linked, not archived, not an alt) posted, commented or upvoted on the pad's
//                                    feed (posts whose home is the pad) or watched / streamed on its stage (econ_watch 'ok')
//                    owner_pad_days  the owner posted or commented there, streamed on its stage to a verified viewer, or
//                                    moderated it (room_events: feed removals / restores / bans, automod reversals, mod
//                                    actions sent to Pepe)
//     people       the anti-farming gates for the participant slice (V3 23.3): the Camfrog login is linked to a PATV
//                  account >= 7 days old, level >= 2, not archived and not flagged by the welcome dedupe (dup_of)
//   POST /api/g/recipe/credit  (bot token) {ref, userId, amount, room, slice, day} -> one credit, keyed by ref (a retry
//     answers {ok, dup}); an account that's gone -> 404 {code: "no_account"} (Pepe returns the PAT to the vault)
//
//   recipe_credits   ref PK, room_id, day, slice, userId, amount, created   (the idempotency record + the owner panel's
//                    "what you earned")
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DAY_MS = 86400000;
const GATES = Object.freeze({ min_age_days: 7, min_level: 2, vwm_cap: 120, active_minutes: 60, active_peak: 3 });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const REF_RE = /^[A-Za-z0-9:_.-]{6,120}$/;
const SLICES = new Set(["owner", "streamers", "people", "gang"]);
const LOGIN_RE = /^[A-Za-z0-9._-]{1,40}$/;
let clock = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery(`CREATE TABLE IF NOT EXISTS recipe_credits (ref TEXT PRIMARY KEY, room_id TEXT NOT NULL, day TEXT, slice TEXT,
                      userId TEXT NOT NULL, amount INTEGER NOT NULL, created INTEGER NOT NULL)`)
      .then(() => runQuery("CREATE INDEX IF NOT EXISTS recipe_credits_room ON recipe_credits (room_id, slice, created)"))
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const ageDays = (created, t) => {
  const ms = Date.parse(String(created || "").replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(created || "")) ? "" : "Z"));
  return Number.isFinite(ms) ? (t - ms) / DAY_MS : 0;
};

async function dupSet(ids) {
  if (!ids.length) return new Set();
  try {
    const rows = await getQuery(`SELECT userId FROM welcome_bonus WHERE dup_of IS NOT NULL AND dup_of != '' AND userId IN (${ids.map(() => "?").join(",")})`, ids);
    return new Set(rows.map((r) => r.userId));
  } catch (e) { return new Set(); }
}

/** The participant gates for a batch of Camfrog logins -> {login: {ok, userId, why}}. `o` (1.99wu): {min_age_days, min_level}
 *  for the other anti-alt gates that share these rules (E-7 convoy hits: 14 days / level 3; E-8 challenge prizes: 7 / 2). */
async function peopleGates(logins, t = clock(), o = {}) {
  const has = (v) => v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v));
  const minAge = has(o.min_age_days) ? Math.max(0, Math.min(365, Number(o.min_age_days))) : GATES.min_age_days;
  const minLevel = has(o.min_level) ? Math.max(0, Math.min(100, Math.floor(Number(o.min_level)))) : GATES.min_level;
  const clean = [...new Set((logins || []).map((l) => String(l || "").toLowerCase()).filter((l) => LOGIN_RE.test(l)))].slice(0, 400);
  const out = {};
  if (!clean.length) return out;
  const rows = await getQuery(`SELECT userId, LOWER(camfrogUsername) AS cf, level, created_at, archived_at FROM users
                               WHERE LOWER(camfrogUsername) IN (${clean.map(() => "?").join(",")})`, clean).catch(async () =>
    getQuery(`SELECT userId, LOWER(camfrogUsername) AS cf, level, created_at, NULL AS archived_at FROM users
              WHERE LOWER(camfrogUsername) IN (${clean.map(() => "?").join(",")})`, clean));
  const byLogin = new Map(rows.map((r) => [r.cf, r]));
  const dups = await dupSet(rows.map((r) => r.userId));
  for (const l of clean) {
    const u = byLogin.get(l);
    if (!u) out[l] = { ok: false, why: "no linked PATV account" };
    else if (u.archived_at) out[l] = { ok: false, why: "archived account" };
    else if (ageDays(u.created_at, t) < minAge) out[l] = { ok: false, userId: u.userId, why: `account younger than ${minAge} days` };
    else if ((Number(u.level) || 0) < minLevel) out[l] = { ok: false, userId: u.userId, why: `below level ${minLevel}` };
    else if (dups.has(u.userId)) out[l] = { ok: false, userId: u.userId, why: "flagged as an alt" };
    else out[l] = { ok: true, userId: u.userId };
  }
  return out;
}

/** Verified watch-minutes per streamer on one room's stage for one day. E-5: the daily rollup (vwm.js, table stage_watch):
 *  status 'ok' minutes minus muted ones from gated viewers, at most 120 per viewer per STREAMER per day across every pad. */
async function streamerVwm(roomId, day) {
  try { return await require("./vwm").forRoom(roomId, day); } catch (e) { console.error("[recipe] vwm:", e.message); return []; }
}

async function activeDays(roomId, day) {
  return (await activeDates(roomId, day)).length;
}
/** 1.99vm: the bridged active days themselves (UTC dates), so Pepe can join them with the pad's own days. */
async function activeDates(roomId, day) {
  const end = Date.parse(day + "T00:00:00Z") + DAY_MS;
  const rows = await require("./rooms").activity(roomId, end - 7 * DAY_MS, end).catch(() => []);
  return rows.filter((d) => (Number(d.minutes) || 0) >= GATES.active_minutes && (Number(d.peak) || 0) >= GATES.active_peak).map((d) => d.day);
}

// 1.99uu: what counts as "moderating the pad" for owner_pad_days (rooms.event names)
const MOD_EVENTS = Object.freeze(["feed-remove", "feed-restore", "feed-comment-remove", "feed-ban", "feed-automod-reverse",
                                  "feed-tag-remove", "pepe-room"]);
const safeQ = async (sql, args) => { try { return await getQuery(sql, args); } catch (e) { return []; } };
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** 1.99uu: a pad's activity measured on the pad itself, for the 7 days ending `day` -> {pad_days, owner_pad_days}. */
async function padDays(R, day, t = clock()) {
  const id = String((R && R.id) || "");
  const end = Date.parse(day + "T00:00:00Z") + DAY_MS, start = end - 7 * DAY_MS;
  const days = new Map();                                     // day -> Set(userId)
  const cell = (d) => { if (!days.has(d)) days.set(d, new Set()); return days.get(d); };
  const ownerId = R && R.owner_kind === "user" && R.owner ? String(R.owner.userId || "") : "";
  const ownerName = R && R.owner ? String(R.owner.username || "").toLowerCase() : "";
  const owner = new Set();
  const feed = [
    ...(await safeQ(`SELECT author_id AS uid, created FROM feed_posts WHERE home_pad = ? AND created >= ? AND created < ? AND deleted_at IS NULL`, [id, start, end])),
    ...(await safeQ(`SELECT c.author_id AS uid, c.created FROM feed_comments c JOIN feed_posts p ON p.id = c.post_id
                     WHERE p.home_pad = ? AND c.created >= ? AND c.created < ? AND c.deleted_at IS NULL`, [id, start, end])),
  ];
  for (const r of feed) {
    const d = utcDay(Number(r.created));
    cell(d).add(String(r.uid));
    if (ownerId && String(r.uid) === ownerId) owner.add(d);
  }
  for (const r of await safeQ(`SELECT v.user_id AS uid, v.created FROM feed_votes v JOIN feed_posts p ON p.id = v.post_id
                               WHERE p.home_pad = ? AND v.value > 0 AND v.created >= ? AND v.created < ?`, [id, start, end])) {
    cell(utcDay(Number(r.created))).add(String(r.uid));
  }
  for (const r of await safeQ(`SELECT day, viewer_id, streamer_id FROM econ_watch WHERE room_id = ? AND day >= ? AND day < ? AND status = 'ok'
                               AND secs - COALESCE(muted_secs, 0) >= 60`, [id, utcDay(start), utcDay(end)])) {
    cell(r.day).add(String(r.viewer_id));
    if (r.streamer_id) cell(r.day).add(String(r.streamer_id));
    if (ownerId && String(r.streamer_id || "") === ownerId) owner.add(r.day);
  }
  if (ownerName) {
    for (const r of await safeQ(`SELECT ts FROM room_events WHERE room_id = ? AND ts >= ? AND ts < ? AND LOWER(actor) = ?
                                 AND what IN (${MOD_EVENTS.map(() => "?").join(",")})`, [id, start, end, ownerName, ...MOD_EVENTS])) {
      owner.add(utcDay(Number(r.ts)));
    }
  }
  const all = [...new Set([...days.values()].flatMap((x) => [...x]))];
  const q = all.length ? await require("./engagement").qualified(all, t).catch(() => ({})) : {};
  const padDates = [];
  for (const [d, set] of days) if ([...set].filter((u) => q[u] && q[u].ok).length >= GATES.active_peak) padDates.push(d);
  return { pad_days: padDates.length, owner_pad_days: owner.size, pad_dates: padDates.sort(), owner_pad_dates: [...owner].sort() };
}

async function inputs(body) {
  await init();
  const b = body || {};
  const day = String(b.day || "");
  if (!DAY_RE.test(day)) return { ok: false, error: "bad day" };
  const rooms = require("./rooms");
  await rooms.init();
  const out = [];
  for (const x of (Array.isArray(b.rooms) ? b.rooms : []).slice(0, 300)) {
    const id = String((x && x.room) || "").slice(0, 120);
    if (!id) continue;
    const R = await rooms.get(id).catch(() => null);
    const owner = R && R.owner_kind === "user" && R.owner && R.owner.userId ? { userId: R.owner.userId } : null;
    // 1.99uu: + the pad's own activity. 1.99vm (the user): for EVERY pad - a connected pad's owner share counts the pad's
    // days alongside its chat room's (either qualifies; Pepe joins the dates: active_any_days, and the owner's Camfrog
    // presence days with owner_pad_dates)
    const pd = R ? await padDays(R, day) : { pad_days: 0, owner_pad_days: 0, pad_dates: [], owner_pad_dates: [] };
    const ad = await activeDates(id, day);
    out.push({ room: id, active_days: ad.length, active_dates: ad, active_any_days: new Set([...ad, ...pd.pad_dates]).size,
               owner, streamers: await streamerVwm(id, day), people: await peopleGates(x.logins), ...pd });
  }
  return { ok: true, day, rooms: out };
}

class Refuse extends Error { constructor(code, status, msg) { super(msg || code); this.code = code; this.status = status; } }

async function credit(body) {
  await init();
  const b = body || {};
  const ref = String(b.ref || ""), userId = String(b.userId || ""), amount = Math.floor(Number(b.amount) || 0);
  const slice = SLICES.has(b.slice) ? b.slice : null;
  const room = String(b.room || "").slice(0, 120);
  if (!REF_RE.test(ref) || !userId || !slice || !room || amount <= 0 || amount > 50000000) throw new Refuse("bad", 400, "bad request");
  const ledger = require("./ledger");
  return require("./boosts").tx(async () => {
    const had = (await getQuery("SELECT amount FROM recipe_credits WHERE ref = ?", [ref]))[0];
    if (had) return { ok: true, dup: true, amount: Number(had.amount) };
    const uid = await ledger.resolveUserId(userId);
    if (!uid) throw new Refuse("no_account", 404, "no such account");
    await runQuery("INSERT INTO recipe_credits (ref, room_id, day, slice, userId, amount, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [ref, room, DAY_RE.test(String(b.day || "")) ? b.day : null, slice, uid, amount, clock()]);
    const R = require("./rooms").getCached(room);
    const label = { owner: "owner share", streamers: "streamer share", people: "regulars' share", gang: "gang share" }[slice];
    await ledger.postOrThrow(uid, amount, `💸 room payout (${label}) p/${R ? R.slug : room}`.slice(0, 120), { source: "recipe" });
    return { ok: true, amount };
  });
}

/** What the owner panel shows: this user's recipe credits from one room (7 / 30 days, all time). */
async function earned(roomId, userId, slice = "owner") {
  await init();
  const t = clock();
  const r = (await getQuery(`SELECT COALESCE(SUM(amount),0) AS all_time, COALESCE(SUM(CASE WHEN created >= ? THEN amount END),0) AS d7,
                                    COALESCE(SUM(CASE WHEN created >= ? THEN amount END),0) AS d30, MAX(created) AS last
                             FROM recipe_credits WHERE room_id = ? AND userId = ? AND slice = ?`,
                            [t - 7 * DAY_MS, t - 30 * DAY_MS, String(roomId), String(userId), slice]))[0] || {};
  return { all_time: Number(r.all_time) || 0, d7: Number(r.d7) || 0, d30: Number(r.d30) || 0, last: r.last || null };
}

function register(app, { isBotToken }) {
  const fail = (res, e) => {
    if (e && e.code && e.status && e.status < 500) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
    console.error("[recipe]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/g/recipe/inputs", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await inputs(b)); } catch (e) { fail(res, e); }
  });
  // 1.99wu: the shared anti-alt gates for one or more Camfrog logins with the caller's thresholds (E-7 convoy hits, E-8 prizes)
  app.post("/api/g/recipe/gates", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      await init();
      res.json({ ok: true, gates: await peopleGates(Array.isArray(b.logins) ? b.logins : [b.login], clock(),
                                                       { min_age_days: b.min_age_days, min_level: b.min_level }) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/g/recipe/credit", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await credit(b)); } catch (e) { fail(res, e); }
  });
  app.post("/api/g/royalties/cutover", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await require("./royalties").cutover({ key: b.key, dry: b.dry !== false })); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, inputs, credit, earned, peopleGates, streamerVwm, activeDays, activeDates, padDays, MOD_EVENTS, register, GATES, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
