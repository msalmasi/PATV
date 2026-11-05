// listenban.js - audiogate2 (owner 2026-11-05, to "a pad ban, a !bridge block and a network ban stop posting and the stage, but not
// listening - should any of them also cut someone's audio?": "Yes"). Those three bans also stop someone HEARING a pad's room audio:
// refused when they connect and cut if they are already listening, on every path that plays it - bridge.js /p/:slug/audio (the raw MP3
// and the framed ?lv=1 levels) and its mic-stage capture tap, roomrtc.js (the ⚡ tickets, the MediaMTX read hook, the sessions it let
// in), micclip.js (a 🔊 mic-clip preview) and stagemiccap.js (a mic-stage clip records the room audio). Top Pads 🎧, the homepage Dock
// and its pop-out play through those same routes (public/js/room-bridge.js).
//
// WHAT COUNTS (refusal):
//   a pad ban        feed_bans for this pad, or room '' (a site-wide ban: every pad - as mainstage.isBanned / postRefusal read it)
//   a !bridge block  bridge_blocks feature 'all' (Pepe's !bridge block, the owner / admin pages, the person menu's "Website bridge" and
//                    a pad ban's bridge half) for this pad or every pad (''); a ONE-feature block (chat, clips, livecams, ...) stays
//                    about that feature only
//   a login ban      padbans pad_login_bans (a Camfrog login banned before it had a PATV account; bridge / pad / site scope), by the
//                    account's linked login - as bridgeblocks.active and mainstage.isBanned do
//   a network ban    netban.js, only while its switch is on: the listener's network (netban.reqNet - the trusted proxy's address, never
//                    a direct socket), site scope everywhere, pad scope in that pad; Staff and above and the ban's exempt accounts pass,
//                    as everywhere else network bans apply
//   NEVER: an incognito ban (veil_bans - it only stops posting under a frog name, and reading it here would show a moderator who the
//   frog is), a stage ban, Pepe's red list, a Camfrog room's !ban / !kick. A pad ban or a bridge block gives staff no pass (as posting).
// WHO: the ACCOUNT the listener connected with - also after that sign-in ends (signing out doesn't lift a ban; on a Public pad they
// could still listen signed out, and only a network ban reaches that); a signed-out listener is asked by network only.
// THE ANSWER: REFUSAL, one text for all three (no reason, no end, no moderator) where a route answers in words; the routes that answer
// an ordinary access denial with a code (⚡ "denied", micclip no_access, the capture's "denied") answer a ban the same way.
// WHEN: connect time = fresh reads (a ban lifted or ended lets them straight back in - nothing about it is remembered); already
// listening = changed() (every writer of those rows calls it -> onChange -> bridge.js re-checks that pad's listeners, every pad for a
// site-wide one) + bridge.js's 15 s pass (a row written with no event - an account merge -, a ban that started while a check failed).
// mayApply(roomId) - synchronous, from memory: the pad ids with an active account ban ('' = some ban covers every pad) + netban.anyFor -
// lets the passes skip a pad nobody is banned from without a lookup; room ids only, no user data; until it has loaded, every pad may.
// Nothing is stored; logs carry counts only. A lookup that fails throws: the passes keep the listener and ask again next time, the
// connect-time callers let them in (no answer is not a no) and log a count.
"use strict";
const { getQuery } = require("./dbUtils");

const REFUSAL = "You can't listen to this pad's room right now.";
let clock = () => Date.now();
const now = () => clock();

const TABLES = new Set();                // tables seen (they never go away)
async function has(table) {
  if (TABLES.has(table)) return true;
  const ok = (await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [table])).length > 0;
  if (ok) TABLES.add(table);
  return ok;
}

/** A pad ban / an 'all' bridge block / a login ban on account `userId` in pad `roomId` -> true | false. Throws when it can't be read. */
async function accountBanned(roomId, userId) {
  if (!userId) return false;
  const room = String(roomId || ""), uid = String(userId), t = now();
  if ((await has("feed_bans")) && (await getQuery(`SELECT 1 AS x FROM feed_bans WHERE user_id = ? AND (room_id = ? OR room_id = '')
        AND (until IS NULL OR until > ?) LIMIT 1`, [uid, room, t])).length) return true;
  if ((await has("bridge_blocks")) && (await getQuery(`SELECT 1 AS x FROM bridge_blocks WHERE user_id = ? AND (room_id = ? OR room_id = '')
        AND COALESCE(feature, 'all') = 'all' AND (until IS NULL OR until > ?) LIMIT 1`, [uid, room, t])).length) return true;
  const PB = require("./padbans");
  const login = await PB.loginOfCached(uid);
  return !!(login && (await PB.loginActive(room, login, ["bridge", "pad", "site"])));
}

/** A network ban on `net` ({ip, hash} - netban.reqNet; or a function giving it, asked only when a ban may apply) in pad `roomId` for
 *  account `userId` (null = signed out) -> true | false. */
async function netBanned(roomId, userId, net) {
  if (!net) return false;
  const NB = require("./netban");
  await NB.init();
  if (!NB.isOn() || !NB.anyFor(roomId)) return false;
  const n = typeof net === "function" ? net() : net;
  if (!n || !n.hash) return false;
  const uid = userId ? String(userId) : null;
  if (!(await NB.refusalFor(n, { roomId, user: uid ? { userId: uid } : null }))) return false;     // (its exempt list by account)
  if (!uid) return true;
  // Staff and above pass: their class now (padaccess's 60 s cache, read again on a would-be cut - as hearNow)
  const u = await require("./padaccess").accountLite(uid, { strict: true, fresh: true });
  return !u || !!(await NB.refusalFor(n, { roomId, user: u }));
}

/**
 * Is this listener banned from hearing pad `roomId`? userId / user = the account it connected with (null = signed out); net = its
 * network (netban.reqNet, or a function giving it; null = unknown - only account bans then). -> "ban" | null. Throws when it can't be
 * read.
 */
async function refusal({ roomId, userId = null, user = null, net = null } = {}) {
  const uid = userId || (user && user.userId) || null;
  if (uid && (await accountBanned(roomId, uid))) return "ban";
  if (await netBanned(roomId, uid, net)) return "ban";
  return null;
}

// ── which pads have bans (memory: room ids only) ──
let ROOMS = null;                        // Set(pad id; '' = a ban covering every pad) | null = not known
async function refresh() {
  try {
    const t = now(), s = new Set();
    if (await has("feed_bans")) for (const r of await getQuery("SELECT DISTINCT room_id FROM feed_bans WHERE until IS NULL OR until > ?", [t])) s.add(String(r.room_id || ""));
    if (await has("bridge_blocks")) {
      for (const r of await getQuery("SELECT DISTINCT room_id FROM bridge_blocks WHERE COALESCE(feature, 'all') = 'all' AND (until IS NULL OR until > ?)", [t])) s.add(String(r.room_id || ""));
    }
    if (await has("pad_login_bans")) {
      for (const r of await getQuery("SELECT DISTINCT room_id, scope FROM pad_login_bans WHERE until IS NULL OR until > ?", [t])) s.add(r.scope === "site" ? "" : String(r.room_id || ""));
    }
    ROOMS = s;
  } catch (e) {
    ROOMS = null;                        // unknown: every pad may (the per-listener lookups decide - and keep on a failure)
    console.error("[listenban] refresh:", e.message);
  }
  return ROOMS;
}
/** May a ban stop someone hearing pad `roomId`? From memory; true while unknown. false = nobody can be banned from it right now. */
function mayApply(roomId) {
  if (!ROOMS || ROOMS.has("") || ROOMS.has(String(roomId || ""))) return true;
  try { const NB = require("./netban"); return NB.isOn() && NB.anyFor(roomId); } catch (e) { return true; }
}

// ── events ──
const listeners = new Set();
/** fn(roomId | null): a ban that can stop listening was made in that pad (null = it may apply to every pad). */
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Every writer of a ban that counts calls this right after its row is written. net = a network ban (netban.anyFor knows it). */
function changed(roomId = null, { net = false } = {}) {
  const id = roomId == null || roomId === "" ? null : String(roomId);
  if (ROOMS && !net) ROOMS.add(id == null ? "" : id);
  for (const fn of listeners) {
    try { const p = fn(id); if (p && typeof p.catch === "function") p.catch((e) => console.error("[listenban] change:", e.message)); }
    catch (e) { console.error("[listenban] change:", e.message); }
  }
}

module.exports = { REFUSAL, refusal, accountBanned, netBanned, refresh, mayApply, onChange, changed,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _rooms: () => ROOMS, _forget: () => { ROOMS = null; } };
