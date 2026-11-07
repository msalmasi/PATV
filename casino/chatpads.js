// casino/chatpads.js — tablechat (owner 2026-11-07: "Also for poker table chats, let users pull up any pad chats regardless if its been
// advertised or added to a room chat"): a casino table's 💬 Chat may open ANY pad's chat the viewer may open - not only the table's own.
//
// Before (1.99ajw casino2, casino/people.js padsFor): the 💬 Chat offered only the live bridged pads of the rooms the table plays in (its
// home room, then the rooms it was pushed to) and the rooms it is advertised in, each with chat = bridge.chatGate for this viewer.
//
// gate(user, slug, net)    THE TABLE CHAT'S GATE: bridge.chatGate (the chat window's own - a live bridged Camfrog pad, its bridge perk,
//                          padaccess.full: public / members / approved members, the 18+ gate - and the Room Dock for this viewer) AND not
//                          banned from that pad (listenban.refusal: a pad ban, a whole-bridge block, a login ban, a network ban - what stops
//                          someone hearing its room audio; never a one-feature block, never an incognito ban: THE VEIL RULE). The chat
//                          EMBED (bridge.js GET /p/:slug/chat?embed=1 - the frame beside the table) asks this, so the page's pad id is never
//                          trusted: whatever the picker or a crafted frame asks for opens only through it. padsFor's `chat` is this gate.
//                          A ban lookup that fails lets them in, as the room audio's connect check does (the pad page shows that chat to a
//                          banned viewer anyway - the ban is about posting and listening, which the chat's own routes refuse again).
// list(T, user, opts)      the picker: [{room, slug, name, role, count}] - the table's own pads first (home, pushed, advert: as before), then
//                          the viewer's recent ones (opts.recent: slugs the page remembers, each checked here again), then every other live
//                          bridged pad - most people in the room first, then by name. Every one passes gate(). UNLISTED pads (rooms.isListed
//                          false: reached by their address only) are left out unless the viewer manages that pad or it is one of the
//                          table's; a recent slug from the page never reaches one.
// one(T, user, slug, net)  one pad by its exact address - "p/<address>" typed in the picker, the chat that follows the tab - or null. An
//                          address reaches an unlisted pad (role "address"), as typing p/<address> does; nothing else is looked up by name.
// more(T, user, pads)      are there pads beyond the table's own that this viewer's chat could open? (the 💬 Chat shows with no table pad;
//                          memory only - the list applies the bans)
// The search box filters the list in the page; only a full address is ever sent here.
"use strict";

const RATE_N = 40, RATE_MS = 60 * 1000, MAX = 200, RECENT_MAX = 8;
const hits = new Map();
let clock = () => Date.now();
function rateOk(key) {
  const now = clock();
  const q = (hits.get(key) || []).filter((t) => now - t < RATE_MS);
  if (q.length >= RATE_N) { hits.set(key, q); return false; }
  q.push(now); hits.set(key, q);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return true;
}
const B = () => require("../bridge");
const TABLE_ROLES = new Set(["home", "pushed", "advert"]);

/** an address as typed or pasted (night-orchard, p/night-orchard, https://publicaccess.tv/p/night-orchard?x) -> its slug, or null */
function addressOf(raw) {
  let s = String(raw == null ? "" : raw).trim().toLowerCase().slice(0, 300);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/, "").replace(/[?#].*$/, "").replace(/^\/+/, "").replace(/^p\//, "").replace(/\/+$/, "");
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(s) ? s : null;
}

let failLog = 0;
/** banned from pad `roomId` (listenban: pad ban, whole-bridge block, login ban, network ban)? A failed lookup: no (logged at most a minute) */
async function banned(roomId, user, net) {
  try { return !!(await require("../listenban").refusal({ roomId, user: user && user.userId ? user : null, net: net || null })); }
  catch (e) {
    if (clock() - failLog > 60e3) { failLog = clock(); console.error("[casino] tablechat: a ban check failed - let in:", e.message); }
    return false;
  }
}
/** the same question for several pads at once (the picker's list: one lookup per ban table, listenban.refusals) -> Set of the banned ids */
async function bannedIn(roomIds, user, net) {
  const ids = roomIds.map(String);
  if (!ids.length) return new Set();
  const uid = user && user.userId ? String(user.userId) : null;
  try {
    const r = await require("../listenban").refusals(ids.map((roomId) => ({ roomId, userId: uid, net: net || null })));
    return new Set(ids.filter((id, i) => r[i]));
  } catch (e) {
    if (clock() - failLog > 60e3) { failLog = clock(); console.error("[casino] tablechat: a ban check failed - let in:", e.message); }
    return new Set();
  }
}
/** the table chat's gate (see the top) -> bridge.chatGate's {ok, R, info, slug, platform} (ok false when banned) */
async function gate(user, slug, net) {
  const g = await B().chatGate(user || null, slug);
  if (!g.ok) return g;
  if (await banned(g.R.id, user, net)) return { ok: false, R: null, info: g.info, slug: g.slug, platform: g.platform };
  return g;
}

const entry = (R, g, role) => ({ room: String(R.id), slug: g.slug || R.slug, name: String((g.info && g.info.title) || R.name || R.id).slice(0, 80), role,
                                 count: Math.max(0, Number(R.count) || 0) });
/** may this viewer's list carry pad R at all? (unlisted: only its managers' - the table's own are asked separately) */
async function listable(R, user) {
  const rooms = require("../rooms");
  if (rooms.isListed(R.id)) return true;
  try { return await rooms.canManage(user || null, R.id); } catch (e) { return false; }
}

/** every live bridged pad (room map order) */
function liveRooms() {
  const out = [];
  for (const R of B()._rooms.values()) if (B().liveBridged(R.id) === R) out.push(R);
  return out;
}

async function list(T, user, { net = null, recent = [] } = {}) {
  await B().load();
  const people = require("./people");
  const own = (await people.padsFor(T, user, net)).filter((p) => p.chat);
  const out = [], seen = new Set();
  const byId = new Map(liveRooms().map((R) => [String(R.id), R]));
  for (const p of own) {
    const R = byId.get(String(p.room));
    if (!R || seen.has(String(R.id))) continue;
    seen.add(String(R.id));
    out.push({ room: p.room, slug: p.slug, name: p.name, role: p.role, count: Math.max(0, Number(R.count) || 0) });
  }
  // the others: each through the gate, then the bans for all of them at once
  const rest = [];
  for (const R of byId.values()) {
    if (seen.has(String(R.id))) continue;
    if (!(await listable(R, user))) continue;
    const g = await B().chatGate(user || null, R.slug);
    if (!g.ok || g.R !== R) continue;
    rest.push({ R, g });
  }
  const bans = await bannedIn(rest.map((x) => x.R.id), user, net);
  const ok = rest.filter((x) => !bans.has(String(x.R.id)));
  const want = [];
  for (const s of (Array.isArray(recent) ? recent : []).slice(0, RECENT_MAX)) { const a = addressOf(s); if (a && !want.includes(a)) want.push(a); }
  const recents = [];
  for (const a of want) {
    const R = B().bySlug(a);
    const x = R && ok.find((y) => y.R === R);
    if (x && !recents.includes(x)) recents.push(x);
  }
  for (const x of recents) out.push(entry(x.R, x.g, "recent"));
  const others = ok.filter((x) => !recents.includes(x)).map((x) => entry(x.R, x.g, "pad"))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug));
  return out.concat(others).slice(0, MAX);
}

async function one(T, user, raw, net) {
  const a = addressOf(raw);
  if (!a) return null;
  await B().load();
  const R = B().bySlug(a);
  if (!R || B().liveBridged(R.id) !== R) return null;
  const g = await gate(user, a, net);
  if (!g.ok || g.R !== R) return null;
  const own = (await require("./people").padsFor(T, user, net)).find((p) => p.chat && String(p.room) === String(R.id));
  const role = own ? own.role : require("../rooms").isListed(R.id) ? "pad" : "address";
  return entry(R, g, role);
}

async function more(T, user, pads) {
  await B().load();
  const mine = new Set((pads || []).filter((p) => p.chat).map((p) => String(p.room)));
  for (const R of liveRooms()) {
    if (mine.has(String(R.id))) continue;
    if (!(await listable(R, user))) continue;
    const g = await B().chatGate(user || null, R.slug);
    if (g.ok && g.R === R) return true;
  }
  return false;
}

module.exports = { gate, banned, bannedIn, list, one, more, addressOf, rateOk, TABLE_ROLES, RATE_N, RATE_MS,
  _reset: () => hits.clear(), _setClock: (f) => { clock = f || (() => Date.now()); } };
