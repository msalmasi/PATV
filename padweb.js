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
"use strict";
const { getQuery } = require("./dbUtils");

const TTL_MS = 90 * 1000, MAX_PER_ROOM = 100, INCOG_CACHE_MS = 30 * 1000;
let clock = () => Date.now();
const rooms = new Map();            // roomId -> Map(userId -> {userId, username, login, at})
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
function sweep(roomId, now = clock()) {
  const m = rooms.get(roomId); if (!m) return [];
  for (const [k, v] of m) if (now - v.at > TTL_MS) m.delete(k);
  if (!m.size) { rooms.delete(roomId); return []; }
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
  try { set = await require("./messages").cardBlocks(k); } catch (e) { set = null; }
  keep(blockCache, k, { set, at: now });
  return set;
}
/**
 * The web users to show on room R's people list for viewer `me` ({userId, username} | null): page-safe entries only.
 * tipOf(name) -> the 💸 tip item for that PATV name ({to, href} | null) - bridge.js passes the viewer's own rules.
 */
async function forRoom(R, me = null, tipOf = null) {
  if (!R || !R.id) return [];
  const list = sweep(R.id);
  if (!list.length) return [];
  const inRoom = new Set((R.members || []).filter((m) => m && m.login && !m.anon).map((m) => String(m.login).toLowerCase()));
  const blocks = await blocksOf(me && me.userId);
  const out = [];
  for (const v of list.slice().reverse()) {                // the newest first
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
      const e = { web: true, display: v.username, patv: { username: v.username } };
      if (self) e.me = true;
      else if (tipOf) { const t = tipOf(v.username); if (t) e.tip = t; }
      out.push(e);
    } catch (err) { /* a failed check leaves that account out */ }
  }
  return out.sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0) || a.display.localeCompare(b.display));
}

module.exports = { note, forRoom, sweep, TTL_MS, MAX_PER_ROOM,
  _setClock: (f) => { clock = f || (() => Date.now()); }, _reset: () => { rooms.clear(); incogCache.clear(); privCache.clear(); blockCache.clear(); } };
