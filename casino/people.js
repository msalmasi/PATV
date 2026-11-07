// casino/people.js — 1.99ajw casino2 (owner 2026-11-04: "Poker table / casino tables need clickable names with the usual tipping etc."
// and "users could also bring up a chat from the tables"): a table's seats as the Room Dock's person menu needs them, and the pads the
// table belongs to (its 💬 Chat). casino/routes.js serves both:
//   GET /api/casino/t/:id/people   signed-in only, private no-store, RATE_N a minute per account: {ok, pepe, pads, seats}
//   GET /api/casino/t/:id/pads     anyone, the same `pads` (the 💬 Chat control for signed-out viewers too), RATE_N a minute per address
//
// pads = [{room, slug, name, role: home | pushed | advert, chat}] - the live bridged pads of the rooms the table plays in (home first, then
// the pushed ones), then the rooms it is advertised in (a web-only table is often only advertised - the owner's table of 2026-11-04 was);
// chat = the pad chat window's own gate says yes for this viewer (bridge.chatGate: the bridge perk, members-tier access, the 18+ gate, the
// Room Dock), so the control only offers a chat that would open. tablechat (owner 2026-11-07): chat = the TABLE CHAT's gate (casino/
// chatpads.js gate - chatGate and not banned from that pad; the frame's embed asks the same), and the 💬 Chat's picker offers every other
// pad's chat the viewer may open too (GET /api/casino/t/:id/chatpads) - these stay on top of it.
//
// seats = {<seat hash>: person} (the seat hash = the table view's `seat`, never an account id):
//   * {me: true, display}                     the viewer's own seat (no menu)
//   * {bot: true, display, patv}              Pepe's account (the casino's own Pepe menu)
//   * {veil: true, display}                   1.99ajw casino2 rework: a MASKED seat (casino/veil.js - veiled on the bridge: the seat's
//                                             Camfrog login, the linked login or the account key hidden / incognito; a masked seat session;
//                                             fails closed while the hidden sets load), keyed by the masked seat's own id - its label
//                                             (a frog name or "someone") and nothing else: no account, no login, no tip, no avatar
//                                             (1.99akb casmask gap b: + bk: 1 on a FROG-NAMED seat for a signed-in viewer - the menu's
//                                             🚫 Block, {k:'cseat'}, personref.js; + vb: 1 when the viewer frog-blocked that person -
//                                             its ✅ Unblock instead. A "someone" seat: neither - review fix)
//   * {display, web: true, patv, tip?}       a web seat - its PATV name only (1.99ajf: a PATV name never maps to a Camfrog login)
//   * {display, patv, tip?, login?, pad?}     a room seat: its login ONLY when it is a NAMED member of a live bridged pad the table plays in
//                                             or advertises in (its own room first) THAT THE VIEWER MAY OPEN (padaccess.full + the 18+
//                                             gate - the roster's own gate: who is in an Approved / 18+ pad's room now is never told to
//                                             someone outside it), with pad = {slug, member: true, mod, pvp}: mod =
//                                             padmod.viewMod(R, viewer's login) (Pepe's powers for this viewer there - the server and Pepe
//                                             re-check every action), pvp = {duel, brawl} when the viewer is linked and the room's web
//                                             commands offer them (the chat's pvpFor re-checks, Pepe's escrow decides)
// The seat keys are the table view's (veil.seatOf: the account's seat hash, a masked seat's own id). The answer also carries the viewer's
// own named blocks (blocks.pageList - the person menu's ✅ Unblock, as liveView's `blk` does on a pad).
// tip = bridge.tipFor's rule: never yourself, never Pepe; {to, href: /u/<name>/tip}. patv = {username, style?, flair?}: their name's
// cosmetic style (cosmetics.nameStyle) and, on a pad seat, their flair in that pad (padflair) - the Dock's header shows both.
"use strict";
const { getQuery } = require("../dbUtils");

const RATE_N = 30, RATE_MS = 60 * 1000;     // (a click with an answer older than a few seconds asks again - casino-ui.js)
const hits = new Map();               // key -> [ms]
let clock = () => Date.now();
function rateOk(key) {
  const now = clock();
  const q = (hits.get(key) || []).filter((t) => now - t < RATE_MS);
  if (q.length >= RATE_N) { hits.set(key, q); return false; }
  q.push(now); hits.set(key, q);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return true;
}
const lc = (s) => String(s == null ? "" : s).toLowerCase();
const B = () => require("../bridge");
const svc = () => require("./service");

/** the table's pads (see the top) for `user` (null = signed out); net = the request's network (netban.reqNet - a network ban; null = unknown) */
async function padsFor(T, user, net = null) {
  const S = svc();
  const list = S.roomsOf(T).map((id, i) => [id, i ? "pushed" : "home"])
    .concat((Array.isArray(T.adverts) ? T.adverts : []).map((id) => [id, "advert"]));
  const out = [], seen = new Set();
  for (const [id, role] of list) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const R = B().liveBridged(id);
    if (!R) continue;
    let gate = null;
    try { gate = await require("./chatpads").gate(user || null, R.slug, net); } catch (e) { gate = null; }
    const name = (gate && gate.info && gate.info.title) || R.name || id;
    out.push({ room: String(id), slug: (gate && gate.slug) || R.slug, name: String(name).slice(0, 80), role, chat: !!(gate && gate.ok) });
  }
  return out;
}

function tipOf(name, me, pepe) {
  if (!name || !me || !me.userId) return null;
  if (me.username && lc(name) === lc(me.username)) return null;
  if (pepe && lc(name) === pepe) return null;
  return { to: String(name), href: "/u/" + encodeURIComponent(String(name)) + "/tip" };
}

/** the seats of table T as viewer `user` ({userId, username}) gets them (see the top) */
async function seatsFor(T, user, pads) {
  const e = T.eng || {}, keys = Array.isArray(e.seats) ? e.seats.slice(0, 12) : [];
  const out = {};
  if (!keys.length) return out;
  const PEPE_ID = require("../feedstore").PEPE_ID;
  let pepe = null;
  try { pepe = await B().pepeUsername(); } catch (e2) { pepe = null; }
  const ids = keys.concat(user && user.userId ? [user.userId] : []);
  const rows = await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId IN (${ids.map(() => "?").join(",")})`, ids);
  const byId = new Map(rows.map((r) => [String(r.userId), r]));
  const meRow = user && user.userId ? byId.get(String(user.userId)) || null : null;
  const me = meRow ? { userId: String(meRow.userId), username: meRow.username, login: meRow.camfrogUsername || null } : null;
  const padBy = new Map((pads || []).map((p) => [p.room, p]));
  // 1.99ajw casino2 review: a pad's room is told only to a viewer who may open it (padaccess.full + the 18+ gate, as the roster) -
  // an Approved advert pad or an 18+ pad never says who is in its live room now, nor offers ⚔️ Duel there
  const PA = require("../padaccess");
  try { await PA.init(); } catch (e) { /* the gate below fails closed */ }
  const opens = new Map();
  const mayOpen = (rid) => {
    if (!opens.has(rid)) { let ok = false; try { ok = !!PA.full(user || null, rid) && PA.adultGate(user || null, rid) === "ok"; } catch (e) { ok = false; } opens.set(rid, ok); }
    return opens.get(rid);
  };
  const styleOf = (name) => { try { return require("../cosmetics").nameStyle(name) || ""; } catch (e) { return ""; } };
  const flairs = new Map();
  const flairOf = async (rid, name) => {
    if (!flairs.has(rid)) flairs.set(rid, await require("../padflair").byUsername(rid).catch(() => null));
    const F = flairs.get(rid), fl = F && name ? F.get(lc(name)) : null;
    try { return fl ? require("../padflair").plain(fl) : null; } catch (e) { return null; }
  };
  const V = require("./veil");
  // 1.99akb casmask (gap b): the keys behind the frog names this viewer blocked (blocks.veilKeysOf - server only; null when it can't be read:
  // the masked seat's menu then offers 🚫 Block, never ✅ Unblock)
  let vkeys = null;
  if (me) { try { vkeys = await require("../blocks").veilKeysOf(me.userId); } catch (e2) { vkeys = null; } }
  for (const k of keys) {
    const hash = V.seatOf(T, k), p = (T.players || {})[k] || {}, row = byId.get(String(k)) || {};
    const display = String((e.names && e.names[k]) || p.name || row.displayname || row.username || "?").slice(0, 60);
    if (String(k) === PEPE_ID || (pepe && lc(row.username) === pepe)) { out[hash] = { bot: true, display, patv: row.username ? { username: row.username } : null }; continue; }
    // 1.99ajw casino2 rework: a masked seat (the table view's own mask - routes.js re-read it first) is its label and nothing else
    // 1.99akb casmask (gap b): + vb: 1 on a FROG-NAMED masked seat whose person this viewer blocked under a frog name (its menu then offers
    // ✅ Unblock - the same residual the chat's folded frog lines carry: two frog names are the same person, never who). Never on a
    // "someone" seat (one can follow their named seat by moments - C.2 - so it would tie the two).
    if (V.masked(T, k)) {
      if (me && String(k) === me.userId) { out[hash] = { me: true, display: V.label(T, k) }; continue; }
      const lab = V.label(T, k), seat = { veil: true, display: lab };
      // (casmask review: Block / Unblock on a FROG-NAMED seat only - a "someone" seat can be the one a watcher just saw named)
      if (me && lab !== V.SOMEONE) seat.bk = 1;
      if (seat.bk && vkeys && vkeys.size && V.keysOf(String(k), p, row.camfrogUsername || null).some((x) => vkeys.has(x))) seat.vb = 1;
      out[hash] = seat;
      continue;
    }
    if (me && String(k) === me.userId) { out[hash] = { me: true, display }; continue; }
    const room = p.via === "room";
    const login = room && p.camfrog ? String(p.camfrog) : null;
    const person = { display };
    if (row.username) {
      person.patv = { username: row.username };
      const st = styleOf(row.username);
      if (st) person.patv.style = st;
      const tip = tipOf(row.username, me, pepe);
      if (tip) person.tip = tip;
    }
    if (!room || !login) { person.web = true; out[hash] = person; continue; }
    // a room seat: named in a live pad of this table now? (their own room first)
    const order = Array.from(new Set([p.room, ...(pads || []).map((x) => x.room)].filter(Boolean)));
    for (const rid of order) {
      const R = B().liveBridged(rid), pad = padBy.get(rid);
      if (!R || !pad || !mayOpen(rid)) continue;
      const named = (R.members || []).some((m) => m && m.login && !m.anon && !m.veil && lc(m.login) === lc(login));
      if (!named) continue;
      person.login = login;
      const mine = me && me.login ? me.login : null;
      const cmds = R.relay && R.cmds && typeof R.cmds === "object" ? R.cmds : null;
      const has = (c) => !!(cmds && Object.prototype.hasOwnProperty.call(cmds, c));
      const pvp = mine && lc(mine) !== lc(login) && (has("!duel") || has("!brawl")) ? { duel: has("!duel"), brawl: has("!brawl") } : null;
      let mod = null;
      try { mod = mine ? require("../padmod").viewMod(R, mine) : null; } catch (e3) { mod = null; }
      person.pad = { slug: pad.slug, member: true, mod, pvp };
      if (person.patv) { const fl = await flairOf(rid, row.username); if (fl) person.patv.flair = fl; }
      break;
    }
    if (!person.login) person.web = true;          // (not in a pad of this table right now: profile + tip, as for a web seat)
    out[hash] = person;
  }
  return out;
}

/** 1.99ajw casino2 rework: the viewer's own named blocks (blocks.pageList; null when it can't be read - the menu then offers 🚫 Block) */
async function blocksOf(user) {
  if (!user || !user.userId) return null;
  try { return await require("../blocks").pageList(user.userId); } catch (e) { return null; }
}

async function pepeInfo() {
  let username = null;
  try { username = await B().pepeUsername(); } catch (e) { username = null; }
  let pad = null;
  try { const sr = B().stageRoom(); pad = sr && sr.slug ? "/p/" + encodeURIComponent(sr.slug) : null; } catch (e) { pad = null; }
  return { username, pad };
}

module.exports = { padsFor, seatsFor, pepeInfo, blocksOf, rateOk, RATE_N, RATE_MS, _reset: () => hits.clear(), _setClock: (f) => { clock = f || (() => Date.now()); } };
