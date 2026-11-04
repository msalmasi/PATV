// personref.js - 1.99?? padppl: WHO a person menu means, resolved EXACTLY from what the viewer clicked - never by re-reading a
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
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername FROM users WHERE lower(username) = ?${await live()} LIMIT 1`, [low(name)]))[0] || null;
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
  return null;
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
  if (!R) return { error: "Which pad?" };
  if (ref.k === "veil") {
    const e = [...(R.members || []), ...(R.mic || [])].find((x) => x && x.anon && x.id === ref.id && x._vz);
    if (!e) return { error: "They aren't in the room any more." };
    const who = await ofVz(e._vz);
    return { kind: "veil", ...who, label: String(e.alias || "someone").slice(0, 60), hood: e.hood || null, veil: true };
  }
  // a veiled line
  const it = (R.feed || []).find((x) => x && Number(x.c) === ref.c);
  let vz = it && it._vz ? it._vz : null;
  if (!vz) {
    try { const r = await require("./bridge").revealLookup(R.id, ref.c); vz = r && r.vz ? r.vz : null; } catch (e) { vz = null; }
  }
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

module.exports = { resolve, clean, pageSafe, linkedAccount, accountById, accountByUsername, ofVz, LOGIN_RE, ACCT_RE, VEIL_ID_RE };
