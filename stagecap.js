// stagecap.js — viewers snap and clip the STAGES (1.99cr): Pepe's broadcast and the pads' live user
// slots, the way !snap / !clip capture a Camfrog cam. A saved capture goes into the pad's story
// (stories.js) next to Pepe's cam captures, labelled "📺 Stage snap/clip of <stream> by <user>".
//
// Flow
//   1. Preview (POST /api/stage/capture {room, stream, kind, secs}). Signed in, with a linked Camfrog
//      name or level >= MIN_LEVEL (staff exempt). The stream is resolved through the stage registry
//      ONLY: "pepe" = Pepe's broadcast (HLS "broadcast", while Pepe is in that pad's room), or a slot
//      id = an open, live, non-embed slot of that pad whose streamer hasn't opted out. Never a path or
//      a name from the browser. YouTube / Twitch embeds can't be captured (cross-origin; not ours).
//      The capture is cut SERVER-SIDE from the HLS segments nginx-rtmp already wrote to disk:
//        snap  the first frame (a keyframe) of the newest complete segment -> webp (sharp, no metadata)
//        clip  the last N s (default 20, max 30) of the newest segments, byte-concatenated MPEG-TS ->
//              H.264 High <= 720p + AAC mp4 (+faststart, metadata dropped)
//      ffmpeg runs in feedmedia.js's job queue (FFMPEG_JOBS = 2 at a time, niced), with the demuxer
//      FORCED (-f mpegts) and -protocol_whitelist file, on local files we picked, with a timeout. The
//      playlist is parsed here (never handed to ffmpeg's HLS demuxer): segment names must be exactly
//      "<stream>-<n>.ts", regular files (no symlinks) inside the HLS directory.
//      The preview is held PREVIEW_TTL, visible only to the account that made it.
//   2. Save (POST /api/stage/captures/:id/save) = a website action "stagecap.save" (actions.js), the
//      same path as the bridge popover's "Save snap": Pepe claims it, checks the capture is still here
//      (/api/stage/captures/check), charges the !snap / !clip price of that pad's room (admins free)
//      with the same PAT routing (Reserve + the room owner's share), then publishes it
//      (/api/stage/captures/publish) and refunds if publishing fails. Accounts without a linked
//      Camfrog name (level >= 2) are charged by their PATV account.
//   3. Published = a media row (media.js) with source "stage": the pad's story, the capture page
//      (/media/<id>), the captures feed (/stage/captures). A content_audit row for the capturer.
//
// Streamer controls: per slot "capture_off" (viewers may NOT snap / clip; default allowed) and "nsfw"
// (captures are marked NSFW). Captures of an NSFW slot are NSFW. Deleting a stage capture: the pad's
// owner, site staff, the capturer, or the slot's streamer.
//
// Rate limits (memory): per user one snap / 10 s and one clip / 60 s; per stream one snap / 3 s and
// one clip / 20 s; at most 3 open previews per user.
//
// Switches (1.99cw), checked at preview, at save, and by Pepe at save time:
//   * the admin kill switch: stage config (mainstage.js, Stage admin) stagecap_enabled, plus one per
//     kind (stagecap_snaps / stagecap_clips), all default ON. Off -> the buttons are hidden, the API
//     refuses, /api/stage/captures/check answers 403 "disabled" (Pepe refuses) and publish refuses
//     (Pepe refunds).
//   * the Camfrog room's !snap switch (`!snap on|off`, default OFF) - the same one !snap and the
//     bridge's Save snap obey. Pepe reports it per room (bridge.snapSwitch); not reported counts as
//     off. Off -> the buttons show disabled ("Snaps are off in this room"), the API refuses, and Pepe
//     re-checks at save. Site-only pads (no Camfrog room, e.g. the Camfrog Lounge) have no switch.
//   * the streamer's per-slot opt-out (capture_off) still applies on top.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const media = require("./media");
const fm = require("./feedmedia");

const STAGING = !!process.env.STAGING;
const PEPE_STREAM = "broadcast";
let HLS_DIR = path.resolve(process.env.STAGECAP_HLS_DIR || ("/mnt/hls" + (STAGING ? "/staging" : "")));
let PEPE_HLS_DIR = path.resolve(process.env.STAGECAP_PEPE_HLS_DIR || "/mnt/hls");
const PREVIEW_TTL = 10 * 60 * 1000;        // a preview can be saved for this long
const SAVE_TTL = 20 * 60 * 1000;           // Pepe must publish within this long of the preview
const PLAYLIST_FRESH_MS = 30 * 1000;       // nginx-rtmp rewrites the playlist every fragment
const SEG_GAP_MS = 15 * 1000;              // older segments must follow on without a gap (same stream run)
const CLIP_DEFAULT = 20, CLIP_MAX = 30, CLIP_MIN = 3;
const MAX_CONCAT_BYTES = 120 * 1024 * 1024;
const SNAP_PX = 1920;
const FF_TIMEOUT = 90 * 1000;
const MIN_LEVEL = 2;
const PRICES = { snap: 25000, clip: 50000 };   // Pepe's DEFAULT_PAT_COSTS; he charges the room's real price
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CID_RE = /^c[a-f0-9]{20}$/;
const LIMITS = { userSnap: 10e3, userClip: 60e3, streamSnap: 3e3, streamClip: 20e3, openPreviews: 3 };

let NOW = () => Date.now();

// ── storage ──
let ready = null;
async function addColumn(table, col, decl) {
  const cols = await getQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === col)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
function init() {
  if (!ready) {
    ready = (async () => {
      await media.ready;
      await require("./mainstage").init();
      await addColumn("stage_slots", "capture_off", "INTEGER NOT NULL DEFAULT 0");
      await addColumn("stage_slots", "nsfw", "INTEGER NOT NULL DEFAULT 0");
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_captures (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, room_id TEXT NOT NULL, source TEXT NOT NULL, slot_id TEXT,
        stream_label TEXT, kind TEXT NOT NULL, ct TEXT NOT NULL, secs REAL, bytes INTEGER, nsfw INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, action_id INTEGER, media_id TEXT, message TEXT, created INTEGER NOT NULL, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_captures_user ON stage_captures (user_id, created)");
      fs.mkdirSync(tmpDir(), { recursive: true });
    })().catch((e) => { console.error("[stagecap] init:", e.message); ready = null; throw e; });
  }
  return ready;
}
const tmpDir = () => path.join(media.DIR, "stagecap-tmp");
const previewFile = (cap) => path.join(tmpDir(), cap.id + (cap.kind === "clip" ? ".mp4" : ".webp"));

// ── HLS on disk (pure-ish; exported for tests) ──
/** The playlist of stream `name` in `dir`, or null when the name isn't a plain stream name. */
function playlistPath(dir, name) {
  if (!NAME_RE.test(String(name || ""))) return null;
  const base = path.resolve(dir);
  const p = path.join(base, name + ".m3u8");
  return path.dirname(p) === base ? p : null;
}
/** A regular file (not a symlink, not a directory) directly inside `dir`. */
function plainFile(dir, file) {
  const base = path.resolve(dir);
  const p = path.join(base, file);
  if (path.dirname(p) !== base) return null;
  try {
    const st = fs.lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() ? { p, st } : null;
  } catch (e) { return null; }
}
/**
 * The newest segments of a LIVE stream, oldest first: [{file, p, seq, dur, mtime}]. `want` seconds:
 * the playlist's segments, extended backwards with older "<name>-<n-1>.ts" files still on disk (nginx
 * keeps them a while) when the playlist is shorter than `want`. Throws a user-facing error when the
 * stream isn't live.
 */
function liveSegments(dir, name, want = 0) {
  const pl = playlistPath(dir, name);
  if (!pl) throw refuse(400, "That stream can't be captured.");
  const f = plainFile(dir, name + ".m3u8");
  if (!f) throw refuse(409, "That stream isn't live right now.");
  if (Date.now() - f.st.mtimeMs > PLAYLIST_FRESH_MS) throw refuse(409, "That stream isn't live right now.");   // file times: the real clock
  if (f.st.size > 64 * 1024) throw refuse(409, "That stream can't be captured.");
  const lines = fs.readFileSync(f.p, "latin1").split(/\r?\n/);
  const segRe = new RegExp("^" + name + "-(\\d{1,12})\\.ts$");      // name is [A-Za-z0-9_-] only (NAME_RE)
  let target = 2, dur = null;
  const segs = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const td = /^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)$/.exec(l);
    if (td) { target = Math.min(30, Math.max(0.5, Number(td[1]))); continue; }
    const inf = /^#EXTINF:(\d+(?:\.\d+)?)/.exec(l);
    if (inf) { dur = Math.min(60, Number(inf[1])); continue; }
    if (l[0] === "#") continue;
    const m = segRe.exec(l);
    if (!m) { dur = null; continue; }                  // anything that isn't one of OUR segments is ignored
    const seg = plainFile(dir, l);
    if (seg) segs.push({ file: l, p: seg.p, seq: Number(m[1]), dur: dur || target, mtime: seg.st.mtimeMs, bytes: seg.st.size });
    dur = null;
  }
  if (!segs.length) throw refuse(409, "That stream isn't live right now.");
  let total = segs.reduce((a, s) => a + s.dur, 0);
  while (want && total < want) {
    const first = segs[0];
    if (first.seq <= 0) break;
    const file = `${name}-${first.seq - 1}.ts`;
    const seg = plainFile(dir, file);
    if (!seg || seg.st.mtimeMs > first.mtime || first.mtime - seg.st.mtimeMs > SEG_GAP_MS) break;
    segs.unshift({ file, p: seg.p, seq: first.seq - 1, dur: target, mtime: seg.st.mtimeMs, bytes: seg.st.size });
    total += target;
  }
  return segs;
}

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const refuse = (s, m) => new Refuse(s, m);

/** Snap: the first frame of the newest complete segment -> webp in `out`. -> {w, h, bytes} */
async function extractSnap(segs, out) {
  const seg = segs[segs.length - 1];
  const png = out + ".png";
  const release = await fm.slot();
  try {
    await fm.run(fm.bin("ffmpeg"), ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mpegts", "-i", seg.p,
      "-map", "0:v:0", "-frames:v", "1", "-map_metadata", "-1", "-f", "image2", "-c:v", "png", "-y", png], { timeoutMs: FF_TIMEOUT });
  } finally { release(); }
  try {
    const sharp = require("sharp");
    const info = await sharp(png, { limitInputPixels: 60e6 }).resize({ width: SNAP_PX, height: SNAP_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 }).toFile(out);
    return { w: info.width, h: info.height, bytes: info.size, secs: 0 };
  } finally { try { fs.unlinkSync(png); } catch (e) { /* none */ } }
}

/** Clip: the last `secs` seconds of `segs` -> H.264/AAC mp4 (<= 720p) in `out`. -> {secs, bytes} */
async function extractClip(segs, secs, out) {
  const total = segs.reduce((a, s) => a + s.dur, 0);
  const cat = out + ".ts";
  // MPEG-TS concatenates by bytes; we never give ffmpeg a playlist or a concat list
  let bytes = 0;
  const fd = fs.openSync(cat, "w");
  try {
    for (const s of segs) {
      const b = fs.readFileSync(s.p);
      bytes += b.length;
      if (bytes > MAX_CONCAT_BYTES) throw refuse(413, "That stream's bitrate is too high to clip.");
      fs.writeSync(fd, b);
    }
  } finally { fs.closeSync(fd); }
  const start = Math.max(0, total - secs);
  const vf = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const release = await fm.slot();
  try {
    await fm.run(fm.bin("ffmpeg"), ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mpegts", "-ss", start.toFixed(2), "-i", cat,
      "-t", String(secs), "-map", "0:v:0", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-vf", vf,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-threads", "4", "-f", "mp4", "-y", out], { timeoutMs: FF_TIMEOUT });
  } finally {
    release();
    try { fs.unlinkSync(cat); } catch (e) { /* none */ }
  }
  let got = Math.min(secs, total);
  try { const pr = await fm.probe(out, "mov"); if (pr.secs > 0) got = pr.secs; if (!pr.video) throw refuse(409, "That stream has no video to clip."); } catch (e) { if (e.refuse) throw e; }
  return { secs: Math.round(got * 10) / 10, bytes: fs.statSync(out).size };
}

// ── dependencies (the live stage; injectable for tests) ──
let deps = {
  resolveRoom: (slug) => require("./roomsweb").resolveRoom(slug),
  pepeIn: (roomId) => require("./bridge").pepeIn(roomId),
  roomCmds: (roomId) => { try { const B = require("./bridge")._rooms.get(roomId); return (B && B.cmds) || {}; } catch (e) { return {}; } },
  canManage: (user, roomId) => require("./rooms").canManage(user, roomId),
  isStaff: (u) => require("./rooms").isStaff(u),
  config: () => require("./mainstage").config(),
  snapSwitch: (roomId) => { try { return require("./bridge").snapSwitch(roomId); } catch (e) { return null; } },
  snapOffText: (roomId) => require("./bridge").snapOffText(roomId),
  siteOnly: (roomId) => require("./rooms").isCommunityOnly(roomId),
};
function _setDeps(d) { deps = { ...deps, ...d }; }
function _setDirs(hls, pepe) { HLS_DIR = path.resolve(hls); PEPE_HLS_DIR = path.resolve(pepe || hls); }

async function account(userId) {
  const C = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const col = (c) => (C.has(c) ? c : `NULL AS ${c}`);
  return (await getQuery(`SELECT userId, username, displayname, class, ${col("level")}, ${col("camfrogUsername")}, ${col("created_at")}, ${col("discordId")}, ${col("twitchId")}
                          FROM users WHERE userId = ?`, [String(userId || "")]))[0] || null;
}
/** null if this account may capture the stages, else why not. */
function eligibility(u) {
  if (!u) return "Sign in first.";
  if (deps.isStaff(u)) return null;
  if (u.camfrogUsername) return null;
  if ((Number(u.level) || 0) >= MIN_LEVEL) return null;
  return `Snapping and clipping the stage needs a linked Camfrog name (type !verify in a Camfrog room with Pepe) or level ${MIN_LEVEL}.`;
}
// ── switches (1.99cw) ──
// 1.99iu: names the pad's Camfrog room and the chat switch a room mod types there (bridge.snapOffText)
const ROOM_OFF = "Snaps are off in this room (a mod can type !snap on there).";   // fallback wording
/** The admin's switches -> {on, snap, clip} (each kind is on only while the master switch is). */
function switches() {
  let c = {};
  try { c = deps.config() || {}; } catch (e) { c = {}; }
  const on = c.stagecap_enabled !== false;
  return { on, snap: on && c.stagecap_snaps !== false, clip: on && c.stagecap_clips !== false };
}
/** null if the admin lets `kind` (snap | clip | photo) be captured, else why not. */
function killed(kind) {
  const s = switches();
  if (!s.on || (!s.snap && !s.clip)) return "Stage snaps and clips are switched off right now.";
  if (kind === "clip" ? !s.clip : !s.snap) return kind === "clip" ? "Stage clips are switched off right now." : "Stage snaps are switched off right now.";
  return null;
}
/** Does this pad have a Camfrog room (so its !snap switch applies)? */
function camfrogRoom(roomId) {
  try { return !deps.siteOnly(roomId); } catch (e) { return true; }
}
/** null if the pad's Camfrog room lets stage captures through, else why not. */
function roomOff(roomId) {
  if (!roomId || !camfrogRoom(roomId)) return null;
  if (deps.snapSwitch(roomId) === true) return null;
  try { return deps.snapOffText(roomId) || ROOM_OFF; } catch (e) { return ROOM_OFF; }
}

/** The price shown before saving: the room's !snap / !clip price as Pepe reported it, else his default. */
function priceOf(roomId, kind) {
  const c = deps.roomCmds(roomId) || {};
  const k = kind === "clip" ? "!clip" : "!snap";
  return Number.isFinite(c[k]) ? c[k] : PRICES[kind === "clip" ? "clip" : "snap"];
}

/**
 * The stream a viewer asked for -> {source, slot, dir, name, label, nsfw}. Resolved through the
 * registry only: "pepe" or an open slot id of THAT pad.
 */
async function resolveStream(R, stream) {
  const ms = require("./mainstage");
  const s = String(stream || "");
  if (s === "pepe") {
    if (deps.pepeIn(R.id) === false) throw refuse(409, "Pepe's stream isn't on this pad's stage right now.");
    return { source: "pepe", slot: null, dir: PEPE_HLS_DIR, name: PEPE_STREAM, label: "Pepe's stream", nsfw: false };
  }
  if (!/^[A-Za-z0-9-]{8,64}$/.test(s)) throw refuse(400, "Pick a stream on this stage.");
  const slot = await ms.getSlot(s);
  if (!slot || (slot.room_id || require("./rooms").HOUSE_ROOM) !== R.id || !["waiting", "active"].includes(slot.status)) throw refuse(404, "That stream isn't on this stage.");
  if (slot.mode === "embed") throw refuse(409, "YouTube and Twitch streams can't be snapped or clipped here.");
  if (!ms.isLive(slot)) throw refuse(409, "That stream isn't live right now.");
  if (slot.capture_off) throw refuse(403, "This streamer has turned off snaps and clips of their stream.");
  if (!String(slot.stream || "").startsWith(ms.STREAM_PREFIX)) throw refuse(409, "That stream can't be captured.");
  return { source: "slot", slot, dir: HLS_DIR, name: slot.stream, label: slot.displayname || slot.username || "a stream", nsfw: !!slot.nsfw };
}

// ── rate limits ──
const hits = new Map();
function gap(key, ms) {
  const t = NOW(), last = hits.get(key) || 0;
  if (t - last < ms) return Math.ceil((ms - (t - last)) / 1000);
  hits.set(key, t);
  if (hits.size > 5000) for (const [k, v] of hits) if (t - v > 10 * 60e3) hits.delete(k);
  return 0;
}
const auditCtx = new Map();   // capture id -> contentaudit.fromRequest (memory only; used when it's published)

/** Make a preview. -> the capture row. */
async function capture(user, req, { room, stream, kind, secs } = {}) {
  await init();
  const u = await account(user && user.userId);
  const why = eligibility(u);
  if (why) throw refuse(u ? 403 : 401, why);
  const k = kind === "clip" ? "clip" : kind === "snap" ? "snap" : null;
  if (!k) throw refuse(400, "Snap or clip?");
  const off = killed(k);
  if (off) throw refuse(403, off);
  const R = room ? await deps.resolveRoom(String(room).slice(0, 128)) : null;
  if (!R) throw refuse(404, "No such pad.");
  const rOff = roomOff(R.id);
  if (rOff) throw refuse(403, rOff);
  const src = await resolveStream(R, stream);
  const want = k === "clip" ? Math.min(CLIP_MAX, Math.max(CLIP_MIN, Math.round(Number(secs) || CLIP_DEFAULT))) : 0;
  const open = (await getQuery("SELECT COUNT(*) AS n FROM stage_captures WHERE user_id = ? AND state IN ('preview','saving') AND created > ?",
    [u.userId, NOW() - PREVIEW_TTL]))[0].n;
  if (open >= LIMITS.openPreviews) throw refuse(429, "Save or discard your other previews first.");
  const segs = liveSegments(src.dir, src.name, want);       // not live -> refused before any rate limit is used
  const streamKey = src.source + ":" + (src.slot ? src.slot.id : R.id);
  let w = gap(`u:${k}:${u.userId}`, k === "clip" ? LIMITS.userClip : LIMITS.userSnap);
  if (w) throw refuse(429, `Slow down - one ${k} every ${(k === "clip" ? LIMITS.userClip : LIMITS.userSnap) / 1000} s (try again in ${w} s).`);
  w = gap(`s:${k}:${streamKey}`, k === "clip" ? LIMITS.streamClip : LIMITS.streamSnap);
  if (w) { hits.delete(`u:${k}:${u.userId}`); throw refuse(429, `Someone just ${k === "clip" ? "clipped" : "snapped"} this stream - try again in ${w} s.`); }
  const id = "c" + crypto.randomBytes(10).toString("hex");
  const cap = { id, kind: k === "clip" ? "clip" : "photo" };
  const out = previewFile(cap);
  let info;
  try {
    info = k === "clip" ? await extractClip(segs, want, out) : await extractSnap(segs, out);
  } catch (e) {
    try { fs.unlinkSync(out); } catch (_) { /* none */ }
    if (e.refuse) throw e;
    console.error("[stagecap] ffmpeg:", e.message, e.stderr || "");
    throw refuse(502, `Couldn't ${k} that stream just now - nothing was charged.`);
  }
  if (k === "clip" && info.secs < CLIP_MIN - 0.5) { try { fs.unlinkSync(out); } catch (_) { /* none */ } throw refuse(409, "Not enough of that stream yet to clip - try again in a few seconds."); }
  const t = NOW();
  await runQuery(`INSERT INTO stage_captures (id, user_id, username, room_id, source, slot_id, stream_label, kind, ct, secs, bytes, nsfw, state, created, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?)`,
    [id, u.userId, u.username, R.id, src.source, src.slot ? src.slot.id : null, String(src.label).slice(0, 60), cap.kind,
     cap.kind === "clip" ? "video/mp4" : "image/webp", info.secs || 0, info.bytes, src.nsfw ? 1 : 0, t, t]);
  if (req) { try { auditCtx.set(id, require("./contentaudit").fromRequest(req)); } catch (e) { /* none */ } }
  console.log(`[stagecap] preview ${id} ${cap.kind} room=${R.id} stream=${src.source}${src.slot ? ":" + src.slot.id : ""} by=${u.username} bytes=${info.bytes}`);
  return { ...(await row(id)), price: priceOf(R.id, k) };
}

async function row(id) { return (await getQuery("SELECT * FROM stage_captures WHERE id = ?", [String(id || "")]))[0] || null; }
function view(c, price) {
  if (!c) return null;
  const live = c.state === "preview" || c.state === "saving";
  return { id: c.id, kind: c.kind, state: c.state, secs: c.secs || 0, stream: c.stream_label, source: c.source, nsfw: !!c.nsfw,
           preview: live ? "/api/stage/captures/" + c.id + "/preview" : null, url: c.media_id ? "/media/" + c.media_id : null,
           message: c.message || null, expires: live ? c.created + PREVIEW_TTL : null, price: price == null ? priceOf(c.room_id, c.kind === "clip" ? "clip" : "snap") : price };
}

/** Save a preview: queue the website action Pepe charges and publishes. */
async function save(user, id, idem) {
  await init();
  const c = await row(id);
  if (!c || c.user_id !== (user && user.userId)) throw refuse(404, "That isn't a capture you made.");
  if (c.state === "saving" || c.state === "done") return c;
  if (c.state !== "preview" || NOW() - c.created > PREVIEW_TTL || !fs.existsSync(previewFile(c))) throw refuse(410, "That preview expired - take a fresh one.");
  const u = await account(c.user_id);
  const why = eligibility(u);
  if (why) throw refuse(403, why);
  const off = killed(c.kind) || roomOff(c.room_id);
  if (off) throw refuse(403, off);
  const actions = require("./actions");
  let aid;
  try {
    aid = await actions.queue(c.user_id, { kind: "stagecap.save", args: [c.room_id, c.id, c.kind === "clip" ? "clip" : "snap"], tag: "stagecap",
      label: `📺 stage ${c.kind === "clip" ? "clip" : "snap"} of ${c.stream_label}`, idem });
  } catch (e) {
    if (e.message === "duplicate" && e.actionId) aid = e.actionId;
    else if (e.message === "busy") throw refuse(429, "You already have a few things waiting for Pepe - give him a moment.");
    else throw e;
  }
  await runQuery("UPDATE stage_captures SET state = 'saving', action_id = ?, message = NULL, updated = ? WHERE id = ? AND state = 'preview'", [aid, NOW(), c.id]);
  return row(c.id);
}

/** The status a page polls. A failed Pepe action puts the capture back to "preview" (retry until it expires). */
async function status(user, id) {
  await init();
  let c = await row(id);
  if (!c || c.user_id !== (user && user.userId)) throw refuse(404, "That isn't a capture you made.");
  if (c.state === "saving" && c.action_id) {
    const a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ?", [c.action_id]))[0];
    if (a && a.status === "failed") {
      const still = NOW() - c.created < PREVIEW_TTL && fs.existsSync(previewFile(c));
      await runQuery("UPDATE stage_captures SET state = ?, message = ?, updated = ? WHERE id = ? AND state = 'saving'",
        [still ? "preview" : "failed", String(a.message || "Pepe couldn't save it.").slice(0, 300), NOW(), c.id]);
      if (!still) dropPreview(c);
      c = await row(id);
    }
  }
  return c;
}

function dropPreview(c) { try { fs.unlinkSync(previewFile(c)); } catch (e) { /* gone */ } }

async function discard(user, id) {
  await init();
  const c = await row(id);
  if (!c || c.user_id !== (user && user.userId)) throw refuse(404, "That isn't a capture you made.");
  if (c.state !== "preview") throw refuse(409, c.state === "saving" ? "That one is already with Pepe." : "Nothing to discard.");
  dropPreview(c);
  await runQuery("UPDATE stage_captures SET state = 'discarded', updated = ? WHERE id = ? AND state = 'preview'", [NOW(), c.id]);
  auditCtx.delete(c.id);
  return true;
}

// ── Pepe's side (bot token) ──
/** Before charging: is the capture still here, and whose? */
async function check(id, username) {
  await init();
  const c = await row(id);
  if (!c || !CID_RE.test(c.id) || c.username !== String(username || "") || c.state !== "saving") return null;
  if (NOW() - c.created > SAVE_TTL || !fs.existsSync(previewFile(c))) return null;
  return c;
}

/** After charging: the capture becomes a media row. Idempotent (a retried publish gets the same answer). */
async function publish(id, username, { hours, byAnon, by } = {}) {
  await init();
  const c0 = await row(id);
  if (c0 && c0.state === "done" && c0.username === String(username || "") && c0.media_id) {
    const m = (await getQuery("SELECT expires FROM media WHERE id = ?", [c0.media_id]))[0];
    return { media_id: c0.media_id, expires: m ? m.expires : null, again: true };
  }
  const c = await check(id, username);
  if (!c) return null;
  if (killed(c.kind)) return null;                // switched off since Pepe's check: he refunds
  const mid = crypto.randomBytes(12).toString("hex");
  const ext = c.kind === "clip" ? ".mp4" : ".webp";
  const file = mid + ext;
  const t = NOW();
  const h = Math.min(720, Math.max(1, Number(hours) || 24));
  const expires = t + h * 3600e3;
  const u = await account(c.user_id);
  const byName = byAnon ? "someone" : String(by || (u && (u.displayname || u.username)) || c.username || "someone").slice(0, 60);
  fs.renameSync(previewFile(c), path.join(media.DIR, file));
  try {
    await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, stream, nsfw, by_user_id, slot_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'stage', ?, ?, ?, ?)`,
      [mid, c.kind, c.ct, file, c.bytes, c.secs || 0, String(c.stream_label || "").slice(0, 60), byName, c.room_id, t, expires,
       c.source === "pepe" ? "pepe" : "slot:" + c.slot_id, c.nsfw ? 1 : 0, c.user_id, c.slot_id || null]);
  } catch (e) {
    try { fs.renameSync(path.join(media.DIR, file), previewFile(c)); } catch (_) { /* gone */ }
    throw e;
  }
  await runQuery("UPDATE stage_captures SET state = 'done', media_id = ?, updated = ? WHERE id = ?", [mid, t, c.id]);
  try {
    const audit = require("./contentaudit");
    await audit.record(auditCtx.get(c.id) || {}, { kind: "capture", id: mid, event: "create", user: u });
  } catch (e) { /* never fails a publish */ }
  auditCtx.delete(c.id);
  console.log(`[stagecap] published ${c.id} -> media ${mid} (${c.kind}, room ${c.room_id}, by ${c.username})`);
  // 1.99dq: a clip's poster frame, the same helper Pepe's uploads use (ffmpeg job queue); snaps are their own picture
  if (c.kind === "clip") media.makePoster({ id: mid, kind: "clip", file, secs: c.secs || 0 }).catch(() => {});
  return { media_id: mid, expires };
}

// ── deleting a published stage capture ──
async function canDelete(user, m) {
  if (!user || !user.userId || !m) return false;
  if (deps.isStaff(user)) return true;
  if (m.room && (await deps.canManage(user, m.room))) return true;
  // 1.99ez: a member's own story upload (userstories.js): the uploader, or a mod of the pad's Camfrog room
  if (m.source === "user") {
    if (m.by_user_id && m.by_user_id === user.userId) return true;
    if (!m.room) return false;
    const acct = user.camfrogUsername !== undefined ? user : await require("./feedstore").account(user.userId).catch(() => null);
    return !!acct && require("./storykeep").isPadMod(acct, m.room);
  }
  if (m.source !== "stage") return false;
  if (m.by_user_id && m.by_user_id === user.userId) return true;
  if (m.slot_id) {
    const s = await require("./mainstage").getSlot(m.slot_id);
    if (s && s.userId === user.userId) return true;
  }
  return false;
}
async function remove(user, mediaId) {
  await init();
  if (!/^[a-f0-9]{8,32}$/i.test(String(mediaId || ""))) throw refuse(404, "No such capture.");
  const m = (await getQuery("SELECT * FROM media WHERE id = ? AND deleted = 0", [String(mediaId)]))[0];
  if (!m) throw refuse(404, "No such capture.");
  if (!(await canDelete(user, m))) {
    throw refuse(403, m.source === "user" ? "Only the person who posted this story, the pad's owner or mods, or an admin can remove it."
      : "Only the pad's owner, an admin, the person who took it or the streamer can delete this.");
  }
  try { fs.unlinkSync(path.join(media.DIR, m.file)); } catch (e) { /* gone */ }
  media.removePoster(m.id);
  await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [m.id]);
  // 1.99eq: Saved copies go with it; a post of it is hidden unless the capturer deleted their own capture (storykeep.js)
  await require("./storykeep").onCaptureRemoved(m.id, { reason: "removed", byCapturer: !!m.by_user_id && m.by_user_id === user.userId })
    .catch((e) => console.error("[stagecap] keep cascade:", e.message));
  console.log(`[stagecap] media ${m.id} deleted by ${user.username || user.userId}`);
  return true;
}

// ── a slot's capture settings (its streamer; the pad's managers too) ──
async function slotSettings(user, slotId, { allow, nsfw } = {}) {
  await init();
  const ms = require("./mainstage");
  const s = await ms.getSlot(String(slotId || ""));
  if (!s) throw refuse(404, "No such slot.");
  const mine = !!user && s.userId === user.userId;
  const manager = !!user && (await deps.canManage(user, s.room_id || require("./rooms").HOUSE_ROOM));
  if (!mine && !manager) throw refuse(403, "That isn't your slot.");
  if (allow !== undefined) await runQuery("UPDATE stage_slots SET capture_off = ? WHERE id = ?", [allow ? 0 : 1, s.id]);
  if (nsfw !== undefined) await runQuery("UPDATE stage_slots SET nsfw = ? WHERE id = ?", [nsfw ? 1 : 0, s.id]);
  try { ms._pubCache.clear(); } catch (e) { /* none */ }
  const r = await ms.getSlot(s.id);
  return { capture: !r.capture_off, nsfw: !!r.nsfw };
}

// ── the captures feed ──
async function feed({ roomId = null, before = null, limit = 30, withUid = false } = {}) {
  await init();
  const where = ["deleted = 0", "source = 'stage'", "expires > ?"], args = [NOW()];
  if (roomId) { where.push("room = ?"); args.push(roomId); }
  if (before) { where.push("created < ?"); args.push(Number(before)); }
  const rows = await getQuery(`SELECT * FROM media WHERE ${where.join(" AND ")} ORDER BY created DESC LIMIT ?`, [...args, Math.min(60, limit)]);
  const items = await require("./stories").clean(rows);
  if (withUid) {
    // 1.99en: the server-rendered page links "by <name>" through the account that SAVED it (media.by_user_id),
    // never by matching the shown name (a Camfrog display name / PATV name) against Camfrog logins.
    // Not in the JSON API (no user ids out); an anonymous save ("someone") has no link.
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const it of items) {
      const r = byId.get(it.id);
      it.byUid = r && it.by && !/^someone$/i.test(String(r.by_user || "").trim()) && r.by_user_id ? String(r.by_user_id) : null;
    }
  }
  return items;
}

// ── housekeeping ──
async function sweep() {
  await init();
  const t = NOW();
  const old = await getQuery("SELECT * FROM stage_captures WHERE state IN ('preview','saving') AND created < ?", [t - SAVE_TTL]);
  for (const c of old) {
    dropPreview(c);
    await runQuery("UPDATE stage_captures SET state = 'expired', updated = ? WHERE id = ?", [t, c.id]);
    auditCtx.delete(c.id);
  }
  const stale = await getQuery("SELECT * FROM stage_captures WHERE state = 'preview' AND created < ?", [t - PREVIEW_TTL]);
  for (const c of stale) { dropPreview(c); await runQuery("UPDATE stage_captures SET state = 'expired', updated = ? WHERE id = ?", [t, c.id]); }
  // stray files (a crash between ffmpeg and the insert)
  try {
    for (const f of fs.readdirSync(tmpDir())) {
      const p = path.join(tmpDir(), f);
      try { if (t - fs.statSync(p).mtimeMs > SAVE_TTL + 60e3) fs.unlinkSync(p); } catch (e) { /* raced */ }
    }
  } catch (e) { /* no dir */ }
  await runQuery("DELETE FROM stage_captures WHERE created < ? AND state != 'done'", [t - 30 * 86400e3]).catch(() => {});
  return old.length + stale.length;
}

// ── routes ──
function register(app, { addUser, isBotToken, noTimers }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  const express = require("express");
  const json = express.json({ limit: "8kb" });
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const guard = (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[stagecap]", e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const noStore = (res) => { res.set("Cache-Control", "private, no-store"); res.set("X-Robots-Tag", "noindex"); };

  // what the capture bar needs: may I, and at what price
  app.get("/api/stage/captures/me", addUser, async (req, res) => {
    noStore(res);
    try {
      await init();
      const u = req.user && req.user.userId ? await account(req.user.userId) : null;
      const R = req.query.room ? await deps.resolveRoom(String(req.query.room).slice(0, 128)) : null;
      const why = eligibility(u);
      const sw = switches();
      res.json({ ok: true, signed: !!u, eligible: !why, why: u ? why : null, clip: { def: CLIP_DEFAULT, max: CLIP_MAX, min: CLIP_MIN },
                 prices: { snap: priceOf(R ? R.id : null, "snap"), clip: priceOf(R ? R.id : null, "clip") },
                 // 1.99cw: the admin's switches (off -> hidden) and the pad's Camfrog room's !snap switch (off -> greyed)
                 enabled: { snap: sw.snap, clip: sw.clip }, room_off: R ? roomOff(R.id) : null });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/stage/capture", addUser, guard, json, async (req, res) => {
    noStore(res);
    try {
      const b = req.body || {};
      // 1.99fu: an Approved pad's stage can only be snapped / clipped from inside it
      if (b.room) {
        const PA = require("./padaccess");
        await PA.init();
        const R = await deps.resolveRoom(String(b.room).slice(0, 128));
        if (R && !PA.canSee(req.user, R.id)) return res.status(404).json({ ok: false, error: "No such pad." });
      }
      const c = await capture(req.user, req, { room: b.room, stream: b.stream, kind: b.kind, secs: b.secs });
      res.json({ ok: true, capture: view(c, c.price) });
    } catch (e) { fail(res, e); }
  });
  app.get("/api/stage/captures/:id/preview", addUser, async (req, res) => {
    noStore(res);
    try {
      await init();
      const c = await row(req.params.id);
      if (!req.user || !c || c.user_id !== req.user.userId || !["preview", "saving"].includes(c.state)) return res.status(404).send("Not found.");
      const p = previewFile(c);
      if (!fs.existsSync(p)) return res.status(410).send("Expired.");
      res.set("X-Content-Type-Options", "nosniff");
      res.set("Content-Security-Policy", "default-src 'none'; sandbox");
      res.type(c.ct);
      res.sendFile(p, { acceptRanges: true });
    } catch (e) { res.status(500).send("Error."); }
  });
  app.get("/api/stage/captures/:id", addUser, async (req, res) => {
    noStore(res);
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, capture: view(await status(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/captures/:id/save", addUser, guard, json, async (req, res) => {
    noStore(res);
    try { res.json({ ok: true, capture: view(await save(req.user, req.params.id, (req.body || {}).idem)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/captures/:id/discard", addUser, guard, json, async (req, res) => {
    try { await discard(req.user, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/captures/media/:mid/delete", addUser, guard, json, async (req, res) => {
    try { await remove(req.user, req.params.mid); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/slots/:id/capture", addUser, guard, json, async (req, res) => {
    const b = req.body || {};
    const tf = (v) => (v === undefined ? undefined : v === true || v === 1 || v === "1" || v === "on" || v === "true");
    try { res.json({ ok: true, ...(await slotSettings(req.user, req.params.id, { allow: tf(b.allow), nsfw: tf(b.nsfw) })) }); } catch (e) { fail(res, e); }
  });

  // Pepe: before charging, and after
  app.post("/api/stage/captures/check", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const c = await check(b.id, b.user);
      if (!c) return res.status(404).json({ ok: false, error: "gone" });
      const off = killed(c.kind);
      if (off) return res.status(403).json({ ok: false, error: "disabled", message: off });
      // camfrog_room: Pepe applies the room's !snap switch only to pads with a Camfrog room (1.99cw);
      // nsfw: his room announcement then says only "an NSFW snap / clip"
      res.json({ ok: true, kind: c.kind === "clip" ? "clip" : "snap", room: c.room_id, stream: c.stream_label, source: c.source, secs: c.secs || 0,
                 nsfw: !!c.nsfw, camfrog_room: camfrogRoom(c.room_id) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/captures/publish", json, async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const r = await publish(b.id, b.user, { hours: b.hours, byAnon: b.by_anon === true, by: b.by });
      if (!r) return res.status(410).json({ ok: false, error: "gone" });
      res.json({ ok: true, url: "/media/" + r.media_id, id: r.media_id, expires: r.expires });
    } catch (e) { fail(res, e); }
  });

  // the captures feed: a page + its JSON (members only, like every capture)
  app.get("/api/stage/captures", addUser, async (req, res) => {
    noStore(res);
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to see captures." });
    try {
      const R = req.query.pad ? await deps.resolveRoom(String(req.query.pad).slice(0, 128)) : null;
      // 1.99fu: an Approved pad's captures are only for the people inside it (padaccess.js)
      const PA = require("./padaccess");
      await PA.init();
      if (R && !PA.canSee(req.user, R.id)) return res.json({ ok: true, items: [] });
      res.json({ ok: true, items: PA.visibleRows(req.user, await feed({ roomId: R ? R.id : null, before: Number(req.query.before) || null }), "room") });
    } catch (e) { fail(res, e); }
  });
  app.get("/stage/captures", addUser, async (req, res) => {
    noStore(res);
    try {
      await init();
      const signed = !!(req.user && req.user.userId);
      // 1.99fu: an Approved pad's captures are only for the people inside it (padaccess.js)
      const PA = require("./padaccess");
      await PA.init();
      let R = req.query.pad ? await deps.resolveRoom(String(req.query.pad).slice(0, 128)) : null;
      const hidden = !!(R && !PA.canSee(req.user, R.id));
      const items = signed && !hidden ? PA.visibleRows(req.user, await feed({ roomId: R ? R.id : null, limit: 60, withUid: true }), "room") : [];
      if (hidden) R = null;
      let titles = {};
      try { const rooms = require("./rooms"); for (const it of items) { const x = rooms.getCached(it.room); titles[it.room] = x ? { title: x.title, slug: require("./roomsweb").linkSlug(x) } : { title: it.room, slug: it.room }; } } catch (e) { titles = {}; }
      res.render("stageCaptures", { user: req.user ? req.user.username : null, signed, items, titles, pad: R ? { title: R.title, slug: R.slug } : null });
    } catch (e) { console.error("[stagecap] page:", e); res.status(500).send("Something went wrong."); }
  });

  if (!noTimers) {
    const t = setInterval(() => sweep().catch((e) => console.error("[stagecap] sweep:", e.message)), 60 * 1000);
    t.unref();
  }
}

module.exports = {
  register, init, capture, save, status, discard, check, publish, remove, canDelete, slotSettings, feed, sweep, eligibility, priceOf,
  switches, killed, roomOff, ROOM_OFF,
  playlistPath, liveSegments, extractSnap, extractClip, resolveStream, view, PRICES, LIMITS, CLIP_MAX, CLIP_DEFAULT, PREVIEW_TTL, SAVE_TTL, MIN_LEVEL,
  _setDeps, _setDirs, _setClock: (fn) => { NOW = fn || (() => Date.now()); }, _hits: hits,
};
