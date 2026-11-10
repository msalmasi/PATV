// houserotate.js — 1.99ano (Pepe account rotation): move Pepe's HOUSE PAD to his new Camfrog home room - its title and address
// with it - in ONE transaction, journaled with a before-image and an undo. Design: the rotation design of 2026-11-10 (§2-§3.2).
//
// Pepe's Camfrog account is rotated now and then: the owner signs him into a new account, and that account owns a new home room
// (2026-11-10: PepeFrog / PepeFrog.Room "Pepe's Pad" -> Pepe_Frog / The_Swamp "The Swamp"). The site's house pad is keyed by
// that room's id (rooms_registry.room_id), so the pad moves to the new id the way a pad connect / disconnect moves one
// (padrekey.js) and becomes the house room (rooms_kv house_room -> rooms.houseRoom()). Its old addresses keep working: the old
// slug and the old id's slug are pad_slug_aliases, so /p/pepes-pad/... and /p/pepefrog-room/... 301 to /p/the-swamp/...
//
// Callers: Pepe's `!identity rotate` (the bot orchestrates and the SITE GOES FIRST) through POST /api/pepe/identity/rotate (bot
// token), and tools/house-rotate.js (a rehearsal on a copy of the database, or an emergency while the site is down).
//
// A change: {key, from: {room, login}, to: {room, title, slug, login}, merge, archive ("move" | "keep"), restore_of, actor}
//   plan    read-only: every count apply would move, the refusal if any, what the before-image holds
//   apply   one dbUtils.tx:
//     a guards     `from` must be the house pad (owner house, platform camfrog, = the house room), else not_house - unless `from`
//                  is gone and `to` already is the house with this title + slug ({already: true}). `to` owned -> to_owned; a
//                  stray pad at `to` (unowned: Pepe bridged the room first) with pad data -> to_has_data unless merge, else its
//                  row goes and its slug becomes an alias (as padconnect.finishCamfrog merges). Open stage slots on `from` ->
//                  open_slots. The key used by a different rotation -> key_conflict.
//     b journal    a house_rotations row with the before-image (the registry rows, both ids' aliases, the kv values, the rules,
//                  Pepe's welcome post, the archive row + its tier, the premium rows, per table.column the row ids that held
//                  `from`)
//     c re-key     padrekey.rekey(from, to, {keep: bridge_spans, livecam_audit}) - every pad row, the vault re-key for Pepe
//                  (pad_vault_rekeys), the seeded marker; the room's evidence stays with the Camfrog room id (D4)
//     d registry   rooms_registry.room_id, pad_connections.room_id
//     e archive    "move" (default, D1): chatlog_rooms room_id + pad_id and chatlog_meta tier:<id> - the pad's chat history stays
//                  continuous (chat_log rows are keyed by rk and don't change). A non-empty archive at `to` -> to_has_archive
//                  unless "keep" (the archive then stays under the old id: no pad, no Plus, purged to the free window after the
//                  grace).
//     f title      rooms_registry.title (60 characters)
//     g address    padaddress.renameInTx: the old slug becomes an alias, slug_set = 1 (an address the same = done)
//     h house      rooms_kv house_room = {id, title, slug, since, prev: [..., {id, title, slug, until}]}
//     i logins     rooms_kv pepe_logins (pepelogins.js: current + former) and escrow_meta / oracle_meta pepe_login
//     j text       exact replacements only: the rules intro (feed_kv rules:<id>) and Pepe's welcome post (title + body: old
//                  title -> new title, p/<old slug> -> p/<new slug>); everything else is history and stays
//     k event      room_events 'house-rotated', the journal's result, an admin_audit row (the API)
//   after the commit: padrekey.reloadCaches, pepelogins, the bridge (reslug, refresh both ids, the live slug), the chat archive's
//   caches (chatlogview.moveRoom / reconcileNow), one notice to the site Admins.
//   status  the journal, newest first, and the house room
//   restore_of <key>  the reverse rotation: back to the old id, then the before-image's title, slug, slug_set, slug_changed_at,
//                  aliases, kv values, rules, welcome text and archive row. Refused while a later rotation exists. The LOGIN does
//                  not go back (the Camfrog account changed) - the logins follow the request.
// A login-only change (the same room, title and address) runs only i; a name-only change (the same room) skips c-e.
// Idempotent: a change already in place answers {already: true} and writes nothing.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const rooms = require("./rooms");
const PL = require("./pepelogins");

// D4: the Camfrog room's evidence stays with its id. 1.99ano (review S11): so do the room's privacy audit (seethrough_log: which
// logins an admin revealed IN that room) and where an on-air consent was asked (onair_consent.room - its pad column moves with
// the pad; the consent itself never carried over: session allows live in memory, "always" is per pad / per cam owner)
const KEEP = Object.freeze(["bridge_spans", "livecam_audit", "seethrough_log", "onair_consent.room"]);
const kept = (t, c) => KEEP.includes(t) || KEEP.includes(`${t}.${c}`);
// 1.99ano (review S9): the bot keys allowed to rotate the house pad - Pepe's own (prod / staging). A key of any other caller
// (the shared /api/pepe family covers the VM supervisor's) is refused; the shared legacy token still works (counted by botkeys)
const PEPE_CALLERS = new Set(["pepe", "pepe-staging"]);
const TITLE_MAX = 60;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{0,79}$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9_.@\-]{0,59}$/;
const PEPE_FEED_ID = "pepe-bot";                                    // feedstore.PEPE_ID: Pepe's site account (his feed posts)
const ROWIDS_MAX = 60000;                                           // the before-image keeps row ids up to this many (counts after)

class Refuse extends Error {
  constructor(status, code, msg, extra) { super(msg); this.status = status; this.code = code; this.refuse = true; this.extra = extra || null; }
}
const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const cleanTitle = (v) => String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
const lower = (s) => String(s || "").toLowerCase();
const dayKey = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const escLike = (s) => String(s).replace(/[\\%_]/g, (m) => "\\" + m);

async function tablesNow() { return new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name)); }
async function regRow(id) { return id ? (await getQuery("SELECT * FROM rooms_registry WHERE room_id = ?", [id]))[0] || null : null; }
async function kvRaw(table, key) {
  try { const r = (await getQuery(`SELECT value FROM ${q(table)} WHERE key = ?`, [key]))[0]; return r ? r.value : null; } catch (e) { return null; }
}
async function kvPut(table, key, value) {
  if (value == null) return runQuery(`DELETE FROM ${q(table)} WHERE key = ?`, [key]);
  return runQuery(`INSERT INTO ${q(table)} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(value)]);
}
/** The house room as the DATABASE says (the cache may be another process's): rooms_kv house_room, else the env / literal default. */
async function dbHouse() {
  const h = parse(await kvRaw("rooms_kv", "house_room"));
  return { id: (h && typeof h.id === "string" && h.id) || rooms.HOUSE_DEFAULT, rec: h && h.id ? h : null };
}

// ── the request ──
/**
 * A request body -> the change (cleaned), or throws Refuse(400, "bad_request"). from.room defaults to the house room; to.title to
 * the pad's title, to.slug to slugify(to.title) (only when a title is given, else the pad's slug); key to rot-<yyyymmdd>-<to room>.
 */
async function cleanChange(b, now = Date.now()) {
  if (!b || typeof b !== "object") throw new Refuse(400, "bad_request", "A JSON body is needed.");
  const bad = (m) => { throw new Refuse(400, "bad_request", m); };
  const from = b.from && typeof b.from === "object" ? b.from : {};
  const to = b.to && typeof b.to === "object" ? b.to : {};
  const archive = b.archive == null || b.archive === "" ? "move" : String(b.archive);
  if (!["move", "keep"].includes(archive)) bad('archive is "move" or "keep".');
  const restoreOf = b.restore_of == null || b.restore_of === "" ? null : String(b.restore_of);
  if (restoreOf && !KEY_RE.test(restoreOf)) bad("restore_of is a rotation key.");
  const house = (await dbHouse()).id;
  const fromRoom = String(from.room == null || from.room === "" ? house : from.room).trim();
  const toRoom = String(to.room == null || to.room === "" ? (restoreOf ? "" : fromRoom) : to.room).trim();
  for (const [k, v] of [["from.room", fromRoom], ...(toRoom ? [["to.room", toRoom]] : [])]) {
    if (!rooms.ROOM_ID_RE.test(v)) bad(`${k} isn't a Camfrog room id.`);
    if (rooms.platformFromId(v) !== "camfrog") bad(`${k} must be a Camfrog room id (not a site / profile / other platform pad).`);
  }
  const toLogin = String(to.login == null ? "" : to.login).trim();
  const fromLogin = String(from.login == null ? "" : from.login).trim();
  if (!toLogin) bad("to.login (Pepe's Camfrog login now) is needed.");
  if (!LOGIN_RE.test(toLogin)) bad("to.login isn't a Camfrog login.");
  if (fromLogin && !LOGIN_RE.test(fromLogin)) bad("from.login isn't a Camfrog login.");
  const title = to.title == null ? "" : cleanTitle(to.title);
  if (to.title != null && String(to.title).trim() && !title) bad("to.title is empty.");
  const slugRaw = to.slug == null ? "" : String(to.slug).trim();
  const key0 = b.key == null || b.key === "" ? null : String(b.key);
  if (key0 && !KEY_RE.test(key0)) bad("key: letters, digits and . _ : - (up to 80).");
  const key = key0 || (restoreOf ? `${restoreOf.slice(0, 75)}-undo` : `rot-${dayKey(now)}-${lower(toRoom).replace(/[^a-z0-9._:\-]/g, "-")}`.slice(0, 80));
  return { key, from: { room: fromRoom, login: fromLogin || null }, to: { room: toRoom || null, title: title || null, slug: slugRaw || null, login: toLogin },
           merge: b.merge === true || b.merge === 1 || /^(1|true|on|yes)$/i.test(String(b.merge || "")), archive, restore_of: restoreOf,
           actor: String(b.actor || "pepe").replace(CTRL, "").trim().slice(0, 60) || "pepe" };
}

// ── what the rows look like now ──
/** The pad's rows at `id` per table.column (what padrekey moves, minus KEEP) + the special keys. -> {move, keep, extra} */
async function survey(id, { tables } = {}) {
  const T = tables || (await tablesNow());
  const RK = require("./padrekey");
  const move = {}, keep = {}, extra = {};
  const cnt = async (sql, params) => { try { return Number(((await getQuery(sql, params))[0] || {}).n) || 0; } catch (e) { return 0; } };
  for (const [t, c] of await RK.padColumns()) {
    if (t === "follows" && c !== "target_id") continue;
    const n = await cnt(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${q(c)} = ?`, [id]);
    if (!n) continue;
    (kept(t, c) ? keep : move)[`${t}.${c}`] = n;
  }
  const put = (k, n) => { if (n) extra[k] = n; };
  if (T.has("follows")) put("follows.target_id", await cnt("SELECT COUNT(*) AS n FROM follows WHERE target_kind = 'room' AND target_id = ?", [id]));
  if (T.has("feed_kv")) for (const p of RK.FEED_KV_PREFIXES) put("feed_kv." + p, await cnt("SELECT COUNT(*) AS n FROM feed_kv WHERE key = ?", [p + id]));
  if (T.has("rooms_kv")) {
    put("rooms_kv.seeded", await cnt("SELECT COUNT(*) AS n FROM rooms_kv WHERE key = ?", ["seeded:" + id]));
    for (const p of RK.ROOMS_KV_PREFIXES) put("rooms_kv." + p, await cnt("SELECT COUNT(*) AS n FROM rooms_kv WHERE key = ?", [p + id]));
  }
  if (T.has("feed_seen")) put("feed_seen.scope", await cnt("SELECT COUNT(*) AS n FROM feed_seen WHERE scope = ?", ["pad:" + id]));
  if (T.has("pepe_feed_log")) put("pepe_feed_log.scope", await cnt("SELECT COUNT(*) AS n FROM pepe_feed_log WHERE scope = ?", [id]));
  if (T.has("premium_subs")) put("premium_subs.target", await cnt("SELECT COUNT(*) AS n FROM premium_subs WHERE target = ? AND tier IN ('prime_time','prime_plus')", [id]));
  if (T.has("premium_ledger")) put("premium_ledger.target", await cnt("SELECT COUNT(*) AS n FROM premium_ledger WHERE target = ? AND tier IN ('prime_time','prime_plus')", [id]));
  if (T.has("pepe_modlog")) put("pepe_modlog.room_l", await cnt("SELECT COUNT(*) AS n FROM pepe_modlog WHERE room_id = ? AND room_l = ?", [id, lower(id)]));
  if (T.has("sb_clips")) put("sb_clips.board", await cnt("SELECT COUNT(*) AS n FROM sb_clips WHERE board = ?", ["room:" + id]));
  if (T.has("backend_wants")) put("backend_wants.feature", await cnt("SELECT COUNT(*) AS n FROM backend_wants WHERE feature = ?", ["casino:" + id]));
  if (T.has("media_requests")) put("media_requests.pad_id", await cnt("SELECT COUNT(*) AS n FROM media_requests WHERE pad_id = ?", [id]));
  if (T.has("feed_kv")) {
    const v = parse(await kvRaw("feed_kv", "aigen_prices"));
    if (v && v.rooms && typeof v.rooms === "object" && Object.prototype.hasOwnProperty.call(v.rooms, id)) extra["feed_kv.aigen_prices"] = 1;
  }
  return { move, keep, extra };
}
/** Pad data at `id` that a merge would mix with the house pad's (the registry row's own bookkeeping - its aliases, its events - left out). */
function padData(s) {
  const out = {};
  for (const [k, n] of Object.entries({ ...s.move, ...s.extra })) {
    if (/^(pad_slug_aliases|room_events)\./.test(k)) continue;
    out[k] = n;
  }
  return out;
}
/** The archive row of `id`: {rk, lines} | null (no archive tables on this site: null). */
async function archiveOf(id, T) {
  if (!T.has("chatlog_rooms")) return null;
  const r = (await getQuery("SELECT rk, rows FROM chatlog_rooms WHERE room_id = ?", [id]))[0];
  if (!r) return null;
  let lines = Number(r.rows) || 0;
  try { lines = Math.max(lines, Number(((await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE rk = ?", [r.rk]))[0] || {}).n) || 0); } catch (e) { /* no chat_log table */ }
  return { rk: Number(r.rk), lines };
}
/** Pepe's pinned welcome post on the pad: the id setup-pepes-pad stored (feed_kv pepespad:welcome:<id>), else his post titled
 *  "...Welcome to <title>..." on it. -> {id, title, body} | null */
async function welcomePost(padId, title, T) {
  if (!T.has("feed_posts")) return null;
  const stored = T.has("feed_kv") ? await kvRaw("feed_kv", "pepespad:welcome:" + padId) : null;
  if (stored) {
    const r = (await getQuery("SELECT id, title, body FROM feed_posts WHERE id = ? AND deleted_at IS NULL", [stored]).catch(() => []))[0];
    if (r) return r;
  }
  if (!title) return null;
  return (await getQuery(`SELECT id, title, body FROM feed_posts WHERE author_id = ? AND home_pad = ? AND deleted_at IS NULL AND title LIKE ? ESCAPE '\\'
                          ORDER BY created LIMIT 1`, [PEPE_FEED_ID, padId, "%Welcome to " + escLike(title) + "%"]).catch(() => []))[0] || null;
}
/** text with every `p/<old>` (a whole slug: not followed by another slug character) -> `p/<new>`. */
function relink(text, oldSlug, newSlug) {
  if (!text || !oldSlug || oldSlug === newSlug) return text;
  const re = new RegExp("(^|[^A-Za-z0-9_-])p/" + oldSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9-])", "g");
  return String(text).replace(re, (m, pre) => pre + "p/" + newSlug);
}
const swap = (text, a, b) => (text && a && a !== b ? String(text).split(a).join(b) : text);

/** Per table.column, the row ids (or primary keys of WITHOUT ROWID tables) that hold `id` - the before-image's row map. */
async function rowIds(id) {
  const RK = require("./padrekey");
  const out = {};
  let total = 0, truncated = false;
  for (const [t, c] of await RK.padColumns()) {
    if ((t === "follows" && c !== "target_id") || kept(t, c)) continue;
    let ids = null;
    try { ids = (await getQuery(`SELECT rowid AS r FROM ${q(t)} WHERE ${q(c)} = ?`, [id])).map((x) => x.r); }
    catch (e) {
      const pk = (await getQuery(`PRAGMA table_info(${q(t)})`)).filter((x) => x.pk > 0).sort((a, b) => a.pk - b.pk).map((x) => x.name);
      if (pk.length) ids = (await getQuery(`SELECT ${pk.map(q).join(", ")} FROM ${q(t)} WHERE ${q(c)} = ?`, [id]).catch(() => [])).map((x) => pk.map((k) => x[k]));
    }
    if (!ids || !ids.length) continue;
    total += ids.length;
    if (total > ROWIDS_MAX) { truncated = true; out[`${t}.${c}`] = ids.length; continue; }
    out[`${t}.${c}`] = ids;
  }
  return { rows: out, total, truncated };
}

/** Everything the undo needs, read now (inside the transaction, before any write). */
async function beforeImage(from, to, T) {
  const aliases = async (id) => getQuery("SELECT slug, room_id, created, by FROM pad_slug_aliases WHERE room_id = ?", [id]);
  const F = await regRow(from), TR = to && to !== from ? await regRow(to) : null;
  const kv = {};
  for (const k of ["house_room", PL.KV_KEY, "seeded:" + from, "pepespad:art:" + from, ...(to && to !== from ? ["seeded:" + to, "pepespad:art:" + to] : [])]) kv[k] = await kvRaw("rooms_kv", k);
  const feedKv = {};
  if (T.has("feed_kv")) for (const k of ["rules:" + from, "pepespad:welcome:" + from]) feedKv[k] = await kvRaw("feed_kv", k);
  const W = await welcomePost(from, F && F.title, T);
  let archive = null;
  if (T.has("chatlog_rooms")) {
    archive = { row: (await getQuery("SELECT * FROM chatlog_rooms WHERE room_id = ?", [from]))[0] || null,
                tier: T.has("chatlog_meta") ? await kvRaw("chatlog_meta", "tier:" + from) : null };
  }
  const premium = T.has("premium_subs") ? await getQuery("SELECT * FROM premium_subs WHERE target = ?", [from]) : [];
  return {
    registry: { from: F, to: TR }, aliases: { from: await aliases(from), to: to && to !== from ? await aliases(to) : [] },
    kv, feed_kv: feedKv, welcome: W ? { id: W.id, title: W.title, body: W.body } : null, archive, premium,
    meta: { escrow: T.has("escrow_meta") ? await kvRaw("escrow_meta", "pepe_login") : null, oracle: T.has("oracle_meta") ? await kvRaw("oracle_meta", "pepe_login") : null },
    ...(to && to !== from ? await rowIds(from) : { rows: {}, total: 0, truncated: false }),
  };
}

async function ensureJournal() {
  await runQuery(`CREATE TABLE IF NOT EXISTS house_rotations (id INTEGER PRIMARY KEY, key TEXT UNIQUE, from_id TEXT, to_id TEXT, at INTEGER,
                  actor TEXT, before TEXT, result TEXT, restored_by INTEGER)`);
}
async function journalByKey(key) {
  try { return (await getQuery("SELECT * FROM house_rotations WHERE key = ?", [key]))[0] || null; } catch (e) { return null; }
}

// ── the decision: what this change is, and whether it may run ──
/**
 * Read-only. -> {c, mode ("move" | "rename" | "login"), already, refusal, F, T, stray, house, title, slug, logins, ...} for
 * plan and apply alike (apply re-runs it inside its transaction). mode: move = a new room id; rename = the same room, a new title
 * or address; login = the same room, title and address (only Pepe's logins).
 */
async function decide(c, opts = {}) {
  const T = await tablesNow();
  const H = await dbHouse();
  let from = c.from.room, to = c.to.room;
  let R0 = null, B = null, RES = null;
  const refuse = (status, code, error, extra) => ({ status, code, error, ...(extra || {}) });
  const out = { c, T, house: H.id, houseRec: H.rec, refusal: null, already: false };
  const prior = await journalByKey(c.key);
  if (c.restore_of) {
    R0 = await journalByKey(c.restore_of);
    if (!R0) return { ...out, refusal: refuse(404, "no_such_rotation", `There is no rotation "${c.restore_of}".`) };
    B = parse(R0.before, {}) || {};
    RES = parse(R0.result, {}) || {};
    if (to && to !== R0.from_id) return { ...out, refusal: refuse(400, "restore_mismatch", `Rotation ${c.restore_of} came from ${R0.from_id}, not ${to}.`) };
    from = R0.to_id; to = R0.from_id;
    out.c = c = { ...c, from: { ...c.from, room: from }, to: { ...c.to, room: to, title: (B.registry && B.registry.from && B.registry.from.title) || c.to.title,
                                                               slug: (B.registry && B.registry.from && B.registry.from.slug) || c.to.slug } };
    out.R0 = R0; out.B = B; out.RES = RES;
  }
  const same = from === to;
  const F = await regRow(from);
  const TR = same ? F : await regRow(to);
  out.F = F; out.TR = TR;
  const cur = PL.parseRecord(await kvRaw("rooms_kv", PL.KV_KEY));
  const wantLogins = PL.merge(cur, { current: c.to.login, former: c.from.login ? [c.from.login] : [] });
  out.logins = { now: cur, want: wantLogins };
  const loginsInPlace = cur.current === wantLogins.current && wantLogins.former.every((x) => cur.former.includes(x));
  const base = F || TR;
  const title = c.to.title || (base && base.title) || to;
  const slug = c.to.slug ? require("./padaddress").fold(c.to.slug) : c.to.title ? rooms.slugify(c.to.title) : (base && base.slug) || rooms.slugify(to);
  out.title = title; out.slug = slug;
  out.mode = !same ? "move" : (F && (F.title !== title || F.slug !== slug)) ? "rename" : "login";
  // the journal: this key done before
  if (prior) {
    if (prior.from_id !== from || prior.to_id !== to) return { ...out, refusal: refuse(409, "key_conflict", `The key ${c.key} belongs to another rotation (${prior.from_id} -> ${prior.to_id}).`) };
    if (prior.restored_by) return { ...out, refusal: refuse(409, "key_conflict", `Rotation ${c.key} was undone - use a new key.`) };
    return { ...out, already: true, journal: prior };
  }
  if (R0) {
    if (R0.restored_by) return { ...out, refusal: refuse(409, "already_restored", `Rotation ${c.restore_of} was undone already.`) };
    const later = (await getQuery("SELECT key FROM house_rotations WHERE id > ? ORDER BY id LIMIT 1", [R0.id]))[0];
    if (later) return { ...out, refusal: refuse(409, "later_rotation", `Rotation ${later.key} came after ${c.restore_of} - undo that one first.`) };
  }
  // already in place (a run that finished, or nothing to do)
  const houseIs = (row) => !!row && row.owner_kind === "house" && row.room_id === H.id;
  if (!same && !F && houseIs(TR) && TR.title === title && TR.slug === slug && loginsInPlace) return { ...out, already: true };
  if (same && houseIs(F) && F.title === title && F.slug === slug && loginsInPlace) return { ...out, already: true };
  // validation that needs the database
  if (!R0 && !same && lower(from) !== lower(to) && rooms.retiredHouseRooms().concat(H.rec && Array.isArray(H.rec.prev) ? H.rec.prev.map((p) => p && p.id) : [])
    .some((x) => x && lower(x) === lower(to))) {
    return { ...out, refusal: refuse(409, "retired_home", `${to} is one of Pepe's earlier home rooms - undo that rotation instead (restore_of).`) };
  }
  // a guards
  if (!F || F.owner_kind !== "house" || rooms.cleanPlatform(F.platform, F.room_id) !== "camfrog" || F.room_id !== H.id) {
    return { ...out, refusal: refuse(409, "not_house", F ? `${from} isn't the house pad (the house room is ${H.id}).` : `There is no pad ${from} (the house room is ${H.id}).`) };
  }
  const A = require("./padaddress");
  const sp = A.formProblem(slug);
  if (sp) return { ...out, refusal: refuse(400, "bad_slug", `p/${slug}: ${sp}`) };
  if (out.mode === "move") {
    if (TR) {
      if (TR.owner_kind !== "none") return { ...out, refusal: refuse(409, "to_owned", `${to} already has a pad with an owner (p/${TR.slug}, ${TR.owner_kind}).`) };
      const data = padData(await survey(to, { tables: T }));
      out.toData = data;
      if (Object.keys(data).length && !c.merge) {
        return { ...out, refusal: refuse(409, "to_has_data", `${to} already has a pad (p/${TR.slug}) with its own rows - look at them, then send merge to fold them in.`, { counts: data }) };
      }
      out.stray = { room: TR.room_id, slug: TR.slug, title: TR.title };
    }
    let slots = 0;
    try { slots = await require("./padconnect").openSlots(from); } catch (e) { slots = 0; }
    if (slots) return { ...out, refusal: refuse(409, "open_slots", `The house pad's stage has ${slots} live or waiting slot(s) - end them first.`) };
    const moved = R0 ? RES.archive === "moved" : c.archive === "move";
    out.archiveFrom = await archiveOf(from, T);
    out.archiveTo = await archiveOf(to, T);
    out.archiveMode = moved && out.archiveFrom ? "move" : "keep";
    if (out.archiveMode === "move" && out.archiveTo && out.archiveTo.lines > 0) {
      return { ...out, refusal: refuse(409, "to_has_archive", `${to} has a chat archive of its own (${out.archiveTo.lines} lines) - send archive "keep" to leave the house pad's under ${from}.`, { lines: out.archiveTo.lines }) };
    }
  }
  // the address: free for this pad (after the move: a stray's own slug is fine, it goes)
  if (slug !== (F && F.slug)) {
    const al = (await getQuery("SELECT room_id FROM pad_slug_aliases WHERE slug = ?", [slug]))[0];
    const reg = (await getQuery("SELECT room_id FROM rooms_registry WHERE slug = ?", [slug]))[0];
    const ok = (id) => !id || id === from || id === to;
    if (!ok(al && al.room_id) || !ok(reg && reg.room_id)) return { ...out, refusal: refuse(409, "slug_taken", `p/${slug} belongs to another pad.`) };
  }
  return out;
}

// ── plan ──
async function plan(body, opts = {}) {
  await rooms.init();
  const c = await cleanChange(body, opts.now);
  const d = await decide(c, opts);
  const res = { ok: !d.refusal, action: "plan", key: d.c.key, mode: d.mode, already: !!d.already, house: d.house,
                from: { room: d.c.from.room, title: d.F ? d.F.title : null, slug: d.F ? d.F.slug : null, login: d.c.from.login },
                to: { room: d.c.to.room, title: d.title, slug: d.slug, login: d.c.to.login },
                refusal: d.refusal ? { code: d.refusal.code, error: d.refusal.error, ...(d.refusal.counts ? { counts: d.refusal.counts } : {}) } : null,
                restore_of: d.c.restore_of || null };
  res.logins = d.logins ? { now: d.logins.now, after: d.logins.want } : null;
  if (d.already || !d.F) return res;
  if (d.mode === "move") {
    const s = await survey(d.c.from.room, { tables: d.T });
    res.counts = { move: s.move, keep: s.keep, extra: s.extra, vault_rekey: 1 };
    res.stray = d.stray || null;
    res.to_data = d.toData || {};
    res.archive = { mode: d.archiveMode || "keep", from: d.archiveFrom || null, to: d.archiveTo || null };
  }
  const T = d.T;
  const aliases = await getQuery("SELECT slug FROM pad_slug_aliases WHERE room_id IN (?, ?)", [d.c.from.room, d.c.to.room]);
  const after = new Set(aliases.map((a) => a.slug));
  if (d.F.slug !== d.slug) after.add(d.F.slug);
  if (d.stray && d.stray.slug && d.stray.slug !== d.slug) after.add(d.stray.slug);
  after.delete(d.slug);
  res.address = { from: d.F.slug, to: d.slug, aliases_after: [...after].sort() };
  const rules = parse(T.has("feed_kv") ? await kvRaw("feed_kv", "rules:" + d.c.from.room) : null);
  const W = await welcomePost(d.c.from.room, d.F.title, T);
  res.text = { rules_intro: !!(rules && rules.intro && d.F.title && d.F.title !== d.title && String(rules.intro).includes(d.F.title)),
               welcome_post: W ? W.id : null };
  return res;
}

// ── apply ──
/** The writes for one change - inside the transaction. -> the result (kept in the journal) */
async function writeChange(d, now) {
  const RK = require("./padrekey");
  const A = require("./padaddress");
  const c = d.c, T = d.T;
  const from = c.from.room, to = c.to.room;
  const F = d.F;
  const result = { key: c.key, mode: d.mode, from, to, at: now, moved: {}, archive: "none", title: { from: F.title, to: d.title },
                   slug: { from: F.slug, to: d.slug }, restore_of: c.restore_of || null };
  // b journal (the before-image first: nothing is written yet)
  await ensureJournal();
  const before = await beforeImage(from, to, T);
  const j = await runQuery("INSERT INTO house_rotations (key, from_id, to_id, at, actor, before, result) VALUES (?, ?, ?, ?, ?, ?, NULL)",
                           [c.key, from, to, now, c.actor, JSON.stringify(before)]);
  result.id = j.id;
  if (d.mode === "move") {
    // a: the stray pad at `to` (unowned - Pepe bridged the room before the rotation) folds in; its address redirects
    if (d.stray) await runQuery("DELETE FROM rooms_registry WHERE room_id = ?", [to]);
    // c re-key
    const rk = await RK.rekey(from, to, { keep: KEEP.slice() });
    result.moved = rk.moved;
    // d registry
    await runQuery("UPDATE rooms_registry SET room_id = ?, updated = ? WHERE room_id = ?", [to, now, from]);
    if (T.has("pad_connections")) await runQuery("UPDATE pad_connections SET room_id = ? WHERE room_id = ?", [to, from]);
    if (d.stray && d.stray.slug && d.stray.slug !== d.slug && !(await getQuery("SELECT 1 FROM rooms_registry WHERE slug = ?", [d.stray.slug])).length) {
      await runQuery("INSERT OR IGNORE INTO pad_slug_aliases (slug, room_id, created, by) VALUES (?, ?, ?, ?)", [d.stray.slug, to, now, "house-rotate"]);
    }
    // e archive
    if (d.archiveMode === "move" && T.has("chatlog_rooms")) {
      if (d.archiveTo) {
        // an empty archive row at `to` (checked: no lines) goes first - the moving one takes its place
        if (T.has("chatlog_open")) await runQuery("DELETE FROM chatlog_open WHERE rk = ?", [d.archiveTo.rk]);
        await runQuery("DELETE FROM chatlog_rooms WHERE rk = ?", [d.archiveTo.rk]);
        if (T.has("chatlog_meta")) await runQuery("DELETE FROM chatlog_meta WHERE key = ?", ["tier:" + to]);
      }
      const u = await runQuery("UPDATE chatlog_rooms SET room_id = ?, pad_id = ? WHERE room_id = ?", [to, to, from]);
      if (T.has("chatlog_meta")) await runQuery("UPDATE OR REPLACE chatlog_meta SET key = ? WHERE key = ?", ["tier:" + to, "tier:" + from]);
      result.archive = u.changes ? "moved" : "none";
      if (u.changes) result.archive_rk = d.archiveFrom.rk;
    } else if (d.archiveFrom) result.archive = "kept";
  }
  // f title
  const R = await regRow(to);
  if (R.title !== d.title) await runQuery("UPDATE rooms_registry SET title = ?, updated = ? WHERE room_id = ?", [d.title, now, to]);
  // g address
  if (c.restore_of) {
    await restoreAddress(to, d, now);
  } else {
    const r = await A.renameInTx(to, d.slug, c.actor, now, { holder: () => null });
    result.address = r;
  }
  // h house room
  if (c.restore_of) {
    const v = d.B.kv ? d.B.kv.house_room : null;
    await kvPut("rooms_kv", "house_room", v == null ? null : v);
  } else {
    const prev = (d.houseRec && Array.isArray(d.houseRec.prev) ? d.houseRec.prev.slice(-19) : []);
    if (d.mode === "move" && lower(from) !== lower(to)) prev.push({ id: from, title: F.title, slug: F.slug, until: new Date(now).toISOString().slice(0, 10) });
    const since = d.houseRec && d.houseRec.id === to && d.houseRec.since ? d.houseRec.since : now;      // a rename / login change: the same home
    await kvPut("rooms_kv", "house_room", JSON.stringify({ id: to, title: d.title, slug: d.slug, since, prev }));
  }
  // i logins
  result.logins = await PL.save({ current: c.to.login, former: c.from.login ? [c.from.login] : [] }, now);
  for (const t of ["escrow_meta", "oracle_meta"]) {
    if (T.has(t)) await kvPut(t, "pepe_login", JSON.stringify(c.to.login));
  }
  // j stored text (exact replacements; a restore puts the before-image back)
  result.text = c.restore_of ? await restoreText(to, d) : await replaceText(to, F, d);
  // k event + the journal
  const detail = d.mode === "move"
    ? `${from} -> ${to}; p/${F.slug} -> p/${d.slug}; '${F.title}' -> '${d.title}'${c.restore_of ? ` (undo of ${c.restore_of})` : ""}`
    : `${d.mode === "rename" ? `p/${F.slug} -> p/${d.slug}; '${F.title}' -> '${d.title}'` : "logins only"}; login ${c.from.login || "?"} -> ${c.to.login}`;
  await rooms.event(to, "house-rotated", c.actor, detail);
  if (c.restore_of) await runQuery("UPDATE house_rotations SET restored_by = ? WHERE id = ?", [j.id, d.R0.id]);
  await runQuery("UPDATE house_rotations SET result = ? WHERE id = ?", [JSON.stringify(result), j.id]);
  return result;
}

/** g / h for an undo: the before-image's address (slug, slug_set, slug_changed_at); the rotation's address stays as an alias. */
async function restoreAddress(to, d, now) {
  const Bf = (d.B.registry && d.B.registry.from) || {};
  const row = await regRow(to);
  const want = Bf.slug || row.slug;
  if (want !== row.slug) {
    const other = (await getQuery("SELECT room_id FROM rooms_registry WHERE slug = ? AND room_id <> ?", [want, to]))[0];
    if (other) throw new Refuse(409, "slug_taken", `p/${want} is another pad's address now (${other.room_id}).`);
    await runQuery("DELETE FROM pad_slug_aliases WHERE slug = ?", [want]);
    await runQuery("INSERT OR IGNORE INTO pad_slug_aliases (slug, room_id, created, by) VALUES (?, ?, ?, ?)", [row.slug, to, now, "house-rotate-undo"]);
    const fv = await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feed_view'");
    if (fv.length) await runQuery("UPDATE OR REPLACE feed_view SET scope = ? WHERE scope = ?", ["p/" + want, "p/" + row.slug]);
  }
  await runQuery("UPDATE rooms_registry SET slug = ?, slug_set = ?, slug_changed_at = ?, updated = ? WHERE room_id = ?",
                 [want, Number(Bf.slug_set) ? 1 : 0, Bf.slug_changed_at == null ? null : Number(Bf.slug_changed_at), now, to]);
  for (const a of (d.B.aliases && d.B.aliases.from) || []) {
    if (a.slug === want) continue;
    await runQuery("INSERT OR IGNORE INTO pad_slug_aliases (slug, room_id, created, by) VALUES (?, ?, ?, ?)", [a.slug, to, a.created, a.by]);
  }
  // the kv values the rotation changed (seeded / pad art of the old id) - the house room and the logins are h / i
  for (const [k, v] of Object.entries(d.B.kv || {})) {
    if (k === "house_room" || k === PL.KV_KEY) continue;
    if (k === "seeded:" + to || k === "pepespad:art:" + to) await kvPut("rooms_kv", k, v);
  }
}
/** j: the rules intro and Pepe's welcome post - old title -> new title, p/<old slug> -> p/<new slug>. -> what changed */
async function replaceText(to, F, d) {
  const out = { rules_intro: false, welcome_post: null };
  const T = d.T;
  const oldT = F.title, newT = d.title, oldS = F.slug, newS = d.slug;
  if (T.has("feed_kv")) {
    const raw = await kvRaw("feed_kv", "rules:" + to);
    const v = parse(raw);
    if (v && typeof v === "object" && typeof v.intro === "string") {
      const intro = relink(swap(v.intro, oldT, newT), oldS, newS);
      if (intro !== v.intro) { v.intro = intro; await kvPut("feed_kv", "rules:" + to, JSON.stringify(v)); out.rules_intro = true; }
    }
  }
  const W = await welcomePost(to, oldT, T);
  if (W) {
    const title = swap(W.title, oldT, newT);
    const body = relink(swap(W.body, oldT, newT), oldS, newS);
    if (title !== W.title || body !== W.body) await runQuery("UPDATE feed_posts SET title = ?, body = ? WHERE id = ?", [title, body, W.id]);
    if (T.has("feed_kv")) await kvPut("feed_kv", "pepespad:welcome:" + to, W.id);
    out.welcome_post = W.id;
  }
  return out;
}
/** j for an undo: the before-image's rules and welcome post. */
async function restoreText(to, d) {
  const out = { rules_intro: false, welcome_post: null };
  const T = d.T, B = d.B;
  if (T.has("feed_kv")) {
    // the image was taken with the old id (this undo's `to`): its keys are this pad's keys again
    for (const k of ["rules:" + to, "pepespad:welcome:" + to]) {
      if (!Object.prototype.hasOwnProperty.call(B.feed_kv || {}, k)) continue;
      await kvPut("feed_kv", k, B.feed_kv[k]);
      if (/^rules:/.test(k)) out.rules_intro = true;
    }
  }
  if (B.welcome && B.welcome.id && T.has("feed_posts")) {
    await runQuery("UPDATE feed_posts SET title = ?, body = ? WHERE id = ?", [B.welcome.title, B.welcome.body, B.welcome.id]);
    out.welcome_post = B.welcome.id;
  }
  return out;
}

/** After the commit: the in-process caches, the bridge, the chat archive, the admins. opts.live = false (the CLI): none of it. */
async function afterCommit(d, result, opts = {}) {
  const from = result.from, to = result.to;
  await PL.refresh().catch((e) => console.error("[houserotate] logins:", e.message));
  if (opts.live === false) return;
  try { await require("./padrekey").reloadCaches(); } catch (e) { console.error("[houserotate] caches:", e.message); await rooms.loadCache().catch(() => {}); }
  let B = null;
  try { const p = require.resolve("./bridge"); B = require.cache[p] ? require.cache[p].exports : null; } catch (e) { B = null; }
  if (B) {
    try {
      B.reslug(to);
      const L = B._rooms.get(to);
      if (L) L.slug = (await rooms.get(to) || {}).slug || L.slug;
      B.refreshRoom(from); B.refreshRoom(to);
    } catch (e) { console.error("[houserotate] bridge:", e.message); }
  }
  if (result.mode === "move") {
    try {
      const CV = require("./chatlogview");
      if (result.archive === "moved") { CV.moveRoom(from, to); await CV.reconcileNow(to); }
      else { await CV.reconcileNow(to, { newPad: true }); await CV.reconcileNow(from); }
    } catch (e) { console.error("[houserotate] chat archive:", e.message); }
  }
  try {
    const P = await rooms.get(to);
    const title = `🪪 House pad: ${result.title.from} -> ${result.title.to}`;
    const body = result.mode === "move" ? `Pepe's house pad moved from Camfrog room ${from} to ${to}; p/${result.slug.from} now 301s to p/${result.slug.to}.`
                                        : `Pepe's house pad: ${result.mode === "rename" ? `p/${result.slug.from} -> p/${result.slug.to}` : "Pepe's login changed"}.`;
    for (const a of await getQuery("SELECT userId FROM users WHERE class = 'Admin'")) {
      await rooms.notify(a.userId, { kind: "stage", title, body, link: P ? "/p/" + encodeURIComponent(P.slug) : "/pads/admin", pm: false });
    }
  } catch (e) { console.error("[houserotate] admins:", e.message); }
}

/** Apply a change. -> {ok, action: "apply", key, already?, result?, house_room} or throws Refuse. opts: {now, live, audit} */
async function apply(body, opts = {}) {
  await rooms.init();
  try { await require("./adminaudit").init(); } catch (e) { /* no audit table: the API writes none */ }
  // every module the transaction uses is loaded before it opens (a module's first load never runs inside it)
  for (const m of ["./padrekey", "./hubpads", "./padaddress", "./padconnect", "./premium"]) { try { require(m); } catch (e) { /* not on this site */ } }
  const now = opts.now || Date.now();
  const c0 = await cleanChange(body, now);
  // the decision again inside the transaction (nothing can change between it and the writes)
  let d = null;
  const result = await tx(async () => {
    d = await decide(c0, opts);
    if (d.refusal) throw new Refuse(d.refusal.status, d.refusal.code, d.refusal.error, d.refusal.counts ? { counts: d.refusal.counts } : (d.refusal.lines != null ? { lines: d.refusal.lines } : null));
    if (d.already) return null;
    const r = await writeChange(d, now);
    if (opts.audit !== false) {
      try {
        await require("./adminaudit").record({ userId: "bot:pepe", username: d.c.actor }, "house-rotate", null,
          { key: d.c.key, from: r.from, to: r.to, mode: r.mode, title: r.title, slug: r.slug, archive: r.archive, restore_of: r.restore_of }, "Pepe account rotation");
      } catch (e) { /* no audit table */ }
    }
    return r;
  });
  if (!result) {
    const H = await dbHouse();
    const row = await regRow(H.id);
    return { ok: true, action: "apply", key: d.c.key, already: true, house_room: row ? { id: row.room_id, slug: row.slug, title: row.title } : { id: H.id } };
  }
  await afterCommit(d, result, opts);
  console.log(`[houserotate] ${result.key}: ${result.from} -> ${result.to} (${result.mode}) moved ${JSON.stringify(result.moved)}`);
  const row = await regRow(result.to);
  return { ok: true, action: "apply", key: result.key, id: result.id, result, house_room: row ? { id: row.room_id, slug: row.slug, title: row.title } : null };
}

/** The journal, newest first (no before-images), + the house room as the database says. */
async function status() {
  await rooms.init();
  let rows = [];
  try { rows = await getQuery("SELECT id, key, from_id, to_id, at, actor, result, restored_by FROM house_rotations ORDER BY id DESC LIMIT 20"); } catch (e) { rows = []; }
  const H = await dbHouse();
  const row = await regRow(H.id);
  return { ok: true, action: "status", house_room: { id: H.id, slug: row ? row.slug : null, title: row ? row.title : null, since: H.rec ? H.rec.since : null,
                                                     prev: H.rec ? H.rec.prev : [] },
           logins: PL.parseRecord(await kvRaw("rooms_kv", PL.KV_KEY)),
           rotations: rows.map((r) => { const x = parse(r.result, {}) || {}; return { id: r.id, key: r.key, from: r.from_id, to: r.to_id, at: r.at, actor: r.actor,
             mode: x.mode || null, title: x.title || null, slug: x.slug || null, archive: x.archive || null, restore_of: x.restore_of || null, restored_by: r.restored_by || null }; }) };
}

async function handle(body, opts = {}) {
  const action = String((body && body.action) || "plan");
  if (action === "plan") return plan(body, opts);
  if (action === "apply") return apply(body, opts);
  if (action === "status") return status();
  throw new Refuse(400, "bad_request", 'action is "plan", "apply" or "status".');
}

/** POST /api/pepe/identity/rotate (bot token): Pepe's !identity rotate. JSON up to 8 kB. */
function register(app, { isBotToken }) {
  app.post("/api/pepe/identity/rotate", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body && typeof req.body === "object" ? req.body : null;
    if (!b || !isBotToken(b.password)) return res.status(403).json({ ok: false, code: "unauthorized", error: "unauthorized" });
    let key = null;
    try { key = require("./botkeys").current(); } catch (e) { key = null; }
    if (key && !PEPE_CALLERS.has(key.caller)) {
      console.warn(`[houserotate] refused: bot key caller ${key.caller} isn't Pepe's`);
      return res.status(403).json({ ok: false, code: "caller", error: "Only Pepe's own key can rotate the house pad." });
    }
    if (!key && b.action === "apply") console.warn("[houserotate] apply on the shared bot token (no per-caller key) - botkeys counts it");
    if (Number(req.get("content-length") || 0) > 8192 || JSON.stringify(b).length > 8192) return res.status(413).json({ ok: false, code: "too_large", error: "At most 8 kB." });
    try {
      const { password, ...rest } = b;
      res.json(await handle(rest));
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 409).json({ ok: false, code: e.code, error: e.message, ...(e.extra || {}) });
      console.error("[houserotate]", e);
      res.status(500).json({ ok: false, code: "internal", error: "Something went wrong - nothing was changed." });
    }
  });
}

module.exports = { register, handle, plan, apply, status, cleanChange, survey, relink, KEEP, PEPE_CALLERS, Refuse };
