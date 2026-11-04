// cfnames.js - 1.99?? padppl: the IMPERSONATION GUARD (owner: someone made a PATV account named like a Camfrog user - "tricon" - to
// harass him). A PATV username is free text with a charset rule; nothing stopped one from taking a Camfrog login Pepe has seen, and the
// only check was at relay time (accountkey.ownsName - only against a LINKED login, and most Camfrog users never link).
//
//   seen(name)           has Pepe seen this Camfrog login? A Set rebuilt every 10 minutes (and on each userstats sync) from
//                        camfrog_userstats.login, users.camfrogUsername (CF auto accounts included) and the live rosters - plus, on a miss,
//                        one indexed probe of the chat archive's chat_log.who / chat_log_veil.login (chatlogdb.read; fails quiet)
//   nameRefusal(n, uid)  why account `uid` (null = a new one) may NOT take username `n`: a seen login that isn't this account's own linked
//                        login. CF auto accounts are exempt (they ARE the login). Logins are already public in Camfrog rooms, so the refusal
//                        reveals nothing new.
//   clashOf(acc, login)  the Camfrog login an account's SHOWN name (username or display name) equals but isn't linked to, or null - the
//                        page's "not the Camfrog user" tag (u.clash) and the /admin/users#nameclash list
// Display names stay free text; bridge.withPatv shows a linked account's PATV display name only when it doesn't clash (see there).
"use strict";
const { getQuery, runQuery } = require("./dbUtils");

const REBUILD_MS = 10 * 60 * 1000, PROBE_TTL = 10 * 60 * 1000, LOGIN_RE = /^[\w.\-]{1,40}$/;
const REFUSAL = "That name belongs to a Camfrog user. If it's yours, link your Camfrog account first (type !verify in a room with Pepe), then you can take it.";
let clock = () => Date.now();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
let SET = new Set(), builtAt = 0, building = null;
const probes = new Map();                 // name -> {hit, at}
const okMarks = new Map();                // "userId|name" -> true (name_clash_ok)

async function init() {
  await runQuery("CREATE TABLE IF NOT EXISTS name_clash_ok (user_id TEXT NOT NULL, name TEXT NOT NULL, by_id TEXT, at INTEGER NOT NULL, PRIMARY KEY (user_id, name))");
}
async function rebuild() {
  if (building) return building;
  building = (async () => {
    const s = new Set();
    const add = (v) => { const l = low(v); if (LOGIN_RE.test(l)) s.add(l); };
    try { for (const r of await getQuery("SELECT login FROM camfrog_userstats LIMIT 200000")) add(r.login); } catch (e) { /* no stats yet */ }
    try { for (const r of await getQuery("SELECT camfrogUsername AS l FROM users WHERE camfrogUsername IS NOT NULL LIMIT 200000")) add(r.l); } catch (e) { /* no users */ }
    try {
      const B = require("./bridge");
      for (const R of (B._rooms && B._rooms.values ? B._rooms.values() : [])) {
        for (const u of [...(R.members || []), ...(R.mic || [])]) if (u && !u.anon && u.login && !/^u:/i.test(u.login)) add(u.login);
      }
    } catch (e) { /* no bridge */ }
    try { await init(); okMarks.clear(); for (const r of await getQuery("SELECT user_id, name FROM name_clash_ok")) okMarks.set(r.user_id + "|" + low(r.name), true); } catch (e) { /* none */ }
    SET = s; builtAt = clock();
  })().finally(() => { building = null; });
  return building;
}
const stale = () => clock() - builtAt > REBUILD_MS;

/** Has Pepe seen Camfrog login `name`? */
async function seen(name) {
  const l = low(name).replace(/^@/, "");
  if (!LOGIN_RE.test(l)) return false;
  if (stale()) { try { await rebuild(); } catch (e) { /* keep the old set */ } }
  if (SET.has(l)) return true;
  const p = probes.get(l);
  if (p && clock() - p.at < PROBE_TTL) return p.hit;
  let hit = false;
  try {
    const CL = require("./chatlogdb");
    hit = !!(await CL.read("SELECT 1 AS x FROM chat_log WHERE who = ? LIMIT 1", [l]))[0] || !!(await CL.read("SELECT 1 AS x FROM chat_log_veil WHERE login = ? LIMIT 1", [l]))[0];
  } catch (e) { hit = false; }
  probes.set(l, { hit, at: clock() });
  if (probes.size > 5000) probes.delete(probes.keys().next().value);
  return hit;
}
/** A live roster just listed these logins (bridge.js ingest) - they count as seen at once. */
function noteLogins(logins) { for (const v of logins || []) { const l = low(v); if (LOGIN_RE.test(l)) SET.add(l); } }

async function linkedLoginOf(userId) {
  if (!userId) return null;
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  return r && r.camfrogUsername ? low(r.camfrogUsername) : null;
}
const isAuto = (name) => { try { return require("./autoaccount").isAutoName(name, { anyCase: true }); } catch (e) { return /^cf/i.test(String(name || "")); } };

/** Why account `userId` (null = a new account) may not take PATV username `name` - null = it may. */
async function nameRefusal(name, userId = null, req = null) {
  const l = low(name);
  if (!LOGIN_RE.test(l) || isAuto(name)) return null;
  if (!(await seen(l))) return null;
  if (userId && (await linkedLoginOf(userId)) === l) return null;              // their own linked login
  if (userId && okMarks.get(String(userId) + "|" + l)) return null;            // an admin marked it OK
  return req && req.t && req.t.has && req.t.has("auth.err.username_camfrog") ? req.t("auth.err.username_camfrog") : REFUSAL;
}

/** The Camfrog login `shown` (an account's username or display name) equals while that account isn't linked to it - or null. Sync:
 *  reads the cached set (callers on the hot path); a stale set still answers. */
function clashOf(userId, username, shown, ownLogin) {
  const own = low(ownLogin);
  for (const v of [shown, username]) {
    const l = low(v);
    if (!l || !LOGIN_RE.test(l) || l === own || isAuto(v)) continue;
    if (SET.has(l) && !okMarks.get(String(userId || "") + "|" + l)) return l;
  }
  if (stale()) rebuild().catch(() => {});
  return null;
}

/** Admins: accounts whose username or usable display name is a seen Camfrog login they aren't linked to (and not marked OK). */
async function clashes() {
  await rebuild();
  const rows = await getQuery("SELECT userId, username, displayname, camfrogUsername, created_at FROM users WHERE archived_at IS NULL LIMIT 200000").catch(() =>
    getQuery("SELECT userId, username, displayname, camfrogUsername, created_at FROM users LIMIT 200000"));
  const out = [];
  for (const r of rows) {
    if (isAuto(r.username)) continue;
    let disp = r.displayname;
    try { disp = require("./displaynames").usable(r.displayname) || ""; } catch (e) { /* raw */ }
    const login = clashOf(r.userId, r.username, disp, r.camfrogUsername);
    if (!login) continue;
    const owner = await require("./personref").linkedAccount(login).catch(() => null);
    out.push({ userId: String(r.userId), username: r.username, display: disp || null, login, linked: r.camfrogUsername || null,
               loginOwner: owner ? owner.username : null, created: r.created_at || null, by: low(r.username) === login ? "username" : "display" });
    if (out.length >= 500) break;
  }
  return out;
}
async function markOk(me, userId, name) {
  await init();
  await runQuery("INSERT OR IGNORE INTO name_clash_ok (user_id, name, by_id, at) VALUES (?, ?, ?, ?)", [String(userId), low(name), String(me.userId), clock()]);
  okMarks.set(String(userId) + "|" + low(name), true);
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "name_clash", { userId: String(userId), username: null }, { op: "ok", name: low(name) }, null);
}

/** Admin rename of a clashing account (usernames.record 'rename:admin' + an inbox notice to them); the new name passes every rule. */
async function adminRename(me, userId, newName) {
  const guard = require("./middleware/authGuard");
  const name = String(newName || "").trim();
  const bad = guard.checkUsername(name) || (await nameRefusal(name, userId));
  if (bad) { const e = new Error(bad); e.status = 400; throw e; }
  if ((await getQuery("SELECT 1 FROM users WHERE lower(username) = lower(?) AND userId != ?", [name, String(userId)])).length) { const e = new Error("That username is taken."); e.status = 409; throw e; }
  const U = require("./usernames");
  if (await U.reservedFor(name, userId)) { const e = new Error("That username belonged to another account."); e.status = 409; throw e; }
  await U.ensure();
  let was = null;
  await require("./dbUtils").tx(async () => {
    was = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(userId)]))[0];
    if (!was) { const e = new Error("No such account."); e.status = 404; throw e; }
    await runQuery("UPDATE users SET username = ? WHERE userId = ?", [name, String(userId)]);
    await U.record(userId, was.username, name, "rename:admin");
  });
  try { await require("./sessions").revokeAll(String(userId), { why: "username changed" }); } catch (e) { /* they sign in again */ }
  try { await require("./inbox").addSafe(String(userId), { kind: "system", title: "Your username changed", body: `An admin changed your username to ${name} because it was the same as a Camfrog user's name.`, link: "/settings/account#account" }); } catch (e) { /* notice only */ }
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "name_clash", { userId: String(userId), username: name }, { op: "rename", from: was.username }, null);
  return { ok: true, username: name };
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[cfnames] init:", e.message));
  const SP = require("./siteperms"), guard = require("./middleware/authGuard");
  const meOf = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] : null);
  const fail = (res, e) => res.status(e && e.status ? e.status : 500).json({ ok: false, error: e && e.status ? e.message : "Something went wrong." });
  app.get("/api/admin/nameclash", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const me = await meOf(req); if (!SP.can(me, "accounts.name_clash")) return res.status(403).json({ ok: false, error: "Admins only." }); res.json({ ok: true, list: await clashes() }); }
    catch (e) { fail(res, e); }
  });
  app.post("/api/admin/nameclash", addUser, require("express").json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    try {
      const me = await meOf(req); if (!SP.can(me, "accounts.name_clash")) return res.status(403).json({ ok: false, error: "Admins only." });
      const b = req.body || {};
      if (b.op === "ok") { await markOk(me, String(b.userId || ""), String(b.name || "")); return res.json({ ok: true }); }
      if (b.op === "rename") return res.json(await adminRename(me, String(b.userId || ""), b.username));
      res.status(400).json({ ok: false, error: "ok or rename" });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, seen, noteLogins, nameRefusal, clashOf, clashes, markOk, adminRename, rebuild, REFUSAL,
  _setClock: (f) => { clock = f; }, _reset: () => { SET = new Set(); builtAt = 0; probes.clear(); okMarks.clear(); }, _add: (l) => SET.add(low(l)) };
