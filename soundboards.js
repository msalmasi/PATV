// soundboards.js — 🔊 soundboards (1.99rh; soundboards design S2, the user's decisions of 2026-10-11).
//
// A soundboard clip is a short sound Pepe plays on the mic in a Camfrog room: a TTS line rendered once in a voice (VoiceBox)
// or a mic-up clip of someone in the room. The SITE owns the catalogue, ownership and the store; Pepe is the client: he
// renders / converts the audio, caches it, and plays it (chat `!sb <clip>`, or the pad's 🔊 drawer, which relays `!sb <id>`
// as the signed-in account's Camfrog name), with the cooldowns, the per-room queue and the Season Pass priority lane.
//
// BOARDS
//   global          voice lines + 🎛️ sound effects (soundboards.json), everyone may play them per use (rarity price); free with All-Access
//   pack:<id>       8 clips each; the pack's owners play them free, anyone else per use (rarity price)
//   season:<id>     12 clips, the current season only; free with a 🎟️ Season Pass (or the season board bought), else 2,500
//   legend          single-clip cosmetics, own-only (Gawk gawk gawk 20,000,000 - a random free voice every play; Founder
//                   10,000,000, numbered 1-25)
//   room:<room id>  a pad's own board: Prime Time 8 slots, Prime Time Plus 24 (premium.padPerks().soundboardSlots), clips
//                   added by the pad owner / staff here (/p/<pad>/owner#soundboard) or in chat (`!sb add`, `!sb addmic`);
//                   owner-set price 0-10,000 (default 1,000). A mic clip of someone is allowed unless THEY opted out of
//                   "soundboard" (likeness.js, D4) - re-checked at every play.
// PRICES (D5/D6, sb_config): common 1,000 / rare 2,500 / epic 5,000 per use; packs 250,000 (a voice pack 400,000), the
//   season board 600,000, All-Access (global + standard packs) 1,500,000. Season Pass: the season board unlimited + 1 free
//   standard pack per month (sp_packs).
// MONEY: per-use plays are charged by Pepe (routing rows soundboard / soundboard_room, likeness cut for a cloned voice's
//   owner or a mic clip's speaker); purchases here: one boosts.tx (debit + premium routing row soundboard_pack /
//   soundboard_legend + a likeness siteCut (15%) for the owners of cloned voices in a pack + the sb_owned row).
// AUDIO: WAV files in SB_DIR, served at /sb/audio/<id>.wav (previews). A clip without audio is status 'render': Pepe's sync
//   hands it out as a render job (tts: text + voice; audio: a source file + trim) and uploads the WAV
//   (POST /api/soundboards/bot/audio); one longer than its cap is 'failed'.
//   1.99vu: a catalogue clip may name a ready-made audio file ("file": "<id>.ogg" in data/soundboard-audio/, made and checked by
//   hand - real sound effects, or a TTS take verified with STT): its src becomes file:<name>#<sha12> and Pepe gets it as an
//   AUDIO render job (he fetches /api/soundboards/bot/src/<id>, converts it with ffmpeg and uploads the WAV like a mic clip).
//   A clip that already has audio keeps playing the old WAV until the new one is up (sb_clips.pending = 1); the replaced WAV is
//   kept in SB_DIR/.replaced/. A changed file (new sha) is sent again; the clip id never changes (ownership, plays, likeness
//   cuts and room slots all point at it). Catalogue "group": "sfx" files a global clip under 🎛️ Sound effects.
//   Live clips (the Gawk legendary) need no WAV - Pepe renders them at every play - so they are 'active' from the start
//   (1.99vu: they were seeded 'render', the render queue skips live clips, so they never became playable; healed at boot + sync).
// REPORTS: 🚩 on every clip; 3 distinct reporters hide it pending review (/admin/soundboards). The pad owner removes room
//   clips at once; the person heard in a mic clip can "Remove me" (also instant).
//
//   sb_clips    id, board, label, emoji, kind (tts|audio), voice, text, subject_login, src, trim_start, trim_end, audio, sha,
//               secs, rarity, price, status (render|active|hidden|removed|failed), note, sort, created_by, created, updated,
//               catalog, live, supply
//   sb_owned    user_id, item (pack:<id> | season:<id> | legend:<id> | all_access), source, payer_id, price, ref, period,
//               serial, routing, created
//   sb_reports  clip_id, user_id, reason, created
//   sb_plays    clip_id, room_id, login, paid, at (Pepe reports them)
//   sb_config   key/value
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const DIR = process.env.SB_DIR ? path.resolve(process.env.SB_DIR) : path.join(__dirname, "uploads", "soundboards");
const CATALOG_FILE = path.join(__dirname, "soundboards.json");
// 1.99vu: ready-made catalogue audio (sound effects, verified TTS takes) - see AUDIO above; data/soundboard-sfx-licences.json
let AUDIO_SRC = process.env.SB_AUDIO_SRC ? path.resolve(process.env.SB_AUDIO_SRC) : path.join(__dirname, "data", "soundboard-audio");
const FILE_RE = /^[a-z0-9][a-z0-9-]{0,60}\.(ogg|opus|mp3|wav|flac)$/;
const GROUPS = ["sfx"];
const RARITIES = Object.freeze({ common: 6, rare: 8, epic: 10, legendary: 12 });
const ROOM_SECS = 10;
const DEFAULTS = Object.freeze({
  enabled: true,
  price_common: 1000, price_rare: 2500, price_epic: 5000, price_season: 2500,
  pack_price: 250000, voice_pack_price: 400000, season_price: 600000, all_access_price: 1500000,
  room_default_price: 1000, room_max_price: 10000,
  sp_packs: 1, report_hide: 3, pack_voice_pct: 15,
  // Pepe's limits (D: apply to owners and Season Pass too)
  cd_user_gap: 45, cd_user_burst: 6, cd_user_window: 600, cd_clip_room: 180, cd_room_gap: 12, cd_room_burst: 20, cd_room_window: 600,
  cd_legend_user: 600, cd_legend_room: 300, queue_max: 3, start_within: 60,
});
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const LABEL_MAX = 32, TEXT_MAX = 120;
// clip text guard (room boards): the same spirit as Pepe's imagine word list - no slurs, sexual content about real people,
// minors, threats, doxxing or fake staff announcements. Pepe's LLM guard runs again before he renders it.
// 1.99up: the list lives in textguard.js (the owner panel's room topic uses it too)
const BAD_TEXT = require("./textguard").BAD_TEXT;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().replace(/^@/, "").toLowerCase();
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const P = () => require("./premium");
const L = () => require("./likeness");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || { 400: "E_BAD_ARGS", 401: "E_NO_PERMISSION", 402: "E_INSUFFICIENT_PAT", 403: "E_NO_PERMISSION", 404: "E_TARGET_NOT_FOUND", 409: "E_ALREADY", 410: "E_GONE", 423: "E_FEATURE_OFF", 429: "E_RATE_LIMITED" }[status] || "E_REFUSED"; }
}

// ── catalogue (soundboards.json) ──
let CAT = { global: { clips: [] }, packs: [], seasons: [], legendaries: [], byPack: {}, bySeason: {}, byLegend: {}, groupOf: {} };
function loadCatalog(file = CATALOG_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const clip = (c, extra) => Object.assign({ id: String(c.id), label: String(c.label || c.id).slice(0, LABEL_MAX), emoji: String(c.emoji || "🔊").slice(0, 8),
    text: String(c.text || "").slice(0, 200), voice: c.voice == null ? null : String(c.voice).slice(0, 40), rarity: RARITIES[c.rarity] ? c.rarity : "common",
    file: FILE_RE.test(String(c.file || "")) ? String(c.file) : null, group: GROUPS.includes(c.group) ? c.group : null }, extra || {});
  const out = { global: { name: (raw.global || {}).name || "Global board", emoji: (raw.global || {}).emoji || "🌍", clips: ((raw.global || {}).clips || []).map((c) => clip(c)) },
                packs: [], seasons: [], legendaries: [], byPack: {}, bySeason: {}, byLegend: {} };
  for (const p of raw.packs || []) {
    const pk = { id: String(p.id), name: String(p.name), emoji: String(p.emoji || "🔊"), desc: String(p.desc || ""), kind: p.kind === "voice" ? "voice" : "standard",
                 price: Number(p.price) > 0 ? Math.floor(Number(p.price)) : null, retired: !!p.retired, clips: (p.clips || []).map((c) => clip(c)) };
    out.packs.push(pk);
    out.byPack[pk.id] = pk;
  }
  for (const s of raw.seasons || []) {
    const se = { id: String(s.id), name: String(s.name), emoji: String(s.emoji || "🗓️"), from: Date.parse(s.from + "T00:00:00Z"), to: Date.parse(s.to + "T00:00:00Z"),
                 clips: (s.clips || []).map((c) => clip(c, { rarity: c.rarity && RARITIES[c.rarity] ? c.rarity : "rare" })) };
    out.seasons.push(se);
    out.bySeason[se.id] = se;
  }
  for (const g of raw.legendaries || []) {
    const lg = clip(g, { rarity: "legendary", price: Math.floor(Number(g.price) || 0), live: !!g.live, supply: Number(g.supply) > 0 ? Math.floor(Number(g.supply)) : null,
                        numbered: !!g.numbered, desc: String(g.desc || "") });
    out.legendaries.push(lg);
    out.byLegend[lg.id] = lg;
  }
  out.groupOf = {};
  for (const c of out.global.clips) if (c.group) out.groupOf[c.id] = c.group;
  CAT = out;
  return CAT;
}
loadCatalog();
const seasonNow = (t = now()) => CAT.seasons.find((s) => t >= s.from && t < s.to) || null;
const periodKey = (t = now()) => new Date(t).toISOString().slice(0, 7);

// ── storage ──
let CONFIG = Object.assign({}, DEFAULTS);
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      fs.mkdirSync(DIR, { recursive: true });
      await runQuery(`CREATE TABLE IF NOT EXISTS sb_clips (id TEXT PRIMARY KEY, board TEXT NOT NULL, label TEXT NOT NULL, emoji TEXT, kind TEXT NOT NULL DEFAULT 'tts',
        voice TEXT, text TEXT, subject_login TEXT, src TEXT, trim_start REAL, trim_end REAL, audio TEXT, sha TEXT, secs REAL, rarity TEXT NOT NULL DEFAULT 'common',
        price INTEGER, status TEXT NOT NULL DEFAULT 'render', note TEXT, sort INTEGER DEFAULT 0, created_by TEXT, created INTEGER, updated INTEGER,
        catalog INTEGER DEFAULT 0, live INTEGER DEFAULT 0, supply INTEGER, tries INTEGER DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS sb_clips_board ON sb_clips (board, status)");
      // 1.99vu: a clip whose audio is being replaced (a new catalogue file) keeps playing until Pepe has uploaded the new WAV
      try { await runQuery("ALTER TABLE sb_clips ADD COLUMN pending INTEGER DEFAULT 0"); } catch (e) { /* already there */ }
      await runQuery(`CREATE TABLE IF NOT EXISTS sb_owned (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, item TEXT NOT NULL, source TEXT NOT NULL,
        payer_id TEXT, price INTEGER NOT NULL DEFAULT 0, ref TEXT NOT NULL, period TEXT, serial INTEGER, routing TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS sb_owned_own ON sb_owned (user_id, item)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS sb_owned_ref ON sb_owned (ref)");
      await runQuery("CREATE TABLE IF NOT EXISTS sb_reports (clip_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT, created INTEGER, PRIMARY KEY (clip_id, user_id))");
      await runQuery("CREATE TABLE IF NOT EXISTS sb_plays (id INTEGER PRIMARY KEY AUTOINCREMENT, clip_id TEXT, room_id TEXT, login TEXT, paid INTEGER, at INTEGER)");
      await runQuery("CREATE INDEX IF NOT EXISTS sb_plays_clip ON sb_plays (clip_id, at)");
      await runQuery("CREATE TABLE IF NOT EXISTS sb_config (key TEXT PRIMARY KEY, value TEXT)");
      await loadConfig();
      await seedCatalog();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function loadConfig() {
  const o = {};
  for (const r of await getQuery("SELECT key, value FROM sb_config")) { try { o[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  CONFIG = cleanConfig(Object.assign({}, DEFAULTS, o));
  return CONFIG;
}
function cleanConfig(c) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    if (typeof d === "boolean") out[k] = c[k] === undefined ? d : c[k] !== false;
    else { const n = Number(c[k]); out[k] = Number.isFinite(n) && n >= 0 ? Math.min(1e10, Math.floor(n)) : d; }
  }
  out.room_max_price = Math.min(out.room_max_price, 1e6);
  return out;
}
async function setConfig(patch, actor) {
  await init();
  CONFIG = cleanConfig(Object.assign({}, CONFIG, patch || {}));
  for (const [k, v] of Object.entries(CONFIG)) await runQuery("INSERT INTO sb_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(v)]);
  console.log(`[soundboards] config changed by ${actor || "?"}`);
  return CONFIG;
}
const config = () => CONFIG;

/** Catalogue clips -> sb_clips (a changed text / voice is rendered again; retired ones are hidden). 1.99vu: live clips are
 *  'active' (no WAV), a catalogue file is installed through Pepe (fileState), and a live clip stuck in 'render' is healed. */
async function seedCatalog() {
  const t = now();
  const want = [];
  for (const c of CAT.global.clips) want.push(Object.assign({ board: "global" }, c));
  for (const p of CAT.packs) for (const c of p.clips) want.push(Object.assign({ board: "pack:" + p.id }, c));
  for (const s of CAT.seasons) for (const c of s.clips) want.push(Object.assign({ board: "season:" + s.id }, c));
  for (const g of CAT.legendaries) want.push(Object.assign({ board: "legend" }, g));
  const ids = new Set();
  let i = 0;
  for (const c of want) {
    ids.add(c.id);
    const cur = (await getQuery("SELECT text, voice, status, src, audio, note FROM sb_clips WHERE id = ?", [c.id]))[0];
    const src = c.live ? null : fileSrc(c);
    if (!cur) {
      // live: playable at once (Pepe renders it at every play); a file: an audio render job; else a TTS render job
      await runQuery(`INSERT INTO sb_clips (id, board, label, emoji, kind, voice, text, src, rarity, status, sort, created_by, created, updated, catalog, live, supply)
                      VALUES (?, ?, ?, ?, 'tts', ?, ?, ?, ?, ?, ?, 'catalog', ?, ?, 1, ?, ?)`,
                     [c.id, c.board, c.label, c.emoji, c.voice, c.text, src, c.rarity, c.live ? "active" : "render", i, t, t, c.live ? 1 : 0, c.supply || null]);
    } else if (c.live) {
      await runQuery(`UPDATE sb_clips SET board = ?, label = ?, emoji = ?, voice = ?, text = ?, rarity = ?, sort = ?, live = 1, supply = ?, updated = ?,
                      status = CASE WHEN status IN ('render', 'removed', 'failed') THEN 'active' ELSE status END, tries = 0, pending = 0
                      WHERE id = ?`, [c.board, c.label, c.emoji, c.voice, c.text, c.rarity, i, c.supply || null, t, c.id]);
    } else if (src) {
      // a ready-made file: a NEW file (or one changed since) goes to Pepe again; the old WAV plays until the new one is up
      // 1.99vx: one that FAILED (Pepe couldn't fetch / convert it) is offered again at every boot - a deploy or restart retries it
      const hasAudio = !!cur.audio && cur.status !== "removed" && cur.status !== "failed";
      // 1.99we: ...and so is a clip still playing audio that ISN'T this file (its upload notes the file's src) - e.g. Pepe
      // failed 5 times, which cleared `pending` and left the old WAV in place
      const fresh = cur.src !== src || cur.status === "failed" || (hasAudio && cur.note !== src);
      await runQuery(`UPDATE sb_clips SET board = ?, label = ?, emoji = ?, voice = ?, text = ?, rarity = ?, sort = ?, live = 0, supply = ?, updated = ?, src = ?,
                      status = CASE WHEN ? THEN (CASE WHEN ? THEN (CASE WHEN status = 'hidden' THEN 'hidden' ELSE 'active' END) ELSE 'render' END)
                                    WHEN status = 'removed' THEN 'render' ELSE status END,
                      pending = CASE WHEN ? AND ? THEN 1 ELSE pending END, tries = CASE WHEN ? THEN 0 ELSE tries END
                      WHERE id = ?`,
                     [c.board, c.label, c.emoji, c.voice, c.text, c.rarity, i, c.supply || null, t, src,
                      fresh ? 1 : 0, hasAudio ? 1 : 0, fresh ? 1 : 0, hasAudio ? 1 : 0, fresh ? 1 : 0, c.id]);
    } else if (c.file) {
      // the file is named but unreadable here (a bad deploy?): keep the clip's current audio - never fall back to a TTS render
      await runQuery("UPDATE sb_clips SET board = ?, label = ?, emoji = ?, rarity = ?, sort = ?, updated = ? WHERE id = ?", [c.board, c.label, c.emoji, c.rarity, i, t, c.id]);
    } else {
      const again = cur.text !== c.text || (cur.voice || null) !== (c.voice || null) || String(cur.src || "").startsWith("file:");
      await runQuery(`UPDATE sb_clips SET board = ?, label = ?, emoji = ?, voice = ?, text = ?, rarity = ?, sort = ?, live = ?, supply = ?, updated = ?,
                      src = CASE WHEN src LIKE 'file:%' THEN NULL ELSE src END,
                      status = CASE WHEN ? THEN 'render' WHEN status = 'removed' THEN 'render' ELSE status END, tries = CASE WHEN ? THEN 0 ELSE tries END
                      WHERE id = ?`, [c.board, c.label, c.emoji, c.voice, c.text, c.rarity, i, c.live ? 1 : 0, c.supply || null, t, again ? 1 : 0, again ? 1 : 0, c.id]);
    }
    i++;
  }
  const cat = await getQuery("SELECT id FROM sb_clips WHERE catalog = 1 AND status != 'removed'");
  for (const r of cat) if (!ids.has(r.id)) await runQuery("UPDATE sb_clips SET status = 'removed', note = 'left the catalogue', updated = ? WHERE id = ?", [t, r.id]);
  await healLive();
}
/** 1.99vu: a live clip never waits for a WAV (the render queue skips live clips) - one left in 'render' is made playable. */
async function healLive() {
  const r = await runQuery("UPDATE sb_clips SET status = 'active', tries = 0, updated = ? WHERE live = 1 AND status = 'render'", [now()]);
  if (r && r.changes) console.log(`[soundboards] ${r.changes} live clip(s) were stuck in 'render' - now active`);
}
/** The src marker of a catalogue clip with a ready-made file: file:<name>#<sha12 of the file> (null: no file / unreadable). */
const _fileShas = new Map();
function fileSrc(c) {
  if (!c || !c.file) return null;
  const full = path.join(AUDIO_SRC, c.file);
  try {
    const st = fs.statSync(full);
    const k = `${full}:${st.size}:${st.mtimeMs}`;
    if (!_fileShas.has(k)) _fileShas.set(k, sha(fs.readFileSync(full)).slice(0, 12));
    return `file:${c.file}#${_fileShas.get(k)}`;
  } catch (e) {
    console.error(`[soundboards] catalogue file missing for ${c.id}: ${c.file}`);
    return null;
  }
}

// ── ownership ──
async function ownedItems(userId) {
  await init();
  if (!userId) return new Set();
  return new Set((await getQuery("SELECT item FROM sb_owned WHERE user_id = ?", [userId])).map((r) => r.item));
}
const hasPass = (userId) => { try { return !!(userId && P().hasPass(userId)); } catch (e) { return false; } };
/** What a viewer may play free right now: {items, pass} -> fn(clip) = free? */
function freeFor(items, pass) {
  return (c) => {
    if (!c) return false;
    const b = String(c.board || "");
    if (b === "legend") return items.has("legend:" + c.id);
    if (b.startsWith("pack:")) return items.has(b) || (items.has("all_access") && (CAT.byPack[b.slice(5)] || {}).kind !== "voice");
    if (b.startsWith("season:")) return pass || items.has(b);
    if (b === "global") return items.has("all_access");
    return false;
  };
}
function priceOf(c) {
  const b = String(c.board || "");
  if (b.startsWith("room:")) return c.price == null ? CONFIG.room_default_price : Math.max(0, Math.min(CONFIG.room_max_price, Math.floor(c.price)));
  if (b.startsWith("season:")) return CONFIG.price_season;
  if (b === "legend") return 0;
  return CONFIG["price_" + (c.rarity || "common")] || CONFIG.price_common;
}
const packPrice = (p) => p.price || (p.kind === "voice" ? CONFIG.voice_pack_price : CONFIG.pack_price);
async function allowance(userId, t = now()) {
  await init();
  const per = hasPass(userId) ? CONFIG.sp_packs : 0;
  if (!per) return { per: 0, used: 0, left: 0, period: periodKey(t) };
  const used = (await getQuery("SELECT COUNT(*) AS n FROM sb_owned WHERE user_id = ? AND source = 'season_pass' AND period = ?", [userId, periodKey(t)]))[0].n;
  return { per, used, left: Math.max(0, per - used), period: periodKey(t) };
}

// ── clips ──
const pub = (c) => ({ id: c.id, board: c.board, label: c.label, emoji: c.emoji, kind: c.kind, rarity: c.rarity, secs: c.secs ? Math.round(c.secs * 10) / 10 : null,
                      voice: c.voice || null, subject: c.subject_login || null, price: priceOf(c), status: c.status, live: !!c.live,
                      group: (c.board === "global" && CAT.groupOf[c.id]) || null,
                      audio: c.status === "active" && c.audio ? `/sb/audio/${c.id}.wav?v=${String(c.sha || "").slice(0, 8)}` : null });
async function clip(id) { await init(); return (await getQuery("SELECT * FROM sb_clips WHERE id = ?", [String(id || "")]))[0] || null; }
async function boardClips(board, statuses = ["active"]) {
  await init();
  return getQuery(`SELECT * FROM sb_clips WHERE board = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY sort, created`, [board, ...statuses]);
}
async function roomSlots(roomId) {
  try { return P().padPerks(roomId).soundboardSlots || 0; } catch (e) { return 0; }
}
function textRefusal(text) {
  const s = String(text || "");
  if (!s.trim()) return "Type the line Pepe should say.";
  if (s.length > TEXT_MAX) return `At most ${TEXT_MAX} characters.`;
  if (BAD_TEXT.some((re) => re.test(s))) return "That line isn't allowed on a soundboard.";
  if (/https?:\/\/|www\./i.test(s)) return "No links on a soundboard.";
  return null;
}
function cleanLabel(s) {
  const v = String(s || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, LABEL_MAX);
  if (!v) throw new Refuse(400, "Give the clip a short label.");
  return v;
}
const newId = (prefix) => prefix + "-" + crypto.randomBytes(5).toString("hex");

/**
 * Add a clip to a pad's room board. who = {userId|null, login|null, staff}; o = {kind: "tts"|"audio", label, emoji, text, voice,
 * price, subject, src (a media file or "pepe:<upload>"), trim_start, trim_end, wav (Buffer: Pepe's ready audio), secs}.
 */
async function addRoomClip(roomId, who, o) {
  await init();
  const rooms = require("./rooms");
  const R = rooms.getCached(roomId);
  if (!R) throw new Refuse(404, "That pad isn't on PATV.");
  const slots = await roomSlots(roomId);
  if (!slots) throw new Refuse(403, "Room soundboards come with 📺 Prime Time (8 clips) or 💎 Prime Time Plus (24).");
  const used = (await getQuery("SELECT COUNT(*) AS n FROM sb_clips WHERE board = ? AND status IN ('render','active','hidden')", ["room:" + roomId]))[0].n;
  if (used >= slots) throw new Refuse(409, `The board is full (${used} of ${slots} clips) - remove one first.`);
  const label = cleanLabel(o.label);
  if ((await getQuery("SELECT 1 FROM sb_clips WHERE board = ? AND status IN ('render','active','hidden') AND LOWER(label) = LOWER(?)", ["room:" + roomId, label])).length) {
    throw new Refuse(409, `There's already a clip called "${label}" on this board.`);
  }
  const kind = o.kind === "audio" ? "audio" : "tts";
  let text = null, subject = null;
  if (kind === "tts") {
    text = String(o.text || "").trim();
    const why = textRefusal(text);
    if (why) throw new Refuse(400, why);
    if (o.voice) {
      const VS = require("./voicestore");
      const v = await VS.voice(o.voice);
      if (!v || v.status !== "active") throw new Refuse(404, "No such voice.");
      if (v.kind === "clone" && !v.allow_soundboard && !(who.userId && v.owner_user_id === who.userId)) throw new Refuse(403, `${v.display} isn't available for soundboards.`);
      if (v.kind === "clone" && !v.allow_free_text && !(who.userId && v.owner_user_id === who.userId)) throw new Refuse(403, `${v.display} only says its owner's approved lines.`);
    }
  } else {
    subject = low(o.subject) || null;
    if (subject && !LOGIN_RE.test(subject)) subject = null;
    if (subject) {
      const su = await L().userByLogin(subject);
      if (su && !(await L().allows(su.userId, "soundboard"))) throw new Refuse(403, `${subject} has opted out of being on soundboards.`);
    }
  }
  let price = o.price == null || o.price === "" ? CONFIG.room_default_price : Math.floor(Number(o.price));
  if (!Number.isFinite(price) || price < 0 || price > CONFIG.room_max_price) throw new Refuse(400, `A price is 0 - ${fmt(CONFIG.room_max_price)} PAT.`);
  const id = newId("r");
  const t = now();
  let status = "render", audio = null, hash = null, secs = null;
  if (o.wav) {
    const r = saveWav(id, o.wav, Number(o.secs) || 0, ROOM_SECS);
    status = r.status; audio = r.audio; hash = r.sha; secs = r.secs;
  }
  await runQuery(`INSERT INTO sb_clips (id, board, label, emoji, kind, voice, text, subject_login, src, trim_start, trim_end, audio, sha, secs, rarity, price, status,
                  sort, created_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'epic', ?, ?, ?, ?, ?, ?)`,
                 [id, "room:" + roomId, label, String(o.emoji || (kind === "audio" ? "🎙️" : "🔊")).slice(0, 8), kind, o.voice || null, text, subject,
                  o.src || null, o.trim_start == null ? null : Number(o.trim_start), o.trim_end == null ? null : Number(o.trim_end), audio, hash, secs, price, status,
                  used, who.userId || ("cf:" + (who.login || "?")), t, t]);
  return clip(id);
}
async function removeClip(id, by, why) {
  await init();
  await runQuery("UPDATE sb_clips SET status = 'removed', note = ?, updated = ? WHERE id = ?", [String(why || "removed by " + (by || "?")).slice(0, 200), now(), id]);
  return true;
}

// ── audio ──
function wavSecs(buf) {
  try {
    if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") return null;
    let off = 12, rate = 0, chans = 0, bits = 0;
    while (off + 8 <= buf.length) {
      const id = buf.slice(off, off + 4).toString(), len = buf.readUInt32LE(off + 4);
      if (id === "fmt ") { chans = buf.readUInt16LE(off + 10); rate = buf.readUInt32LE(off + 12); bits = buf.readUInt16LE(off + 22); }
      if (id === "data") return rate && chans && bits ? Math.min(len, buf.length - off - 8) / (rate * chans * (bits / 8)) : null;
      off += 8 + len + (len % 2);
    }
  } catch (e) { return null; }
  return null;
}
function capFor(c) { return String(c.board || "").startsWith("room:") ? ROOM_SECS : (RARITIES[c.rarity] || 10); }
function saveWav(id, buf, secsHint, cap) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.length > 4 * 1024 * 1024) return { status: "failed" };
  const secs = wavSecs(buf);
  if (secs == null) return { status: "failed" };
  if (secs > cap + 0.25) return { status: "failed", secs, note: `too long (${secs.toFixed(1)} s, the cap is ${cap} s)` };
  fs.mkdirSync(DIR, { recursive: true });
  const file = id + ".wav";
  // 1.99vu: a WAV being replaced (a re-render, a new catalogue file) is kept in .replaced/<id>.<sha8>.wav - the way back
  try {
    const old = path.join(DIR, file);
    if (fs.existsSync(old)) {
      const prev = fs.readFileSync(old);
      if (sha(prev) !== sha(buf)) {
        fs.mkdirSync(path.join(DIR, ".replaced"), { recursive: true });
        fs.writeFileSync(path.join(DIR, ".replaced", `${id}.${sha(prev).slice(0, 8)}.wav`), prev);
      }
    }
  } catch (e) { console.error(`[soundboards] couldn't keep the old audio of ${id}: ${e.message}`); }
  fs.writeFileSync(path.join(DIR, file), buf);
  return { status: "active", audio: file, sha: sha(buf), secs };
}
async function storeAudio(id, buf, voice) {
  const c = await clip(id);
  if (!c || c.status === "removed") throw new Refuse(404, "No such clip.");
  const r = saveWav(id, buf, 0, capFor(c));
  const t = now();
  if (r.status !== "active") {
    // 1.99vu: a clip that already plays (its new file was refused) keeps its old WAV
    await runQuery(`UPDATE sb_clips SET status = CASE WHEN pending = 1 AND audio IS NOT NULL THEN status ELSE 'failed' END, pending = 0, note = ?, tries = tries + 1,
                    updated = ? WHERE id = ?`, [r.note || "bad audio", t, id]);
    return { ok: false, status: "failed", note: r.note || "bad audio" };
  }
  // `rendered_voice`: the voice Pepe actually used (a "random" catalogue clip is rolled once, at render time)
  await runQuery(`UPDATE sb_clips SET audio = ?, sha = ?, secs = ?, status = CASE WHEN status = 'hidden' THEN 'hidden' ELSE 'active' END, note = ?, pending = 0, tries = 0,
                  updated = ? WHERE id = ?`,
                 [r.audio, r.sha, r.secs, voice ? ("voice: " + String(voice).slice(0, 40)) : (String(c.src || "").startsWith("file:") ? c.src.slice(0, 120) : null), t, id]);
  return { ok: true, status: "active", secs: r.secs };
}

// ── what Pepe gets ──
async function botState() {
  await init();
  await healLive();
  // 1.99wc: a catalogue sound file Pepe failed on is offered again an hour later (not just at the next boot) - a Pepe
  // that couldn't fetch it (bot 1.99wb: his session stripped the bot token -> 403) recovers on his own once he's fixed
  await runQuery(`UPDATE sb_clips SET status = 'render', tries = 0, note = 'retrying the catalogue file', updated = ?
                  WHERE catalog = 1 AND status = 'failed' AND src LIKE 'file:%' AND updated < ?`, [now(), now() - 3600e3]);
  // 1.99we: the same for a clip that still plays its OLD audio (its file's upload never landed): offered again
  await runQuery(`UPDATE sb_clips SET pending = 1, tries = 0, updated = ?
                  WHERE catalog = 1 AND status IN ('active','hidden') AND src LIKE 'file:%' AND IFNULL(pending, 0) = 0
                        AND IFNULL(note, '') != src AND updated < ?`, [now(), now() - 3600e3]);
  const rows = await getQuery("SELECT * FROM sb_clips WHERE status IN ('active','render') ORDER BY board, sort, created");
  const season = seasonNow();
  const clips = rows.filter((c) => c.board !== "sample" && (!String(c.board).startsWith("season:") || (season && c.board === "season:" + season.id)))
    .map((c) => Object.assign(pub(c), { text: c.live ? c.text : undefined, voice_owner: null, sha: c.sha || null }));
  // the owners of cloned voices (their cut) and who may not be on a soundboard any more
  try {
    const VS = require("./voicestore");
    const owners = await VS.ownerMap();
    for (const c of clips) if (c.voice && owners[low(c.voice)]) c.voice_owner = owners[low(c.voice)];
  } catch (e) { /* no voice store yet */ }
  const own = await getQuery(`SELECT o.item, u.camfrogUsername AS cf FROM sb_owned o JOIN users u ON u.userId = o.user_id
                              WHERE u.camfrogUsername IS NOT NULL AND u.camfrogUsername != ''`);
  const owned = {};
  for (const r of own) (owned[low(r.cf)] = owned[low(r.cf)] || []).push(r.item);
  let sp = [];
  try { sp = await P().passCamfrogs(); } catch (e) { sp = []; }
  const optouts = await L().optoutMap().catch(() => ({}));
  const sbOut = Object.keys(optouts).filter((k) => (optouts[k] || []).includes("soundboard"));
  const render = (await getQuery(`SELECT id, kind, voice, text, src, trim_start, trim_end, board, rarity, live FROM sb_clips
                                  WHERE (status = 'render' OR (pending = 1 AND status IN ('active','hidden'))) AND live = 0 AND tries < 5
                                  ORDER BY created LIMIT 6`))
    // a catalogue file is an AUDIO job (Pepe fetches + converts it like a mic clip); the version rides on the URL
    .map((c) => ({ id: c.id, kind: String(c.src || "").startsWith("file:") ? "audio" : c.kind, voice: c.voice, text: c.text,
                   src: c.src ? `/api/soundboards/bot/src/${c.id}` + (String(c.src).startsWith("file:") ? `?v=${String(c.src).split("#")[1] || ""}` : "") : null,
                   trim_start: c.trim_start, trim_end: c.trim_end, cap: capFor(c) }));
  return { on: CONFIG.enabled, cfg: CONFIG, season: season ? { id: season.id, name: season.name, emoji: season.emoji } : null, clips, owned, sp, sb_optouts: sbOut, render };
}
async function notePlays(list) {
  for (const p of (Array.isArray(list) ? list : []).slice(0, 500)) {
    if (!p || !p.clip) continue;
    await runQuery("INSERT INTO sb_plays (clip_id, room_id, login, paid, at) VALUES (?, ?, ?, ?, ?)",
                   [String(p.clip).slice(0, 60), String(p.room || "").slice(0, 128), low(p.login).slice(0, 40), Math.floor(Number(p.paid) || 0),
                    Number(p.at) > 1e12 ? Math.floor(Number(p.at)) : now()]);
  }
}

// ── what a viewer sees in a room (the 🔊 drawer) ──
async function roomBoard(user, roomId) {
  await init();
  const items = await ownedItems(user && user.userId);
  const pass = hasPass(user && user.userId);
  const free = freeFor(items, pass);
  const season = seasonNow();
  const tabs = [];
  const add = (key, name, emoji, rows) => { if (rows.length) tabs.push({ key, name, emoji, clips: rows.map((c) => Object.assign(pub(c), { free: free(c) })) }); };
  add("room", "Room", "🏠", roomId ? await boardClips("room:" + roomId) : []);
  add("global", CAT.global.name, CAT.global.emoji, await boardClips("global"));
  if (season) add("season", season.name, season.emoji, await boardClips("season:" + season.id));
  const mine = [];
  for (const p of CAT.packs) if (!p.retired) mine.push(...(await boardClips("pack:" + p.id)));
  add("packs", "Packs", "🎁", mine);
  const legends = (await boardClips("legend")).filter((c) => items.has("legend:" + c.id));
  add("legend", "Legendary", "🌟", legends);
  // 1.99tf: the room's own switch + Pepe admins' master switch (Pepe's report, padowner.soundboardState) - the drawer says why
  let room = { on: true, why: null };
  if (roomId) { try { room = await require("./padowner").soundboardState(roomId); } catch (e) { room = { on: true, why: null }; } }
  return { on: CONFIG.enabled, room_on: room.on, room_why: room.why, pass, tabs, owned: [...items] };
}

// ── buying ──
function itemOf(raw) {
  const s = String(raw || "");
  if (s === "all_access") return { item: s, name: "All-Access", price: CONFIG.all_access_price, flow: "soundboard_pack" };
  if (s.startsWith("pack:")) { const p = CAT.byPack[s.slice(5)]; if (p && !p.retired) return { item: s, name: p.name, price: packPrice(p), flow: "soundboard_pack", pack: p }; }
  if (s.startsWith("season:")) { const se = CAT.bySeason[s.slice(7)]; if (se && seasonNow() && seasonNow().id === se.id) return { item: s, name: se.name, price: CONFIG.season_price, flow: "soundboard_pack", season: se }; }
  if (s.startsWith("legend:")) { const g = CAT.byLegend[s.slice(7)]; if (g) return { item: s, name: g.label, price: g.price, flow: "soundboard_legend", legend: g }; }
  return null;
}
async function buy(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!CONFIG.enabled) throw new Refuse(423, "Soundboards are switched off right now.");
  const it = itemOf(opts.item);
  if (!it) throw new Refuse(404, "That isn't for sale.");
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = `sb:${user.userId}:${rawRef}`;
  const useAllowance = !!opts.allowance;
  if (useAllowance && !(it.pack && it.pack.kind === "standard")) throw new Refuse(400, "The Season Pass's free pack is a standard pack.");
  const price = useAllowance ? 0 : it.price;
  const t = now();
  const out = await require("./boosts").tx(async () => {
    const had = (await getQuery("SELECT * FROM sb_owned WHERE ref = ?", [ref]))[0];
    if (had) return { dup: true, row: had };
    if ((await getQuery("SELECT 1 FROM sb_owned WHERE user_id = ? AND item = ?", [user.userId, it.item]))[0]) throw new Refuse(409, `You already have ${it.name}.`);
    let serial = null;
    if (it.legend && it.legend.supply) {
      const n = (await getQuery("SELECT COUNT(*) AS n FROM sb_owned WHERE item = ?", [it.item]))[0].n;
      if (n >= it.legend.supply) throw new Refuse(410, `All ${it.legend.supply} ${it.name} clips are taken.`);
      serial = n + 1;
    }
    let period = null, routing = null;
    if (useAllowance) {
      const a = await allowance(user.userId, t);
      if (!a.per) throw new Refuse(403, "The free monthly pack comes with a 🎟️ Season Pass.");
      if (!a.left) throw new Refuse(409, "You've used this month's free pack - more next month.");
      period = a.period;
    } else if (price > 0) {
      const r = await require("./ledger").post(user.userId, -price, `🔊 soundboard: ${it.name}`.slice(0, 120),
                                               { requireCover: true, transactionId: P().txRef(ref), source: "soundboards" });
      if (!r.ok) throw new Refuse(402, `${it.name} costs ${fmt(price)} PAT - you don't have enough.`);
      // the owners of cloned voices in a pack (or a legendary) get their cut (likeness.js, 15%), split by their clips
      let cut = 0;
      const clipsOf = it.pack ? it.pack.clips : it.legend ? [it.legend] : [];
      const byOwner = {};
      try {
        const owners = await require("./voicestore").ownerMap();
        for (const c of clipsOf) { const o = c.voice && owners[low(c.voice)]; if (o) byOwner[o] = (byOwner[o] || 0) + 1; }
      } catch (e) { /* no voice store */ }
      const total = clipsOf.length || 1;
      for (const [owner, n] of Object.entries(byOwner)) {
        cut += await L().siteCut({ key: "sb_pack", flow: it.flow, base: Math.floor(price * n / total), subjects: [owner], payerId: user.userId,
                                   ref: `sbp-${crypto.createHash("sha256").update(ref + owner).digest("hex").slice(0, 24)}` });
      }
      routing = await P().bookRoute(it.flow, price - cut, { payerId: user.userId, label: `soundboard ${it.item}` });
    }
    await runQuery(`INSERT INTO sb_owned (user_id, item, source, payer_id, price, ref, period, serial, routing, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [user.userId, it.item, useAllowance ? "season_pass" : "buy", user.userId, price, ref, period, serial, routing ? JSON.stringify(routing) : null, t]);
    return { dup: false, serial };
  });
  if (out.dup) return { dup: true, item: it.item, price: out.row.price };
  return { dup: false, item: it.item, name: it.name, price, serial: out.serial, source: useAllowance ? "season_pass" : "buy" };
}
async function grantComp(userId, item, by) {
  await init();
  const it = itemOf(item);
  if (!it) throw new Refuse(404, "No such soundboard item.");
  if ((await getQuery("SELECT 1 FROM sb_owned WHERE user_id = ? AND item = ?", [userId, it.item]))[0]) return { already: true };
  await runQuery("INSERT INTO sb_owned (user_id, item, source, payer_id, price, ref, created) VALUES (?, ?, 'comp', NULL, 0, ?, ?)",
                 [userId, it.item, `comp:${String(by || "?").slice(0, 40)}:${userId}:${it.item}:${now()}`, now()]);
  return { already: false };
}

// ── reports / removal ──
async function report(user, clipId, reason) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const c = await clip(clipId);
  if (!c || c.status === "removed") throw new Refuse(404, "No such clip.");
  await runQuery("INSERT OR IGNORE INTO sb_reports (clip_id, user_id, reason, created) VALUES (?, ?, ?, ?)", [c.id, user.userId, String(reason || "").slice(0, 300), now()]);
  const n = (await getQuery("SELECT COUNT(*) AS n FROM sb_reports WHERE clip_id = ?", [c.id]))[0].n;
  if (n >= CONFIG.report_hide && c.status === "active") {
    await runQuery("UPDATE sb_clips SET status = 'hidden', note = ?, updated = ? WHERE id = ?", [`${n} reports - hidden pending review`, now(), c.id]);
    return { reports: n, hidden: true };
  }
  return { reports: n, hidden: false };
}
/** The person heard in a mic clip removes it ("Remove me") - instant, no review. */
async function removeMe(user, clipId) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const c = await clip(clipId);
  if (!c || c.status === "removed") throw new Refuse(404, "No such clip.");
  const me = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [user.userId]))[0];
  let mine = !!(me && c.subject_login && low(me.camfrogUsername) === low(c.subject_login));
  if (!mine && c.voice) {
    try { const v = await require("./voicestore").voice(c.voice); mine = !!(v && v.owner_user_id === user.userId); } catch (e) { mine = false; }
  }
  if (!mine) throw new Refuse(403, "Only the person heard in a clip can remove it.");
  await removeClip(c.id, user.username, "removed by the person heard in it");
  return { removed: true };
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[soundboards] init:", e.message));
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "64kb" });
  const big = express.json({ limit: "6mb" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code });
    console.error("[soundboards]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const same = (req, res) => {
    if (!guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const staff = (u) => !!u && ["Admin", "Staff"].includes(u.class);
  const padOf = async (slug) => {
    const rooms = require("./rooms");
    return (await rooms.bySlug(String(slug || "").toLowerCase())) || (await require("./roomsweb").resolveRoom(String(slug || "")).catch(() => null));
  };

  // ── Pepe ──
  app.post("/api/soundboards/bot/sync", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { await notePlays(b.plays); res.json({ ok: true, ...(await botState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/soundboards/bot/audio", big, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      if (b.failed) {
        await init();
        // 1.99vu: a clip that already has audio (its new catalogue file failed) keeps playing it; after 5 tries it stops asking
        await runQuery(`UPDATE sb_clips SET tries = tries + 1, note = ?,
                        status = CASE WHEN tries + 1 >= 5 AND NOT (pending = 1 AND audio IS NOT NULL) THEN 'failed' ELSE status END,
                        pending = CASE WHEN tries + 1 >= 5 THEN 0 ELSE pending END, updated = ? WHERE id = ?`,
                       [String(b.failed).slice(0, 200), now(), String(b.id || "")]);
        return res.json({ ok: true });
      }
      res.json(await storeAudio(String(b.id || ""), Buffer.from(String(b.data || ""), "base64"), b.voice));
    } catch (e) { fail(res, e); }
  });
  app.get("/api/soundboards/bot/src/:id", async (req, res) => {
    if (!isBotToken(req.get("x-bot-token") || req.query.password)) return res.status(403).end();
    try {
      const c = await clip(req.params.id);
      if (!c || !c.src) return res.status(404).end();
      if (c.src.startsWith("file:")) {
        // 1.99vu: a catalogue file (data/soundboard-audio) - only names the catalogue itself allows (FILE_RE, no paths)
        const name = c.src.slice(5).split("#")[0];
        const full = path.join(AUDIO_SRC, name);
        if (!FILE_RE.test(name) || path.dirname(full) !== AUDIO_SRC || !fs.existsSync(full)) return res.status(404).end();
        res.set("Cache-Control", "no-store");
        return res.sendFile(full);
      }
      if (c.src.startsWith("media:")) {
        const M = require("./media");
        const m = (await getQuery("SELECT file FROM media WHERE id = ?", [c.src.slice(6)]))[0];
        if (!m || !M.fileExists(m)) return res.status(404).end();
        return res.sendFile(path.join(M.DIR, m.file));
      }
      res.status(404).end();
    } catch (e) { res.status(500).end(); }
  });
  // chat: !sb add / !sb addmic (Pepe checked the owner / mod) and !sb remove
  app.post("/api/soundboards/bot/room-clip", big, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const c = await addRoomClip(String(b.room || ""), { userId: null, login: low(b.camfrog) }, {
        kind: b.kind, label: b.label, text: b.text, voice: b.voice, price: b.price, subject: b.subject,
        wav: b.data ? Buffer.from(String(b.data), "base64") : null, secs: b.secs });
      res.json({ ok: true, clip: pub(c) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/soundboards/bot/room-remove", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      await init();
      const c = (await getQuery("SELECT * FROM sb_clips WHERE board = ? AND status IN ('render','active','hidden','failed') AND (id = ? OR LOWER(label) = LOWER(?)) LIMIT 1",
                                ["room:" + String(b.room || ""), String(b.clip || ""), String(b.clip || "")]))[0];
      if (!c) return res.status(404).json({ ok: false, error: "no clip by that name on this room's board" });
      await removeClip(c.id, "cf:" + low(b.camfrog), "removed in chat by " + low(b.camfrog));
      res.json({ ok: true, label: c.label });
    } catch (e) { fail(res, e); }
  });

  // ── audio (previews) ──
  app.get("/sb/audio/:file", addUser, async (req, res) => {
    const m = /^([a-z0-9][a-z0-9-]{1,40})\.wav$/.exec(String(req.params.file || ""));
    if (!m) return res.status(404).end();
    try {
      const c = await clip(m[1]);
      if (!c || !c.audio || !["active", "hidden"].includes(c.status)) return res.status(404).end();
      if (c.status === "hidden" && !staff(req.user)) return res.status(404).end();
      res.set("Cache-Control", "public, max-age=86400");
      res.type("audio/wav");
      res.sendFile(path.join(DIR, c.audio));
    } catch (e) { res.status(500).end(); }
  });

  // ── the store ──
  const pageData = async (user) => {
    await init();
    const items = await ownedItems(user && user.userId);
    const pass = hasPass(user && user.userId);
    const free = freeFor(items, pass);
    const map = async (board) => (await boardClips(board)).map((c) => Object.assign(pub(c), { free: free(c) }));
    const season = seasonNow();
    const legends = [];
    for (const g of CAT.legendaries) {
      const sold = (await getQuery("SELECT COUNT(*) AS n FROM sb_owned WHERE item = ?", ["legend:" + g.id]))[0].n;
      const c = await clip(g.id);
      legends.push({ id: g.id, item: "legend:" + g.id, label: g.label, emoji: g.emoji, desc: g.desc, price: g.price, supply: g.supply, sold, owned: items.has("legend:" + g.id),
                     audio: c ? pub(c).audio : null, live: g.live });
    }
    const packs = [];
    for (const p of CAT.packs) if (!p.retired) packs.push({ id: p.id, item: "pack:" + p.id, name: p.name, emoji: p.emoji, desc: p.desc, kind: p.kind, price: packPrice(p),
                                                           owned: items.has("pack:" + p.id) || (items.has("all_access") && p.kind !== "voice"), clips: await map("pack:" + p.id) });
    return { on: CONFIG.enabled, signed: !!(user && user.userId), pass, allowance: user && user.userId ? await allowance(user.userId) : null, cfg: CONFIG,
             global: { name: CAT.global.name, emoji: CAT.global.emoji, clips: await map("global") },
             season: season ? { id: season.id, item: "season:" + season.id, name: season.name, emoji: season.emoji, to: season.to, price: CONFIG.season_price,
                                owned: pass || items.has("season:" + season.id), clips: await map("season:" + season.id) } : null,
             packs, legends, all_access: { item: "all_access", price: CONFIG.all_access_price, owned: items.has("all_access") } };
  };
  app.get("/soundboards", addUser, async (req, res, next) => {
    try {
      res.set("Cache-Control", "private, no-store");
      res.render("soundboards", { user: req.user ? req.user.username : null, d: await pageData(req.user) });
    } catch (e) { next(e); }
  });
  app.get("/api/soundboards", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await pageData(req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/soundboards/buy", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    try {
      const b = req.body || {};
      const r = await buy(req.user, { item: b.item, ref: b.ref, allowance: b.allowance === true });
      res.json({ ok: true, ...r, state: await pageData(req.user) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/soundboards/report", addUser, json, async (req, res) => {
    if (!same(req, res)) return;
    try { res.json({ ok: true, ...(await report(req.user, (req.body || {}).clip, (req.body || {}).reason)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/soundboards/remove-me", addUser, json, async (req, res) => {
    if (!same(req, res)) return;
    try { res.json({ ok: true, ...(await removeMe(req.user, (req.body || {}).clip)) }); } catch (e) { fail(res, e); }
  });

  // ── a pad's board: the 🔊 drawer + the owner's editor ──
  app.get("/api/rooms/:slug/soundboard", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await padOf(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.json({ ok: true, ...(await roomBoard(req.user, R.id)) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/soundboard/manage", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await padOf(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      if (!(await require("./rooms").canManage(req.user, R.id))) return res.status(403).json({ ok: false, error: "Only the pad's owner can edit its soundboard." });
      res.json({ ok: true, ...(await manageState(R.id)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/soundboard/clips", addUser, big, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    try {
      const R = await padOf(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      if (!(await require("./rooms").canManage(req.user, R.id))) return res.status(403).json({ ok: false, error: "Only the pad's owner can edit its soundboard." });
      const b = req.body || {};
      const who = { userId: req.user.userId, staff: staff(req.user) };
      if (b.action === "add_tts") {
        await addRoomClip(R.id, who, { kind: "tts", label: b.label, emoji: b.emoji, text: b.text, voice: b.voice || null, price: b.price });
      } else if (b.action === "add_mic") {
        // a 🔊 mic clip already posted on this pad (feed_voices): the person heard in it must allow soundboards (likeness.js)
        const pid = String(b.post || "").replace(/^.*\/posts\//, "").replace(/[/?#].*$/, "");
        const v = (await getQuery("SELECT * FROM feed_voices WHERE post_id = ? AND removed_at IS NULL", [pid]))[0];
        if (!v || v.room_id !== R.id) throw new Refuse(404, "That isn't a 🔊 mic clip posted on this pad.");
        const logins = String(v.logins || "").trim().split(/\s+/).filter(Boolean);
        if (logins.length !== 1) throw new Refuse(400, "Pick a mic clip with one person in it.");
        const st = Math.max(0, Number(b.start) || 0), en = Number(b.end) || st + ROOM_SECS;
        if (en - st > ROOM_SECS + 0.01 || en <= st) throw new Refuse(400, `Pick at most ${ROOM_SECS} seconds.`);
        await addRoomClip(R.id, who, { kind: "audio", label: b.label, emoji: b.emoji, subject: logins[0], src: "media:" + v.media_id, trim_start: st, trim_end: en, price: b.price });
      } else if (b.action === "price" || b.action === "remove" || b.action === "move") {
        const c = await clip(b.clip);
        if (!c || c.board !== "room:" + R.id || c.status === "removed") throw new Refuse(404, "No such clip on this board.");
        if (b.action === "remove") await removeClip(c.id, req.user.username, "removed by the pad owner");
        else if (b.action === "price") {
          const p = Math.floor(Number(b.price));
          if (!Number.isFinite(p) || p < 0 || p > CONFIG.room_max_price) throw new Refuse(400, `A price is 0 - ${fmt(CONFIG.room_max_price)} PAT.`);
          await runQuery("UPDATE sb_clips SET price = ?, updated = ? WHERE id = ?", [p, now(), c.id]);
        } else {
          const list = await boardClips("room:" + R.id, ["render", "active", "hidden", "failed"]);
          const i = list.findIndex((x) => x.id === c.id), j = i + (b.dir === "up" ? -1 : 1);
          if (i >= 0 && j >= 0 && j < list.length) { const tmp = list[i]; list[i] = list[j]; list[j] = tmp; }
          for (let k = 0; k < list.length; k++) await runQuery("UPDATE sb_clips SET sort = ? WHERE id = ?", [k, list[k].id]);
        }
      } else throw new Refuse(400, "What should I do?");
      res.json({ ok: true, ...(await manageState(R.id)) });
    } catch (e) { fail(res, e); }
  });

  // ── staff ──
  app.get("/admin/soundboards", addUser, async (req, res, next) => {
    try {
      if (!staff(req.user)) return res.status(404).render("notFound", { user: req.user ? req.user.username : null });
      res.set("Cache-Control", "private, no-store");
      res.render("sbAdmin", { user: req.user.username, d: await adminState() });
    } catch (e) { next(e); }
  });
  app.get("/api/soundboards/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!staff(req.user)) return res.status(403).json({ ok: false });
    try { res.json({ ok: true, ...(await adminState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/soundboards/admin", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!same(req, res)) return;
    if (!staff(req.user)) return res.status(403).json({ ok: false, error: "Staff only." });
    try {
      const b = req.body || {};
      if (b.config) {
        if (req.user.class !== "Admin") throw new Refuse(403, "Admins only.");
        await setConfig(b.config, req.user.username);
      }
      if (b.clip && ["hide", "restore", "remove", "rerender"].includes(b.action)) {
        const c = await clip(b.clip);
        if (!c) throw new Refuse(404, "No such clip.");
        const st = { hide: "hidden", restore: c.audio ? "active" : "render", remove: "removed", rerender: "render" }[b.action];
        await runQuery("UPDATE sb_clips SET status = ?, note = ?, tries = CASE WHEN ? = 'render' THEN 0 ELSE tries END, updated = ? WHERE id = ?",
                       [st, `${b.action} by ${req.user.username}`, st, now(), c.id]);
        if (b.action === "restore") await runQuery("DELETE FROM sb_reports WHERE clip_id = ?", [c.id]);
      }
      res.json({ ok: true, ...(await adminState()) });
    } catch (e) { fail(res, e); }
  });
}

async function manageState(roomId) {
  await init();
  const slots = await roomSlots(roomId);
  const clips = (await boardClips("room:" + roomId, ["render", "active", "hidden", "failed"])).map((c) => Object.assign(pub(c), { text: c.text, note: c.note, price: priceOf(c) }));
  let voices = [];
  try { voices = await require("./voicestore").pickable(); } catch (e) { voices = []; }
  return { slots, used: clips.length, clips, voices, max_price: CONFIG.room_max_price, default_price: CONFIG.room_default_price, secs: ROOM_SECS };
}
async function adminState() {
  await init();
  const counts = await getQuery("SELECT status, COUNT(*) AS n FROM sb_clips GROUP BY status");
  const reported = await getQuery(`SELECT c.id, c.board, c.label, c.status, c.note, c.audio, c.sha, COUNT(r.user_id) AS reports FROM sb_clips c JOIN sb_reports r ON r.clip_id = c.id
                                   GROUP BY c.id ORDER BY reports DESC LIMIT 50`);
  const failed = await getQuery("SELECT id, board, label, note, tries FROM sb_clips WHERE status IN ('failed','render') ORDER BY updated DESC LIMIT 50");
  const sales = await getQuery("SELECT item, COUNT(*) AS n, SUM(price) AS pat FROM sb_owned GROUP BY item ORDER BY pat DESC LIMIT 50");
  const plays = await getQuery("SELECT clip_id, COUNT(*) AS n, SUM(paid) AS pat FROM sb_plays WHERE at > ? GROUP BY clip_id ORDER BY n DESC LIMIT 20", [now() - 7 * 86400000]);
  return { cfg: CONFIG, counts, reported: reported.map((c) => Object.assign(c, { audio: c.audio ? `/sb/audio/${c.id}.wav?v=${String(c.sha || "").slice(0, 8)}` : null })), failed, sales, plays };
}

module.exports = {
  init, config, setConfig, loadCatalog, seasonNow, botState, notePlays, roomBoard, addRoomClip, removeClip, storeAudio, buy, grantComp, allowance, ownedItems,
  report, removeMe, priceOf, clipStatus: clip, freeFor, textRefusal, wavSecs, register, Refuse, RARITIES, ROOM_SECS,
  get CAT() { return CAT; }, get DIR() { return DIR; }, get AUDIO_SRC() { return AUDIO_SRC; }, fileSrc, healLive,
  _setAudioSrc: (d) => { AUDIO_SRC = path.resolve(d); },
  _seed: () => seedCatalog(),
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
