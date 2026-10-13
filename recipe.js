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
//     pad_days / owner_pad_days  (1.99uu) the connection-neutral equivalents of active_days / the owner's presence, for
//                  a pad WITHOUT a connected Camfrog room (Pepe uses them there; a connected pad keeps the chat measures).
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

/** The participant gates for a batch of Camfrog logins -> {login: {ok, userId, why}}. */
async function peopleGates(logins, t = clock()) {
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
    else if (ageDays(u.created_at, t) < GATES.min_age_days) out[l] = { ok: false, why: "account younger than 7 days" };
    else if ((Number(u.level) || 0) < GATES.min_level) out[l] = { ok: false, why: "below level 2" };
    else if (dups.has(u.userId)) out[l] = { ok: false, why: "flagged as an alt" };
    else out[l] = { ok: true, userId: u.userId };
  }
  return out;
}

/** Verified watch-minutes per streamer on one room's stage for one day. */
async function streamerVwm(roomId, day, t = clock()) {
  let rows = [];
  try {
    rows = await getQuery(`SELECT w.streamer_id, w.viewer_id, w.secs, w.muted_secs, u.level, u.created_at, u.isEmailVerified, u.discordId, u.twitchId
                           FROM econ_watch w JOIN users u ON u.userId = w.viewer_id
                           WHERE w.day = ? AND w.room_id = ? AND w.status = 'ok' AND w.streamer_id IS NOT NULL AND w.stream LIKE 'slot:%'`,
                          [day, roomId]);
  } catch (e) { return []; }
  const per = new Map();
  for (const r of rows) {
    if (ageDays(r.created_at, t) < GATES.min_age_days || (Number(r.level) || 0) < GATES.min_level) continue;
    if (!(Number(r.isEmailVerified) === 1 || r.discordId || r.twitchId)) continue;
    const min = Math.min(GATES.vwm_cap, Math.max(0, (Number(r.secs) || 0) - (Number(r.muted_secs) || 0)) / 60);
    if (min <= 0) continue;
    const s = per.get(r.streamer_id) || { userId: r.streamer_id, vwm: 0, viewers: 0 };
    s.vwm += min; s.viewers += 1;
    per.set(r.streamer_id, s);
  }
  if (!per.size) return [];
  const live = await getQuery(`SELECT userId FROM users WHERE userId IN (${[...per.keys()].map(() => "?").join(",")})`, [...per.keys()]);
  const exists = new Set(live.map((r) => r.userId));
  return [...per.values()].filter((s) => exists.has(s.userId)).map((s) => ({ ...s, vwm: Math.round(s.vwm * 10) / 10 }));
}

async function activeDays(roomId, day) {
  const end = Date.parse(day + "T00:00:00Z") + DAY_MS;
  const rows = await require("./rooms").activity(roomId, end - 7 * DAY_MS, end).catch(() => []);
  return rows.filter((d) => (Number(d.minutes) || 0) >= GATES.active_minutes && (Number(d.peak) || 0) >= GATES.active_peak).length;
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
  let padN = 0;
  for (const set of days.values()) if ([...set].filter((u) => q[u] && q[u].ok).length >= GATES.active_peak) padN += 1;
  return { pad_days: padN, owner_pad_days: owner.size };
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
    // 1.99uu: + the pad's own activity (a pad without a connected Camfrog room is measured on the pad; Pepe picks)
    const pd = R && rooms.platformOf(id) !== "camfrog" ? await padDays(R, day) : { pad_days: 0, owner_pad_days: 0 };
    out.push({ room: id, active_days: await activeDays(id, day), owner, streamers: await streamerVwm(id, day),
               people: await peopleGates(x.logins), ...pd });
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

module.exports = { init, inputs, credit, earned, peopleGates, streamerVwm, activeDays, padDays, MOD_EVENTS, register, GATES, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
