// personref.js - 1.99ajn padppl: WHO a person menu means, resolved EXACTLY from what the viewer clicked - never by re-reading a
// typed name. The page sends the reference its row / line carries; each kind resolves only as itself (no fallback to another kind):
//
//   {k: "login", v}        a Camfrog login from a roster row or a named line -> that login + its LIVE linked account (the
//                          bridge's rule, userlinks.resolve: users.camfrogUsername only, a real account before a CF auto one,
//                          archived never). Never users.username: a PATV account NAMED like the login is someone else (tricon).
//   {k: "acct", v: "u:<id>"} a web line's account key -> that account.
//   {k: "user", v}         a 🌐 people-list row (its PATV username) -> users.username exactly, never a Camfrog login.
//   {k: "veil", id}        a veiled roster / mic entry by its opaque id (veil.opaqueId) -> the identity on that entry's
//                          non-enumerable _vz (this room's snapshot only).
//   {k: "line", c}         a veiled chat line by its feed row -> bridge.revealLookup (the live item's _vz first, then
//                          chat_log_veil; this room only).
//   {k: "cseat", t, s}     1.99?? casmask (the 1.99ajw verifier's gap b): a MASKED seat at a site casino table by the masked seat's
//                          own id (casino/veil.js seatOf - never the account's seat hash) -> the account / login behind it, read from
//                          the table in memory (a seat that is no longer masked or no longer there: "They aren't at the table any
//                          more."). No pad: anyone signed in may watch a table.
//
// resolve(ref, {R}) -> {kind: "account" | "login" | "veil", userId | null, username | null, login | null, label, veil: bool} | {error}
// A veiled result's real identity is for the SERVER only: callers never send userId / username / login of a veil to a page.
"use strict";
const { getQuery } = require("./dbUtils");

const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/i;
const NAME_RE = /^[\w.\-$]{1,48}$/;
const VEIL_ID_RE = /^v-[A-Za-z0-9_-]{6,20}$/;
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

let archivedCol = null;
async function live() {
  if (archivedCol === null) {
    try { archivedCol = (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { archivedCol = false; }
  }
  return archivedCol ? " AND archived_at IS NULL" : "";
}
const isAuto = (name) => { try { return require("./autoaccount").isAutoName(name, { anyCase: true }); } catch (e) { return /^cf/i.test(String(name || "")); } };

/** The live account linked to Camfrog login `login` (a real account before a CF auto one), or null. */
async function linkedAccount(login) {
  const l = low(login);
  if (!LOGIN_RE.test(l)) return null;
  const rows = await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE lower(camfrogUsername) = ?${await live()} LIMIT 5`, [l]);
  rows.sort((a, b) => (isAuto(a.username) ? 1 : 0) - (isAuto(b.username) ? 1 : 0));
  return rows[0] || null;
}
async function accountById(id) {
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE userId = ?${await live()}`, [String(id || "")]))[0] || null;
}
async function accountByUsername(name) {
  // (1.99ajn padppl verify: a legacy pair of usernames that differ only in case - the exact spelling the row carried wins, as sign-in does)
  const v = String(name == null ? "" : name).trim();
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE lower(username) = ?${await live()} ORDER BY (username = ?) DESC LIMIT 1`,
    [low(v), v]))[0] || null;
}
const disp = (r) => { try { return require("./displaynames").usable(r.displayname) || r.username; } catch (e) { return r.displayname || r.username; } };
const acctOut = (r, kind = "account", extra = {}) => ({ kind, userId: String(r.userId), username: r.username, login: r.camfrogUsername || null,
  label: disp(r), veil: false, ...extra });

/** A veil's real identity (_vz {login, display}) -> {userId, username, login} (login null for an account key). */
async function ofVz(vz) {
  if (!vz || !vz.login) return { userId: null, username: null, login: null };
  const m = ACCT_RE.exec(String(vz.login));
  if (m) { const a = await accountById(m[1]); return { userId: a ? String(a.userId) : null, username: a ? a.username : null, login: a && a.camfrogUsername ? a.camfrogUsername : null }; }
  const a = await linkedAccount(vz.login);
  return { userId: a ? String(a.userId) : null, username: a ? a.username : null, login: low(vz.login) };
}

/** The ref a page sent -> a clean ref, or null. */
function clean(ref) {
  if (!ref || typeof ref !== "object") return null;
  const k = String(ref.k || "");
  if (k === "login") { const v = String(ref.v || "").trim(); return LOGIN_RE.test(v) && !ACCT_RE.test(v) ? { k, v } : null; }
  if (k === "acct") { const v = String(ref.v || "").trim(); return ACCT_RE.test(v) ? { k, v } : null; }
  if (k === "user") { const v = String(ref.v || "").trim().replace(/^@/, ""); return NAME_RE.test(v) ? { k, v } : null; }
  if (k === "veil") { const id = String(ref.id || "").trim(); return VEIL_ID_RE.test(id) ? { k, id } : null; }
  if (k === "line") { const c = Math.floor(Number(ref.c)); return c > 0 ? { k, c } : null; }
  if (k === "cseat") {
    const t = String(ref.t || "").trim(), s = String(ref.s || "").trim();
    return CSEAT_T_RE.test(t) && CSEAT_S_RE.test(s) ? { k, t, s } : null;
  }
  return null;
}
const CSEAT_T_RE = /^[0-9a-f]{10}$/, CSEAT_S_RE = /^v[0-9a-f]{11}$/;
/** 1.99?? casmask: a masked casino seat -> {kind: "veil", userId, username, login, label, room} | {error} (see the top) */
async function ofCasinoSeat(ref) {
  const gone = { error: "They aren't at the table any more." };
  let T = null, V = null;
  try { T = require("./casino/service").getTable(ref.t); V = require("./casino/veil"); } catch (e) { return gone; }
  if (!T || !T.eng || !Array.isArray(T.eng.seats)) return gone;
  const uid = T.eng.seats.map(String).find((u) => V.masked(T, u) && V.seatOf(T, u) === ref.s);
  if (!uid) return gone;
  const p = (T.players || {})[uid] || {};
  const a = await accountById(uid);
  const login = p.via === "room" && p.camfrog ? low(p.camfrog) : a && a.camfrogUsername ? low(a.camfrogUsername) : null;
  return { kind: "veil", userId: a ? String(a.userId) : String(uid), username: a ? a.username : null, login: login && LOGIN_RE.test(login) ? login : null,
           label: String(V.label(T, uid) || "someone").slice(0, 60), room: T.room ? String(T.room) : null, veil: true };
}

async function resolve(raw, { R = null } = {}) {
  const ref = clean(raw);
  if (!ref) return { error: "Who? Pick someone from the list." };
  if (ref.k === "login") {
    const a = await linkedAccount(ref.v);
    if (a) return acctOut(a, "login", { login: low(ref.v) });
    return { kind: "login", userId: null, username: null, login: low(ref.v), label: ref.v, veil: false };
  }
  if (ref.k === "acct") {
    const a = await accountById(ACCT_RE.exec(ref.v)[1]);
    return a ? acctOut(a) : { error: "That account isn't here any more." };
  }
  if (ref.k === "user") {
    const a = await accountByUsername(ref.v);
    return a ? acctOut(a) : { error: "That account isn't here any more." };
  }
  if (ref.k === "cseat") return ofCasinoSeat(ref);
  if (!R) return { error: "Which pad?" };
  if (ref.k === "veil") {
    const e = [...(R.members || []), ...(R.mic || [])].find((x) => x && x.anon && x.id === ref.id && x._vz);
    if (!e) return { error: "They aren't in the room any more." };
    const who = await ofVz(e._vz);
    return { kind: "veil", ...who, label: String(e.alias || "someone").slice(0, 60), hood: e.hood || null, veil: true };
  }
  // a veiled line - ALWAYS through bridge.revealLookup (1.99ajn padppl review fix: its rules - a line taken down, its speaker left out by
  // forget-me / deletion / a staff removal, its identity row gone - apply to the live item too, never the raw in-memory _vz)
  const it = (R.feed || []).find((x) => x && Number(x.c) === ref.c);
  let vz = null;
  try { const r = await require("./bridge").revealLookup(R.id, ref.c); vz = r && r.vz ? r.vz : null; } catch (e) { vz = null; }
  if (!vz) return { error: "That line isn't here any more." };
  const who = await ofVz(vz);
  const label = it && it.u && it.u.alias ? String(it.u.alias).slice(0, 60) : "someone";
  return { kind: "veil", ...who, label, hood: it && it.u && it.u.hood ? it.u.hood : null, veil: true };
}

/** What a page may be told about a resolved person: never a veil's identity. */
function pageSafe(p) {
  if (!p || p.error) return p;
  if (p.veil) return { kind: "veil", label: p.label, veil: true };
  return { kind: p.kind, username: p.username || null, login: p.login || null, label: p.label, veil: false };
}

/** 1.99ajn padppl review fix: may `viewer` ({userId, class}) point at a veiled row / line of pad R (its full access - a private pad's
 *  frog names stay out of reach of people who can't see it)? Named refs need no pad. Fails closed. */
async function padOk(raw, viewer, R) {
  const ref = clean(raw);
  if (ref && ref.k === "cseat") return !!(viewer && viewer.userId);       // (1.99?? casmask: a casino table - no pad, signed in only)
  if (!ref || (ref.k !== "veil" && ref.k !== "line")) return true;
  if (!R || !R.id || !viewer || !viewer.userId) return false;
  try { const PA = require("./padaccess"); if (PA.init) await PA.init(); return !!PA.full({ userId: viewer.userId, class: viewer.class }, R.id); } catch (e) { return false; }
}

module.exports = { resolve, clean, pageSafe, padOk, linkedAccount, accountById, accountByUsername, ofVz, LOGIN_RE, ACCT_RE, VEIL_ID_RE };
