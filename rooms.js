// rooms.js — the room registry: who OWNS each Camfrog room on PATV, its page settings, its stage
// settings, which room the homepage features, and a light activity tally (1.99bi).
//
//   rooms_registry   room_id (Camfrog room id, e.g. "PepeFrog.Room") PK, slug, title, description,
//                    banner, owner_kind ('house' = Pepe / the site | 'user' | 'none'), owner_user_id,
//                    slot_count (user stage slots, default 1), approval (scheduled bookings need the
//                    owner's OK), slot_price (PAT / live minute for a NON-featured slot, default 0 =
//                    free), platform ('camfrog' | 'site' | 'twitch' | 'discord': where the pad comes
//                    from, 1.99x; derived from the id for older rows), created, updated
//   rooms_kv         small settings: front_room ("auto" | room id), seeded:<room id>, lounge_camfrog_v1,
//                    front_auto (the automatic pick + when it was made, JSON), front_cfg (its tunables, JSON)
//   room_events      owner/admin actions per room (audit trail shown on the manage page)
//   room_activity    room_id, day (UTC yyyy-mm-dd), minutes bridged live, peak people, chat lines -
//                    what the room-owner royalty thresholds read (royalties.js)
//
// Rooms come from two places: the seeds below, and any room Pepe bridges (registered with no owner
// the first time it's seen). A registered room keeps its page (/rooms/<slug>) and its stage even when
// Pepe isn't bridging it right now.
//
// Owner powers (canManage): site Admins/Staff everywhere; a room's owner in their own room. House
// rooms (Pepe's) are managed by site staff only. The homepage's featured room ("front room") is a
// site-admin setting here and has NOTHING to do with Pepe's `!activeroom` (his Camfrog window/mic).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const STAGING = !!process.env.STAGING;
const HOUSE_ROOM = process.env.STAGE_DEFAULT_ROOM || (STAGING ? "PepeBeta.Room" : "PepeFrog.Room");
// owner "match" = one PATV account whose username / display name / Camfrog / Discord / Twitch name is
// exactly this (case-insensitive); the seed is retried every start until it resolves or an admin sets it
const SEEDS = [
  { room_id: "PepeFrog.Room", title: "Pepe's Pad", owner: "house" },
  { room_id: "PepeBeta.Room", title: "PepeLab", owner: "house" },
  { room_id: "plant_based_chatting", title: "Houseplants", owner: { match: "foamy1111" } },   // 1.99bn: his Camfrog LOGIN (account pb), not the display name "plantbaked"
  // 1.99ci: the site's own general pad (no Camfrog room behind it). Ids starting "patv:" are site pads.
  // 1.99x: "Camfrog Lounge" (was "PATV Lounge", slug patv-lounge) - the id stays patv:lounge so its posts,
  // settings and follows stay put. It's a SITE pad (the site made it) despite the name.
  { room_id: "patv:lounge", title: "Camfrog Lounge", slug: "camfrog-lounge", owner: "house",
    description: "The general Camfrog pad: hang out, share anything, talk about any room or none." },
];
const LOUNGE_ID = "patv:lounge";
// 1.99x: the Lounge's earlier seeded title / slug / descriptions - swapped at start (once, rooms_kv
// lounge_camfrog_v1) only while a field still holds one of these, so an admin's edit is never overwritten
const OLD_LOUNGE_TITLE = "PATV Lounge";
const OLD_LOUNGE_SLUG = "patv-lounge";
const OLD_SEED_DESC = [
  "The general PATV community: anything that isn't about one room. Old main-feed posts live here.",     // 1.99ci
  "The general PATV pad: anything that isn't about one Camfrog room. Old main-feed posts live here.",   // 1.99ck
];

// ── platforms (1.99x): where a pad comes from. Camfrog pads are backed by a Camfrog room; site pads were
// made by the site itself (patv:<x>). Twitch / Discord pads are valid values, not used yet. ──
const PLATFORMS = ["camfrog", "site", "twitch", "discord"];
/** The platform an id implies (rows without one yet): patv: -> site, twitch: / discord: -> those, else camfrog. */
function platformFromId(roomId) {
  const m = /^(patv|twitch|discord):/i.exec(String(roomId || ""));
  if (!m) return "camfrog";
  return m[1].toLowerCase() === "patv" ? "site" : m[1].toLowerCase();
}
const cleanPlatform = (p, roomId) => (PLATFORMS.includes(String(p || "").toLowerCase()) ? String(p).toLowerCase() : platformFromId(roomId));
/** A pad's platform: the registry's when it's registered, else what its id implies. */
function platformOf(roomId) {
  const r = CACHE.byId.get(String(roomId || ""));
  return cleanPlatform(r && r.platform, roomId);
}
/** A pad with no Camfrog room behind it (any platform but camfrog). Kept for the 1.99ci callers. */
const isCommunityOnly = (roomId) => platformOf(roomId) !== "camfrog";
const MAX_SLOTS_DEFAULT = 4;     // owners can set 1..this many user slots (stage_config.max_slots_per_room)

const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const str = (v, n) => String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, n);
const slugify = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "room";
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~\-]{0,127}$/;
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS rooms_registry (
        room_id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, description TEXT, banner TEXT,
        owner_kind TEXT NOT NULL DEFAULT 'none', owner_user_id TEXT,
        slot_count INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0, slot_price INTEGER NOT NULL DEFAULT 0,
        created INTEGER, updated INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS rooms_registry_slug ON rooms_registry (slug)");
      // 1.99x: the platform column, derived once for rows that predate it (patv: -> site, else camfrog)
      const cols = new Set((await getQuery("PRAGMA table_info(rooms_registry)")).map((c) => c.name));
      if (!cols.has("platform")) await runQuery("ALTER TABLE rooms_registry ADD COLUMN platform TEXT");
      await runQuery(`UPDATE rooms_registry SET platform = CASE WHEN room_id LIKE 'patv:%' THEN 'site' WHEN room_id LIKE 'twitch:%' THEN 'twitch'
                      WHEN room_id LIKE 'discord:%' THEN 'discord' ELSE 'camfrog' END WHERE platform IS NULL OR platform = ''`);
      await runQuery("CREATE INDEX IF NOT EXISTS rooms_registry_owner ON rooms_registry (owner_user_id)");
      await runQuery("CREATE TABLE IF NOT EXISTS rooms_kv (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery("CREATE TABLE IF NOT EXISTS room_events (room_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT)");
      await runQuery("CREATE INDEX IF NOT EXISTS room_events_room ON room_events (room_id, ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS room_activity (
        room_id TEXT NOT NULL, day TEXT NOT NULL, minutes INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0,
        lines INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (room_id, day))`);
      await seed();
      await migrateLounge();
      await loadCache();
      await loadAuto();
    })().catch((e) => { console.error("[rooms] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// the users table differs between the live DB and minimal test DBs: only reference columns it has
let UCOLS = null;
async function userCols() {
  if (!UCOLS) UCOLS = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  return UCOLS;
}
const ucol = (cols, c, alias = "") => (cols.has(c) ? `${alias}${c}` : "NULL");

// ── cache: the registry is small and read on every page; reloaded after each write ──
let CACHE = { byId: new Map(), bySlug: new Map(), front: "auto", at: 0 };
async function loadCache() {
  const C = await userCols();
  const rows = await getQuery(`SELECT r.*, u.username AS owner_username, ${ucol(C, "displayname", "u.")} AS owner_display,
                               ${ucol(C, "camfrogUsername", "u.")} AS owner_camfrog
                               FROM rooms_registry r LEFT JOIN users u ON u.userId = r.owner_user_id`);
  const byId = new Map(), bySlug = new Map();
  for (const r of rows) { byId.set(r.room_id, r); bySlug.set(r.slug, r); bySlug.set(slugify(r.room_id), r); }
  const f = (await getQuery("SELECT value FROM rooms_kv WHERE key = 'front_room'"))[0];
  CACHE = { byId, bySlug, front: f ? String(f.value) : "auto", at: Date.now() };
  return CACHE;
}

async function kvSet(key, value) {
  await runQuery("INSERT INTO rooms_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
}
async function kvGet(key) {
  const r = (await getQuery("SELECT value FROM rooms_kv WHERE key = ?", [key]))[0];
  return r ? r.value : null;
}

async function event(roomId, what, actor, detail) {
  try {
    await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, ?, ?, ?)",
                   [roomId, Date.now(), what, actor || null, detail ? String(detail).slice(0, 300) : null]);
  } catch (e) { console.error("[rooms] event:", e.message); }
}

/** Find exactly one account by any of its names. Returns the row or null (none / ambiguous). */
async function findUser(name) {
  const n = String(name || "").trim().replace(/^@/, "").toLowerCase();
  if (!n) return null;
  const C = await userCols();
  const names = ["username", "displayname", "camfrogUsername", "discordUsername", "twitchDisplayname"].filter((c) => C.has(c));
  const rows = await getQuery(`SELECT userId, username, ${ucol(C, "displayname")} AS displayname, ${ucol(C, "camfrogUsername")} AS camfrogUsername
    FROM users WHERE ${names.map((c) => `LOWER(COALESCE(${c},'')) = ?`).join(" OR ")}`, names.map(() => n));
  const isAuto = (r) => /^CF[a-z0-9]{8}$/.test(String(r.username));
  // 1.99bn: an automatic account whose Camfrog "login" is really ANOTHER account's display / Discord /
  // Twitch name is never picked (Pepe once made foamy1111's display name "plantbaked" into a login of
  // its own). It's dropped before anything else is weighed.
  const other = ["displayname", "discordUsername", "twitchDisplayname"].filter((c) => C.has(c));
  const kept = [];
  for (const r of rows) {
    const cf = String(r.camfrogUsername || "").toLowerCase();
    if (cf && isAuto(r) && other.length) {
      const clash = await getQuery(`SELECT 1 FROM users WHERE userId != ? AND camfrogUsername IS NOT NULL AND LOWER(camfrogUsername) != ?
                                    AND (${other.map((c) => `LOWER(COALESCE(${c},'')) = ?`).join(" OR ")}) LIMIT 1`,
                                   [r.userId, cf, ...other.map(() => cf)]);
      if (clash.length) continue;
    }
    kept.push(r);
  }
  // an exact username wins over any other name
  const exact = kept.filter((r) => String(r.username).toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  // a real account beats Pepe's automatic "CFxxxxxxxx" accounts that share the name
  const real = kept.filter((r) => !isAuto(r));
  if (real.length === 1) return real[0];
  return kept.length === 1 ? kept[0] : null;
}

async function ensureRow(roomId, title, wantSlug = null, platform = null) {
  const id = str(roomId, 128);
  if (!ROOM_ID_RE.test(id)) return null;
  const have = (await getQuery("SELECT room_id FROM rooms_registry WHERE room_id = ?", [id]))[0];
  if (have) return id;
  const base = wantSlug ? slugify(wantSlug) : slugify(id);
  let slug = base;
  for (let i = 2; (await getQuery("SELECT 1 FROM rooms_registry WHERE slug = ?", [slug])).length; i++) slug = base + "-" + i;
  const t = Date.now();
  await runQuery(`INSERT OR IGNORE INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated) VALUES (?, ?, ?, 'none', ?, ?, ?)`,
                 [id, slug, str(title, 60) || null, cleanPlatform(platform, id), t, t]);
  return id;
}

/**
 * 1.99x: "PATV Lounge" -> "Camfrog Lounge" on installs seeded before the rename. Runs once (rooms_kv
 * lounge_camfrog_v1); each field changes only while it still holds the old seeded value, so an admin's
 * title, description or slug is left alone. The id (patv:lounge) never changes. -> {title, description, slug}
 */
async function migrateLounge() {
  const out = { title: false, description: false, slug: false };
  if (await kvGet("lounge_camfrog_v1")) return out;
  const s = SEEDS.find((x) => x.room_id === LOUNGE_ID);
  const row = (await getQuery("SELECT * FROM rooms_registry WHERE room_id = ?", [LOUNGE_ID]))[0];
  if (row && s) {
    if (row.title === OLD_LOUNGE_TITLE) {
      await runQuery("UPDATE rooms_registry SET title = ? WHERE room_id = ?", [s.title, LOUNGE_ID]); out.title = true;
    }
    if (OLD_SEED_DESC.includes(row.description)) {
      await runQuery("UPDATE rooms_registry SET description = ? WHERE room_id = ?", [s.description, LOUNGE_ID]); out.description = true;
    }
    if (row.slug === OLD_LOUNGE_SLUG && !(await getQuery("SELECT 1 FROM rooms_registry WHERE slug = ?", [s.slug])).length) {
      await runQuery("UPDATE rooms_registry SET slug = ? WHERE room_id = ?", [s.slug, LOUNGE_ID]); out.slug = true;
    }
    if (out.title || out.description || out.slug) {
      await event(LOUNGE_ID, "page", "migration", "Camfrog Lounge rename: " + Object.keys(out).filter((k) => out[k]).join(", "));
      console.log("[rooms] lounge_camfrog_v1: " + JSON.stringify(out));
    }
  }
  await kvSet("lounge_camfrog_v1", JSON.stringify({ at: Date.now(), ...out }));
  return out;
}

async function seed() {
  for (const s of SEEDS) {
    if (await kvGet("seeded:" + s.room_id)) continue;
    await ensureRow(s.room_id, s.title, s.slug || null);
    const row = (await getQuery("SELECT * FROM rooms_registry WHERE room_id = ?", [s.room_id]))[0];
    if (!row) continue;
    if (!row.title) await runQuery("UPDATE rooms_registry SET title = ? WHERE room_id = ?", [s.title, s.room_id]);
    if (s.description && !row.description) await runQuery("UPDATE rooms_registry SET description = ? WHERE room_id = ?", [s.description, s.room_id]);
    // 1.99ck: the Lounge's 1.99ci seed text said "community" - swap it for the pad wording (an edited description is left alone)
    else if (s.description && OLD_SEED_DESC.includes(row.description)) await runQuery("UPDATE rooms_registry SET description = ? WHERE room_id = ?", [s.description, s.room_id]);
    if (s.owner === "house") {
      await runQuery("UPDATE rooms_registry SET owner_kind = 'house', owner_user_id = NULL, title = COALESCE(title, ?) WHERE room_id = ?", [s.title, s.room_id]);
      await kvSet("seeded:" + s.room_id, "house");
      continue;
    }
    const u = await findUser(s.owner.match);
    if (u) {
      await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ?, updated = ? WHERE room_id = ?", [u.userId, Date.now(), s.room_id]);
      await kvSet("seeded:" + s.room_id, u.userId);
      await event(s.room_id, "owner", "seed", `${s.owner.match} -> ${u.username}`);
      console.log(`[rooms] seeded ${s.room_id}: owner ${u.username} (matched "${s.owner.match}")`);
    } else {
      console.log(`[rooms] seed ${s.room_id}: no single account named "${s.owner.match}" yet - set the owner on /rooms/admin`);
    }
  }
}

// ── reads ──
function view(r) {
  if (!r) return null;
  return {
    id: r.room_id, slug: r.slug, title: r.title || r.room_id, description: r.description || "", banner: r.banner || "",
    owner_kind: r.owner_kind,
    owner: r.owner_kind === "user" && r.owner_user_id ? { userId: r.owner_user_id, username: r.owner_username || null,
      display: r.owner_display || r.owner_username || null, camfrog: r.owner_camfrog || null } : null,
    house: r.owner_kind === "house",
    platform: cleanPlatform(r.platform, r.room_id),                  // 1.99x: camfrog | site | twitch | discord
    community: cleanPlatform(r.platform, r.room_id) !== "camfrog",   // 1.99ci: no Camfrog room behind it
    slot_count: Math.max(1, Number(r.slot_count) || 1), approval: !!r.approval, slot_price: Math.max(0, Number(r.slot_price) || 0),
  };
}
// the cache also refreshes itself once a minute (a row changed outside this process, e.g. a cleanup)
let refreshing = null;
function maybeRefresh() {
  if (Date.now() - CACHE.at > 60 * 1000 && !refreshing) {
    refreshing = loadCache().catch((e) => console.error("[rooms] refresh:", e.message)).finally(() => { refreshing = null; });
  }
}
async function get(roomId) { await init(); maybeRefresh(); return view(CACHE.byId.get(String(roomId || ""))); }
async function bySlug(slug) { await init(); return view(CACHE.bySlug.get(String(slug || "").toLowerCase())); }
async function list() { await init(); maybeRefresh(); return [...CACHE.byId.values()].map(view).sort((a, b) => a.title.localeCompare(b.title)); }
function getCached(roomId) { return view(CACHE.byId.get(String(roomId || ""))); }
/** 1.99ck: a pad by slug from the cache, synchronously (pads.js autolinks p/<slug> while rendering). */
function bySlugCached(slug) { return view(CACHE.bySlug.get(String(slug || "").toLowerCase())); }
function listCached() { return [...CACHE.byId.values()].map(view); }

/** Stage settings for a room (defaults when it isn't registered - mainstage.js reads this). */
async function stageSettings(roomId) {
  const r = await get(roomId);
  return r || { id: roomId, slot_count: 1, approval: false, slot_price: 0, owner_kind: "none", owner: null, house: false, title: roomId };
}

/** Bridge saw this room: make sure it has a registry row (no owner). Cheap after the first time. */
async function noteBridged(roomId, name) {
  if (CACHE.byId.has(roomId)) return;
  await init();
  if (CACHE.byId.has(roomId)) return;
  if (await ensureRow(roomId, name)) await loadCache();
}

// ── permissions ──
async function canManage(user, roomId) {
  if (!user || !user.userId) return false;
  if (isStaff(user)) return true;
  const r = await get(roomId);
  return !!(r && r.owner && r.owner.userId === user.userId);
}
async function ownedBy(userId) {
  await init();
  return listCached().filter((r) => r.owner && r.owner.userId === userId);
}

// ── writes ──
function cleanBanner(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.length > 300 || /[\s"'<>\\`]/.test(s)) return null;
  if (/^https:\/\/[A-Za-z0-9.-]+\/[^\s]*$/.test(s)) return s;
  if (/^\/(public|uploads)\/[A-Za-z0-9/_.\-]+$/.test(s) && !s.includes("..")) return s;
  return null;
}
/** Owner page settings: title, description, banner. */
async function setPage(roomId, patch, actor) {
  await init();
  const r = await get(roomId);
  if (!r) throw Object.assign(new Error("No such room."), { status: 404 });
  const title = patch.title != null ? str(patch.title, 60) : r.title;
  const description = patch.description != null ? String(patch.description).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, 500) : r.description;
  let banner = r.banner;
  if (patch.banner != null) {
    banner = cleanBanner(patch.banner);
    if (banner === null) throw Object.assign(new Error("The banner must be an https:// image link."), { status: 400 });
  }
  await runQuery("UPDATE rooms_registry SET title = ?, description = ?, banner = ?, updated = ? WHERE room_id = ?",
                 [title || null, description || null, banner || null, Date.now(), roomId]);
  await event(roomId, "page", actor, `title=${title}`);
  await loadCache();
  return get(roomId);
}
/** Owner stage settings: slot_count (1..cap), approval, slot_price (0..featured price). */
async function setStage(roomId, patch, actor, caps = {}) {
  await init();
  const r = await get(roomId);
  if (!r) throw Object.assign(new Error("No such room."), { status: 404 });
  const maxSlots = Math.max(1, Number(caps.maxSlots) || MAX_SLOTS_DEFAULT);
  const maxPrice = Math.max(0, Number(caps.maxPrice) || 0);
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const slots = patch.slot_count != null ? int(patch.slot_count, 1, maxSlots, r.slot_count) : r.slot_count;
  const approval = patch.approval != null ? (patch.approval === true || patch.approval === "1" || patch.approval === 1 || patch.approval === "on" || patch.approval === "true") : r.approval;
  const price = patch.slot_price != null ? int(patch.slot_price, 0, maxPrice, r.slot_price) : r.slot_price;
  await runQuery("UPDATE rooms_registry SET slot_count = ?, approval = ?, slot_price = ?, updated = ? WHERE room_id = ?",
                 [slots, approval ? 1 : 0, price, Date.now(), roomId]);
  await event(roomId, "stage", actor, `slots=${slots} approval=${approval ? 1 : 0} price=${price}`);
  await loadCache();
  return get(roomId);
}
/** Admin: set (or clear) a room's owner. who = username/Camfrog name, "house" or "" (none). */
async function setOwner(roomId, who, actor) {
  await init();
  let id = await ensureRow(roomId, null);
  if (!id) throw Object.assign(new Error("Bad room id."), { status: 400 });
  const w = String(who || "").trim();
  if (!w || w.toLowerCase() === "none") {
    await runQuery("UPDATE rooms_registry SET owner_kind = 'none', owner_user_id = NULL, updated = ? WHERE room_id = ?", [Date.now(), id]);
  } else if (w.toLowerCase() === "house" || w.toLowerCase() === "pepe") {
    await runQuery("UPDATE rooms_registry SET owner_kind = 'house', owner_user_id = NULL, updated = ? WHERE room_id = ?", [Date.now(), id]);
  } else {
    const u = await findUser(w);
    if (!u) throw Object.assign(new Error(`No single PATV account named "${w}".`), { status: 404 });
    await runQuery("UPDATE rooms_registry SET owner_kind = 'user', owner_user_id = ?, updated = ? WHERE room_id = ?", [u.userId, Date.now(), id]);
  }
  await kvSet("seeded:" + id, "admin");      // an admin decision is never overwritten by a seed
  await event(id, "owner", actor, w || "none");
  await loadCache();
  return get(id);
}
async function addRoom(roomId, title, actor) {
  await init();
  const id = await ensureRow(roomId, title);
  if (!id) throw Object.assign(new Error("A room id is letters, digits and . _ : ~ -"), { status: 400 });
  await event(id, "added", actor, title || "");
  await loadCache();
  return get(id);
}

// ── the homepage's featured room (NOT Pepe's !activeroom) ──
async function setFront(value, actor) {
  await init();
  const v = String(value || "auto").trim();
  if (v !== "auto" && !CACHE.byId.has(v)) throw Object.assign(new Error("Unknown room."), { status: 400 });
  await kvSet("front_room", v);
  await event(v === "auto" ? null : v, "front", actor, v);
  await loadCache();
  return v;
}
// 1.99cj: "auto" = a FAIR activity ranking with hysteresis (frontroom.js has the formula and the
// rules). No room is preferred - not the house room, not the room Pepe's Camfrog window shows
// (`!activeroom` is his mic/window business and plays no part here). The current pick and when it
// was made live in rooms_kv "front_auto" (so a restart doesn't flip it); the tunables in "front_cfg".
const FR = require("./frontroom");
let clockFn = () => Date.now();
const nowMs = () => clockFn();
let AUTO = null;          // {id, at, score, parts, reason, lead, evalAt, ranked} - loaded from rooms_kv
let CFG = null;
let evaluating = null;
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } };
async function loadAuto() {
  AUTO = parseJson(await kvGet("front_auto"));
  CFG = FR.cleanCfg(parseJson(await kvGet("front_cfg")) || {});
}
async function frontCfg() { await init(); if (!CFG) await loadAuto(); return CFG; }
async function setFrontCfg(patch, actor) {
  await init();
  if (!CFG) await loadAuto();
  CFG = FR.cleanCfg(patch, CFG);
  await kvSet("front_cfg", JSON.stringify(CFG));
  await event(null, "front-cfg", actor, JSON.stringify(CFG));
  return CFG;
}

/** Activity per row: the row's own `act` (tests / callers that already have it), else the bridge's
 *  rolling tally (roomactivity.js) for the configured window + the row's human headcount. */
function withAct(rows, cfg, now) {
  let RA = null;
  try { RA = require("./roomactivity"); } catch (e) { RA = null; }
  return (rows || []).map((r) => {
    if (r.act) return r;
    const a = RA ? RA.stats(r.id, { windowMin: cfg.window_min, now }) : { chatters: 0, lines: 0, micMin: 0, lastAt: null };
    return { ...r, act: { ...a, people: r.people != null ? r.people : Math.max(0, (Number(r.count) || 0) - 1) } };
  });
}

/** Run one evaluation of the automatic pick (at most once per eval_sec unless forced). */
async function evaluateAuto(summary, { force = false, actor = "auto", now = nowMs() } = {}) {
  await init();
  if (!CFG) await loadAuto();
  if (!force && AUTO && AUTO.id && AUTO.evalAt && now - AUTO.evalAt < CFG.eval_sec * 1000) return AUTO;
  if (evaluating) return evaluating;
  evaluating = (async () => {
    const ranked = FR.rank(withAct(summary, CFG, now), CFG, now);
    const { state, switched } = FR.decide(AUTO, ranked, CFG, now, { force });
    state.ranked = ranked.slice(0, 8).map((r) => ({ id: r.id, score: r.score, parts: r.parts, dead: r.dead, lastAt: r.lastAt }));
    if (state.id) {
      AUTO = state;
      await kvSet("front_auto", JSON.stringify(AUTO));
    }
    if (switched) {
      const sc = (id) => { const r = ranked.find((x) => x.id === id); return r ? r.score : "-"; };
      const detail = `${switched.from || "(none)"} -> ${switched.to}: ${switched.reason} [score ${sc(switched.to)} vs ${sc(switched.from)}]`;
      console.log("[rooms] front room (auto) " + detail);
      await event(switched.to, "front-auto", actor, detail);
    }
    return AUTO;
  })().finally(() => { evaluating = null; });
  return evaluating;
}

/** The room the homepage features: an admin's pinned pick, else the automatic pick (above), else -
 *  only when nothing has ever been live - the house room. `summary` = bridge.summary() rows.
 *  (The old second argument - Pepe's window room - is ignored on purpose.) */
async function frontRoom(summary, opts = {}) {
  await init();
  const o = opts && typeof opts === "object" && !("id" in opts) ? opts : {};
  const pin = CACHE.front;
  let auto = null;
  try { auto = await evaluateAuto(summary, { now: o.now != null ? o.now : nowMs() }); } catch (e) { console.error("[rooms] front auto:", e.message); auto = AUTO; }
  if (pin && pin !== "auto" && CACHE.byId.has(pin)) return { id: pin, pinned: true };
  if (auto && auto.id) return { id: auto.id, pinned: false };
  return { id: HOUSE_ROOM, pinned: false };
}
/** Admin: pick the top room now (hold ignored), logged with who asked. */
async function frontReevaluate(summary, actor) {
  return evaluateAuto(summary, { force: true, actor: actor || "admin", now: nowMs() });
}
/** Admin display: the setting, the automatic pick with its score breakdown, the ranking, the tunables. */
async function frontStatus() {
  await init();
  if (!CFG) await loadAuto();
  const title = (id) => { const r = CACHE.byId.get(id); return (r && r.title) || id; };
  const A = AUTO ? { ...AUTO, title: title(AUTO.id), ranked: (AUTO.ranked || []).map((r) => ({ ...r, title: title(r.id) })),
                     lead: AUTO.lead ? { ...AUTO.lead, title: title(AUTO.lead.id) } : null } : null;
  return { setting: CACHE.front || "auto", auto: A, cfg: CFG, holdUntil: A && A.at ? A.at + CFG.hold_min * 60 * 1000 : null };
}
const frontSetting = () => CACHE.front || "auto";

// ── activity (for royalty thresholds): fed by bridge.js ingest ──
const lastMin = new Map();      // room id -> the minute bucket last counted (memory)
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
async function noteActivity(roomId, count, lines, t = Date.now()) {
  try {
    await init();
    const minute = Math.floor(t / 60000);
    const addMin = lastMin.get(roomId) === minute ? 0 : 1;
    lastMin.set(roomId, minute);
    if (!addMin && !lines && !count) return;
    await runQuery(`INSERT INTO room_activity (room_id, day, minutes, peak, lines) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(room_id, day) DO UPDATE SET minutes = minutes + excluded.minutes,
                    peak = MAX(peak, excluded.peak), lines = lines + excluded.lines`,
                   [roomId, dayOf(t), addMin, Math.max(0, Math.floor(Number(count) || 0)), Math.max(0, Math.floor(Number(lines) || 0))]);
  } catch (e) { console.error("[rooms] activity:", e.message); }
}
async function activity(roomId, fromMs, toMs) {
  await init();
  return getQuery("SELECT day, minutes, peak, lines FROM room_activity WHERE room_id = ? AND day >= ? AND day < ? ORDER BY day",
                  [roomId, dayOf(fromMs), dayOf(toMs)]);
}

// ── for Pepe: the owner of every room, so chat commands can respect them ──
async function ownersForPepe() {
  await init();
  return listCached().map((r) => ({ id: r.id, slug: r.slug, title: r.title, owner_kind: r.owner_kind,
    owner: r.owner ? { username: r.owner.username, camfrog: r.owner.camfrog ? String(r.owner.camfrog).toLowerCase() : null } : null,
    slot_count: r.slot_count }));
}

/** Notice to a user: the inbox always, and a Camfrog PM through Pepe when they allow it. */
async function notify(userId, { kind = "stage", title, body, link, ref, pm = true }) {
  try {
    if (!userId) return false;
    const inbox = require("./inbox");
    const stored = await inbox.addSafe(userId, { kind, title, body, link, ref });
    if (!stored || !pm) return stored;
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [userId]))[0];
    if (u && u.camfrogUsername && await inbox.pmAllowed(userId, kind)) {
      const site = process.env.SITE_URL || (STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
      await require("./actions").queue(userId, { kind: "notify", args: [u.camfrogUsername, `${title}${link ? " " + site + link : ""}`.slice(0, 300), kind],
                                                 tag: "stage-notify", label: title }).catch(() => {});
    }
    return stored;
  } catch (e) { console.error("[rooms] notify:", e.message); return false; }
}

// Is a route registered? (the room analytics page is built by another module; link it when present)
function hasRoute(app, path) {
  try {
    const stack = (app._router && app._router.stack) || (app.router && app.router.stack) || [];
    return stack.some((l) => l.route && l.route.path === path);
  } catch (e) { return false; }
}

module.exports = {
  init, get, bySlug, bySlugCached, list, getCached, listCached, stageSettings, noteBridged, canManage, ownedBy, setPage, setStage,
  setOwner, addRoom, setFront, frontRoom, frontSetting, frontStatus, frontReevaluate, frontCfg, setFrontCfg, evaluateAuto,
  _setClock: (fn) => { clockFn = fn || (() => Date.now()); }, _reloadAuto: loadAuto, noteActivity, activity, ownersForPepe, notify, findUser, event,
  hasRoute, slugify, isStaff, cleanBanner, kvGet, kvSet, loadCache, HOUSE_ROOM, MAX_SLOTS_DEFAULT, SEEDS, LOUNGE_ID, isCommunityOnly,
  PLATFORMS, platformOf, platformFromId, migrateLounge, OLD_LOUNGE_SLUG,
};
