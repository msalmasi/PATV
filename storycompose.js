// storycompose.js — versioned Story Studio edits, applied inside the existing hostile-upload pipeline.
// The browser declares crop/trim and draws text/stickers into one transparent overlay; preflight and
// posting validate the declared words and ownership. Pixels are never trusted or served unchanged:
// pictures first use feedmedia's decoder, video is encoded once with local-only inputs, and the final
// composite goes through the existing story safety hook. Mentions are separate data, never pixels.
// 1.99alq train3 verify - a design limit, on purpose: the word filter and the sticker ownership check read only what the edit
// DECLARES (its texts, its sticker ids). The overlay's pixels come from the browser, so a modified client can draw any words, or
// sticker art it doesn't own, into the layer; only the image-safety check (the story safety hook, on the composed result) sees
// what was drawn. Moderation of a story's drawn words is the report / remove path, as for any picture.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const media = require("./feedmedia");
const { getQuery, runQuery } = require("./dbUtils");
const ID_RE = /^[a-f0-9]{24}$/, RATIO = 9 / 16, TOLERANCE = 1e-6;
class Refuse extends Error { constructor(status, message) { super(message); this.status = status; this.refuse = true; } }
const limits = () => require("./userstories"); // lazy: userstories also uses this module for preflight
const object = v => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finite = v => typeof v === "number" && Number.isFinite(v);
function keys(value, allowed, message) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Refuse(400, message);
}
function cleanEdit(raw, { kind } = {}) {
  const L = limits();
  keys(raw, ["v", "pad", "fit", "crop", "trim", "overlay", "text", "stickers"], "That story edit has unsupported fields.");
  if (raw.v !== 1) throw new Refuse(400, "That story edit version isn't supported.");
  if (kind !== "image" && kind !== "video") throw new Refuse(400, "Only pictures and videos can be edited as stories.");
  if (typeof raw.pad !== "string" || !raw.pad.trim() || raw.pad.length > 160 || /[\x00-\x1f\x7f-\x9f]/.test(raw.pad))
    throw new Refuse(400, "Choose a destination for the story.");
  if (raw.fit !== "fill" && raw.fit !== "fit") throw new Refuse(400, "Choose crop or fit for the story.");
  const edit = { v: 1, pad: raw.pad.trim(), fit: raw.fit };
  if (raw.fit === "fill") {
    keys(raw.crop, ["x", "y", "w", "h"], "Choose a valid crop for the story.");
    const c = raw.crop;
    if (![c.x, c.y, c.w, c.h].every(finite) || c.x < 0 || c.y < 0 || c.w < 0.05 || c.h < 0.05 || c.x + c.w > 1 + TOLERANCE || c.y + c.h > 1 + TOLERANCE)
      throw new Refuse(400, "The crop must stay inside the picture and be at least five percent wide and tall.");
    edit.crop = { x: c.x, y: c.y, w: Math.min(c.w, 1 - c.x), h: Math.min(c.h, 1 - c.y) };
  } else if (Object.hasOwn(raw, "crop")) throw new Refuse(400, "Fit uses the whole picture, so it can't include a crop.");
  if (Object.hasOwn(raw, "trim")) {
    if (kind !== "video") throw new Refuse(400, "Only videos can be trimmed.");
    keys(raw.trim, ["start", "end"], "Choose a valid video trim.");
    const { start, end } = raw.trim;
    if (!finite(start) || !finite(end) || start < 0 || end <= start || end - start < 1 || end - start > L.STORY_MAX_SECS + 0.5)
      throw new Refuse(400, "Choose between 1 and 30 seconds of video.");
    edit.trim = { start, end };
  }
  if (Object.hasOwn(raw, "overlay")) {
    if (typeof raw.overlay !== "string" || !ID_RE.test(raw.overlay)) throw new Refuse(400, "That story overlay isn't valid.");
    edit.overlay = raw.overlay;
  }
  const text = raw.text === undefined ? [] : raw.text;
  if (!Array.isArray(text) || text.length > L.STORY_TEXTS_MAX) throw new Refuse(400, "A story can have up to three text layers.");
  edit.text = text.map(line => {
    if (typeof line !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(line) || !line.trim() || Array.from(line.trim()).length > L.STORY_TEXT_LEN)
      throw new Refuse(400, "Each text layer needs 1 to 120 characters without control characters.");
    return line.trim();
  });
  const stickers = raw.stickers === undefined ? [] : raw.stickers;
  if (!Array.isArray(stickers) || stickers.length > L.STORY_STICKERS_MAX) throw new Refuse(400, "A story can have up to ten stickers.");
  const catalog = require("./stickers").CAT;
  edit.stickers = stickers.map(sticker => {
    keys(sticker, ["pack", "sticker"], "That story sticker isn't available.");
    if (typeof sticker.pack !== "string" || typeof sticker.sticker !== "string" || !/^[a-z0-9]{1,32}$/.test(sticker.pack) || !/^[a-z0-9]{1,32}$/.test(sticker.sticker))
      throw new Refuse(400, "That story sticker isn't available.");
    const pack = Object.hasOwn(catalog.byId, sticker.pack) ? catalog.byId[sticker.pack] : null;
    if (!pack || !Object.hasOwn(pack.byId, sticker.sticker)) throw new Refuse(400, "That story sticker isn't available.");
    return { pack: sticker.pack, sticker: sticker.sticker };
  });
  return edit;
}

/** Read-only preflight. Processing repeats this check and atomically claims the row. */
async function overlayCheck(ownerId, id) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Refuse(400, "That story overlay isn't valid.");
  const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [id]))[0];
  if (!row || row.owner_id !== ownerId || row.purpose !== "story_ovl" || row.post_id != null)
    throw new Refuse(400, "Choose your own ready story overlay.");
  if (row.state === "deleted" && row.error === "used for a story") throw new Refuse(400, "That overlay was already used.");
  if (row.state !== "ready" || row.kind !== "image" || !media.filePath(row.file)) throw new Refuse(400, "Choose your own ready story overlay.");
  return row;
}
function shape(edit, w, h) {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new media.MediaError("That picture's size couldn't be read.");
  if (edit.fit === "fill" && Math.abs((w * edit.crop.w / (h * edit.crop.h)) / RATIO - 1) > 0.02)
    throw new media.MediaError("The crop must have the story's 9:16 shape.");
}
function outputNames(ext) {
  const base = crypto.randomBytes(16).toString("hex");
  const folder = path.join(media.dir(), base.slice(0, 2)); fs.mkdirSync(folder, { recursive: true });
  return { base, folder, file: base + ext, thumb: base + "_t.webp", poster: base + "_p.webp" };
}
function removeOutput(out) { if (out) media.removeFiles([out.file, out.thumb, out.poster]); }
async function displayedVideoSize(input, sn, pr) {
  let result;
  try {
    // 1.99alq: -show_streams, not -show_entries stream_side_data=...: the VPS's ffprobe 4.2 has no "stream_side_data" section
    // name (ffprobe 5+ added it), so that option failed to parse there and every edited video was refused. Both versions put
    // the "rotate" tag and the display matrix's "rotation" in the stream entry read below.
    result = await media.run(media.bin("ffprobe"), ["-v", "error", "-protocol_whitelist", "file", "-f", sn.ffmt,
      "-select_streams", "v:0", "-show_streams", "-of", "json", input], { timeoutMs: 30000 });
    result = JSON.parse(result.out || "{}");
  } catch (_) { throw new media.MediaError("That video's rotation couldn't be read."); }
  const stream = Array.isArray(result.streams) ? result.streams[0] || {} : {};
  const matrix = (stream.side_data_list || []).find(x => finite(x.rotation));
  const rotation = matrix ? matrix.rotation : Number(stream.tags && stream.tags.rotate) || 0;
  const quarterTurn = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  return quarterTurn ? { w: Number(pr.video.height), h: Number(pr.video.width) } : { w: Number(pr.video.width), h: Number(pr.video.height) };
}
// story camera (1.99alu): a video's length from the end of its last packet, for a file whose header has none. Demuxing only (no
// decoding), the first video stream, the demuxer forced and local files only, as everywhere here; the ffprobe 4.2 on the VPS knows
// every option used. -> seconds (ms precision), 0 when no packet has a time.
async function packetSecs(input, ffmt) {
  const r = await media.run(media.bin("ffprobe"), ["-v", "error", "-protocol_whitelist", "file", "-f", ffmt, "-select_streams", "v:0",
    "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", input], { timeoutMs: 30000, maxOut: 8 * 1024 * 1024 });
  let end = 0;
  for (const line of String((r && r.out) || "").split(/\r?\n/)) {
    const [pts, dur] = line.split(","), at = Number(pts) + (Number(dur) || 0);
    if (Number.isFinite(at) && at > end) end = at;
  }
  return Math.round(end * 1000) / 1000;
}
async function picture(input, sn, edit, overlay) {
  const L = limits(), sharp = require("sharp");
  let intermediate = null, out = null;
  try {
    intermediate = await media.processImage(input, sn.fmt);
    if (intermediate.animated) throw new media.MediaError("Animated pictures can't be edited yet - post it as it is.");
    shape(edit, intermediate.w, intermediate.h);
    let image = sharp(fs.readFileSync(media.filePath(intermediate.file)));
    if (edit.fit === "fill") {
      const c = edit.crop, left = Math.round(c.x * intermediate.w), top = Math.round(c.y * intermediate.h);
      image = image.extract({ left, top, width: Math.min(Math.round(c.w * intermediate.w), intermediate.w - left), height: Math.min(Math.round(c.h * intermediate.h), intermediate.h - top) })
        .resize(L.STORY_W, L.STORY_H);
    } else image = image.resize(L.STORY_W, L.STORY_H, { fit: "contain", background: "#000" });
    if (overlay) image = image.composite([{ input: overlay, left: 0, top: 0 }]);
    const buffer = await image.webp({ quality: 82 }).toBuffer();
    out = outputNames(".webp");
    await fs.promises.writeFile(media.filePath(out.file), buffer, { flag: "wx" });
    await sharp(buffer).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toFile(media.filePath(out.thumb));
    return { kind: "image", ct: "image/webp", file: out.file, thumb: out.thumb, poster: null, w: L.STORY_W, h: L.STORY_H, secs: 0,
      bytes: fs.statSync(media.filePath(out.file)).size + fs.statSync(media.filePath(out.thumb)).size };
  } catch (e) { removeOutput(out); throw e; }
  finally { removeOutput(intermediate); }
}
async function video(input, sn, edit, overlay, caps, work) {
  const L = limits(), sharp = require("sharp");
  if (!sn.ffmt) throw new media.MediaError("That video type isn't supported.");
  const pr = await media.probe(input, sn.ffmt).catch(() => null);
  if (!pr || !pr.video) throw new media.MediaError("A story needs a video track, not audio alone.");
  // story camera (1.99alu): a browser recording (MediaRecorder WebM, some fragmented MP4) can carry no length in its header
  if (!Number.isFinite(pr.secs) || pr.secs <= 0) pr.secs = await packetSecs(input, sn.ffmt).catch(() => 0);
  if (!Number.isFinite(pr.secs) || pr.secs <= 0) throw new media.MediaError("That video's length couldn't be read.");
  const sourceCap = Math.min(L.STORY_SRC_MAX_SECS, Number(caps.max_video_secs) || L.STORY_SRC_MAX_SECS);
  if (pr.secs > sourceCap) throw new media.MediaError("The source video is too long for a story edit.");
  if (Number(pr.video.width) * Number(pr.video.height) > 8192 * 8192) throw new media.MediaError("That video's frame size is too big.");
  if (edit.trim && edit.trim.end > pr.secs + 0.5) throw new media.MediaError("The trim goes past the end of the video.");
  if (!edit.trim && pr.secs > L.STORY_MAX_SECS + 0.5) throw new media.MediaError("Trim it to 30 seconds.");
  const size = await displayedVideoSize(input, sn, pr); shape(edit, size.w, size.h);
  const start = edit.trim ? edit.trim.start : 0, duration = edit.trim ? edit.trim.end - start : pr.secs;
  const out = outputNames(".mp4"), outPath = media.filePath(out.file);
  let png = null;
  if (overlay) { png = path.join(work, "overlay.png"); await sharp(overlay).resize(L.STORY_VIDEO_W, L.STORY_VIDEO_H).png().toFile(png); }
  const vf = edit.fit === "fill"
    ? `crop=iw*${edit.crop.w}:ih*${edit.crop.h}:iw*${edit.crop.x}:ih*${edit.crop.y},scale=${L.STORY_VIDEO_W}:${L.STORY_VIDEO_H},setsar=1`
    : `scale=${L.STORY_VIDEO_W}:${L.STORY_VIDEO_H}:force_original_aspect_ratio=decrease,pad=${L.STORY_VIDEO_W}:${L.STORY_VIDEO_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  const args = ["-hide_banner", "-nostdin", "-v", "error", "-ss", String(start), "-t", String(duration),
    "-protocol_whitelist", "file", "-f", sn.ffmt, "-i", input];
  if (png) args.push("-protocol_whitelist", "file", "-f", "image2", "-i", png);
  args.push("-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-threads", "4");
  if (png) args.push("-filter_complex", `[0:v:0]${vf}[base];[base][1:v:0]overlay=0:0[v]`, "-map", "[v]", "-map", "0:a:0?");
  else args.push("-map", "0:v:0", "-map", "0:a:0?", "-vf", vf);
  args.push("-t", String(duration), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", "-y", outPath);
  const release = await media.slot();
  try {
    await media.run(media.bin("ffmpeg"), args);
    const result = await media.probe(outPath, "mov").catch(() => null);
    if (!result || !result.video || !result.secs || result.secs > L.STORY_MAX_SECS + 0.5) throw new media.MediaError("The finished story must be at most 30 seconds.");
    if (Number(result.video.width) !== L.STORY_VIDEO_W || Number(result.video.height) !== L.STORY_VIDEO_H) throw new media.MediaError("The finished story has the wrong picture size.");
    const posterPng = path.join(work, "poster.png");
    try {
      await media.run(media.bin("ffmpeg"), ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-ss", String(Math.min(1, result.secs / 2)),
        "-f", "mov", "-i", outPath, "-frames:v", "1", "-y", posterPng], { timeoutMs: 30000 });
      await sharp(fs.readFileSync(posterPng)).resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toFile(media.filePath(out.poster));
    } catch (_) { /* the viewer can use the video's first frame when no poster can be made */ }
    const poster = fs.existsSync(media.filePath(out.poster)) ? out.poster : null;
    return { kind: "video", ct: "video/mp4", file: out.file, thumb: null, poster, w: L.STORY_VIDEO_W, h: L.STORY_VIDEO_H,
      secs: Math.round(result.secs * 10) / 10, bytes: fs.statSync(outPath).size + (poster ? fs.statSync(media.filePath(poster)).size : 0) };
  } catch (e) { removeOutput(out); throw e; }
  finally { release(); }
}
async function process(input, sn, attachment, caps = {}) {
  let edit;
  try { edit = cleanEdit(typeof attachment.edit === "string" ? JSON.parse(attachment.edit) : attachment.edit, { kind: attachment.kind }); }
  catch (e) { throw new media.MediaError(e.refuse ? e.message : "That story edit couldn't be read."); }
  let overlay = null, claimed = null, work = null;
  try {
    if (edit.overlay) {
      const row = await overlayCheck(attachment.owner_id, edit.overlay);
      const used = await runQuery("UPDATE feed_attachments SET state = 'deleted', error = 'used for a story' WHERE id = ? AND state = 'ready' AND post_id IS NULL AND owner_id = ? AND purpose = 'story_ovl'", [row.id, attachment.owner_id]);
      if (!used.changes) throw new media.MediaError("That overlay was already used.");
      claimed = row;
      overlay = fs.readFileSync(media.filePath(row.file));
      const meta = await require("sharp")(overlay).metadata(), L = limits();
      if (meta.format !== "webp" || meta.width !== L.STORY_W || meta.height !== L.STORY_H || (meta.pages || 1) > 1)
        throw new media.MediaError("The overlay must be 1080 × 1920.");
    }
    if (sn.kind === "image" && attachment.kind === "image") return await picture(input, sn, edit, overlay);
    if (attachment.kind !== "video" || sn.kind === "image" || sn.bad) throw new media.MediaError("That source isn't a story picture or video.");
    work = fs.mkdtempSync(path.join(media.dir(), "tmp", "story-"));
    return await video(input, sn, edit, overlay, caps, work);
  } catch (e) {
    if (e && e.refuse) throw new media.MediaError(e.message, e.status);
    throw new media.MediaError("That story couldn't be composed. Try again.");
  } finally {
    removeOutput(claimed);
    if (work && path.dirname(path.resolve(work)) === path.resolve(media.dir(), "tmp")) fs.rmSync(work, { recursive: true, force: true });
  }
}
module.exports = { cleanEdit, overlayCheck, process, packetSecs, Refuse };
