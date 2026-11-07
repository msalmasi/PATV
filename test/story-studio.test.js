// Story Studio's versioned edit spec and real safe-media pipeline. All pictures/video are generated here.
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-studio-"));
process.chdir(tmp);
process.env.FEED_DIR = path.join(tmp, "feed"); process.env.MEDIA_DIR = path.join(tmp, "stories"); process.env.FEED_NO_NICE = "1";
const sharp = require("sharp"), { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const media = require(path.join(repo, "feedmedia")), compose = require(path.join(repo, "storycompose"));
const US = require(path.join(repo, "userstories")), stickers = require(path.join(repo, "stickers"));
let HAVE_FFMPEG = true;
try { execFileSync(media.bin("ffmpeg"), ["-version"], { stdio: "ignore", windowsHide: true }); execFileSync(media.bin("ffprobe"), ["-version"], { stdio: "ignore", windowsHide: true }); } catch (_) { HAVE_FFMPEG = false; }
const videoOptions = { skip: !HAVE_FFMPEG && "no ffmpeg" };
const owner = "u_orchardcanvas", caps = { max_video_secs: 180 };
const fit = extra => ({ v: 1, pad: "profile", fit: "fit", text: [], stickers: [], ...extra });
const fill = crop => ({ ...fit(), fit: "fill", crop });
const attachment = (kind, edit) => ({ owner_id: owner, kind, edit: JSON.stringify(edit) });
const sniff = file => media.sniff(fs.readFileSync(file).subarray(0, 4096));
const png = path.join(tmp, "portrait.png"), jpeg = path.join(tmp, "landscape.jpg"), oriented = path.join(tmp, "rotated.jpg");
const portraitVideo = path.join(tmp, "portrait.mp4"), landscapeVideo = path.join(tmp, "landscape.mp4");
const ffmpeg = args => execFileSync(media.bin("ffmpeg"), ["-hide_banner", "-nostdin", "-v", "error", ...args], { stdio: "pipe", windowsHide: true });
const sourceRows = () => getQuery("SELECT * FROM feed_attachments ORDER BY id");
function files() {
  const out = [];
  function visit(folder) { for (const e of fs.readdirSync(folder, { withFileTypes: true })) { const p = path.join(folder, e.name); if (e.isDirectory()) visit(p); else out.push(path.relative(media.dir(), p)); } }
  visit(media.dir()); return out.sort();
}
function done(out) { media.removeFiles([out.file, out.thumb, out.poster]); }
async function pixel(file, x, y) {
  const { data, info } = await sharp(fs.readFileSync(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
}
async function overlay(options = {}) {
  const id = crypto.randomBytes(12).toString("hex"), base = crypto.randomBytes(16).toString("hex"), file = base + ".webp";
  fs.mkdirSync(path.dirname(media.filePath(file)), { recursive: true });
  const square = await sharp({ create: { width: 160, height: 160, channels: 4, background: "#ff0000" } }).png().toBuffer();
  await sharp({ create: { width: options.width || 1080, height: options.height || 1920, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: square, left: 180, top: 300 }]).webp({ lossless: true }).toFile(media.filePath(file));
  await runQuery("INSERT INTO feed_attachments (id,owner_id,purpose,kind,state,file,created) VALUES (?,?,?,?,?,?,?)", [id, options.owner || owner, options.purpose || "story_ovl", "image", options.state || "ready", file, Date.now()]);
  return { id, file };
}

test.before(async () => {
  media.dir();
  await runQuery("CREATE TABLE IF NOT EXISTS feed_attachments (id TEXT PRIMARY KEY, owner_id TEXT, purpose TEXT, kind TEXT, state TEXT, post_id TEXT, error TEXT, file TEXT, thumb TEXT, poster TEXT, created INTEGER)");
  await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#237d42" } }).png().toFile(png);
  await sharp({ create: { width: 4000, height: 3000, channels: 3, background: "#237d42" } }).jpeg().toFile(jpeg);
  await sharp({ create: { width: 1920, height: 1080, channels: 3, background: "#237d42" } }).jpeg().withMetadata({ orientation: 6 }).toFile(oriented);
});

test("versioned spec normalizes code-point text and known stickers without mutating the input", () => {
  const pack = stickers.CAT.packs[0], sticker = pack.stickers[0];
  const input = fit({ pad: " profile ", text: [" 😀 مرحبا "], stickers: [{ pack: pack.id, sticker: sticker.id }] });
  const result = compose.cleanEdit(input, { kind: "image" });
  assert.deepEqual(result.text, ["😀 مرحبا"]); assert.equal(result.pad, "profile"); assert.equal(input.pad, " profile ");
  assert.deepEqual(result.stickers, input.stickers);
  assert.equal(compose.cleanEdit(fit({ text: ["😀".repeat(120)] }), { kind: "image" }).text[0].length, 240);
});
test("spec refuses unsupported versions/fields and invalid crop, trim, layers, overlays or stickers", () => {
  const cases = [null, [], { ...fit(), v: 2 }, { ...fit(), unseen: true }, { ...fit(), pad: "" }, { ...fit(), pad: 2 },
    { ...fit(), fit: "stretch" }, { ...fit(), crop: { x: 0, y: 0, w: 1, h: 1 } }, { ...fit(), fit: "fill" },
    fill({ x: NaN, y: 0, w: 1, h: 1 }), fill({ x: 0, y: 0, w: Infinity, h: 1 }), fill({ x: -0.1, y: 0, w: 1, h: 1 }),
    fill({ x: 0, y: 0, w: 0.049, h: 1 }), fill({ x: 0.5, y: 0, w: 0.6, h: 1 }), fill({ x: 0, y: 0, w: 1, h: 1, turn: 90 }),
    { ...fit(), text: [" "] }, { ...fit(), text: ["line\nbreak"] }, { ...fit(), text: ["x".repeat(121)] }, { ...fit(), text: ["a", "b", "c", "d"] },
    { ...fit(), text: "hello" }, { ...fit(), overlay: "x".repeat(24) }, { ...fit(), overlay: null },
    { ...fit(), stickers: [{ pack: "unknownpack", sticker: "unknown" }] }, { ...fit(), stickers: Array(11).fill({}) },
    { ...fit(), stickers: [{ pack: "__proto__", sticker: "constructor" }] }, { ...fit(), stickers: [{ pack: "constructor", sticker: "unknown" }] },
    { ...fit(), stickers: [{ pack: stickers.CAT.packs[0].id, sticker: "constructor" }] }];
  for (const edit of cases) assert.throws(() => compose.cleanEdit(edit, { kind: "image" }), e => e instanceof compose.Refuse && e.status === 400 && e.message.length > 10);
  for (const trim of [{ start: 0, end: 0.5 }, { start: 0, end: 31 }, { start: 2, end: 1 }, { start: -1, end: 1 }, { start: 0, end: Infinity }, { start: 0, end: 2, extra: 1 }])
    assert.throws(() => compose.cleanEdit(fit({ trim }), { kind: "video" }), compose.Refuse);
  assert.throws(() => compose.cleanEdit(fit({ trim: { start: 0, end: 2 } }), { kind: "image" }), /Only videos/);
  assert.throws(() => compose.cleanEdit(fit(), { kind: "audio" }), /pictures and videos/);
  assert.deepEqual(compose.cleanEdit(fill({ x: 0, y: 0, w: 1 + 0.0000005, h: 1 }), { kind: "image" }).crop, { x: 0, y: 0, w: 1, h: 1 });
});
test("landscape fill becomes exact portrait webp with a 640px thumbnail and no metadata", async () => {
  const before = files();
  const out = await compose.process(jpeg, sniff(jpeg), attachment("image", fill({ x: 0.2890625, y: 0, w: 0.421875, h: 1 })), caps);
  assert.equal(out.kind, "image"); assert.equal(out.w, 1080); assert.equal(out.h, 1920);
  assert.ok(media.FILE_RE.test(out.file)); assert.ok(media.FILE_RE.test(out.thumb));
  const meta = await sharp(fs.readFileSync(media.filePath(out.file))).metadata();
  assert.equal(meta.width, 1080); assert.equal(meta.height, 1920); assert.equal(meta.format, "webp");
  for (const field of ["exif", "icc", "iptc", "xmp", "orientation"]) assert.equal(meta[field], undefined);
  const thumb = await sharp(fs.readFileSync(media.filePath(out.thumb))).metadata(); assert.equal(thumb.height, 640);
  assert.equal(files().length - before.length, 2, "intermediate full/thumbnail removed"); done(out); assert.deepEqual(files(), before);
});
test("fit letterboxes on black, composites the overlay at its declared pixels and consumes it once", async () => {
  const ovl = await overlay(), edit = fit({ overlay: ovl.id }), before = files().filter(f => !f.endsWith(ovl.file));
  const out = await compose.process(jpeg, sniff(jpeg), attachment("image", edit), caps);
  const corner = await pixel(media.filePath(out.file), 5, 5), red = await pixel(media.filePath(out.file), 220, 340);
  assert.ok(corner.every(c => c < 5), corner.join()); assert.ok(red[0] > 230 && red[1] < 25 && red[2] < 25, red.join());
  assert.equal(fs.existsSync(media.filePath(ovl.file)), false);
  const row = (await sourceRows()).find(r => r.id === ovl.id); assert.equal(row.state, "deleted"); assert.equal(row.error, "used for a story");
  await assert.rejects(compose.process(jpeg, sniff(jpeg), attachment("image", edit), caps), /already used/);
  done(out); assert.deepEqual(files(), before);
});
test("EXIF orientation is applied before the crop's shape is validated", async () => {
  const out = await compose.process(oriented, sniff(oriented), attachment("image", fill({ x: 0, y: 0, w: 1, h: 1 })), caps);
  assert.equal(out.w, 1080); assert.equal(out.h, 1920); done(out);
});
test("invalid shape, wrong overlay dimensions and hostile source remove claimed overlays and intermediate outputs", async () => {
  for (const variant of ["shape", "dimensions", "source"]) {
    const ovl = await overlay(variant === "dimensions" ? { height: 1919 } : {});
    const before = files().filter(f => !f.endsWith(ovl.file));
    const edit = variant === "shape" ? { ...fill({ x: 0, y: 0, w: 1, h: 1 }), overlay: ovl.id } : fit({ overlay: ovl.id });
    const source = variant === "source" ? path.join(tmp, "broken.png") : jpeg;
    if (variant === "source") fs.writeFileSync(source, "not a picture");
    const sn = variant === "source" ? { kind: "image", fmt: "png" } : sniff(source);
    const message = variant === "shape" ? /9:16/ : variant === "dimensions" ? /1080 × 1920/ : /couldn't be read/;
    await assert.rejects(compose.process(source, sn, attachment("image", edit), caps), message);
    assert.deepEqual(files(), before, variant + " leaves no media or overlay files");
  }
});
test("overlay preflight is read-only and refuses somebody else's, unready or non-overlay upload", async () => {
  const own = await overlay(); assert.equal((await compose.overlayCheck(owner, own.id)).state, "ready");
  for (const options of [{ owner: "u_cloudcopper" }, { state: "processing" }, { purpose: "story" }]) {
    const other = await overlay(options); await assert.rejects(compose.overlayCheck(owner, other.id), /own ready/); media.removeFiles([other.file]);
  }
  await assert.rejects(compose.overlayCheck(owner, "a".repeat(24)), /own ready/);
  media.removeFiles([own.file]);
});
test("two concurrent sources cannot claim one overlay", async () => {
  const ovl = await overlay(), edit = fit({ overlay: ovl.id });
  const results = await Promise.allSettled([1, 2].map(() => compose.process(png, sniff(png), attachment("image", edit), caps)));
  const successes = results.filter(r => r.status === "fulfilled"), failures = results.filter(r => r.status === "rejected");
  assert.equal(successes.length, 1); assert.equal(failures.length, 1); assert.match(failures[0].reason.message, /already used/);
  done(successes[0].value); assert.equal(fs.existsSync(media.filePath(ovl.file)), false);
});

test("a real 42s portrait video trims in one encoding pass, keeps audio/overlay and produces a poster", videoOptions, async () => {
  ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=1080x1920:r=3:d=42", "-f", "lavfi", "-i", "sine=frequency=440:duration=42", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", portraitVideo]);
  const ovl = await overlay(), edit = { ...fill({ x: 0, y: 0, w: 1, h: 1 }), trim: { start: 5, end: 35 }, overlay: ovl.id };
  const before = files().filter(f => !f.endsWith(ovl.file)), calls = [], oldRun = media.run, oldSlot = media.slot;
  let slots = 0, out;
  media.run = async (cmd, args, options) => { calls.push({ cmd, args }); return oldRun(cmd, args, options); };
  media.slot = async () => { slots++; return oldSlot(); };
  try { out = await compose.process(portraitVideo, sniff(portraitVideo), attachment("video", edit), caps); }
  finally { media.run = oldRun; media.slot = oldSlot; }
  assert.equal(out.w, 720); assert.equal(out.h, 1280); assert.ok(Math.abs(out.secs - 30) <= 0.2); assert.ok(out.poster);
  const pr = await media.probe(media.filePath(out.file), "mov"); assert.ok(pr.audio); assert.ok(Math.abs(pr.secs - 30) <= 0.2);
  const encoding = calls.filter(c => c.args.includes(portraitVideo));
  assert.equal(encoding.filter(c => c.args.includes("libx264")).length, 1); assert.equal(slots, 1);
  const args = encoding.find(c => c.args.includes("libx264")).args;
  assert.ok(args.indexOf("-ss") < args.indexOf("-i")); assert.ok(args.indexOf("-t") < args.indexOf("-i"));
  assert.equal(args[args.indexOf("-map_metadata") + 1], "-1"); assert.equal(args[args.indexOf("-map_chapters") + 1], "-1");
  for (let i = 0; i < args.length; i++) if (args[i] === "-i") { assert.equal(args[i - 4], "-protocol_whitelist"); assert.equal(args[i - 3], "file"); assert.equal(args[i - 2], "-f"); }
  assert.ok(args.includes("image2")); assert.ok(args.includes("0:a:0?")); assert.ok(args.includes("-sn") && args.includes("-dn"));
  // 1.99??: the VPS's ffprobe 4.2 has no "stream_side_data" section name, so the rotation probe must read -show_streams
  const rotationProbe = encoding.find(c => c.args.includes("-select_streams"));
  assert.ok(rotationProbe && rotationProbe.args.includes("-show_streams"));
  assert.ok(!rotationProbe.args.some(a => /stream_side_data/.test(a)), rotationProbe.args.join(" "));
  const frame = path.join(tmp, "sample.png"); ffmpeg(["-ss", "1", "-i", media.filePath(out.file), "-frames:v", "1", "-y", frame]);
  const red = await pixel(frame, 150, 230); assert.ok(red[0] > 220 && red[1] < 35 && red[2] < 35, red.join());
  assert.deepEqual(fs.readdirSync(path.join(media.dir(), "tmp")), []); done(out); assert.deepEqual(files(), before);
});
test("video fit keeps landscape content and black bars", videoOptions, async () => {
  ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=1920x1080:r=3:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", landscapeVideo]);
  const out = await compose.process(landscapeVideo, sniff(landscapeVideo), attachment("video", fit()), caps);
  assert.equal(out.w, 720); assert.equal(out.h, 1280);
  const frame = path.join(tmp, "fit.png"); ffmpeg(["-i", media.filePath(out.file), "-frames:v", "1", "-y", frame]);
  assert.ok((await pixel(frame, 5, 5)).every(v => v < 5)); done(out);
});
test("rotated coded landscape is validated in displayed portrait orientation", videoOptions, async t => {
  const rotated = path.join(tmp, "rotate90.mp4");
  try { ffmpeg(["-display_rotation", "90", "-i", landscapeVideo, "-c", "copy", "-y", rotated]); }
  catch (_) { try { ffmpeg(["-i", landscapeVideo, "-c", "copy", "-metadata:s:v:0", "rotate=90", "-y", rotated]); } catch (_) { t.skip("installed ffmpeg cannot write a rotation tag"); return; } }
  const details = JSON.parse(execFileSync(media.bin("ffprobe"), ["-v", "error", "-show_streams", "-of", "json", rotated]).toString());
  if (!(details.streams || []).some(s => (s.tags && Math.abs(Number(s.tags.rotate)) === 90) || (s.side_data_list || []).some(d => Math.abs(d.rotation) === 90))) { t.skip("installed ffmpeg did not retain a rotation tag"); return; }
  const out = await compose.process(rotated, sniff(rotated), attachment("video", fill({ x: 0, y: 0, w: 1, h: 1 })), caps);
  assert.equal(out.w, 720); assert.equal(out.h, 1280); done(out);
});
test("video refuses overlong, audio-only, out-of-source trim and wrong shape; cleanup survives ffmpeg failure", videoOptions, async () => {
  await assert.rejects(compose.process(portraitVideo, sniff(portraitVideo), attachment("video", fit()), caps), /Trim it to 30/);
  await assert.rejects(compose.process(portraitVideo, sniff(portraitVideo), attachment("video", fit({ trim: { start: 30, end: 50 } })), caps), /past the end/);
  await assert.rejects(compose.process(portraitVideo, sniff(portraitVideo), attachment("video", { ...fill({ x: 0, y: 0, w: 0.95, h: 1 }), trim: { start: 0, end: 2 } }), caps), /9:16/);
  await assert.rejects(compose.process(portraitVideo, sniff(portraitVideo), attachment("video", fit({ trim: { start: 0, end: 2 } })), { max_video_secs: 40 }), /source video is too long/);
  const long = path.join(tmp, "overlong.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=320x180:r=1:d=181", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", long]);
  await assert.rejects(compose.process(long, sniff(long), attachment("video", fit({ trim: { start: 0, end: 2 } })), caps), /source video is too long/);
  const audio = path.join(tmp, "audio.m4a"); ffmpeg(["-f", "lavfi", "-i", "sine=frequency=400:duration=1", "-c:a", "aac", "-y", audio]);
  await assert.rejects(compose.process(audio, sniff(audio), attachment("video", fit()), caps), /video track/);
  const ovl = await overlay(), before = files().filter(f => !f.endsWith(ovl.file)), oldRun = media.run;
  media.run = async (cmd, args, options) => { if (args.includes("libx264")) throw new Error("simulated encode failure"); return oldRun(cmd, args, options); };
  try { await assert.rejects(compose.process(portraitVideo, sniff(portraitVideo), attachment("video", fit({ trim: { start: 0, end: 2 }, overlay: ovl.id })), caps), /couldn't be composed/); }
  finally { media.run = oldRun; }
  assert.deepEqual(files(), before); assert.deepEqual(fs.readdirSync(path.join(media.dir(), "tmp")), []);
});
test("animated pictures reject edits and remove the intermediate image", videoOptions, async () => {
  const gif = path.join(tmp, "animated.gif"); ffmpeg(["-f", "lavfi", "-i", "testsrc=size=24x24:rate=2:duration=1", "-y", gif]);
  const before = files(); await assert.rejects(compose.process(gif, sniff(gif), attachment("image", fit()), caps), /Animated pictures can't be edited yet/);
  assert.deepEqual(files(), before);
});
