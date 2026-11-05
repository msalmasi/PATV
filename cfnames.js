// cfnames.js - 1.99ajn padppl: the CAMFROG-NAME TAG (owner: someone made a PATV account named like a Camfrog user - "tricon" - to
// harass him). A PATV username is free text with a charset rule, and the only check was at relay time (accountkey.ownsName - only
// against a LINKED login, and most Camfrog users never link).
// 1.99ajw padppl rework (owner 2026-11-04, on the guard that refused such names: "Wouldn't this prevent people legit creating a PATV
// account with their own username? Or a common username he saw on CF? I don't like this part."): NOBODY is refused a name because Pepe
// has seen it on Camfrog - sign-up, rename, Pepe's rename and every OAuth / SSO account creation take it. What stays: the "not the
// Camfrog user" tag wherever such a name shows, the typed-name disambiguation (targets.js, the 409 "which one"), the admin list.
//
//   seen(name)           has Pepe seen this Camfrog login? A Set rebuilt every 10 minutes (and on each userstats sync) from
//                        camfrog_userstats.login, users.camfrogUsername (CF auto accounts included) and the live rosters - plus, on a miss,
//                        one indexed probe of the chat archive's chat_log.who / chat_log_veil.login (chatlogdb.read; fails quiet)
//   nameHint(n, uid)     a gentle, NON-BLOCKING hint after a sign-up / rename whose name is a login Pepe has seen (and isn't the account's
//                        own linked login): "Is <name> your Camfrog name? Link it in Settings so people know it's you." - the same words
//                        whether or not someone else has that login linked (it says nothing about who has it). hintAfter() flashes it.
//   clashOf(acc, login)  the Camfrog login an account's SHOWN name (username or display name) equals but isn't linked to, or null - the
//                        /admin/users#nameclash list, and mentions.js (a typed "@" never alerts a look-alike)
// Display names stay free text; bridge.withPatv SHOWS a clashing name (1.99ajw rework: a linked login's display name too - it used to be
// replaced by the login). dock3 1.99akf (owner 2026-11-05: "it's just confusing"): the pad's "not the Camfrog user" tag is gone - no
// viewer-facing surface carries u.clash any more.
// Review fix (LOOK-ALIKES): a name also clashes when it only LOOKS like a seen login - skeleton(): Unicode compatibility forms folded,
// Cyrillic / Greek letters that look Latin mapped to them, 0 -> o, 1 / I / i / | -> l, rn -> m, vv -> w, and the separators at either end
// dropped ("Тricon", "tric0n", "tricon_", "trlcon" all read as "tricon"). An exact match is checked first; a look-alike never counts against
// the account's OWN linked login (Tricon showing "Tricon" is fine). Admin "Mark OK" marks are kept by account id AND username, so they
// apply to a linked account's display name on pad lines too (bridge.withPatv knows the username, not the id).
"use strict";
const { getQuery, runQuery } = require("./dbUtils");

const REBUILD_MS = 10 * 60 * 1000, PROBE_TTL = 10 * 60 * 1000, LOGIN_RE = /^[\w.\-]{1,40}$/;
// (1.99ajw rework: only the ADMIN rename tool still refuses a seen login - it exists to end a clash, never to make another one)
const REFUSAL = "That name is a Camfrog login Pepe has seen - pick another, or Mark OK instead.";
const HINT = "Is {name} your Camfrog name? Link it in Settings so people know it's you.";
let clock = () => Date.now();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
let SET = new Set(), SKEL = new Map(), builtAt = 0, building = null;
// the look-alike folding (see the header) - a small table, enough for the letters people use to pass for a Latin name
const CONF = { "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j",
  "\u0455": "s", "\u04bb": "h", "\u0501": "d", "\u0261": "g", "\u0442": "t", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u0432": "b", "\u0433": "r",
  "\u03bf": "o", "\u03b1": "a", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c1": "p", "\u03c4": "t", "\u03c5": "u", "\u03c7": "x" };
const SK_MEMO = new Map();
function skeleton(v) {
  const raw = String(v == null ? "" : v);
  const m = SK_MEMO.get(raw);
  if (m !== undefined) return m;
  const out = skel(raw);
  SK_MEMO.set(raw, out);
  if (SK_MEMO.size > 20000) SK_MEMO.clear();
  return out;
}
function skel(raw) {
  let x = raw.normalize("NFKC").toLowerCase();
  x = Array.from(x).map((ch) => CONF[ch] || ch).join("");
  x = x.replace(/0/g, "o").replace(/[1i|!]/g, "l").replace(/rn/g, "m").replace(/vv/g, "w").replace(/^[._\-]+|[._\-]+$/g, "");
  return x;
}
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
    try {
      await init(); okMarks.clear();
      for (const r of await getQuery("SELECT o.user_id, o.name, u.username FROM name_clash_ok o LEFT JOIN users u ON u.userId = o.user_id")) {
        okMarks.set(r.user_id + "|" + low(r.name), true);
        if (r.username) okMarks.set("@" + low(r.username) + "|" + low(r.name), true);
      }
    } catch (e) { /* none */ }
    const k = new Map();
    for (const l of s) { const sk = skeleton(l); if (!sk) continue; const a = k.get(sk); if (a) { if (a.length < 8) a.push(l); } else k.set(sk, [l]); }
    SET = s; SKEL = k; builtAt = clock();
  })().finally(() => { building = null; });
  return building;
}
const stale = () => clock() - builtAt > REBUILD_MS;

/** Has Pepe seen Camfrog login `name`? `veil: false` (1.99ajw padppl verify - the sign-up hint) leaves out the logins behind veiled
 *  lines (chat_log_veil): a login only ever seen incognito / hidden never answers "seen" to someone who types it as a new name. */
async function seen(name, { veil = true } = {}) {
  const l = low(name).replace(/^@/, "");
  if (!LOGIN_RE.test(l)) return false;
  if (stale()) { try { await rebuild(); } catch (e) { /* keep the old set */ } }
  if (SET.has(l)) return true;
  const key = veil ? l : l + "|nv";
  const p = probes.get(key);
  if (p && clock() - p.at < PROBE_TTL) return p.hit;
  let hit = false;
  try {
    const CL = require("./chatlogdb");
    hit = !!(await CL.read("SELECT 1 AS x FROM chat_log WHERE who = ? LIMIT 1", [l]))[0] || (veil && !!(await CL.read("SELECT 1 AS x FROM chat_log_veil WHERE login = ? LIMIT 1", [l]))[0]);
  } catch (e) { hit = false; }
  probes.set(key, { hit, at: clock() });
  if (probes.size > 5000) probes.delete(probes.keys().next().value);
  return hit;
}
/** A live roster just listed these logins (bridge.js ingest) - they count as seen at once. */
function noteLogins(logins) {
  for (const v of logins || []) {
    const l = low(v); if (!LOGIN_RE.test(l) || SET.has(l)) continue;
    SET.add(l);
    const sk = skeleton(l), a = SKEL.get(sk); if (a) { if (a.length < 8 && !a.includes(l)) a.push(l); } else if (sk) SKEL.set(sk, [l]);
  }
}
/** A seen login that `name` only LOOKS like (never `own`, never one whose look `own` shares) - or null. Sync, from the cached set. */
function lookAlike(name, own = null) {
  const sk = skeleton(name);
  if (!sk) return null;
  const o = low(own);
  if (o && skeleton(o) === sk) return null;                     // their own login's look (Tricon showing "Tricon")
  const a = SKEL.get(sk);
  return a ? a.find((l) => l !== o) || null : null;
}
const okMarked = (userId, username, l) => !!(okMarks.get(String(userId || "") + "|" + l) || (username && okMarks.get("@" + low(username) + "|" + l)));

async function linkedLoginOf(userId) {
  if (!userId) return null;
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  return r && r.camfrogUsername ? low(r.camfrogUsername) : null;
}
const isAuto = (name) => { try { return require("./autoaccount").isAutoName(name, { anyCase: true }); } catch (e) { return /^cf/i.test(String(name || "")); } };

/** 1.99ajw padppl rework: why the ADMIN rename tool (adminRename) won't give account `userId` the name `name` - a seen login (or a look-alike
 *  of one) that isn't the account's own linked login and isn't marked OK - or null. Never asked for a sign-up, a rename, Pepe's rename or
 *  an OAuth / SSO account: those take any free name. */
async function adminNameRefusal(name, userId = null) {
  const l = low(name);
  if (!LOGIN_RE.test(l) || isAuto(name)) return null;
  const own = userId ? await linkedLoginOf(userId) : null;
  let hit = (await seen(l)) ? l : null;
  if (hit && own === hit) return null;                                         // their own linked login
  if (!hit) {                                                                  // a look-alike of a seen login
    if (stale()) { try { await rebuild(); } catch (e) { /* keep the old set */ } }
    hit = lookAlike(name, own);
  }
  if (!hit) return null;
  if (userId && okMarks.get(String(userId) + "|" + hit)) return null;          // an admin marked it OK
  return REFUSAL;
}

/** 1.99ajw padppl rework: the gentle hint for an account that just took PATV username `name` (sign-up, rename, an OAuth / SSO account) -
 *  only when `name` is EXACTLY a Camfrog login Pepe has seen and not the account's own linked login; never says whether that login is
 *  linked to anyone. -> the hint's words | null. Never throws. */
async function nameHint(name, userId = null, req = null) {
  try {
    const l = low(name);
    if (!LOGIN_RE.test(l) || isAuto(name)) return null;
    if (!(await seen(l, { veil: false }))) return null;                         // (verify: never from veiled lines - see seen())
    if (userId && (await linkedLoginOf(userId)) === l) return null;            // it IS their linked login - nothing to link
    const v = { name: String(name).trim() };
    return req && req.t && req.t.has && req.t.has("auth.hint.camfrog_name") ? req.t("auth.hint.camfrog_name", v) : HINT.replace("{name}", v.name);
  } catch (e) { return null; }
}
/** nameHint, flashed as a note for the next page (connect-flash "success" - the welcome line's list). Never throws, never blocks. */
async function hintAfter(req, userId, name) {
  try {
    const h = await nameHint(name, userId, req);
    if (h && req && typeof req.flash === "function") req.flash("success", h);
    return h;
  } catch (e) { return null; }
}

/** The Camfrog login `shown` (an account's username or display name) equals while that account isn't linked to it - or null. Sync:
 *  reads the cached set (callers on the hot path); a stale set still answers. */
function clashOf(userId, username, shown, ownLogin, { onlyShown = false } = {}) {
  const own = low(ownLogin);
  if (stale()) rebuild().catch(() => {});
  const names = onlyShown ? [shown] : [shown, username];
  for (const v of names) {
    const l = low(v);
    if (!l || l === own || isAuto(v)) continue;
    if (LOGIN_RE.test(l) && SET.has(l) && !okMarked(userId, username, l)) return l;
  }
  // review fix: a name that only LOOKS like a seen login ("Тricon", "tric0n", "tricon_") - never against their own login's look
  for (const v of names) {
    if (!v || isAuto(v) || low(v) === own) continue;
    const la = lookAlike(v, own);
    if (la && !okMarked(userId, username, la)) return la;
  }
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
  try { const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(userId)]))[0]; if (u && u.username) okMarks.set("@" + low(u.username) + "|" + low(name), true); } catch (e) { /* by id then */ }
  await require("./adminaudit").record({ userId: me.userId, username: me.username }, "name_clash", { userId: String(userId), username: null }, { op: "ok", name: low(name) }, null);
}

/** Admin rename of a clashing account (usernames.record 'rename:admin' + an inbox notice to them); the new name passes every rule. */
async function adminRename(me, userId, newName) {
  const guard = require("./middleware/authGuard");
  const name = String(newName || "").trim();
  const bad = guard.checkUsername(name) || (await adminNameRefusal(name, userId));
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
  // (review fix: the seen set is built at start, so the first polls after a restart already answer the admins' list and the mention guard)
  init().then(() => rebuild()).catch((e) => console.error("[cfnames] init:", e.message));
  const SP = require("./siteperms"), guard = require("./middleware/authGuard");
  const meOf = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] : null);
  const fail = (res, e) => {
    if (!(e && e.status)) console.error("[cfnames]", e);                // (review fix: a 500 leaves a log line)
    const SR = require("./staffrank");
    res.status(e && e.status ? e.status : 500).json(Object.assign({ ok: false, error: e && e.status ? SR.msg(res, e) : "Something went wrong." },
      e instanceof SR.StaffRankError ? { code: e.code } : {}));
  };
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
      // rankrule (staffrank.js): never yourself / your own alt; a rename never on PATV staff of your rank or above ("it's OK": a lift)
      if (b.op === "ok" || b.op === "rename") await require("./staffrank").assert(me, String(b.userId || ""), { lift: b.op === "ok" });
      if (b.op === "ok") { await markOk(me, String(b.userId || ""), String(b.name || "")); return res.json({ ok: true }); }
      if (b.op === "rename") return res.json(await adminRename(me, String(b.userId || ""), b.username));
      res.status(400).json({ ok: false, error: "ok or rename" });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, seen, noteLogins, nameHint, hintAfter, adminNameRefusal, clashOf, lookAlike, skeleton, clashes, markOk, adminRename, rebuild, REFUSAL, HINT,
  _setClock: (f) => { clock = f; }, _reset: () => { SET = new Set(); SKEL = new Map(); builtAt = 0; probes.clear(); okMarks.clear(); }, _add: (l) => noteLogins([l]) };
