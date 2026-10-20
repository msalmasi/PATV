// camaccess.js — 1.99aar: WHO may watch your cam on the website, beyond on / off.
//
// The on / off switch stays where it was (livecam_optout: /settings/privacy or !livecam off|on). While it's on, the cam
// owner (their Camfrog login) picks one of these modes:
//   everyone   any signed-in member (what "on" meant before 1.99aav)
//   members    signed-in members with a linked Camfrog name or another proven identity (verified.js) - THE DEFAULT since
//              1.99aav (the user's call, 2026-10-15): an owner who never chose gets this; an explicit choice is kept
//   followers  people who follow the owner's PATV account (follows.js; an owner without a linked account has no followers,
//              so everyone else has to ask)
//   request    nobody until the owner says yes
// and, for members / followers, whether people who don't qualify may still ASK (`ask`, default on; request mode always
// lets people ask). The owner's "always" list (cam_allow) gets in under every mode.
//
// Asking: a viewer who is refused with can_ask gets "🙋 Ask to watch" on the cam. One open request per viewer and cam,
// REQ_TTL_MS to answer. The owner is told in the room their cam is in - Pepe PMs them (the request rides Pepe's live-cam
// poll: `ca_asks` out, `ca_ack` back) - and in their PATV inbox when their name is linked. The answer:
//   Camfrog   !camok <name> (this time) · !camok <name> always · !camno <name>    (POST /api/bridge/camviewers op answer)
//   website   /settings/privacy - the pending requests, Allow / Always / Deny
// "This time" lets that viewer in for GRANT_MS (live, snapshots and clips alike); "always" adds them to the list; a no
// closes the request (they can ask again after REASK_MS). The viewer is told in their inbox either way and the cam page
// keeps polling while it waits, starting by itself on a yes.
// Tightening the mode (or removing someone from the list) ends the live streams of viewers who no longer qualify.
//
// camRefusal (camviewers.js) asks gate() after the owner's off switch, "private" and blocks; 👻 staff in ghost mode skip
// it like the rest (but never for saving).
// stagefix site: a pad's Stage asks gate() for every viewer of a cam put on it (livecam.stageViewerWhy - no asking there, and no
// ghost bypass); Pepe's public stream follows the mode too (onair.js, D-9: followers / request never, members only by an on-air
// OK given after modeSince() - when the owner last CHANGED it: cam_access.mode_at, which a save that keeps the mode - the
// "others can ask" switch - doesn't move).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const MODES = ["everyone", "members", "followers", "request"];
const DEFAULT_MODE = "members";            // 1.99aav: verified members, unless the owner chose otherwise
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const REQ_TTL_MS = 10 * 60 * 1000;
const GRANT_MS = 6 * 3600 * 1000;
const REASK_MS = 10 * 60 * 1000;
const MAX_ALLOW = 500;
const MAX_PENDING = 20;            // per cam owner
const ASKS_PER_HOUR = 10;          // per viewer, every cam together
const RESEND_MS = 20 * 1000;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

const MSG = {
  members: "They only show their cam to members with a linked Camfrog name or a verified account.",
  followers: "They only show their cam to people who follow them.",
  request: "They show their cam to people they say yes to.",
};

let deps = {
  verified: async (userId) => {
    const u = (await getQuery("SELECT * FROM users WHERE userId = ?", [String(userId)]))[0];
    if (!u) return false;
    if (u.camfrogUsername) return true;
    try { return !!(await require("./verified").verify(u)); } catch (e) { return false; }
  },
  follows: (userId, ownerId) => require("./follows").isFollowing(String(userId), "user", String(ownerId)),
  ownerAccount: async (login) => {
    const r = (await getQuery("SELECT userId, username FROM users WHERE lower(camfrogUsername) = ? ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1", [low(login)]))[0];
    return r ? { userId: String(r.userId), username: r.username } : null;
  },
  notify: (userId, n) => require("./rooms").notify(userId, { ...n, pm: false }),
  liveWatchers: (owner) => { try { return require("./livecam").watchersOf(owner); } catch (e) { return []; } },
  dropViewer: (owner, userId, why) => { try { return require("./livecam").dropViewerOf(owner, userId, why); } catch (e) { return 0; } },
};

// ── state ──
let ACCESS = new Map();            // owner -> {mode, ask, modeAt}
let ALLOW = new Map();             // owner -> Map(userId -> {username, created, via})
const REQ = new Map();             // id -> {id, owner, userId, username, display, room, at, status, until, decided, by, sentAt, tries, acked}
const ASKED = new Map();           // viewer userId -> [times]

let ready = null;
let LOADED = false;               // micfollow: ACCESS holds the real modes (until then accessOf answers the default)
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS cam_access (owner TEXT PRIMARY KEY, mode TEXT NOT NULL, ask INTEGER NOT NULL DEFAULT 1,
                      updated INTEGER NOT NULL, via TEXT, user_id TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS cam_allow (owner TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, created INTEGER NOT NULL,
                      via TEXT, PRIMARY KEY (owner, user_id))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS cam_requests (id TEXT PRIMARY KEY, owner TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT,
                      room TEXT, at INTEGER NOT NULL, status TEXT NOT NULL, until INTEGER, decided INTEGER, by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS cam_requests_owner ON cam_requests (owner, at)");
      // stagefix fix: mode_at = when the MODE last changed (D-9 reads it; `updated` moves on every save, the ask switch too).
      // Rows from before it existed start at `updated` - the latest the mode can have changed.
      const ccols = (await getQuery("PRAGMA table_info(cam_access)")).map((c) => c.name);
      if (!ccols.includes("mode_at")) {
        await runQuery("ALTER TABLE cam_access ADD COLUMN mode_at INTEGER");
        await runQuery("UPDATE cam_access SET mode_at = updated WHERE mode_at IS NULL");
      }
      const a = new Map();
      for (const r of await getQuery("SELECT owner, mode, ask, updated, mode_at FROM cam_access")) {
        if (MODES.includes(r.mode)) a.set(low(r.owner), { mode: r.mode, ask: !!r.ask, modeAt: Number(r.mode_at != null ? r.mode_at : r.updated) || 0 });
      }
      ACCESS = a;
      const m = new Map();
      for (const r of await getQuery("SELECT owner, user_id, username, created, via FROM cam_allow")) {
        const o = low(r.owner);
        if (!m.has(o)) m.set(o, new Map());
        m.get(o).set(String(r.user_id), { username: r.username || "", created: Number(r.created) || 0, via: r.via || "" });
      }
      ALLOW = m;
      LOADED = true;
      // open requests and live grants survive a restart (their notices to Pepe start over)
      const t = now();
      for (const r of await getQuery("SELECT * FROM cam_requests WHERE (status = 'pending' AND at > ?) OR (status = 'ok' AND until > ?)", [t - REQ_TTL_MS, t])) {
        REQ.set(r.id, { id: r.id, owner: low(r.owner), userId: String(r.user_id), username: r.username || "", display: "", room: r.room || "",
                        at: Number(r.at), status: r.status, until: Number(r.until) || 0, decided: Number(r.decided) || 0, by: r.by || "",
                        sentAt: 0, tries: 0, acked: r.status !== "pending" });
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** The owner's mode (sync once init() ran). */
function accessOf(owner) {
  const a = ACCESS.get(low(owner));
  return a ? { mode: a.mode, ask: a.ask } : { mode: DEFAULT_MODE, ask: true };
}
/** stagefix site (D-9): when the owner last CHANGED their mode (ms; 0 = never chose - the default applies). onair.js: a `members`
 *  cam goes on Pepe's public stream only by an on-air OK given AFTER this. stagefix fix: a save that keeps the mode (the "others
 *  can ask" switch, the same mode again) doesn't move it. Sync once init() ran. */
function modeSince(owner) {
  const a = ACCESS.get(low(owner));
  return a ? a.modeAt || 0 : 0;
}
const allowed = (owner, userId) => { const m = ALLOW.get(low(owner)); return !!(m && m.has(String(userId))); };
function openReq(owner, userId, t = now()) {
  for (const r of REQ.values()) {
    if (r.owner === low(owner) && r.userId === String(userId) && r.status === "pending" && t - r.at < REQ_TTL_MS) return r;
  }
  return null;
}
function grantOf(owner, userId, t = now()) {
  for (const r of REQ.values()) {
    if (r.owner === low(owner) && r.userId === String(userId) && r.status === "ok" && r.until > t) return r;
  }
  return null;
}
function lastNo(owner, userId) {
  let best = null;
  for (const r of REQ.values()) {
    if (r.owner === low(owner) && r.userId === String(userId) && r.status === "no" && (!best || r.decided > best.decided)) best = r;
  }
  return best;
}

/**
 * May `userId` see `owner`'s cam under the owner's mode? null = yes, else {code, status, error, can_ask, pending}.
 * (The off switch, "private", blocks and ghosts are camRefusal's - this is only the mode.)
 */
async function gate(owner, userId, t = now()) {
  await init();
  const o = low(owner);
  const A = accessOf(o);
  if (A.mode === "everyone" || userId == null) return null;
  const uid = String(userId);
  if (allowed(o, uid) || grantOf(o, uid, t)) return null;
  const acct = await deps.ownerAccount(o).catch(() => null);
  if (acct && acct.userId === uid) return null;                     // their own cam
  if (A.mode === "members" && (await deps.verified(uid).catch(() => false))) return null;
  if (A.mode === "followers" && acct && (await deps.follows(uid, acct.userId).catch(() => false))) return null;
  const pend = openReq(o, uid, t);
  const no = lastNo(o, uid);
  const canAsk = (A.mode === "request" || A.ask) && !(no && t - no.decided < REASK_MS);
  return { code: "cam_" + A.mode, status: 403, error: MSG[A.mode], can_ask: canAsk || !!pend, pending: !!pend, mode: A.mode };
}

// ── the owner's settings ──
async function setMode(owner, mode, { ask, via = "web", userId = null, t = now() } = {}) {
  await init();
  const o = low(owner);
  if (!LOGIN_RE.test(o)) return { ok: false, error: "That isn't a Camfrog name." };
  if (!MODES.includes(mode)) return { ok: false, error: "Pick everyone, members, followers or request." };
  const cur = accessOf(o);
  // stagefix fix: the mode's own clock moves only when the mode changes (no row yet = the default, members: choosing members
  // keeps it at 0 - nothing changed)
  const was = ACCESS.get(o);
  const modeAt = mode !== cur.mode ? t : was ? was.modeAt || 0 : 0;
  const a = { mode, ask: typeof ask === "boolean" ? ask : cur.ask, modeAt };
  await runQuery(`INSERT INTO cam_access (owner, mode, ask, updated, via, user_id, mode_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(owner) DO UPDATE SET mode = excluded.mode, ask = excluded.ask, updated = excluded.updated, via = excluded.via,
                  user_id = COALESCE(excluded.user_id, cam_access.user_id), mode_at = excluded.mode_at`,
                 [o, a.mode, a.ask ? 1 : 0, t, via === "chat" ? "chat" : "web", userId, modeAt]);
  ACCESS.set(o, a);                          // 1.99aav: "everyone" is a choice now (the default is members), so it's kept too
  const ended = await recheck(o, t);
  await mfRecheck(o);                        // micfollow: followers / on request -> off every pad's 🎙 mic stage at once
  console.log(`[camaccess] ${o}: ${a.mode}${a.mode !== "everyone" && a.mode !== "request" ? (a.ask ? " (others can ask)" : " (no asking)") : ""} via ${via}${ended ? `, ${ended} live viewer(s) ended` : ""}`);
  return { ok: true, mode: a.mode, ask: a.ask, ended };
}
/** micfollow: the mic stage re-checks this cam's owner (their mode) and forgets its cached viewer gates. Never throws. */
async function mfRecheck(owner) {
  try { await require("./micfollow").recheck(owner); } catch (e) { /* no mic follows */ }
}
/** End the live streams of viewers who no longer qualify (a tighter mode, someone taken off the list). */
async function recheck(owner, t = now()) {
  let n = 0;
  for (const w of deps.liveWatchers(owner) || []) {
    if (!w || !w.userId || (w.ghost && !w.stage)) continue;     // stagefix site: 👻 never gets past a Stage tile (DF-43)
    if (await gate(owner, w.userId, t)) n += deps.dropViewer(owner, w.userId, "cam_access") || 0;
  }
  return n;
}
function listAllow(owner) {
  const m = ALLOW.get(low(owner));
  return m ? [...m.entries()].map(([uid, b]) => ({ userId: uid, username: b.username, created: b.created, via: b.via })).sort((a, b) => b.created - a.created) : [];
}
async function allow(owner, user, { via = "web", t = now() } = {}) {
  await init();
  const o = low(owner);
  const m = ALLOW.get(o) || new Map();
  if (!m.has(user.userId) && m.size >= MAX_ALLOW) return { ok: false, error: `Your list holds up to ${MAX_ALLOW} people - remove someone first.` };
  await runQuery(`INSERT INTO cam_allow (owner, user_id, username, created, via) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(owner, user_id) DO UPDATE SET username = excluded.username`, [o, user.userId, user.username || null, t, via === "chat" ? "chat" : "web"]);
  if (!m.has(user.userId)) m.set(user.userId, { username: user.username || "", created: t, via: via === "chat" ? "chat" : "web" });
  ALLOW.set(o, m);
  return { ok: true };
}
async function disallow(owner, target, { t = now() } = {}) {
  await init();
  const o = low(owner);
  const m = ALLOW.get(o);
  const s = low(String(target || "").replace(/^@/, ""));
  let uid = null;
  if (m) for (const [id, b] of m) if (low(b.username) === s || id === s.replace(/^u:/, "")) { uid = id; break; }
  if (!uid) {
    const r = await require("./camviewers").resolveViewer(target);
    if (r.error) return { ok: false, error: r.error };
    uid = r.userId;
  }
  if (!m || !m.has(uid)) return { ok: true, was: false };
  const b = m.get(uid);
  await runQuery("DELETE FROM cam_allow WHERE owner = ? AND user_id = ?", [o, uid]);
  m.delete(uid);
  if (!m.size) ALLOW.delete(o);
  for (const r of REQ.values()) if (r.owner === o && r.userId === uid && r.status === "ok") { r.status = "ended"; r.until = t; }
  await runQuery("UPDATE cam_requests SET status = 'ended', until = ? WHERE owner = ? AND user_id = ? AND status = 'ok'", [t, o, uid]);
  const ended = await recheck(o, t);
  await mfRecheck(o);
  return { ok: true, was: true, user: { username: b.username }, ended };
}

// ── asking ──
/** A viewer asks to watch. u = {userId, username, displayname?}. -> {ok, pending, id} | {ok:false, code, error} */
async function ask(owner, u, room, t = now()) {
  await init();
  const o = low(owner);
  if (!LOGIN_RE.test(o) || !u || !u.userId) return { ok: false, code: "bad", error: "Whose cam?" };
  const g = await gate(o, u.userId, t);
  if (!g) return { ok: true, allowed: true };
  const open = openReq(o, u.userId, t);
  if (open) return { ok: true, pending: true, id: open.id, expires: open.at + REQ_TTL_MS };
  if (!g.can_ask) return { ok: false, code: "no_ask", error: lastNo(o, u.userId) ? "They said no - you can ask again in a few minutes." : g.error };
  const mine = (ASKED.get(String(u.userId)) || []).filter((x) => t - x < 3600 * 1000);
  if (mine.length >= ASKS_PER_HOUR) return { ok: false, code: "rate", error: "That's a lot of asking - try again later." };
  let open_ = 0;
  for (const r of REQ.values()) if (r.owner === o && r.status === "pending" && t - r.at < REQ_TTL_MS) open_++;
  if (open_ >= MAX_PENDING) return { ok: false, code: "busy", error: "They have a lot of requests waiting - try again later." };
  mine.push(t); ASKED.set(String(u.userId), mine);
  let display = "";
  try { display = require("./displaynames").usable(u.displayname) || ""; } catch (e) { display = ""; }
  const r = { id: "ca" + crypto.randomBytes(8).toString("hex"), owner: o, userId: String(u.userId), username: u.username || "", display: String(display).slice(0, 40),
              room: String(room || ""), at: t, status: "pending", until: 0, decided: 0, by: "", sentAt: 0, tries: 0, acked: false };
  REQ.set(r.id, r);
  await runQuery("INSERT INTO cam_requests (id, owner, user_id, username, room, at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    [r.id, o, r.userId, r.username || null, r.room || null, t]);
  const acct = await deps.ownerAccount(o).catch(() => null);
  if (acct) {
    deps.notify(acct.userId, { kind: "system", title: `🙋 ${r.username} asks to watch your cam on PATV`,
      body: "Allow them this time (6 hours), always, or say no - here or in Camfrog: !camok " + r.username + " · !camno " + r.username,
      link: "/settings/privacy#livecam", ref: "camask:" + r.id }).catch(() => {});
  }
  console.log(`[camaccess] ${r.username} asks to watch ${o} (${r.id})`);
  return { ok: true, pending: true, id: r.id, expires: t + REQ_TTL_MS };
}
/** The viewer's own view of their request: {state: allowed | pending | no | expired | none}. */
async function askState(owner, userId, t = now()) {
  await init();
  if (!(await gate(owner, userId, t))) return { state: "allowed" };
  const open = openReq(owner, userId, t);
  if (open) return { state: "pending", expires: open.at + REQ_TTL_MS };
  const no = lastNo(owner, userId);
  if (no && t - no.decided < REASK_MS) return { state: "no" };
  return { state: "none" };
}
/**
 * The owner answers. target = a viewer's name or a request id; how = once | always | no.
 * -> {ok, user, how} | {ok:false, error}
 */
async function answer(owner, target, how, { via = "web", t = now() } = {}) {
  await init();
  const o = low(owner);
  if (!["once", "always", "no"].includes(how)) return { ok: false, error: "Allow once, always, or no?" };
  let req = REQ.get(String(target || ""));
  if (req && req.owner !== o) req = null;
  let user = null;
  if (req) user = { userId: req.userId, username: req.username };
  else {
    const r = await require("./camviewers").resolveViewer(target);
    if (r.error) return { ok: false, error: r.error };
    user = { userId: r.userId, username: r.username };
    req = openReq(o, r.userId, t);
  }
  if (!req && how === "no") return { ok: false, error: `${user.username} hasn't asked to watch your cam.` };
  if (!req) {                               // allowing someone who didn't ask (yet) is fine: it's the owner's cam
    req = { id: "ca" + crypto.randomBytes(8).toString("hex"), owner: o, userId: user.userId, username: user.username, display: "", room: "", at: t,
            status: "pending", until: 0, decided: 0, by: "", sentAt: 0, tries: 0, acked: true };
    REQ.set(req.id, req);
    await runQuery("INSERT INTO cam_requests (id, owner, user_id, username, room, at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
      [req.id, o, req.userId, req.username || null, null, t]);
  }
  req.status = how === "no" ? "no" : "ok";
  req.until = how === "no" ? 0 : t + GRANT_MS;
  req.decided = t;
  req.by = via === "chat" ? "chat" : "web";
  req.acked = true;
  await runQuery("UPDATE cam_requests SET status = ?, until = ?, decided = ?, by = ? WHERE id = ?", [req.status, req.until || null, t, req.by, req.id]);
  if (how === "always") await allow(o, user, { via, t });
  deps.notify(user.userId, how === "no"
    ? { kind: "system", title: `${o} said no to showing you their cam`, body: "", link: "", ref: "camans:" + req.id }
    : { kind: "system", title: `✅ ${o} lets you watch their cam${how === "always" ? "" : " (for 6 hours)"}`, body: "Open it from their room's pad.",
        link: "", ref: "camans:" + req.id }).catch(() => {});
  console.log(`[camaccess] ${o} answered ${user.username}: ${how} via ${via}`);
  return { ok: true, how, user: { username: user.username } };
}
function pendingFor(owner, t = now()) {
  const o = low(owner);
  return [...REQ.values()].filter((r) => r.owner === o && r.status === "pending" && t - r.at < REQ_TTL_MS)
    .sort((a, b) => b.at - a.at).map((r) => ({ id: r.id, username: r.username, display: r.display, room: r.room, at: r.at, expires: r.at + REQ_TTL_MS }));
}

/** Pepe's poll: the requests to PM (and his acks of the last ones). body: {ca, ca_ack}. */
function forBot(body, t = now()) {
  body = body || {};
  for (const id of (Array.isArray(body.ca_ack) ? body.ca_ack : []).slice(0, 200)) { const r = REQ.get(String(id)); if (r) r.acked = true; }
  for (const [id, r] of REQ) {
    if (r.status === "pending" && t - r.at >= REQ_TTL_MS) {
      r.status = "expired";
      runQuery("UPDATE cam_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", [id]).catch(() => {});
    }
    if (r.status !== "pending" && !(r.status === "ok" && r.until > t) && !(r.status === "no" && t - r.decided < REASK_MS)) REQ.delete(id);
  }
  for (const [uid, list] of ASKED) { const k = list.filter((x) => t - x < 3600 * 1000); if (k.length) ASKED.set(uid, k); else ASKED.delete(uid); }
  if (body.ca !== true) return [];
  const out = [];
  for (const r of REQ.values()) {
    if (r.status !== "pending" || r.acked) continue;
    if (r.sentAt && (t - r.sentAt < RESEND_MS || r.tries >= 3)) continue;
    r.sentAt = t; r.tries++;
    out.push({ id: r.id, login: r.owner, room: r.room, username: r.username, display: r.display });
    if (out.length >= 50) break;
  }
  return out;
}
function prune(t = now()) {
  return runQuery("DELETE FROM cam_requests WHERE at < ?", [t - 30 * 24 * 3600 * 1000]).catch(() => {});
}
function stats() {
  let allowN = 0;
  for (const m of ALLOW.values()) allowN += m.size;
  const modes = {};
  for (const a of ACCESS.values()) modes[a.mode] = (modes[a.mode] || 0) + 1;
  return { modes, allow: allowN, pending: [...REQ.values()].filter((r) => r.status === "pending").length };
}

module.exports = {
  init, loaded: () => LOADED, gate, accessOf, modeSince, setMode, listAllow, allow, disallow, ask, askState, answer, pendingFor, forBot, prune, stats, recheck,
  MODES, DEFAULT_MODE, MSG, REQ_TTL_MS, GRANT_MS, REASK_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setDeps: (d) => { deps = Object.assign({}, deps, d || {}); },
  _reset: () => { ACCESS = new Map(); ALLOW = new Map(); REQ.clear(); ASKED.clear(); ready = null; LOADED = false; },
};
