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
const streams = M.makeStreams(cfg, fakePlex, fakeSpawn, () => T);
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

test("ffmpeg args: VAAPI full-GPU path, scaled to 720p keeping the aspect, AAC, FLV to the RTMP url", () => {
  const a = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 0, quality: 720, url: "rtmp://x/stage/key" });
  const s = a.join(" ");
  assert.match(s, /-hwaccel vaapi -hwaccel_device \/dev\/dri\/renderD128 -hwaccel_output_format vaapi/);
  assert.match(s, /-re -i /);
  assert.match(s, /scale_vaapi=w=960:h=720:format=nv12/);            // 1440x1080 (4:3) -> 960x720
  assert.match(s, /-c:v h264_vaapi/);
  assert.ok(s.includes("-map 0:a:0?"));                               // no track picked: the first audio track
  assert.ok(a.includes("-f") && a[a.length - 1] === "rtmp://x/stage/key");
  assert.ok(!s.includes("-ss"));
  const b = M.ffmpegArgs(cfg, { ...ITEMS["100"], hdr: true }, { offset: 600, quality: 1080, audio: 1, url: "rtmp://x/y/k" }).join(" ");
  assert.match(b, /-ss 600\.000 -i /);
  assert.match(b, /tonemap_vaapi=.*scale_vaapi=w=1440:h=1080/);
  assert.match(b, /-map 0:1 /);
});
test("ffmpeg args: burnt-in text subtitles (CPU filter + hwupload), seek keeps subtitle timing, image subs overlay", () => {
  const a = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 120, quality: 480, sub: 2, url: "rtmp://x/y/k", srcLink: "/run/mediactl/stage.mkv" }).join(" ");
  assert.ok(!a.includes("-hwaccel vaapi"));
  assert.match(a, /-init_hw_device vaapi=va:\/dev\/dri\/renderD128 -filter_hw_device va/);
  assert.match(a, /-ss 120\.000 -copyts -i \/run\/mediactl\/stage\.mkv/);
  assert.match(a, /subtitles=filename=.*stage\.mkv:si=0,setpts=PTS-STARTPTS,scale=640:480,format=nv12,hwupload/);
  assert.match(a, /-af asetpts=PTS-STARTPTS/);
  const b = M.ffmpegArgs(cfg, ITEMS["100"], { offset: 0, quality: 720, sub: 3, url: "rtmp://x/y/k" }).join(" ");
  assert.match(b, /\[0:v:0\]\[0:3\]overlay=eof_action=pass,scale=960:720/);
  const x = M.ffmpegArgs({ ...cfg, encoder: "x264" }, ITEMS["100"], { quality: 720, url: "rtmp://x/y/k" }).join(" ");
  assert.match(x, /-c:v libx264 -preset veryfast/);
  assert.ok(!x.includes("vaapi"));
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
