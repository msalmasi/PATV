// roomctl.js — 📡 control the Camfrog rooms Pepe is in, from the site (1.99kp). Site Admins only.
//
//   /admin/pepe/rooms      the page (views/admin/pepeRooms.ejs): the rooms Pepe is in (people / on mic for bridged rooms),
//                          which one is active (his mic/cam window + the main stage) and which are muted; Join (name +
//                          optional password), Leave, Make active / Active: auto, Mute / Unmute per room.
//
// The same code path as Pepe's own admin panel (camfrog-bot pepe_roomctl.py, port 8766 on the VM) - so it works from
// anywhere, not only from the VM:
//   Pepe   --POST /api/pepe/rooms/state {password: bot token, state}-->  the list (every ~20 s + right after a change)
//   admin  --POST /api/admin/pepe/rooms {verb, room, password?, force?}--> a website action kind "room.ctl"
//          [verb, room, password?, "force"?] (actions.js); Pepe runs it on a worker (site_admin only), answers
//          "joining X…" at once and follows up with the result (pepe_webact._webact_followup)
//   admin  --GET  /api/admin/pepe/rooms--> {online, state, actions: the last room.ctl actions with their results}
//
// Guards: Admin class (page + API), same-site + X-Requested-With: fetch, 20 changes a minute per admin, room names
// checked for shape; Pepe re-checks site_admin and does one change at a time. A join password is used once: it is
// never in the action's label, and it is blanked from the stored action as soon as Pepe answers (actions.js ack) -
// and refused here too if the action is still waiting after 10 minutes (it would have expired anyway).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const guard = require("./middleware/authGuard");

const VERBS = new Set(["join", "leave", "active", "mute", "unmute"]);
const ROOM_RE = /^[^\u0000-\u001f<>]{1,64}$/;
const STATE_MAX = 32 * 1024;
const ONLINE_MS = 90 * 1000;
const RATE = { max: 20, windowMs: 60 * 1000 };
const hits = guard.limiter(RATE);

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn || (() => Date.now()); }

let STATE = null;                // {at, data}
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS pepe_rooms_state (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, data TEXT)");
      const r = (await getQuery("SELECT at, data FROM pepe_rooms_state WHERE id = 1"))[0];
      if (r && !STATE) { try { STATE = { at: Number(r.at), data: JSON.parse(r.data) }; } catch (e) { STATE = null; } }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const numOrNull = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100000, Math.floor(Number(v)))));

/** Pepe's state, re-shaped to what the page shows (nothing else is kept). */
function cleanState(s) {
  if (!s || typeof s !== "object") return null;
  const rooms = (Array.isArray(s.rooms) ? s.rooms : []).slice(0, 30).map((r) => (r && typeof r === "object" && str(r.id, 128) ? {
    id: str(r.id, 128), name: str(r.name, 80) || str(r.id, 128), count: numOrNull(r.count), mic: numOrNull(r.mic),
    muted: typeof r.muted === "boolean" ? r.muted : null, active: !!r.active, bridged: !!r.bridged, autojoin: !!r.autojoin,
  } : null)).filter(Boolean);
  const busy = s.busy && typeof s.busy === "object" ? { verb: str(s.busy.verb, 10), room: str(s.busy.room, 64) } : null;
  const log = (Array.isArray(s.log) ? s.log : []).slice(0, 12).map((x) => ({
    ts: Number(x && x.ts) > 0 ? Math.round(Number(x.ts) * 1000) : null, verb: str(x && x.verb, 10), room: str(x && x.room, 64),
    by: str(x && x.by, 60), ok: !!(x && x.ok), msg: str(x && x.msg, 200) }));
  const aj = (Array.isArray(s.autojoin) ? s.autojoin : []).slice(0, 30).map((e) => ({ name: str(e && e.name, 64), enabled: !!(e && e.enabled) })).filter((e) => e.name);
  // 1.99zp: rooms Pepe is banned from (bot pepe_roomban: no automatic joins, a backoff retry, an owner/admin join tries)
  const ms = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : null);
  const bans = (Array.isArray(s.bans) ? s.bans : []).slice(0, 30).map((b) => ({ room: str(b && b.room, 128), by: str(b && b.by, 80),
    at: ms(b && b.at), since: ms(b && b.since), retry_at: ms(b && b.retry_at), tries: Math.max(0, Math.min(99, Math.floor(Number(b && b.tries) || 0))) }))
    .filter((b) => b.room);
  return { rooms, active_room: str(s.active_room, 128) || null, active_auto: str(s.active_auto, 128) || null, pinned: !!s.pinned,
           audio_room: str(s.audio_room, 128) || null, net_audio: !!s.net_audio, busy, log, autojoin: aj, bans };
}

async function setState(raw) {
  await init();
  const data = cleanState(raw);
  if (!data) return false;
  const json = JSON.stringify(data);
  if (json.length > STATE_MAX) return false;
  STATE = { at: NOW(), data };
  await runQuery("INSERT INTO pepe_rooms_state (id, at, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data",
                 [STATE.at, json]);
  return true;
}

async function view() {
  await init();
  const t = NOW();
  let actions = [];
  try {
    actions = await getQuery(`SELECT id, username, label, status, message, created, updated FROM pepe_actions
                              WHERE kind = 'room.ctl' ORDER BY id DESC LIMIT 12`);
  } catch (e) { actions = []; }
  return { now: t, online: !!(STATE && t - STATE.at < ONLINE_MS), at: STATE ? STATE.at : null, state: STATE ? STATE.data : null, actions };
}

const LABEL = { join: "Join", leave: "Leave", active: "Make active", mute: "Mute", unmute: "Unmute" };

/** An admin's change -> the queued action id. */
async function request(user, b = {}) {
  await init();
  if (!SP.can(user, "pepe.rooms_commands_audio")) throw new Refuse(403, "Admins only.");
  const verb = String(b.verb || "").toLowerCase();
  if (!VERBS.has(verb)) throw new Refuse(400, "Unknown room action.");
  const room = str(b.room, 64);
  if (!room || !ROOM_RE.test(room)) throw new Refuse(400, "Which room?");
  const pw = verb === "join" ? str(b.password, 64) : "";
  const force = verb === "active" && !!b.force;
  if (!(STATE && NOW() - STATE.at < ONLINE_MS)) throw new Refuse(409, "Pepe isn't reporting his rooms right now (offline?) - try again in a minute.");
  if (verb !== "join" && !(verb === "active" && room.toLowerCase() === "auto")) {
    const known = (STATE.data.rooms || []).some((r) => [r.id, r.name].some((x) => String(x).toLowerCase() === room.toLowerCase()));
    if (!known) throw new Refuse(404, "Pepe isn't in that room.");
  }
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, `Slow down - at most ${RATE.max} room changes a minute.`);
  hits.hit(key);
  const args = [verb, room, pw, force ? "force" : ""];
  const label = `${LABEL[verb]} ${room}${verb === "join" && pw ? " (with a password)" : ""}${force ? " (force)" : ""}`;
  try {
    return await require("./actions").queue(user.userId, { kind: "room.ctl", args, tag: "pepe-rooms", label });
  } catch (e) {
    if (e && e.message === "busy") throw new Refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    throw e;
  }
}

/** A finished room.ctl action never keeps its password (actions.js calls this on every ack; also swept here). */
async function scrubPasswords() {
  try {
    const rows = await getQuery(`SELECT id, args FROM pepe_actions WHERE kind = 'room.ctl' AND (status IN ('done','failed') OR created < ?)
                                 AND args LIKE '["join",%' LIMIT 50`, [NOW() - 10 * 60 * 1000]);
    for (const r of rows) {
      let a = [];
      try { a = JSON.parse(r.args); } catch (e) { a = []; }
      if (Array.isArray(a) && a[2]) {
        a[2] = "";
        await runQuery("UPDATE pepe_actions SET args = ? WHERE id = ?", [JSON.stringify(a), r.id]);
      }
    }
    await runQuery(`UPDATE pepe_actions SET status = 'failed', message = 'expired - Pepe never picked it up', updated = ?
                    WHERE kind = 'room.ctl' AND status = 'pending' AND created < ?`, [NOW(), NOW() - 10 * 60 * 1000]);
  } catch (e) { /* no pepe_actions table yet */ }
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[roomctl] init:", e.message));
  const admin = (json) => (req, res, next) => {
    if (!req.user || !req.user.userId) return json ? res.status(401).json({ ok: false, error: "Sign in first." }) : res.redirect("/login?next=/admin/pepe/rooms");
    if (!SP.can(req.user, "pepe.rooms_commands_audio")) return json ? res.status(403).json({ ok: false, error: "Admins only." }) : res.status(403).send("Admins only.");
    next();
  };
  const fetchOnly = (req, res, next) => (guard.sameSite(req) && req.get("X-Requested-With") === "fetch"
    ? next() : res.status(403).json({ ok: false, error: "Security check failed - reload the page." }));
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[roomctl]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };

  app.post("/api/pepe/rooms/state", async (req, res) => {
    if (!isBotToken(String((req.body || {}).password || req.get("x-bot-token") || ""))) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: await setState((req.body || {}).state) }); } catch (e) { console.error("[roomctl] state:", e.message); res.status(500).json({ ok: false }); }
  });
  app.get("/admin/pepe/rooms", addUser, admin(false), async (req, res) => {
    try {
      await scrubPasswords();
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("admin/pepeRooms", { user: req.user.username, title: "Admin · Pepe's rooms", section: "pepe", isAdmin: true, v: await view() });
    } catch (e) { console.error("[roomctl] page:", e); res.status(500).send("Couldn't load the page."); }
  });
  app.get("/api/admin/pepe/rooms", addUser, admin(true), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { await scrubPasswords(); res.json({ ok: true, ...(await view()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/rooms", addUser, admin(true), fetchOnly, async (req, res) => {
    try { res.json({ ok: true, id: await request(req.user, req.body || {}) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, setState, cleanState, view, request, scrubPasswords, init, _setClock, _reset: () => { STATE = null; }, VERBS };
