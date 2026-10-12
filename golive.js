// golive.js — 🎥 "X just went live" (1.99kp): go-live alerts for followers + the announcement in the pad.
//
// A STREAM START is one of:
//   * a stage slot going live (mainstage.js: the first RTMP / browser / WHIP publish = goLive; an embed slot opening;
//     a 📼 Play from Plex slot = a library slot's first publish) -> onSlot(slot)
//   * a Twitch-connected pad's channel going live (padconnect.js twitch pads; polled here every TWITCH_POLL_MS when the
//     site has Twitch app credentials - TWITCH_CLIENT_ID + TWITCH_SECRET_KEY)
// Each start is handled ONCE (golive_log, keyed slot:<id> / twitch:<stream id>), and a streamer who comes back on the
// same pad within RESTART_MS (a dropped connection, a new slot right after the last) doesn't alert anyone again.
//
// 1) FOLLOWERS (people who follow the streamer, and people who follow the pad):
//    an inbox notice (inbox kind "golive", the 🔔), plus a Pepe PM in Camfrog when they asked for that (and the inbox
//    "PM me" preference for go-live isn't off). Never: the streamer themselves, someone who blocked the streamer or
//    was blocked by them (dm_blocks, either way), anyone who can't see the pad (padaccess), a follow with go-live
//    switched off, or anyone with go-live alerts off. At most NOTIFY_MAX per start.
//      golive_prefs   user_id, alerts (default 1), pm (default 0), updated
//      follows.live   per follow: NULL / 1 = alerts on, 0 = off (follows.js adds the column)
// 2) THE PAD: unless its owner switched it off (golive_pad.announce, default on) and at most once per PAD_GAP_MS:
//    a line in the pad's live chat on PATV (bridge.js liveNotice: a "live" feed item) and Pepe's line in the pad's
//    linked Camfrog room (bridge-relay job "golive", camfrog-bot pepe_relay._relay_golive):
//      "🎥 <streamer> just went live on <pad> — <title / what> — <link>"
//    Both only exist for a pad whose Camfrog room Pepe bridges (that is the pad's chat on PATV); other pads get the
//    follower alerts only.
// 3) 1.99lr: a 📼 QUEUE's next title (mediaqueue.js decides when: not more often than library_queue_announce_min) ->
//    nowPlaying(): "📼 Now playing on <pad>: <title>" in the pad's chat + Pepe's line in its Camfrog room (relay job
//    "nowplaying"). Same owner switch; NEVER a follower alert (that was the queue's stream start, once).
//
// Routes (signed in; JSON = same site + X-Requested-With: fetch)
//   POST /api/golive/prefs          {alerts?, pm?}
//   POST /api/golive/follow         {kind: user|room, id, on}      one follow's go-live alerts
//   POST /api/rooms/:slug/golive    {announce}                     the pad owner's switch (pad settings -> Stage)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const NOTIFY_MAX = 1000;
const RESTART_MS = 30 * 60 * 1000;        // the same streamer back on the same pad within this = the same show
const PAD_GAP_MS = 10 * 60 * 1000;        // one pad announcement per this
const TWITCH_POLL_MS = 3 * 60 * 1000;

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn || (() => Date.now()); }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./follows").init();
      await runQuery(`CREATE TABLE IF NOT EXISTS golive_prefs (user_id TEXT PRIMARY KEY, alerts INTEGER NOT NULL DEFAULT 1,
                      pm INTEGER NOT NULL DEFAULT 0, updated INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS golive_pad (room_id TEXT PRIMARY KEY, announce INTEGER NOT NULL DEFAULT 1, updated INTEGER, by TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS golive_log (key TEXT PRIMARY KEY, room_id TEXT, user_id TEXT, source TEXT, ts INTEGER NOT NULL,
                      notified INTEGER NOT NULL DEFAULT 0, announced INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS golive_log_room ON golive_log (room_id, ts)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const SITE = () => String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL ||
  (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");

// ── preferences ──
async function prefs(userId) {
  await init();
  const r = (await getQuery("SELECT alerts, pm FROM golive_prefs WHERE user_id = ?", [String(userId || "")]))[0];
  return { alerts: r ? !!r.alerts : true, pm: r ? !!r.pm : false };
}
async function setPrefs(user, b = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const cur = await prefs(user.userId);
  const next = { alerts: b.alerts === undefined ? cur.alerts : !!b.alerts, pm: b.pm === undefined ? cur.pm : !!b.pm };
  await runQuery(`INSERT INTO golive_prefs (user_id, alerts, pm, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET alerts = excluded.alerts, pm = excluded.pm, updated = excluded.updated`,
                 [user.userId, next.alerts ? 1 : 0, next.pm ? 1 : 0, NOW()]);
  return next;
}
/** One follow's switch. The follow must exist (follow first). */
async function setFollow(user, kind, id, on) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  await init();
  const F = require("./follows");
  const T = await F.resolve(kind, id);
  if (!T) throw new Refuse(404, "Not found.");
  const r = await runQuery("UPDATE follows SET live = ? WHERE follower = ? AND target_kind = ? AND target_id = ?", [on ? 1 : 0, user.userId, kind, T.id]);
  if (!r || !r.changes) throw new Refuse(409, "Follow them first.");
  return { kind, id: T.id, live: !!on };
}
async function padAnnounce(roomId) {
  await init();
  const r = (await getQuery("SELECT announce FROM golive_pad WHERE room_id = ?", [String(roomId || "")]))[0];
  return r ? !!r.announce : true;
}
async function setPadAnnounce(user, roomId, on) {
  await init();
  const rooms = require("./rooms");
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner (or a site admin) can change that.");
  await runQuery(`INSERT INTO golive_pad (room_id, announce, updated, by) VALUES (?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET announce = excluded.announce, updated = excluded.updated, by = excluded.by`,
                 [roomId, on ? 1 : 0, NOW(), user && user.username ? user.username : null]);
  return { announce: !!on };
}

/** 1.99up: the pad's announcement switch back to the default (on): the row goes. */
async function resetPadAnnounce(user, roomId) {
  await init();
  const rooms = require("./rooms");
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner (or a site admin) can change that.");
  await runQuery("DELETE FROM golive_pad WHERE room_id = ?", [roomId]);
  return { announce: true };
}
/** 1.99up: did the owner (or an admin) set the switch? (null = never: the default) */
async function padAnnounceSet(roomId) {
  await init();
  const r = (await getQuery("SELECT announce FROM golive_pad WHERE room_id = ?", [String(roomId || "")]))[0];
  return r ? !!r.announce : null;
}

// ── who hears about it ──
/** Follower user ids for a start (see the header for every rule). */
async function audience(roomId, streamerId) {
  await init();
  const args = [];
  let where = "(f.target_kind = 'room' AND f.target_id = ?)";
  args.push(String(roomId));
  if (streamerId) { where = "(" + where + " OR (f.target_kind = 'user' AND f.target_id = ?))"; args.push(String(streamerId)); }
  const rows = await getQuery(`SELECT DISTINCT f.follower AS id, u.class AS class FROM follows f JOIN users u ON u.userId = f.follower
                               LEFT JOIN golive_prefs gp ON gp.user_id = f.follower
                               WHERE ${where} AND COALESCE(f.live, 1) = 1 AND COALESCE(gp.alerts, 1) = 1
                               ${streamerId ? "AND f.follower != ?" : ""}
                               LIMIT ?`, [...args, ...(streamerId ? [String(streamerId)] : []), NOTIFY_MAX * 2]);
  let blocked = new Set();
  if (streamerId) {
    try {
      const b = await getQuery("SELECT blocker_id, blocked_id FROM dm_blocks WHERE blocker_id = ? OR blocked_id = ?", [streamerId, streamerId]);
      blocked = new Set(b.map((x) => (x.blocker_id === streamerId ? x.blocked_id : x.blocker_id)));
    } catch (e) { blocked = new Set(); }               // no DM blocks table yet
  }
  const PA = require("./padaccess");
  await PA.init();
  return rows.filter((r) => !blocked.has(r.id) && PA.canSee({ userId: r.id, class: r.class }, roomId)).slice(0, NOTIFY_MAX).map((r) => r.id);
}

/** What's on, in a few words: the slot title, the Plex title, the embed's label. */
function whatOf(s) {
  if (!s) return "";
  if (s.title) return clean(s.title, 90);
  if (s.mode === "embed" && s.embed) {
    try { const e = typeof s.embed === "string" ? JSON.parse(s.embed) : s.embed; return clean(require("./stageembed").label(e), 90); } catch (e) { return ""; }
  }
  return "";
}

/**
 * One stream start. o = {key, roomId, userId (streamer, may be null), display, what, source}. -> what happened
 * (for tests/logs): {dup} | {notified, announced}. Never throws.
 */
async function onLive(o) {
  try {
    await init();
    const key = clean(o.key, 120);
    const roomId = String(o.roomId || "");
    if (!key || !roomId) return { skipped: "bad" };
    const t = NOW();
    const ins = await runQuery("INSERT OR IGNORE INTO golive_log (key, room_id, user_id, source, ts) VALUES (?, ?, ?, ?, ?)",
                               [key, roomId, o.userId || null, clean(o.source, 20) || null, t]);
    if (!ins || !ins.changes) return { dup: true };
    const rooms = require("./rooms");
    const R = await rooms.get(roomId);
    if (!R) return { skipped: "no pad" };
    // the same streamer back on the same pad soon after = the same show (a reconnect, the next slot)
    const again = (await getQuery(`SELECT COUNT(*) AS n FROM golive_log WHERE room_id = ? AND key != ? AND ts > ? AND
                                   ((? IS NOT NULL AND user_id = ?) OR (? IS NULL AND user_id IS NULL))`,
                                  [roomId, key, t - RESTART_MS, o.userId || null, o.userId || null, o.userId || null]))[0].n > 0;
    const display = clean(o.display, 40) || "Someone";
    const what = clean(o.what, 90);
    const href = require("./pads").padHref(R);
    const padName = clean(R.title, 60) || R.id;
    let notified = 0, announced = false;
    if (!again) {
      const ids = await audience(roomId, o.userId);
      const P = new Map();
      if (ids.length) {
        const pr = await getQuery(`SELECT user_id, pm FROM golive_prefs WHERE user_id IN (${ids.map(() => "?").join(",")})`, ids);
        for (const p of pr) P.set(p.user_id, !!p.pm);
      }
      for (const uid of ids) {
        const ok = await rooms.notify(uid, { kind: "golive", title: `🎥 ${display} is live on ${padName}`, body: what, link: href,
                                             ref: "golive:" + key, pm: !!P.get(uid) });
        if (ok) notified++;
      }
      await runQuery("UPDATE golive_log SET notified = ? WHERE key = ?", [notified, key]);
    }
    if (await padAnnounce(roomId)) {
      const last = (await getQuery("SELECT MAX(ts) AS t FROM golive_log WHERE room_id = ? AND announced = 1", [roomId]))[0];
      if (!(last && last.t && t - last.t < PAD_GAP_MS) && !again) {
        const bridge = require("./bridge");
        const link = SITE() + href;
        const said = await bridge.liveNotice(roomId, { who: display, pad: padName, what, link: href });
        const job = await bridge.liveAnnounce(roomId, { streamer: display, pad: padName, what, link, camfrog: o.camfrog || "", userId: o.userId || null });
        announced = !!(said || job);
        if (announced) await runQuery("UPDATE golive_log SET announced = 1 WHERE key = ?", [key]);
      }
    }
    return { notified, announced, again };
  } catch (e) {
    console.error("[golive]", e.message);
    return { error: e.message };
  }
}

// the streamer's Camfrog login for Pepe's line (Pepe re-checks !incognito); "" when hidden / none
async function camfrogOf(userId) {
  try {
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
    const camfrog = u && u.camfrogUsername ? String(u.camfrogUsername).toLowerCase() : "";
    return camfrog && require("./quotes").isHidden(camfrog) ? "" : camfrog;
  } catch (e) { return ""; }
}

/**
 * 1.99lr: a 📼 queue moved on to its next title. o = {roomId, userId, display, what}. The caller rate-limits; this checks
 * the pad owner's switch. -> {announced, said, job}. Never throws.
 */
async function nowPlaying(o = {}) {
  try {
    await init();
    const roomId = String(o.roomId || "");
    const what = clean(o.what, 90);
    if (!roomId || !what) return { announced: false, why: "bad" };
    if (!(await padAnnounce(roomId))) return { announced: false, why: "off" };
    const R = await require("./rooms").get(roomId);
    if (!R) return { announced: false, why: "no pad" };
    const href = require("./pads").padHref(R);
    const padName = clean(R.title, 60) || R.id;
    const display = clean(o.display, 40) || "Someone";
    const bridge = require("./bridge");
    const said = await bridge.liveNotice(roomId, { who: display, pad: padName, what, link: href, np: true });
    const job = await bridge.liveAnnounce(roomId, { streamer: display, pad: padName, what, link: SITE() + href, camfrog: await camfrogOf(o.userId),
                                                    userId: o.userId || null, np: true });
    return { announced: !!(said || job), said: !!said, job: !!job };
  } catch (e) {
    console.error("[golive] now playing:", e.message);
    return { announced: false, error: e.message };
  }
}

/** A stage slot went live (mainstage.js). `s` = the stage_slots row. */
async function onSlot(s) {
  if (!s || !s.id || !s.room_id) return null;
  const camfrog = await camfrogOf(s.userId);
  return onLive({ key: "slot:" + s.id, roomId: s.room_id, userId: s.userId, display: s.displayname || s.username,
                  what: whatOf(s), source: s.source === "library" ? "plex" : s.mode === "embed" ? "embed" : "stage", camfrog });
}
/** Fire and forget (the stage never waits on alerts). */
function slotLive(s) { setImmediate(() => { onSlot(s).catch(() => {}); }); }

// ── Twitch-connected pads ──
const twitchLive = new Map();          // room id -> {id, title, since}
let twitchToken = { v: null, exp: 0 };
async function twitchFetch(url, opt) { return fetch(url, { ...opt, signal: AbortSignal.timeout(15000) }); }
async function appToken() {
  const id = process.env.TWITCH_CLIENT_ID, sec = process.env.TWITCH_SECRET_KEY;
  if (!id || !sec) return null;
  if (twitchToken.v && NOW() < twitchToken.exp - 60000) return twitchToken.v;
  const r = await twitchFetch("https://id.twitch.tv/oauth2/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, client_secret: sec, grant_type: "client_credentials" }).toString() });
  if (!r.ok) throw new Error("twitch token HTTP " + r.status);
  const j = await r.json();
  twitchToken = { v: j.access_token, exp: NOW() + (Number(j.expires_in) || 3600) * 1000 };
  return twitchToken.v;
}
/** -> [{roomId, login, ownerId, ownerName}] for the pads connected to Twitch. */
async function twitchPads() {
  let rows = [];
  try {
    rows = await getQuery(`SELECT c.room_id, c.external_name, c.external_id, r.owner_user_id, u.username, u.displayname, u.twitchLogin
                           FROM pad_connections c JOIN rooms_registry r ON r.room_id = c.room_id LEFT JOIN users u ON u.userId = r.owner_user_id
                           WHERE c.platform = 'twitch' AND c.status = 'verified'`);
  } catch (e) { return []; }
  return rows.map((r) => ({ roomId: r.room_id, login: String(r.twitchLogin || r.external_name || "").toLowerCase(), ownerId: r.owner_user_id,
                            ownerName: r.displayname || r.username || r.external_name || "" }))
    .filter((p) => /^[a-z0-9_]{2,25}$/.test(p.login));
}
async function twitchTick() {
  const pads = await twitchPads();
  if (!pads.length) { twitchLive.clear(); return 0; }
  const token = await appToken();
  if (!token) return 0;
  const seen = new Map();
  for (let i = 0; i < pads.length; i += 100) {
    const chunk = pads.slice(i, i + 100);
    const q = chunk.map((p) => "user_login=" + encodeURIComponent(p.login)).join("&");
    const r = await twitchFetch("https://api.twitch.tv/helix/streams?first=100&" + q, { headers: { Authorization: "Bearer " + token, "Client-Id": process.env.TWITCH_CLIENT_ID } });
    if (r.status === 401) { twitchToken = { v: null, exp: 0 }; return 0; }
    if (!r.ok) throw new Error("twitch streams HTTP " + r.status);
    const j = await r.json();
    for (const st of (j && j.data) || []) seen.set(String(st.user_login || "").toLowerCase(), st);
  }
  let started = 0;
  for (const p of pads) {
    const st = seen.get(p.login);
    if (!st) { twitchLive.delete(p.roomId); continue; }
    const was = twitchLive.get(p.roomId);
    twitchLive.set(p.roomId, { id: String(st.id), title: clean(st.title, 90), since: Date.parse(st.started_at) || NOW() });
    if (!was || was.id !== String(st.id)) {
      started++;
      await onLive({ key: "twitch:" + String(st.id), roomId: p.roomId, userId: p.ownerId || null, display: p.ownerName || st.user_name,
                     what: clean(st.title, 90) || "Twitch", source: "twitch" });
    }
  }
  return started;
}
/** A Twitch pad's live stream right now (memory), or null - for the homepage's "now playing". */
function twitchNow(roomId) { return twitchLive.get(String(roomId || "")) || null; }

// ── routes ──
let timer = null;
function register(app, { addUser, noTimers } = {}) {
  init().catch((e) => console.error("[golive] init:", e.message));
  if (!noTimers && !timer && process.env.TWITCH_CLIENT_ID && process.env.TWITCH_SECRET_KEY) {
    timer = setInterval(() => twitchTick().catch((e) => console.error("[golive] twitch:", e.message)), TWITCH_POLL_MS);
    timer.unref();
  }
  const guard = require("./middleware/authGuard");
  const json = (req, res, next) => {
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[golive]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/golive/prefs", addUser, json, async (req, res) => {
    try { const b = req.body || {}; res.json({ ok: true, ...(await setPrefs(req.user, { alerts: b.alerts, pm: b.pm })) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/golive/follow", addUser, json, async (req, res) => {
    try { const b = req.body || {}; res.json({ ok: true, ...(await setFollow(req.user, String(b.kind || ""), String(b.id || ""), !!b.on)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/golive", addUser, json, async (req, res) => {
    try {
      const rooms = require("./rooms");
      const R = (await rooms.get(String(req.params.slug || ""))) || (await rooms.bySlug(String(req.params.slug || "")));
      if (!R) throw new Refuse(404, "No such pad.");
      res.json({ ok: true, ...(await setPadAnnounce(await require("./feedstore").account(req.user.userId), R.id, !!(req.body || {}).announce)) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, prefs, setPrefs, setFollow, padAnnounce, setPadAnnounce, resetPadAnnounce, padAnnounceSet, audience, onLive, onSlot, slotLive, whatOf, nowPlaying,
                   twitchTick, twitchNow, _twitchLive: twitchLive, _setClock, Refuse, RESTART_MS, PAD_GAP_MS };
