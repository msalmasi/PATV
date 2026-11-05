// padbans.js - 1.99ajn padppl (owner, 2026-11-04: "I need a way to ban users from the bridge from their user-sub menu. Also to ban users
// from the pad generally (feed etc.)"): the WEBSITE's bans, from the person menu, on the EXACT identity of the row / line clicked
// (personref.js - a web account by its id, a Camfrog login by its login, a veiled line by its server-side identity) - never by
// re-resolving a typed name. It writes only the EXISTING stores, so every reader keeps working:
//
//   scope bridge   bridgeblocks.block(room, feature 'all')            the website bridge: chat, commands, clips, cams from the website
//   scope pad      feedstore.ban(room) + bridgeblocks.block(room)     the whole pad: feed posts, comments, stories, stage booking, chat
//   scope site     feedstore.ban('')  (staff; signs them out, as ever) the whole site
//   a Camfrog login with NO PATV account   pad_login_bans (login, room_id, scope) - copied onto the account when that login links
//   a VEILED person (incognito / hidden)   veil_bans (room_id, scope, user_id, login, label) - see THE VEIL RULE
//
// THE VEIL RULE (no unmasking - 1.99ajn padppl review fix, "who, not what"): a veil ban is a row of its own (never the named row - a later
// named ban of a suspect can't overwrite it and make the 🐸 entry vanish) and it acts ONLY while that person is UNDER A FROG NAME on the
// website (veiledNow: Incognito on, or hidden) - it refuses their website bridge in that pad (bridgeblocks.active: chat, commands, clips,
// cams), whatever frog name they use. It never touches anything they do under their own name (feed posts, stories, stage booking, a
// live stage stream, the mic stage - mainstage.isBanned and postRefusal never read it) and has no visible effect at all, so a moderator
// can't watch who goes quiet, or ask a suspect to post and see it fail, to learn who the frog is. "Whole pad" and "bridge" are the same
// thing for a frog name (stored as bridge); staff can make it site-wide. Lists show it as "🐸 <label> · identity hidden", the room event
// names only the label, admin_audit the real identity (admins only). The live view never flags a veiled entry as banned (wban), so a
// new frog session can't be matched to an old ban. If the person comes back under their own name and misbehaves, ban that name.
// 1.99ajw padppl rework (owner 2026-11-04, on bans "narrowed to the one frog name": "This could lead to incognito harrassment no? Maybe this
// could work by blocking ANY frog name the person uses (essentially blocking the person from using incognito in that pad)"): a frog-name
// ban IS that - an INCOGNITO BAN on the person behind it, resolved on the server by their account (and linked login), so it covers every
// frog name they use in that pad, now and later. While it lasts, their website chat / commands / clips / cams there under a frog name are
// refused with a plain "You can't post incognito on this pad right now." (bridgeblocks.INCOG_REFUSAL - no reason, no end, nothing that
// names how the moderator saw them); under their own name nothing changes unless they are banned by name too. The moderator never
// learns who it is: the answer is the same for anyone behind the frog name (the moderator's own frog name included), the list shows
// "🐸 <the frog name it was made on> (identity hidden) - incognito ban". Durations, reasons (seen by the pad's mods and staff, never by
// the person), audit and Lift as for every website ban.
// Rank (review fix): a NAMED ban is refused on the pad's owner (unless staff ban) and on PATV staff of the same rank or above; a frog
// name's ban is never refused for rank (that answer would say who it is) - it only ever stops frog-named website chat.
//
// Who may (the existing rules): bridge = the pad's owner / staff (rooms.canManage) or a room mod by Pepe's kick cap (bridgeblocks'
// padCtx rule); pad = rooms.canManage; site = SP feed.moderate (Staff); networks (netban.js) = SP safety.net_bans (Admins).
// Durations 1 h / 1 d / 7 d / permanent (a permanent one needs a reason). Rate: 10 bans or lifts per 10 minutes per moderator.
//
// Routes: GET  /api/rooms/:slug/bans                one merged list (bridge, pad, login and veil bans)
//         POST /api/rooms/:slug/ban/preview        {ref, scope} -> who it is (the identity KIND, never a veil's), the scopes allowed, the
//                                                  refusal the person will see, network collisions (admins)
//         POST /api/rooms/:slug/ban                {ref, scope, dur, reason, nets, key}
//         POST /api/rooms/:slug/unban              {ref | entry, scope}
"use strict";
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");
const PR = require("./personref");
const SP = require("./siteperms");

const REASON_MAX = 120;
const DUR = { "1h": 3600e3, "1d": 86400e3, "7d": 7 * 86400e3, perm: null };
const SCOPES = ["bridge", "pad", "site"];
const RATE_N = 10, RATE_MS = 10 * 60 * 1000;
const WMOD_TTL = 60 * 1000, WBAN_TTL = 15 * 1000;
let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const CTRL = /[\u0000-\u001f\u007f]/g;
const clean = (s, n) => String(s == null ? "" : s).replace(CTRL, " ").replace(/<[^<>]{0,60}>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_login_bans (login TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL,
        until INTEGER, reason TEXT, by_id TEXT, by_name TEXT, at INTEGER NOT NULL, PRIMARY KEY (login, room_id, scope))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS veil_bans (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL,
        user_id TEXT, login TEXT, label TEXT, until INTEGER, reason TEXT, by_id TEXT, by_name TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS veil_bans_user ON veil_bans (user_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS veil_bans_login ON veil_bans (login)");
      await runQuery("CREATE INDEX IF NOT EXISTS veil_bans_room ON veil_bans (room_id)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg, extra) { super(msg); this.status = status; Object.assign(this, extra || {}); } }

// ── who may ──
const wmodCache = new Map();
async function wmodFor(me, R, live = null) {
  if (!me || !me.userId || !R || !R.id) return null;
  const k = me.userId + "|" + R.id, c = wmodCache.get(k);
  if (c && now() - c.at < WMOD_TTL) return c.v;
  const rooms = require("./rooms");
  let pad = false;
  try { pad = await rooms.canManage(me, R.id); } catch (e) { pad = false; }
  let bridge = pad;
  if (!bridge && me.camfrogUsername && live) {
    try { const caps = require("./padmod").capsFor(live, me.camfrogUsername); bridge = !!(caps && Array.isArray(caps.actions) && caps.actions.includes("kick")); } catch (e) { bridge = false; }
  }
  const v = { bridge, pad, site: SP.can(me, "feed.moderate"), nets: SP.can(me, "safety.net_bans") };
  const out = v.bridge || v.pad || v.site || v.nets ? v : null;
  wmodCache.set(k, { at: now(), v: out });
  if (wmodCache.size > 5000) wmodCache.delete(wmodCache.keys().next().value);
  return out;
}

/** wmodFor by account id - the cache first (the live view asks on every poll), the users row only on a miss. */
async function wmodById(userId, R, live = null) {
  if (!userId || !R || !R.id) return null;
  const c = wmodCache.get(userId + "|" + R.id);
  if (c && now() - c.at < WMOD_TTL) return c.v;
  const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  return me ? wmodFor(me, R, live) : null;
}

// ── the live view's flags on NAMED entries (never veiled ones) ──
const wbanCache = new Map();
/** Map(lowercased CURRENT PATV username -> {b: until|0 (a bridge 'all' block in THIS pad), p: until|0 (a pad ban here)}). Review fixes:
 *  keyed by the account's username now (a rename keeps the flag), and only this pad's own rows - an admin's site-wide block is neither
 *  shown to the pad's mods nor offered as a Lift that can't lift it. */
async function wbanMap(roomId) {
  const c = wbanCache.get(roomId);
  if (c && now() - c.at < WBAN_TTL) return c.m;
  const m = new Map(), t = now();
  const put = (name, k, until) => { if (!name) return; const e = m.get(low(name)) || { b: 0, p: 0 }; e[k] = until == null ? -1 : Number(until); m.set(low(name), e); };
  try {
    for (const r of await getQuery(`SELECT COALESCE(u.username, b.username) AS username, b.until FROM bridge_blocks b LEFT JOIN users u ON u.userId = b.user_id
                                    WHERE b.room_id = ? AND b.feature = 'all' AND (b.until IS NULL OR b.until > ?) LIMIT 2000`, [roomId, t])) put(r.username, "b", r.until);
  } catch (e) { /* no table yet */ }
  try {
    for (const r of await getQuery(`SELECT COALESCE(u.username, f.username) AS username, f.until FROM feed_bans f LEFT JOIN users u ON u.userId = f.user_id
                                    WHERE f.room_id = ? AND (f.until IS NULL OR f.until > ?) LIMIT 2000`, [roomId, t])) put(r.username, "p", r.until);
  } catch (e) { /* no table yet */ }
  wbanCache.set(roomId, { at: t, m });
  if (wbanCache.size > 500) wbanCache.delete(wbanCache.keys().next().value);
  return m;
}
const dropCaches = (roomId) => { if (roomId != null) wbanCache.delete(roomId); else wbanCache.clear(); };

// ── what the sheet says ──
function identity(p) {
  if (p.veil) return { kind: "veil", title: `The person behind 🐸 ${p.label}`, sub: "identity hidden from you" };
  if (!p.userId) return { kind: "login", title: `Camfrog login ${p.login}`, sub: "not on PATV (applies if it links an account)" };
  if (p.kind === "login") return { kind: "login", title: `Camfrog login ${p.login}`, sub: `PATV account @${p.username}` };
  if (p.login) return { kind: "account", title: `PATV account @${p.username}`, sub: `Camfrog login ${p.login}` };
  return { kind: "account", title: `PATV account @${p.username}`, sub: "🌐 web, no Camfrog link" };
}
function refusalPreview(scope, until, reason) {
  const when = until ? " until " + new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  const why = reason ? " (" + reason + ")" : "";
  if (scope === "veil") return require("./bridgeblocks").INCOG_REFUSAL;          // 1.99ajw padppl rework: the incognito ban's plain words
  if (scope === "bridge") return "A mod of this room blocked you from talking in it from the website" + when + why + ".";
  if (scope === "pad") return "You can't post in this pad" + when + why + ".";
  return "You can't post on the feed" + when + why + ".";
}

// ── rate ──
const hits = new Map();
function limited(userId) {
  const t = now(), k = String(userId);
  const a = (hits.get(k) || []).filter((x) => t - x < RATE_MS);
  if (a.length >= RATE_N) return true;
  a.push(t); hits.set(k, a);
  return false;
}

async function audit(me, action, p, detail, reason) {
  try {
    await require("./adminaudit").record({ userId: me.userId, username: me.username }, action,
      { userId: p.userId || null, username: p.username || (p.login ? "cf:" + p.login : null) }, detail, reason || null);
  } catch (e) { console.error("[padbans] audit:", e.message); }
}
const eventName = (p) => (p.veil ? `🐸 ${p.label} (identity hidden)` : p.userId ? "@" + p.username : "Camfrog login " + p.login);
// 1.99ajw padppl rework: how a frog-name ban (an incognito ban) is listed - the frog name it was made on, never who
const veilWho = (label) => `🐸 ${label || "someone"} (identity hidden) - incognito ban`;

/** May `me` use `scope` here? (throws) */
async function need(me, R, live, scope) {
  const w = await wmodFor(me, R, live);
  if (!w || !w[scope]) throw new Refuse(403, scope === "site" ? "Only PATV staff can ban site-wide." : scope === "pad" ? "Only this pad's owner and PATV staff can ban from the whole pad." : "Only this room's mods, the pad's owner and staff can do that.");
  return w;
}

/** Review fix (rank): why `me` may not ban NAMED account `p` here, or null. The pad's owner only by staff; PATV staff / admins only by
 *  someone of a higher class; a room mod (Pepe's kick cap) not by a fellow room mod (only the owner / staff). Never asked for a veil. */
async function rankRefusal(me, R, live, p) {
  if (!p || !p.userId || p.veil) return null;
  const core = require("./siteperms-core");
  const t = (await getQuery("SELECT userId, class, camfrogUsername FROM users WHERE userId = ?", [String(p.userId)]))[0];
  if (!t) return null;
  const mine = core.classRank(me), theirs = core.classRank(t);
  if (theirs > 0 && theirs >= mine) return "You can't ban PATV staff of your rank or above.";
  let owner = null;
  try { const r = await require("./rooms").get(R.id); owner = r && r.owner ? String(r.owner.userId) : null; } catch (e) { owner = null; }
  if (owner && owner === String(p.userId) && !mine) return "That's the pad's owner.";
  // a room mod by Pepe's caps (not the owner / staff) can't ban another room mod
  let manager = false;
  try { manager = await require("./rooms").canManage(me, R.id); } catch (e) { manager = false; }
  if (!manager && live && t.camfrogUsername) {
    try { const c = require("./padmod").capsFor(live, t.camfrogUsername); if (c && Array.isArray(c.actions) && c.actions.includes("kick")) return "You can't ban another of this room's mods - ask the pad's owner."; } catch (e) { /* no caps */ }
  }
  return null;
}

// ── who is under a frog name right now (THE VEIL RULE) ──
const loginCache = new Map();
/** The account's linked Camfrog login (lowercased) | null - cached 60 s (the refusal readers ask it on every write). */
async function loginOfCached(userId) {
  if (!userId) return null;
  const k = String(userId), c = loginCache.get(k);
  if (c && now() - c.at < 60e3) return c.v;
  let v = null;
  try { const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [k]))[0]; v = r && r.camfrogUsername ? low(r.camfrogUsername) : null; } catch (e) { v = null; }
  loginCache.set(k, { at: now(), v });
  if (loginCache.size > 5000) loginCache.delete(loginCache.keys().next().value);
  return v;
}
/** Is this person under a frog name on the website NOW (privacyeff: incognito or hidden - the sticky sets; plus a FRESH read of the
 *  website Incognito switch)? A source that can't be read counts as yes (a veil ban then refuses - never a visible effect). */
async function veiledNow(userId, login = null) {
  const keys = [...(login ? [low(login)] : []), ...(userId ? ["u:" + String(userId)] : [])];
  if (!keys.length) return false;
  try {
    const PE = require("./privacyeff");
    if (keys.some((k) => { const e = PE.eff(k); return !!(e && (e.name || e.out)); })) return true;
  } catch (e) { return true; }
  try {
    const rows = await getQuery(`SELECT "on" AS "on" FROM incognito_state WHERE login IN (${keys.map(() => "?").join(",")})`, keys);
    if (rows.some((r) => r && Number(r.on) === 1)) return true;
  } catch (e) { /* no incognito table yet */ }
  return false;
}

/**
 * Ban the person `ref` points at. me = the moderator's users row; R = the pad (registry: {id}); live = the live room (bridge.bySlug).
 * -> {ok, who: {kind, title, sub}, scope, until}
 */
async function ban(me, R, live, { ref, scope, dur, reason, nets = false, exempt = [], via = "person-menu" } = {}) {
  await init();
  if (!SCOPES.includes(scope)) throw new Refuse(400, "Pick where: the website bridge, the whole pad or the whole site.");
  if (!Object.prototype.hasOwnProperty.call(DUR, dur)) throw new Refuse(400, "Pick how long: 1 hour, 1 day, 7 days or permanent.");
  const why = clean(reason, REASON_MAX);
  if (dur === "perm" && !why) throw new Refuse(400, "A permanent ban needs a reason.");
  const w = await need(me, R, live, scope);
  if (nets && !w.nets) throw new Refuse(403, "Only PATV admins can block networks.");
  if (limited(me.userId)) throw new Refuse(429, "That's a lot of bans - wait a few minutes.");
  const p = await PR.resolve(ref, { R: live });
  if (p.error) throw new Refuse(404, p.error);
  if (p.veil) {
    // THE VEIL RULE: a frog name's ban is the same for every scope a pad can give (its website chat while they're a frog) - "pad" is
    // stored as "bridge"; and "That's you" / "Pepe" are never answered for a veil (the same answer whoever is behind it)
    if (scope === "pad") scope = "bridge";
  } else {
    if ((p.userId && String(p.userId) === String(me.userId)) || (p.login && me.camfrogUsername && p.login === low(me.camfrogUsername))) throw new Refuse(400, "That's you.");
    if (p.userId && String(p.userId) === String(require("./feedstore").PEPE_ID)) throw new Refuse(400, "Pepe can't be banned.");
    const rk = await rankRefusal(me, R, live, p);
    if (rk) throw new Refuse(403, rk);
  }
  const until = DUR[dur] == null ? null : now() + DUR[dur];
  const room = scope === "site" ? "" : String(R.id);
  const by = { userId: String(me.userId), name: me.username, via: "web" };
  const selfVeil = p.veil && ((p.userId && String(p.userId) === String(me.userId)) || (p.login && me.camfrogUsername && p.login === low(me.camfrogUsername)));
  if (selfVeil) {
    /* the moderator's own frog name: nothing to store - and the same answer as anyone else's */
  } else if (p.veil) {
    await runQuery(`INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [room, scope, p.userId || null, p.login || null, String(p.label || "someone").slice(0, 60), until, why || null, by.userId, by.name, now()]);
    if (room) await require("./rooms").event(room, "pad-ban", me.username, `${eventName(p)} - incognito ban${until ? " until " + new Date(until).toISOString() : " (permanent)"}${why ? " - " + why : ""}`);
    await audit(me, "pad_ban", p, { room: room || "*", scope, until, via, veil: true, incognito: true, label: p.label }, why);
  } else if (!p.userId) {
    await runQuery(`INSERT INTO pad_login_bans (login, room_id, scope, until, reason, by_id, by_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(login, room_id, scope) DO UPDATE SET until = excluded.until, reason = excluded.reason, by_id = excluded.by_id,
                      by_name = excluded.by_name, at = excluded.at`, [p.login, room, scope, until, why || null, by.userId, by.name, now()]);
    if (room) await require("./rooms").event(room, "pad-ban", me.username, `${eventName(p)} - ${scope}${until ? " until " + new Date(until).toISOString() : " (permanent)"}${why ? " - " + why : ""}`);
    await audit(me, "pad_ban", p, { room: room || "*", scope, until, via, login: p.login }, why);
    try { require("./micfollow").recheckLogin && require("./micfollow").recheckLogin(p.login); } catch (e) { /* no mic follows */ }
  } else {
    const target = { userId: p.userId, username: p.username };
    if (scope === "bridge" || scope === "pad") {
      await require("./bridgeblocks").block({ roomId: room, target, feature: "all", until, reason: why, by });
    }
    if (scope === "pad" || scope === "site") {
      const FS = require("./feedstore");
      await FS.ban(me, "u:" + p.userId, { room, reason: why, untilMs: until, via });
    } else {
      await audit(me, "pad_ban", p, { room, scope, until, via }, why);
    }
  }
  let netsOut = null;
  if (nets && p.userId && !p.veil) {
    // (review fix: the networks are blocked for as long as the ban, at most 7 days - a network is often shared; the sheet says so - and
    // the accounts the admin ticked as "let them through" go on the ban's exempt list)
    const netDays = dur === "1h" || dur === "1d" ? 1 : 7;
    try { netsOut = await require("./netban").banAccountNets(me, p.userId, { scope: scope === "site" ? "site" : "pad", roomId: room || null, reason: why, via, days: netDays,
                                                                            exempt: Array.isArray(exempt) ? exempt.slice(0, 50).map(String) : [] }); }
    catch (e) { if (!(e && e.status)) console.error("[padbans] nets:", e.message); else throw e; }
  }
  dropCaches(room || null);
  return { ok: true, who: identity(p), scope, until, ...(netsOut ? { nets: { networks: netsOut.networks, until: netsOut.until } } : {}) };
}

/** Lift a ban: by the person (named / login: ref + scope) or by a list entry (`entry` = "veil:<id>" | "login:<login>:<scope>"). */
async function unban(me, R, live, { ref = null, entry = null, scope = null, feature = null, via = "person-menu" } = {}) {
  await init();
  if (limited(me.userId)) throw new Refuse(429, "That's a lot of changes - wait a few minutes.");
  const e = String(entry || "");
  if (e.startsWith("veil:")) {
    const id = Math.floor(Number(e.slice(5)));
    const row = (await getQuery("SELECT * FROM veil_bans WHERE id = ?", [id]))[0];
    if (!row || (row.room_id && row.room_id !== String(R.id))) throw new Refuse(404, "That ban isn't here any more.");
    await need(me, R, live, row.scope);
    await runQuery("DELETE FROM veil_bans WHERE id = ?", [id]);
    const p = { veil: true, label: row.label, userId: row.user_id, login: row.login };
    if (row.room_id) await require("./rooms").event(row.room_id, "pad-unban", me.username, `${eventName(p)} - incognito ban`);
    await audit(me, "pad_unban", p, { room: row.room_id || "*", scope: row.scope, via, veil: true, incognito: true }, null);
    return { ok: true };
  }
  if (e.startsWith("login:")) {
    const [, login, sc] = e.split(":");
    if (!SCOPES.includes(sc)) throw new Refuse(400, "Which ban?");
    await need(me, R, live, sc);
    const room = sc === "site" ? "" : String(R.id);
    await runQuery("DELETE FROM pad_login_bans WHERE login = ? AND room_id = ? AND scope = ?", [low(login), room, sc]);
    if (room) await require("./rooms").event(room, "pad-unban", me.username, `Camfrog login ${low(login)} - ${sc}`);
    await audit(me, "pad_unban", { login: low(login) }, { room: room || "*", scope: sc, via }, null);
    return { ok: true };
  }
  if (!SCOPES.includes(scope)) throw new Refuse(400, "Which ban?");
  await need(me, R, live, scope);
  const p = await PR.resolve(ref, { R: live });
  if (p.error) throw new Refuse(404, p.error);
  if (p.veil) throw new Refuse(400, "Lift a frog name's ban from the pad's list of bans.");
  const room = scope === "site" ? "" : String(R.id);
  if (!p.userId) {
    await runQuery("DELETE FROM pad_login_bans WHERE login = ? AND room_id = ? AND scope = ?", [p.login, room, scope]);
    await audit(me, "pad_unban", p, { room: room || "*", scope, via }, null);
  } else {
    const target = { userId: p.userId, username: p.username };
    const by = { userId: String(me.userId), name: me.username, via: "web" };
    // (one feature's block from the list by its feature; the person menu's Lift = the "all" block)
    if (scope === "bridge") await require("./bridgeblocks").unblock({ roomId: room, target, feature: feature ? String(feature).slice(0, 20) : "all", by });
    if (scope === "pad") {
      // review fix: lifting a whole-pad ban lifts the bridge block made WITH it (the same end) - never a separate one a mod made, nor
      // one feature's block
      const fb = (await getQuery("SELECT until FROM feed_bans WHERE user_id = ? AND room_id = ?", [String(p.userId), room]).catch(() => []))[0];
      const bb = (await getQuery("SELECT until FROM bridge_blocks WHERE user_id = ? AND room_id = ? AND feature = 'all'", [String(p.userId), room]).catch(() => []))[0];
      const same = fb && bb && ((fb.until == null && bb.until == null) || (fb.until != null && bb.until != null && Math.abs(Number(fb.until) - Number(bb.until)) < 5000));
      if (same || (!fb && bb)) await require("./bridgeblocks").unblock({ roomId: room, target, feature: "all", by });
    }
    if (scope === "pad" || scope === "site") await require("./feedstore").unban(me, p.userId, room, { via });
    if (scope === "bridge") await audit(me, "pad_unban", p, { room, scope, via }, null);
  }
  dropCaches(room || null);
  return { ok: true, who: identity(p) };
}

/**
 * One merged list for the pad: named bridge blocks, pad bans, login bans and veil bans (veils by label only - review fix: never the
 * real identity, even for see-through holders; Reveal on a line is the logged way). w = the viewer's wmod (review fixes): a room mod who
 * may only block from the bridge sees bridge rows only (not the owner's pad bans and their reasons); a viewer who may ban site-wide (staff)
 * also sees the site-wide frog-name and login bans (room_id '') so they can be lifted. A pad ban and the bridge block made with it are ONE
 * row. Named rows carry the account id (the Lift button's exact ref - a rename doesn't break it).
 */
async function list(R, { w = { bridge: true, pad: true, site: false } } = {}) {
  await init();
  const t = now(), out = [];
  const ok = (scope) => (String(scope || "").split(":")[0] === "bridge" ? !!(w.bridge || w.pad) : scope === "site" ? !!w.site : !!w.pad);
  const cur = new Map();
  try {
    for (const r of await getQuery("SELECT userId, username FROM users WHERE userId IN (SELECT user_id FROM feed_bans WHERE room_id = ? UNION SELECT user_id FROM bridge_blocks WHERE room_id = ?) LIMIT 1000",
      [String(R.id), String(R.id)])) cur.set(String(r.userId), r.username);
  } catch (e) { /* the stored names then */ }
  const nameOf = (id, stored) => cur.get(String(id)) || stored || String(id);
  const pads = new Map();
  try {
    for (const b of await getQuery("SELECT * FROM feed_bans WHERE room_id = ? AND (until IS NULL OR until > ?) ORDER BY at DESC LIMIT 300", [String(R.id), t])) {
      const row = { kind: "account", scope: "pad", who: "@" + nameOf(b.user_id, b.username), username: nameOf(b.user_id, b.username), userId: String(b.user_id),
                    until: b.until == null ? null : Number(b.until), reason: b.reason || "", by: b.by || "", at: Number(b.at) || 0 };
      pads.set(String(b.user_id), row);
      if (ok("pad")) out.push(row);
    }
  } catch (e) { /* no feed yet */ }
  for (const b of await require("./bridgeblocks").list(R.id, { withGlobal: false })) {
    const pb = pads.get(String(b.userId));
    const sameAsPad = pb && (b.feature || "all") === "all" && ((pb.until == null && b.until == null) || (pb.until != null && b.until != null && Math.abs(pb.until - b.until) < 5000));
    if (sameAsPad && ok("pad")) continue;                    // (the pad ban's own bridge block: one row)
    const scope = b.feature === "all" ? "bridge" : "bridge:" + b.feature;
    if (!ok(scope)) continue;
    // (a bridge-only mod sees the bridge half of the owner's pad ban - never the owner's reason)
    out.push({ kind: "account", scope, who: "@" + nameOf(b.userId, b.username), username: nameOf(b.userId, b.username), userId: String(b.userId),
               until: b.until, reason: sameAsPad ? "" : b.reason, by: b.by, at: b.created });
  }
  const rooms = w.site ? [String(R.id), ""] : [String(R.id)];
  const ph = rooms.map(() => "?").join(",");
  for (const b of await getQuery(`SELECT * FROM pad_login_bans WHERE room_id IN (${ph}) AND (until IS NULL OR until > ?) ORDER BY at DESC LIMIT 300`, [...rooms, t])) {
    if (!ok(b.scope)) continue;
    out.push({ kind: "login", scope: b.scope, who: "Camfrog login " + b.login, entry: `login:${b.login}:${b.scope}`, until: b.until == null ? null : Number(b.until), reason: b.reason || "", by: b.by_name || "", at: Number(b.at), ...(b.room_id === "" ? { site: true } : {}) });
  }
  for (const b of await getQuery(`SELECT * FROM veil_bans WHERE room_id IN (${ph}) AND (until IS NULL OR until > ?) ORDER BY created DESC LIMIT 300`, [...rooms, t])) {
    const sc = b.scope === "pad" ? "bridge" : b.scope;
    if (!ok(sc)) continue;
    out.push({ kind: "veil", scope: sc, who: veilWho(b.label), incog: 1, entry: "veil:" + b.id, until: b.until == null ? null : Number(b.until),
               reason: b.reason || "", by: b.by_name || "", at: Number(b.created), ...(b.room_id === "" ? { site: true } : {}) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A veil ban refusing this account (or login) in this room - the refusal readers ask it. scopes: which ones count. -> row | null */
async function veilActive(roomId, userId, { login = null, scopes = ["bridge", "pad", "site"] } = {}) {
  if (!userId && !login) return null;
  try {
    await init();
    const t = now(), ph = scopes.map(() => "?").join(",");
    const rows = await getQuery(`SELECT * FROM veil_bans WHERE (room_id = ? OR (room_id = '' AND scope = 'site')) AND scope IN (${ph})
                                 AND (until IS NULL OR until > ?) AND (${userId ? "user_id = ?" : "0"} ${login ? "OR login = ?" : ""}) ORDER BY until IS NULL DESC, until DESC LIMIT 1`,
      [String(roomId || ""), ...scopes, t, ...(userId ? [String(userId)] : []), ...(login ? [low(login)] : [])]);
    return rows[0] || null;
  } catch (e) { return null; }
}
/** A Camfrog-login ban (no account yet) refusing this login here. */
async function loginActive(roomId, login, scopes = ["bridge", "pad", "site"]) {
  if (!login) return null;
  try {
    await init();
    const ph = scopes.map(() => "?").join(",");
    return (await getQuery(`SELECT * FROM pad_login_bans WHERE login = ? AND (room_id = ? OR (room_id = '' AND scope = 'site')) AND scope IN (${ph})
                            AND (until IS NULL OR until > ?) LIMIT 1`, [low(login), String(roomId || ""), ...scopes, now()]))[0] || null;
  } catch (e) { return null; }
}

/** A Camfrog login just linked `userId`: its login bans become the account's named bans (same end), veil bans learn the account. */
async function linked(userId, login) {
  try {
    await init();
    const l = low(login);
    const rows = await getQuery("SELECT * FROM pad_login_bans WHERE login = ? AND (until IS NULL OR until > ?)", [l, now()]);
    const acc = await PR.accountById(userId);
    if (!acc) return;
    const target = { userId: String(userId), username: acc.username };
    for (const r of rows) {
      const by = { userId: r.by_id || null, name: r.by_name || "padbans", via: "web" };
      if (r.scope === "bridge" || r.scope === "pad") await require("./bridgeblocks").block({ roomId: r.room_id, target, feature: "all", until: r.until == null ? null : Number(r.until), reason: r.reason || "", by });
      if (r.scope === "pad" || r.scope === "site") {
        await runQuery(`INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, room_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, by = excluded.by, at = excluded.at`,
          [String(userId), r.room_id, acc.username, r.reason || null, r.by_name || null, now(), r.until == null ? null : Number(r.until)]);
      }
    }
    await tx(async () => {
      await runQuery("DELETE FROM pad_login_bans WHERE login = ?", [l]);
      await runQuery("UPDATE veil_bans SET user_id = ? WHERE login = ? AND user_id IS NULL", [String(userId), l]);
    });
    dropCaches(null); loginCache.clear();
  } catch (e) { console.error("[padbans] link:", e.message); }
}

/** Expired rows: login bans 30 days after they end, veil bans 30 days after they end. */
async function sweep() {
  try {
    await init();
    const cut = now() - 30 * 86400e3;
    await runQuery("DELETE FROM pad_login_bans WHERE until IS NOT NULL AND until < ?", [cut]);
    await runQuery("DELETE FROM veil_bans WHERE until IS NOT NULL AND until < ?", [cut]);
  } catch (e) { console.error("[padbans] sweep:", e.message); }
}

function register(app, { addUser, bySlug = null }) {
  init().catch((e) => console.error("[padbans] init:", e.message));
  const t = setInterval(sweep, 6 * 3600e3); if (t.unref) t.unref();
  const t0 = setTimeout(sweep, 90 * 1000); if (t0.unref) t0.unref();       // (review fix: also soon after a start - deploys come often)
  const guard = require("./middleware/authGuard");
  const liveOf = (slug) => { try { return (bySlug || ((s) => require("./bridge").bySlug(s)))(String(slug)); } catch (e) { return null; } };
  const fail = (res, e) => {
    if (e && e.status && e.status < 500) return res.status(e.status).json(Object.assign({ ok: false, error: e.message }, e.choices ? { code: "ambiguous", choices: e.choices } : {}));
    console.error("[padbans]", e); res.status(500).json({ ok: false, error: "Something went wrong - nothing changed." });
  };
  async function ctx(req, res, write) {
    res.set("Cache-Control", "no-store");
    if (write && (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req))) { res.status(400).json({ ok: false, error: "Bad request." }); return null; }
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) { res.status(404).json({ ok: false, error: "No such pad." }); return null; }
    const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!me) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const live = liveOf(req.params.slug);
    return { R, me, live: live && live.id === R.id ? live : null };
  }
  app.get("/api/rooms/:slug/bans", addUser, async (req, res) => {
    try {
      const c = await ctx(req, res, false); if (!c) return;
      const w = await wmodFor(c.me, c.R, c.live);
      if (!w || !(w.bridge || w.pad || w.site)) return res.status(403).json({ ok: false, error: "Only this room's mods, the pad's owner and staff can see that." });
      res.json({ ok: true, bans: await list(c.R, { w }), wmod: w });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/ban/preview", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const c = await ctx(req, res, true); if (!c) return;
      const w = await wmodFor(c.me, c.R, c.live);
      if (!w) return res.status(403).json({ ok: false, error: "Only this room's mods, the pad's owner and staff can do that." });
      if (!(await PR.padOk((req.body || {}).ref, c.me, c.R))) return res.status(404).json({ ok: false, error: "That line isn't here any more." });
      const p = await PR.resolve((req.body || {}).ref, { R: c.live });
      if (p.error) return res.status(404).json({ ok: false, error: p.error });
      // (a frog name: "bridge" stands for this pad - its website chat while they're a frog; THE VEIL RULE)
      const scopes = SCOPES.filter((s) => w[s] && !(p.veil && s === "pad"));
      if (p.veil && !scopes.includes("bridge") && w.pad) scopes.unshift("bridge");
      // review fix: the "use 🔨 Ban… for the Camfrog room" note only for a Camfrog login, and only for a viewer Pepe gives that power here
      let roomBan = false;
      if (c.live && p.login && !p.veil && c.me.camfrogUsername) {
        try { const caps = require("./padmod").capsFor(c.live, c.me.camfrogUsername); roomBan = !!(caps && Array.isArray(caps.actions) && caps.actions.includes("ban")); } catch (e) { roomBan = false; }
      }
      const out = { ok: true, who: identity(p), scopes, nets: null, veil: !!p.veil,
        refusal: Object.fromEntries(scopes.map((s) => [s, refusalPreview(p.veil ? "veil" : s, now() + DUR["1d"], "")])), room: roomBan };
      if (w.nets && p.userId && !p.veil) {
        try { out.nets = await require("./netban").shared(c.me, p.userId, { reason: "ban sheet", accounts: true }); } catch (e) { out.nets = null; }
      }
      // (review fix: the Lift sheet says what is lifted - this pad's own website ban(s) on a NAMED account: end, reason, who; a pad ban's
      // own bridge block is part of it; a bridge-only mod never sees the pad ban's reason)
      if (p.userId && !p.veil) {
        const room = String(c.R.id), t = now();
        const bb = (await getQuery("SELECT until, reason, blocker_name FROM bridge_blocks WHERE room_id = ? AND user_id = ? AND feature = 'all' AND (until IS NULL OR until > ?)", [room, String(p.userId), t]).catch(() => []))[0];
        const fb = (await getQuery("SELECT until, reason, by FROM feed_bans WHERE room_id = ? AND user_id = ? AND (until IS NULL OR until > ?)", [room, String(p.userId), t]).catch(() => []))[0];
        const sameEnd = (a, b) => (a.until == null && b.until == null) || (a.until != null && b.until != null && Math.abs(Number(a.until) - Number(b.until)) < 5000);
        const partOfPad = !!(fb && bb && sameEnd(fb, bb));
        out.current = {
          pad: fb && w.pad ? { until: fb.until == null ? null : Number(fb.until), reason: fb.reason || "", by: fb.by || "" } : null,
          bridge: bb && !(partOfPad && w.pad) ? { until: bb.until == null ? null : Number(bb.until), reason: partOfPad ? "" : bb.reason || "", by: bb.blocker_name || "" } : null,
        };
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/ban", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const c = await ctx(req, res, true); if (!c) return;
      const b = req.body || {};
      if (!(await PR.padOk(b.ref, c.me, c.R))) return res.status(404).json({ ok: false, error: "That line isn't here any more." });
      res.json(await ban(c.me, c.R, c.live, { ref: b.ref, scope: String(b.scope || ""), dur: String(b.dur || ""), reason: b.reason, nets: b.nets === true,
                                              exempt: Array.isArray(b.exempt) ? b.exempt : [] }));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/unban", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const c = await ctx(req, res, true); if (!c) return;
      const b = req.body || {};
      res.json(await unban(c.me, c.R, c.live, { ref: b.ref || null, entry: b.entry || null, scope: b.scope ? String(b.scope) : null, feature: b.feature ? String(b.feature) : null }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, ban, unban, list, wmodFor, wmodById, wbanMap, veilActive, loginActive, veiledNow, loginOfCached, rankRefusal, linked, sweep, identity, refusalPreview, DUR, SCOPES,
  Refuse, _setClock: (f) => { clock = f; wmodCache.clear(); wbanCache.clear(); loginCache.clear(); }, _reset: () => { hits.clear(); wmodCache.clear(); wbanCache.clear(); loginCache.clear(); } };
