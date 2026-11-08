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
  // 1.99alq: the VPS's ffprobe 4.2 has no "stream_side_data" section name, so the rotation probe must read -show_streams
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

// ── storyux (1.99??): the picture itself is pinched and dragged in the editor. Fill keeps posting a crop inside the picture; Fit
//    posts the frame's window over the picture ("frame", picture fractions, 9:16), which can run past the picture's edges - black
//    there. The editor's geometry (story-studio.js, run here as it is) says where a point of the picture is shown; the composed
//    story must put it there. ──
const vm = require("vm");
function clientGeometry() {
  const doc = { addEventListener() {}, readyState: "complete", querySelector: () => null };
  const win = { document: doc, Math, Object, Array, String, Number, JSON, Promise, Date, Error, isFinite, location: { pathname: "/", search: "" } };
  win.window = win; vm.runInContext(fs.readFileSync(path.join(repo, "public/js/story-studio.js"), "utf8"), vm.createContext(win));
  return win.patvStoryStudio.geometry;
}
const framed = frame => fit({ frame });
/** The centre of the red marker in a picture: the mean of its red pixels (r > 170, g and b < 100), and how many there are. */
async function redSpot(file) {
  const { data, info } = await sharp(fs.readFileSync(file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, sx = 0, sy = 0, minX = Infinity, maxX = -1;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * info.channels;
    if (data[i] > 170 && data[i + 1] < 100 && data[i + 2] < 100) { n++; sx += x; sy += y; minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  return { n, x: sx / n, y: sy / n, w: maxX - minX + 1, W: info.width, H: info.height };
}
/** Where the editor shows a picture point (u, v in picture fractions) for a window, in the output's pixels. */
function shown(G, win, u, v, W, H) { const r = G.rect(win); return { x: (r.x + u * r.w) * W, y: (r.y + v * r.h) * H, w: r.w * W }; }
// a 1600 x 900 green picture with a 100 x 100 red square at (1100, 600): its centre is (0.71875, 0.72222) of the picture
const MARK = { x: 1100, y: 600, size: 100, W: 1600, H: 900 }, MU = (MARK.x + MARK.size / 2) / MARK.W, MV = (MARK.y + MARK.size / 2) / MARK.H;
const marked = path.join(tmp, "marked.png"), markedVideo = path.join(tmp, "marked.mp4");

test("spec: a Fit frame (the picture pinched or dragged inside Fit) is checked - the zoom limits, the picture's centre in the frame, never with Fill", () => {
  const ok = { x: -0.4, y: -0.2, w: 1.6, h: 1.9 };
  assert.deepEqual(compose.cleanEdit(framed(ok), { kind: "image" }).frame, ok);
  assert.deepEqual(compose.cleanEdit(framed({ x: 0.45, y: 0.4, w: 0.06, h: 0.2 }), { kind: "video" }).frame, { x: 0.45, y: 0.4, w: 0.06, h: 0.2 });
  const input = framed({ ...ok }); compose.cleanEdit(input, { kind: "image" }); assert.deepEqual(input.frame, ok, "not changed in place");
  assert.equal(compose.cleanEdit(fit(), { kind: "image" }).frame, undefined, "no frame: the whole picture, as before");
  const bad = [
    { ...fill({ x: 0, y: 0, w: 1, h: 1 }), frame: ok },                         // Fill has its crop
    framed(null), framed([]), framed("0,0,1,1"), framed({ x: 0, y: 0, w: 1 }), framed({ ...ok, turn: 1 }),
    framed({ ...ok, x: NaN }), framed({ ...ok, w: Infinity }), framed({ ...ok, h: "1" }),
    framed({ x: 0.48, y: 0.4, w: 0.04, h: 0.2 }),                                 // under 5% of the picture
    framed({ x: -1, y: -2, w: 2.5, h: 4.4 }),                                     // smaller than half the whole picture
    framed({ x: 0.6, y: 0, w: 1, h: 1 }), framed({ x: -0.6, y: 0, w: 1, h: 1 }),  // the picture's centre left the frame
    framed({ x: 0, y: 0.51, w: 1, h: 1 }), framed({ x: 0, y: -0.52, w: 1, h: 1 }),
    framed({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }),                                 // past 8x the frame-filling zoom
  ];
  for (const edit of bad) assert.throws(() => compose.cleanEdit(edit, { kind: "image" }), e => e instanceof compose.Refuse && e.status === 400 && e.message.length > 10, JSON.stringify(edit.frame));
});

test("a picture pinched smaller and dragged in Fit lands where the editor showed it, on black; one zoomed in Fill too", async () => {
  const G = clientGeometry(), own = MARK.W / MARK.H;
  const square = await sharp({ create: { width: MARK.size, height: MARK.size, channels: 3, background: "#ff0000" } }).png().toBuffer();
  await sharp({ create: { width: MARK.W, height: MARK.H, channels: 3, background: "#237d42" } }).composite([{ input: square, left: MARK.x, top: MARK.y }]).png().toFile(marked);
  // Fit: the whole picture, pinched to 70% about a point left of the middle, then dragged down and right (frame fractions)
  let win = G.contain(own);
  win = G.zoom(win, own, "fit", 0.7, { x: 0.4, y: 0.5 }, { x: 0.4, y: 0.5 });
  win = G.pan(win, own, "fit", 0.12, 0.08);
  const out = await compose.process(marked, sniff(marked), attachment("image", framed(win)), caps);
  const spot = await redSpot(media.filePath(out.file)), want = shown(G, win, MU, MV, 1080, 1920);
  assert.ok(Math.abs(spot.x - want.x) <= 2 && Math.abs(spot.y - want.y) <= 2, `marker at ${spot.x.toFixed(1)},${spot.y.toFixed(1)} - shown at ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
  assert.ok(Math.abs(spot.w - MARK.size / MARK.W * want.w) <= 2, `marker ${spot.w}px wide - shown ${(MARK.size / MARK.W * want.w).toFixed(1)}px`);
  const r = G.rect(win);
  assert.ok((await pixel(media.filePath(out.file), 5, 5)).every(c => c < 8), "black where the picture isn't");
  const inside = await pixel(media.filePath(out.file), Math.round((r.x + 0.1 * r.w) * 1080), Math.round((r.y + 0.1 * r.h) * 1920));
  assert.ok(inside[1] > 100 && inside[0] < 60, "the picture where it is: " + inside.join());
  done(out);
  // Fill: dragged left to bring the marker in, pinched 2x about it (the fingers drifting), dragged again; the crop never leaves the picture
  let crop = G.cover(own);
  crop = G.pan(crop, own, "fill", -0.6, 0);
  crop = G.zoom(crop, own, "fill", 2, { x: 0.59, y: 0.7 }, { x: 0.55, y: 0.65 });
  crop = G.pan(crop, own, "fill", -0.05, 0.02);
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.w <= 1 + 1e-9 && crop.y + crop.h <= 1 + 1e-9);
  const out2 = await compose.process(marked, sniff(marked), attachment("image", fill(crop)), caps);
  const spot2 = await redSpot(media.filePath(out2.file)), want2 = shown(G, crop, MU, MV, 1080, 1920);
  assert.ok(spot2.n > 0, "the marker is in the crop");
  assert.ok(Math.abs(spot2.x - want2.x) <= 3 && Math.abs(spot2.y - want2.y) <= 3, `marker at ${spot2.x.toFixed(1)},${spot2.y.toFixed(1)} - shown at ${want2.x.toFixed(1)},${want2.y.toFixed(1)}`);
  done(out2);
  // a frame that isn't the picture's 9:16 window is refused, as a crop is
  await assert.rejects(compose.process(marked, sniff(marked), attachment("image", framed({ x: 0, y: -0.5, w: 1, h: 1.2 })), caps), /9:16/);
});

test("a video pinched and dragged in Fit lands where the editor showed it (ffmpeg), with black around it", videoOptions, async () => {
  ffmpeg(["-f", "lavfi", "-i", `color=c=0x237d42:s=${MARK.W}x${MARK.H}:r=5:d=2`, "-vf", `drawbox=x=${MARK.x}:y=${MARK.y}:w=${MARK.size}:h=${MARK.size}:color=red:t=fill`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", markedVideo]);
  const G = clientGeometry(), own = MARK.W / MARK.H;
  let win = G.contain(own);
  win = G.zoom(win, own, "fit", 0.6, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 });
  win = G.pan(win, own, "fit", -0.15, 0.1);
  const out = await compose.process(markedVideo, sniff(markedVideo), attachment("video", framed(win)), caps);
  assert.equal(out.w, 720); assert.equal(out.h, 1280);
  const frame = path.join(tmp, "framed.png"); ffmpeg(["-ss", "0.5", "-i", media.filePath(out.file), "-frames:v", "1", "-y", frame]);
  const spot = await redSpot(frame), want = shown(G, win, MU, MV, 720, 1280);
  assert.ok(spot.n > 0, "the marker is in the story");
  assert.ok(Math.abs(spot.x - want.x) <= 3 && Math.abs(spot.y - want.y) <= 3, `marker at ${spot.x.toFixed(1)},${spot.y.toFixed(1)} - shown at ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
  assert.ok(Math.abs(spot.w - MARK.size / MARK.W * want.w) <= 3, `marker ${spot.w}px wide - shown ${(MARK.size / MARK.W * want.w).toFixed(1)}px`);
  assert.ok((await pixel(frame, 4, 4)).every(c => c < 12), "black where the picture isn't");
  done(out);
  // zoomed in past the frame-filling size inside Fit: the picture runs off the frame's edges (no black), still where shown
  // (3.5x the whole picture: its height just covers the frame; the marker kept wholly inside the frame, so its centre is a fair measure)
  let deep = G.zoom(G.contain(own), own, "fit", 3.5, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 });
  deep = G.pan(deep, own, "fit", -0.43, 0);
  const rd = G.rect(deep); assert.ok(rd.x < 0 && rd.y < 0 && rd.x + rd.w > 1 && rd.y + rd.h > 1, "the picture covers the frame");
  const out2 = await compose.process(markedVideo, sniff(markedVideo), attachment("video", framed(deep)), caps);
  const frame2 = path.join(tmp, "framed2.png"); ffmpeg(["-ss", "0.5", "-i", media.filePath(out2.file), "-frames:v", "1", "-y", frame2]);
  const spot2 = await redSpot(frame2), want2 = shown(G, deep, MU, MV, 720, 1280);
  assert.ok(Math.abs(spot2.n - (MARK.size * want2.w / MARK.W) ** 2) < 0.1 * (MARK.size * want2.w / MARK.W) ** 2, "the whole marker is in the story");
  assert.ok(Math.abs(spot2.x - want2.x) <= 4 && Math.abs(spot2.y - want2.y) <= 4, `marker at ${spot2.x.toFixed(1)},${spot2.y.toFixed(1)} - shown at ${want2.x.toFixed(1)},${want2.y.toFixed(1)}`);
  done(out2);
});

// ── storyux verify (the review of 2026-11-08): Fill's 5% check had no float tolerance (the editor's deepest pinch on a tall
//    picture was refused); at deep zoom whole-source-pixel cuts were blown up by the zoom (the picture slid off the layers); a
//    video with non-square pixels was refused in Fit (and squashed in plain Fit) ──
test("storyux verify: Fill's crop at the editor's deepest pinch on a tall picture is accepted - five percent with the frame's float tolerance", () => {
  const G = clientGeometry();
  assert.ok(compose.cleanEdit(fill({ x: 0.4, y: 0.3, w: 0.21, h: 0.049999999999999996 }), { kind: "image" }).crop, "a hair under 5% by float");
  assert.throws(() => compose.cleanEdit(fill({ x: 0.4, y: 0.3, w: 0.21, h: 0.0499 }), { kind: "image" }), /five percent/, "really under 5% still is not");
  let tried = 0;
  for (const w of [720, 750, 1080, 1170, 1284, 1440]) for (const h of [3205, 3215, 3227, 3500, 4000, 6000, 9000]) {
    const own = w / h; if (!G.canFill(own)) continue;
    // the deepest pinch, as the page posts it (a JSON round trip)
    const crop = JSON.parse(JSON.stringify(G.zoom(G.cover(own), own, "fill", 1000, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    assert.doesNotThrow(() => compose.cleanEdit(fill(crop), { kind: "image" }), `${w}x${h}: ${JSON.stringify(crop)}`); tried++;
  }
  assert.ok(tried >= 30);
});

// a 640 x 360 picture (the deep end: the deepest zoom shows 32 of its pixels across) with a 10 x 10 red marker at (326, 186) - next
// to the middle, as Fit keeps the picture's middle in the frame (at 8x a window 5% wide holds it)
const SMALL = { x: 326, y: 186, size: 10, W: 640, H: 360 }, SU = (SMALL.x + SMALL.size / 2) / SMALL.W, SV = (SMALL.y + SMALL.size / 2) / SMALL.H;
const smallPng = path.join(tmp, "small.png"), smallVideo = path.join(tmp, "small.mp4");
/** the deepest pinch about the marker (the fingers on it), then a small drag - in Fit or in Fill */
function deepest(G, own, layout) {
  const start = layout === "fit" ? G.contain(own) : G.cover(own), r0 = G.rect(start), f0 = { x: r0.x + SU * r0.w, y: r0.y + SV * r0.h };
  const win = G.pan(G.zoom(start, own, layout, 1000, f0, f0), own, layout, 0.031, -0.017);
  assert.ok(Math.abs(win.w - G.widths(own, layout)[0]) < 1e-9, "the deepest zoom");
  return win;
}
const deepEdit = (layout, win) => (layout === "fit" ? framed(win) : fill(win));

test("storyux verify: at the deepest zoom a photo still lands under the layers - Fit's frame and Fill's crop cut where the editor shows, to the output pixel", async () => {
  const G = clientGeometry(), own = SMALL.W / SMALL.H;
  const square = await sharp({ create: { width: SMALL.size, height: SMALL.size, channels: 3, background: "#ff0000" } }).png().toBuffer();
  await sharp({ create: { width: SMALL.W, height: SMALL.H, channels: 3, background: "#237d42" } }).composite([{ input: square, left: SMALL.x, top: SMALL.y }]).png().toFile(smallPng);
  for (const layout of ["fit", "fill"]) {
    const win = deepest(G, own, layout);
    const out = await compose.process(smallPng, sniff(smallPng), attachment("image", deepEdit(layout, win)), caps);
    const spot = await redSpot(media.filePath(out.file)), want = shown(G, win, SU, SV, 1080, 1920), size = SMALL.size / SMALL.W * want.w;
    assert.ok(Math.abs(spot.x - want.x) <= 2 && Math.abs(spot.y - want.y) <= 2, `${layout}: marker at ${spot.x.toFixed(1)},${spot.y.toFixed(1)} - shown at ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
    assert.ok(Math.abs(spot.w - size) <= 4, `${layout}: marker ${spot.w}px wide - shown ${size.toFixed(1)}px`);
    assert.ok((await pixel(media.filePath(out.file), 1079, 1919)).every((c, i) => i === 1 ? c > 100 : c < 60), "the picture reaches the frame's far corner (no black edge)");
    done(out);
  }
});

test("storyux verify: at the deepest zoom a video still lands under the layers - Fit's frame and Fill's crop cut where the editor shows", videoOptions, async () => {
  ffmpeg(["-f", "lavfi", "-i", `color=c=0x237d42:s=${SMALL.W}x${SMALL.H}:r=5:d=2`, "-vf", `drawbox=x=${SMALL.x}:y=${SMALL.y}:w=${SMALL.size}:h=${SMALL.size}:color=red:t=fill`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", smallVideo]);
  const G = clientGeometry(), own = SMALL.W / SMALL.H;
  for (const layout of ["fit", "fill"]) {
    const win = deepest(G, own, layout);
    const out = await compose.process(smallVideo, sniff(smallVideo), attachment("video", deepEdit(layout, win)), caps);
    assert.equal(out.w, 720); assert.equal(out.h, 1280);
    const frame = path.join(tmp, `deep-${layout}.png`); ffmpeg(["-ss", "0.5", "-i", media.filePath(out.file), "-frames:v", "1", "-y", frame]);
    const spot = await redSpot(frame), want = shown(G, win, SU, SV, 720, 1280);
    assert.ok(Math.abs(spot.x - want.x) <= 3 && Math.abs(spot.y - want.y) <= 3, `${layout}: marker at ${spot.x.toFixed(1)},${spot.y.toFixed(1)} - shown at ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
    const edge = await pixel(frame, 719, 1279); assert.ok(edge[1] > 90 && edge[0] < 80, "the picture reaches the frame's far corner: " + edge.join());
    done(out);
  }
});

test("storyux verify: a video with non-square pixels (1440 x 1080 stored, shown 16:9) is framed by what the browser shows - plain Fit, a Fit frame and Fill all land where shown", videoOptions, async () => {
  const file = path.join(tmp, "anamorphic.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=c=0x237d42:s=1440x1080:r=5:d=2", "-vf", "drawbox=x=824:y=600:w=76:h=100:color=red:t=fill,setsar=4/3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", file]);
  const G = clientGeometry(), own = 1920 / 1080, U = (824 + 38) / 1440, V = (600 + 50) / 1080;   // the browser's videoWidth x videoHeight: 1920 x 1080
  let frameWin = G.zoom(G.contain(own), own, "fit", 0.8, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }); frameWin = G.pan(frameWin, own, "fit", 0.05, 0.03);
  const fillWin = G.pan(G.cover(own), own, "fill", -0.1, 0);
  for (const [name, edit, win] of [["plain Fit", fit(), G.contain(own)], ["a Fit frame", framed(frameWin), frameWin], ["Fill", fill(fillWin), fillWin]]) {
    const out = await compose.process(file, sniff(file), attachment("video", edit), caps);
    const frame = path.join(tmp, "anamorphic-out.png"); ffmpeg(["-ss", "0.5", "-i", media.filePath(out.file), "-frames:v", "1", "-y", frame]);
    const spot = await redSpot(frame), want = shown(G, win, U, V, 720, 1280);
    assert.ok(Math.abs(spot.x - want.x) <= 3 && Math.abs(spot.y - want.y) <= 3, `${name}: marker at ${spot.x.toFixed(1)},${spot.y.toFixed(1)} - shown at ${want.x.toFixed(1)},${want.y.toFixed(1)}`);
    assert.ok(Math.abs(spot.w - 76 / 1440 * G.rect(win).w * 720) <= 3, `${name}: marker ${spot.w}px wide (not squashed)`);
    done(out);
  }
});
