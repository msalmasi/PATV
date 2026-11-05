// padweb.js - 1.99ajf dockclean (Room Dock clean-up, owner point 32): who is on a pad's live chat from the WEBSITE right now, for the
// pad page's people list ("🌐 web users" under the Camfrog room's members).
//
// What it is: an in-memory map per room of the signed-in accounts whose pad page asked GET /api/rooms/:slug/live in the last TTL_MS
// (90 s) - noted by bridge.js after that route's own access checks passed (members-tier, the 18+ gate, the Prime Time Plus bridge).
// At most MAX_PER_ROOM (100) accounts per room, the oldest dropped first. Nothing is persisted, logged or exported; a restart forgets
// everyone. Signed-out viewers are never noted.
//
// What a page gets (bridge.js liveView `web`): [{web: true, display: <PATV username>, patv: {username}, me?: true, tip?}] - the PATV
// name only (no chat login, no account id). Left out:
//   * an account whose chat identity (the linked Camfrog login, or the account key "u:<userId>") is hidden by the site's ONE reader rule
//     (quotes.isHidden: hubhidden's AND the chat archive's sticky sets - incognito, !bridge hide, forget-me, account deletion, staff
//     removal - plus chatlogview.isHiddenLogin, the chat's own view of both), or has Incognito on (the website switch / !incognito:
//     incognito_state). While either set is still loading, EVERY web user is left out (fail closed);
//   * an account that keeps its room activity private (its profile's Analytics section or Rooms panel hidden: chatlogview.privateFlags,
//     the rule the bridge's "someone" joins and the clip / stage pickers already follow);
//   * staff in 👻 ghost mode (ghost.js: out of every viewer list);
//   * an account blocked either way with the viewer (messages.cardBlocks - their DM blocks);
//   * an account whose linked login is already in the room's member list (no duplicates - the Camfrog entry shows them);
//   * a failed check (the database busy): left out.
// 1.99ajf dockclean review: only the pad page's own polls note anyone (bridge.js ?pad=1), not the homepage panel or the owner pages.
// The privacy page (/privacy#rooms) says so: Incognito, or keeping your room activity private, keeps you off the list.
//
// 1.99ajn padppl (owner: "Website users in the people list can be anyone that posted in the last hour. But we should differentiate them
// from people who actually had the pad's chat open in the last 90s. Like active/inactive."): a second in-memory map - who POSTED in
// this pad's chat from the website in the last POST_TTL_MS (1 hour; bridge-relay.js notes a say job once Pepe sent it or its line came
// back, from any page - the homepage Dock included), at most MAX_PER_ROOM per room, forgotten on a restart. forRoom lists the union:
//   act: 1          the pad's chat is open (the pad page or its chat window polled in the last 90 s) - ACTIVE
//   act: 0, ago: n  posted n minutes ago, chat not open now - INACTIVE (the page dims it)
// EVERY exclusion below runs the same for both kinds. Also left out (padppl blocks): someone who blocked the viewer's Camfrog login by
// name before it had an account (blocks.js loginBlockersOf - a named block, like dm_blocks). Review fix (no unmasking): only a line that
// went out UNDER THE PERSON'S NAME notes them (bridge.js ingest -> bridge-relay notePosted -> notePostNamed: the room's own echo was a
// named line, and they weren't incognito / hidden when it came) - a frog-named line or a hidden bar never does, so turning incognito off
// later can't put a name next to "posted 10 min ago" and the frog line said then.
"use strict";
const { getQuery } = require("./dbUtils");

const TTL_MS = 90 * 1000, MAX_PER_ROOM = 100, INCOG_CACHE_MS = 30 * 1000, POST_TTL_MS = 60 * 60 * 1000;
let clock = () => Date.now();
const rooms = new Map();            // roomId -> Map(userId -> {userId, username, login, at})
const posted = new Map();           // roomId -> Map(userId -> {userId, username, login, at}) - 1.99ajn padppl: posted in the last hour
const incogCache = new Map();       // chat key -> {on, at}
const privCache = new Map();        // userId -> {on, at}: their room activity is private (profile)
const blockCache = new Map();       // viewer userId -> {set, at}: the ids blocked either way with them
function keep(map, k, v) { map.set(k, v); if (map.size > 2000) map.delete(map.keys().next().value); }

/** A signed-in viewer's pad page asked for the live room (the route's access checks passed). login = their linked chat login | null. */
function note(roomId, user, login) {
  if (!roomId || !user || !user.userId || !user.username) return;
  const now = clock();
  let m = rooms.get(roomId);
  if (!m) { m = new Map(); rooms.set(roomId, m); }
  const id = String(user.userId);
  m.delete(id);                                   // (re-inserted: the Map's order is the age order)
  m.set(id, { userId: id, username: String(user.username), login: login ? String(login).toLowerCase() : null, at: now });
  while (m.size > MAX_PER_ROOM) m.delete(m.keys().next().value);
}
/** 1.99ajn padppl: this account's line from the website reached pad room roomId's chat (bridge-relay: Pepe sent it / its echo came). */
function notePost(roomId, user, login, at = clock()) {
  if (!roomId || !user || !user.userId || !user.username) return;
  let m = posted.get(roomId);
  if (!m) { m = new Map(); posted.set(roomId, m); }
  const id = String(user.userId);
  m.delete(id);
  m.set(id, { userId: id, username: String(user.username), login: login ? String(login).toLowerCase() : null, at: Number(at) || clock() });
  while (m.size > MAX_PER_ROOM) m.delete(m.keys().next().value);
}
/** 1.99ajn padppl review fix: notePost only for a line that went out under the person's NAME - nobody hides that key now (the sticky
 *  hidden sets: incognito, !bridge hide, forget-me...) and Incognito is off (a FRESH read - never the 30 s cache, a switch just
 *  flipped counts). Fails closed (a failed check notes nothing). Never throws. */
async function notePostNamed(roomId, user, login, at = clock()) {
  try {
    if (!roomId || !user || !user.userId || !user.username) return false;
    const id = String(user.userId), l = login ? String(login).toLowerCase() : null;
    const keys = [...(l ? [l] : []), "u:" + id];
    if (keys.some((k) => hiddenKey(k))) return false;
    const rows = await getQuery(`SELECT "on" AS "on" FROM incognito_state WHERE login IN (${keys.map(() => "?").join(",")})`, keys);
    if (rows.some((r) => r && Number(r.on) === 1)) return false;
    notePost(roomId, user, l, at);
    return true;
  } catch (e) { return false; }
}
function sweep(roomId, now = clock()) {
  const m = rooms.get(roomId); if (!m) return [];
  for (const [k, v] of m) if (now - v.at > TTL_MS) m.delete(k);
  if (!m.size) { rooms.delete(roomId); return []; }
  return [...m.values()];
}
function sweepPosted(roomId, now = clock()) {
  const m = posted.get(roomId); if (!m) return [];
  for (const [k, v] of m) if (now - v.at > POST_TTL_MS) m.delete(k);
  if (!m.size) { posted.delete(roomId); return []; }
  return [...m.values()];
}
async function incognitoOn(key) {
  const now = clock(), c = incogCache.get(key);
  if (c && now - c.at < INCOG_CACHE_MS) return c.on;
  const r = (await getQuery(`SELECT "on" AS "on" FROM incognito_state WHERE login = ?`, [key]))[0];
  const on = !!(r && r.on);
  incogCache.set(key, { on, at: now });
  if (incogCache.size > 2000) incogCache.delete(incogCache.keys().next().value);
  return on;
}
function hiddenKey(key) {
  // the site's one reader rule first (both sticky sets, any kind, fail closed while either loads), then the chat's own view of them
  try { if (require("./quotes").isHidden(key)) return true; } catch (e) { return true; }
  try { if (require("./chatlogview").isHiddenLogin(key)) return true; } catch (e) { return true; }
  try {
    const H = require("./hubhidden");
    if (typeof H.loading === "function" && H.loading()) return true;       // fail closed until the hidden list has loaded
    const h = H.hash(key);
    return !!(h && (H.isHiddenHash(h) || H.isLeftOutHash(h)));
  } catch (e) { return true; }
}
/** Their room activity is private (the profile's Analytics section or Rooms panel hidden) - cached 30 s; a failed read = private. */
async function privateOn(v) {
  const now = clock(), c = privCache.get(v.userId);
  if (c && now - c.at < INCOG_CACHE_MS) return c.on;
  let on = true;
  try {
    const f = await require("./chatlogview").privateFlags({ ids: [v.userId], logins: v.login ? [v.login] : [] });
    on = !!(f && ((f.ids && f.ids.has(String(v.userId))) || (v.login && f.logins && f.logins.has(v.login))));
  } catch (e) { on = true; }
  keep(privCache, v.userId, { on, at: now });
  return on;
}
/** The ids blocked either way with this viewer (cached 30 s); null when the read failed (then nobody else is listed). */
async function blocksOf(viewerId) {
  if (!viewerId) return new Set();
  const now = clock(), k = String(viewerId), c = blockCache.get(k);
  if (c && now - c.at < INCOG_CACHE_MS) return c.set;
  let set = null;
  try {
    set = await require("./messages").cardBlocks(k);
    // 1.99ajn padppl: + whoever blocked this viewer's Camfrog login by name before it had an account (a named block, like dm_blocks).
    // Never a frog-name block: THE VEIL RULE - it never changes what the blocked person sees (blocks.js)
    for (const id of await require("./blocks").loginBlockersOf(k)) set.add(String(id));
  } catch (e) { set = null; }
  keep(blockCache, k, { set, at: now });
  return set;
}
/**
 * The web users to show on room R's people list for viewer `me` ({userId, username} | null): page-safe entries only.
 * tipOf(name) -> the 💸 tip item for that PATV name ({to, href} | null) - bridge.js passes the viewer's own rules.
 */
async function forRoom(R, me = null, tipOf = null) {
  if (!R || !R.id) return [];
  // 1.99ajn padppl: the open ones (act 1) and, after them, who posted in the last hour without the chat open now (act 0)
  const t = clock();
  const open = sweep(R.id, t), openIds = new Set(open.map((v) => v.userId));
  const list = [...open.map((v) => Object.assign({}, v, { act: 1 })),
                ...sweepPosted(R.id, t).filter((v) => !openIds.has(v.userId)).map((v) => Object.assign({}, v, { act: 0, ago: Math.max(1, Math.round((t - v.at) / 60000)) }))];
  if (!list.length) return [];
  const inRoom = new Set((R.members || []).filter((m) => m && m.login && !m.anon).map((m) => String(m.login).toLowerCase()));
  const blocks = await blocksOf(me && me.userId);
  const out = [];
  for (const v of list) {
    try {
      if (v.login && inRoom.has(v.login)) continue;
      const self = !!(me && me.userId && String(me.userId) === v.userId);
      if (!self && (blocks === null || blocks.has(v.userId))) continue;
      try { if (require("./ghost").isGhost(v.userId)) continue; } catch (e) { continue; }
      const key = v.login || "u:" + v.userId;
      if (hiddenKey(key) || hiddenKey("u:" + v.userId)) continue;
      if (await incognitoOn(key)) continue;
      if (v.login && await incognitoOn("u:" + v.userId)) continue;
      if (await privateOn(v)) continue;
      const e = { web: true, display: v.username, patv: { username: v.username }, act: v.act };
      // 1.99ajn padppl: a web name that is a Camfrog login this account isn't linked to - the "not the Camfrog user" tag (cfnames.js)
      try { const cl = require("./cfnames").clashOf(v.userId, v.username, v.username, v.login); if (cl) e.clash = cl; } catch (err) { /* no tag */ }
      if (!v.act) e.ago = v.ago;
      if (self) e.me = true;
      else if (tipOf) { const t = tipOf(v.username); if (t) e.tip = t; }
      out.push(e);
    } catch (err) { /* a failed check leaves that account out */ }
  }
  // yourself first, then ACTIVE (chat open) before INACTIVE (posted only), then by name
  return out.sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0) || (b.act || 0) - (a.act || 0) || a.display.localeCompare(b.display));
}

module.exports = { note, notePost, notePostNamed, forRoom, sweep, sweepPosted, TTL_MS, POST_TTL_MS, MAX_PER_ROOM,
  hiddenKey, incognitoOn,          // 1.99ajw casino2: the casino tables' veiled seats follow the same rule (casino/people.js)
  _setClock: (f) => { clock = f || (() => Date.now()); },
  _reset: () => { rooms.clear(); posted.clear(); incogCache.clear(); privCache.clear(); blockCache.clear(); } };
