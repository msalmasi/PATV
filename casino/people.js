// casino/people.js — 1.99?? casino2 (owner 2026-11-04: "Poker table / casino tables need clickable names with the usual tipping etc."
// and "users could also bring up a chat from the tables"): a table's seats as the Room Dock's person menu needs them, and the pads the
// table belongs to (its 💬 Chat). casino/routes.js serves both:
//   GET /api/casino/t/:id/people   signed-in only, private no-store, RATE_N a minute per account: {ok, pepe, pads, seats}
//   GET /api/casino/t/:id/pads     anyone, the same `pads` (the 💬 Chat control for signed-out viewers too), RATE_N a minute per address
//
// pads = [{room, slug, name, role: home | pushed | advert, chat}] - the live bridged pads of the rooms the table plays in (home first, then
// the pushed ones), then the rooms it is advertised in (a web-only table is often only advertised - the owner's table of 2026-11-04 was);
// chat = the pad chat window's own gate says yes for this viewer (bridge.chatGate: the bridge perk, members-tier access, the 18+ gate, the
// Room Dock), so the control only offers a chat that would open.
//
// seats = {<seat hash>: person} (the seat hash = the table view's `seat`, never an account id):
//   * {me: true, display}                     the viewer's own seat (no menu)
//   * {bot: true, display, patv}              Pepe's account (the casino's own Pepe menu)
//   * {veil: true}                            hidden on the bridge NOW (the seat's Camfrog login, a web seat's linked login or its
//                                             account key: the site's one reader rule + the chat's own view, incognito on) - nothing
//                                             else: no account, no login, no tip (fails closed while the hidden sets load)
//   * {display, web: true, patv, tip?}        a web seat - its PATV name only (1.99ajf: a PATV name never maps to a Camfrog login)
//   * {display, patv, tip?, login?, pad?}     a room seat: its login ONLY when it is a NAMED member of a live bridged pad the table plays in
//                                             or advertises in (its own room first), with pad = {slug, member: true, mod, pvp}: mod =
//                                             padmod.viewMod(R, viewer's login) (Pepe's powers for this viewer there - the server and Pepe
//                                             re-check every action), pvp = {duel, brawl} when the viewer is linked and the room's web
//                                             commands offer them (the chat's pvpFor re-checks, Pepe's escrow decides)
// tip = bridge.tipFor's rule: never yourself, never Pepe; {to, href: /u/<name>/tip}.
"use strict";
const { getQuery } = require("../dbUtils");

const RATE_N = 20, RATE_MS = 60 * 1000;
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

/** hidden on the bridge now (padweb's rule: quotes.isHidden + chatlogview.isHiddenLogin + hubhidden; fails closed), or incognito on */
async function veiled(key) {
  if (!key) return false;
  const W = require("../padweb");
  try { if (W.hiddenKey(key)) return true; } catch (e) { return true; }
  try { return !!(await W.incognitoOn(key)); } catch (e) { return true; }
}

/** the table's pads (see the top) for `user` (null = signed out) */
async function padsFor(T, user) {
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
    try { gate = await B().chatGate(user || null, R.slug); } catch (e) { gate = null; }
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
  const S = svc(), e = T.eng || {}, keys = Array.isArray(e.seats) ? e.seats.slice(0, 12) : [];
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
  for (const k of keys) {
    const hash = S.uidHash(k), p = (T.players || {})[k] || {}, row = byId.get(String(k)) || {};
    const display = String((e.names && e.names[k]) || p.name || row.displayname || row.username || "?").slice(0, 60);
    if (String(k) === PEPE_ID || (pepe && lc(row.username) === pepe)) { out[hash] = { bot: true, display, patv: row.username ? { username: row.username } : null }; continue; }
    if (me && String(k) === me.userId) { out[hash] = { me: true, display }; continue; }
    const room = p.via === "room";
    const login = room && p.camfrog ? String(p.camfrog) : null;
    let hidden = false;
    for (const key of [login, row.camfrogUsername, "u:" + k]) if (key && await veiled(key)) { hidden = true; break; }
    if (hidden) { out[hash] = { veil: true }; continue; }
    const person = { display };
    if (row.username) {
      person.patv = { username: row.username };
      const tip = tipOf(row.username, me, pepe);
      if (tip) person.tip = tip;
    }
    if (!room || !login) { person.web = true; out[hash] = person; continue; }
    // a room seat: named in a live pad of this table now? (their own room first)
    const order = Array.from(new Set([p.room, ...(pads || []).map((x) => x.room)].filter(Boolean)));
    for (const rid of order) {
      const R = B().liveBridged(rid), pad = padBy.get(rid);
      if (!R || !pad) continue;
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
      break;
    }
    if (!person.login) person.web = true;          // (not in a pad of this table right now: profile + tip, as for a web seat)
    out[hash] = person;
  }
  return out;
}

async function pepeInfo() {
  let username = null;
  try { username = await B().pepeUsername(); } catch (e) { username = null; }
  let pad = null;
  try { const sr = B().stageRoom(); pad = sr && sr.slug ? "/p/" + encodeURIComponent(sr.slug) : null; } catch (e) { pad = null; }
  return { username, pad };
}

module.exports = { padsFor, seatsFor, pepeInfo, rateOk, RATE_N, RATE_MS, _reset: () => hits.clear(), _setClock: (f) => { clock = f || (() => Date.now()); } };
