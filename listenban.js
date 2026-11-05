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
// review fixes: refusals() asks a whole pass at once (a few lookups per pass, not per listener); the linked login is read fresh; an
// account merged away answers to the survivor's bans; gen() lets a connect check that a ban raced ask again; madeSince() is what a
// restart replays on the ⚡ sessions it forgot.
"use strict";
const DB = require("./dbUtils");                  // (DB.getQuery at call time)
const getQuery = (sql, p) => DB.getQuery(sql, p);

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

// review fix (regression F1): the passes ask every listener of a pass at ONCE - one lookup per table for the whole batch (user_id IN
// (...), chunked), not one per listener; the connect-time check is the same code for one listener. Review fix (access F3): the account's
// linked Camfrog login is read fresh with it (never padbans' 60 s cache: a login moved onto an account with no event - a provider merge
// - counts on the next pass and the next connect); an account merged away since (account_merges - its rows moved to the survivor)
// answers to the surviving account's bans too.
const CHUNK = 400;                       // (well under SQLite's parameter limit)
const chunks = (a) => { const out = []; for (let i = 0; i < a.length; i += CHUNK) out.push(a.slice(i, i + CHUNK)); return out; };
const marks = (a) => a.map(() => "?").join(", ");
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();       // (padbans.js's login spelling)

/** ids -> Map(id -> {ids: [itself, the account it was merged into], logins: [their linked Camfrog logins]}). A login that can't be read
 *  is none (as padbans.loginOfCached answered). */
async function accountsOf(ids) {
  const login = new Map(), into = new Map();
  try {
    const users = async (list) => {
      for (const ch of chunks(list)) {
        for (const r of await getQuery(`SELECT userId, camfrogUsername FROM users WHERE userId IN (${marks(ch)})`, ch)) {
          login.set(String(r.userId), r.camfrogUsername && low(r.camfrogUsername) ? low(r.camfrogUsername) : null);
        }
      }
    };
    await users(ids);
    const gone = ids.filter((id) => !login.has(id));
    if (gone.length && (await has("account_merges"))) {
      for (const ch of chunks(gone)) {
        for (const r of await getQuery(`SELECT old_id, new_id FROM account_merges WHERE old_id IN (${marks(ch)})`, ch)) if (r.new_id) into.set(String(r.old_id), String(r.new_id));
      }
      const more = [...new Set(into.values())].filter((id) => !login.has(id));
      if (more.length) await users(more);
    }
  } catch (e) { /* the login / merge part only: unread = none */ }
  const out = new Map();
  for (const id of ids) {
    const all = into.has(id) && into.get(id) !== id ? [id, into.get(id)] : [id];
    out.set(id, { ids: all, logins: [...new Set(all.map((x) => login.get(x)).filter(Boolean))] });
  }
  return out;
}

/** A network ban on `net` ({ip, hash} - netban.reqNet; an array of them - a ⚡ session's ticket network and the address MediaMTX saw;
 *  or a function giving either, asked only when a ban may apply) in pad `roomId` for account `userId` (null = signed out) -> boolean.
 *  From memory (netban's lists) - a lookup only for the staff pass of someone it would cut. */
async function netBanned(roomId, userId, net) {
  if (!net) return false;
  const NB = require("./netban");
  await NB.init();
  if (!NB.isOn() || !NB.anyFor(roomId)) return false;
  const v = typeof net === "function" ? net() : net;
  const nets = (Array.isArray(v) ? v : [v]).filter((n) => n && n.hash);
  if (!nets.length) return false;
  const uid = userId ? String(userId) : null;
  const hit = async (user) => { for (const n of nets) if (await NB.refusalFor(n, { roomId, user })) return true; return false; };
  if (!(await hit(uid ? { userId: uid } : null))) return false;          // (its exempt list by account)
  if (!uid) return true;
  // Staff and above pass: their class now (padaccess's 60 s cache, read again on a would-be cut - as hearNow)
  const u = await require("./padaccess").accountLite(uid, { strict: true, fresh: true });
  return !u || (await hit(u));
}

/**
 * Which of these listeners are banned from hearing their pad? items: [{roomId, userId (the account it connected with; null = signed
 * out), net (see netBanned; null = unknown - account bans only)}] -> [true | false], in order. One lookup per table for the batch.
 * Throws when a ban table can't be read.
 */
async function refusals(items) {
  const list = Array.isArray(items) ? items.map((i) => i || {}) : [];
  const out = list.map(() => false);
  if (!list.length) return out;
  const t = now();
  const ids = [...new Set(list.map((i) => (i.userId ? String(i.userId) : null)).filter(Boolean))];
  if (ids.length) {
    const acc = await accountsOf(ids);
    const all = [...new Set([...acc.values()].flatMap((a) => a.ids))];
    const feed = new Map(), bridge = new Map();          // account -> Set(pad id; '' = every pad)
    const put = (m, k, r) => { k = String(k); if (!m.has(k)) m.set(k, new Set()); m.get(k).add(String(r || "")); };
    if (await has("feed_bans")) {
      for (const ch of chunks(all)) {
        for (const r of await getQuery(`SELECT user_id, room_id FROM feed_bans WHERE user_id IN (${marks(ch)}) AND (until IS NULL OR until > ?)`, [...ch, t])) put(feed, r.user_id, r.room_id);
      }
    }
    if (await has("bridge_blocks")) {
      for (const ch of chunks(all)) {
        for (const r of await getQuery(`SELECT user_id, room_id FROM bridge_blocks WHERE user_id IN (${marks(ch)}) AND COALESCE(feature, 'all') = 'all'
              AND (until IS NULL OR until > ?)`, [...ch, t])) put(bridge, r.user_id, r.room_id);
      }
    }
    const logins = [...new Set([...acc.values()].flatMap((a) => a.logins))];
    const lb = new Map();                                // login -> [{room, scope}] (padbans.loginActive's rule, bridge / pad / site)
    if (logins.length && (await has("pad_login_bans"))) {
      for (const ch of chunks(logins)) {
        for (const r of await getQuery(`SELECT login, room_id, scope FROM pad_login_bans WHERE login IN (${marks(ch)}) AND scope IN ('bridge', 'pad', 'site')
              AND (until IS NULL OR until > ?)`, [...ch, t])) {
          const k = low(r.login); if (!lb.has(k)) lb.set(k, []); lb.get(k).push({ room: String(r.room_id || ""), scope: r.scope });
        }
      }
    }
    const inPad = (s, room) => !!s && (s.has(room) || s.has(""));
    list.forEach((i, k) => {
      if (!i.userId) return;
      const a = acc.get(String(i.userId)), room = String(i.roomId || "");
      if (a.ids.some((x) => inPad(feed.get(x), room) || inPad(bridge.get(x), room))) { out[k] = true; return; }
      if (a.logins.some((l) => (lb.get(l) || []).some((b) => b.room === room || (b.room === "" && b.scope === "site")))) out[k] = true;
    });
  }
  for (let k = 0; k < list.length; k++) {
    if (!out[k] && (await netBanned(list[k].roomId, list[k].userId || null, list[k].net || null))) out[k] = true;
  }
  return out;
}

/** A pad ban / an 'all' bridge block / a login ban on account `userId` in pad `roomId` -> true | false. Throws when it can't be read. */
async function accountBanned(roomId, userId) {
  if (!userId) return false;
  return (await refusals([{ roomId, userId }]))[0];
}

/**
 * Is this listener banned from hearing pad `roomId`? userId / user = the account it connected with (null = signed out); net = its
 * network (see netBanned; null = unknown - only account bans then). -> "ban" | null. Throws when it can't be read. The connect-time
 * question (fresh reads); the passes ask refusals() for all their listeners at once.
 */
async function refusal({ roomId, userId = null, user = null, net = null } = {}) {
  const uid = userId || (user && user.userId) || null;
  return (await refusals([{ roomId, userId: uid, net }]))[0] ? "ban" : null;
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

/**
 * Review fix (access F2): the pads with a ban that counts made since `t0` (ms) and still in force - '' = one covering every pad. Room ids
 * only. roomrtc.js asks it once after a restart (t0 = a little before this start): MediaMTX kept the ⚡ sessions the site forgot, and a
 * ban made just before the restart (its event lost with the process) or before MediaMTX's first listing found nobody to end.
 */
async function madeSince(t0) {
  const s = new Set(), t = now(), since = Number(t0) || 0;
  if (await has("feed_bans")) {
    for (const r of await getQuery("SELECT DISTINCT room_id FROM feed_bans WHERE at >= ? AND (until IS NULL OR until > ?)", [since, t])) s.add(String(r.room_id || ""));
  }
  if (await has("bridge_blocks")) {
    for (const r of await getQuery(`SELECT DISTINCT room_id FROM bridge_blocks WHERE COALESCE(feature, 'all') = 'all' AND updated >= ?
          AND (until IS NULL OR until > ?)`, [since, t])) s.add(String(r.room_id || ""));
  }
  if (await has("pad_login_bans")) {
    for (const r of await getQuery("SELECT DISTINCT room_id, scope FROM pad_login_bans WHERE at >= ? AND (until IS NULL OR until > ?)", [since, t])) s.add(r.scope === "site" ? "" : String(r.room_id || ""));
  }
  let netOn = false;
  try { const NB = require("./netban"); await NB.init(); netOn = NB.isOn(); } catch (e) { netOn = false; }
  if (netOn && (await has("net_bans"))) {
    for (const r of await getQuery(`SELECT DISTINCT scope, room_id FROM net_bans WHERE created >= ? AND lifted_at IS NULL
          AND (until IS NULL OR until > ?)`, [since, t])) s.add(r.scope === "pad" ? String(r.room_id || "") : "");
  }
  return s;
}

// ── events ──
const listeners = new Set();
let GEN = 0;                             // review fix (access F4): bumped by every changed() - a connect check that saw it move asks again
/** fn(roomId | null): a ban that can stop listening was made in that pad (null = it may apply to every pad). */
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Every writer of a ban that counts calls this right after its row is written. net = a network ban (netban.anyFor knows it). */
function changed(roomId = null, { net = false } = {}) {
  GEN++;
  const id = roomId == null || roomId === "" ? null : String(roomId);
  if (ROOMS && !net) ROOMS.add(id == null ? "" : id);
  for (const fn of listeners) {
    try { const p = fn(id); if (p && typeof p.catch === "function") p.catch((e) => console.error("[listenban] change:", e.message)); }
    catch (e) { console.error("[listenban] change:", e.message); }
  }
}
/** How many bans have been made since this start (changed() calls) - a connect check reads it before and after. */
const gen = () => GEN;

module.exports = { REFUSAL, refusal, refusals, accountBanned, netBanned, refresh, mayApply, madeSince, onChange, changed, gen,
  _setClock: (fn) => { clock = fn || (() => Date.now()); }, _rooms: () => ROOMS, _forget: () => { ROOMS = null; } };
