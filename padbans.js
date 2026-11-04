// padbans.js - 1.99?? padppl (owner, 2026-11-04: "I need a way to ban users from the bridge from their user-sub menu. Also to ban users
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
// THE VEIL RULE (no unmasking): a veil ban is a row of its own (never the named row - a later named ban of a suspect can't overwrite it
// and make the 🐸 entry vanish), it only REFUSES new actions (bridgeblocks.active / feedstore.postRefusal / mainstage.isBanned ask it) and
// never has a visible effect (it doesn't hide posts, end stage slots or take tiles - only named bans do, and they never read veil_bans),
// lists show it as "🐸 <label> · identity hidden", the room event names only the label, admin_audit the real identity (admins only).
// The live view never flags a veiled entry as banned (wban), so a new frog session can't be matched to an old ban. Residual: the
// person's NAMED web activity in that pad is refused too, so a moderator watching who goes quiet could guess (spec text).
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
/** Map(lowercased PATV username -> {b: until|0 (a bridge 'all' block here or everywhere), p: until|0 (a pad ban here)}). */
async function wbanMap(roomId) {
  const c = wbanCache.get(roomId);
  if (c && now() - c.at < WBAN_TTL) return c.m;
  const m = new Map(), t = now();
  const put = (name, k, until) => { if (!name) return; const e = m.get(low(name)) || { b: 0, p: 0 }; e[k] = until == null ? -1 : Number(until); m.set(low(name), e); };
  try {
    for (const r of await getQuery("SELECT username, until FROM bridge_blocks WHERE (room_id = ? OR room_id = '') AND feature = 'all' AND (until IS NULL OR until > ?) LIMIT 2000", [roomId, t])) put(r.username, "b", r.until);
  } catch (e) { /* no table yet */ }
  try {
    for (const r of await getQuery("SELECT username, until FROM feed_bans WHERE room_id = ? AND (until IS NULL OR until > ?) LIMIT 2000", [roomId, t])) put(r.username, "p", r.until);
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

/** May `me` use `scope` here? (throws) */
async function need(me, R, live, scope) {
  const w = await wmodFor(me, R, live);
  if (!w || !w[scope]) throw new Refuse(403, scope === "site" ? "Only PATV staff can ban site-wide." : scope === "pad" ? "Only this pad's owner and PATV staff can ban from the whole pad." : "Only this room's mods, the pad's owner and staff can do that.");
  return w;
}

/**
 * Ban the person `ref` points at. me = the moderator's users row; R = the pad (registry: {id}); live = the live room (bridge.bySlug).
 * -> {ok, who: {kind, title, sub}, scope, until}
 */
async function ban(me, R, live, { ref, scope, dur, reason, nets = false, via = "person-menu" } = {}) {
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
  if ((p.userId && String(p.userId) === String(me.userId)) || (p.login && me.camfrogUsername && p.login === low(me.camfrogUsername))) throw new Refuse(400, "That's you.");
  if (p.userId && String(p.userId) === String(require("./feedstore").PEPE_ID)) throw new Refuse(400, "Pepe can't be banned.");
  const until = DUR[dur] == null ? null : now() + DUR[dur];
  const room = scope === "site" ? "" : String(R.id);
  const by = { userId: String(me.userId), name: me.username, via: "web" };
  if (p.veil) {
    await runQuery(`INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [room, scope, p.userId || null, p.login || null, String(p.label || "someone").slice(0, 60), until, why || null, by.userId, by.name, now()]);
    if (room) await require("./rooms").event(room, "pad-ban", me.username, `${eventName(p)} - ${scope}${until ? " until " + new Date(until).toISOString() : " (permanent)"}${why ? " - " + why : ""}`);
    await audit(me, "pad_ban", p, { room: room || "*", scope, until, via, veil: true, label: p.label }, why);
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
  if (nets && p.userId) {
    try { await require("./netban").banAccountNets(me, p.userId, { scope: scope === "site" ? "site" : "pad", roomId: room || null, reason: why, via }); }
    catch (e) { if (!(e && e.status)) console.error("[padbans] nets:", e.message); else throw e; }
  }
  dropCaches(room || null);
  return { ok: true, who: identity(p), scope, until };
}

/** Lift a ban: by the person (named / login: ref + scope) or by a list entry (`entry` = "veil:<id>" | "login:<login>:<scope>"). */
async function unban(me, R, live, { ref = null, entry = null, scope = null, via = "person-menu" } = {}) {
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
    if (row.room_id) await require("./rooms").event(row.room_id, "pad-unban", me.username, `${eventName(p)} - ${row.scope}`);
    await audit(me, "pad_unban", p, { room: row.room_id || "*", scope: row.scope, via, veil: true }, null);
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
    if (scope === "bridge" || scope === "pad") await require("./bridgeblocks").unblock({ roomId: room, target, feature: null, by });
    if (scope === "pad" || scope === "site") await require("./feedstore").unban(me, p.userId, room, { via });
    if (scope === "bridge") await audit(me, "pad_unban", p, { room, scope, via }, null);
  }
  dropCaches(room || null);
  return { ok: true, who: identity(p) };
}

/** One merged list for the pad: named bridge blocks, pad bans, login bans and veil bans (veils by label only). */
async function list(R, { seeVeils = false } = {}) {
  await init();
  const t = now(), out = [];
  for (const b of await require("./bridgeblocks").list(R.id, { withGlobal: false })) {
    out.push({ kind: "account", scope: b.feature === "all" ? "bridge" : "bridge:" + b.feature, who: "@" + (b.username || b.userId), username: b.username,
               until: b.until, reason: b.reason, by: b.by, at: b.created });
  }
  try {
    for (const b of await getQuery("SELECT * FROM feed_bans WHERE room_id = ? AND (until IS NULL OR until > ?) ORDER BY at DESC LIMIT 300", [String(R.id), t])) {
      out.push({ kind: "account", scope: "pad", who: "@" + (b.username || b.user_id), username: b.username, userId: b.user_id, until: b.until == null ? null : Number(b.until), reason: b.reason || "", by: b.by || "", at: Number(b.at) || 0 });
    }
  } catch (e) { /* no feed yet */ }
  for (const b of await getQuery("SELECT * FROM pad_login_bans WHERE room_id = ? AND (until IS NULL OR until > ?) ORDER BY at DESC LIMIT 300", [String(R.id), t])) {
    out.push({ kind: "login", scope: b.scope, who: "Camfrog login " + b.login, entry: `login:${b.login}:${b.scope}`, until: b.until == null ? null : Number(b.until), reason: b.reason || "", by: b.by_name || "", at: Number(b.at) });
  }
  for (const b of await getQuery("SELECT * FROM veil_bans WHERE room_id = ? AND (until IS NULL OR until > ?) ORDER BY created DESC LIMIT 300", [String(R.id), t])) {
    out.push({ kind: "veil", scope: b.scope, who: `🐸 ${b.label || "someone"} · identity hidden`, entry: "veil:" + b.id, until: b.until == null ? null : Number(b.until),
               reason: b.reason || "", by: b.by_name || "", at: Number(b.created), ...(seeVeils ? { real: b.user_id || (b.login ? "cf:" + b.login : null) } : {}) });
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
    dropCaches(null);
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
      res.json({ ok: true, bans: await list(c.R, { seeVeils: SP.can(c.me, "chatlog.see_through") }), wmod: w });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/ban/preview", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const c = await ctx(req, res, true); if (!c) return;
      const w = await wmodFor(c.me, c.R, c.live);
      if (!w) return res.status(403).json({ ok: false, error: "Only this room's mods, the pad's owner and staff can do that." });
      const p = await PR.resolve((req.body || {}).ref, { R: c.live });
      if (p.error) return res.status(404).json({ ok: false, error: p.error });
      const scopes = SCOPES.filter((s) => w[s]);
      const out = { ok: true, who: identity(p), scopes, nets: null,
        refusal: Object.fromEntries(scopes.map((s) => [s, refusalPreview(s, now() + DUR["1d"], "")])), room: !!c.live };
      if (w.nets && p.userId && !p.veil) {
        try { out.nets = await require("./netban").shared(c.me, p.userId, { reason: "ban sheet" }); } catch (e) { out.nets = null; }
      }
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/ban", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const c = await ctx(req, res, true); if (!c) return;
      const b = req.body || {};
      res.json(await ban(c.me, c.R, c.live, { ref: b.ref, scope: String(b.scope || ""), dur: String(b.dur || ""), reason: b.reason, nets: b.nets === true }));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/unban", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    try {
      const c = await ctx(req, res, true); if (!c) return;
      const b = req.body || {};
      res.json(await unban(c.me, c.R, c.live, { ref: b.ref || null, entry: b.entry || null, scope: b.scope ? String(b.scope) : null }));
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, ban, unban, list, wmodFor, wmodById, wbanMap, veilActive, loginActive, linked, sweep, identity, refusalPreview, DUR, SCOPES,
  Refuse, _setClock: (f) => { clock = f; wmodCache.clear(); wbanCache.clear(); }, _reset: () => { hits.clear(); wmodCache.clear(); wbanCache.clear(); } };
