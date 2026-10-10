// Offline tests for the homelab media-control service (deploy/mediactl/mediactl.js): request signing, the IP
// allow-list, the ffmpeg command lines (VAAPI full-GPU path, burnt-in subtitles, seeking), and the HTTP API with a
// mocked Plex and a fake ffmpeg (start / one per stage / pause / resume / seek / stop / guards).
//   node --test test/mediactl.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const M = require(path.resolve(__dirname, "..", "deploy", "mediactl", "mediactl.js"));
// real ffprobe answers (mediactl's own -show_entries) for library files of each kind, captured in the Plex container
const FIX = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "ffprobe", n + ".json"), "utf8"));
const PROBE = Object.fromEntries(["hevc10-hdr10-dv8", "h264-hi10", "mpeg2-dvd", "xvid", "hevc8-4k", "av1-4k", "h264-sd"].map((n) => [n, M.parseProbe(FIX(n))]));
const SECRET = "s".repeat(40);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mediactl-test-"));
const media = path.join(tmp, "media");
fs.mkdirSync(path.join(media, "movies"), { recursive: true });
const FILE = path.join(media, "movies", "Night of the Living Dead (1968).mkv");
fs.writeFileSync(FILE, "x");
const OUTSIDE = path.join(tmp, "elsewhere.mkv");
fs.writeFileSync(OUTSIDE, "x");

// ── a fake Plex (only what the service asks) ──
const ITEMS = {
  "100": { type: "movie", title: "Night of the Living Dead", year: 1968, file: FILE, duration: 5760, width: 1440, height: 1080,
           audio: [{ index: 1, label: "English (AAC)", default: true }], subs: [
             { index: 2, rel: 0, label: "English (SRT)", codec: "srt", image: false, burnable: true },
             { index: 3, rel: 1, label: "French (PGS)", codec: "pgs", image: true, burnable: true }] },
  "101": { type: "movie", title: "Outside", year: 2000, file: OUTSIDE, duration: 100, width: 1920, height: 1080, audio: [], subs: [] },
  "102": { type: "show", title: "A Show", year: 2001, file: null, duration: null, episodes: [] },
};
const fakePlex = {
  calls: [],
  async search(q) { this.calls.push(["search", q]); return [{ key: "100", type: "movie", title: "Night of the Living Dead", year: 1968, duration: 5760, poster: true }]; },
  async item(key) { this.calls.push(["item", key]); const it = ITEMS[key]; if (!it) { const e = new Error("Not in the Plex library"); e.status = 404; throw e; } return { key, ...it, hdr: false }; },
  async poster() { return { type: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff]) }; },
};

// ── a fake ffmpeg ──
const procs = [];
function fakeSpawn(cmd, args) {
  const p = new EventEmitter();
  p.stdout = new PassThrough(); p.stderr = new PassThrough();
  p.args = args; p.killed = false;
  p.kill = (sig) => { if (p.killed) return; p.killed = true; setImmediate(() => p.emit("exit", null, sig)); };
  procs.push(p);
  return p;
}
const lastProc = () => procs[procs.length - 1];

const cfg = M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_ALLOW: "127.0.0.1/32,::1", MEDIACTL_MEDIA_ROOTS: media + path.sep,
                           MEDIACTL_RTMP_ALLOW: "rtmp://stream.publicaccess.tv/", PLEX_TOKEN: "t", MEDIACTL_MAX_STREAMS: "2" });
let T = Date.now();
let probeAnswer = null;                 // what the fake ffprobe says about the next file (null = ffprobe failed)
const fakeProbe = async () => probeAnswer;
const streams = M.makeStreams(cfg, fakePlex, fakeSpawn, () => T, fakeProbe);
const { server } = M.makeServer(cfg, { plex: fakePlex, streams });
let base;
test.before(() => new Promise((r) => server.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { streams.stopAll(); server.close(); });

async function call(method, p, body, { secret = SECRET, ts = Date.now(), nonce = crypto.randomBytes(12).toString("hex"), tamper = false } = {}) {
  const data = body ? JSON.stringify(body) : "";
  const sig = M.sign(secret, { ts: String(ts), nonce, method, url: p, body: data });
  const r = await fetch(base + p, { method, headers: { "x-mc-ts": String(ts), "x-mc-nonce": nonce, "x-mc-sig": sig, ...(data ? { "Content-Type": "application/json" } : {}) },
                                    body: tamper ? data.replace("100", "101") : (data || undefined) });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, json: ct.includes("json") ? await r.json() : null };
}
const START = { rtmp: "rtmp://stream.publicaccess.tv/stage", key: "psABCDEFGHIJKLMNOP", ratingKey: "100", quality: 720, title: "Night" };

test("ipAllowed: v4 CIDRs, v6, v4-mapped", () => {
  assert.equal(M.ipAllowed("127.0.0.1", ["127.0.0.1/32"]), true);
  assert.equal(M.ipAllowed("::ffff:127.0.0.1", ["127.0.0.1/32"]), true);
  assert.equal(M.ipAllowed("10.1.2.3", ["10.0.0.0/8"]), true);
  assert.equal(M.ipAllowed("11.1.2.3", ["10.0.0.0/8"]), false);
  assert.equal(M.ipAllowed("100.64.1.2", ["100.64.0.0/10"]), true);
  assert.equal(M.ipAllowed("::1", ["::1"]), true);
  assert.equal(M.ipAllowed("fd00::5", ["fd00::/8"]), true);
  assert.equal(M.ipAllowed("garbage", ["0.0.0.0/0"]), false);
});

test("parseProbe: real ffprobe answers -> codec, 10-bit, HDR, Dolby Vision, interlacing, anamorphic SAR", () => {
  assert.deepEqual(PROBE["hevc10-hdr10-dv8"], { index: 0, codec: "hevc", profile: "Main 10", pixFmt: "yuv420p10le", width: 3840, height: 1920, sar: 1,
    interlaced: false, transfer: "smpte2084", hdr: true, dv: 8, dvCompat: 1, rotation: 0 });
  assert.equal(PROBE["mpeg2-dvd"].interlaced, true);
  assert.ok(Math.abs(PROBE["mpeg2-dvd"].sar - 8 / 9) < 1e-9);
  assert.equal(PROBE["h264-hi10"].pixFmt, "yuv420p10le");
  assert.equal(PROBE["hevc8-4k"].hdr, false);
  // cover art in front of the film, a phone video shot sideways, HLG
  const cover = M.parseProbe({ streams: [{ index: 0, codec_name: "mjpeg", width: 600, height: 600, disposition: { attached_pic: 1 } },
                                         { index: 1, codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080, disposition: { attached_pic: 0 } }] });
  assert.equal(cover.index, 1);
  const rot = M.parseProbe({ streams: [{ index: 0, codec_name: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] }] });
  assert.equal(rot.rotation, 270);
  assert.equal(M.parseProbe({ streams: [{ index: 0, codec_name: "hevc", pix_fmt: "yuv420p10le", color_transfer: "arib-std-b67" }] }).hdr, true);
  assert.equal(M.parseProbe({ streams: [] }), null);
  assert.equal(M.parseProbe(null), null);
});

test("pickModes: what the iGPU can decode goes on the GPU, the rest on the CPU, every ladder ends in libx264", () => {
  const it = ITEMS["100"];
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["h264-sd"]), ["hw", "hwdl", "sw", "x264"]);
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["hevc8-4k"]), ["hw", "hwdl", "sw", "x264"]);
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["av1-4k"]), ["hw", "hwdl", "sw", "x264"]);
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["mpeg2-dvd"]), ["hw", "hwdl", "sw", "x264"]);
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["hevc10-hdr10-dv8"]), ["hwdl", "sw", "x264"], "HDR: tone-mapped on the CPU");
  assert.deepEqual(M.pickModes(cfg, it, { sub: 2 }, PROBE["h264-sd"]), ["hwdl", "sw", "x264"], "burnt-in subtitles: drawn on the CPU");
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["h264-hi10"]), ["sw", "x264"], "H.264 Hi10P: no VA-API decoder");
  assert.deepEqual(M.pickModes(cfg, it, {}, PROBE["xvid"]), ["sw", "x264"], "MPEG-4 ASP: no VA-API decoder");
  assert.deepEqual(M.pickModes(cfg, it, {}, { ...PROBE["h264-sd"], rotation: 90 }), ["sw", "x264"], "rotated: ffmpeg's autorotate is CPU");
  assert.deepEqual(M.pickModes(cfg, it, {}, null), ["hw", "hwdl", "sw", "x264"], "no probe: try the GPU, the ladder catches it");
  assert.deepEqual(M.pickModes(cfg, { ...it, hdr: true }, {}, null), ["hwdl", "sw", "x264"], "no probe: Plex's HDR flag");
  assert.deepEqual(M.pickModes({ ...cfg, encoder: "x264" }, it, {}, PROBE["h264-sd"]), ["x264"]);
});

test("ffmpeg args: SDR on the GPU end to end, aspect kept, AAC, FLV to the RTMP url", () => {
  const a = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 0, quality: 720, url: "rtmp://x/stage/key" });
  const s = a.join(" ");
  assert.match(s, /-init_hw_device vaapi=va:\/dev\/dri\/renderD128 -filter_hw_device va -hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi/);
  assert.match(s, /-re -i /);
  assert.match(s, /\[0:v:0\]scale_vaapi=w=960:h=720:format=nv12\[v\]/);            // 1440x1080 (4:3) -> 960x720
  assert.ok(!s.includes("hwdownload") && !s.includes("tonemap"));
  assert.match(s, /-c:v h264_vaapi/);
  assert.ok(s.includes("-map 0:a:0?"));                                             // no track picked: the first audio track
  assert.ok(a.includes("-f") && a[a.length - 1] === "rtmp://x/stage/key");
  assert.ok(!s.includes("-ss"));
  // a 4K HEVC 8-bit source: GPU, scaled to 1080p
  assert.match(M.ffmpegArgs(cfg, ITEMS["100"], { quality: 1080, url: "u", probe: PROBE["hevc8-4k"] }).join(" "), /\[0:0\]scale_vaapi=w=1920:h=1080:format=nv12\[v\]/);
});

test("ffmpeg args: the 1.99ji bug - HDR10 / Dolby Vision is tone-mapped on the CPU (never tonemap_vaapi), capped at 720p", () => {
  const s = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 600, quality: 1080, audio: 1, url: "rtmp://x/y/k", probe: PROBE["hevc10-hdr10-dv8"] }).join(" ");
  assert.ok(!s.includes("tonemap_vaapi"), "Arrow Lake's iHD refuses tonemap_vaapi (error -22 / nothing written)");
  assert.match(s, /-ss 600\.000 -i /);
  // 3840x1920 -> 1440x720, decoded + shrunk on the GPU as 10-bit, tone-mapped on the CPU, back up for the GPU encoder
  assert.match(s, /\[0:0\]scale_vaapi=w=1440:h=720:format=p010,hwdownload,format=p010le,zscale=t=linear:npl=100:p=bt709,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=nv12,hwupload\[v\]/);
  assert.match(s, /-map 0:1 /);
  assert.match(s, /-c:v h264_vaapi/);
  // MEDIACTL_HDR_MAX_HEIGHT=1080 lets it through at 1080p
  assert.match(M.ffmpegArgs({ ...cfg, hdrMaxHeight: 1080 }, ITEMS["100"], { quality: 1080, url: "u", probe: PROBE["hevc10-hdr10-dv8"] }).join(" "), /scale_vaapi=w=2160:h=1080:format=p010/);
  // no probe: Plex's HDR flag does the same
  assert.match(M.ffmpegArgs(cfg, { ...ITEMS["100"], hdr: true }, { quality: 720, url: "u" }).join(" "), /format=p010,hwdownload,format=p010le,zscale=t=linear/);
  // the CPU fallbacks tone-map too
  assert.match(M.ffmpegArgs(cfg, ITEMS["100"], { quality: 720, url: "u", probe: PROBE["hevc10-hdr10-dv8"], mode: "sw" }).join(" "), /\[0:0\]scale=1440:720,zscale=t=linear.*format=nv12,hwupload\[v\]/);
  const x = M.ffmpegArgs(cfg, ITEMS["100"], { quality: 720, url: "u", probe: PROBE["hevc10-hdr10-dv8"], mode: "x264" }).join(" ");
  assert.match(x, /\[0:0\]scale=1440:720,zscale=t=linear.*format=yuv420p\[v\]/);
  assert.ok(!x.includes("vaapi"));
});

test("ffmpeg args: interlaced anamorphic DVD, Hi10P anime, XviD, a 4:3 source", () => {
  const d = M.ffmpegArgs(cfg, ITEMS["100"], { quality: 1080, url: "u", probe: PROBE["mpeg2-dvd"] }).join(" ");
  assert.match(d, /\[0:0\]deinterlace_vaapi,scale_vaapi=w=640:h=480:format=nv12\[v\]/, "720x480 at SAR 8:9 shows as 640x480");
  const dsw = M.ffmpegArgs(cfg, ITEMS["100"], { quality: 1080, url: "u", probe: PROBE["mpeg2-dvd"], mode: "sw" }).join(" ");
  assert.match(dsw, /\[0:0\]bwdif,scale=640:480,format=nv12,hwupload\[v\]/);
  const h = M.ffmpegArgs(cfg, ITEMS["100"], { quality: 1080, url: "u", probe: PROBE["h264-hi10"] }).join(" ");
  assert.ok(!h.includes("-hwaccel "), "Hi10P is decoded on the CPU");
  assert.match(h, /-init_hw_device vaapi=va:\/dev\/dri\/renderD128 -filter_hw_device va -re/);
  assert.match(h, /\[0:0\]scale=1548:1080,format=nv12,hwupload\[v\]/);
  const v = M.ffmpegArgs(cfg, ITEMS["100"], { quality: 720, url: "u", probe: PROBE["xvid"] }).join(" ");
  assert.match(v, /\[0:0\]scale=640:480,format=nv12,hwupload\[v\]/, "never upscaled");
  assert.deepEqual(M.outSize(M.QUALITY[1080], { width: 3840, height: 1600 }, null), { w: 2592, h: 1080 });
  assert.deepEqual(M.outSize(M.QUALITY[1080], { width: 7680, height: 1080 }, null), { w: 4096, h: 576 }, "at most 4096 wide");
  assert.deepEqual(M.outSize(M.QUALITY[720], {}, { width: 1080, height: 1920, sar: 1, rotation: 90 }), { w: 1280, h: 720 }, "rotated: the sides swap");
  assert.deepEqual(M.outSize(M.QUALITY[480], { width: 853, height: 481 }, null), { w: 852, h: 480 }, "even sides");
});

test("ffmpeg args: burnt-in subtitles after the GPU shrank the picture; seek keeps subtitle timing; image subs scaled + overlaid", () => {
  const a = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 120, quality: 480, sub: 2, url: "rtmp://x/y/k", srcLink: "/run/mediactl/stage.mkv" }).join(" ");
  assert.match(a, /-hwaccel vaapi -hwaccel_device va -hwaccel_output_format vaapi -re -ss 120\.000 -copyts -i \/run\/mediactl\/stage\.mkv/);
  assert.match(a, /scale_vaapi=w=640:h=480:format=nv12,hwdownload,format=nv12,subtitles=filename=.*stage\.mkv:si=0,setpts=PTS-STARTPTS,format=nv12,hwupload\[v\]/);
  assert.match(a, /-af asetpts=PTS-STARTPTS/);
  const b = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 0, quality: 720, sub: 3, url: "rtmp://x/y/k" }).join(" ");
  assert.match(b, /\[0:3\]scale=960:720\[sb\];\[0:v:0\]scale_vaapi=w=960:h=720:format=nv12,hwdownload,format=nv12\[pic\];\[pic\]\[sb\]overlay=eof_action=pass,format=nv12,hwupload\[v\]/);
  // HDR + subtitles: tone-map first, then draw the (SDR) subtitles
  const c = M.ffmpegArgs(cfg, ITEMS["100"], { quality: 720, sub: 2, url: "u", srcLink: "/l.mkv", probe: PROBE["hevc10-hdr10-dv8"] }).join(" ");
  assert.match(c, /tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,subtitles=filename=/);
  const x = M.ffmpegArgs({ ...cfg, encoder: "x264" }, ITEMS["100"], { quality: 720, url: "rtmp://x/y/k" }).join(" ");
  assert.match(x, /-c:v libx264 -preset veryfast/);
  assert.ok(!x.includes("vaapi"));
});

test("fallback ladder: a mode that dies before the first frame falls through to the next; a network error doesn't", async () => {
  const lp = [];
  const spawn2 = (c, a) => { const p = fakeSpawn(c, a); lp.push(p); return p; };
  probeAnswer = PROBE["hevc10-hdr10-dv8"];
  const st = M.makeStreams(cfg, fakePlex, spawn2, () => T, fakeProbe);
  await st.start("fb.Room", START);
  assert.equal(st.get("fb.Room").mode, "hwdl");
  assert.equal(st.get("fb.Room").source.hdr, true);
  assert.match(lp[0].args.join(" "), /-hwaccel vaapi/);
  lp[0].stderr.write("[vost#0:0/h264_vaapi @ 0x1] Task finished with error code: -22 (Invalid argument)\n");
  await new Promise((r) => setImmediate(r));
  lp[0].emit("exit", 234);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(lp.length, 2, "relaunched straight away");
  const v = st.get("fb.Room");
  assert.equal(v.state, "playing");
  assert.equal(v.mode, "sw");
  assert.equal(v.fallbacks[0].mode, "hwdl");
  assert.ok(!lp[1].args.includes("-hwaccel"));
  // the sw one runs (frames out), then dies mid-film: an ordinary restart in the SAME mode, not a fallback
  lp[1].stdout.write("out_time_us=60000000\n");
  await new Promise((r) => setImmediate(r));
  T += 60000;
  lp[1].emit("exit", 1);
  assert.equal(st.get("fb.Room").mode, "sw");
  st.stopAll();
  // an RTMP refusal before the first frame is not the filter graph's fault: error, no fallback
  const st2 = M.makeStreams(cfg, fakePlex, spawn2, () => T, fakeProbe);
  await st2.start("fb2.Room", START);
  const n = lp.length;
  lp[n - 1].stderr.write("[flv @ 0x1] rtmp://stream.publicaccess.tv/stage/psABCDEFGHIJKLMNOP: Connection refused\n");
  await new Promise((r) => setImmediate(r));
  lp[n - 1].emit("exit", 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(lp.length, n);
  assert.equal(st2.get("fb2.Room").state, "error");
  assert.equal(st2.get("fb2.Room").mode, "hwdl");
  st2.stopAll();
  // the whole ladder failing ends in an error with x264's last words
  const st3 = M.makeStreams(cfg, fakePlex, spawn2, () => T, fakeProbe);
  probeAnswer = PROBE["xvid"];
  await st3.start("fb3.Room", START);
  for (let i = 0; i < 2; i++) {
    const p = lp[lp.length - 1];
    p.stderr.write(`boom ${i}\n`);
    await new Promise((r) => setImmediate(r));
    p.emit("exit", 1);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  const e3 = st3.get("fb3.Room");
  assert.equal(e3.state, "error");
  assert.equal(e3.mode, "x264");
  assert.match(e3.error, /boom 1/);
  st3.stopAll();
  probeAnswer = null;
});

test("probeFile runs ffprobe with mediactl's entries and survives it failing", async () => {
  const seen = [];
  const fx = (cmd, args, o, cb) => { seen.push([cmd, args]); cb(null, JSON.stringify(FIX("h264-sd"))); };
  const p = await M.probeFile(cfg, "/mnt/x.mkv", fx);
  assert.equal(p.codec, "h264");
  assert.equal(seen[0][0], "ffprobe");
  assert.equal(seen[0][1][seen[0][1].length - 1], "/mnt/x.mkv");
  assert.equal(await M.probeFile(cfg, "/x", (c, a, o, cb) => cb(new Error("ENOENT"))), null);
  assert.equal(await M.probeFile(cfg, "/x", (c, a, o, cb) => cb(null, "not json")), null);
});
test("escFilter escapes a path for a filtergraph option", () => {
  assert.equal(M.escFilter("/a/b's:c[1].mkv"), "/a/b\\\\\\'s\\\\:c\\[1\\].mkv");
});

test("auth: /health is open, everything else needs a valid, fresh, unused signature", async () => {
  const h = await fetch(base + "/health").then((r) => r.json());
  assert.equal(h.ok, true);
  assert.equal(h.plex, true);
  assert.equal((await call("GET", "/streams", null, { secret: "w".repeat(40) })).status, 401);
  assert.equal((await call("GET", "/streams", null, { ts: Date.now() - 10 * 60000 })).status, 401);
  const nonce = "abcdefghijklmnop1234";
  assert.equal((await call("GET", "/streams", null, { nonce })).status, 200);
  assert.equal((await call("GET", "/streams", null, { nonce })).status, 401, "a replayed nonce is refused");
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", START, { tamper: true })).status, 401, "a changed body breaks the signature");
});

test("search + item + poster go through Plex", async () => {
  const s = await call("GET", "/search?q=night");
  assert.equal(s.status, 200);
  assert.equal(s.json.results[0].key, "100");
  assert.equal((await call("GET", "/search?q=n")).status, 400);
  const i = await call("GET", "/item/100");
  assert.equal(i.json.item.title, "Night of the Living Dead");
  assert.equal((await call("GET", "/item/999")).status, 404);
  const p = await call("GET", "/poster/100");
  assert.equal(p.status, 200);
});

test("start: one stream per stage, guards on the RTMP target, the key, the file's folder, a show", async () => {
  procs.length = 0;
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", { ...START, rtmp: "rtmp://evil.example/stage" })).status, 400);
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", { ...START, key: "a b" })).status, 400);
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", { ...START, ratingKey: "101" })).status, 403, "outside the media roots");
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", { ...START, ratingKey: "102" })).status, 400, "a show has no file");
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", { ...START, sub: 9 })).status, 400, "unknown subtitle track");
  assert.equal(procs.length, 0);
  const r = await call("PUT", "/streams/PepeFrog.Room", START);
  assert.equal(r.status, 200);
  assert.equal(r.json.stream.state, "playing");
  assert.equal(procs.length, 1);
  assert.equal(lastProc().args[lastProc().args.length - 1], "rtmp://stream.publicaccess.tv/stage/psABCDEFGHIJKLMNOP");
  assert.equal((await call("PUT", "/streams/PepeFrog.Room", START)).status, 409, "one per stage");
  // progress from ffmpeg's -progress output
  lastProc().stdout.write("frame=10\nout_time_us=30000000\nprogress=continue\n");
  await new Promise((r2) => setImmediate(r2));
  const st = await call("GET", "/streams");
  assert.equal(st.json.streams[0].position, 30);
  assert.equal(st.json.streams[0].duration, 5760);
});

test("max streams: a second stage is fine, a third is refused (MEDIACTL_MAX_STREAMS=2)", async () => {
  assert.equal((await call("PUT", "/streams/other.Room", START)).status, 200);
  assert.equal((await call("PUT", "/streams/third.Room", START)).status, 429);
  assert.equal((await call("POST", "/streams/other.Room/stop", {})).status, 200);
});

test("pause keeps the position, resume and seek restart ffmpeg at the right offset, stop forgets", async () => {
  const before = procs.length;
  const p = await call("POST", "/streams/PepeFrog.Room/pause", {});
  assert.equal(p.json.stream.state, "paused");
  assert.equal(p.json.stream.position, 30);
  assert.equal((await call("POST", "/streams/PepeFrog.Room/pause", {})).status, 409);
  const r = await call("POST", "/streams/PepeFrog.Room/resume", {});
  assert.equal(r.json.stream.state, "playing");
  assert.equal(procs.length, before + 1);
  assert.ok(lastProc().args.join(" ").includes("-ss 30.000"));
  const s = await call("POST", "/streams/PepeFrog.Room/seek", { offset: 3600 });
  assert.equal(s.json.stream.offset, 3600);
  assert.ok(lastProc().args.join(" ").includes("-ss 3600.000"));
  const x = await call("POST", "/streams/PepeFrog.Room/stop", {});
  assert.equal(x.json.stream.state, "stopped");
  assert.equal((await call("GET", "/streams")).json.streams.length, 0);
});

test("ffmpeg ending at the end of the file = ended; dying straight away = error with its last lines (keys masked)", async () => {
  await call("PUT", "/streams/PepeFrog.Room", START);
  let p = lastProc();
  p.stdout.write("out_time_us=5760000000\n");
  await new Promise((r) => setImmediate(r));
  p.emit("exit", 0);
  assert.equal((await call("GET", "/streams/PepeFrog.Room")).json.stream.state, "ended");
  await call("POST", "/streams/PepeFrog.Room/stop", {});
  await call("PUT", "/streams/PepeFrog.Room", START);
  p = lastProc();
  p.stderr.write("rtmp://stream.publicaccess.tv/stage/psABCDEFGHIJKLMNOP: I/O error\n");
  await new Promise((r) => setImmediate(r));
  p.emit("exit", 1);
  const st = (await call("GET", "/streams/PepeFrog.Room")).json.stream;
  assert.equal(st.state, "error");
  assert.ok(!st.error.includes("psABCDEFGHIJKLMNOP"), "the stream key is not in the error");
  await call("POST", "/streams/PepeFrog.Room/stop", {});
});

test("an allow-list miss is a bare 403", async () => {
  const cfg2 = { ...cfg, allow: ["10.0.0.0/8"] };
  const { server: s2 } = M.makeServer(cfg2, { plex: fakePlex, streams: M.makeStreams(cfg2, fakePlex, fakeSpawn) });
  await new Promise((r) => s2.listen(0, "127.0.0.1", r));
  const r = await fetch(`http://127.0.0.1:${s2.address().port}/health`);
  assert.equal(r.status, 403);
  s2.close();
});

test("makePlex parses Plex's JSON: hub search, a movie's part + streams, a show's episodes; the token goes in a header", async () => {
  const seen = [];
  const fake = async (url, o) => {
    seen.push({ url, token: o.headers["X-Plex-Token"] });
    const u = new URL(url);
    if (u.pathname === "/hubs/search") return { status: 200, json: { MediaContainer: { Hub: [
      { type: "movie", Metadata: [{ ratingKey: 100, type: "movie", title: "Night", year: 1968, duration: 5760000, thumb: "/t" }] },
      { type: "show", Metadata: [{ ratingKey: 200, type: "show", title: "Show", leafCount: 10 }] },
      { type: "artist", Metadata: [{ ratingKey: 9, type: "artist", title: "Band" }] }] } } };
    if (u.pathname === "/library/metadata/100") return { status: 200, json: { MediaContainer: { Metadata: [{ ratingKey: 100, type: "movie", title: "Night", year: 1968,
      Media: [{ duration: 5760000, width: 1920, height: 1080, Part: [{ file: "/mnt/O/movies/Night.mkv", duration: 5760000, Stream: [
        { streamType: 1, index: 0, codec: "hevc", colorTrc: "smpte2084" },
        { streamType: 2, index: 1, codec: "eac3", displayTitle: "English (EAC3 5.1)", languageCode: "eng", selected: true },
        { streamType: 3, index: 2, codec: "subrip", displayTitle: "English (SRT)" },
        { streamType: 3, index: 3, codec: "hdmv_pgs_subtitle", displayTitle: "French (PGS)" },
        { streamType: 3, codec: "srt", key: "/library/streams/77", displayTitle: "External" }] }] }] }] } } };
    if (u.pathname === "/library/metadata/200") return { status: 200, json: { MediaContainer: { Metadata: [{ ratingKey: 200, type: "show", title: "Show" }] } } };
    if (u.pathname === "/library/metadata/200/allLeaves") return { status: 200, json: { MediaContainer: { Metadata: [
      { ratingKey: 201, type: "episode", title: "Pilot", grandparentTitle: "Show", parentIndex: 1, index: 1, duration: 1800000 }] } } };
    return { status: 404, json: null };
  };
  const P = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok" }, fake);
  const s = await P.search("night");
  assert.deepEqual(s.map((x) => [x.key, x.type]), [["100", "movie"], ["200", "show"]]);
  const it = await P.item("100");
  assert.equal(it.file, "/mnt/O/movies/Night.mkv");
  assert.equal(it.duration, 5760);
  assert.equal(it.hdr, true);
  assert.deepEqual(it.audio.map((a) => [a.index, a.default]), [[1, true]]);
  assert.deepEqual(it.subs.map((x) => [x.index, x.rel, x.image, x.burnable]), [[2, 0, false, true], [3, 1, true, true]], "external subtitles are left out");
  const sh = await P.item("200");
  assert.equal(sh.episodes[0].key, "201");
  assert.equal(sh.episodes[0].episode, 1);
  await assert.rejects(P.item("999"), (e) => e.status === 404);
  assert.ok(seen.every((x) => x.token === "tok" && !x.url.includes("tok")), "the token never goes in the URL");
});

test("1.2.0: Plex shares from plex.tv (ids, names, no tokens) and removing one only when the share belongs to that Plex user", async () => {
  const seen = [];
  const xml = '<MediaContainer><SharedServer id="40000001" username="sharer1" email="g@x.test" userID="50000001" accessToken="SECRETTOK" name="Gang &amp; Co" acceptedAt="1700000192" invitedAt="1700000190" allLibraries="1"></SharedServer>' +
              '<SharedServer id="42" username="pend" email="" userID="77" accessToken="T2" acceptedAt="0" invitedAt="1700000000" allLibraries="0"/></MediaContainer>';
  const fake = async (url, o) => {
    seen.push({ url, method: o.method || "GET", token: o.headers["X-Plex-Token"] });
    if (url.endsWith("/identity")) return { status: 200, json: { MediaContainer: { machineIdentifier: "abcdef0123456789" } } };
    if (/\/api\/servers\/abcdef0123456789\/shared_servers$/.test(url) && (o.method || "GET") === "GET") {
      // the real request() keeps only 500 characters of a non-JSON answer: the share list must be read raw
      const long = " ".repeat(2000) + xml;
      return o.raw ? { status: 200, headers: {}, body: Buffer.from(long) } : { status: 200, json: null, text: long.slice(0, 500) };
    }
    if (/shared_servers\/40000001$/.test(url) && o.method === "DELETE") return { status: 200, json: null, text: "" };
    return { status: 404, json: null, text: "" };
  };
  const P = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok", plexTv: "https://plex.example" }, fake);
  const s = await P.shares();
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].share_id, s[0].plex_id, s[0].username, s[0].title, s[0].pending], ["40000001", "50000001", "sharer1", "Gang & Co", false]);
  assert.equal(s[1].pending, true);
  assert.ok(!JSON.stringify(s).includes("SECRETTOK"), "access tokens are never returned");
  await assert.rejects(P.removeShare("40000001", "999"), (e) => e.status === 409, "the share must belong to that Plex user");
  await assert.rejects(P.removeShare("5", "50000001"), (e) => e.status === 404);
  assert.equal(seen.filter((x) => x.method === "DELETE").length, 0);
  const r = await P.removeShare("40000001", "50000001");
  assert.equal(r.removed, true);
  assert.equal(seen.filter((x) => x.method === "DELETE").length, 1);
  assert.ok(seen.every((x) => x.token === "tok" && !x.url.includes("tok")), "the token is a header, never in the URL");
});

test("1.3.0: the server OWNER from plex.tv api/v2/user - id, username, title only (never its token or email), cached", async () => {
  const seen = [];
  const fake = async (url, o) => {
    seen.push(url);
    if (url === "https://plex.example/api/v2/user") {
      const xml = '<?xml version="1.0"?><user id="9000001" uuid="u1" username="plantbaked" title="Plant &amp; Baked" email="owner@x.test" authToken="OWNERSECRET">' +
                  '<subscription active="1"/><profile/></user>';
      return { status: 200, headers: {}, body: Buffer.from(xml) };
    }
    return { status: 404, json: null, text: "" };
  };
  const P = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok", plexTv: "https://plex.example" }, fake);
  const o = await P.owner();
  assert.deepEqual(o, { plex_id: "9000001", username: "plantbaked", title: "Plant & Baked" });
  assert.ok(!JSON.stringify(o).includes("OWNERSECRET") && !JSON.stringify(o).includes("owner@x.test"));
  await P.owner();
  assert.equal(seen.length, 1, "cached");
  const bad = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok", plexTv: "https://plex.example" },
    async () => ({ status: 200, headers: {}, body: Buffer.from("<html>nope</html>") }));
  await assert.rejects(bad.owner(), (e) => e.status === 502);
});
