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
// 1.99qp 💎 PRIME TIME PLUS: a Plus pad may define MAX_FLAIRS_PLUS flairs (twice the normal), and its OWNER shows the
// automatic "💎 Plus" flair in that pad (where they have no flair of the pad's own) - never stored, never assignable.
//
// 1.99wq POST FLAIR (Reddit-style link flair): a flair with kind 'post' labels a POST in its home pad (📰 News, 🎰 Casino ...)
// instead of a person. The pad's owner / mods define them next to the user flairs (MAX_POST_FLAIRS, twice on a Plus pad),
// may mark one "mods only" (mod_only: only people who manage the pad - and Pepe in a house pad - may put it on a post), and
// may require a flair on every post (pad_flair_cfg.post_required: the composer asks for one; automatic posts made for
// someone - room generations, kept captures - are exempt). The author picks it in the composer (or the Edit form); a post
// shows it before its title, and it filters the pad's feed (/p/<pad>?flair=<id>).
//   pad_flairs.kind      'user' (default, every flair before 1.99wq) | 'post'
//   pad_flairs.mod_only  post flair only mods may use
//   pad_flair_cfg        room_id PK, post_required, updated, by
//   feed_post_flair      post_id PK, room_id (the post's home pad), flair_id, set_by, set_at
//
// Management: the pad settings hub's "🏷️ Flair" tab (views/padSettings.ejs, public/js/pad-flair.js). Members pick
// theirs from the pad page's Feed tab ("Your flair here").
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const MAX_FLAIRS = 25, MAX_FLAIRS_PLUS = 50, NAME_MAX = 24, EMOJI_MAX = 16, CACHE_MS = 60e3;
const MAX_POST_FLAIRS = 20, MAX_POST_FLAIRS_PLUS = 40;          // 1.99wq: post flair
const DEFAULT_COLOR = "#66bb6a";
let NOW = () => Date.now();

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
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
      // 1.99wq: post flair (additive columns + two tables)
      const cols = new Set((await getQuery("PRAGMA table_info(pad_flairs)")).map((c) => c.name));
      if (!cols.has("kind")) await runQuery("ALTER TABLE pad_flairs ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
      if (!cols.has("mod_only")) await runQuery("ALTER TABLE pad_flairs ADD COLUMN mod_only INTEGER NOT NULL DEFAULT 0");
      await runQuery("CREATE TABLE IF NOT EXISTS pad_flair_cfg (room_id TEXT PRIMARY KEY, post_required INTEGER NOT NULL DEFAULT 0, updated INTEGER, by TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_post_flair (post_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, flair_id INTEGER NOT NULL,
                      set_by TEXT, set_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_post_flair_room ON feed_post_flair (room_id, flair_id)");
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
  const o = { id: Number(r.id), name: r.name, color: c.hex, ink: c.ink, emoji: r.emoji || "", self: !!r.self_assign };
  if (r.kind === "post") { o.kind = "post"; o.self = false; o.mod_only = !!r.mod_only; }
  return o;
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
// 1.99mv: the automatic 💚 Supporter flair (supporter.js: donated to PATV; 🥉 / 🥈 / 🥇 by lifetime total) - after the pad's
// own flair, before the 📼 Plex one; never stored, never assignable
const SUP = () => require("./supporter");
// 1.99qp: 💎 Prime Time Plus - more flair slots, and the owner's automatic 💎 Plus flair in their Plus pad
const plusPad = (roomId) => { try { return require("./premium").isPrimePlus(roomId); } catch (e) { return false; } };
const maxFlairs = (roomId) => (plusPad(roomId) ? MAX_FLAIRS_PLUS : MAX_FLAIRS);
let PLUS_FLAIR = null;
function plusFlair() {
  if (!PLUS_FLAIR) { const c = cleanColor("#7fdbff") || cleanColor(DEFAULT_COLOR); PLUS_FLAIR = { id: 0, name: "Plus", color: c.hex, ink: c.ink, emoji: "💎", self: false, auto: "plus" }; }
  return PLUS_FLAIR;
}
/** The Plus pad's owner -> {id, name (lowercased username)} or null (not a Plus pad / no owner). */
function plusHost(roomId) {
  if (!plusPad(roomId)) return null;
  try { const R = rooms.getCached(roomId); return R && R.owner && R.owner.userId ? { id: String(R.owner.userId), name: String(R.owner.username || "").toLowerCase() } : null; }
  catch (e) { return null; }
}
function supById(userId) { try { return SUP().flair(SUP().supporterSync(userId)); } catch (e) { return null; } }
function supByName(name) { try { return SUP().flair(SUP().supporterByName(name)); } catch (e) { return null; } }
async function load(roomId) {
  const id = String(roomId || "");
  const hit = cache.get(id);
  if (hit && NOW() - hit.at < CACHE_MS) return hit;
  await init();
  const every = (await getQuery("SELECT * FROM pad_flairs WHERE room_id = ? ORDER BY sort, id", [id])).map(shape);
  const flairs = every.filter((f) => f.kind !== "post");
  const postFlairs = every.filter((f) => f.kind === "post");                 // 1.99wq
  const cfg = (await getQuery("SELECT post_required FROM pad_flair_cfg WHERE room_id = ?", [id]))[0];
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
  const v = { at: NOW(), flairs, byUser, byName, postFlairs, required: !!(cfg && cfg.post_required) };
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
  const host = plusHost(roomId);
  for (const id of userIds || []) {
    const f = L.byUser.get(String(id)) || (host && host.id === String(id) ? plusFlair() : null) || supById(id) || plexById(id);
    if (f) out.set(String(id), f);
  }
  return out;
}
/** The pad's flairs by lowercased PATV username (the live chat resolves people by their linked account's username). */
async function byUsername(roomId) {
  if (!flairable(roomId)) return new Map();
  const m = (await load(roomId)).byName;
  // the pad's own flair, else the automatic 💎 Plus (the Plus pad's owner, 1.99qp) / 💚 Supporter / 📼 Plex one (a Map-like: only get / has are used)
  const host = plusHost(roomId);
  const plusOf = (name) => (host && host.name && String(name || "").toLowerCase() === host.name ? plusFlair() : null);
  return { get: (name) => m.get(name) || plusOf(name) || supByName(name) || plexByName(name) || undefined,
           has: (name) => m.has(name) || !!plusOf(name) || !!supByName(name) || !!plexByName(name), size: m.size };
}
async function of(roomId, userId) { return (await forUsers(roomId, [userId])).get(String(userId)) || null; }

/** The chip (escaped; colour values are strict hex from cleanColor). */
function html(f, { cls = "" } = {}) {
  if (!f || !f.name) return "";
  return `<span class="ufl${cls ? " " + esc(cls) : ""}" style="--fl:${esc(f.color)};--fli:${esc(f.ink)}" title="${f.auto === "plex" ? "On our Plex server" : f.auto === "supporter" ? "Supports PATV with donations" : f.auto === "plus" ? "Runs this 💎 Prime Time Plus pad" : "Pad flair: " + esc(f.name)}">${f.emoji ? `<span class="ufl-e" aria-hidden="true">${esc(f.emoji)}</span>` : ""}<span class="ufl-n">${esc(f.name)}</span></span>`;
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
  const id = input.id != null && input.id !== "" ? Number(input.id) : null;
  // 1.99wq: a flair's kind is fixed when it's made ('post' = post flair); an edit keeps it
  const all = await getQuery("SELECT id, name, COALESCE(kind, 'user') AS kind FROM pad_flairs WHERE room_id = ?", [roomId]);
  const old = id !== null ? all.find((f) => Number(f.id) === id) : null;
  if (id !== null && !old) throw new Refuse(404, "No such flair in this pad.");
  const kind = old ? old.kind : (input.kind === "post" ? "post" : "user");
  const on = (v) => v === true || v === 1 || v === "1" || v === "on";
  const self = kind === "user" && on(input.self) ? 1 : 0;
  const modOnly = kind === "post" && on(input.mod_only) ? 1 : 0;
  const have = all.filter((f) => f.kind === kind);
  if (have.some((f) => Number(f.id) !== id && String(f.name).toLowerCase() === name.toLowerCase())) {
    throw new Refuse(409, `This pad already has a ${kind === "post" ? "post " : ""}flair called "${name}".`);
  }
  const t = NOW();
  if (id === null) {
    if (kind === "post" && have.length >= maxPostFlairs(roomId)) {
      throw new Refuse(400, `A pad can have up to ${maxPostFlairs(roomId)} post flairs.` + (plusPad(roomId) ? "" : ` 💎 Prime Time Plus pads get ${MAX_POST_FLAIRS_PLUS}.`));
    }
    if (kind === "user" && have.length >= maxFlairs(roomId)) throw new Refuse(400, `A pad can have up to ${maxFlairs(roomId)} flairs.` + (plusPad(roomId) ? "" : ` 💎 Prime Time Plus pads get ${MAX_FLAIRS_PLUS}.`));
    await runQuery("INSERT INTO pad_flairs (room_id, name, color, emoji, self_assign, sort, created, created_by, updated, kind, mod_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   [roomId, name, color.hex, emoji || null, self, have.length, t, who(actor), t, kind, modOnly]);
    await audit(roomId, actor, `created ${kind === "post" ? "post " : ""}flair "${name}"${self ? " (self-assignable)" : ""}${modOnly ? " (mods only)" : ""}`);
  } else {
    await runQuery("UPDATE pad_flairs SET name = ?, color = ?, emoji = ?, self_assign = ?, mod_only = ?, updated = ? WHERE id = ? AND room_id = ?",
                   [name, color.hex, emoji || null, self, modOnly, t, id, roomId]);
    await audit(roomId, actor, `edited ${kind === "post" ? "post " : ""}flair "${name}"`);
  }
  drop(roomId);
  return kind === "post" ? postFlairs(roomId) : list(roomId);
}
/** Delete a flair (everyone wearing it loses it). */
async function remove(actor, roomId, flairId) {
  await init();
  await mustManage(actor, roomId);
  const f = (await getQuery("SELECT * FROM pad_flairs WHERE id = ? AND room_id = ?", [Number(flairId), roomId]))[0];
  if (!f) throw new Refuse(404, "No such flair in this pad.");
  await runQuery("DELETE FROM pad_user_flairs WHERE room_id = ? AND flair_id = ?", [roomId, f.id]);
  await runQuery("DELETE FROM feed_post_flair WHERE room_id = ? AND flair_id = ?", [roomId, f.id]);      // 1.99wq: posts lose a deleted post flair
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
    const f = (await getQuery("SELECT * FROM pad_flairs WHERE id = ? AND room_id = ? AND COALESCE(kind, 'user') != 'post'", [Number(flairId), roomId]))[0];
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
    const f = (await getQuery("SELECT * FROM pad_flairs WHERE id = ? AND room_id = ? AND COALESCE(kind, 'user') != 'post'", [Number(flairId), roomId]))[0];
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
  // 1.99wq: post flair - how many live posts carry each one; the pad's own tags (feedtags.js)
  const L = await load(roomId);
  const pn = new Map();
  if (L.postFlairs.length) {
    for (const r of await getQuery(`SELECT pf.flair_id, COUNT(*) AS n FROM feed_post_flair pf JOIN feed_posts p ON p.id = pf.post_id
                                    WHERE pf.room_id = ? AND p.deleted_at IS NULL GROUP BY pf.flair_id`, [roomId]).catch(() => [])) pn.set(Number(r.flair_id), r.n);
  }
  const TG = require("./feedtags");
  return { flairs: flairs.map((f) => ({ ...f, n: count.get(f.id) || 0 })), people, max: maxFlairs(roomId), nameMax: NAME_MAX, palette: LOOK().PALETTE,
           post: { flairs: L.postFlairs.map((f) => ({ ...f, n: pn.get(f.id) || 0 })), required: L.required, max: maxPostFlairs(roomId) },
           padTags: await TG.padTags(roomId).catch(() => []), padTagsMax: TG.MAX_PAD_TAGS };
}

// ── 1.99wq: post flair ──
const maxPostFlairs = (roomId) => (plusPad(roomId) ? MAX_POST_FLAIRS_PLUS : MAX_POST_FLAIRS);
/** The pad's post flairs (shaped, with mod_only). */
async function postFlairs(roomId) { return flairable(roomId) ? (await load(roomId)).postFlairs : []; }
/** {required, flairs} - what a composer / Pepe needs to label a post in this pad. */
async function postRules(roomId) {
  if (!flairable(roomId)) return { required: false, flairs: [] };
  const L = await load(roomId);
  return { required: L.required && L.postFlairs.length > 0, flairs: L.postFlairs };
}
const bareName = (x) => String(x || "").normalize("NFKC").replace(/\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
/** A post flair by id (a number / numeric string) or by name (case-insensitive, an emoji prefix tolerated), or null. */
function findPostFlair(flairs, raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "object" && raw.id != null) raw = raw.id;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && String(raw).trim() === String(n)) return flairs.find((f) => f.id === n) || null;
  const want = bareName(raw);
  if (!want) { const e = String(raw).replace(/\s+/g, ""); return flairs.find((f) => f.emoji && f.emoji === e) || null; }
  return flairs.find((f) => bareName(f.name) === want) || null;
}
/** May this account use mods-only post flair here? The pad's managers, and Pepe in a house pad (he is the house). */
async function mayModFlair(actor, roomId) {
  if (!actor || !actor.userId) return false;
  if (await rooms.canManage(actor, roomId)) return true;
  const R = rooms.getCached(roomId);
  return actor.userId === "pepe-bot" && !!(R && R.house);
}
/**
 * The flair a new / edited post will carry in its home pad: input = an id or a name ("" / null = none).
 * Throws Refuse for an unknown flair, a mods-only one used by someone who isn't a mod, or none where the pad requires one
 * (opts.exempt: an automatic post made for someone - the requirement doesn't apply). -> the flair or null
 */
async function checkPostFlair(actor, roomId, input, { exempt = false } = {}) {
  await init();
  if (!flairable(roomId)) return null;
  const R = await postRules(roomId);
  const none = input == null || input === "" || input === 0 || input === "0";
  if (none) {
    if (R.required && !exempt) throw new Refuse(400, "This pad asks for a flair on every post - pick one.");
    return null;
  }
  const f = findPostFlair(R.flairs, input);
  if (!f) throw new Refuse(400, "That flair isn't one of this pad's post flairs.");
  if (f.mod_only && !(await mayModFlair(actor, roomId))) throw new Refuse(403, `Only this pad's mods can use the "${f.name}" flair.`);
  return f;
}
/** Put a flair on a post (null = take it off). */
async function setPostFlair(postId, roomId, flair, by = null) {
  await init();
  if (!flair) { await runQuery("DELETE FROM feed_post_flair WHERE post_id = ?", [String(postId)]); return null; }
  await runQuery(`INSERT INTO feed_post_flair (post_id, room_id, flair_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(post_id) DO UPDATE SET room_id = excluded.room_id, flair_id = excluded.flair_id, set_by = excluded.set_by, set_at = excluded.set_at`,
                 [String(postId), String(roomId), Number(flair.id), by, NOW()]);
  return flair;
}
/** Posts -> Map(postId -> flair) (their home pad's post flair; one query + the cached pads). */
async function postFlairsFor(ids) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  await init();
  const rows = await getQuery(`SELECT post_id, room_id, flair_id FROM feed_post_flair WHERE post_id IN (${ids.map(() => "?").join(",")})`, ids.map(String));
  for (const r of rows) {
    const f = (await load(r.room_id)).postFlairs.find((x) => x.id === Number(r.flair_id));
    if (f) out.set(String(r.post_id), f);
  }
  return out;
}
/** feedstore.list's ?flair= filter: posts carrying this post flair (alias p = feed_posts). */
function filterSql(flairId) {
  return { sql: "p.id IN (SELECT post_id FROM feed_post_flair WHERE flair_id = ?)", args: [Number(flairId) || 0] };
}
/** "Posts here need a flair" on / off (the pad's owner / mods). */
async function setRequired(actor, roomId, on) {
  await init();
  await mustManage(actor, roomId);
  await runQuery(`INSERT INTO pad_flair_cfg (room_id, post_required, updated, by) VALUES (?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET post_required = excluded.post_required, updated = excluded.updated, by = excluded.by`,
                 [roomId, on ? 1 : 0, NOW(), who(actor)]);
  await audit(roomId, actor, on ? "posts need a flair" : "post flair optional");
  drop(roomId);
  return postRules(roomId);
}
/** The post-flair chip (escaped; strict hex colours); href = the pad's feed filtered by it. */
function postHtml(f, href = null) {
  if (!f || !f.name) return "";
  const inner = `${f.emoji ? `<span class="ufl-e" aria-hidden="true">${esc(f.emoji)}</span>` : ""}<span class="ufl-n">${esc(f.name)}</span>`;
  const st = `style="--fl:${esc(f.color)};--fli:${esc(f.ink)}"`;
  return href ? `<a class="pfl-post" ${st} href="${esc(href)}" title="Post flair: ${esc(f.name)}">${inner}</a>`
              : `<span class="pfl-post" ${st} title="Post flair: ${esc(f.name)}">${inner}</span>`;
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
      // 1.99wq: the post flairs this viewer may use (the Edit form's choices)
      const PR = await postRules(R.id);
      const modF = await mayModFlair(u, R.id);
      const post = { required: PR.required, flairs: PR.flairs.filter((f) => modF || !f.mod_only) };
      res.json({ ok: true, flairs: await list(R.id), post, mine: u ? await mine(u, R.id) : null, ...(manage ? { manage: await manageView(R.id) } : {}) });
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
  // 1.99wq: "posts here need a flair"
  app.post("/api/pads/:slug/flair/required", addUser, async (req, res) => {
    try { const w = await write(req, res); if (!w) return; await setRequired(w.u, w.R.id, (req.body || {}).on === true); res.json({ ok: true, manage: await manageView(w.R.id) }); } catch (e) { fail(res, e); }
  });
  // 1.99wq: the pad's own tags (feedtags.padTags) - shown first in its tag bar and the composer's suggestions
  app.post("/api/pads/:slug/flair/tags", addUser, async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      await mustManage(w.u, w.R.id);
      await require("./feedtags").setPadTags(w.u, w.R.id, (req.body || {}).tags);
      res.json({ ok: true, manage: await manageView(w.R.id) });
    } catch (e) { fail(res, e); }
  });
  // 1.99wq: a post's flair - its author, or the pad's mods (posts whose home pad this is)
  app.post("/api/pads/:slug/flair/post", addUser, async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      const b = req.body || {};
      const p = (await getQuery("SELECT id, author_id, home_pad, deleted_at FROM feed_posts WHERE id = ?", [String(b.post || "")]))[0];
      if (!p || p.deleted_at || p.home_pad !== w.R.id) return res.status(404).json({ ok: false, error: "No such post in this pad." });
      const mod = await rooms.canManage(w.u, w.R.id);
      if (!mod && p.author_id !== w.u.userId) return res.status(403).json({ ok: false, error: "Only the post's author and this pad's mods can change its flair." });
      const f = await checkPostFlair(w.u, w.R.id, b.flair, { exempt: mod });
      await setPostFlair(p.id, w.R.id, f, who(w.u));
      if (mod && p.author_id !== w.u.userId) await audit(w.R.id, w.u, `set post ${p.id}'s flair to ${f ? `"${f.name}"` : "none"}`);
      res.json({ ok: true, flair: f });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/flair/mine", addUser, async (req, res) => {
    try { const w = await write(req, res); if (!w) return; res.json({ ok: true, mine: await pick(w.u, w.R.id, (req.body || {}).flair) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { postFlairs, postRules, findPostFlair, checkPostFlair, setPostFlair, postFlairsFor, filterSql, setRequired, postHtml, mayModFlair, maxPostFlairs,
                   MAX_POST_FLAIRS, MAX_POST_FLAIRS_PLUS,
                   init, register, list, forUsers, byUsername, of, html, plain, dropAll, plexFlair, save, remove, assign, pick, mine, manageView, cleanName, cleanEmoji, cleanColor,
                   Refuse, MAX_FLAIRS, MAX_FLAIRS_PLUS, maxFlairs, plusFlair, NAME_MAX, _drop: drop, _clear: () => cache.clear(), _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
