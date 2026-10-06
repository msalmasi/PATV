// padmod.js — the pad page's "Manage" panel (1.99co): Camfrog room moderation from the website GUI.
//
// Who sees it: only a signed-in account whose linked Camfrog login (users.camfrogUsername, set by !verify)
// holds mod powers in THAT room by Pepe's own roles. The site never decides that: it tells Pepe which
// linked logins are watching each pad (`viewers` in the /api/bridge/sync response), and Pepe's room
// snapshot answers with `mod` = {login: caps} for the ones with powers (camfrog-bot pepe_relaycmd.py
// _relaycmd_caps - the same check his command handlers make). Site roles and pad ownership grant
// nothing here. Everyone else gets `mod: null` and the page shows nothing new.
//
// How a click runs: the browser sends a STRUCTURED action {action, target, args}; this file turns it into
// the one command line that action means (buildModLine - fixed command per action, a checked login, numbers
// clamped, free text cleaned and stripped of the trailing "-flags" Pepe's dispatcher would act on) and
// queues it as an ordinary relay "cmd" job (bridge-relay.js) tagged `gui: <action>`. Pepe runs it through
// his real dispatcher as that login - permissions, PAT prices, automod power-abuse strikes, rate limits,
// the room echo "🌐 <name> (web): !kick bob", mod log "(from the website ...; reason: ...)" - and re-checks
// that the line is that action's command and that the person holds its powers BEFORE anything is echoed.
// Raw command text is never accepted on this path. The moderator's reason rides as `reason` (mod log
// only; !fine also takes it in the line, as in chat). Pepe's reply (public or private) comes back in the
// ack and the panel shows it.
//
// Room settings (chatty on/off, chatty depth, greeter on/off): Pepe admins only (caps.admin), behind a
// password step-up every time (like the control panel), exact command lines only, and logged
// (bridge_cmd_log + Pepe's web_cmd mod-log entry). Pepe keeps these commands deny-listed for the relay box.
//
// Mod history / banned list: a read-only "modinfo" job Pepe answers from this room's mod log (mods only).
"use strict";
const express = require("express");
const bcrypt = require("bcrypt");
const { getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");
const relay = require("./bridge-relay");

// action -> the command it runs. Pepe has the same table (MOD_ACTIONS / GUI_ACTIONS).
const ACTIONS = {
  topic: "!topic", kick: "!kick", ban: "!ban", unban: "!unban", punish: "!punish", unpunish: "!unpunish",
  blockmic: "!blockmic", unblockmic: "!unblockmic", timeout: "!timeout", strike: "!strike", strike_appeal: "!strike",
  fine: "!fine", casinoban: "!casinoban", casinounban: "!casinounban", djban: "!djban", djunban: "!djunban",
};
const SETTINGS = {
  chatty: { on: "!chatty on", off: "!chatty off" },
  chattydepth: { off: "!chattydepth off", short: "!chattydepth short", normal: "!chattydepth normal", long: "!chattydepth long" },
  greeter: { on: "!greeter on", off: "!greeter off" },
};
const TOPIC_MAX = 200;              // what Pepe sends with /topic (handle_pepe_topic caps it at 200)
const REASON_MAX = 120;
const FINE_MAX = 1e9;
const TIMEOUT_MAX_H = 720;          // = Pepe's !timeout clamp
const VIEWER_TTL = 2 * 60 * 1000;   // a pad viewer counts this long after their last poll
const VIEWERS_PER_ROOM = 60;
const LINK_TTL = 60 * 1000;
const TARGET_RE = /^[A-Za-z0-9_.][\w.\-]{0,39}$/;   // a Camfrog login; never starts with "-" (a flag) or "!" / "/"
const FLAG_ARG = /^(-v|--v|--voice)$/i;

/** Free text for a command line: one line, no markup / control chars, no leading "/" or "!", capped,
 *  and no trailing "-flag" tokens (Pepe's dispatcher lifts those off the END of a line: -p, -all,
 *  -global, -mic, "-v <voice>" ...). */
function freeText(s, max) {
  let t = relay.clean(s, 400).replace(/^[\s/!]+/, "").slice(0, max).trim();
  let w = t ? t.split(" ") : [];
  for (;;) {
    if (w.length && w[w.length - 1].startsWith("-")) { w.pop(); continue; }
    if (w.length >= 2 && FLAG_ARG.test(w[w.length - 2])) { w.splice(-2, 2); continue; }
    break;
  }
  return w.join(" ").trim();
}

function cleanLogin(s) {
  const t = String(s == null ? "" : s).trim().replace(/^@/, "");
  return TARGET_RE.test(t) ? t : "";
}

function intIn(v, lo, hi) {
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v == null ? "" : v)) ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && Math.floor(n) === n && n >= lo && n <= hi ? n : null;
}

/** {action, target, args} -> {line} (the exact command) or {error}. The only way a panel click becomes text. */
function buildModLine(action, target, args) {
  const a = typeof action === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, action) ? action : null;
  if (!a) return { error: "Unknown action." };
  const x = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  if (a === "topic") {
    const t = freeText(x.text, TOPIC_MAX);
    return t ? { line: "!topic " + t } : { error: "Type a topic first." };
  }
  const who = cleanLogin(target);
  if (!who) return { error: "Pick someone from the room." };
  if (a === "timeout") {
    const h = intIn(x.hours, 1, TIMEOUT_MAX_H);
    return h ? { line: `!timeout ${who} ${h}` } : { error: "Pick a time-out of 1 to 720 hours." };
  }
  if (a === "strike_appeal") return { line: `!strike appeal ${who}` };
  if (a === "fine") {
    const n = intIn(x.amount, 1, FINE_MAX);
    if (!n) return { error: "Fine a whole number of PAT, 1 or more." };
    const why = freeText(x.reason, REASON_MAX);
    return { line: `!fine ${who} ${n}` + (why ? " " + why : "") };
  }
  return { line: `${ACTIONS[a]} ${who}` };
}

// ── Pepe's caps for each pad viewer (from his room snapshot) ──
const ROLE_RE = /^[a-z]{1,12}$/;
function cleanCaps(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const actions = (Array.isArray(c.actions) ? c.actions : []).filter((a) => a !== "topic" && Object.prototype.hasOwnProperty.call(ACTIONS, a));
  if (!actions.length) return null;
  const out = { actions: [...new Set(actions)], on: c.on !== false, roles: (Array.isArray(c.roles) ? c.roles : []).filter((r) => typeof r === "string" && ROLE_RE.test(r)).slice(0, 4) };
  if (c.topic_price != null && Number.isFinite(Number(c.topic_price))) out.topicPrice = Math.max(0, Math.min(1e9, Math.floor(Number(c.topic_price))));
  if (c.blocked) out.blocked = relay.clean(c.blocked, 120);
  if (c.admin === true) {
    out.admin = true;
    const s = c.settings && typeof c.settings === "object" ? c.settings : {};
    out.settings = {};
    if (typeof s.chatty === "boolean") out.settings.chatty = s.chatty;
    if (typeof s.greeter === "boolean") out.settings.greeter = s.greeter;
    if (typeof s.chattydepth === "string" && SETTINGS.chattydepth[s.chattydepth]) out.settings.chattydepth = s.chattydepth;
  }
  return out;
}
/** The snapshot's `mod` field -> {loginLower: caps} (malformed entries dropped). */
function cleanModCaps(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    const login = cleanLogin(k).toLowerCase();
    const c = login && cleanCaps(v);
    if (c) out[login] = c;
    if (++n >= 100) break;
  }
  return out;
}
const capsFor = (R, login) => (R && R.mod && login ? R.mod[String(login).toLowerCase()] || null : null);

// ── who's watching which pad (linked logins), for Pepe ──
const viewers = new Map();           // roomId -> Map(loginLower -> last poll)
function noteViewer(roomId, login) {
  const l = cleanLogin(login).toLowerCase();
  if (!roomId || !l) return;
  let m = viewers.get(roomId);
  if (!m) { m = new Map(); viewers.set(roomId, m); }
  m.set(l, Date.now());
}
/** {roomId: [logins]} for the sync response (live rooms only, recent viewers). */
function viewersFor(liveIds) {
  const out = {}, now = Date.now();
  for (const [rid, m] of viewers) {
    for (const [l, t] of m) if (now - t > VIEWER_TTL) m.delete(l);
    if (!m.size) { viewers.delete(rid); continue; }
    if (liveIds && !liveIds.has(rid)) continue;
    out[rid] = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, VIEWERS_PER_ROOM).map((e) => e[0]);
  }
  return out;
}

// users.camfrogUsername per account (cached briefly: the pad polls every 1.5 s)
const linkCache = new Map();
async function linkedLogin(userId) {
  if (!userId) return null;
  const c = linkCache.get(userId);
  if (c && Date.now() - c.at < LINK_TTL) return c.login;
  let login = null;
  try { login = ((await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [userId]))[0] || {}).camfrogUsername || null; } catch (e) { login = null; }
  linkCache.set(userId, { login, at: Date.now() });
  if (linkCache.size > 5000) linkCache.delete(linkCache.keys().next().value);
  return login;
}

/** What the live view tells THIS viewer about the panel (null = nothing; the page shows nothing new). */
function viewMod(R, login) {
  const c = capsFor(R, login);
  if (!c) return null;
  return Object.assign({}, c, { login: String(login).toLowerCase() });
}

// ── Pepe's modinfo answer -> safe JSON for the browser ──
const TYPE_RE = /^[a-z_]{1,24}$/;
function cleanInfo(info) {
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const ts = (v) => String(v == null ? "" : v).replace(/[^0-9T:\- ]/g, "").slice(0, 19);
  const out = { days: intIn(info.days, 1, 365) || 30 };
  if (Array.isArray(info.list)) {
    out.list = info.list.slice(0, 100).map((r) => r && typeof r === "object" ? {
      login: cleanLogin(r.login), state: ["banned", "punished", "mic-blocked"].includes(r.state) ? r.state : null, ts: ts(r.ts), by: relay.clean(r.by, 40),
    } : null).filter((r) => r && r.login && r.state);
  }
  if (info.target) {
    out.target = cleanLogin(info.target);
    out.role = typeof info.role === "string" && ROLE_RE.test(info.role) ? info.role : "everyone";
    for (const k of ["redlist", "owner", "djbanned", "timeout"]) if (typeof info[k] === "boolean") out[k] = info[k];
    if (info.strikes != null) out.strikes = intIn(info.strikes, 0, 1000) || 0;
    if (info.muted_until) out.mutedUntil = ts(info.muted_until);
    out.history = (Array.isArray(info.history) ? info.history : []).slice(0, 20).map((h) => h && typeof h === "object" ? {
      ts: ts(h.ts), type: TYPE_RE.test(String(h.type || "")) ? h.type : "event", actor: relay.clean(h.actor, 40), details: relay.cleanReply(h.details).slice(0, 160),
    } : null).filter(Boolean);
  }
  return out;
}

// ── routes ──
const pwFails = guard.limiter({ max: 5, windowMs: 15 * 60 * 1000 });
const MOD_GAP = 2000, MOD_BURST = 10, MOD_WINDOW = 10 * 60 * 1000;      // = Pepe's moderation limit (10 per 10 min)

function register(app, { addUser, bySlug, isLive }) {
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  // JSON + X-Requested-With + same site + signed in + linked + a live room + Pepe's caps for this login
  async function ctx(req, res, { needOn = true } = {}) {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { bad(res, 400, "Bad request."); return null; }
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const u = (await getQuery("SELECT userId, username, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!u) { bad(res, 401, "Sign in first."); return null; }
    if (!u.camfrogUsername) { bad(res, 403, "Link your Camfrog name first: type !verify in a Camfrog room with Pepe."); return null; }
    const R = bySlug(req.params.slug);
    if (!R || !isLive(R)) { bad(res, 404, "That Camfrog room isn't live right now."); return null; }
    const caps = capsFor(R, u.camfrogUsername);
    if (!caps) { bad(res, 403, "You don't have moderator powers in this room."); return null; }
    if (needOn && !caps.on) { bad(res, 403, "Web moderation is off in this room."); return null; }
    return { u, R, caps };
  }

  app.post("/api/rooms/:slug/mod", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    const c = await ctx(req, res);
    if (!c) return;
    const { u, R, caps } = c;
    const b = req.body || {};
    const action = String(b.action || "");
    const allowed = action === "topic" ? caps.topicPrice != null : caps.actions.includes(action);
    if (!allowed) return bad(res, 403, "You can't do that in this room.");
    const built = buildModLine(action, b.target, b.args);
    if (built.error) return bad(res, 400, built.error);
    if (action !== "topic" && cleanLogin(b.target).toLowerCase() === String(u.camfrogUsername).toLowerCase()) return bad(res, 400, "That's you.");
    const lim = relay.limited("cmd|" + u.userId, relay.CMD_GAP, relay.CMD_BURST, relay.CMD_WINDOW)
      || (action !== "topic" ? relay.limited("mod|" + u.userId, MOD_GAP, MOD_BURST, MOD_WINDOW) : null);
    if (lim) return bad(res, 429, lim);
    const reason = action === "topic" ? "" : freeText((b.args || {}).reason, REASON_MAX);
    const j = relay.newJob({ kind: "cmd", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername,
      text: built.line, gui: action, reason });
    console.log(`[padmod] room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} action=${action} job=${j.id}`);
    relay.cmdLog({ userId: u.userId, username: u.username, camfrog: u.camfrogUsername, room: R.id,
      command: built.line + " [panel" + (reason ? ", reason: " + reason : "") + "]", job: j.id, status: "pending", result: "" });
    res.json({ ok: true, id: j.id, line: built.line });
  });

  // a user's roles + this room's mod history (target), or the banned / punished list (no target)
  app.post("/api/rooms/:slug/mod/info", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    const c = await ctx(req, res, { needOn: false });
    if (!c) return;
    const { u, R } = c;
    const raw = (req.body || {}).target;
    const target = raw ? cleanLogin(raw) : "";
    if (raw && !target) return bad(res, 400, "No such user.");
    const lim = relay.limited("modinfo|" + u.userId, 500, 20, 60 * 1000);
    if (lim) return bad(res, 429, lim);
    const j = relay.newJob({ kind: "modinfo", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, target });
    res.json({ ok: true, id: j.id });
  });

  // room settings: Pepe admins only, password step-up every time, exact lines
  app.post("/api/rooms/:slug/mod/setting", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    const c = await ctx(req, res);
    if (!c) return;
    const { u, R, caps } = c;
    if (!caps.admin) return bad(res, 403, "Room settings are for Pepe admins.");
    const b = req.body || {};
    const key = String(b.key || ""), value = String(b.value || "");
    const line = Object.prototype.hasOwnProperty.call(SETTINGS, key) && Object.prototype.hasOwnProperty.call(SETTINGS[key], value) ? SETTINGS[key][value] : null;
    if (!line) return bad(res, 400, "Unknown setting.");
    const who = String(u.userId);
    const wait = pwFails.blocked(who);
    const audit = (status, result) => relay.cmdLog({ userId: u.userId, username: u.username, camfrog: u.camfrogUsername, room: R.id,
      command: line + " [panel setting]", job: null, status, result });
    if (wait) { audit("denied", "locked out after wrong passwords"); return bad(res, 429, "Too many wrong passwords. Try again in " + guard.waitText(wait) + "."); }
    const row = (await getQuery("SELECT password FROM users WHERE userId = ?", [u.userId]))[0];
    const hash = row && typeof row.password === "string" && row.password.startsWith("$2") ? row.password : null;
    if (!hash) { audit("denied", "no password on the account"); return bad(res, 403, "Your account has no password to confirm with - set one (forgot password) first."); }
    const pw = b.password;
    if (typeof pw !== "string" || !pw || Buffer.byteLength(pw, "utf8") > 200 || !(await bcrypt.compare(pw, hash))) {
      pwFails.hit(who);
      audit("denied", "wrong password");
      return bad(res, 403, "Wrong password.");
    }
    pwFails.reset(who);
    const lim = relay.limited("modset|" + u.userId, 3000, 10, 10 * 60 * 1000);
    if (lim) return bad(res, 429, lim);
    const j = relay.newJob({ kind: "cmd", roomId: R.id, userId: u.userId, username: u.username, camfrog: u.camfrogUsername, text: line, setting: key });
    console.log(`[padmod] SETTING room=${R.id} account=${u.username} camfrog=${u.camfrogUsername} line=${JSON.stringify(line)} job=${j.id}`);
    relay.cmdLog({ userId: u.userId, username: u.username, camfrog: u.camfrogUsername, room: R.id,
      command: line + " [panel setting]", job: j.id, status: "pending", result: "" });
    res.json({ ok: true, id: j.id, line });
  });

  // one of MY panel jobs: state + Pepe's answer
  app.get("/api/rooms/:slug/mod/job/:id", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
    const j = relay._jobs.get(String(req.params.id || ""));
    if (!j || j.userId !== req.user.userId || !(j.gui || j.setting || j.kind === "modinfo")) return bad(res, 404, "No such request (they expire after a few minutes).");
    const r = j.result || {};
    res.json({ ok: true, state: j.state === "done" ? "done" : j.state === "claimed" ? "running" : "pending", done: j.state === "done",
      success: j.state === "done" ? !!r.ok : null, msg: r.msg || "", replies: r.replies || [], info: r.info || null, line: j.kind === "cmd" ? j.text : null });
  });
}

module.exports = { register, buildModLine, freeText, cleanModCaps, cleanCaps, cleanInfo, capsFor, viewMod, noteViewer, viewersFor, linkedLogin,
  ACTIONS, SETTINGS, TOPIC_MAX, REASON_MAX, _viewers: viewers, _linkCache: linkCache, _pwFails: pwFails };
