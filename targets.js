// targets.js - 1.99?? padppl: the ONE resolver for a TYPED moderation name (owner, 2026-11-04: "Someone created a PATV username that's the
// same username as a Camfrog user (tricon) in order to harass. So when I try to ban 'tricon' from the bridge, it autoresolved to Tricon's
// PATV username."). Before this, four resolvers disagreed: bridgeblocks.resolveTarget tried the chat login first, rooms.findUser and
// accountsadmin.findUser the username first, mainstage.ban the username only - so the same word hit different people, and nobody was
// asked which one was meant. Now every typed name goes through resolve():
//
//   u:<id>              that account, exactly
//   @name  🌐name       a PATV USERNAME only (users.username, case-insensitive)
//   cf:<login>          a Camfrog LOGIN only: the account linked to it (a real account before a CF auto one), else - when allowed - the
//                       login itself (a website ban that waits for it to link an account)
//   a bare name         every identity it could mean: the account with that username, the account linked to that login, and (allowLogin)
//                       a Camfrog login Pepe has seen that no account is linked to. ONE distinct identity -> it (a username equal to that
//                       account's own linked login is one person). MORE than one -> {ambiguous: true, choices, error} - never a guess:
//                       "'tricon' is two people: Camfrog login tricon (PATV @TriconOG) and the PATV account 🌐tricon. Say cf:tricon or
//                       🌐tricon." (written for Pepe's room reply too: <= 200 characters; his _bb_site prints the site's error text)
//
// resolve(raw, {allowLogin}) -> {userId, username, login, kind: "account" | "login"} | {ambiguous, choices: [{ref, kind, label}], error} | {error}
"use strict";
const { getQuery } = require("./dbUtils");
const PR = require("./personref");

const WEB_MARK = "\u{1f310}";
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/i;
const NAME_RE = /^[\w.\-$]{1,48}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

const out = (r, kind = "account") => ({ userId: String(r.userId), username: r.username, login: r.camfrogUsername || null, kind });

/** Has Pepe seen this Camfrog login (cfnames.js when it's there; else the chat log / stats)? Never throws. */
async function seenLogin(login) {
  try { const CF = require("./cfnames"); if (CF && typeof CF.seen === "function") return await CF.seen(login); } catch (e) { /* no cfnames yet */ }
  for (const [sql, args] of [["SELECT 1 FROM camfrog_userstats WHERE login = ? LIMIT 1", [low(login)]], ["SELECT 1 FROM chat_log WHERE who = ? LIMIT 1", [low(login)]]]) {
    try { if ((await getQuery(sql, args))[0]) return true; } catch (e) { /* no such table */ }
  }
  return false;
}

async function resolve(raw, { allowLogin = false } = {}) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return { error: "Who? Give a name." };
  const m = ACCT_RE.exec(s);
  if (m) { const a = await PR.accountById(m[1]); return a ? out(a) : { error: "No PATV account has that id." }; }
  let only = null;
  if (s.startsWith(WEB_MARK)) { s = s.slice(WEB_MARK.length).trim(); only = "user"; }
  else if (s.startsWith("@")) { s = s.slice(1).trim(); only = "user"; }
  else if (/^cf:/i.test(s)) { s = s.slice(3).trim(); only = "login"; }
  if (only === "user") {
    if (!NAME_RE.test(s)) return { error: "That isn't a name." };
    const a = await PR.accountByUsername(s);
    return a ? out(a) : { error: `No PATV account called ${s}.` };
  }
  if (!LOGIN_RE.test(s) && !(only === null && NAME_RE.test(s))) return { error: "That isn't a name." };
  const byLogin = LOGIN_RE.test(s) ? await PR.linkedAccount(s) : null;
  if (only === "login") {
    if (byLogin) return out(byLogin, "login");
    if (allowLogin && LOGIN_RE.test(s)) return { userId: null, username: null, login: low(s), kind: "login" };
    return { error: `No PATV account is linked to the Camfrog login ${s}.` };
  }
  const byName = await PR.accountByUsername(s);
  const cands = [];
  if (byLogin) cands.push({ id: String(byLogin.userId), ref: "cf:" + s, kind: "login", label: `Camfrog login ${low(s)} (PATV @${byLogin.username})`, acc: byLogin });
  if (byName && (!byLogin || String(byName.userId) !== String(byLogin.userId))) {
    cands.push({ id: String(byName.userId), ref: WEB_MARK + byName.username, kind: "account", label: `the PATV account ${WEB_MARK}${byName.username}`, acc: byName });
  }
  if (!byLogin && allowLogin && LOGIN_RE.test(s) && (await seenLogin(s))) {
    cands.push({ id: null, ref: "cf:" + s, kind: "login", label: `Camfrog login ${low(s)} (not on PATV)`, login: low(s) });
  }
  if (!cands.length) return { error: `No PATV account called ${s}.` };
  if (cands.length === 1) {
    const c = cands[0];
    return c.acc ? out(c.acc, c.kind) : { userId: null, username: null, login: c.login, kind: "login" };
  }
  const say = cands.map((c) => c.ref).join(" or ");
  const error = `'${s}' is ${cands.length === 2 ? "two" : cands.length} people: ${cands.map((c) => c.label).join(" and ")}. Say ${say}.`.slice(0, 200);
  return { ambiguous: true, error, choices: cands.map((c) => ({ ref: c.ref, kind: c.kind, label: c.label })) };
}

module.exports = { resolve, seenLogin, WEB_MARK };
