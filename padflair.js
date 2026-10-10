// padflair.js — user flair: a pad's own badges for its people (1.99ir).
//
// Each pad can define up to MAX_FLAIRS flairs (name, colour, optional emoji). Its owner and mods (rooms.canManage: the
// pad's owner and site Admins / Staff - the same people who moderate the pad's feed) create them, edit them, and give
// one to a member. A flair the pad marks "self-assignable" can also be picked by any member who can see the pad.
// One flair per person per pad. A flair a mod gave can only be changed by a mod (the member can't swap it for a
// self-assignable one, or take it off).
//
// Where it shows - only in THAT pad: next to the person's name on the pad's feed (post cards in the pad's own feed),
// on a post's page when the post's home pad is the pad (the post and its comments), and on the pad page's live
// Camfrog room chat (people whose Camfrog login is linked to their PATV account).
//
//   pad_flairs       id PK, room_id, name, color (#rrggbb, contrast-guarded like a pad accent), emoji, self_assign,
//                    sort, created, created_by, updated
//   pad_user_flairs  room_id + user_id PK, flair_id, set_by (a username), self (1 = they picked it), set_at
//
// Reads are cached per pad (CACHE_MS; every write drops that pad's entry), so the feed / chat pay one query per pad
// and minute, not per row.
//
// 1.99jp: the automatic 📼 PLEX flair - people on our Plex server (plexmembers.js, an active membership) show a "📼 Plex"
// chip in every pad where they have no flair of the pad's own (the pad's flair always wins). It comes and goes with the
// membership (no row is written); media setting plex_flair switches it off.
//
// Management: the pad settings hub's "🏷️ Flair" tab (views/padSettings.ejs, public/js/pad-flair.js). Members pick
// theirs from the pad page's Feed tab ("Your flair here").
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const MAX_FLAIRS = 25, NAME_MAX = 24, EMOJI_MAX = 16, CACHE_MS = 60e3;
const DEFAULT_COLOR = "#66bb6a";
let NOW = () => Date.now();

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‌‎-‏‪-‮⁦-⁩]/g;
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
const LOOK = () => require("./padlook");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_flairs (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, name TEXT NOT NULL,
                      color TEXT, emoji TEXT, self_assign INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, created INTEGER,
                      created_by TEXT, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pad_flairs_room ON pad_flairs (room_id, sort)");
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_user_flairs (room_id TEXT NOT NULL, user_id TEXT NOT NULL, flair_id INTEGER NOT NULL,
                      set_by TEXT, self INTEGER NOT NULL DEFAULT 0, set_at INTEGER, PRIMARY KEY (room_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS pad_user_flairs_flair ON pad_user_flairs (flair_id)");
    })().catch((e) => { console.error("[flair] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── cleaning ──
function cleanName(v) {
  const s = String(v == null ? "" : v).normalize("NFKC").replace(CTRL, "").replace(/\s+/g, " ").trim();
  const a = Array.from(s).slice(0, NAME_MAX).join("").trim();
  return /[\p{L}\p{N}]/u.test(a) ? a : null;
}
/** An emoji (one or a short sequence: ZWJ families, flags, skin tones) or "" - never letters, digits or markup. */
function cleanEmoji(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, "").trim();
  if (!s) return "";
  if (s.length > EMOJI_MAX) return null;
  if (/[\x00-\x7f]/.test(s.replace(/[#*0-9]️?⃣/g, ""))) return null;               // keycaps aside, no ASCII
  if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣)+$/u.test(s)) return null;
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(s)) return null;
  return s;
}
/** -> {hex (contrast-guarded on the dark page), ink (the text colour on it)} or null */
function cleanColor(v) {
  const g = LOOK().guardAccent(String(v == null || v === "" ? DEFAULT_COLOR : v));
  return g ? { hex: g.hex, ink: g.ink } : null;
}
function shape(r) {
  if (!r) return null;
  const c = cleanColor(r.color) || cleanColor(DEFAULT_COLOR);
  return { id: Number(r.id), name: r.name, color: c.hex, ink: c.ink, emoji: r.emoji || "", self: !!r.self_assign };
}

// ── cache: room id -> {at, flairs: [...], byUser: Map(userId -> flair), byName: Map(lowercased username -> flair)} ──
const cache = new Map();
function drop(roomId) { cache.delete(String(roomId)); }
function dropAll() { cache.clear(); }

// 1.99jp: the automatic 📼 Plex flair (never stored, never assignable)
let PLEX_FLAIR = null;
function plexFlair() {
  if (!PLEX_FLAIR) { const c = cleanColor("#e5a00d") || cleanColor(DEFAULT_COLOR); PLEX_FLAIR = { id: 0, name: "Plex", color: c.hex, ink: c.ink, emoji: "📼", self: false, auto: "plex" }; }
  return PLEX_FLAIR;
}
function plexOn() { try { return !!require("./mediaconf").get().plex_flair; } catch (e) { return false; } }
const PM = () => require("./plexmembers");
function plexById(userId) { try { return plexOn() && PM().memberSync(userId) ? plexFlair() : null; } catch (e) { return null; } }
function plexByName(name) { try { return plexOn() && PM().memberByName(name) ? plexFlair() : null; } catch (e) { return null; } }
async function load(roomId) {
  const id = String(roomId || "");
  const hit = cache.get(id);
  if (hit && NOW() - hit.at < CACHE_MS) return hit;
  await init();
  const flairs = (await getQuery("SELECT * FROM pad_flairs WHERE room_id = ? ORDER BY sort, id", [id])).map(shape);
  const byId = new Map(flairs.map((f) => [f.id, f]));
  const rows = flairs.length ? await getQuery(`SELECT uf.user_id, uf.flair_id, uf.self, u.username FROM pad_user_flairs uf LEFT JOIN users u ON u.userId = uf.user_id
                                               WHERE uf.room_id = ?`, [id]) : [];
  const byUser = new Map(), byName = new Map();
  for (const r of rows) {
    const f = byId.get(Number(r.flair_id));
    if (!f) continue;
    byUser.set(String(r.user_id), f);
    if (r.username) byName.set(String(r.username).toLowerCase(), f);
  }
  const v = { at: NOW(), flairs, byUser, byName };
  cache.set(id, v);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return v;
}

// ── reads ──
const flairable = (roomId) => !!roomId && !rooms.isProfile(String(roomId));
async function list(roomId) { return flairable(roomId) ? (await load(roomId)).flairs : []; }
/** userIds -> Map(userId -> flair) in this pad (people without one are left out). */
async function forUsers(roomId, userIds) {
  const out = new Map();
  if (!flairable(roomId)) return out;
  const L = await load(roomId);
  for (const id of userIds || []) { const f = L.byUser.get(String(id)) || plexById(id); if (f) out.set(String(id), f); }
  return out;
}
/** The pad's flairs by lowercased PATV username (the live chat resolves people by their linked account's username). */
async function byUsername(roomId) {
  if (!flairable(roomId)) return new Map();
  const m = (await load(roomId)).byName;
  // the pad's own flair, else the automatic 📼 Plex one (a Map-like: only get / has are used)
  return { get: (name) => m.get(name) || plexByName(name) || undefined, has: (name) => m.has(name) || !!plexByName(name), size: m.size };
}
async function of(roomId, userId) { return (await forUsers(roomId, [userId])).get(String(userId)) || null; }

/** The chip (escaped; colour values are strict hex from cleanColor). */
function html(f, { cls = "" } = {}) {
  if (!f || !f.name) return "";
  return `<span class="ufl${cls ? " " + esc(cls) : ""}" style="--fl:${esc(f.color)};--fli:${esc(f.ink)}" title="${f.auto === "plex" ? "On our Plex server" : "Pad flair: " + esc(f.name)}">${f.emoji ? `<span class="ufl-e" aria-hidden="true">${esc(f.emoji)}</span>` : ""}${esc(f.name)}</span>`;
}
/** What the live chat JSON carries (rendered with textContent on the page). */
const plain = (f) => (f ? { name: f.name, color: f.color, ink: f.ink, emoji: f.emoji || "" } : null);

// ── writes ──
async function mustManage(actor, roomId) {
  if (!actor || !actor.userId) throw new Refuse(401, "Sign in first.");
  if (!flairable(roomId)) throw new Refuse(400, "Profiles don't have flair.");
  if (!(await rooms.canManage(actor, roomId))) throw new Refuse(403, "Only this pad's owner and mods can manage its flair.");
}
const who = (u) => (u && (u.username || u.userId)) || "?";
async function audit(roomId, actor, detail) { await rooms.event(roomId, "feed-flair", who(actor), detail).catch(() => {}); }

/** Create (no id) or edit a flair. input: {id?, name, color, emoji, self} -> the pad's flairs */
async function save(actor, roomId, input = {}) {
  await init();
  await mustManage(actor, roomId);
  const name = cleanName(input.name);
  if (!name) throw new Refuse(400, "Give the flair a name (letters or numbers, up to " + NAME_MAX + ").");
  const color = cleanColor(input.color);
  if (!color) throw new Refuse(400, "Pick a colour (#rrggbb).");
  const emoji = cleanEmoji(input.emoji);
  if (emoji === null) throw new Refuse(400, "The emoji box takes one emoji (or leave it empty).");
  const self = input.self === true || input.self === 1 || input.self === "1" || input.self === "on" ? 1 : 0;
  const have = await getQuery("SELECT id, name FROM pad_flairs WHERE room_id = ?", [roomId]);
  const id = input.id != null && input.id !== "" ? Number(input.id) : null;
  if (id !== null && !have.some((f) => Number(f.id) === id)) throw new Refuse(404, "No such flair in this pad.");
  if (have.some((f) => Number(f.id) !== id && String(f.name).toLowerCase() === name.toLowerCase())) throw new Refuse(409, `This pad already has a flair called "${name}".`);
  const t = NOW();
  if (id === null) {
    if (have.length >= MAX_FLAIRS) throw new Refuse(400, `A pad can have up to ${MAX_FLAIRS} flairs.`);
    await runQuery("INSERT INTO pad_flairs (room_id, name, color, emoji, self_assign, sort, created, created_by, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   [roomId, name, color.hex, emoji || null, self, have.length, t, who(actor), t]);
    await audit(roomId, actor, `created flair "${name}"${self ? " (self-assignable)" : ""}`);
  } else {
    await runQuery("UPDATE pad_flairs SET name = ?, color = ?, emoji = ?, self_assign = ?, updated = ? WHERE id = ? AND room_id = ?",
                   [name, color.hex, emoji || null, self, t, id, roomId]);
    await audit(roomId, actor, `edited flair "${name}"`);
  }
  drop(roomId);
  return list(roomId);
}
/** Delete a flair (everyone wearing it loses it). */
async function remove(actor, roomId, flairId) {
  await init();
  await mustManage(actor, roomId);
  const f = (await getQuery("SELECT * FROM pad_flairs WHERE id = ? AND room_id = ?", [Number(flairId), roomId]))[0];
  if (!f) throw new Refuse(404, "No such flair in this pad.");
  await runQuery("DELETE FROM pad_user_flairs WHERE room_id = ? AND flair_id = ?", [roomId, f.id]);
  await runQuery("DELETE FROM pad_flairs WHERE id = ?", [f.id]);
  await audit(roomId, actor, `deleted flair "${f.name}"`);
  drop(roomId);
  return list(roomId);
}
async function userByName(name) {
  const n = String(name == null ? "" : name).trim().replace(/^@/, "").replace(/^u\//i, "").slice(0, 64);
  if (!n) return null;
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const live = cols.has("archived_at") ? " AND archived_at IS NULL" : "";
  const r = (await getQuery(`SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?)${live} LIMIT 1`, [n]))[0];
  if (r) return r;
  if (!cols.has("camfrogUsername")) return null;
  return (await getQuery(`SELECT userId, username FROM users WHERE LOWER(camfrogUsername) = LOWER(?)${live} LIMIT 1`, [n]))[0] || null;
}
/** A mod gives `target` (a username / Camfrog name / {userId}) flair `flairId`; null / "" takes it off. */
async function assign(actor, roomId, target, flairId) {
  await init();
  await mustManage(actor, roomId);
  const u = target && typeof target === "object" && target.userId ? target : await userByName(target);
  if (!u) throw new Refuse(404, "No PATV account by that name.");
  if (flairId === null || flairId === undefined || flairId === "" || Number(flairId) === 0) {
    await runQuery("DELETE FROM pad_user_flairs WHERE room_id = ? AND user_id = ?", [roomId, String(u.userId)]);
    await audit(roomId, actor, `took flair off ${u.username || u.userId}`);
  } else {
    const f = (await getQuery("SELECT * FROM pad_flairs WHERE id = ? AND room_id = ?", [Number(flairId), roomId]))[0];
    if (!f) throw new Refuse(404, "No such flair in this pad.");
    await runQuery(`INSERT INTO pad_user_flairs (room_id, user_id, flair_id, set_by, self, set_at) VALUES (?, ?, ?, ?, 0, ?)
                    ON CONFLICT(room_id, user_id) DO UPDATE SET flair_id = excluded.flair_id, set_by = excluded.set_by, self = 0, set_at = excluded.set_at`,
                   [roomId, String(u.userId), f.id, who(actor), NOW()]);
    await audit(roomId, actor, `gave ${u.username || u.userId} the flair "${f.name}"`);
  }
  drop(roomId);
  return manageView(roomId);
}
/**
 * A member picks one of the pad's self-assignable flairs for themselves (null = none). Refused when a mod gave them
 * their current flair, when they can't see the pad, or when they're banned from its feed.
 */
async function pick(actor, roomId, flairId) {
  await init();
  if (!actor || !actor.userId) throw new Refuse(401, "Sign in to pick a flair.");
  if (!flairable(roomId)) throw new Refuse(400, "Profiles don't have flair.");
  const PA = require("./padaccess");
  await PA.init();
  if (!PA.canSee(actor, roomId)) throw new Refuse(404, "No such pad.");
  const ban = (await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND (room_id = ? OR room_id = '') AND (until IS NULL OR until > ?)",
                              [actor.userId, roomId, NOW()]).catch(() => []))[0];
  if (ban) throw new Refuse(403, "You're banned from this pad's feed.");
  const cur = (await getQuery("SELECT * FROM pad_user_flairs WHERE room_id = ? AND user_id = ?", [roomId, actor.userId]))[0];
  if (cur && !cur.self && (await getQuery("SELECT 1 FROM pad_flairs WHERE id = ?", [cur.flair_id])).length) {
    throw new Refuse(403, "A mod gave you your flair here - ask them to change it.");
  }
  if (flairId === null || flairId === undefined || flairId === "" || Number(flairId) === 0) {
    await runQuery("DELETE FROM pad_user_flairs WHERE room_id = ? AND user_id = ?", [roomId, actor.userId]);
  } else {
    const f = (await getQuery("SELECT * FROM pad_flairs WHERE id = ? AND room_id = ?", [Number(flairId), roomId]))[0];
    if (!f) throw new Refuse(404, "No such flair in this pad.");
    if (!f.self_assign) throw new Refuse(403, "Only a mod can give that flair.");
    await runQuery(`INSERT INTO pad_user_flairs (room_id, user_id, flair_id, set_by, self, set_at) VALUES (?, ?, ?, ?, 1, ?)
                    ON CONFLICT(room_id, user_id) DO UPDATE SET flair_id = excluded.flair_id, set_by = excluded.set_by, self = 1, set_at = excluded.set_at`,
                   [roomId, actor.userId, f.id, who(actor), NOW()]);
  }
  drop(roomId);
  return mine(actor, roomId);
}
/** The member's own view: {flair, locked (a mod gave it), choices (self-assignable)} */
async function mine(actor, roomId) {
  await init();
  if (!flairable(roomId)) return { flair: null, locked: false, choices: [] };
  const L = await load(roomId);
  const cur = actor && actor.userId ? (await getQuery("SELECT * FROM pad_user_flairs WHERE room_id = ? AND user_id = ?", [roomId, actor.userId]))[0] : null;
  const flair = cur ? L.flairs.find((f) => f.id === Number(cur.flair_id)) || null : null;
  return { flair, locked: !!(flair && cur && !cur.self), choices: L.flairs.filter((f) => f.self) };
}
/** The settings hub: the flairs (with how many wear each) and who has which. */
async function manageView(roomId) {
  await init();
  const flairs = await list(roomId);
  const rows = flairs.length ? await getQuery(`SELECT uf.user_id, uf.flair_id, uf.self, uf.set_by, uf.set_at, u.username, u.displayname FROM pad_user_flairs uf
                                               LEFT JOIN users u ON u.userId = uf.user_id WHERE uf.room_id = ? ORDER BY uf.set_at DESC LIMIT 500`, [roomId]) : [];
  const people = rows.map((r) => ({ userId: r.user_id, username: r.username || null, display: r.displayname || r.username || "[gone]",
                                    flair: flairs.find((f) => f.id === Number(r.flair_id)) || null, self: !!r.self, by: r.set_by || null, at: Number(r.set_at) || null }))
    .filter((p) => p.flair);
  const count = new Map();
  for (const p of people) count.set(p.flair.id, (count.get(p.flair.id) || 0) + 1);
  return { flairs: flairs.map((f) => ({ ...f, n: count.get(f.id) || 0 })), people, max: MAX_FLAIRS, nameMax: NAME_MAX, palette: LOOK().PALETTE };
}

// ── routes: /api/pads/<slug>/flair ... (the pad's own access rules apply: an Approved pad's flair is for its insiders) ──
function register(app, { addUser }) {
  init().catch(() => {});
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[flair]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const padOf = async (slug) => {
    try { return await require("./roomsweb").resolveRoom(String(slug || "").slice(0, 128)); } catch (e) { return null; }
  };
  const viewerOf = async (req) => (req.user && req.user.userId ? require("./feedstore").account(req.user.userId) : null);
  const write = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") { res.status(403).json({ ok: false, error: "Bad request." }); return null; }
    if (!req.is("application/json")) { res.status(415).json({ ok: false, error: "JSON only." }); return null; }
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const R = await padOf(req.params.slug);
    if (!R) { res.status(404).json({ ok: false, error: "No such pad." }); return null; }
    return { u: await viewerOf(req), R };
  };
  app.get("/api/pads/:slug/flair", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await padOf(req.params.slug);
      const PA = require("./padaccess");
      await PA.init();
      const u = await viewerOf(req);
      if (!R || !PA.canSee(u, R.id)) return res.status(404).json({ ok: false, error: "No such pad." });
      const manage = await rooms.canManage(u, R.id);
      res.json({ ok: true, flairs: await list(R.id), mine: u ? await mine(u, R.id) : null, ...(manage ? { manage: await manageView(R.id) } : {}) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/flair/save", addUser, async (req, res) => {
    try { const w = await write(req, res); if (!w) return; await save(w.u, w.R.id, req.body || {}); res.json({ ok: true, manage: await manageView(w.R.id) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/flair/delete", addUser, async (req, res) => {
    try { const w = await write(req, res); if (!w) return; await remove(w.u, w.R.id, (req.body || {}).id); res.json({ ok: true, manage: await manageView(w.R.id) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/flair/assign", addUser, async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      const b = req.body || {};
      res.json({ ok: true, manage: await assign(w.u, w.R.id, b.userId ? { userId: String(b.userId) } : b.user, b.flair) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/flair/mine", addUser, async (req, res) => {
    try { const w = await write(req, res); if (!w) return; res.json({ ok: true, mine: await pick(w.u, w.R.id, (req.body || {}).flair) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, list, forUsers, byUsername, of, html, plain, dropAll, plexFlair, save, remove, assign, pick, mine, manageView, cleanName, cleanEmoji, cleanColor,
                   Refuse, MAX_FLAIRS, NAME_MAX, _drop: drop, _clear: () => cache.clear(), _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
