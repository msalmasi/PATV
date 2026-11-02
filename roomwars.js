// roomwars.js — ROOM WARS on the site (room-wars plan 2026-11-02, slices R4a / R4b / R8). Gangs hold Camfrog rooms (pads):
// Pepe runs the game (camfrog-bot pepe_roomwars.py - claims, bonds, raids, upkeep, convoys) and pushes the generated map and
// who holds what here after every change (pepe_roomwarsfeed.py). READ-ONLY: nothing in this file moves a PAT. The bonds
// themselves live in Pepe's turf_data.json; this is the second, dated copy (R11 moves control to the site in v2).
//
//   POST /api/g/roomwars/state   (bot token) {revision, day, built_at, on, map: {rooms: {rid: row}}, room_control: {rid: ctl},
//                                 convoys, raid, hit, perks, perks_live, rules}  -> {ok, revision, same?}
//                                 idempotent by revision: the same one again = "same" (no write; the day's history row is
//                                 added if that day has none yet), an older one = 409 {code: "E_STALE", revision}, a newer one
//                                 replaces the latest copy and the day's history row (one transaction). 503 while the
//                                 site's feed switch is off. Everything is whitelisted (clean()): gang ids, bonds, perks,
//                                 tiers, timers and counts - no member, crew, defender or recipient ever gets stored.
//   GET  /api/gtf/roomwars        the public view: rooms (pad link, tier, I30, bond, upkeep), the holder by gang (tag, name,
//                                 colour), its bond / perks / timers, live raid / convoys (counts only)
//   GET  /api/gtf/roomwars/history?days=N   one row per day: who held which room, with what bond
//   GET  /gtf/roomwars            the live map page (views/roomwars.ejs; public/js/roomwars-map.js draws the map from the JSON);
//                                 /gtf/turf -> 301 here (pepe.publicaccess.tv/turf redirects here too - poll-site/netlify.toml)
//   GET  /gtf/london              "Turf Wars: London" - the archive of the borough game, from the saved season records
//                                 (data/turf-london.json: seasons 2 and 4, the only two with a record; R8)
//   GET/POST /api/admin/roomwars-cfg   (games.config, same-site fetch) the site's switches - the card is /admin/games#roomwars
//
// tables: roomwars_state (id = 1: revision, data, day, built_at, updated = when this revision came, seen = Pepe's latest
//         push, a resend included - the pages' "may be out of date")   roomwars_history (day PK: revision, data, updated)
//         roomwars_meta (key/value: cfg)
//
// SITE SETTINGS (roomwars_meta.cfg; plan section 4 defaults until the owner answers - changeable without a deploy):
//   feed_on        true   decision 18: the site keeps a read-only copy of room control now (off: pushes answered 503)
//   disband_guard  true   R1 / decision 7: a gang that holds a room can't disband (release first); R5 (Pepe's
//                         disband_release switch): his disband op lists the rooms he releases (`room_release`) - not refused
//   show_slice     true   decision 11: the pad page shows the gang slice of the last payout (it comes out of room games)
//   show_dormant   false  decision 5: only rooms that are contestable or held are drawn
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");

const DEFAULTS = Object.freeze({ feed_on: true, disband_guard: true, show_slice: true, show_dormant: false });
const TIERS = ["center", "mid", "outer"];
const RID_RE = /^[^\s\u0000-\u001f<>"'&\\]{1,80}$/;
const GID_RE = /^[A-Za-z0-9]{2,32}$/;
const PERK_RE = /^[a-z][a-z0-9_]{1,19}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// the numbers "how it works" quotes - Pepe's rw_cfg as he pushes it (pepe_roomwars RW_DEFAULTS until he has)
const RULES = Object.freeze({ release_h: 72, lock_h: 72, raid_buyin: 20000, hijack_buyin: 5000, convoy_min: 25000, convoy_s: 600, slash: 0.25,
                              hijack_take: 0.2, min_crew: 2, raid_lobby_s: 45, payout_convoy_min: 25000, convoy_hour: 5 });
const STALE_MS = 3 * 3600e3;            // Pepe resends every 30 min; 3 h without word = the page says it may be out of date
const GUARD_FRESH_MS = 40 * 60e3;       // the disband guard trusts a copy Pepe confirmed within his 30-min resend (+ slack)
const HISTORY_MAX = 800;
let clock = () => Date.now();
const now = () => clock();

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS roomwars_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
        data TEXT NOT NULL, day TEXT, built_at INTEGER, updated INTEGER NOT NULL, seen INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS roomwars_history (day TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL,
        updated INTEGER NOT NULL)`);
      await runQuery("CREATE TABLE IF NOT EXISTS roomwars_meta (key TEXT PRIMARY KEY, value TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── cleaning (Pepe's payload -> the only shape stored) ──
const int = (v, lo = 0, hi = Number.MAX_SAFE_INTEGER) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
};
const str = (v, n) => (v == null ? "" : String(v).replace(/[\u0000-\u001f<>]/g, " ").trim().slice(0, n));
const ts = (v) => int(v, 0, 4102444800);                  // unix seconds, at most 2100-01-01
const gid = (v) => (GID_RE.test(String(v || "")) ? String(v) : null);

function cleanRoom(r) {
  if (!r || typeof r !== "object") return null;
  const xy = Array.isArray(r.xy) && r.xy.length === 2 ? [int(r.xy[0], 0, 680), int(r.xy[1], 0, 680)] : null;
  return { name: str(r.name, 60), tier: TIERS.includes(r.tier) ? r.tier : "outer", i30: int(r.i30), i7: int(r.i7),
           eligible: r.eligible === true, dormant: r.dormant === true, bond: int(r.bond), upkeep: int(r.upkeep),
           perk_slots: int(r.perk_slots, 0, 6), xy };
}
function cleanCtl(c) {
  if (!c || typeof c !== "object" || !gid(c.gang)) return null;
  const perks = [...new Set((Array.isArray(c.perks) ? c.perks : []).map(String).filter((p) => PERK_RE.test(p)))].slice(0, 6);
  return { gang: gid(c.gang), bond: int(c.bond), bond_req: int(c.bond_req), since: ts(c.since), perks,
           lock_until: ts(c.lock_until), war_until: ts(c.war_until), upkeep_unpaid: int(c.upkeep_unpaid, 0, 999),
           neglected: c.neglected === true, exposed_at: ts(c.exposed_at), release_at: ts(c.release_at), wars: int(c.wars, 0, 1e6),
           upkeep_day: DAY_RE.test(String(c.upkeep_day || "")) ? String(c.upkeep_day) : null };
}
/** Pepe's push -> {revision, day, built_at, on, map: {rooms}, room_control, convoys, raid, hit, perks, perks_live}; throws Refuse. */
function clean(b) {
  const revision = Number(b && b.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Refuse(400, "revision required", "E_REV");
  const srcRooms = b.map && typeof b.map === "object" && b.map.rooms && typeof b.map.rooms === "object" ? b.map.rooms : {};
  const srcCtl = b.room_control && typeof b.room_control === "object" ? b.room_control : {};
  const rooms = {}, room_control = {};
  for (const [rid, r] of Object.entries(srcRooms).slice(0, 200)) {
    const x = RID_RE.test(rid) ? cleanRoom(r) : null;
    if (x) rooms[rid] = x;
  }
  for (const [rid, c] of Object.entries(srcCtl).slice(0, 200)) {
    const x = RID_RE.test(rid) ? cleanCtl(c) : null;
    if (x) room_control[rid] = x;
  }
  const convoys = (Array.isArray(b.convoys) ? b.convoys : []).slice(0, 20).map((c) => (c && RID_RE.test(String(c.rid || ""))
    ? { rid: String(c.rid), gang: gid(c.gang), kind: c.kind === "payout" ? "payout" : "gang", amount: int(c.amount), until: ts(c.until),
        taken: c.taken === true, defenders: int(c.defenders, 0, 999) } : null)).filter(Boolean);
  const r = b.raid && typeof b.raid === "object" && RID_RE.test(String(b.raid.rid || ""))
    ? { rid: String(b.raid.rid), attacker: gid(b.raid.attacker), defender: gid(b.raid.defender), phase: b.raid.phase === "running" ? "running" : "lobby",
        crew: int(b.raid.crew, 0, 999), defenders: int(b.raid.defenders, 0, 999) } : null;
  const h = b.hit && typeof b.hit === "object" && RID_RE.test(String(b.hit.rid || ""))
    ? { rid: String(b.hit.rid), phase: b.hit.phase === "running" ? "running" : "lobby", crew: int(b.hit.crew, 0, 999) } : null;
  const perks = {};
  for (const [k, v] of Object.entries(b.perks && typeof b.perks === "object" ? b.perks : {}).slice(0, 12)) if (PERK_RE.test(k)) perks[k] = str(v, 80);
  const live = Array.isArray(b.perks_live) ? [...new Set(b.perks_live.map(String).filter((p) => PERK_RE.test(p)))].slice(0, 12) : null;
  const rules = {};
  for (const k of Object.keys(RULES)) {
    const n = Number(b.rules && b.rules[k]);
    if (Number.isFinite(n) && n >= 0 && n <= 1e9) rules[k] = n;
  }
  return { revision, day: DAY_RE.test(String(b.day || "")) ? String(b.day) : null, built_at: ts(b.built_at), on: b.on === true,
           map: { rooms }, room_control, convoys, raid: r, hit: h, perks, perks_live: live, rules };
}

// ── settings ──
let cfgCache = null, cfgAt = 0;
function cleanCfg(c) {
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (c && typeof c[k] === "boolean") out[k] = c[k];
  return out;
}
async function cfg() {
  if (cfgCache && now() - cfgAt < 15000) return cfgCache;
  await init();
  const row = (await getQuery("SELECT value FROM roomwars_meta WHERE key = 'cfg'"))[0];
  let raw = null;
  try { raw = row ? JSON.parse(row.value) : null; } catch (e) { raw = null; }
  cfgCache = cleanCfg(raw);
  cfgAt = now();
  return cfgCache;
}
async function setCfg(patch) {
  await init();
  const next = cleanCfg({ ...(await cfg()), ...(patch || {}) });
  await runQuery("INSERT INTO roomwars_meta (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  cfgCache = next;
  cfgAt = now();
  return next;
}

// ── the store ──
let latestCache = null;                 // {state, revision, updated} | {none: true}
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Store Pepe's push (see the header). -> {ok, revision, same?} | throws Refuse. */
async function put(b) {
  await init();
  if (!(await cfg()).feed_on) throw new Refuse(503, "the room-wars feed is switched off on the site", "E_OFF");
  const st = clean(b || {});
  const at = now();
  const day = st.day || utcDay(at);
  const data = JSON.stringify(st);
  const out = await tx(async () => {
    const cur = (await getQuery("SELECT revision FROM roomwars_state WHERE id = 1"))[0];
    if (cur && Number(cur.revision) > st.revision) throw new Refuse(409, "a newer revision is stored", "E_STALE", { revision: Number(cur.revision) });
    if (cur && Number(cur.revision) === st.revision) {
      // a resend: the copy stays as it is (only "seen" moves) - and the day gets its history row if it has none yet
      // (Pepe resends every 30 min, so a quiet day still gets one)
      await runQuery("UPDATE roomwars_state SET seen = ? WHERE id = 1", [at]);
      await runQuery("INSERT OR IGNORE INTO roomwars_history (day, revision, data, updated) SELECT ?, revision, data, ? FROM roomwars_state WHERE id = 1",
                     [day, at]);
      return { ok: true, revision: st.revision, same: true };
    }
    await runQuery(`INSERT INTO roomwars_state (id, revision, data, day, built_at, updated, seen) VALUES (1, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data, day = excluded.day,
                    built_at = excluded.built_at, updated = excluded.updated, seen = excluded.seen`, [st.revision, data, day, st.built_at, at, at]);
    await runQuery(`INSERT INTO roomwars_history (day, revision, data, updated) VALUES (?, ?, ?, ?)
                    ON CONFLICT(day) DO UPDATE SET revision = excluded.revision, data = excluded.data, updated = excluded.updated
                    WHERE excluded.revision >= roomwars_history.revision`, [day, st.revision, data, at]);
    return { ok: true, revision: st.revision };
  });
  latestCache = null;
  if (!out.same) {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM roomwars_history"))[0].n;
    if (n > HISTORY_MAX) await runQuery("DELETE FROM roomwars_history WHERE day IN (SELECT day FROM roomwars_history ORDER BY day ASC LIMIT ?)", [n - HISTORY_MAX]);
  }
  return out;
}

/** The latest stored copy: {state, revision, updated} or null (Pepe never pushed). */
async function latest() {
  if (latestCache) return latestCache.none ? null : latestCache;
  await init();
  const r = (await getQuery("SELECT revision, data, updated, seen FROM roomwars_state WHERE id = 1"))[0];
  let state = null;
  try { state = r ? JSON.parse(r.data) : null; } catch (e) { state = null; }
  latestCache = state ? { state, revision: Number(r.revision), updated: Number(r.updated), seen: Number(r.seen) || Number(r.updated) } : { none: true };
  return latestCache.none ? null : latestCache;
}

/**
 * gangs.js's disband guard (R1): the rooms this gang holds in the latest copy - [{id, name}]. Never creates a table and
 * never throws (it runs inside the disband's transaction: a memoized CREATE there would roll back with a refusal).
 * Only a copy Pepe is still confirming counts (RW-SITE-5): with the feed switched off (his pushes refused, the copy frozen)
 * or no push for GUARD_FRESH_MS (he backs off after a site blip), a room released in chat since would refuse the disband
 * here forever - so the guard stands aside and Pepe's own check (it runs first, the only way into a disband) decides.
 */
async function heldBy(gangId) {
  try {
    const c = await cfgNoInit();
    if (!c.disband_guard || !c.feed_on) return [];
    const r = (await getQuery("SELECT data, updated, seen FROM roomwars_state WHERE id = 1"))[0];
    if (!r) return [];
    if (now() - (Number(r.seen) || Number(r.updated) || 0) > GUARD_FRESH_MS) return [];
    const st = JSON.parse(r.data);
    return Object.entries(st.room_control || {}).filter(([, c]) => c && c.gang === String(gangId))
      .map(([rid]) => ({ id: rid, name: ((st.map && st.map.rooms && st.map.rooms[rid]) || {}).name || rid }));
  } catch (e) { return []; }
}
async function cfgNoInit() {
  if (cfgCache && now() - cfgAt < 15000) return cfgCache;
  try {
    const row = (await getQuery("SELECT value FROM roomwars_meta WHERE key = 'cfg'"))[0];
    return cleanCfg(row ? JSON.parse(row.value) : null);
  } catch (e) { return { ...DEFAULTS }; }
}

// ── views ──
/** Pepe's gang colour (frida-bot _gang_color: hsl(md5(gid) % 360, 62%, 46%)) + a readable ink for text on it. */
function gangColor(g) {
  const h = Number(BigInt("0x" + crypto.createHash("md5").update(String(g || "free")).digest("hex")) % 360n);
  const s = 0.62, l = 0.46, k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
  return { bg: `hsl(${h}, 62%, 46%)`, ink: (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? "#ffffff" : "#0b0b0b" };
}

async function gangInfo(gids) {
  try { return await require("./gangs").namesOf(gids); } catch (e) { return {}; }
}
async function padInfo(rids) {
  const out = {};
  const R = require("./rooms");
  for (const rid of rids) {
    try {
      const p = await R.get(rid);
      if (p) out[rid] = { slug: p.slug, title: p.title, listed: p.listed !== false, adult: !!p.adult };
    } catch (e) { /* a pad the site doesn't know: shown by Pepe's name, no link */ }
  }
  return out;
}
async function slicesOf(rids) {
  const out = {};
  if (!rids.length) return out;
  try {
    const rows = await getQuery(`SELECT room_id, recipe FROM room_vault_state WHERE room_id IN (${rids.map(() => "?").join(",")})`, rids);
    for (const r of rows) {
      let rc = null;
      try { rc = r.recipe ? JSON.parse(r.recipe) : null; } catch (e) { rc = null; }
      const eps = rc && Array.isArray(rc.epochs) ? rc.epochs : [];
      const last = eps.length ? eps[eps.length - 1] : null;
      if (last && DAY_RE.test(String(last.day || ""))) out[r.room_id] = { day: String(last.day), amount: int(last.gang) };
    }
  } catch (e) { /* no pad vaults here (an older or empty site): no slice line */ }
  return out;
}

function perkList(keys, st) {
  const live = Array.isArray(st.perks_live) ? new Set(st.perks_live) : null;
  return (keys || []).map((k) => ({ key: k, pepe: (st.perks || {})[k] || k, live: live ? live.has(k) : true }));
}

let viewCache = null;                   // {at, revision, v}
/**
 * The public view of the latest copy (the page, the API, the pad card, the gang section). Gangs by tag / name / colour,
 * rooms by Pepe's map name (+ the pad's address when it is a listed pad). No person anywhere.
 */
async function view() {
  const L = await latest();
  const c = await cfg();
  if (!L) return { live: false, cfg: c, rooms: [], all: [], counts: { held: 0, free: 0, dormant: 0 }, convoys: [], raid: null, hit: null, perks: [],
                   rules: { ...RULES } };
  if (viewCache && viewCache.revision === L.revision && viewCache.cfgKey === JSON.stringify(c) && now() - viewCache.at < 15000) {
    return Object.assign({}, viewCache.v, { stale: now() - L.seen > STALE_MS, seen: L.seen });
  }
  const st = L.state;
  const rids = [...new Set(Object.keys(st.map.rooms || {}).concat(Object.keys(st.room_control || {})))];
  const gids = [...new Set(Object.values(st.room_control || {}).map((x) => x.gang)
    .concat(st.raid ? [st.raid.attacker, st.raid.defender] : []).concat((st.convoys || []).map((x) => x.gang)).filter(Boolean))];
  const [gangs, pads, slices] = await Promise.all([gangInfo(gids), padInfo(rids), c.show_slice ? slicesOf(Object.keys(st.room_control || {})) : {}]);
  const t = Math.floor(now() / 1000);
  const gangOf = (g) => {
    if (!g) return null;
    const x = gangs[g] || {};
    const col = gangColor(g);
    return { gid: g, tag: x.tag || null, name: x.name || null, live: !!x.live, href: x.live && x.tag ? "/gtf/gangs/" + encodeURIComponent(x.tag) : null,
             color: col.bg, ink: col.ink };
  };
  const all = rids.map((rid) => {
    const r = (st.map.rooms || {})[rid] || { name: rid, tier: "outer", i30: 0, i7: 0, eligible: false, dormant: true, bond: 0, upkeep: 0, perk_slots: 0, xy: null };
    const ctl = (st.room_control || {})[rid] || null;
    const pad = pads[rid] || null;
    const held = ctl ? Object.assign(gangOf(ctl.gang), {
      bond: ctl.bond, bond_req: ctl.bond_req, since: ctl.since || null, perks: perkList(ctl.perks, st), wars: ctl.wars,
      locked_until: ctl.lock_until > t && !ctl.neglected ? ctl.lock_until : null,
      lockdown_until: ctl.war_until > t ? ctl.war_until : null,
      exposed: !!(ctl.exposed_at && ctl.exposed_at <= t), topup_by: ctl.exposed_at > t ? ctl.exposed_at : null,
      neglected: ctl.neglected, unpaid: ctl.upkeep_unpaid, release_at: ctl.release_at || null,
      slice: slices[rid] || null }) : null;
    const raid = st.raid && st.raid.rid === rid ? Object.assign({}, st.raid, { attacker: gangOf(st.raid.attacker), defender: gangOf(st.raid.defender) }) : null;
    const convoy = (st.convoys || []).find((x) => x.rid === rid && x.until > t) || null;
    return { id: rid, name: r.name || (pad && pad.title) || rid, tier: r.tier, i30: r.i30, i7: r.i7, bond: r.bond, upkeep: r.upkeep,
             perk_slots: r.perk_slots, eligible: r.eligible, dormant: r.dormant, xy: r.xy,
             state: held ? "held" : (r.eligible ? "free" : "dormant"),
             pad: pad && pad.listed ? { slug: pad.slug, href: "/p/" + encodeURIComponent(pad.slug), adult: pad.adult } : null,
             held, raid, convoy: convoy ? Object.assign({}, convoy, { gang: gangOf(convoy.gang) }) : null };
  });
  const order = { center: 0, mid: 1, outer: 2 };
  all.sort((a, b) => (order[a.tier] - order[b.tier]) || (b.i30 - a.i30) || a.id.localeCompare(b.id));
  const rooms = all.filter((r) => c.show_dormant || r.state !== "dormant");
  const v = {
    live: true, on: st.on, revision: L.revision, updated: L.updated, built_at: st.built_at || null, day: st.day, cfg: c,
    rooms, all, counts: { held: all.filter((r) => r.held).length, free: all.filter((r) => r.state === "free").length, dormant: all.filter((r) => r.state === "dormant").length },
    convoys: (st.convoys || []).filter((x) => x.until > t).map((x) => Object.assign({}, x, { gang: gangOf(x.gang), room: (all.find((r) => r.id === x.rid) || {}).name || x.rid })),
    raid: st.raid ? Object.assign({}, st.raid, { attacker: gangOf(st.raid.attacker), defender: gangOf(st.raid.defender), room: (all.find((r) => r.id === st.raid.rid) || {}).name || st.raid.rid }) : null,
    hit: st.hit ? Object.assign({}, st.hit, { room: (all.find((r) => r.id === st.hit.rid) || {}).name || st.hit.rid }) : null,
    perks: Object.keys(st.perks || {}).map((k) => perkList([k], st)[0]),
    rules: Object.assign({}, RULES, st.rules || {}),
  };
  viewCache = { at: now(), revision: L.revision, cfgKey: JSON.stringify(c), v };
  return Object.assign({}, v, { stale: now() - L.seen > STALE_MS, seen: L.seen });
}

/** The pad page's card: this pad's row on the map (held / free / dormant) or null when it isn't on the map. */
async function forPad(roomId) {
  const v = await view();
  if (!v.live) return null;
  const r = v.all.find((x) => x.id === String(roomId));
  if (!r) return null;
  return { room: r, on: v.on, stale: v.stale, updated: v.updated, show_slice: v.cfg.show_slice };
}
/** The gang page's section: the rooms this gang holds, plus the latest copy's freshness. */
async function forGang(gangId) {
  const v = await view();
  if (!v.live) return null;
  return { rooms: v.all.filter((r) => r.held && r.held.gid === String(gangId)), on: v.on, stale: v.stale, updated: v.updated,
           bonds: v.all.filter((r) => r.held && r.held.gid === String(gangId)).reduce((s, r) => s + (r.held.bond || 0), 0) };
}

/** One row per day: {day, revision, rooms: {rid: {gang, tag, bond}}} (newest first). */
async function history(days = 30) {
  await init();
  const n = Math.min(HISTORY_MAX, Math.max(1, int(days, 1, HISTORY_MAX)));
  const rows = await getQuery("SELECT day, revision, data FROM roomwars_history ORDER BY day DESC LIMIT ?", [n]);
  const out = [];
  const gids = new Set();
  for (const r of rows) {
    let st = null;
    try { st = JSON.parse(r.data); } catch (e) { st = null; }
    const rooms = {};
    for (const [rid, c] of Object.entries((st && st.room_control) || {})) { rooms[rid] = { gang: c.gang, bond: c.bond }; gids.add(c.gang); }
    out.push({ day: r.day, revision: Number(r.revision), rooms });
  }
  const g = await gangInfo([...gids]);
  for (const d of out) for (const x of Object.values(d.rooms)) x.tag = (g[x.gang] || {}).tag || null;
  return out;
}

// ── R8: Turf Wars: London (the archive) ──
let londonCache = null;
function londonData() {
  if (!londonCache) londonCache = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "turf-london.json"), "utf8"));
  return londonCache;
}
/** The archive view: each season with a record (newest first), its final map and standings; gangs by tag / name only. */
async function london() {
  const d = londonData();
  const ids = new Set(Object.keys(d.gangs || {}));
  for (const s of d.seasons) { for (const a of Object.values(s.final || {})) if (a.owner) ids.add(a.owner); for (const [g] of s.standings || []) ids.add(g); }
  const liveNames = await gangInfo([...ids]);
  const gang = (g) => {
    if (!g) return null;
    const rec = (d.gangs || {})[g] || {}, now_ = liveNames[g] || {};
    const col = gangColor(g);
    return { gid: g, tag: rec.tag || now_.tag || "?", name: rec.name || now_.name || "", color: col.bg, ink: col.ink,
             href: now_.live && now_.tag ? "/gtf/gangs/" + encodeURIComponent(now_.tag) : null };
  };
  const edges = [];
  const seen = new Set();
  for (const [aid, a] of Object.entries(d.areas)) for (const n of a.neighbors || []) {
    const k = [aid, n].sort().join("|");
    if (!seen.has(k) && d.areas[n]) { seen.add(k); edges.push([d.areas[aid].xy, d.areas[n].xy]); }
  }
  const seasons = d.seasons.slice().sort((a, b) => b.season - a.season).map((s) => {
    const areas = Object.entries(d.areas).map(([aid, a]) => {
      const f = (s.final || {})[aid] || {};
      return { id: aid, name: a.name, tier: a.tier, business: a.business, xy: a.xy, owner: gang(f.owner), stake: int(f.stake), bank: int(f.bank),
               cargo: int((s.cargo || {})[aid]) };
    });
    const held = {};
    for (const a of areas) if (a.owner) held[a.owner.gid] = (held[a.owner.gid] || 0) + 1;
    return { season: s.season, archived: s.archived, closed_ts: s.closed_ts, reason: s.reason, winner: gang(s.winner), pot: s.pot, match: s.match,
             stakes_back: s.stakes_back, standings: (s.standings || []).map(([g, score]) => ({ gang: gang(g), score: int(score) })),
             areas, edges, held: Object.entries(held).map(([g, n]) => ({ gang: gang(g), n })).sort((a, b) => b.n - a.n), published: s.published || null };
  });
  return { city: d.city, seasons };
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[roomwars] init:", e.message));      // tables exist before any disband transaction reads them
  const fail = (res, e, tag) => {
    if (e instanceof Refuse) return res.status(e.status).json(Object.assign({ ok: false, code: e.code, error: e.message }, e.extra || {}));
    console.error(`[roomwars] ${tag}:`, e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/g/roomwars/state", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await put(b)); } catch (e) { fail(res, e, "state"); }
  });
  app.get("/api/gtf/roomwars", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const v = await view();
      res.json({ ok: true, live: v.live, on: !!v.on, revision: v.revision || null, updated: v.updated || null, built_at: v.built_at || null,
                 stale: !!v.stale, rooms: v.rooms, counts: v.counts, convoys: v.convoys, raid: v.raid, hit: v.hit, perks: v.perks, rules: v.rules });
    } catch (e) { fail(res, e, "api"); }
  });
  app.get("/api/gtf/roomwars/history", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, days: await history(req.query.days || 30) }); } catch (e) { fail(res, e, "history"); }
  });
  app.get("/gtf/turf", (req, res) => res.redirect(301, "/gtf/roomwars"));
  app.get("/gtf/roomwars", addUser, async (req, res) => {
    try {
      res.render("roomwars", { user: req.user ? req.user.username : null, v: await view() });
    } catch (e) { console.error("[roomwars] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/gtf/london", addUser, async (req, res) => {
    try {
      res.render("turfLondon", { user: req.user ? req.user.username : null, a: await london() });
    } catch (e) { console.error("[roomwars] london:", e); res.status(500).send("Something went wrong."); }
  });

  // admins: the site's switches (card: /admin/games#roomwars)
  const admin = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return false; }
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "games.config")) { res.status(403).json({ ok: false, error: "Admins only." }); return false; }
    return true;
  };
  app.get("/api/admin/roomwars-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      const L = await latest();
      const hist = (await getQuery("SELECT COUNT(*) AS n, MIN(day) AS first FROM roomwars_history"))[0] || {};
      res.json({ ok: true, cfg: await cfg(), defaults: DEFAULTS,
                 feed: L ? { revision: L.revision, updated: L.updated, held: Object.keys(L.state.room_control || {}).length,
                             rooms: Object.keys(L.state.map.rooms || {}).length, on: !!L.state.on } : null,
                 history: { days: Number(hist.n) || 0, first: hist.first || null } });
    } catch (e) { fail(res, e, "admin"); }
  });
  app.post("/api/admin/roomwars-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const b = req.body || {};
    const patch = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== "boolean") return res.status(400).json({ ok: false, error: `${k} must be true or false` });
      patch[k] = b[k];
    }
    if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: "nothing to change" });
    try {
      const c = await setCfg(patch);
      viewCache = null;
      console.log(`[roomwars] ${req.user.username || req.user.userId}: cfg ${JSON.stringify(patch)}`);
      await require("./adminaudit").record(req.user, "roomwars-cfg", null, c).catch((e) => console.warn(`[roomwars] audit: ${e.message}`));
      res.json({ ok: true, cfg: c });
    } catch (e) { fail(res, e, "admin set"); }
  });
}

module.exports = { init, register, clean, put, latest, view, forPad, forGang, heldBy, history, london, cfg, setCfg, gangColor, Refuse, DEFAULTS, RULES,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _reset: () => { latestCache = null; viewCache = null; cfgCache = null; londonCache = null; } };
