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

// ── 1.99acx: "seeking just ends the stream" (The Observance, 2026-10-18) ──
// an ffmpeg that only exits when the test says so (a real one takes a fraction of a second after SIGTERM - notice it on its 0.5 s
// stats tick, flush, close the RTMP publish - and the SIGKILL comes at 4 s)
function slowSpawnInto(list) {
  return (cmd, args) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.args = args; p.signals = [];
    p.kill = (sig) => { p.signals.push(sig); };
    list.push(p);
    return p;
  };
}
const nextTick = () => new Promise((r) => setImmediate(r));
// what ffmpeg 7.1 prints when nginx-rtmp refuses a publish on a stream name that's still held ("Server error: <nginx's onStatus
// description>", then EPERM = "Operation not permitted" - what prod's nginx did to stageaudio's repair, site 1.99abc)
const ALREADY = "[rtmp @ 0x55d1c0a3e2c0] Server error: Already publishing\n" +
                "[out#0/flv @ 0x55d1c0a3d140] Error opening output rtmp://stream.publicaccess.tv/stage/stage-0123456789abcdef?k=psABCDEFGHIJKLMNOP: Operation not permitted\n" +
                "Error opening output file rtmp://stream.publicaccess.tv/stage/stage-0123456789abcdef?k=psABCDEFGHIJKLMNOP.\n";

test("1.99acx: a seek launches the new ffmpeg only after the old one has EXITED; overlapping seeks collapse; a stop meanwhile wins", async () => {
  const lp = [];
  const st = M.makeStreams({ ...cfg, exitWaitMs: 3000 }, fakePlex, slowSpawnInto(lp), () => T, async () => null);
  await st.start("sk.Room", START);
  assert.equal(lp.length, 1);
  lp[0].stdout.write("out_time_us=600000000\n");                 // 10 minutes in
  await nextTick();
  const sk = st.seek("sk.Room", 3000);                             // the timeline clicked half-way
  await nextTick(); await nextTick();
  assert.equal(lp.length, 1, "nothing new while the old ffmpeg still holds the stage's stream name");
  assert.deepEqual(lp[0].signals, ["SIGTERM"]);
  assert.equal(st.get("sk.Room").state, "playing", "it already reads playing at the new place");
  assert.equal(st.get("sk.Room").offset, 3000);
  const sk2 = st.seek("sk.Room", 4000);                            // clicked again before it came back
  lp[0].emit("exit", 255);
  const [, v2] = await Promise.all([sk, sk2]);
  assert.equal(lp.length, 2, "one new ffmpeg, for the last seek");
  assert.match(lp[1].args.join(" "), /-ss 4000\.000/);
  assert.deepEqual([v2.state, v2.offset], ["playing", 4000]);
  lp[1].stdout.write("out_time_us=5000000\n");
  await nextTick();
  assert.equal(st.get("sk.Room").position, 4005, "the old ffmpeg's exit didn't touch the new one");
  // a stop while a seek waits: nothing starts
  const sk3 = st.seek("sk.Room", 100);
  st.stop("sk.Room");
  lp[1].emit("exit", 255);
  await sk3;
  assert.equal(lp.length, 2);
  assert.equal(st.get("sk.Room"), null);
  // a 📼 queue's next title: the PUT right after a stop waits for the stopped ffmpeg too
  await st.start("sk.Room", START);
  assert.equal(lp.length, 3);
  st.stop("sk.Room");
  const nx = st.start("sk.Room", { ...START, offset: 60 });
  await nextTick(); await nextTick();
  assert.equal(lp.length, 3, "the next title waits");
  lp[2].emit("exit", 255);
  await nx;
  assert.equal(lp.length, 4);
  assert.match(lp[3].args.join(" "), /-ss 60\.000/);
  // resume right after pause waits as well
  st.pause("sk.Room");
  const rs = st.resume("sk.Room");
  await nextTick();
  assert.equal(lp.length, 4);
  lp[3].emit("exit", 255);
  assert.equal((await rs).state, "playing");
  assert.equal(lp.length, 5);
  // an old ffmpeg that ignores SIGTERM: the wait is capped (the SIGKILL follows at 4 s anyway)
  const lq = [];
  const st2 = M.makeStreams({ ...cfg, exitWaitMs: 30 }, fakePlex, slowSpawnInto(lq), () => T, async () => null);
  await st2.start("cap.Room", START);
  await st2.seek("cap.Room", 200);
  assert.equal(lq.length, 2, "launched after the cap");
  st.stopAll(); st2.stopAll();
  for (const p of [...lp, ...lq]) p.emit("exit", 255);
});

test("1.99acx: 'Already publishing' from the ingest is tried again in a moment - same mode, no fallback, not an error - then gives up", async () => {
  const lp = [];
  const sp = (c, a) => { const p = fakeSpawn(c, a); lp.push(p); return p; };
  const st = M.makeStreams({ ...cfg, pubRetryMs: 5 }, fakePlex, sp, () => T, async () => null);
  const refuse = async (p, text = ALREADY) => { p.stderr.write(text); await nextTick(); p.emit("exit", 1); await nextTick(); };
  const wait = () => new Promise((r) => setTimeout(r, 25));
  await st.start("pb.Room", START);
  assert.equal(st.get("pb.Room").mode, "hw");
  await refuse(lp[0]);
  assert.equal(st.get("pb.Room").state, "playing", "waiting to try again, not an error");
  await wait();
  assert.equal(lp.length, 2, "tried again");
  assert.equal(st.get("pb.Room").mode, "hw", "the same mode: the ingest's refusal isn't the GPU's fault");
  assert.equal(st.get("pb.Room").fallbacks.length, 0);
  // it gets going: the budget is whole again for the next time
  lp[1].stdout.write("out_time_us=2000000\n");
  await nextTick();
  assert.equal(st.get("pb.Room").position, 2);
  st.stopAll();
  // still refused after PUB_RETRIES tries: an error (the key masked), as before
  await st.start("pb.Room", START);
  for (let i = 0; i < 9; i++) { await refuse(lp[lp.length - 1]); await wait(); }
  const v = st.get("pb.Room");
  assert.equal(v.state, "error");
  assert.match(v.error, /Already publishing/);
  assert.ok(!v.error.includes("psABCDEFGHIJKLMNOP"), "the stream key is not in the error");
  st.stopAll();
  // any other refusal before the first frame is still an error at once (a cut slot's key, a dead ingest)
  await st.start("pb.Room", START);
  const n = lp.length;
  await refuse(lp[n - 1], "[out#0/flv @ 0x1] Error opening output rtmp://stream.publicaccess.tv/stage/psABCDEFGHIJKLMNOP: Input/output error\n");
  await wait();
  assert.equal(lp.length, n);
  assert.equal(st.get("pb.Room").state, "error");
  st.stopAll();
});

test("1.99acx: a pause / seek meanwhile voids a pending relaunch - the 'Already publishing' retry, the mode fallback, the blip restart", async (t) => {
  const lp = [];
  const sp = (c, a) => { const p = fakeSpawn(c, a); lp.push(p); return p; };
  let clk = T;
  const st = M.makeStreams({ ...cfg, pubRetryMs: 20 }, fakePlex, sp, () => clk, async () => null);
  const wait = () => new Promise((r) => setTimeout(r, 60));
  const refuse = async (p) => { p.stderr.write(ALREADY); await nextTick(); p.emit("exit", 1); await nextTick(); };
  // the ingest refused it, a retry is pending: a pause meanwhile wins - nothing starts by itself
  await st.start("v.Room", START);
  await refuse(lp[0]);
  st.pause("v.Room");
  await wait();
  assert.equal(lp.length, 1, "the pending retry started nothing");
  assert.equal(st.get("v.Room").state, "paused");
  // ...and a seek meanwhile: exactly one new ffmpeg, the seek's
  await st.resume("v.Room");
  assert.equal(lp.length, 2);
  await refuse(lp[1]);
  await st.seek("v.Room", 1234);
  assert.equal(lp.length, 3);
  await wait();
  assert.equal(lp.length, 3, "the older retry is void");
  assert.match(lp[2].args.join(" "), /-ss 1234\.000/);
  st.stop("v.Room");
  // a mode fallback pending (setImmediate) when a seek comes in: ONE launch - the fallback's mode, at the seek's place
  await st.start("v.Room", START);
  let n = lp.length;
  assert.equal(st.get("v.Room").mode, "hw");
  lp[n - 1].stderr.write("[vost#0:0/h264_vaapi @ 0x1] Task finished with error code: -22 (Invalid argument)\n");
  await nextTick();
  lp[n - 1].emit("exit", 234);                                    // hw failed -> hwdl next, on the next turn
  await st.seek("v.Room", 2000);                                  // ...but the seek came first
  await nextTick(); await nextTick();
  assert.equal(lp.length, n + 1, "one new ffmpeg, not two");
  assert.match(lp[n].args.join(" "), /-ss 2000\.000/);
  assert.equal(st.get("v.Room").mode, "hwdl");
  st.stop("v.Room");
  // a blip restart pending (2 s) when a seek comes in: ONE launch
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    await st.start("v.Room", START);
    n = lp.length;
    lp[n - 1].stdout.write("out_time_us=60000000\n");
    await nextTick();
    clk += 60000;
    lp[n - 1].stderr.write("[flv @ 0x1] Broken pipe\n");
    await nextTick();
    lp[n - 1].emit("exit", 1);                                    // it ran a minute: a network blip -> again in 2 s
    await st.seek("v.Room", 3000);
    assert.equal(lp.length, n + 1);
    t.mock.timers.tick(2000);
    await nextTick();
    assert.equal(lp.length, n + 1, "the blip restart is void");
    assert.equal(st.get("v.Room").state, "playing");
    assert.match(lp[n].args.join(" "), /-ss 3000\.000/);
  } finally {
    st.stopAll();
    t.mock.timers.reset();
  }
  for (const p of lp) p.emit("exit", 255);
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
      { ratingKey: 201, type: "episode", title: "Pilot", grandparentTitle: "Show", grandparentRatingKey: 200, parentRatingKey: 210, parentIndex: 1, index: 1, duration: 1800000 }] } } };
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
  assert.deepEqual([sh.episodes[0].show_key, sh.episodes[0].season_key], ["200", "210"], "1.4.0: where the episode sits (📼 queues)");
  assert.equal(sh.show_key, null);
  await assert.rejects(P.item("999"), (e) => e.status === 404);
  assert.ok(seen.every((x) => x.token === "tok" && !x.url.includes("tok")), "the token never goes in the URL");
});

test("1.2.0: Plex shares from plex.tv (ids, names, no tokens) and removing one only when the share belongs to that Plex user", async () => {
  const seen = [];
  const xml = '<MediaContainer><SharedServer id="40000001" username="sharer1" email="g@x.test" userID="50000001" accessToken="SECRETTOK" name="Gang &amp; Co" acceptedAt="1700000192" invitedAt="1700000190" allLibraries="1"></SharedServer>' +
              '<SharedServer id="42" username="pend" email="" userID="77" accessToken="T2" acceptedAt="0" invitedAt="1700000000" allLibraries="0"/></MediaContainer>';
  const fake = async (url, o) => {
    seen.push({ url, method: o.method || "GET", token: o.headers["X-Plex-Token"] });
    if (url.endsWith("/identity")) return { status: 200, json: { MediaContainer: { machineIdentifier: "abcdef0123456789", version: "1.43.4.10903-e5521bd8c" } } };
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
    if (url.endsWith("/identity")) return { status: 200, json: { MediaContainer: { machineIdentifier: "abcdef0123456789", version: "1.43.4.10903-e5521bd8c" } } };
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
    async (url, o) => (url.endsWith("/identity") ? fake(url, o) : { status: 200, headers: {}, body: Buffer.from("<html>nope</html>") }));
  await assert.rejects(bad.owner(), (e) => e.status === 502 && /owner/.test(e.message));
});

test("1.6.0 (site 1.99acx): plex.tv calls go out AS the server (its machine id, product, real version) - never mediactl's own name/version on the server's token", async () => {
  // plex.tv copies X-Plex-Version onto the device that owns the token; PLEX_TOKEN is the server's own, so "PATV mediactl" 1.5.0
  // made plex.tv list the 1.43 server as Plex Media Server 1.5.0 and the Plex apps (1.41.2+) called it outdated
  let t = 1_000_000, version = "1.43.4.10903-e5521bd8c", identityAsXml = false;
  const seen = [];
  const fake = async (url, o) => {
    seen.push({ url, h: o.headers });
    if (url.endsWith("/identity")) {
      if (identityAsXml) {   // an XML answer: the version is the MediaContainer's, not the <?xml version="1.0"?> declaration's
        const x = `<?xml version="1.0" encoding="UTF-8"?>\n<MediaContainer size="0" apiVersion="1.2.3" claimed="1" machineIdentifier="abcdef0123456789" version="${version}">\n</MediaContainer>`;
        return { status: 200, json: null, text: x };
      }
      return { status: 200, json: { MediaContainer: { size: 0, apiVersion: "1.2.3", claimed: true, machineIdentifier: "abcdef0123456789", version } } };
    }
    if (url === "https://plex.example/api/v2/user") return { status: 200, headers: {}, body: Buffer.from('<user id="9000001" username="pb" title="pb" authToken="X"/>') };
    if (/\/api\/servers\/abcdef0123456789\/shared_servers$/.test(url)) return { status: 200, headers: {}, body: Buffer.from("<MediaContainer/>") };
    if (url.startsWith("http://127.0.0.1:32400/hubs/search")) return { status: 200, json: { MediaContainer: { Hub: [] } } };
    return { status: 404, json: null, text: "" };
  };
  const P = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok", plexTv: "https://plex.example" }, fake, () => t);
  await P.shares();
  await P.owner();
  await P.search("night");
  const tvCalls = seen.filter((x) => x.url.startsWith("https://plex.example/"));
  assert.equal(tvCalls.length, 2);
  for (const c of tvCalls) {
    assert.equal(c.h["X-Plex-Client-Identifier"], "abcdef0123456789", "the server's machine identifier");
    assert.equal(c.h["X-Plex-Product"], "Plex Media Server");
    assert.equal(c.h["X-Plex-Version"], "1.43.4.10903-e5521bd8c", "the server's REAL version");
    assert.equal(c.h["X-Plex-Token"], "tok");
    assert.ok(!/mediactl/i.test(JSON.stringify(c.h)) && c.h["X-Plex-Version"] !== M.VERSION, "never mediactl's own name or version");
  }
  // the local Plex still sees "PATV mediactl" (those requests never reach plex.tv)
  const local = seen.find((x) => x.url.includes("/hubs/search"));
  assert.equal(local.h["X-Plex-Product"], "PATV mediactl");
  assert.equal(seen.filter((x) => x.url.endsWith("/identity")).length, 1, "the identity is cached");
  // a Plex update while mediactl runs: the new version is used once the cache is older than 10 minutes
  version = "1.43.5.11000-aaaaaaaaa";
  t += 9 * 60 * 1000;
  await P.shares();
  assert.equal(seen[seen.length - 1].h["X-Plex-Version"], "1.43.4.10903-e5521bd8c", "still cached");
  t += 2 * 60 * 1000;
  identityAsXml = true;
  await P.shares();
  assert.equal(seen[seen.length - 1].h["X-Plex-Version"], "1.43.5.11000-aaaaaaaaa", "re-read after 10 minutes (XML answer read right)");
  assert.equal(await P.machineId(), "abcdef0123456789");
  // Plex restarting (an update) when the cache runs out: the last good identity carries on, and the next call reads it again
  identityAsXml = false;
  let plexDown = true;
  const P2 = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok", plexTv: "https://plex.example" },
    async (url, o) => { if (plexDown && url.endsWith("/identity")) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); return fake(url, o); }, () => t);
  await assert.rejects(P2.shares(), /ECONNREFUSED/, "no identity ever read: nothing to fall back on");
  plexDown = false;
  await P2.shares();
  t += 11 * 60 * 1000;
  plexDown = true;
  version = "1.43.6.12000-bbbbbbbbb";
  await P2.shares();
  assert.equal(seen[seen.length - 1].h["X-Plex-Version"], "1.43.5.11000-aaaaaaaaa", "Plex down: the last good identity is used");
  plexDown = false;
  await P2.shares();
  assert.equal(seen[seen.length - 1].h["X-Plex-Version"], "1.43.6.12000-bbbbbbbbb", "Plex back: read again at once");
  // no readable version -> nothing goes to plex.tv at all (never stamp a guess)
  const noVer = async (url, o) => (url.endsWith("/identity") ? { status: 200, json: { MediaContainer: { machineIdentifier: "abcdef0123456789" } } } : fake(url, o));
  const sent = [];
  const Q = M.makePlex({ plexUrl: "http://127.0.0.1:32400", plexToken: "tok", plexTv: "https://plex.example" },
    async (url, o) => { sent.push(url); return noVer(url, o); });
  await assert.rejects(Q.owner(), (e) => e.status === 502 && /version/.test(e.message));
  await assert.rejects(Q.shares(), (e) => e.status === 502);
  assert.ok(!sent.some((u) => u.startsWith("https://plex.example/")), "plex.tv was never called");
  assert.equal(await Q.machineId(), "abcdef0123456789", "the machine id alone still reads");
});

// 1.7.0 / handoff 36: invented library data, exercised through the real Plex adapter and signed HTTP routes.
function clerkPlexFixture() {
  const movie = (key, section, title) => ({
    ratingKey: String(key), librarySectionID: section, type: "movie", title, year: 2004,
    originallyAvailableAt: "2004-03-14", addedAt: 1700000000, updatedAt: 1700001000,
    duration: 5400000, summary: "An invented story. ".repeat(90), tagline: "A paper moon rises.",
    Genre: [{ tag: "Mystery" }, { tag: "Comedy" }], contentRating: "PG", rating: 7.4, audienceRating: 8.1,
    studio: "Imaginary Lantern Studio", Director: [1, 2, 3, 4].map(n => ({ tag: `Director ${n}` })),
    Role: Array.from({ length: 8 }, (_, n) => ({ tag: `Performer ${n + 1}` })),
    Country: ["Cedarland", "Willowland", "Birchland", "Oaklandia"].map(tag => ({ tag })),
    Guid: [{ id: "imdb://tt9000001" }, { id: "tmdb://900001" }, { id: "tvdb://900002" }],
    thumb: `/library/metadata/${key}/thumb/1`,
    Media: [{ width: 1280, height: 720, container: "mkv", Part: [{ file: FILE, duration: 5400000,
      Stream: [{ streamType: 1, index: 0, codec: "h264" }, { streamType: 2, index: 1, codec: "aac" }] }] }],
  });
  const items = {
    "7101": movie("7101", "71", "Paper Moon Picnic"),
    "7102": movie("7102", "71", "Lantern Post Office"),
    "7201": movie("7201", "72", "Synthetic Hidden Adult Film"),
    "7301": movie("7301", "73", "Synthetic Hidden Off Film"),
    "7401": movie("7401", undefined, "Synthetic Unknown Section Film"),
    "7110": { ratingKey: "7110", librarySectionID: "71", type: "show", title: "Clockwork Orchard", leafCount: 4 },
    "7115": { ratingKey: "7115", librarySectionID: "71", type: "season", title: "Season One", parentRatingKey: "7110", leafCount: 4 },
  };
  for (const [key, section] of [["7111", "71"], ["7211", "72"], ["7311", "73"], ["7411", undefined]]) {
    items[key] = { ...movie(key, section, `Invented Episode ${key}`), type: "episode", grandparentTitle: "Clockwork Orchard",
      grandparentRatingKey: "7110", parentRatingKey: "7115", parentIndex: 1, index: 2, duration: 1800000 };
  }
  const state = {
    items,
    sections: [
      { key: "71", title: "Cedar Screen", type: "movie" },
      { key: "72", title: "Synthetic Adult Section Name", type: "movie" },
      { key: "73", title: "Synthetic Off Section Name", type: "show" },
    ],
    search: ["7101", "7201", "7301", "7401", "7110"],
    leaves: ["7111", "7211", "7311", "7411"],
    catalog: ["7101", "7102", "7201", "7301", "7401", "7111"],
    collections: [
      { ratingKey: "7150", librarySectionID: "71", type: "collection", title: "Cedar Favourites", childCount: 5 },
      { ratingKey: "7250", librarySectionID: "72", type: "collection", title: "Synthetic Adult Collection" },
      { ratingKey: "7350", librarySectionID: "73", type: "collection", title: "Synthetic Off Collection" },
      { ratingKey: "7450", type: "collection", title: "Cedar Lanterns" },
    ],
    members: ["7101", "7201", "7301", "7401", "7102"], seen: [],
  };
  const response = value => ({ status: 200, json: { MediaContainer: JSON.parse(JSON.stringify(value)) } });
  const page = (u, opts, rows, container = {}) => {
    const h = opts.headers || {};
    const start = Number(u.searchParams.get("X-Plex-Container-Start") || h["X-Plex-Container-Start"] || 0);
    const size = Number(u.searchParams.get("X-Plex-Container-Size") || h["X-Plex-Container-Size"] || rows.length || 1);
    return response({ ...container, Metadata: rows.slice(start, start + size), totalSize: rows.length, offset: start,
      size: rows.slice(start, start + size).length });
  };
  // Plex 1.43.4 as checked against the real server (CT 102 loopback sidecar, 2026-11-07): the listing endpoints - a show's
  // /allLeaves, /library/sections/<id>/all, a section's /collections, a collection's /children - put librarySectionID ONCE, on
  // the MediaContainer; the rows carry none of their own (0 of 381 rows checked). With state.plex143 the fake answers the same
  // way: the rows of the listing's own section lose their id and the container carries it (a number, as Plex's JSON has it);
  // a row of ANOTHER section keeps its own id (so a cross-section row stays detectable). state.containerSection = null leaves
  // the container without an id too (no id anywhere); a string makes the container claim that section. state.bareItems does
  // the same to /library/metadata/<key> (real Plex keeps an id on those rows; mediactl must not depend on it).
  const listing = (natural, rows, on = state.plex143) => {
    if (!on) return { rows, container: {} };
    const own = natural == null ? null : String(natural);
    const out = rows.map(m => {
      if (!m || own == null || String(m.librarySectionID) !== own) return m;
      const { librarySectionID, ...rest } = m;
      return rest;
    });
    const claimed = state.containerSection === undefined ? own : state.containerSection;
    return { rows: out, container: claimed == null ? {} : { librarySectionID: Number(claimed) } };
  };
  // What Plex 1.43 reads as an "updated at least" filter: the key updatedAt>> or updatedAt> (on the wire updatedAt%3E%3E= /
  // updatedAt%3E=, or literal). A KEY spelled "updatedAt>=" - URLSearchParams encodes its own "=", updatedAt%3E%3D=<since> - is
  // no filter Plex knows: it answers the whole section (the 1.7.0 defect: total 15871 where Plex's own filter gives 125).
  // A field may carry a type prefix (movie. / show. / episode.). Without one, a TV library means the SHOW's field - plexapi
  // documents it as "in a TV show library viewCount is assumed to be show.viewCount", so an episode read (type=4) with
  // a bare updatedAt filters on each episode's show; episode.updatedAt is the episode's own.
  const plexSince = (u, type) => {
    for (const [key, v] of u.searchParams) {
      const f = /^(?:(movie|show|episode)\.)?updatedAt>>?$/.exec(key);
      if (f) return { since: Number(v), on: f[1] || (type === "episode" ? "show" : type) };
    }
    return null;
  };
  const updatedOn = (m, on) => (on === "show" && m.type === "episode" ? (items[m.grandparentRatingKey] || {}).updatedAt : m.updatedAt);
  state.request = async (url, opts = {}) => {
    const u = new URL(url);
    state.seen.push({ url, path: u.pathname, query: u.searchParams, headers: opts.headers || {}, at: performance.now() });
    // Plex not answering (restarting for an update, crashed, stalled) or answering with an error: state.down = "refused",
    // "stall" (no answer until the request's own timeout runs out) or an HTTP status
    if (state.down === "refused") throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:32400"), { code: "ECONNREFUSED" });
    if (state.down === "stall") return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), opts.timeout ?? 15000));
    if (typeof state.down === "number") return { status: state.down, json: null, text: "" };
    if (u.pathname === "/hubs/search") return response({ ...(state.searchContainerSection != null ? { librarySectionID: Number(state.searchContainerSection) } : {}),
      Hub: [{ type: "movie", Metadata: state.search.map(k => items[k]) }] });
    if (u.pathname === "/library/sections") return response({ Directory: state.sections });
    let match;
    if ((match = /^\/library\/sections\/(\d+)\/all$/.exec(u.pathname))) {
      const type = { 1: "movie", 2: "show", 4: "episode" }[u.searchParams.get("type")];
      const since = plexSince(u, type);
      const all = state.catalog.map(k => items[k]).filter(m => (state.ignoreCatalogType || !type || m.type === type) && (since == null || updatedOn(m, since.on) >= since.since));
      const { rows, container } = listing(match[1], all);
      if (state.ignoreCatalogBounds) return response({ ...container, Metadata: rows, totalSize: rows.length, offset: 0, size: rows.length });
      return page(u, opts, rows, container);
    }
    if ((match = /^\/library\/sections\/(\d+)\/collections$/.exec(u.pathname))) {
      const { rows, container } = listing(match[1], state.collections);
      return page(u, opts, rows, container);
    }
    if ((match = /^\/library\/(?:metadata|collections)\/(\d+)\/children$/.exec(u.pathname))) {
      const header = state.collections.find(c => c.ratingKey === match[1]);
      const { rows, container } = listing(header && header.librarySectionID != null ? header.librarySectionID : "71", state.members.map(k => items[k]));
      return page(u, opts, rows, container);
    }
    if ((match = /^\/library\/metadata\/(\d+)\/allLeaves$/.exec(u.pathname))) {
      const parent = items[match[1]];
      const { rows, container } = listing(parent && parent.librarySectionID, state.leaves.map(k => items[k]));
      return response({ ...container, Metadata: rows });
    }
    if ((match = /^\/library\/metadata\/(\d+)$/.exec(u.pathname))) {
      const item = items[match[1]] || state.collections.find(c => c.ratingKey === match[1]);
      if (!item) return { status: 404 };
      const { rows, container } = listing(item.librarySectionID, [item], !!state.bareItems);
      return response({ ...container, Metadata: rows });
    }
    if (u.pathname === "/photo/:/transcode") return { status: 200, headers: { "content-type": "image/jpeg" }, body: Buffer.from([255, 216, 255]) };
    return { status: 404 };
  };
  return state;
}

// The filter keys Plex itself reads from a request: it splits the raw query on "&" and on each pair's FIRST raw "=", then
// decodes the key (so updatedAt%3E%3E=5 is the key "updatedAt>>", and updatedAt%3E%3D=5 is the key "updatedAt>=").
function plexQueryKeys(url) {
  const raw = new URL(url).search.replace(/^\?/, "");
  return raw ? raw.split("&").map(pair => {
    const i = pair.indexOf("=");
    return [decodeURIComponent(i < 0 ? pair : pair.slice(0, i)), i < 0 ? "" : decodeURIComponent(pair.slice(i + 1))];
  }) : [];
}
const isUpdatedAt = (k) => /^(?:[a-z]+\.)?updatedAt/.test(k);
function assertPlexSince(url, since, keys = ["updatedAt>>", "updatedAt>"]) {
  const raw = new URL(url).search;
  assert.ok(!/updatedAt%3E%3D=/i.test(raw), `the since filter's own "=" was encoded (Plex ignores updatedAt%3E%3D=): ${raw}`);
  const filters = plexQueryKeys(url).filter(([k]) => isUpdatedAt(k));
  assert.equal(filters.length, 1, `exactly one updatedAt filter: ${raw}`);
  assert.ok(keys.includes(filters[0][0]), `Plex reads ${keys.map(k => k + "=").join(" or ")}, got key ${JSON.stringify(filters[0][0])}`);
  assert.equal(filters[0][1], String(since));
}

async function clerkHarness(t, env = {}, extra = {}) {
  const fixture = clerkPlexFixture();
  const config = { ...M.loadConfig({ MEDIACTL_SECRET: SECRET, MEDIACTL_ALLOW: "127.0.0.1/32,::1", PLEX_TOKEN: "invented-fixture-token",
    PLEX_URL: "http://plex.invalid", MEDIACTL_MEDIA_ROOTS: media + path.sep,
    MEDIACTL_RTMP_ALLOW: "rtmp://stream.publicaccess.tv/", MEDIACTL_SECTIONS: "71,72", MEDIACTL_SECTIONS_ADULT: "72", ...env }), ...extra };
  const plex = M.makePlex(config, fixture.request);
  const spawned = [];
  const spawn = (cmd, args) => {
    const p = new EventEmitter();
    p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.args = args; p.killed = false;
    p.kill = sig => { if (p.killed) return; p.killed = true; setImmediate(() => p.emit("exit", null, sig)); };
    spawned.push(p); return p;
  };
  const streamSet = M.makeStreams(config, plex, spawn, Date.now, async () => null);
  const local = M.makeServer(config, { plex, streams: streamSet }).server;
  await new Promise(resolve => local.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${local.address().port}`;
  t.after(async () => { streamSet.stopAll(); local.closeIdleConnections(); await new Promise(resolve => local.close(resolve)); });
  const request = async (method, route, body, auth = {}) => {
    const data = body == null ? "" : JSON.stringify(body);
    const ts = String(auth.ts ?? Date.now()), nonce = auth.nonce || crypto.randomBytes(12).toString("hex");
    const sig = M.sign(auth.secret || SECRET, { ts, nonce, method, url: route, body: data });
    const r = await fetch(origin + route, { method, headers: {
      "x-mc-ts": ts, "x-mc-nonce": nonce, "x-mc-sig": sig,
      ...(data ? { "Content-Type": "application/json" } : {}),
    }, body: data || undefined });
    const buffer = Buffer.from(await r.arrayBuffer());
    return { status: r.status, json: (r.headers.get("content-type") || "").includes("json") ? JSON.parse(buffer.toString()) : null,
      body: buffer, headers: r.headers };
  };
  return { fixture, plex, request, streamSet, spawned, origin };
}

function assertClerkNoDeniedMetadata(value) {
  const json = JSON.stringify(value);
  for (const marker of ["Synthetic Hidden", "Synthetic Unknown", "Synthetic Adult", "Synthetic Off", "Invented Episode 7211", "Invented Episode 7311", "Invented Episode 7411"])
    assert.ok(!json.includes(marker), `denied metadata escaped: ${marker}`);
}

test("1.7.0: search, item, nested episodes and posters share the fail-closed section policy", async t => {
  const h = await clerkHarness(t);
  const search = await h.request("GET", "/search?q=paper&include_adult=1");
  assert.equal(search.status, 200);
  assert.deepEqual(search.json.results.map(r => r.key), ["7101", "7110"]);
  assert.ok(search.json.results.every(r => r.section === "71"));
  assertClerkNoDeniedMetadata(search.json);
  for (const key of ["7201", "7301", "7401"]) {
    await assert.rejects(h.plex.item(key), e => e.status === 404, "direct item reads must also enforce policy");
    const item = await h.request("GET", `/item/${key}?include_adult=1`);
    const poster = await h.request("GET", `/poster/${key}?include_adult=1`);
    assert.equal(item.status, 404); assert.equal(poster.status, 404);
    assertClerkNoDeniedMetadata([item.json, poster.json]);
  }
  assert.equal(h.fixture.seen.filter(c => c.path === "/photo/:/transcode").length, 0, "denied posters never fetch image bytes");
  for (const key of ["7110", "7115"]) {
    const item = await h.request("GET", `/item/${key}`);
    assert.equal(item.status, 200);
    assert.deepEqual(item.json.item.episodes.map(r => r.key), ["7111"]);
    assert.equal(item.json.item.episodes[0].section, "71");
    assertClerkNoDeniedMetadata(item.json);
  }
  assert.equal((await h.request("GET", "/poster/7101")).status, 200);
  assert.equal((await h.request("GET", "/item/7101")).json.item.section, "71");
  h.fixture.items["7101"].librarySectionID = "72";
  assert.equal((await h.request("GET", "/item/7101")).status, 404, "a remembered key is rechecked after its section changes");
  assert.equal((await h.request("GET", "/poster/7101")).status, 404);
});

test("1.7.0: an adult-only policy still fails closed for unknown sections", async t => {
  const h = await clerkHarness(t, { MEDIACTL_SECTIONS: "", MEDIACTL_SECTIONS_ADULT: "72" });
  const r = await h.request("GET", "/search?q=paper");
  assert.deepEqual(r.json.results.map(x => x.key), ["7101", "7301", "7110"]);
  assert.equal((await h.request("GET", "/item/7401")).status, 404);
  assert.equal((await h.request("GET", "/item/7201")).status, 404);
  assert.equal((await h.request("GET", "/item/7301")).status, 200, "an empty allow list preserves other legacy sections");
});

test("1.7.0: stream start, resume and seek recheck the current section before spawning", async t => {
  const h = await clerkHarness(t);
  for (const key of ["7201", "7301", "7401"]) {
    const r = await h.request("PUT", "/streams/policy-start", { ...START, ratingKey: key, title: "Invented stream" });
    assert.equal(r.status, 404); assertClerkNoDeniedMetadata(r.json);
  }
  assert.equal(h.spawned.length, 0);
  for (const section of ["72", "73", undefined]) {
    h.fixture.items["7101"].librarySectionID = "71";
    assert.equal((await h.request("PUT", "/streams/policy-resume", { ...START, ratingKey: "7101", title: "Invented stream" })).status, 200);
    assert.equal((await h.request("POST", "/streams/policy-resume/pause")).status, 200);
    const before = h.spawned.length;
    const reads = h.fixture.seen.filter(c => c.path === "/library/metadata/7101").length;
    h.fixture.items["7101"].librarySectionID = section;
    assert.equal((await h.request("POST", "/streams/policy-resume/resume")).status, 404);
    assert.equal(h.spawned.length, before, "no cached file may restart after policy denies its current section");
    assert.ok(h.fixture.seen.filter(c => c.path === "/library/metadata/7101").length > reads);
    await h.request("DELETE", "/streams/policy-resume");
  }
  h.fixture.items["7101"].librarySectionID = "71";
  assert.equal((await h.request("PUT", "/streams/policy-seek", { ...START, ratingKey: "7101", title: "Invented stream" })).status, 200);
  const before = h.spawned.length;
  h.fixture.items["7101"].librarySectionID = "72";
  assert.equal((await h.request("POST", "/streams/policy-seek/seek", { offset: 60 })).status, 404);
  assert.equal(h.spawned.length, before);
});

test("1.7.0: section discovery masks denied titles and adult wins over the allow list", async t => {
  const h = await clerkHarness(t);
  const r = await h.request("GET", "/sections");
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.equal(r.json.allow_list_set, true);
  assert.deepEqual(r.json.sections.map(s => [s.id, s.title, s.policy]), [
    ["71", "Cedar Screen", "allowed"], ["72", "(hidden)", "adult"], ["73", "(hidden)", "off"],
  ]);
  assert.ok(r.json.sections.every(s => ["movie", "show"].includes(s.type) && Number.isInteger(s.count) && s.count >= 0));
  assertClerkNoDeniedMetadata(r.json);
  for (const section of ["72", "73", "999"]) {
    for (const route of [`/catalog?section=${section}&type=1`, `/collections?section=${section}`]) {
      const before = h.fixture.seen.length;
      const denied = await h.request("GET", route + "&include_adult=1");
      assert.equal(denied.status, 404); assertClerkNoDeniedMetadata(denied.json);
      assert.equal(h.fixture.seen.length, before, "a denied section is rejected before Plex is queried");
    }
  }
});

test("1.7.0: catalog pages expose bounded metadata, delta filters and no source file paths", async t => {
  const h = await clerkHarness(t);
  h.fixture.catalog = ["7101", "7102", "7201", "7301", "7401"];
  const first = await h.request("GET", "/catalog?section=71&type=1&start=0&size=1&since=1700000000");
  assert.equal(first.status, 200); assert.equal(first.json.total, 5); assert.equal(first.json.next, 1);
  assert.equal(first.json.rows.length, 1);
  const row = first.json.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ["key", "type", "title", "year", "aired", "added", "updated", "duration", "summary", "tagline",
    "genres", "content_rating", "rating", "audience_rating", "studio", "directors", "cast", "countries", "imdb", "tmdb", "tvdb",
    "show_key", "season_key", "show", "season", "episode", "section"].sort());
  assert.deepEqual([row.key, row.type, row.title, row.year, row.aired, row.added, row.updated, row.duration, row.section],
    ["7101", "movie", "Paper Moon Picnic", 2004, "2004-03-14", 1700000000, 1700001000, 5400, "71"]);
  assert.deepEqual([row.imdb, String(row.tmdb), String(row.tvdb)], ["tt9000001", "900001", "900002"]);
  assert.deepEqual([row.rating, row.audience_rating, row.content_rating, row.studio, row.tagline],
    [7.4, 8.1, "PG", "Imaginary Lantern Studio", "A paper moon rises."]);
  assert.deepEqual(row.genres, ["Mystery", "Comedy"]);
  assert.equal(row.summary.length, 1000); assert.equal(row.directors.length, 3); assert.equal(row.cast.length, 6); assert.equal(row.countries.length, 3);
  const second = await h.request("GET", "/catalog?section=71&type=1&start=1&size=5000");
  assert.equal(second.status, 200); assert.deepEqual(second.json.rows.map(r => r.key), ["7102"]); assert.equal(second.json.next, null);
  assertClerkNoDeniedMetadata(second.json);
  const sent = h.fixture.seen.filter(c => c.path === "/library/sections/71/all");
  assertPlexSince(sent[0].url, 1700000000);
  assert.ok(!plexQueryKeys(sent[1].url).some(([k]) => isUpdatedAt(k)), "no since: no updatedAt filter at all");
  assert.equal(sent[0].query.get("type"), "1");
  assert.equal(Number(sent[0].query.get("X-Plex-Container-Size") || sent[0].headers["X-Plex-Container-Size"]), 1);
  assert.equal(Number(sent[1].query.get("X-Plex-Container-Start") || sent[1].headers["X-Plex-Container-Start"]), 1);
  assert.ok(Number(sent[1].query.get("X-Plex-Container-Size") || sent[1].headers["X-Plex-Container-Size"]) <= 500);
  for (const answer of [first.json, second.json]) {
    assert.ok(!JSON.stringify(answer).includes('"file"') && !JSON.stringify(answer).includes(FILE));
    assert.ok(!JSON.stringify(answer).includes("invented-fixture-token"));
  }
  h.fixture.catalog = ["7111"];
  const ep = await h.request("GET", "/catalog?section=71&type=4&size=10");
  assert.equal(ep.status, 200); assert.equal(ep.json.rows[0].summary.length, 500);
  assert.deepEqual([ep.json.rows[0].show_key, ep.json.rows[0].season_key, ep.json.rows[0].show, ep.json.rows[0].season, ep.json.rows[0].episode],
    ["7110", "7115", "Clockwork Orchard", 1, 2]);
  h.fixture.catalog = ["7110"];
  assert.equal((await h.request("GET", "/catalog?section=71&type=2")).json.rows[0].type, "show");
  h.fixture.catalog = ["7101", "7111", "7102", "7110"];
  h.fixture.ignoreCatalogType = true;
  const mixed = await h.request("GET", "/catalog?section=71&type=1&size=500");
  assert.equal(mixed.status, 200); assert.deepEqual(mixed.json.rows.map(r => r.key), ["7101", "7102"],
    "a broken upstream type filter cannot return episodes or shows in a movie page");
  h.fixture.ignoreCatalogBounds = true;
  const oversized = await h.request("GET", "/catalog?section=71&type=1&size=1");
  assert.equal(oversized.status, 200); assert.deepEqual(oversized.json.rows.map(r => r.key), ["7101"],
    "the requested page bound still holds when Plex sends an oversized response");
  for (const query of ["section=71&type=9", "section=bad&type=1", "type=1"]) {
    const before = h.fixture.seen.length;
    const bad = await h.request("GET", "/catalog?" + query);
    assert.ok(bad.status >= 400 && bad.status < 500); assert.equal(h.fixture.seen.length, before);
  }
});

test("1.7.0: collections omit denied shelves and members, and never expose source metadata", async t => {
  const h = await clerkHarness(t);
  const r = await h.request("GET", "/collections?section=71");
  assert.equal(r.status, 200); assert.equal(r.json.collections.length, 2);
  assert.deepEqual(r.json.collections[0], { key: "7150", title: "Cedar Favourites", count: 2, members: ["7101", "7102"] });
  assert.deepEqual(r.json.collections[1], { key: "7450", title: "Cedar Lanterns", count: 2, members: ["7101", "7102"] },
    "a collection header can inherit its reviewed section; its members still need their own section");
  assertClerkNoDeniedMetadata(r.json);
  assert.ok(!JSON.stringify(r.json).includes('"file"') && !JSON.stringify(r.json).includes(FILE));
  assert.ok(!h.fixture.seen.some(c => /\/(7250|7350)\/children$/.test(c.path)), "denied collection member lists are never fetched");
});

test("1.7.0: collection members are capped at 2000 and cannot cross into another allowed section", async t => {
  const h = await clerkHarness(t, { MEDIACTL_SECTIONS: "71,72,73" });
  h.fixture.collections = [h.fixture.collections[0]];
  h.fixture.members = ["7301", "7401"];
  for (let n = 0; n < 2003; n++) {
    const key = String(800000 + n);
    h.fixture.items[key] = { ratingKey: key, librarySectionID: "71", type: "movie", title: `Invented Catalogue Film ${n}` };
    h.fixture.members.push(key);
  }
  const r = await h.request("GET", "/collections?section=71");
  assert.equal(r.status, 200);
  assert.equal(r.json.collections[0].count, 2000); assert.equal(r.json.collections[0].members.length, 2000);
  assert.ok(!r.json.collections[0].members.includes("7301"), "a different allowed section still cannot contaminate this section's shelf");
  assert.ok(!r.json.collections[0].members.includes("7401"));
  assert.deepEqual(r.json.collections[0].members, Array.from({ length: 2000 }, (_, n) => String(800000 + n)));
});

test("1.7.0: an empty allow list disables catalog and collections but preserves legacy search shape", async t => {
  const h = await clerkHarness(t, { MEDIACTL_SECTIONS: "", MEDIACTL_SECTIONS_ADULT: "" });
  for (const route of ["/catalog?section=71&type=1", "/collections?section=71"]) {
    const r = await h.request("GET", route);
    assert.equal(r.status, 503); assert.deepEqual(r.json, { ok: false, error: "set MEDIACTL_SECTIONS" });
  }
  assert.equal(h.fixture.seen.length, 0, "no catalog data fetched without an explicit allow list");
  const r = await h.request("GET", "/search?q=paper");
  assert.equal(r.status, 200);
  const expected = h.fixture.search.map(key => {
    const m = h.fixture.items[key];
    return { key, type: m.type, title: m.title || "", year: m.year || null, show: m.grandparentTitle || null,
      season: m.parentIndex != null ? m.parentIndex : null, episode: m.index != null && m.type === "episode" ? m.index : null,
      duration: m.duration ? Math.round(m.duration / 1000) : null, poster: !!(m.thumb || m.grandparentThumb || m.parentThumb),
      leafs: m.leafCount || null, show_key: null, season_key: null };
  });
  const withoutSection = r.json.results.map(({ section, ...legacy }) => legacy);
  assert.equal(JSON.stringify(withoutSection), JSON.stringify(expected), "the only new search field is section");
  assert.deepEqual(r.json.results.map(x => x.section), ["71", "72", "73", null, "71"]);
  assert.equal((await h.request("GET", "/item/7401")).status, 200, "unknown section preserves legacy behavior only with both lists empty");
  const sections = await h.request("GET", "/sections");
  assert.equal(sections.json.allow_list_set, false);
});

test("1.7.0: catalog, sections and collections share one four-per-second Plex request budget", async t => {
  const h = await clerkHarness(t);
  const routes = ["/catalog?section=71&type=1&size=1&start=0", "/sections", "/collections?section=71",
    "/catalog?section=71&type=1&size=1&start=1", "/catalog?section=71&type=1&size=1&start=0",
    "/catalog?section=71&type=1&size=1&start=1"];
  const answers = await Promise.all(routes.map(route => h.request("GET", route)));
  assert.ok(answers.every(r => r.status === 200));
  const at = h.fixture.seen.filter(c => /^\/library\/(sections|collections)\b/.test(c.path)).map(c => c.at);
  assert.ok(at.length >= 6, "all catalog, section and collection requests were observed");
  for (let i = 4; i < at.length; i++) assert.ok(at[i] - at[i - 4] >= 990, `more than four calls within one second: ${at[i] - at[i - 4]}ms`);
});

test("1.7.0: new routes retain signing and replay protection, and unsupported routes retain the 404 feature signal", async t => {
  const h = await clerkHarness(t);
  for (const route of ["/sections", "/catalog?section=71&type=1", "/collections?section=71"]) {
    assert.equal((await fetch(h.origin + route)).status, 401);
    assert.equal((await h.request("GET", route, undefined, { secret: "wrong" })).status, 401);
    assert.equal((await h.request("GET", route, undefined, { ts: Date.now() - 600000 })).status, 401);
  }
  assert.equal(h.fixture.seen.length, 0, "unauthenticated requests never reach Plex");
  const nonce = crypto.randomBytes(12).toString("hex");
  const first = await h.request("GET", "/search?q=paper", undefined, { nonce });
  const repeated = await h.request("GET", "/search?q=paper", undefined, { nonce });
  assert.equal(first.status, 200); assert.equal(repeated.status, 401);
  const missing = await h.request("GET", "/unsupported-feature");
  assert.equal(missing.status, 404); assert.deepEqual(missing.json, { ok: false, error: "not found" });
});

// ── 1.7.0 against Plex 1.43's real answer shape (the pre-install check, 2026-11-07, real Plex 1.43.4 in a loopback sidecar):
// listing rows carry no librarySectionID of their own - only the MediaContainer does - and a since filter must reach Plex as
// updatedAt>>= (URLSearchParams turned "updatedAt>=" into updatedAt%3E%3D=, which Plex ignores). The fake: state.plex143. ──
function addOrchardEpisodes(fixture) {
  for (const [key, index] of [["7112", 3], ["7113", 4]])
    fixture.items[key] = { ...fixture.items["7111"], ratingKey: key, title: `Orchard Episode ${index}`, index };
}

test("1.7.0 on Plex 1.43: a show's and a season's episodes come back although allLeaves rows only carry the container's section", async t => {
  const h = await clerkHarness(t);
  h.fixture.plex143 = true;
  addOrchardEpisodes(h.fixture);
  h.fixture.leaves = ["7111", "7112", "7113", "7211"];
  // the fake answers like the real server: the container has the id, the show's own rows have none
  const raw = await h.fixture.request("http://plex.invalid/library/metadata/7110/allLeaves");
  assert.equal(raw.json.MediaContainer.librarySectionID, 71);
  assert.equal(raw.json.MediaContainer.Metadata.filter(m => m.librarySectionID != null).length, 1, "only the other section's row has an id of its own");
  for (const key of ["7110", "7115"]) {
    const r = await h.request("GET", `/item/${key}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.item.episodes.length, 3, `${key}: every episode of the show, not 0`);
    assert.deepEqual(r.json.item.episodes.map(e => [e.key, e.episode, e.season, e.section, e.show_key, e.season_key]), [
      ["7111", 2, 1, "71", "7110", "7115"], ["7112", 3, 1, "71", "7110", "7115"], ["7113", 4, 1, "71", "7110", "7115"]]);
    assertClerkNoDeniedMetadata(r.json);   // 7211 keeps its own (adult) id: a row's own id wins over the container's
  }
  // no policy at all (1.6.0's behaviour): the same episodes, labelled with the section they inherit
  const legacy = await clerkHarness(t, { MEDIACTL_SECTIONS: "", MEDIACTL_SECTIONS_ADULT: "" });
  legacy.fixture.plex143 = true;
  addOrchardEpisodes(legacy.fixture);
  legacy.fixture.leaves = ["7111", "7112", "7113"];
  const lr = await legacy.request("GET", "/item/7110");
  assert.deepEqual(lr.json.item.episodes.map(e => [e.key, e.section]), [["7111", "71"], ["7112", "71"], ["7113", "71"]]);
});

test("1.7.0 on Plex 1.43: catalog pages fill from rows that only carry the container's section", async t => {
  const h = await clerkHarness(t);
  h.fixture.plex143 = true;
  addOrchardEpisodes(h.fixture);
  h.fixture.catalog = ["7101", "7102", "7201", "7301"];
  const all = await h.request("GET", "/catalog?section=71&type=1&size=500");
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.rows.map(r => [r.key, r.type, r.section]), [["7101", "movie", "71"], ["7102", "movie", "71"]]);
  assert.deepEqual([all.json.total, all.json.next], [4, null]);
  assertClerkNoDeniedMetadata(all.json);   // rows of other sections keep their own ids and are dropped
  const pages = [];
  for (let start = 0, guard = 0; start != null && guard < 10; guard++) {
    const p = await h.request("GET", `/catalog?section=71&type=1&size=1&start=${start}`);
    assert.equal(p.status, 200);
    pages.push(p.json.rows.map(r => r.key));
    start = p.json.next;
  }
  assert.deepEqual(pages, [["7101"], ["7102"], [], []], "paging walks Plex's pages; only the section's own rows fill them");
  h.fixture.catalog = ["7111", "7112", "7113"];
  const eps = await h.request("GET", "/catalog?section=71&type=4&size=500");
  assert.deepEqual(eps.json.rows.map(r => [r.key, r.section, r.show_key, r.season_key, r.episode]),
    [["7111", "71", "7110", "7115", 2], ["7112", "71", "7110", "7115", 3], ["7113", "71", "7110", "7115", 4]]);
  h.fixture.catalog = ["7110"];
  assert.deepEqual((await h.request("GET", "/catalog?section=71&type=2")).json.rows.map(r => [r.key, r.type, r.section]), [["7110", "show", "71"]]);
});

test("1.7.0 on Plex 1.43: a since (delta) read reaches Plex as updatedAt>>= and comes back narrowed", async t => {
  for (const plex143 of [false, true]) {   // rows with their own ids (the since filter alone) and Plex 1.43's real shape
    const h = await clerkHarness(t);
    h.fixture.plex143 = plex143;
    h.fixture.items["7102"].updatedAt = 1600000000;   // untouched since long before the last sync
    h.fixture.catalog = ["7101", "7102"];
    const delta = await h.request("GET", "/catalog?section=71&type=1&since=1700000000");
    assert.equal(delta.status, 200);
    const sent = h.fixture.seen.filter(c => c.path === "/library/sections/71/all");
    assert.equal(sent.length, 1);
    assertPlexSince(sent[0].url, 1700000000);
    assert.equal(delta.json.total, 1, `plex143=${plex143}: Plex narrowed the read to what changed since (not the whole section)`);
    assert.deepEqual([delta.json.rows.map(r => r.key), delta.json.next], [["7101"], null]);
    const full = await h.request("GET", "/catalog?section=71&type=1");
    assert.deepEqual([full.json.total, full.json.rows.map(r => r.key)], [2, ["7101", "7102"]]);
    assert.ok(!plexQueryKeys(h.fixture.seen[h.fixture.seen.length - 1].url).some(([k]) => isUpdatedAt(k)), "a full read carries no updatedAt filter");
    const before = h.fixture.seen.length;
    assert.equal((await h.request("GET", "/catalog?section=71&type=1&since=yesterday")).status, 400);
    assert.equal(h.fixture.seen.length, before, "a bad since never reaches Plex");
  }
});

test("1.7.0 on Plex 1.43: an inherited section goes through the same fail-closed policy - adult / off denied, no id anywhere denied", async t => {
  const h = await clerkHarness(t);   // MEDIACTL_SECTIONS 71,72 + MEDIACTL_SECTIONS_ADULT 72: 72 adult (adult wins), 73 off
  h.fixture.plex143 = true;
  h.fixture.bareItems = true;        // /library/metadata/<key> rows without their own id too
  addOrchardEpisodes(h.fixture);
  const transcodes = () => h.fixture.seen.filter(c => c.path === "/photo/:/transcode").length;
  const item = await h.request("GET", "/item/7101");
  assert.equal(item.status, 200);
  assert.equal(item.json.item.section, "71", "an allowed item's row inherits the container's section");
  assert.equal((await h.request("GET", "/poster/7101")).status, 200);
  const shown = transcodes();
  for (const key of ["7201", "7301", "7211", "7311"]) {
    const it = await h.request("GET", `/item/${key}`), poster = await h.request("GET", `/poster/${key}`);
    assert.equal(it.status, 404, `item ${key}`); assert.equal(poster.status, 404, `poster ${key}`);
    assertClerkNoDeniedMetadata([it.json, poster.json]);
  }
  assert.equal(transcodes(), shown, "a denied poster never fetches image bytes");
  assert.equal((await h.request("PUT", "/streams/inherit-start", { ...START, ratingKey: "7201", title: "Invented stream" })).status, 404);
  assert.equal(h.spawned.length, 0, "nothing starts from an inherited adult section");
  // a listing whose container names a denied section: rows without their own id are denied with it
  h.fixture.bareItems = false;
  h.fixture.containerSection = "72";
  h.fixture.catalog = ["7101", "7102"]; h.fixture.leaves = ["7111", "7112", "7113"]; h.fixture.members = ["7101", "7102"];
  const cat = await h.request("GET", "/catalog?section=71&type=1");
  assert.equal(cat.status, 200); assert.deepEqual(cat.json.rows, []); assert.equal(cat.json.total, 2);
  const show = await h.request("GET", "/item/7110");
  assert.equal(show.status, 200); assert.deepEqual(show.json.item.episodes, []);
  const col = await h.request("GET", "/collections?section=71");
  assert.equal(col.status, 200); assert.deepEqual(col.json.collections, [], "shelves the container puts in the adult section are left out");
  for (const r of [cat, show, col]) assertClerkNoDeniedMetadata(r.json);
  // no id anywhere (neither the row nor its container): fail closed
  h.fixture.containerSection = null;
  const cat0 = await h.request("GET", "/catalog?section=71&type=1");
  assert.deepEqual(cat0.json.rows, []); assert.equal(cat0.json.total, 2);
  assert.deepEqual((await h.request("GET", "/item/7110")).json.item.episodes, []);
  assert.deepEqual((await h.request("GET", "/collections?section=71")).json.collections.map(c => [c.key, c.members]), [["7150", []], ["7450", []]],
    "a header may still inherit its reviewed section; members with no section anywhere never do");
  h.fixture.bareItems = true;
  assert.equal((await h.request("GET", "/item/7101")).status, 404);
  assert.equal((await h.request("GET", "/poster/7101")).status, 404);
  assert.equal(transcodes(), shown);
  // an adult-only policy: other sections keep working when inherited, adult and unknown are still refused
  const a = await clerkHarness(t, { MEDIACTL_SECTIONS: "", MEDIACTL_SECTIONS_ADULT: "72" });
  a.fixture.plex143 = true; a.fixture.bareItems = true;
  const off = await a.request("GET", "/item/7301");
  assert.equal(off.status, 200); assert.equal(off.json.item.section, "73");
  assert.equal((await a.request("GET", "/item/7201")).status, 404);
  a.fixture.containerSection = null;
  assert.equal((await a.request("GET", "/item/7301")).status, 404, "no id anywhere fails closed with either list set");
});

test("1.7.0 on Plex 1.43: collection members fill from children that only carry the container's section", async t => {
  const h = await clerkHarness(t);
  h.fixture.plex143 = true;
  h.fixture.members = ["7101", "7201", "7102"];
  const r = await h.request("GET", "/collections?section=71");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.collections, [
    { key: "7150", title: "Cedar Favourites", count: 2, members: ["7101", "7102"] },
    { key: "7450", title: "Cedar Lanterns", count: 2, members: ["7101", "7102"] }]);
  assertClerkNoDeniedMetadata(r.json);
  assert.ok(!h.fixture.seen.some(c => /\/(7250|7350)\/children$/.test(c.path)), "denied collection member lists are never fetched");
});

test("1.7.0: search never borrows a section from its container (one search spans sections): a row without its own id is left out", async t => {
  const h = await clerkHarness(t);
  h.fixture.searchContainerSection = "71";
  h.fixture.search = ["7101", "7401"];
  const r = await h.request("GET", "/search?q=paper");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map(x => [x.key, x.section]), [["7101", "71"]]);
  assertClerkNoDeniedMetadata(r.json);
});

// ── review findings on the 1.7.0 fix (2026-11-07) ──
// F1: in a TV library a filter field without a type prefix is the SHOW's (as plexapi documents it: "in a TV show library
// viewCount is assumed to be show.viewCount"). An episode delta (type=4) sent as a bare updatedAt>>= filtered on each episode's
// show: a new episode of a show whose own updatedAt didn't move stayed out of the catalog until the next day's full read, and a
// touched show brought every one of its episodes back. Episodes name their own field (episode.updatedAt>>=); shows (type=2)
// and movies keep the bare field, which is their own.
function addLanternShow(fixture) {
  fixture.items["7120"] = { ratingKey: "7120", librarySectionID: "71", type: "show", title: "Invented Lantern Show", leafCount: 1, updatedAt: 1600000000 };
}

test("1.7.0 in a TV library: an episode delta filters on the episode's own updatedAt (episode.updatedAt>>=), never its show's", async t => {
  for (const plex143 of [false, true]) {
    const h = await clerkHarness(t);
    h.fixture.plex143 = plex143;
    addOrchardEpisodes(h.fixture);
    addLanternShow(h.fixture);
    const it = h.fixture.items;
    it["7110"].updatedAt = 1600000000;   // the show itself: untouched since long before the last sync
    it["7111"].updatedAt = 1700001000;   // an episode whose metadata changed since
    it["7112"].updatedAt = 1600000000;   // an episode untouched since
    it["7113"].updatedAt = 1700002000;   // a new episode of that existing show
    h.fixture.catalog = ["7111", "7112", "7113"];
    const sent = () => h.fixture.seen.filter(c => c.path === "/library/sections/71/all").at(-1).url;
    const delta = await h.request("GET", "/catalog?section=71&type=4&since=1700000000");
    assert.equal(delta.status, 200);
    assert.deepEqual([delta.json.total, delta.json.rows.map(r => r.key)], [2, ["7111", "7113"]],
      `plex143=${plex143}: the changed and the new episode, although their show's own updatedAt didn't move`);
    assertPlexSince(sent(), 1700000000, ["episode.updatedAt>>"]);
    assert.ok(/[?&]episode\.updatedAt%3E%3E=1700000000(&|$)/.test(new URL(sent()).search), `on the wire: episode.updatedAt%3E%3E=<since> - ${new URL(sent()).search}`);
    // the show touched since (a refresh), most of its episodes not: only the episodes that changed come back
    it["7110"].updatedAt = 1700005000;
    const touched = await h.request("GET", "/catalog?section=71&type=4&since=1700000000");
    assert.deepEqual([touched.json.total, touched.json.rows.map(r => r.key)], [2, ["7111", "7113"]], "not every episode of a touched show");
    // shows (type=2): the show's own field, bare - as for movies
    h.fixture.catalog = ["7110", "7120"];
    const shows = await h.request("GET", "/catalog?section=71&type=2&since=1700000000");
    assertPlexSince(sent(), 1700000000);
    assert.deepEqual([shows.json.total, shows.json.rows.map(r => [r.key, r.type])], [1, [["7110", "show"]]]);
    // a full read of episodes carries no updatedAt filter of any kind
    h.fixture.catalog = ["7111", "7112", "7113"];
    const full = await h.request("GET", "/catalog?section=71&type=4");
    assert.deepEqual(full.json.rows.map(r => r.key), ["7111", "7112", "7113"]);
    assert.ok(!plexQueryKeys(sent()).some(([k]) => isUpdatedAt(k)), "a full read carries no updatedAt filter");
  }
});

// F2: with a section policy set, a seek, a resume and every automatic restart (mode fallback, network blip, "Already publishing"
// retry) re-read the item first. A Plex that couldn't be read (restarting for an update, crashed, an error answer, no answer)
// counted as a denied section: the stream was killed and forgotten, where 1.6.0 played on from the file it had. Only Plex's own
// answer - the item is gone (404) or now sits in a section the policy denies - stops it. Otherwise it plays on with the section
// it was started from, and the next re-read asks again. The re-read has its own short limit, so a stalled Plex can't hold a
// seek past the site's 15 s.
const waitFor = async (cond, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise(r => setTimeout(r, 10)); return cond(); };
const ssOf = (p) => { const i = p.args.indexOf("-ss"); return i < 0 ? null : p.args[i + 1]; };

test("1.7.0 review: a Plex that can't be read doesn't end a stream - seek, resume and the automatic restart play on; Plex's own 404 / denial still stops it", async t => {
  const h = await clerkHarness(t, {}, { recheckMs: 100 });
  const stream = async (stage) => (await h.request("GET", `/streams/${stage}`)).json.stream;
  for (const down of ["refused", 503, 401, "stall"]) {
    const stage = `plex-down-${down}`;
    h.fixture.down = null;
    assert.equal((await h.request("PUT", `/streams/${stage}`, { ...START, ratingKey: "7101", title: "Invented stream" })).status, 200);
    h.fixture.down = down;
    // a seek while Plex can't be read
    let before = h.spawned.length;
    const t0 = Date.now();
    const seek = await h.request("POST", `/streams/${stage}/seek`, { offset: 60 });
    assert.equal(seek.status, 200, `${down}: the seek goes through (${JSON.stringify(seek.json)})`);
    assert.ok(Date.now() - t0 < 3000, `${down}: the seek answers within the re-read's own limit, not after Plex's 15 s`);
    assert.equal(h.spawned.length, before + 1); assert.equal(ssOf(h.spawned.at(-1)), "60.000");
    const now = await stream(stage);
    assert.deepEqual([now.state, now.offset], ["playing", 60]);
    // pause -> resume
    assert.equal((await h.request("POST", `/streams/${stage}/pause`)).status, 200);
    before = h.spawned.length;
    assert.equal((await h.request("POST", `/streams/${stage}/resume`)).status, 200, `${down}: the resume goes through`);
    assert.equal(h.spawned.length, before + 1);
    // the automatic restart: this ffmpeg dies before its first frame -> the next mode, after the same re-read
    before = h.spawned.length;
    h.spawned.at(-1).emit("exit", 1);
    assert.ok(await waitFor(() => h.spawned.length === before + 1), `${down}: the automatic restart went ahead`);
    assert.equal((await stream(stage)).mode, "hwdl");
    // Plex answers again - and says the item moved to the adult section: the next seek is refused and the stream forgotten
    h.fixture.down = null;
    h.fixture.items["7101"].librarySectionID = "72";
    before = h.spawned.length;
    assert.equal((await h.request("POST", `/streams/${stage}/seek`, { offset: 90 })).status, 404);
    assert.equal(h.spawned.length, before); assert.equal(await stream(stage), null);
    h.fixture.items["7101"].librarySectionID = "71";
  }
  // the item gone from Plex (Plex's own 404): a resume is refused and the stream forgotten, nothing starts
  const saved = h.fixture.items["7102"];
  assert.equal((await h.request("PUT", "/streams/plex-gone", { ...START, ratingKey: "7102", title: "Invented stream" })).status, 200);
  assert.equal((await h.request("POST", "/streams/plex-gone/pause")).status, 200);
  delete h.fixture.items["7102"];
  let before = h.spawned.length;
  assert.equal((await h.request("POST", "/streams/plex-gone/resume")).status, 404);
  assert.equal(h.spawned.length, before); assert.equal(await stream("plex-gone"), null);
  // ...and an automatic restart of it doesn't start either
  h.fixture.items["7102"] = saved;
  assert.equal((await h.request("PUT", "/streams/plex-gone-auto", { ...START, ratingKey: "7102", title: "Invented stream" })).status, 200);
  delete h.fixture.items["7102"];
  before = h.spawned.length;
  h.spawned.at(-1).emit("exit", 1);
  assert.ok(await waitFor(() => h.streamSet.get("plex-gone-auto") == null), "forgotten once Plex said the item is gone");
  assert.equal(h.spawned.length, before);
  h.fixture.items["7102"] = saved;
});
