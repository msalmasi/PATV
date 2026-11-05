// blocks.js - 1.99ajn padppl (owner: "we need a way for users to block other users from the user submenu (both in chat and on profile).
// Right now you can only do it from DMs."): ONE block, wherever it is made. The DM block (messages.js dm_blocks) stays THE block - the
// person menu (pad chat, the chat window, the casino tables' shared menu), the profile's ⋯ More and /settings/blocked write the same
// row the DM header does, so a block means the same everywhere it already applies. Two more kinds for people the menu can show but
// who have no account to block by name:
//
//   dm_blocks     (messages.js)  blocker_id, blocked_id       a named block on an account - both directions count for most effects
//   login_blocks  blocker_id, login, created                  a Camfrog login with no PATV account yet; becomes a dm_blocks row when
//                                                             that login links an account (linked())
//   veil_blocks   id, blocker_id, blocked_id, blocked_login,  a frog name (incognito): stored by the hidden person's account / login,
//                 label, room_id, created                     resolved on the server from the line / roster entry clicked; the blocker
//                                                             only ever sees the label
//
// Where a NAMED block takes effect (dm_blocks / login_blocks, both directions unless said):
//   1 DMs (generic refusal)  2 DM post cards  3 feed @mention notices  4 shop gifts / comps  5 post tips  6 story tips / replies /
//   visibility  7 go-live alerts  8 mention web push  9 likeness commands  10 mic stage / live cams  11 chat search  12 the 🌐 people
//   list  13 profile stories - and, NEW here: 14 every tip (tips.transferPat: the tip page, the pad tip modal, Pepe's !tip via
//   chattip)  15 web !duel / !brawl / !tip naming them (bridge-relay runCmd)  16 pad chat @mention alerts from their NAMED lines
//   (mentions.js)  17 pad chat lines of people YOU blocked folded for you (one direction, named lines only; liveView `blk`)  18 gifts to
//   frog names between you withheld (veilgift)
//
// THE VEIL RULE (1.99ajn padppl review fix - "who, not what"): a block on a FROG NAME acts ONLY on what that person does UNDER A FROG
// NAME: their @mentions from frog-named lines don't alert the blocker (whatever frog name they use next). It never touches anything
// they do under their own name (DMs, tips, gifts, challenges, the people list, alerts from their named lines) and changes NOTHING the
// blocker sees - so the blocker can't test a suspect ("DM me" / "tip me" / "mention me" and watch what fails) and can't match a frog
// to a name. The other way round too: a NAMED block never suppresses an alert from a frog-named line (a named block of a suspect +
// a missing alert from 🐸V would say V is that suspect). Residual (privacy page): a frog-name block follows the person to their next
// frog name, so a missing alert can tell the blocker two frog names are the same person - never who.
// 1.99ajw padppl rework (owner 2026-11-04, "blocking ANY frog name the person uses" - an incognito harasser just takes the next frog name):
// a frog-name block HIDES THAT PERSON'S VEILED ACTIVITY FROM THE BLOCKER, under ANY frog name, in ANY pad - by their account / login,
// resolved on the server:
//   - their frog-named chat / 🎙 lines are folded for the blocker (veilKeysOf -> chatlogview.dress `vb: 1` on the live feed, history and
//     search; chatlog-core folds them like a named block's) - never a "someone" line or a hidden bar (those carry no frog name; folding
//     "someone" right after a named exit would link the two)
//   - their frog-named @mentions don't alert the blocker (mentions.js)
//   - while they are under a frog name (padbans.veiledNow), their web !duel / !brawl / !tip / !challenge aimed at the blocker are refused
//     (bridge-relay.challengeBlocked) and a 🎁 gift they send the blocker's frog name is withheld (veilgift.js)
// What they do under their OWN name is untouched (so it never unmasks), and a named block still never acts on frog-named lines. The
// accepted residual, stated on the sheet and the privacy page: folding / a refusal can show the blocker that two frog names are the same
// person - never who.
// Every answer to a veil block is the same whoever is behind it (an account, an unlinked login, nobody), apart from "That's you".
// Menus never say "they blocked you"; only "you blocked them" (blk), and never on a veiled entry (Unblock is in Settings → Blocked people)
// - except (1.99?? casmask, the 1.99ajw verifier's gap b) a FROG-NAMED masked casino seat whose person the viewer frog-blocked (people.js
// vb, {k:'cseat'} below): the same residual a folded frog line already carries (two frog names are the same person - never who). A
// "someone" seat is neither blocked nor unblocked from the table (casmask review: it can be the seat a watcher just saw named - a
// block on it would tie the name to every frog name; personref refuses it, the same answer whoever sits there).
//
// Routes: POST /api/blocks {ref, on, slug?} (ref = personref.js, or {k:'vb', id} / {k:'lb', v} from the settings list)
//         (1.99?? casmask: or {k:'cseat', t, s} - a masked casino seat by its own id: Block, and Unblock lifting every frog-name block on that person)
//         GET  /api/blocks            the viewer's blocks (veils by label only)
//         GET  /settings/blocked      the page
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const PR = require("./personref");

const CACHE_MS = 30 * 1000;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
let clock = () => Date.now();
const now = () => clock();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      try { await require("./messages").init(); } catch (e) {
        await runQuery(`CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL,
          PRIMARY KEY (blocker_id, blocked_id))`);
      }
      await runQuery("CREATE TABLE IF NOT EXISTS login_blocks (blocker_id TEXT NOT NULL, login TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (blocker_id, login))");
      await runQuery("CREATE INDEX IF NOT EXISTS login_blocks_login ON login_blocks (login)");
      await runQuery(`CREATE TABLE IF NOT EXISTS veil_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, blocker_id TEXT NOT NULL, blocked_id TEXT,
        blocked_login TEXT, label TEXT, room_id TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS veil_blocks_blocker ON veil_blocks (blocker_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS veil_blocks_blocked ON veil_blocks (blocked_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS veil_blocks_login ON veil_blocks (blocked_login)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── the cache of "who did this viewer block" (their own list, for menus and folding) ──
const cache = new Map();          // userId -> {at, v}
const vcache = new Map();         // 1.99ajw padppl rework: userId -> {at, v: Set of the keys behind the frog names they blocked} (server-only)
function changed(...ids) { for (const id of ids) if (id) { cache.delete(String(id)); vcache.delete(String(id)); } }

/** Named dm_blocks either way between two accounts. */
async function either(a, b) {
  if (!a || !b || String(a) === String(b)) return false;
  await init();
  return !!(await getQuery("SELECT 1 FROM dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
    [String(a), String(b), String(b), String(a)]))[0];
}
async function loginOf(userId) {
  try { const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0]; return r && r.camfrogUsername ? low(r.camfrogUsername) : null; }
  catch (e) { return null; }
}
/** Has `to` blocked `from`'s Camfrog login while it had no PATV account (login_blocks - a NAMED block the DM table can't hold)? */
async function loginBlocked(fromId, toId, { fromLogin = null } = {}) {
  if (!toId) return false;
  await init();
  const login = fromLogin ? low(fromLogin) : fromId ? await loginOf(fromId) : null;
  return !!(login && (await getQuery("SELECT 1 FROM login_blocks WHERE blocker_id = ? AND login = ? LIMIT 1", [String(toId), login]))[0]);
}
/** Has `to` blocked `from` under a frog name (veil_blocks, by the account or the login behind it)? Only frog-named actions ask this. */
async function veilBlocked(fromId, toId, { fromLogin = null } = {}) {
  if (!toId || (!fromId && !fromLogin)) return false;
  await init();
  const login = fromLogin ? low(fromLogin) : fromId ? await loginOf(fromId) : null;
  return !!(await getQuery(`SELECT 1 FROM veil_blocks WHERE blocker_id = ? AND (${fromId ? "blocked_id = ?" : "0"} ${login ? "OR blocked_login = ?" : ""}) LIMIT 1`,
    [String(toId), ...(fromId ? [String(fromId)] : []), ...(login ? [login] : [])]))[0];
}
/** The NAMED-block checks only (dm_blocks either way, `to`'s login block on `from`) - the 1.99ajn padppl review's name for what the
 *  DM refusal asks besides dm_blocks. Kept as hiddenTowards for its callers. */
const hiddenTowards = loginBlocked;
/**
 * May `from` NOT do something TO `to` (tip, gift, challenge, message, a mention alert)? THE VEIL RULE decides which blocks count:
 *   veiled: false (default) - `from` acts under their OWN name: named blocks either way, or `to`'s login block on `from`.
 *   veiled: true            - `from` acts under a FROG NAME (a frog-named chat line): only `to`'s frog-name blocks on them.
 */
async function towards(fromId, toId, opts = {}) {
  if (!toId || (fromId && String(fromId) === String(toId))) return false;
  if (opts.veiled) return veilBlocked(fromId, toId, opts);
  if (fromId && (await either(fromId, toId))) return true;
  return loginBlocked(fromId, toId, opts);
}
/** The ids of accounts that blocked `userId`'s Camfrog login by name before it had an account (the people list leaves them out for
 *  `userId`, as dm_blocks do). Never frog-name blocks - THE VEIL RULE: those never change what the blocked person sees. */
async function loginBlockersOf(userId) {
  if (!userId) return new Set();
  await init();
  const login = await loginOf(userId);
  if (!login) return new Set();
  return new Set((await getQuery("SELECT blocker_id FROM login_blocks WHERE login = ?", [login])).map((r) => String(r.blocker_id)));
}
/** Who `viewerId` blocked by name: {ids, users (lowercased usernames), logins (lowercased)} - cached CACHE_MS. Never veils. */
async function blockedBy(viewerId) {
  const empty = { ids: new Set(), users: new Set(), logins: new Set() };
  if (!viewerId) return empty;
  const k = String(viewerId), c = cache.get(k);
  if (c && now() - c.at < CACHE_MS) return c.v;
  await init();
  const v = { ids: new Set(), users: new Set(), logins: new Set() };
  const rows = await getQuery(`SELECT b.blocked_id AS id, u.username, u.camfrogUsername AS login FROM dm_blocks b LEFT JOIN users u ON u.userId = b.blocked_id
                               WHERE b.blocker_id = ? LIMIT 2000`, [k]);
  for (const r of rows) { v.ids.add(String(r.id)); if (r.username) v.users.add(low(r.username)); if (r.login) v.logins.add(low(r.login)); }
  for (const r of await getQuery("SELECT login FROM login_blocks WHERE blocker_id = ? LIMIT 2000", [k])) v.logins.add(low(r.login));
  cache.set(k, { at: now(), v });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return v;
}
/** The page's compact copy of blockedBy (the viewer's own list): {l: [logins], u: [usernames]} or null when empty. */
async function pageList(viewerId) {
  const b = await blockedBy(viewerId);
  if (!b.users.size && !b.logins.size) return null;
  return { l: [...b.logins].sort(), u: [...b.users].sort() };
}
/**
 * 1.99ajw padppl rework: the SERVER-ONLY keys of everyone `viewerId` blocked under a frog name - lowercased Camfrog logins and "u:<id>"
 * account keys (a frog line's identity, _vz.login / chat_log_veil.login, is one of these), the account's CURRENT linked login included, so
 * a person who links / relinks stays covered. Never the viewer's own keys. Cached CACHE_MS. It never leaves the server: pages only get
 * `vb: 1` on a frog-named line (chatlogview.dress). -> Set (empty when none)
 */
async function veilKeysOf(viewerId) {
  if (!viewerId) return new Set();
  const k = String(viewerId), c = vcache.get(k);
  if (c && now() - c.at < CACHE_MS) return c.v;
  await init();
  const v = new Set();
  const rows = await getQuery(`SELECT b.blocked_id AS id, b.blocked_login AS login, u.camfrogUsername AS cf FROM veil_blocks b
                               LEFT JOIN users u ON u.userId = b.blocked_id WHERE b.blocker_id = ? LIMIT 2000`, [k]);
  for (const r of rows) {
    if (r.id) v.add("u:" + low(r.id));
    if (r.login && LOGIN_RE.test(low(r.login))) v.add(low(r.login));
    if (r.cf && LOGIN_RE.test(low(r.cf))) v.add(low(r.cf));
  }
  if (v.size) {
    v.delete("u:" + low(k));
    const mine = await loginOf(k);
    if (mine) v.delete(mine);
  }
  vcache.set(k, { at: now(), v });
  if (vcache.size > 5000) vcache.delete(vcache.keys().next().value);
  return v;
}

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code || null; } }

const hits = new Map();
function limited(userId) {
  const t = now(), k = String(userId);
  const a = (hits.get(k) || []).filter((x) => t - x < 60 * 1000);
  if (a.length >= 20) return true;
  a.push(t); hits.set(k, a);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return false;
}

/**
 * Block / unblock the person `ref` points at (personref.js), as `user` ({userId, username, camfrogUsername?}). R = the pad's live
 * room (veiled refs). -> the page-safe answer. A veil's answer is the same whatever is behind it.
 */
async function set(user, ref, on, { R = null } = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (limited(user.userId)) throw new Refuse(429, "Easy there - try again in a minute.");
  const me = String(user.userId);
  // the settings list's own rows
  if (ref && ref.k === "vb") {
    const id = Math.floor(Number(ref.id));
    await runQuery("DELETE FROM veil_blocks WHERE id = ? AND blocker_id = ?", [id, me]);
    changed(me);
    return { ok: true, blocked: false, veil: true };
  }
  if (ref && ref.k === "lb") {
    const l = low(ref.v);
    if (!LOGIN_RE.test(l)) throw new Refuse(400, "Who?");
    if (on === false) { await runQuery("DELETE FROM login_blocks WHERE blocker_id = ? AND login = ?", [me, l]); changed(me); return { ok: true, blocked: false, login: l }; }
    ref = { k: "login", v: l };
  }
  const p = await PR.resolve(ref, { R, cseat: true });       // (1.99?? casmask: the masked casino seat's Block - personref opt-in)
  if (p.error) throw new Refuse(404, p.error);
  const myLogin = user.camfrogUsername ? low(user.camfrogUsername) : await loginOf(me);
  if (p.veil) {
    if ((p.userId && p.userId === me) || (p.login && myLogin && p.login === myLogin)) throw new Refuse(400, "That's you.", "self");
    // 1.99?? casmask (the 1.99ajw verifier's gap b): a MASKED casino seat ({k:'cseat'}, personref.js) - its menu offers 🚫 Block (a
    // frog-name block like the chat's) and ✅ Unblock on a frog name the viewer already blocked that way. Unblock lifts every frog-name
    // block on that person (the block follows them under any frog name); Block adds none when one is already there. The answer is the
    // same either way, whoever is behind the seat.
    const seat = !!(ref && ref.k === "cseat");
    const who = [...(p.userId ? ["blocked_id = ?"] : []), ...(p.login ? ["blocked_login = ?"] : [])];
    const args = [me, ...(p.userId ? [String(p.userId)] : []), ...(p.login ? [p.login] : [])];
    if (on === false) {
      if (!seat) throw new Refuse(400, "Unblock frog names from Settings → Blocked people.");
      if (who.length) await runQuery(`DELETE FROM veil_blocks WHERE blocker_id = ? AND (${who.join(" OR ")})`, args);
      changed(me);
      return { ok: true, blocked: false, veil: true, label: p.label };
    }
    const have = seat && who.length ? (await getQuery(`SELECT 1 FROM veil_blocks WHERE blocker_id = ? AND (${who.join(" OR ")}) LIMIT 1`, args))[0] : null;
    if (!have) {
      await runQuery("INSERT INTO veil_blocks (blocker_id, blocked_id, blocked_login, label, room_id, created) VALUES (?, ?, ?, ?, ?, ?)",
        [me, p.userId || null, p.login || null, String(p.label || "someone").slice(0, 60), R ? String(R.id) : p.room ? String(p.room) : null, now()]);
    }
    changed(me);
    return { ok: true, blocked: true, veil: true, label: p.label };
  }
  if (p.userId) {
    if (p.userId === me) throw new Refuse(400, "You can't block yourself.", "self");
    let r;
    try { r = await require("./messages").setBlockById(user, p.userId, on !== false); }
    catch (e) { throw new Refuse(e.status || 400, e.message); }
    // a login block on the same login is folded into the named one
    if (p.login) await runQuery("DELETE FROM login_blocks WHERE blocker_id = ? AND login = ?", [me, p.login]);
    changed(me, p.userId);
    return { ok: true, blocked: r.blocked, user: r.user };
  }
  // an unlinked Camfrog login
  if (!p.login) throw new Refuse(404, "Who?");
  if (myLogin && p.login === myLogin) throw new Refuse(400, "You can't block yourself.", "self");
  if (on === false) await runQuery("DELETE FROM login_blocks WHERE blocker_id = ? AND login = ?", [me, p.login]);
  else await runQuery("INSERT OR IGNORE INTO login_blocks (blocker_id, login, created) VALUES (?, ?, ?)", [me, p.login, now()]);
  changed(me);
  return { ok: true, blocked: on !== false, login: p.login };
}

/** The viewer's blocks, every kind - veils by label (and pad name) only. */
async function list(userId) {
  await init();
  const me = String(userId);
  let named = [];
  try { named = await require("./messages").blockList(me); } catch (e) { named = []; }
  const logins = (await getQuery("SELECT login, created FROM login_blocks WHERE blocker_id = ? ORDER BY created DESC LIMIT 500", [me]))
    .map((r) => ({ login: r.login, at: Number(r.created) }));
  const veils = [];
  for (const r of await getQuery("SELECT id, label, room_id, created FROM veil_blocks WHERE blocker_id = ? ORDER BY created DESC LIMIT 500", [me])) {
    let pad = null;
    // (review fix: never the raw room id as a title - no cached title = "a pad")
    try { const room = r.room_id ? require("./rooms").getCached(r.room_id) : null; pad = room ? { title: room.title || room.name || null, slug: room.slug || null } : null; } catch (e) { pad = null; }
    veils.push({ id: Number(r.id), label: r.label || "someone", pad, at: Number(r.created) });
  }
  return { named, logins, veils };
}

/** A Camfrog login just got linked to `userId` (index.js completeCamfrogLink, autoaccount): login blocks on it become named blocks,
 *  veil blocks that only knew the login learn the account. Never throws. */
async function linked(userId, login) {
  try {
    await init();
    const l = low(login);
    if (!userId || !LOGIN_RE.test(l)) return;
    await tx(async () => {
      const rows = await getQuery("SELECT blocker_id, created FROM login_blocks WHERE login = ?", [l]);
      for (const r of rows) {
        if (String(r.blocker_id) === String(userId)) continue;
        await runQuery("INSERT OR IGNORE INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [r.blocker_id, String(userId), Number(r.created) || now()]);
      }
      await runQuery("DELETE FROM login_blocks WHERE login = ?", [l]);
      await runQuery("UPDATE veil_blocks SET blocked_id = ? WHERE blocked_login = ? AND blocked_id IS NULL", [String(userId), l]);
    });
    cache.clear(); vcache.clear();
  } catch (e) { console.error("[blocks] link:", e.message); }
}

/** Account deletion / merge (accountdelete.js / accountMerge.js). */
async function forget(userId) {
  try {
    await init();
    await runQuery("DELETE FROM login_blocks WHERE blocker_id = ?", [String(userId)]);
    await runQuery("DELETE FROM veil_blocks WHERE blocker_id = ?", [String(userId)]);
    await runQuery("UPDATE veil_blocks SET blocked_id = NULL WHERE blocked_id = ?", [String(userId)]);
    cache.clear(); vcache.clear();
  } catch (e) { console.error("[blocks] forget:", e.message); }
}
async function merge(fromId, toId) {
  try {
    await init();
    await runQuery("UPDATE OR IGNORE login_blocks SET blocker_id = ? WHERE blocker_id = ?", [String(toId), String(fromId)]);
    await runQuery("DELETE FROM login_blocks WHERE blocker_id = ?", [String(fromId)]);
    await runQuery("UPDATE veil_blocks SET blocker_id = ? WHERE blocker_id = ?", [String(toId), String(fromId)]);
    await runQuery("UPDATE veil_blocks SET blocked_id = ? WHERE blocked_id = ?", [String(toId), String(fromId)]);
    cache.clear(); vcache.clear();
  } catch (e) { console.error("[blocks] merge:", e.message); }
}
/** The blocker's own export: labels and logins, never who is behind a frog name. */
async function exportFor(userId) {
  const L = await list(userId);
  return { logins: L.logins, frog_names: L.veils.map((v) => ({ label: v.label, pad: v.pad ? v.pad.title : null, at: v.at })) };
}

function register(app, { addUser, bySlug = null }) {
  init().catch((e) => console.error("[blocks] init:", e.message));
  const guard = require("./middleware/authGuard");
  const roomOf = (slug) => {
    if (!slug) return null;
    try { return (bySlug || ((s) => require("./bridge").bySlug(s)))(String(slug).slice(0, 128)); } catch (e) { return null; }
  };
  const fail = (res, e) => {
    if (e instanceof Refuse || e.status) return res.status(e.status || 400).json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
    console.error("[blocks]", e); res.status(500).json({ ok: false, error: "Something went wrong - nothing changed." });
  };
  app.post("/api/blocks", addUser, require("express").json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(400).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const b = req.body || {};
      const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!me) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = roomOf(b.slug);
      // (1.99ajn padppl review fix: a frog name's row / line only in a pad this viewer may see - the same answer as a line that's gone)
      if (!(await PR.padOk(b.ref, me, R, { cseat: true }))) return res.status(404).json({ ok: false, error: "That line isn't here any more." });
      res.json(await set(me, b.ref, b.on !== false, { R }));
    } catch (e) { fail(res, e); }
  });
  app.get("/api/blocks", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await list(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  app.get("/settings/blocked", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/blocked"));
      res.set("Cache-Control", "private, no-store");
      res.render("settingsBlocked", { user: req.user.username, blocks: await list(req.user.userId) });
    } catch (e) { next(e); }
  });
}

module.exports = { init, register, set, list, either, towards, hiddenTowards, loginBlocked, veilBlocked, loginBlockersOf, blockedBy, pageList, linked, forget, merge, exportFor,
  changed, veilKeysOf, Refuse, _setClock: (f) => { clock = f; cache.clear(); vcache.clear(); }, _reset: () => { cache.clear(); vcache.clear(); hits.clear(); } };
