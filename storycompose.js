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
  keys(raw, ["v", "pad", "fit", "crop", "frame", "trim", "overlay", "text", "stickers", "camera"], "That story edit has unsupported fields.");
  if (raw.v !== 1) throw new Refuse(400, "That story edit version isn't supported.");
  if (kind !== "image" && kind !== "video") throw new Refuse(400, "Only pictures and videos can be edited as stories.");
  if (typeof raw.pad !== "string" || !raw.pad.trim() || raw.pad.length > 160 || /[\x00-\x1f\x7f-\x9f]/.test(raw.pad))
    throw new Refuse(400, "Choose a destination for the story.");
  if (raw.fit !== "fill" && raw.fit !== "fit") throw new Refuse(400, "Choose crop or fit for the story.");
  const edit = { v: 1, pad: raw.pad.trim(), fit: raw.fit };
  if (raw.fit === "fill") {
    keys(raw.crop, ["x", "y", "w", "h"], "Choose a valid crop for the story.");
    const c = raw.crop;
    // storyux verify: five percent with the float tolerance the frame has - the editor's deepest pinch on a tall picture computes
    // a side of 0.049999999999999996
    if (![c.x, c.y, c.w, c.h].every(finite) || c.x < 0 || c.y < 0 || c.w < 0.05 - TOLERANCE || c.h < 0.05 - TOLERANCE || c.x + c.w > 1 + TOLERANCE || c.y + c.h > 1 + TOLERANCE)
      throw new Refuse(400, "The crop must stay inside the picture and be at least five percent wide and tall.");
    edit.crop = { x: c.x, y: c.y, w: Math.min(c.w, 1 - c.x), h: Math.min(c.h, 1 - c.y) };
  } else if (Object.hasOwn(raw, "crop")) throw new Refuse(400, "Fit uses the whole picture, so it can't include a crop.");
  // storyux (1.99amb): frame = the picture pinched or dragged inside Fit (story-studio.js): the frame's 9:16 window over the
  // picture, in picture fractions, which can run past the picture's edges (black there). The editor's own limits: the
  // picture's centre stays in the frame, never smaller than half the whole picture (the window's shorter side at most 2
  // pictures), never past 8x the frame-filling zoom (its longer side at least 1/8) or a window under 5% of the picture.
  // No frame: the whole picture, as before. The 9:16 shape is checked against the picture itself (shape()).
  if (Object.hasOwn(raw, "frame")) {
    if (raw.fit !== "fit") throw new Refuse(400, "Fill uses a crop, so it can't include a frame.");
    keys(raw.frame, ["x", "y", "w", "h"], "Choose a valid frame for the story.");
    const f = raw.frame;
    if (![f.x, f.y, f.w, f.h].every(finite) || f.w < 0.05 - TOLERANCE || f.h < 0.05 - TOLERANCE || f.w > 1000 || f.h > 1000)
      throw new Refuse(400, "The picture can be zoomed in only so far - at least five percent of it stays in the story.");
    if (Math.min(f.w, f.h) > 2 + TOLERANCE || Math.max(f.w, f.h) < 0.125 - TOLERANCE)
      throw new Refuse(400, "The picture can be zoomed between half its whole size and eight times the size that fills the story.");
    if (f.x > 0.5 + TOLERANCE || f.x + f.w < 0.5 - TOLERANCE || f.y > 0.5 + TOLERANCE || f.y + f.h < 0.5 - TOLERANCE)
      throw new Refuse(400, "Keep the middle of the picture inside the story.");
    edit.frame = { x: f.x, y: f.y, w: f.w, h: f.h };
  }
  if (Object.hasOwn(raw, "trim")) {
    if (kind !== "video") throw new Refuse(400, "Only videos can be trimmed.");
    keys(raw.trim, ["start", "end"], "Choose a valid video trim.");
    const { start, end } = raw.trim;
    if (!finite(start) || !finite(end) || start < 0 || end <= start || end - start < 1 || end - start > L.STORY_MAX_SECS + 0.5)
      throw new Refuse(400, "Choose between 1 and 30 seconds of video.");
    edit.trim = { start, end };
  }
  // storyfix2 (1.99aly): camera: true = a clip the story camera recorded (story-camera.js). The length a browser shows for it can
  // run past the media the file holds (an iPhone's MediaRecorder MP4), so its trim is clamped to the file and, kept whole, it
  // comes with no trim at all (video() below)
  if (Object.hasOwn(raw, "camera")) {
    if (raw.camera !== true) throw new Refuse(400, "That story edit has unsupported fields.");
    if (kind !== "video") throw new Refuse(400, "Only a video can be a camera clip.");
    edit.camera = true;
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
  const win = edit.fit === "fill" ? edit.crop : edit.frame;
  if (win && Math.abs((w * win.w / (h * win.h)) / RATIO - 1) > 0.02)
    throw new media.MediaError(edit.fit === "fill" ? "The crop must have the story's 9:16 shape." : "The frame must have the story's 9:16 shape.");
}
// storyux (1.99amb): the picture's window (Fill's crop, or Fit's frame - picture fractions, 9:16) drawn into an outW x outH story
// the way the editor shows it (its RECT: the picture at -x/w, -y/h of the frame, 1/w by 1/h of it); the rest is black.
// storyux verify: exact at any zoom - cutting whole source pixels and stretching them to the ideal place blew a half-pixel
// rounding up by the zoom (14 px at the deepest zoom of a 640 x 360 photo, 30 of a video), and the picture slid off the
// layers. So: the part in view on whole source pixels, rounded outward with a pixel more each side (the scaler's edge) ->
// src; scaled by the window's own scale -> size; the output's visible window cut from that on output pixels -> cut; put at
// `at` (whole output pixels). Off by under a pixel, at any zoom. iw x ih: the picture's square pixels.
function windowed(f, iw, ih, outW, outH) {
  const ix0 = Math.max(0, f.x), iy0 = Math.max(0, f.y), ix1 = Math.min(1, f.x + f.w), iy1 = Math.min(1, f.y + f.h);
  const sx = outW / (f.w * iw), sy = outH / (f.h * ih);                                   // output pixels per source pixel
  const L = Math.max(0, Math.floor(ix0 * iw + TOLERANCE) - 1), T = Math.max(0, Math.floor(iy0 * ih + TOLERANCE) - 1);
  const R = Math.max(L + 1, Math.min(iw, Math.ceil(ix1 * iw - TOLERANCE) + 1)), B = Math.max(T + 1, Math.min(ih, Math.ceil(iy1 * ih - TOLERANCE) + 1));
  const out = (v, n) => Math.min(n, Math.max(0, Math.round(v)));
  const ox0 = Math.min(outW - 1, out((ix0 - f.x) / f.w * outW, outW)), oy0 = Math.min(outH - 1, out((iy0 - f.y) / f.h * outH, outH));
  const ow = Math.max(1, out((ix1 - f.x) / f.w * outW, outW) - ox0), oh = Math.max(1, out((iy1 - f.y) / f.h * outH, outH) - oy0);
  // where the piece's top-left lands in the output, and the output's window in the scaled piece
  const qx = (L / iw - f.x) / f.w * outW, qy = (T / ih - f.y) / f.h * outH;
  const cx = Math.max(0, Math.round(ox0 - qx)), cy = Math.max(0, Math.round(oy0 - qy));
  // a pixel short at an edge the picture has no more of: stretched by under a pixel, never a black line
  const pw = Math.max(1, Math.round((R - L) * sx), cx + ow), ph = Math.max(1, Math.round((B - T) * sy), cy + oh);
  return { src: { x: L, y: T, w: R - L, h: B - T }, size: { w: pw, h: ph }, cut: { x: cx, y: cy, w: ow, h: oh }, at: { x: ox0, y: oy0 },
    full: ox0 === 0 && oy0 === 0 && ow === outW && oh === outH };
}
// the same for ffmpeg (yuv444p throughout, so no cut is rounded to the 4:2:0 chroma; the encoder makes it 4:2:0 at the end)
function windowFilter(p, outW, outH) {
  return `format=yuv444p,crop=${p.src.w}:${p.src.h}:${p.src.x}:${p.src.y},scale=${p.size.w}:${p.size.h}:flags=bicubic,crop=${p.cut.w}:${p.cut.h}:${p.cut.x}:${p.cut.y}`
    + (p.full ? "" : `,pad=${outW}:${outH}:${p.at.x}:${p.at.y}:color=black`) + ",setsar=1";
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
  // storyux verify: the pixels' own shape (sample aspect ratio) - a 1440 x 1080 file with 4:3 pixels is shown, and a browser
  // reports it (videoWidth), as 1920 x 1080; the editor's fractions are of that. After ffmpeg's autorotate a quarter turn swaps
  // the frame and inverts the pixels' shape. -> w x h shown, fw x fh the frame ffmpeg's filters get, sar its pixels' shape
  const m = /^(\d+):(\d+)$/.exec(String(stream.sample_aspect_ratio || "")), raw = m && Number(m[2]) > 0 ? Number(m[1]) / Number(m[2]) : 1;
  const sar0 = Number.isFinite(raw) && raw > 0 ? raw : 1, w = Number(pr.video.width), h = Number(pr.video.height);
  const fw = quarterTurn ? h : w, fh = quarterTurn ? w : h, sar = quarterTurn ? 1 / sar0 : sar0;
  return { w: fw * sar, h: fh, fw, fh, sar };
}
// story camera (1.99alu): a video's length from the end of its last packet, for a file whose header has none. Demuxing only (no
// decoding), the first video stream, the demuxer forced and local files only, as everywhere here; the ffprobe 4.2 on the VPS knows
// every option used. -> seconds (ms precision), 0 when no packet has a time.
async function packetSecs(input, ffmt) {
  const span = await packetSpan(input, ffmt, "v:0");
  return span && span.end > 0 ? span.end : 0;
}
// storyfix2 (1.99aly): where a file's packets start and end - every stream unless `streams` names one (an iPhone recording's sound
// can run on after its picture stops, so the media's length is the longest stream's). Demuxing only, the demuxer forced, local
// files only; ffprobe 4.2 knows every option. -> { start, end } in seconds (ms precision), null when no packet has a time.
async function packetSpan(input, ffmt, streams) {
  const args = ["-v", "error", "-protocol_whitelist", "file", "-f", ffmt];
  if (streams) args.push("-select_streams", streams);
  args.push("-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", input);
  const r = await media.run(media.bin("ffprobe"), args, { timeoutMs: 30000, maxOut: 8 * 1024 * 1024 });
  let start = Infinity, end = -Infinity;
  for (const line of String((r && r.out) || "").split(/\r?\n/)) {
    const [pts, dur] = line.split(","), at = pts === undefined || pts.trim() === "" ? NaN : Number(pts);
    if (!Number.isFinite(at)) continue;
    start = Math.min(start, at); end = Math.max(end, at + (Number(dur) || 0));
  }
  const ms = (n) => Math.round(n * 1000) / 1000;
  return Number.isFinite(end) ? { start: ms(start), end: ms(end) } : null;
}
// the seconds a span covers, counted from 0 as a browser shows the file (a late first packet is a gap before it, not less media)
const spanSecs = (span) => (span ? Math.round((span.end - Math.min(0, span.start)) * 1000) / 1000 : 0);
async function picture(input, sn, edit, overlay) {
  const L = limits(), sharp = require("sharp");
  let intermediate = null, out = null;
  try {
    intermediate = await media.processImage(input, sn.fmt);
    if (intermediate.animated) throw new media.MediaError("Animated pictures can't be edited yet - post it as it is.");
    shape(edit, intermediate.w, intermediate.h);
    let image = sharp(fs.readFileSync(media.filePath(intermediate.file)));
    const layers = overlay ? [{ input: overlay, left: 0, top: 0 }] : [];
    const win = edit.fit === "fill" ? edit.crop : edit.frame;
    if (win) {
      // storyux verify: Fill's crop and Fit's frame alike - the part in view, scaled and cut to the output pixel (windowed), on
      // black where the picture isn't
      const p = windowed(win, intermediate.w, intermediate.h, L.STORY_W, L.STORY_H);
      const { data, info } = await image.extract({ left: p.src.x, top: p.src.y, width: p.src.w, height: p.src.h }).resize(p.size.w, p.size.h, { fit: "fill" })
        .extract({ left: p.cut.x, top: p.cut.y, width: p.cut.w, height: p.cut.h }).raw().toBuffer({ resolveWithObject: true });
      const raw = { width: info.width, height: info.height, channels: info.channels };
      if (p.full) image = sharp(data, { raw });
      else { image = sharp({ create: { width: L.STORY_W, height: L.STORY_H, channels: 3, background: "#000" } }); layers.unshift({ input: data, raw, left: p.at.x, top: p.at.y }); }
    } else image = image.resize(L.STORY_W, L.STORY_H, { fit: "contain", background: "#000" });
    if (layers.length) image = image.composite(layers);
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
  // story camera (1.99alu): a browser recording (MediaRecorder WebM, some fragmented MP4) can carry no length in its header.
  // storyfix2 (1.99aly): measured over every stream's packets (was the video's alone: a picture that stops before the sound
  // made the clip shorter than it is)
  let span;
  const measured = async () => { if (span === undefined) span = await packetSpan(input, sn.ffmt).catch(() => null); return spanSecs(span); };
  if (!Number.isFinite(pr.secs) || pr.secs <= 0) pr.secs = await measured();
  if (!Number.isFinite(pr.secs) || pr.secs <= 0) throw new media.MediaError("That video's length couldn't be read.");
  const sourceCap = Math.min(L.STORY_SRC_MAX_SECS, Number(caps.max_video_secs) || L.STORY_SRC_MAX_SECS);
  if (pr.secs > sourceCap) throw new media.MediaError("The source video is too long for a story edit.");
  // storyfix2: the header's length is checked against the packets for a camera clip (kept whole or trimmed), and for any trim
  // that runs past it - the longer of the two is the media's length (a short header is no reason to refuse or cut a clip).
  // storyfix2 verify: the source cap holds against that length too - a header that says less is no way past it (0.5 s for the
  // last packet's own length)
  let secs = pr.secs;
  if (edit.camera || (edit.trim && edit.trim.end > secs + 0.5)) secs = Math.max(secs, await measured());
  if (secs > sourceCap + 0.5) throw new media.MediaError("The source video is too long for a story edit.");
  if (Number(pr.video.width) * Number(pr.video.height) > 8192 * 8192) throw new media.MediaError("That video's frame size is too big.");
  let start = 0, duration;
  if (edit.trim && edit.camera) {
    // storyfix2: a camera clip's trim is in the browser's length, which can run past the file (an iPhone's MP4): clamped to the
    // media, refused only when nothing of it is left.
    // storyfix2 verify: the browser's timeline (and secs) start at 0, but ffmpeg's input -ss counts from the file's first
    // timestamp - a recording whose first packet is late was cut that much later than shown. The seek is taken back by it;
    // the time before the first packet holds no media, so it isn't counted in the length either
    const first = span && span.start > 0 ? span.start : 0;
    if (edit.trim.start > secs - 0.1) throw new media.MediaError("The trim starts after the end of the video.");
    if (edit.trim.end <= first + 0.05) throw new media.MediaError("The trim ends before the video starts.");
    start = Math.max(0, edit.trim.start - first); duration = Math.min(edit.trim.end, secs) - Math.max(edit.trim.start, first);
  } else if (edit.trim) {
    if (edit.trim.end > secs + 0.5) throw new media.MediaError("The trim goes past the end of the video.");
    start = edit.trim.start; duration = edit.trim.end - start;
  } else if (edit.camera) {
    // storyfix2: a camera clip kept whole: all the file holds, up to the story's length (the result is checked below)
    duration = L.STORY_MAX_SECS;
  } else {
    if (pr.secs > L.STORY_MAX_SECS + 0.5) throw new media.MediaError("Trim it to 30 seconds.");
    duration = pr.secs;
  }
  const size = await displayedVideoSize(input, sn, pr); shape(edit, size.w, size.h);
  const out = outputNames(".mp4"), outPath = media.filePath(out.file);
  let png = null;
  if (overlay) { png = path.join(work, "overlay.png"); await sharp(overlay).resize(L.STORY_VIDEO_W, L.STORY_VIDEO_H).png().toFile(png); }
  // storyux verify: square pixels first where the file's aren't (then the frame is what the browser showed, and every cut
  // below is in its pixels); Fill's crop and Fit's frame cut to the output pixel (windowed); plain Fit letterboxes as before
  const anamorphic = Math.abs(size.sar - 1) > 1e-3, iw = anamorphic ? 2 * Math.max(1, Math.round(size.w / 2)) : size.fw, ih = size.fh;
  const square = anamorphic ? `format=yuv444p,scale=${iw}:${ih}:flags=bicubic,setsar=1,` : "";
  const win = edit.fit === "fill" ? edit.crop : edit.frame;
  const vf = square + (win ? windowFilter(windowed(win, iw, ih, L.STORY_VIDEO_W, L.STORY_VIDEO_H), L.STORY_VIDEO_W, L.STORY_VIDEO_H)
    : `scale=${L.STORY_VIDEO_W}:${L.STORY_VIDEO_H}:force_original_aspect_ratio=decrease,pad=${L.STORY_VIDEO_W}:${L.STORY_VIDEO_H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`);
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
    // storyfix2 verify: a camera trim past the picture's end (its sound runs on) encodes no picture - that's what to say
    if (edit.trim && edit.camera && (!result || !result.video || !result.secs)) throw new media.MediaError("The trim starts after the end of the video.");
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
module.exports = { cleanEdit, overlayCheck, process, packetSecs, packetSpan, Refuse };
