// stories.js — Pepe's room captures as IG-style stories (1.99bz).
//
// A room's "story" is its Camfrog captures from the last 24 h: Pepe's !snap photos, !clip videos and
// audio-only clips (media.js, the same rows the room feed's "Fresh captures" strip shows). The /feed
// page and the homepage show a strip of circles, one per room with fresh captures (unseen first, then
// the most recent); a room feed shows that room's captures as thumbnails. Tapping either opens the
// story viewer (public/js/stories.js).
//
//   story_seen   user_id, room_id, upto (ms: the newest capture the user has seen in that room),
//                updated. A ring is "unseen" while the room has a capture newer than upto. Signed-out
//                browsers keep the same map in localStorage (the viewer itself is signed-in only).
//
// Rules (same as the captures always had):
//   * captures are for signed-in members: visitors get the circles (room name + count, no pictures)
//     and a sign-in prompt instead of the viewer; GET /api/stories is 401 for them
//   * a capture whose subject Pepe flagged private (media.anon: !incognito / !bridge hide), or whose
//     linked PATV account hides its Analytics or Rooms panel (the room-analytics rule, roomstats.js),
//     is shown as "someone" - the same for the "taken by" name
//   * Pepe's cam captures carry no NSFW flag (they're his own room captures, not uploads); feed posts'
//     NSFW rules don't apply here. 1.99cr: STAGE captures (stagecap.js, source "stage") of a slot its
//     streamer marked NSFW are nsfw: blurred behind a tap in the viewer, never a story cover
//   * rows whose file is gone are skipped (they used to render as broken images)
//
// 1.99ez (userstories.js): members' own stories (media source "user": a picture / short video they uploaded to a pad
// or their profile) sit in the same strips, credited to the uploader; a PERSON story (id user:<userId>, the profile
// pad's id) is a member's profile uploads + the captures of them (unless they turned that off, went private or hid
// one). The homepage / /feed strip gets a person circle for each member with a profile upload (and the viewer's own);
// the Following tab's strip leads with the people the viewer follows (forViewer {people}).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");
const media = require("./media");

const WINDOW_MS = 24 * 3600 * 1000;
const MAX_ITEMS = 600;
const ROOM_RE = /^[A-Za-z0-9][A-Za-z0-9._:~\-]{0,127}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await media.ready;
      await runQuery(`CREATE TABLE IF NOT EXISTS story_seen (
        user_id TEXT NOT NULL, room_id TEXT NOT NULL, upto INTEGER NOT NULL, updated INTEGER, PRIMARY KEY (user_id, room_id))`);
    })().catch((e) => { console.error("[stories] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

let MCOLS = null;
async function mediaCols() {
  if (!MCOLS) MCOLS = new Set((await getQuery("PRAGMA table_info(media)")).map((c) => c.name));
  return MCOLS;
}

/** Camfrog logins (lower-case) whose linked PATV account keeps its room activity private. */
async function privateLogins(logins) {
  const list = [...new Set(logins.map((l) => String(l || "").toLowerCase()))].filter((l) => LOGIN_RE.test(l));
  const out = new Set();
  if (!list.length) return out;
  let users = [];
  try {
    users = await getQuery(`SELECT userId, camfrogUsername FROM users WHERE lower(camfrogUsername) IN (${list.map(() => "?").join(",")})`, list);
  } catch (e) { users = []; }
  const pl = require("./profilelayout");
  for (const u of users) {
    let hidden;
    try {
      const L = await pl.get(u.userId);
      hidden = pl.stateOf(L, "analytics") === "hidden" || pl.stateOf(L, "an_rooms") === "hidden";
    } catch (e) { hidden = true; }      // can't read their choice: fail closed
    if (hidden) out.add(String(u.camfrogUsername).toLowerCase());
  }
  return out;
}

/**
 * Capture rows -> the public shape, privacy applied, missing files dropped.
 * -> [{id, kind, src, page, subject, by, room, created, expires, secs}]
 */
async function clean(rows) {
  const live = rows.filter((r) => media.fileExists(r));
  // 1.99ez: a member's own upload (source "user") is credited to their PATV display name - not a Camfrog login
  const priv = await privateLogins(live.flatMap((r) => (r.source === "user" ? [] : [r.subject, r.by_user])));
  const name = (s, anon) => {
    const n = String(s || "").trim();
    if (!n || anon || priv.has(n.toLowerCase())) return null;
    return n.slice(0, 60);
  };
  return live.map((r) => ({
    id: r.id, kind: r.kind === "clip" || r.kind === "audio" ? r.kind : "photo", src: "/media/" + encodeURIComponent(r.id) + "/raw",
    page: "/media/" + encodeURIComponent(r.id), subject: r.source === "user" ? null : name(r.subject, r.anon),
    by: r.source === "user" ? String(r.by_user || "").trim().slice(0, 60) || null : name(r.by_user, false),
    room: r.room || "", created: Number(r.created) || 0, expires: Number(r.expires) || 0, secs: Number(r.secs) || 0,
    // 1.99cr: stage captures (stagecap.js) read "📺 Stage snap/clip of <stream> by <user>"; NSFW comes from the slot
    // 1.99ez: "user" = a member's own story upload (userstories.js); NSFW = their tick or the safety check
    source: r.source === "stage" ? "stage" : r.source === "user" ? "user" : "cam", nsfw: !!Number(r.nsfw || 0),
    // 1.99dq: a clip's poster frame / an audio capture's waveform card (media.js) - null until it's made
    poster: media.hasPoster(r) ? "/media/" + encodeURIComponent(r.id) + "/poster" : null,
  }));
}

/** Live captures (newest first), optionally one room. Used by the room feed strip and /feed. */
async function captures(roomId, limit = 12, { windowMs = null, noProfiles = false } = {}) {
  try {
    await init();
    const C = await mediaCols();
    const t = NOW();
    const where = ["deleted = 0", "expires > ?"], args = [t];
    if (windowMs) { where.push("created > ?"); args.push(t - windowMs); }
    if (roomId) { where.push("room = ?"); args.push(roomId); }
    const opt = (c, d) => (C.has(c) ? c : `${d} AS ${c}`);
    if (noProfiles) where.push("room NOT LIKE 'user:%'");
    const rows = await getQuery(`SELECT id, kind, file, subject, by_user, room, created, expires, secs, ${opt("anon", "0")}, ${opt("source", "NULL")}, ${opt("nsfw", "0")}
                                 FROM media WHERE ${where.join(" AND ")} ORDER BY created DESC LIMIT ?`, [...args, Math.min(MAX_ITEMS, limit)]);
    return await clean(rows);
  } catch (e) {
    console.error("[stories] captures:", e.message);
    return [];
  }
}

function roomInfo(roomId) {
  const R = rooms.getCached(roomId);
  if (R && rooms.isProfile(roomId)) {             // 1.99ez: not reached by forViewer (person stories), kept safe anyway
    const href = require("./pads").padHref(R);
    return { id: roomId, title: R.title, href, feed: href };
  }
  let slug = R ? R.slug : null;
  if (R) { try { slug = require("./roomsweb").linkSlug(R); } catch (e) { /* registry slug */ } }
  return {
    id: roomId, title: R ? R.title : roomId,
    href: "/p/" + encodeURIComponent(R ? slug : roomId),
    feed: "/p/" + encodeURIComponent(R ? slug : roomId) + "#feed",
  };
}

async function seenMap(userId) {
  if (!userId) return new Map();
  await init();
  const rows = await getQuery("SELECT room_id, upto FROM story_seen WHERE user_id = ?", [userId]);
  return new Map(rows.map((r) => [r.room_id, Number(r.upto) || 0]));
}

/**
 * Every room with captures from the last 24 h. Signed in: items (oldest first, the story's order),
 * seen state, a cover (the newest photo or clip poster). Signed out: rooms and counts only.
 * Order: unseen rooms first, then by the newest capture.
 */
async function forViewer(viewer, { room = null, people = null } = {}) {
  await rooms.init();
  // 1.99fn: a profile pad's own story is its member's PERSON story - never a pad circle, never mixed into a pad's
  if (room && rooms.isProfile(room)) {
    const st = await require("./userstories").personStory(viewer, String(room).slice(rooms.PROFILE_PREFIX.length)).catch(() => null);
    return st ? [st] : [];
  }
  // 1.99ez: profile-pad stories (room user:<id>) are PERSON stories (userstories.js), never pad circles;
  // 1.99fn: with `room`, strictly that pad's rows
  const items = (await captures(room, MAX_ITEMS, { windowMs: WINDOW_MS, noProfiles: true })).filter((c) => c.room && (!room || c.room === room));
  const signed = !!(viewer && viewer.userId);
  const seen = signed ? await seenMap(viewer.userId) : new Map();
  // 1.99eq: what this viewer may do with each capture (📌 Post to pad / 🔖 Save - storykeep.js; the server re-checks)
  if (signed) { try { await require("./storykeep").annotate(viewer, items); } catch (e) { console.error("[stories] annotate:", e.message); } }
  // 1.99ez: 🗑 on members' own story uploads (the uploader, the pad's owner / mods, staff)
  if (signed) { try { await require("./userstories").annotate(viewer, items); } catch (e) { console.error("[stories] annotate (user):", e.message); } }
  const by = new Map();
  for (const c of items) {
    if (!by.has(c.room)) by.set(c.room, []);
    by.get(c.room).push(c);
  }
  const out = [];
  for (const [rid, list] of by) {
    list.sort((a, b) => a.created - b.created);
    const latest = list[list.length - 1].created;
    const upto = seen.get(rid) || 0;
    // cover: the newest capture that has a picture - a photo, or a clip's poster frame (1.99dq; 1.99ds:
    // a newer clip's poster wins over an older photo); never NSFW, never an audio waveform card
    const cv = [...list].reverse().find((c) => !c.nsfw && (c.kind === "photo" || (c.kind === "clip" && c.poster)));
    const cover = cv ? (cv.kind === "photo" ? cv.src : cv.poster) : null;
    const base = { ...roomInfo(rid), latest, count: list.length, unseen: latest > upto };
    if (signed) out.push({ ...base, seen: upto, cover, items: list.map(({ room: _r, ...x }) => x) });
    else out.push({ ...base, unseen: true, cover: null });
  }
  out.sort((a, b) => (b.unseen - a.unseen) || (b.latest - a.latest));
  // 1.99ez: person stories - the Following strip's people first (people = their user ids), then (no pad filter) members
  // with a profile upload and the viewer themselves
  if (!room) {
    let lead = [], rest = [];
    try {
      const US = require("./userstories");
      const follow = Array.isArray(people) ? people : [];
      const extra = (await US.profileUploaders()).concat(signed ? [viewer.userId] : []).filter((u) => !follow.includes(u));
      lead = follow.length ? await US.people(viewer, follow, { seen }) : [];
      rest = await US.people(viewer, extra, { seen });
    } catch (e) { console.error("[stories] people:", e.message); }
    const ord = (a, b) => (b.unseen - a.unseen) || (b.latest - a.latest);
    lead.sort(ord);
    const merged = out.concat(rest).sort(ord);
    return lead.concat(merged);
  }
  return out;
}

/** Record that `user` has seen `roomId`'s story up to `upto` (never moves backwards, never ahead of now). */
async function markSeen(user, roomId, upto) {
  if (!user || !user.userId) return null;
  const rid = String(roomId || "");
  const t = Math.floor(Number(upto));
  if (!ROOM_RE.test(rid) || !Number.isFinite(t) || t <= 0) return null;
  await init();
  const at = Math.min(t, NOW());
  await runQuery(`INSERT INTO story_seen (user_id, room_id, upto, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id, room_id) DO UPDATE SET upto = MAX(story_seen.upto, excluded.upto), updated = excluded.updated`,
                 [user.userId, rid, at, NOW()]);
  // keep the table small: rooms whose captures are long gone
  if (Math.random() < 0.02) runQuery("DELETE FROM story_seen WHERE updated < ?", [NOW() - 30 * 86400e3]).catch(() => {});
  return (await getQuery("SELECT upto FROM story_seen WHERE user_id = ? AND room_id = ?", [user.userId, rid]))[0].upto;
}

/** JSON for an inline <script type="application/json"> (no "</script>" breakout). */
function inlineJson(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function register(app, { addUser }) {
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  app.get("/api/stories", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Robots-Tag", "noindex");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to see captures." });
    // 1.99fn: ?room=<pad id> - ONE pad's story (its room captures, stage captures, members' stories posted to it) and
    // nothing else: the viewer opened from a pad's capture strip must not run on into other pads' or members' person
    // (profile) stories. A profile pad id (user:<id>) is that member's person story.
    const room = req.query.room != null ? String(req.query.room).slice(0, 128) : null;
    if (room !== null && !ROOM_RE.test(room)) return res.status(400).json({ ok: false, error: "Bad room." });
    try { res.json({ ok: true, rooms: await forViewer(req.user, room ? { room } : {}) }); } catch (e) {
      console.error("[stories] api:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  app.post("/api/stories/seen", addUser, async (req, res) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const b = req.body || {};
      const upto = await markSeen(req.user, b.room, b.upto);
      if (upto === null) return res.status(400).json({ ok: false, error: "Bad room." });
      res.json({ ok: true, upto });
    } catch (e) {
      console.error("[stories] seen:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, captures, clean, forViewer, markSeen, seenMap, register, inlineJson, privateLogins, WINDOW_MS, _setClock };
