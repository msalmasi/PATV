// camreveal.js — 1.99?? (privacy controls S4): the CAM REVEAL (G:/ops/privacy-controls-spec-2026-11-02.md section 3.2 "The new CAM
// REVEAL", section 5 "S4", and the owner's answers, section 8 - they override 3.2's defaults: Q8 + Q9 who, Q10 + Q11 the notice,
// Q12 evidence, Q13 the pad's own switches, Q15 3 minutes + "Extend", Q22 the by-login entry).
//
// What it is: a moderator checks a cam the person has hidden from the website (the owner's example: someone nude on cam in a Camfrog
// room with live cam off - "an admin can't check to verify without logging into camfrog"). The cam is opened for the moderators who
// asked and nobody else (livecam.js reveal sessions: their own key, a random WHEP path, 3 minutes each, never a ▶ Live slot, never a
// stage / mic-stage / warm-keep / capture relay), never recorded except as evidence below, and every view is logged.
//
// WHO (Q8, re-checked on every beat and in MediaMTX's read hook - livecam.revealAuth -> stillMay):
//   admin  chatlog.see_through (Admin) - every pad
//   staff  livecam.reveal (Staff, locked "privacy" - siteperms-core.js) - every pad
//   owner  the pad's registered owner NOW (rooms registry) - their own pad
//   mod    the room's moderators: Pepe's mod caps for the viewer's linked Camfrog login in that room (padmod.capsFor - the same
//          check the pad's Manage panel and livecam.mayEnd use) - their own room
// The by-login entry (/admin/pepe/livecams, Q22: someone left out or not listed) is admin / staff only, and the page itself needs
// livecam.admin. Saving evidence stills / clips (Q12): admins and the pad's owner only (camevidence.js).
//
// WHICH CAM (resolved here, server-side - never a login from the browser for a veiled person):
//   {tile}    a mic-stage cover (micfollow.coverWho)          {member}  a people-list frog entry by its opaque id (veil.opaqueId)
//   {login}   a NAMED person the page shows by login (the ▶ Live popover of someone with live cam off, private activity, ...)
//   {login} + the admin entry: any login in that room - also someone LEFT OUT (forget-me, an account deletion, a staff removal: Q22,
//             cam only - their name and lines stay unrevealable everywhere else)
// It must be WITHHELD from this moderator now - live cam off, !bridge hide, incognito while incognito cams aren't in effect, private
// activity, their blocks, their who-may-watch mode, left out - otherwise 409 "visible" (use ▶ Live). What it got past is the
// bypass label ("reveal:<livecam_off | hidden | incognito | private | blocked | <mode> | left_out | not_listed>").
//
// LOGGED, in ONE dbUtils.tx BEFORE any ticket (a failed write refuses it): seethrough_log (scope cam_reveal: the login, the role,
// the reason, ref "cam:<sid>[:x extend][:g ghost][:l by login]"), livecam_audit (ghost, bypass, veil = the frog name or "veiled" for a
// veiled person - admin views show that, never the login), cam_views (kind "reveal", same veil) and admin_audit
// (seethrough.cam_reveal). "Extend (logged)" writes all four again. A reason of at least 3 characters is required.
//
// TOLD (Q10 / Q11): at the first frame, unless the moderator is in 👻 ghost mode (re-checked on every beat): Pepe's PM (camviewers
// noteReveal -> his notice_text) and an inbox notice (kind "privacy", Telegram default-on) to every PATV account linked to the login -
// "Someone moderating <pad> viewed your cam" - NEVER who. !whowatching / the privacy card list "someone moderating <pad>".
//
// LIMITS: one open reveal per moderator, at least 10 s between reveals, at most 6 per 10 minutes (evidence.js's numbers); one reveal
// session per person (a second moderator joins it with their own rows and their own notice); the live-cam caps (budget, max_live).
// The pad's own switches stand (Q13): no reveal where the bridge, its cams or its live cams are off.
//
// THE SWITCH (dark): chatlog_meta 'cam_reveal' {on, at, by, first_on} - /admin/bridge#camreveal (chatlog.admin), audited (admin_audit
// camreveal.switch + a room_events row). ON needs privacy wire v2 (frog names and opaque ids exist only there). While it's on the sync
// answer says `camreveal: 1` (advert()); Pepe opens reveal wants (exact, quiet, past the opt-out, the window closed after) and sends a
// veiled member's on_cam only after that, and says `camreveal: 1` on his own sync while he does (noteBot). effective() = the advert AND
// Pepe's word within BOT_FRESH_MS. Off, or an older Pepe: every route here answers 404 and nothing on any page changes. Turning it OFF
// ends every reveal at once.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");

const BOT_FRESH_MS = 2 * 60 * 1000;          // Pepe's word (his sync's camreveal: 1) counts this long - he syncs every few seconds
const ROLE_MS = 30 * 1000;                   // the live view's role cache (every action asks fresh)
const REASON_MIN = 3, REASON_MAX = 200;
const REQ_GAP = 10e3, REQ_BURST = 6, REQ_WINDOW = 10 * 60e3;          // = evidence.js: a reveal per 10 s, 6 per 10 minutes, per moderator
const EXT_GAP = 5e3, EXT_BURST = 10, EXT_WINDOW = 60 * 60e3;          // "Extend": 10 an hour
const ID_RE = /^v-[A-Za-z0-9_-]{12}$/;
const TILE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const SID_RE = /^[0-9a-f]{12}$/;
const ROLES = new Set(["admin", "staff", "owner", "mod"]);
const SITE_WIDE = new Set(["admin", "staff"]);
const SAVERS = new Set(["admin", "owner"]);   // Q12
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

let clock = () => Date.now();
const now = () => clock();
let STATE = { on: false, at: null, by: null, first_on: null };
let ready = null, loaded = false;
let BOT_AT = 0;
const ROLE_CACHE = new Map();                // "userId|room" -> {role, at}

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; this.code = code; } }
const MSG = {
  off: "Viewing hidden cams isn't switched on.",
  forbidden: "Only PATV admins and staff, a pad's owner and the room's moderators can view a hidden cam for moderation.",
  forbidden_login: "Only PATV admins and staff can open a cam by its Camfrog login.",
  why: "Say why (at least 3 characters) - it's logged.",
  gone: "They aren't here any more.",
  not_on_cam: "They aren't on cam.",
  visible: "Their cam isn't hidden from you - use ▶ Live.",
  self: "That's your own cam.",
  pad_access: "This pad's live room is for its approved members.",
  offline: "That Camfrog room isn't live right now.",
  room_off: "Live cams aren't on in this Camfrog room.",
  ended: "That moderation view already ended.",
  held: "Their cam can't be viewed right now.",          // 1.99?? (review fixes 2 - RV-B)
};

// ── the switch ──
function cleanState(o) {
  const v = o && typeof o === "object" ? o : {};
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
  return { on: v.on === true, at: n(v.at), by: typeof v.by === "string" ? v.by.slice(0, 60) : null, first_on: n(v.first_on) };
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'cam_reveal'"))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** The switch itself (false until loaded: fails closed). */
const isOn = () => loaded && STATE.on === true;
/** Has it ever been on? (the inbox lists its "privacy" category from then on) */
const everOn = () => loaded && STATE.first_on != null;
const pwOn = () => { try { return require("./privwire").isOn() === true; } catch (e) { return false; } };
/** Does the sync answer say camreveal: 1? The switch AND privacy wire v2. */
const advert = () => isOn() && pwOn();
/** Pepe's sync body (v1 or v2): camreveal: 1 = he opens reveal wants and sends veiled on_cam now. Anything else: he doesn't. */
function noteBot(body, t = now()) { BOT_AT = body && typeof body === "object" && body.camreveal === 1 ? t : 0; }
const botOn = (t = now()) => BOT_AT > 0 && t - BOT_AT <= BOT_FRESH_MS;
/** May a cam be revealed now? The advert AND Pepe's word. Synchronous; fails closed. */
const effective = (t = now()) => advert() && botOn(t);
function state() { return { ...STATE, loaded, advert: advert(), pepe: botOn(), effective: effective(), privwire: pwOn() }; }
async function setOn(want, user) {
  await init();
  const on = want === true;
  if (on && !pwOn()) throw new Refuse(409, "Turn privacy wire v2 on first - frog names exist only on it.", "privwire_off");
  if (STATE.on === on) return { ...state(), unchanged: true };
  const t = now();
  const next = cleanState({ on, at: t, by: user && user.username ? user.username : null, first_on: STATE.first_on || (on ? t : null) });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('cam_reveal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  try { await require("./adminaudit").record(user || { userId: "system" }, "camreveal.switch", null, { on }); } catch (e) { console.error("[camreveal] audit:", e.message); }
  try { await require("./rooms").event(null, "camreveal.switch", user && user.username ? user.username : null, `cam reveals ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  if (!on) { try { require("./livecam").revealSwitchOff(); } catch (e) { /* no live cams */ } }
  console.log(`[camreveal] cam reveals switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})`);
  return state();
}

// ── who may (Q8) ──
async function userRow(userId) {
  return (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0] || null;
}
/** The moderator role of `user` ({userId} or an id) in bridge room R: "admin" | "staff" | "owner" | "mod" | null. Fresh; fails closed. */
async function roleOf(user, R) {
  const uid = user && typeof user === "object" ? user.userId : user;
  if (uid == null || !R || !R.id) return null;
  let u = null;
  try { u = await userRow(uid); } catch (e) { return null; }
  if (!u) return null;
  const SP = require("./siteperms");
  try { if (SP.can(u, "chatlog.see_through")) return "admin"; if (SP.can(u, "livecam.reveal")) return "staff"; } catch (e) { return null; }
  try {
    const RS = require("./rooms");
    const pad = (RS.getCached && RS.getCached(String(R.id))) || (RS.get ? await RS.get(String(R.id)) : null);
    if (pad && pad.owner && pad.owner.userId != null && String(pad.owner.userId) === String(u.userId)) return "owner";
  } catch (e) { /* not the owner */ }
  try { if (u.camfrogUsername && require("./padmod").capsFor(R, u.camfrogUsername)) return "mod"; } catch (e) { /* no caps */ }
  return null;
}
/** roleOf, cached ROLE_MS - for drawing the page (the cv / reveal flags). Every reveal, beat and read asks fresh. */
async function roleCached(userId, R, t = now()) {
  if (userId == null || !R || !R.id) return null;
  const k = String(userId) + "|" + String(R.id), c = ROLE_CACHE.get(k);
  if (c && t - c.at < ROLE_MS) return c.role;
  const role = await roleOf(userId, R);
  ROLE_CACHE.set(k, { role, at: t });
  if (ROLE_CACHE.size > 5000) ROLE_CACHE.delete(ROLE_CACHE.keys().next().value);
  return role;
}
/** livecam.revealAuth (MediaMTX's read hook): may this moderator still read reveal session S? */
async function stillMay(userId, S) {
  if (!S || !S.rv || S.ended || !effective()) return false;
  let R = null;
  try { R = require("./bridge")._rooms.get(String(S.roomId)); } catch (e) { R = null; }
  const role = R ? await roleOf(userId, R) : null;
  return !!role && (!S.rv.bylogin || SITE_WIDE.has(role));
}

// ── which cam (server-side) ──
const veilstage = () => require("./veilstage");
function leftOut(login) { try { return veilstage().leftOut(low(login)) === true; } catch (e) { return true; } }
const onCamOf = (v) => (v === true ? true : v === false ? false : null);
function namedEntry(R, l) { return (R.members || []).find((e) => e && !e.anon && !e.self && low(e.login) === l) || null; }
function veiledEntry(R, l) { return (R.members || []).find((e) => e && e.anon && e._vz && low(e._vz.login) === l) || null; }
/** The person a request names in R -> {login, kind: named | incognito | hidden | absent, alias, onCam: true | false | null, via} | null. */
function subjectOf(R, b, byLogin = false) {
  if (!R || !b || typeof b !== "object") return null;
  if (!byLogin && b.tile != null) {
    const tile = String(b.tile).slice(0, 40);
    if (!TILE_RE.test(tile)) return null;
    let who = null;
    try { who = require("./micfollow").coverWho(R.id, tile); } catch (e) { who = null; }
    const l = who ? low(who.login) : "";
    if (!LOGIN_RE.test(l)) return null;
    const e = veiledEntry(R, l);
    return { login: l, kind: e && e._vz.kind === "incognito" ? "incognito" : "hidden", alias: e && e.alias ? String(e.alias) : null,
             onCam: e ? onCamOf(e._vz.on_cam) : null, via: "tile" };
  }
  if (!byLogin && b.member != null) {
    const id = String(b.member).slice(0, 20);
    if (!ID_RE.test(id)) return null;
    const e = (R.members || []).find((x) => x && x.anon && x.id === id && x._vz);
    const l = e ? low(e._vz.login) : "";
    if (!LOGIN_RE.test(l)) return null;
    return { login: l, kind: e._vz.kind === "incognito" ? "incognito" : "hidden", alias: e.alias ? String(e.alias) : null,
             onCam: onCamOf(e._vz.on_cam), via: "member" };
  }
  const l = low(b.login);
  if (!LOGIN_RE.test(l)) return null;
  const n = namedEntry(R, l);
  if (!byLogin) return n ? { login: l, kind: "named", alias: null, onCam: onCamOf(n.on_cam), via: "login" } : null;
  if (n) return { login: l, kind: "named", alias: null, onCam: onCamOf(n.on_cam), via: "by_login" };
  const v = veiledEntry(R, l);
  if (v) return { login: l, kind: v._vz.kind === "incognito" ? "incognito" : "hidden", alias: v.alias ? String(v.alias) : null, onCam: onCamOf(v._vz.on_cam), via: "by_login" };
  return { login: l, kind: "absent", alias: null, onCam: null, via: "by_login" };          // (Pepe's own roster decides: not_on_cam)
}
/** The person's kind in R now (a beat's re-check). */
function kindNow(R, l) {
  if (namedEntry(R, l)) return "named";
  const v = veiledEntry(R, l);
  return v ? (v._vz.kind === "incognito" ? "incognito" : "hidden") : "absent";
}
/** Why the cam of subject `sub` is withheld from viewer `uid` now (the bypass label) - null: it isn't (they can use ▶ Live). */
async function withheldWhy(R, sub, uid) {
  const l = sub.login;
  if (leftOut(l)) return "left_out";
  let Q = null;
  try { Q = require("./quotes"); } catch (e) { Q = null; }
  if (sub.kind === "hidden" || (Q && Q.isBridgeOff && Q.isBridgeOff(l))) return "hidden";
  const LC = require("./livecam");
  if (LC.optedOut(l)) return "livecam_off";
  let icEff = false;
  try { icEff = require("./incogcams").effective() === true; } catch (e) { icEff = false; }
  if ((sub.kind === "incognito" || (Q && Q.isIncognito && Q.isIncognito(l))) && !icEff) return "incognito";
  try { if ((await require("./stories").privateLogins([l])).has(l)) return "private"; } catch (e) { /* none */ }
  try { await require("./camviewers").init(); if (require("./camviewers").blocked(l, uid)) return "blocked"; } catch (e) { /* none */ }
  try { const g = await require("./camaccess").gate(l, uid); if (g) return String(g.code || "access").slice(0, 20); } catch (e) { /* none */ }
  if (sub.kind === "named" && icEff) { try { if (require("./incogcams").veiledPresence(R, l)) return "veiled_hold"; } catch (e) { /* none */ } }
  if (sub.kind === "absent") return "not_listed";
  return null;
}
const isGhost = (uid) => { try { return require("./ghost").isGhost(uid) === true; } catch (e) { return false; } };
function padName(roomId) {
  let pad = "";
  try { const r = require("./rooms").getCached(String(roomId)); pad = (r && (r.title || r.name)) || ""; } catch (e) { pad = ""; }
  if (!pad) { try { const R = require("./bridge")._rooms.get(String(roomId)); pad = (R && R.name) || ""; } catch (e) { pad = ""; } }
  pad = clean(pad, 40).replace(/[<>]/g, "");
  return pad || "this pad";
}
const evidenceOn = () => { try { return require("./camevidence").on() === true; } catch (e) { return false; } };

// ── the rows (one transaction) ──
async function writeRows({ u, R, sub, role, reason, why, sid, ghost, label, veiled, byLogin, what, told = false }) {
  const ST = require("./seethrough"), AA = require("./adminaudit");
  await ST.init(); await AA.init(); await require("./camviewers").init(); await require("./livecam").init();
  const t = now(), uid = String(u.userId);
  return tx(async () => {
    const st = await ST.log({ userId: uid, role, scope: "cam_reveal", roomId: R.id, logins: [sub.login], reason,
                              ref: "cam:" + sid + (what === "extend" ? ":x" : "") + (ghost ? ":g" : "") + (byLogin ? ":l" : "") });
    if (!st) throw new Error("camreveal: no see-through row");                 // never a reveal without its row
    const a = await runQuery("INSERT INTO livecam_audit (room_id, target, viewer_id, viewer_name, started, ghost, bypass, veil) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                             [String(R.id), sub.login, uid, u.username || null, t, ghost ? 1 : 0, "reveal:" + why, veiled ? label : null]);
    const auditId = a && a.id ? Number(a.id) : null;
    if (!auditId) throw new Error("camreveal: no livecam_audit row");
    // (review RV-3: the row names its session and starts untold - camviewers.markRevealTold flips it at the first frame (notify), so a
    // failed open is never listed to the person; an Extend of a view they were already told about is told at once)
    await runQuery("INSERT INTO cam_views (owner, room_id, user_id, username, kind, at, ghost, bypass, veil, rv, told) VALUES (?, ?, ?, ?, 'reveal', ?, ?, ?, ?, ?, ?)",
                   [sub.login, String(R.id), uid, u.username || null, t, ghost ? 1 : 0, "reveal:" + why, veiled ? label : null, String(sid), told ? 1 : 0]);
    await AA.record({ userId: uid, username: u.username || null }, "seethrough.cam_reveal", null,
                    { room: String(R.id), sid, role, why, ghost: !!ghost, by_login: !!byLogin, what, st }, reason || null);
    return { auditId, st };
  });
}

/**
 * Open (or join) a reveal. u = the users row ({userId, username, camfrogUsername}); b = {tile | member | login, reason};
 * byLogin = the admin page's entry. -> the reveal player's start {ok, rv, whep, state, until, expires, name, veiled, can_save, role}
 */
async function start(u, R, b, { byLogin = false } = {}) {
  await init();
  if (!effective()) throw new Refuse(404, MSG.off, "off");
  if (!R) throw new Refuse(404, MSG.offline, "offline");
  if (!R.cams || R.livecams === false) throw new Refuse(403, MSG.room_off, "room_off");
  // the role FIRST - a caller without one learns nothing about any tile, entry or login (the same 403 for all)
  const role = await roleOf(u, R);
  if (!role || !ROLES.has(role)) throw new Refuse(403, MSG.forbidden, "forbidden");
  if (byLogin && !SITE_WIDE.has(role)) throw new Refuse(403, MSG.forbidden_login, "forbidden");
  const reason = clean(b && b.reason, REASON_MAX);
  if (reason.length < REASON_MIN) throw new Refuse(400, MSG.why, "why");
  if (!(await require("./bridge-relay").padFull(u.userId, R.id))) throw new Refuse(403, MSG.pad_access, "pad_access");
  const sub = subjectOf(R, b, byLogin);
  if (!sub) throw new Refuse(404, MSG.gone, "gone");
  if (!byLogin && leftOut(sub.login)) throw new Refuse(404, MSG.gone, "gone");     // (XT-1: never through a tile / an entry)
  if (low(u.camfrogUsername) === sub.login) throw new Refuse(409, MSG.self, "self");
  if (sub.onCam === false) throw new Refuse(400, MSG.not_on_cam, "not_on_cam");
  const why = await withheldWhy(R, sub, u.userId);
  if (!why) throw new Refuse(409, MSG.visible, "visible");
  // 1.99?? (privacy controls, review fixes 2 - RV-B): a NAMED person whose mic hold still shows a frog name (veiled_hold) - their face
  // next to their login pairs the two, which S5 refuses to everyone (ghosts too). Only a role that may reveal who is behind a frog
  // name (veilstage.stageRole: an Admin, the pad's owner, + staff / room mods while text_reveal_roles is on) gets it; anyone else the
  // neutral refusal - before the rate limit and before any row
  if (why === "veiled_hold") {
    let nameRight = null;
    try { nameRight = await require("./veilstage").stageRole(u, R.id); } catch (e) { nameRight = null; }
    if (!nameRight) throw new Refuse(409, MSG.held, "unavailable");
  }
  const LC = require("./livecam");
  const mine = LC.revealOfViewer(String(u.userId));
  if (mine && !(mine.roomId === R.id && mine.login === sub.login)) throw new Refuse(409, "Close the cam you're viewing for moderation first.", "one_open");
  const cur = LC.revealOf(R.id, sub.login);
  // 1.99?? (review fixes 2 - RV-C): an open by-login session (an admin's / staff's, from the admin page) is theirs alone - a pad role
  // can't join it (MediaMTX and the first beat would end it with lost_right after its rows and its rate were spent): refused first
  if (cur && cur.rv && cur.rv.bylogin && !SITE_WIDE.has(role)) throw new Refuse(409, MSG.held, "unavailable");
  if (!(cur && cur.viewers.has(String(u.userId)))) {                             // (a re-open of the one they're on isn't a new reveal)
    const lim = require("./bridge-relay").limited("camreveal|" + u.userId, REQ_GAP, REQ_BURST, REQ_WINDOW);
    if (lim) throw new Refuse(429, lim, "rate");
  }
  const ghost = isGhost(u.userId);
  const veiled = sub.kind !== "named" || why === "left_out";
  const label = veiled ? (sub.alias || "veiled") : sub.login;
  const ans = await LC.revealStart(u, R, sub.login, { why, label, veiled, bylogin: byLogin, role },
    (sid) => writeRows({ u, R, sub, role, reason, why, sid, ghost, label, veiled, byLogin, what: "open" }));
  console.log(`[camreveal] open room=${R.id} by=${u.userId} as=${role}${ghost ? " ghost" : ""}${byLogin ? " by-login" : ""} why=${why}`);
  // (the player shows the frog name for a veiled person - never the login; the by-login entry shows what the admin typed)
  return { ...ans, name: byLogin || !veiled ? sub.login : sub.alias || null, veiled: veiled && !byLogin, can_save: SAVERS.has(role) && evidenceOn(), role };
}
/** A beat: the right, the pad, the person still withheld (and listed, unless by login) - else the moderator's view ends with why. */
async function beat(u, R, sid) {
  const LC = require("./livecam");
  const uid = String(u.userId);
  const S = LC.revealSess(R.id, sid);
  if (!S || S.ended || !S.viewers.has(uid)) return LC.revealBeat(uid, R.id, sid);
  const stop = (why) => { LC.revealStop(uid, R.id, sid, why); return { ok: true, state: "ended", why }; };
  if (!effective()) return stop("switched_off");
  const role = await roleOf(u, R);
  if (!role || (S.rv.bylogin && !SITE_WIDE.has(role))) return stop("lost_right");
  if (!(await require("./bridge-relay").padFull(uid, R.id))) return stop("pad_access");
  if (!S.rv.bylogin && leftOut(S.login)) return stop("left_out");
  const kind = kindNow(R, S.login);
  if (!S.rv.bylogin && kind === "absent") return stop("gone");
  if (!(await withheldWhy(R, { login: S.login, kind }, uid))) return stop("visible");
  return LC.revealBeat(uid, R.id, sid);
}
/** "Extend (logged)": the four rows again, then another 3 minutes. */
async function extend(u, R, sid, reason0) {
  const LC = require("./livecam");
  const uid = String(u.userId);
  const S = LC.revealSess(R.id, sid);
  const v = S && !S.ended ? S.viewers.get(uid) : null;
  if (!v || now() > v.until) throw new Refuse(410, MSG.ended, "ended");
  const role = await roleOf(u, R);
  if (!role || (S.rv.bylogin && !SITE_WIDE.has(role))) throw new Refuse(403, MSG.forbidden, "forbidden");
  const reason = clean(reason0, REASON_MAX);
  if (reason.length < REASON_MIN) throw new Refuse(400, MSG.why, "why");
  const lim = require("./bridge-relay").limited("camreveal-x|" + uid, EXT_GAP, EXT_BURST, EXT_WINDOW);
  if (lim) throw new Refuse(429, lim, "rate");
  const ghost = isGhost(uid);
  const a = await writeRows({ u, R, sub: { login: S.login }, role, reason, why: S.rv.why, sid: S.sid, ghost, label: S.rv.label, veiled: S.rv.veiled,
                              byLogin: S.rv.bylogin, what: "extend", told: !!v.told });
  if (!LC.revealExtend(uid, R.id, S.sid, a.auditId)) {
    await runQuery("UPDATE livecam_audit SET ended = ?, secs = 0, end_reason = 'ended' WHERE id = ? AND ended IS NULL", [now(), a.auditId]).catch(() => {});
    throw new Refuse(410, MSG.ended, "ended");
  }
  const w = S.viewers.get(uid);
  return { ok: true, rv: S.sid, until: w.until };
}

// ── the notice (Q10 / Q11): livecam calls this at the first frame, once per moderator per reveal session, never for a ghost ──
async function inboxNotice(S, uid, pad) {
  const rows = await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [S.login]).catch(() => []);
  // (the ref names the session and an HMAC of the moderator - never their id: inbox rows go out in a person's own data export.
  // Review RV-5: the HMAC covers the session too, so it still tells one moderator's notice from another's within a reveal, but two
  // reveals by the same moderator never share a tail - the person can't link them)
  const ref = "camreveal:" + S.sid + ":" + crypto.createHmac("sha256", SECRET).update("camreveal-ref:" + S.sid + ":" + uid).digest("hex").slice(0, 10);
  const I = require("./inbox");
  for (const r of rows) {
    await I.addSafe(String(r.userId), { kind: "privacy", title: `👁 Someone moderating ${pad} viewed your cam`,
      body: "On publicaccess.tv, for moderation. Your settings haven't changed. Every such view is logged.", link: "/settings/privacy", ref }).catch(() => false);
  }
  return rows.length;
}
function notify(S, uid) {
  if (!S || !S.rv || isGhost(uid)) return false;
  const pad = padName(S.roomId);
  try { require("./camviewers").noteReveal(S.roomId, S.login, pad); } catch (e) { console.error("[camreveal] PM notice:", e.message); }
  // (review RV-3: from now on !whowatching / the privacy card list this view - never before its first frame)
  try { require("./camviewers").markRevealTold(S.sid, uid).catch(() => 0); } catch (e) { /* best effort */ }
  inboxNotice(S, uid, pad).catch((e) => console.error("[camreveal] inbox notice:", e.message));
  console.log(`[camreveal] told room=${S.roomId} rv=${S.sid}`);
  return true;
}
try { require("./livecam").onRevealNotice(notify); } catch (e) { /* no live cams */ }

// ── for the pad page (bridge.js liveView): may this viewer get the View-cam controls here? ──
/** -> the role (cached) while effective, else null. Never throws. */
async function viewerRole(userId, R) {
  try { if (!userId || !effective()) return null; return await roleCached(userId, R); } catch (e) { return null; }
}

function register(app, { addUser, bySlug, isLive }) {
  init().catch((e) => console.error("[camreveal] init:", e.message));
  try { require("./livecam").onRevealNotice(notify); } catch (e) { /* no live cams */ }
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "4kb" });
  const noStore = (res) => { res.set("Cache-Control", "private, no-store"); res.set("Referrer-Policy", "no-referrer"); res.set("X-Robots-Tag", "noindex"); };
  const fetchOnly = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code || null, error: e.message, ...(e.extra || {}) });
    console.error("[camreveal]", e && (e.code || e.name || e.message));
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was opened." });
  };
  const me = async (req) => (req.user && req.user.userId ? await userRow(req.user.userId) : null);
  const liveRoom = (req) => {
    const R = bySlug(req.params.slug);
    if (!R || !isLive(R)) throw new Refuse(404, MSG.offline, "offline");
    return R;
  };
  const OFF = { ok: false, code: "off", error: MSG.off };

  app.post("/api/rooms/:slug/livecam/reveal", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      await init();
      if (!effective()) return res.status(404).json(OFF);
      const u = await me(req);
      if (!u) return res.status(401).json({ ok: false, code: "signin", error: "Sign in first." });
      res.json(await start(u, liveRoom(req), req.body || {}));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/livecam/reveal/beat", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) return res.status(401).json({ ok: false, code: "signin", error: "Sign in first." });
      const sid = String((req.body || {}).rv || "").slice(0, 24);
      const R = bySlug(req.params.slug);
      if (!R) return res.json({ ok: true, state: "ended", why: "offline" });
      if (!SID_RE.test(sid)) return res.json({ ok: true, state: "ended", why: "gone" });
      res.json(await beat(u, R, sid));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/livecam/reveal/extend", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      await init();
      if (!effective()) return res.status(404).json(OFF);
      const u = await me(req);
      if (!u) return res.status(401).json({ ok: false, code: "signin", error: "Sign in first." });
      const R = bySlug(req.params.slug);
      if (!R) throw new Refuse(404, MSG.offline, "offline");
      const sid = String((req.body || {}).rv || "").slice(0, 24);
      if (!SID_RE.test(sid)) throw new Refuse(410, MSG.ended, "ended");
      res.json(await extend(u, R, sid, (req.body || {}).reason));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/livecam/reveal/stop", addUser, json, (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "signin", error: "Sign in first." });
    const R = bySlug(req.params.slug);
    const sid = String((req.body || {}).rv || "").slice(0, 24);
    if (R && SID_RE.test(sid)) { try { require("./livecam").revealStop(String(req.user.userId), R.id, sid, "stopped"); } catch (e) { /* gone */ } }
    res.json({ ok: true });
  });
  // the by-login entry (Q22): /admin/pepe/livecams - livecam.admin (the page) AND an admin / staff reveal role. {room (pad or id), login, reason}
  app.post("/api/admin/pepe/livecams/reveal", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      if (!SP.can(req.user, "livecam.admin")) return res.status(403).json({ ok: false, error: "Admins only." });
      await init();
      if (!effective()) return res.status(404).json(OFF);
      const u = await me(req);
      if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
      const ref = low((req.body || {}).room).slice(0, 128);
      let R = ref ? bySlug(ref) : null;
      if (!R && ref) { try { R = [...require("./bridge")._rooms.values()].find((x) => x && (low(x.id) === ref || low(x.slug) === ref)) || null; } catch (e) { R = null; } }
      if (!R || !isLive(R)) throw new Refuse(404, MSG.offline, "offline");
      const out = await start(u, R, { login: (req.body || {}).login, reason: (req.body || {}).reason }, { byLogin: true });
      res.json({ ...out, slug: R.slug || null });
    } catch (e) { fail(res, e); }
  });
  // the switch (/admin/bridge#camreveal; chatlog.admin, like privacy wire v2)
  const can = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/camreveal", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try { await init(); res.json({ ok: true, state: state() }); }
    catch (e) { console.error("[camreveal] admin:", e.message); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/admin/camreveal", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!can(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (!fetchOnly(req, res)) return;
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { res.json({ ok: true, state: await setOn(b.on, { userId: req.user.userId, username: req.user.username }) }); }
    catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      console.error("[camreveal] switch:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, isOn, everOn, advert, noteBot, botOn, effective, state, setOn, register, Refuse, MSG, BOT_FRESH_MS,
                   roleOf, roleCached, viewerRole, stillMay, subjectOf, withheldWhy, start, beat, extend, notify, padName, SAVERS, SITE_WIDE,
                   REQ_GAP, REQ_BURST, REQ_WINDOW,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = cleanState(null); loaded = false; ready = null; BOT_AT = 0; ROLE_CACHE.clear(); } };
