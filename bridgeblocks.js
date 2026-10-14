// bridgeblocks.js — 1.99xa: block a WEB sender from relaying into a pad's chat room (the "!bridge block" family).
//
// A room's mods / the pad's owner / Pepe's admins can stop one PATV account from talking into a bridged Camfrog room from the
// website (relay lines, clips, typed "!" commands, the 🐸 Pepe menu) - for a while or until lifted, with a reason. It blocks the
// ACCOUNT's web relay only: a linked chat login keeps its normal Camfrog chat (that is what !kick / !ban / !timeout are for).
// Pepe admins (site Admins on the web) can block an account in every room at once (room_id '' = global).
//
// The SITE is the source of truth:
//   bridge_blocks  (room_id, user_id) PK - room_id '' = every room; username (shown), reason, blocked_by (the blocker's
//                  userId when known), blocker_name (a label: PATV username or "chat:<login>"), via (web | chat | admin),
//                  created, until (ms, NULL = until lifted), updated, op_key (the bot call's idempotency key)
// Every write is one dbUtils.tx (never a raw BEGIN); a block / unblock is idempotent by its key (room, account) - a bot call
// replayed with the same `key` changes nothing. Audit: a room block / unblock goes in the pad's event log (rooms.event,
// "bridge-block"), a global one in admin_audit (action "bridge_block").
//
// Enforced twice: bridge-relay.js refuses a blocked account's say / clip / command (`refusal`), and Pepe refuses its relay jobs
// from his MIRROR (camfrog-bot pepe_bridgeblock.py) - the bridge sync response carries the rows whenever Pepe's mirror version
// differs (`forSync`), so a stale or unreachable site is still covered by what he already knows.
//
// 1.99zf: a block can cover ONE bridge feature instead of everything (column `feature`, PK (room_id, user_id, feature)):
//   all        everything below (what !bridge block always did)
//   chat       relay lines        commands   typed "!" commands + the Pepe menu   soundboard  the pad's soundboard (!sb)
//   voice      push-to-talk clips snapshots  cam snapshots (ask / save)            livecams    live cams
//   clips      cam clips + mic clips (record / save)
// The pad's owner / room mods pick one (or all) for their room; site Admins set them per account in every room
// (/admin/users#bridgebans) - every admin change goes in admin_audit (bridge_block). refusal(room, user, feature) is what every
// web write path asks (bridge-relay, padpepe, camclip, micclip, livecam); its text names the feature, the end and the reason.
//
// Routes:
//   POST /api/bridge/blocks                 Pepe (bot token): {op: block|unblock|list, room, global, target, by, until, secs, reason, key}
//                                           - Pepe has already checked that `by` may do it in that room (his own mod / owner / admin checks)
//   GET  /api/rooms/:slug/blocks            the pad's blocks (owner, site staff, or a room mod by Pepe's caps for their linked login)
//   POST /api/rooms/:slug/blocks            {op: block|unblock, target, hours, reason} (same people; JSON + X-Requested-With + same site)
//   GET  /api/admin/bridge/blocks           every block (site Admins)
//   POST /api/admin/bridge/blocks           {op, room ('' = every room), target, hours, reason} (site Admins)
"use strict";
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");

const REASON_MAX = 120;
const MAX_MS = 365 * 24 * 3600 * 1000;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/;
const NAME_RE = /^[\w.\-$]{1,40}$/;
const WEB_MARK = "\u{1f310}";
const FEATURES = ["chat", "commands", "soundboard", "voice", "snapshots", "livecams", "clips"];
const FEATURE_SET = new Set(["all", ...FEATURES]);
// what the refusal says they can't do: [in this room, in every room]
const WHAT = {
  all: ["talking in it from the website", "talking into chat rooms from the website"],
  chat: ["chatting in it from the website", "chatting in rooms from the website"],
  commands: ["using commands and the Pepe menu in it from the website", "using commands and the Pepe menu from the website"],
  soundboard: ["using its soundboard", "using pad soundboards"],
  voice: ["sending voice clips into it", "sending voice clips into rooms"],
  snapshots: ["taking cam snapshots in it", "taking cam snapshots"],
  livecams: ["watching live cams in it", "watching live cams"],
  clips: ["making cam and mic clips in it", "making cam and mic clips"],
};
const featureOf = (f) => { const v = String(f == null || f === "" ? "all" : f).toLowerCase().trim(); return FEATURE_SET.has(v) ? v : null; };

let clock = () => Date.now();
const now = () => clock();
let ver = "boot-" + Date.now().toString(36);      // Pepe re-reads the mirror after a site restart
let seq = 0;
const bump = () => { ver = now().toString(36) + "-" + (++seq); };

const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (s, n) => String(s == null ? "" : s).replace(CTRL, " ").replace(/<[^<>]{0,60}>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      const create = `CREATE TABLE IF NOT EXISTS bridge_blocks (room_id TEXT NOT NULL, user_id TEXT NOT NULL, feature TEXT NOT NULL DEFAULT 'all',
        username TEXT, reason TEXT, blocked_by TEXT, blocker_name TEXT, via TEXT, created INTEGER NOT NULL, until INTEGER, updated INTEGER NOT NULL,
        op_key TEXT, PRIMARY KEY (room_id, user_id, feature))`;
      const have = await getQuery("PRAGMA table_info(bridge_blocks)");
      if (!have.length) await runQuery(create);
      else if (!have.some((c) => c.name === "feature")) {
        // 1.99zf: the old (room_id, user_id) key -> (room_id, user_id, feature); every old row is an "all" block
        await tx(async () => {
          await runQuery("DROP TABLE IF EXISTS bridge_blocks_v2");
          await runQuery(create.replace("IF NOT EXISTS bridge_blocks", "bridge_blocks_v2"));
          await runQuery(`INSERT INTO bridge_blocks_v2 (room_id, user_id, feature, username, reason, blocked_by, blocker_name, via, created, until, updated, op_key)
                          SELECT room_id, user_id, 'all', username, reason, blocked_by, blocker_name, via, created, until, updated, op_key FROM bridge_blocks`);
          await runQuery("DROP TABLE bridge_blocks");
          await runQuery("ALTER TABLE bridge_blocks_v2 RENAME TO bridge_blocks");
        });
        console.log("[bridgeblocks] migrated bridge_blocks to per-feature rows");
      }
      await runQuery("CREATE INDEX IF NOT EXISTS bridge_blocks_user ON bridge_blocks (user_id)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function hasArchived() {
  try { return (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { return false; }
}

/**
 * Who a mod means: "🌐name" (a PATV username), "u:<userId>", a linked chat login, or a PATV username.
 * -> {userId, username, login} | {error}. A bare name tries the chat login first (what the room sees), then the username.
 */
async function resolveTarget(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/^@/, "");
  if (!s) return { error: "Who? Give a name." };
  const live = (await hasArchived()) ? "AND archived_at IS NULL" : "";
  const pick = (r) => (r ? { userId: String(r.userId), username: r.username, login: r.camfrogUsername || null } : null);
  const m = ACCT_RE.exec(s);
  if (m) {
    const r = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE userId = ? ${live}`, [m[1]]))[0];
    return pick(r) || { error: "No PATV account has that id." };
  }
  let webOnly = false;
  if (s.startsWith(WEB_MARK)) { s = s.slice(WEB_MARK.length).trim(); webOnly = true; }
  s = s.replace(/^@/, "");
  if (!NAME_RE.test(s)) return { error: "That isn't a name." };
  const low = s.toLowerCase();
  if (!webOnly) {
    const r = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(camfrogUsername) = ? ${live} LIMIT 2`, [low]));
    if (r.length === 1) return pick(r[0]);
  }
  const r = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(username) = ? ${live} LIMIT 1`, [low]))[0];
  return pick(r) || { error: `No PATV account called ${s}.` };
}

const rowOut = (r) => r && ({ room: r.room_id, global: r.room_id === "", userId: r.user_id, feature: r.feature || "all", username: r.username, reason: r.reason || "",
  by: r.blocker_name || "", via: r.via || "", created: Number(r.created) || 0, until: r.until == null ? null : Number(r.until) });

/** The active block on this account in this room covering `feature` (an "all" block covers every feature; the room's own
 *  before a global one, the exact feature before "all"), or null. feature "all" = any block at all. */
async function active(roomId, userId, feature = "all", t = now()) {
  if (!userId) return null;
  await init();
  const f = featureOf(feature) || "all";
  const args = [String(userId), String(roomId || ""), t];
  if (f !== "all") args.push(f);
  const rows = await getQuery(`SELECT * FROM bridge_blocks WHERE user_id = ? AND (room_id = ? OR room_id = '') AND (until IS NULL OR until > ?)
                               ${f === "all" ? "" : "AND feature IN ('all', ?)"}`, args);
  const rank = (x) => (x.room_id !== "" ? 0 : 2) + ((x.feature || "all") === f ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b));
  return rows[0] ? rowOut(rows[0]) : null;
}

/** The refusal text for one block (rowOut) when `feature` was asked for. */
function refusalText(b, feature = "all") {
  const f = featureOf(feature) || "all";
  const what = WHAT[b.feature === "all" ? f : b.feature] || WHAT.all;
  const when = b.until ? " until " + new Date(b.until).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  const lead = b.global ? "You're blocked from " : "A mod of this room blocked you from ";
  return lead + what[b.global ? 1 : 0] + when + (b.reason ? " (" + b.reason + ")" : "") + ".";
}

/** Why this account may not use `feature` of the web bridge in this room (null = it may). Every web write path asks this. */
async function refusal(roomId, userId, feature = "all") {
  let b = null;
  try { b = await active(roomId, userId, feature); } catch (e) { b = null; }
  return b ? refusalText(b, feature) : null;
}

function untilFrom({ until, secs, hours }, t) {
  if (until != null && until !== "") {
    const u = Math.floor(Number(until));
    if (!(u > t)) return { error: "That time is already over." };
    return { until: Math.min(u, t + MAX_MS) };
  }
  const s = secs != null && secs !== "" ? Number(secs) : hours != null && hours !== "" ? Number(hours) * 3600 : null;
  if (s == null || s === 0) return { until: null };                // until lifted
  if (!(s > 0)) return { error: "That isn't a length of time." };
  return { until: t + Math.min(Math.floor(s * 1000), MAX_MS) };
}

/**
 * Block (or re-block) `target` in `roomId` ('' = every room). by = {userId?, name, via}. key = the caller's idempotency key.
 * -> {block, again} | {error}
 */
async function block({ roomId, target, feature = "all", until = null, reason = "", by = {}, key = null }) {
  await init();
  const room = String(roomId == null ? "" : roomId).slice(0, 128);
  const feat = featureOf(feature);
  if (!feat) return { error: "That isn't a bridge feature." };
  const k = key ? String(key).slice(0, 80) : null;
  const t = now();
  const why = clean(reason, REASON_MAX);
  const out = await tx(async () => {
    const cur = (await getQuery("SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ? AND feature = ?", [room, target.userId, feat]))[0];
    if (cur && k && cur.op_key === k) return { block: rowOut(cur), again: true };
    await runQuery(`INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, blocked_by, blocker_name, via, created, until, updated, op_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(room_id, user_id, feature) DO UPDATE SET username = excluded.username, reason = excluded.reason,
                      blocked_by = excluded.blocked_by, blocker_name = excluded.blocker_name, via = excluded.via, until = excluded.until,
                      updated = excluded.updated, op_key = excluded.op_key`,
      [room, target.userId, feat, target.username || null, why || null, by.userId || null, clean(by.name, 60) || null, clean(by.via, 12) || null,
       t, until, t, k]);
    const detail = `${cur ? "re-blocked" : "blocked"} ${target.username || target.userId} from ${feat === "all" ? "the web relay" : "the web bridge's " + feat}`
      + (until ? " until " + new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC" : " until lifted")
      + (why ? " - " + why : "") + ` (${clean(by.via, 12) || "?"})`;
    await audit(room, "block", by, target, detail, { feature: feat, until, reason: why });
    const row = (await getQuery("SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ? AND feature = ?", [room, target.userId, feat]))[0];
    return { block: rowOut(row), again: false };
  });
  if (!out.again) bump();
  return out;
}

/** Lift a block: one feature's, or (feature null) every one this account has in that room. -> {removed} (false = there was
 *  none; idempotent). */
async function unblock({ roomId, target, feature = null, by = {}, key = null }) {
  await init();
  const room = String(roomId == null ? "" : roomId).slice(0, 128);
  const feat = feature == null || feature === "" ? null : featureOf(feature);
  if (feature != null && feature !== "" && !feat) return { removed: false, error: "That isn't a bridge feature." };
  const out = await tx(async () => {
    const q = feat ? ["SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ? AND feature = ?", [room, target.userId, feat]]
                   : ["SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ?", [room, target.userId]];
    const cur = await getQuery(q[0], q[1]);
    if (!cur.length) return { removed: false };
    await runQuery(q[0].replace("SELECT *", "DELETE"), q[1]);
    const what = feat ? (feat === "all" ? "the web relay" : "the web bridge's " + feat) : cur.length > 1 ? "every web bridge block" : (cur[0].feature === "all" ? "the web relay" : "the web bridge's " + cur[0].feature);
    await audit(room, "unblock", by, target, `unblocked ${target.username || target.userId} on ${what} (${clean(by.via, 12) || "?"})`,
      { key, feature: feat || "*" });
    return { removed: true };
  });
  if (out.removed) bump();
  return out;
}

async function audit(room, op, by, target, detail, extra) {
  if (room) {
    await require("./rooms").event(room, "bridge-block", clean(by.name, 60) || null, detail);
  }
  if (!room || by.via === "admin") {             // 1.99zf: an admin's room block is in admin_audit too
    await require("./adminaudit").record({ userId: by.userId || "pepe", username: clean(by.name, 60) || "pepe" }, "bridge_block",
      { userId: target.userId, username: target.username || null }, Object.assign({ op, room: room || "*", via: clean(by.via, 12) || null }, extra || {}),
      extra && extra.reason ? extra.reason : null);
  }
}

/** Active blocks: a room's (with the global ones when `withGlobal`), or every one (roomId null). */
async function list(roomId = null, { withGlobal = true } = {}) {
  await init();
  const t = now();
  let rows;
  if (roomId == null) rows = await getQuery("SELECT * FROM bridge_blocks WHERE until IS NULL OR until > ? ORDER BY updated DESC LIMIT 500", [t]);
  else {
    rows = await getQuery(`SELECT * FROM bridge_blocks WHERE (room_id = ? ${withGlobal ? "OR room_id = ''" : ""}) AND (until IS NULL OR until > ?)
                           ORDER BY updated DESC LIMIT 300`, [String(roomId), t]);
  }
  return rows.map(rowOut);
}

/** Pepe's mirror: every active block + the account's CURRENT chat login (a relay job from an old site may carry only it).
 *  1.99zf: a feature-aware Pepe (blocks_cap >= 2) gets every row with its `feature`; an older one only the "all" rows (it would
 *  read a one-feature block as a block on everything). The version says which, so an upgraded Pepe re-reads. */
async function mirror(featureCap = false) {
  await init();
  const rows = await getQuery(`SELECT b.room_id, b.user_id, b.feature, b.username, b.until, b.reason, u.camfrogUsername AS login FROM bridge_blocks b
                               LEFT JOIN users u ON u.userId = b.user_id WHERE (b.until IS NULL OR b.until > ?) ${featureCap ? "" : "AND b.feature = 'all'"} LIMIT 5000`, [now()]);
  return { v: verFor(featureCap), rows: rows.map((r) => Object.assign({ room: r.room_id, user_id: r.user_id, username: r.username || null, login: r.login || null,
                                            until: r.until == null ? null : Number(r.until), reason: r.reason || "" }, featureCap ? { feature: r.feature || "all" } : {})) };
}
const verFor = (featureCap) => (featureCap ? ver + ":f" : ver);

/** The bridge sync response's extra field: the mirror when Pepe (relay_cap) has an older version than ours. */
async function forSync(body) {
  if (!body || !(body.relay_cap === 1 || body.relay_cap === true)) return {};
  const fc = Number(body.blocks_cap) >= 2;
  if (String(body.blocks_v || "") === verFor(fc)) return {};
  try { return { bridge_blocks: await mirror(fc) }; } catch (e) { console.error("[bridgeblocks] mirror:", e.message); return {}; }
}

/** Every block one account has (rooms + global), for /admin/users#bridgebans. */
async function forUser(userId) {
  await init();
  const rows = await getQuery("SELECT * FROM bridge_blocks WHERE user_id = ? AND (until IS NULL OR until > ?) ORDER BY room_id, feature", [String(userId), now()]);
  return rows.map(rowOut);
}

function parseHours(v) {
  if (v == null || v === "" || v === "perm") return { hours: 0 };
  const n = Number(v);
  if (n === 0) return { hours: 0 };
  return Number.isFinite(n) && n > 0 && n <= 24 * 365 ? { hours: n } : { error: "Pick a length (in hours), or until lifted." };
}

function register(app, { isBotToken, addUser, bySlug }) {
  init().catch((e) => console.error("[bridgeblocks] init:", e.message));
  const guard = require("./middleware/authGuard");
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  const fail = (res, e) => { console.error("[bridgeblocks]", e); bad(res, 500, "Something went wrong - nothing changed."); };

  // ── Pepe: !bridge block / unblock / blocks ──
  app.post("/api/bridge/blocks", express.json({ limit: "4kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    res.set("Cache-Control", "no-store");
    try {
      const op = String(b.op || "");
      const room = b.global ? "" : String(b.room || "").slice(0, 128);
      if (!b.global && !room) return bad(res, 400, "Which room?");
      if (op === "list") return res.json({ ok: true, blocks: await list(room || null, { withGlobal: true }), v: ver });
      if (op !== "block" && op !== "unblock") return bad(res, 400, "op must be block, unblock or list");
      const target = await resolveTarget(b.target);
      if (target.error) return bad(res, 404, target.error);
      const by = { userId: null, name: "chat:" + clean(b.by, 40), via: "chat" };
      try {
        const byAcc = (await getQuery("SELECT userId, username FROM users WHERE lower(camfrogUsername) = ? LIMIT 1", [clean(b.by, 40).toLowerCase()]))[0];
        if (byAcc) { by.userId = String(byAcc.userId); by.name = byAcc.username + " (chat " + clean(b.by, 40) + ")"; }
      } catch (e) { /* the label is enough */ }
      const feat = b.feature == null || b.feature === "" ? null : featureOf(b.feature);       // 1.99zf
      if (b.feature != null && b.feature !== "" && !feat) return bad(res, 400, "Pick one of: all, " + FEATURES.join(", ") + ".");
      if (op === "unblock") return res.json({ ok: true, target, ...(await unblock({ roomId: room, target, feature: feat, by, key: b.key })), v: ver });
      const u = untilFrom({ until: b.until, secs: b.secs }, now());
      if (u.error) return bad(res, 400, u.error);
      return res.json({ ok: true, target, ...(await block({ roomId: room, target, feature: feat || "all", until: u.until, reason: b.reason, by, key: b.key })), v: ver });
    } catch (e) { fail(res, e); }
  });

  // ── the pad's owner page ("Moderate your room") ──
  async function padCtx(req, res, write) {
    if (write && (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req))) { bad(res, 400, "Bad request."); return null; }
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) { bad(res, 404, "No such pad."); return null; }
    const rooms = require("./rooms");
    const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!me) { bad(res, 401, "Sign in first."); return null; }
    let ok = await rooms.canManage(me, R.id);
    if (!ok && me.camfrogUsername && bySlug) {
      // a mod of the room by Pepe's own roles (the caps his snapshot sent for this linked login) - kick powers or more
      try {
        const L = bySlug(req.params.slug);
        const caps = L && L.id === R.id ? require("./padmod").capsFor(L, me.camfrogUsername) : null;
        ok = !!(caps && Array.isArray(caps.actions) && caps.actions.includes("kick"));
      } catch (e) { ok = false; }
    }
    if (!ok) { bad(res, 403, "Only this room's mods, the pad's owner and admins can do that."); return null; }
    return { R, me };
  }
  app.get("/api/rooms/:slug/blocks", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const c = await padCtx(req, res, false); if (!c) return;
      res.json({ ok: true, blocks: await list(c.R.id, { withGlobal: true }) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/blocks", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const c = await padCtx(req, res, true); if (!c) return;
      const b = req.body || {};
      const target = await resolveTarget(b.target);
      if (target.error) return bad(res, 404, target.error);
      const by = { userId: String(c.me.userId), name: c.me.username, via: "web" };
      const feat = b.feature == null || b.feature === "" ? null : featureOf(b.feature);       // 1.99zf: one feature, or all
      if (b.feature != null && b.feature !== "" && !feat) return bad(res, 400, "That isn't a bridge feature.");
      if (b.op === "unblock") return res.json({ ok: true, target, ...(await unblock({ roomId: c.R.id, target, feature: feat, by })) });
      if (b.op !== "block") return bad(res, 400, "block or unblock");
      if (target.userId === String(c.me.userId)) return bad(res, 400, "That's you.");
      const h = parseHours(b.hours);
      if (h.error) return bad(res, 400, h.error);
      const u = untilFrom({ hours: h.hours }, now());
      res.json({ ok: true, target, ...(await block({ roomId: c.R.id, target, feature: feat || "all", until: u.until, reason: b.reason, by })) });
    } catch (e) { fail(res, e); }
  });

  // ── admins: every block, and global ones ──
  async function admin(req, res, write) {
    if (write && (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req))) { bad(res, 400, "Bad request."); return null; }
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const me = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!me || me.class !== "Admin") { bad(res, 403, "Admins only."); return null; }
    return me;
  }
  app.get("/api/admin/bridge/blocks", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!(await admin(req, res, false))) return;
      if (req.query.target != null) {        // 1.99zf: one account's restrictions (/admin/users#bridgebans)
        const target = await resolveTarget(req.query.target);
        if (target.error) return bad(res, 404, target.error);
        return res.json({ ok: true, target, features: ["all", ...FEATURES], blocks: await forUser(target.userId) });
      }
      res.json({ ok: true, blocks: await list(null), features: ["all", ...FEATURES] });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/bridge/blocks", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const me = await admin(req, res, true); if (!me) return;
      const b = req.body || {};
      const room = String(b.room || "").trim().slice(0, 128);
      const target = await resolveTarget(b.target);
      if (target.error) return bad(res, 404, target.error);
      const by = { userId: String(me.userId), name: me.username, via: "admin" };
      // 1.99zf: `features` = several at once (the per-account toggles); `feature` one; neither = "all" (unblock: every one)
      let feats = Array.isArray(b.features) ? b.features : b.feature != null && b.feature !== "" ? [b.feature] : null;
      if (feats) {
        feats = [...new Set(feats.map(featureOf))];
        if (!feats.length || feats.includes(null)) return bad(res, 400, "Pick one of: all, " + FEATURES.join(", ") + ".");
      }
      if (b.op === "unblock") {
        let removed = false;
        for (const f of feats || [null]) removed = (await unblock({ roomId: room, target, feature: f, by })).removed || removed;
        return res.json({ ok: true, target, removed, blocks: await forUser(target.userId) });
      }
      if (b.op !== "block") return bad(res, 400, "block or unblock");
      const h = parseHours(b.hours);
      if (h.error) return bad(res, 400, h.error);
      const until = untilFrom({ hours: h.hours }, now()).until;
      let last = null;
      for (const f of feats || ["all"]) last = await block({ roomId: room, target, feature: f, until, reason: b.reason, by });
      res.json({ ok: true, target, ...last, blocks: await forUser(target.userId) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, resolveTarget, active, refusal, refusalText, block, unblock, list, mirror, forSync, forUser, untilFrom, parseHours,
  FEATURES, featureOf,
  version: () => ver, _setClock: (f) => { clock = f; } };
