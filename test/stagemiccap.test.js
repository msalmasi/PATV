"use strict";
// Offline fixtures only: generated colours/testsrc and a tone, never a cam or a live bridge.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
process.env.SECRET_KEY = crypto.randomBytes(32).toString("hex");
process.env.FEED_NO_NICE = "1";
const M = require("../stagemiccap"), T = M._test;
const fm = require("../feedmedia"), sharp = require("sharp");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stagemiccap-test-"));
const R = { id: "fixture-pad", slug: "fixture-pad", title: "Fixture pad" }, U = { userId: "fixture-member", level: 3 };
const cam = (id, extra = {}) => ({ kind: "cam", id, name: id, video: "live", watch: "ok", pos: 0, ...extra });
let clock = 100000, program, hidden, refused, exact, pinned, cfg, allowed, clipOn, roomOff, liveShown, perk, taps, notices, readers, activeReaders, maxReaders;
function reset(extra = {}) {
  clock = 100000; program = { layout: "split", src: [cam("alice"), cam("bob", { pos: 1 })] };
  hidden = new Set(); refused = new Set(); exact = true; pinned = true; cfg = { stagecap_mic: true }; allowed = true; clipOn = true; roomOff = null; liveShown = true; perk = true;
  taps = []; notices = []; readers = []; activeReaders = 0; maxReaders = 0; T.snapAt.clear();
  M.configure({ now: () => clock, config: () => cfg, killed: () => null, roomOff: () => roomOff, eligibility: () => null,
    full: async () => allowed, block: async () => null, clipSwitch: () => clipOn, clipOffText: () => "Clips are off.", liveShown: () => liveShown, bridgeOk: () => perk,
    account: async () => U, resolveRoom: async () => R, people: async () => [], program: async () => program,
    hidden: l => hidden.has(l), camRefusal: async (l, u, o) => { assert.equal(o.strict, true); return refused.has(l) ? {} : null; },
    exact: () => exact, pin: () => pinned, camPath: (r, l) => "cam-" + l,
    still: () => null, offset: () => 0, mic: () => [], privateLogins: async () => new Set(),
    note: async (kind, r, l, u) => notices.push({ kind, r, l, u }),
    audioTap: (r, fn, u) => { const tap = { fn, u, stopped: false }; taps.push(tap); return () => { tap.stopped = true; }; },
    // mic keep review: no real wait for a clip's last mic-list read (the fixture clock stands still); recheck's name cards
    lastRosterWaitMs: 0, cards: async () => [],
    fm: () => fm, reader: fakeReader, ...extra });
}
function id() { return "c" + crypto.randomBytes(10).toString("hex"); }
function options(kind = "snap") { const cid = id(); return { id: cid, R, user: U, kind, secs: 10, surface: "pad", tmpDir: tmp, out: path.join(tmp, cid + (kind === "snap" ? ".webp" : ".mp4")) }; }
function fakeReader(job, tile, file) {
  let resolve, killed = false;
  const done = new Promise(r => { resolve = r; });
  const rd = { done, file, tile, kill() { if (killed) return; killed = true; activeReaders--; resolve({ ok: false, file, firstAt: 0 }); }, finish(data) { if (killed) return; fs.writeFileSync(file, data); killed = true; activeReaders--; resolve({ ok: true, file, firstAt: 0 }); } };
  readers.push(rd); activeReaders++; maxReaders = Math.max(maxReaders, activeReaders); return rd;
}
const tick = () => new Promise(r => setImmediate(r));
function ff(args) { return execFileSync(fm.bin("ffmpeg"), ["-hide_banner", "-v", "error", "-y", ...args], { maxBuffer: 8 * 1024 * 1024 }); }
let frame, videoA, videoB, tone;
test.before(async () => {
  frame = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#d83136" } }).png().toBuffer();
  videoA = path.join(tmp, "a.ts"); videoB = path.join(tmp, "b.ts"); tone = path.join(tmp, "room.mp3");
  ff(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=15", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "15", "-an", "-f", "mpegts", videoA]);
  ff(["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-t", "4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "15", "-an", "-f", "mpegts", videoB]);
  ff(["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "4", "-c:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", tone]);
});
test.beforeEach(() => reset());
test.after(async () => { for (const j of T.jobs.values()) M.cancel(j.id); await tick(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("all legacy and dynamic grids stay within the canvas; dynamic main and pip mirror CSS", () => {
  for (let n = 1; n <= 9; n++) {
    const p = { src: Array.from({ length: n }, (_, i) => cam("p" + i, { pos: i })), dyn: { n, t: "d" + n, main: "p" + (n - 1) } };
    const rs = M.rects(p); assert.equal(rs.length, n); assert.equal(rs[0].id, "p" + (n - 1));
    for (const r of rs) { assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 720); assert.ok(r.w > 0 && r.h > 0); }
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) { const x = rs[a], y = rs[b]; assert.ok(x.x + x.w <= y.x || y.x + y.w <= x.x || x.y + x.h <= y.y || y.y + y.h <= x.y); }
  }
  for (const [layout, n] of [["single", 1], ["split", 2], ["grid4", 4], ["grid9", 9]]) assert.equal(M.rects({ layout, src: Array.from({ length: n }, (_, i) => cam("p" + i)) }).length, n);
  const rs = M.rects({ layout: "pip", src: [cam("old"), cam("new", { newest: true })] });
  assert.deepEqual(rs[0], { id: "new", x: 0, y: 0, w: 1280, h: 720 }); assert.equal(rs[1].w, 384); assert.equal(rs[1].x, 888);
  assert.equal(M.rects({ layout: "pip", src: [cam("pin", { pin: true }), cam("recent")] })[0].id, "recent");
});
test("covers never consult an identity, consent, path or reader; labels and fallback stay anonymous", async () => {
  const cover = { kind: "cover", id: "anon-ab12cd34", name: "Soggy Bullfrog", veil: "hidden", hood: 3, watch: "cover" };
  Object.defineProperty(cover, "login", { get() { throw Error("must never read cover identity"); } });
  M.configure({ hidden: () => { throw Error("must not check cover login"); }, camPath: () => { throw Error("must not open cover"); } });
  const tile = await T.tileFor(cover, R, U); assert.equal(tile.mode, "cover"); assert.equal(tile.login, undefined); assert.equal(tile.name, "Soggy Bullfrog · hidden");
  const buf = await M.renderFrame({ src: [cover] }, [tile], R); assert.ok(buf.length > 500);
  assert.equal(M.coverArt({ ...cover, hood: "../../../etc/passwd" }).art, null);
  // wave2 WP-4: the art is installed (public/img/anon) and a cover without a frog name (today's wire) reads "someone"
  const v1 = { kind: "cover", id: "anon-00ff00ff", name: null, veil: "incognito", hood: 0, watch: "cover" };
  const art = M.coverArt(v1);
  assert.ok(art.art && /<title>Incognito frog<\/title>/.test(art.art.toString("utf8")), "hood-peek-0.svg");
  assert.equal(art.label, "someone · incognito");
  assert.ok(/<title>Hidden frog<\/title>/.test(M.coverArt({ ...v1, veil: "hidden", hood: 7 }).art.toString("utf8")), "hood-shadow-7.svg");
});
test("cam table enforces strict consent, veil, exact and pin rules and never fetches avatar URLs", async () => {
  for (const watch of ["blocked", "unavailable", "members_only", "new-unknown"]) assert.equal((await T.tileFor(cam("alice", { watch }), R, U)).mode, "blank");
  hidden.add("alice"); assert.equal((await T.tileFor(cam("alice"), R, U)).name, ""); hidden.clear();
  refused.add("alice"); assert.equal((await T.tileFor(cam("alice"), R, U)).mode, "blank"); refused.clear();
  exact = false; assert.equal((await T.tileFor(cam("alice"), R, U)).mode, "card");
  assert.equal((await T.tileFor(cam("alice", { pin: true }), R, U)).mode, "live"); pinned = false;
  assert.equal((await T.tileFor(cam("alice", { pin: true }), R, U)).mode, "card");
  assert.equal((await T.tileFor(cam("alice", { watch: "notice", avatar: "https://invalid.example/avatar" }), R, U)).mode, "card");
  M.configure({ still: () => ({ state: "ok", img: "data:image/png;base64," + frame.toString("base64") }) });
  assert.equal((await T.tileFor(cam("alice", { video: "still" }), R, U)).mode, "still");
  assert.deepEqual(T.entries({ src: [cam("alice", { watch: "hidden" })] }), []);
  assert.equal((await T.tileFor({ kind: "unknown", id: "alice", watch: "ok" }, R, U)).mode, "blank");
});
test("wave2 WP-4 (F.3): with a dynamic template a tile the viewer reported stays a (blank) cell, so the capture keeps the page's template; a stage of only such tiles isn't capturable", async () => {
  const src = [cam("alice"), cam("bob", { watch: "hidden" }), cam("carl", { newest: true })];
  const p = { src, dyn: { n: 3, t: "d3", main: "carl" } };
  assert.deepEqual(T.entries(p).map((e) => e.id), ["alice", "bob", "carl"], "kept with dyn");
  const rs = M.rects(p);
  assert.equal(rs.length, 3, "d3 - the template the viewer sees, not the legacy grid");
  assert.equal(rs[0].id, "carl");
  assert.equal((await T.tileFor(src[1], R, U)).mode, "blank", "drawn as a blank cell, never the cam");
  assert.deepEqual(T.entries({ src }).map((e) => e.id), ["alice", "carl"], "without dyn: left out as before");
  program = { on: true, src: [cam("bob", { watch: "hidden" })], dyn: { n: 1, t: "d1", main: "bob" } };
  await assert.rejects(M.start(options()), /Nobody/, "nothing a viewer may see: not usable");
});
test("text is XML escaped, Unicode bounded and pictographs omitted", () => {
  const s = T.text('<Bob & "friends">🐸'); assert.equal(s, "&lt;Bob &amp; &quot;friends&quot;&gt;");
  assert.equal(Array.from(T.text("a".repeat(50))).length, 40); assert.ok(T.text("a".repeat(50)).endsWith("…"));
});
test("all request gates are fail closed, dark availability is absent and home is refused", async () => {
  cfg.stagecap_mic = false; assert.equal(await M.availability(R, U), null); await assert.rejects(M.start(options()), /off right now/);
  cfg.stagecap_mic = true; await assert.rejects(M.start({ ...options(), surface: "home" }), /Open the pad/);
  allowed = false; await assert.rejects(M.start(options()), /not available/); allowed = true;
  clipOn = null; assert.equal((await M.availability(R, U)).clip, false); await assert.rejects(M.start(options("clip")), /Clips are off/);
  clipOn = true; roomOff = "Snaps are off."; await assert.rejects(M.start(options()), /Snaps are off/);
  roomOff = null; program = null; await assert.rejects(M.start(options()), /Nobody/);
});
test("review fix: the Prime Time Plus bridge gate - a pad without the perk can't be captured, at start or recheck; Pepe not live refuses a new capture only", async () => {
  M.configure({ people: async () => ["alice"] });
  const preview = () => M.recheck({ id: id(), room_id: R.id, user_id: U.userId, kind: "photo" });
  perk = false;
  await assert.rejects(M.start(options()), /unavailable/); await assert.rejects(M.start(options("clip")), /unavailable/);
  assert.deepEqual([(await M.availability(R, U)).snap, (await M.availability(R, U)).clip], [false, false]);
  assert.equal(await preview(), T.MSG.revoked, "a preview made before the perk lapsed");
  perk = true; assert.equal(await preview(), null);
  // review fix 2: Pepe's room not live (no sync for 90 s - a restart, an update) refuses a new capture, never a pending preview
  liveShown = false;
  await assert.rejects(M.start(options()), /unavailable/); await assert.rejects(M.start(options("clip")), /unavailable/);
  assert.deepEqual([(await M.availability(R, U)).snap, (await M.availability(R, U)).clip], [false, false]);
  assert.equal(await preview(), null, "a Pepe gap keeps the preview");
  await assert.rejects(T.gate(R, U, "snap", "pad", { live: true }), /unavailable/); await T.gate(R, U, "snap", "pad");
});
test("RTSP auth permits only a running path/job; loopback empty credentials get one challenge", () => {
  const job = { id: id(), kind: "clip", secs: 20, expiry: clock + 35000, reading: true, paths: new Set(["cam-a"]), cancelled: false };
  T.jobs.set(job.id, job);
  try {
    const b = { ip: "127.0.0.1", user: "stagecap", password: T.password(job, "cam-a") };
    assert.equal(M.rtspAuth(b, "cam-a"), 200); assert.equal(M.rtspAuth(b, "cam-b"), 403);
    for (const ip of ["127.0.0.1", "127.2.3.4", "::1", "::ffff:127.0.0.1"]) assert.equal(M.rtspAuth({ ip }, "cam-a"), 401);
    for (const ip of ["198.51.100.1", "localhost", "127.0.0.1.attacker.invalid", "::ffff:198.51.100.1"]) assert.equal(M.rtspAuth({ ...b, ip }, "cam-a"), 403);
    job.paths.clear(); assert.equal(M.rtspAuth(b, "cam-a"), 403); job.paths.add("cam-a"); job.reading = false; assert.equal(M.rtspAuth(b, "cam-a"), 403);
    job.reading = true; clock += 35001; assert.equal(M.rtspAuth(b, "cam-a"), 403);
  } finally { T.jobs.delete(job.id); }
});
test("RTSP base is numeric loopback, readers force TCP/format and errors redact their credentials", () => {
  assert.equal(T.rtspBase(), "rtsp://127.0.0.1:8554"); assert.equal(T.rtspBase("rtsp://[::1]:8554"), "rtsp://[::1]:8554");
  for (const s of ["rtsp://localhost", "https://127.0.0.1", "rtsp://198.51.100.2", "rtsp://user:pass@127.0.0.1", "rtsp://127.0.0.1/path", "rtsp://127.0.0.1?x=y"]) assert.throws(() => T.rtspBase(s));
  const job = { id: id(), kind: "clip", expiry: clock + 35000 }, args = T.readerArgs(job, { path: "cam-a" }, "fixture.ts");
  assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "rtsp,tcp,rtp"); assert.equal(args[args.indexOf("-rtsp_transport") + 1], "tcp"); assert.ok(args.includes("copy"));
  assert.equal(M.sanitize("failed rtsp://stagecap:never-print-this@127.0.0.1/cam"), "failed rtsp://stagecap:[redacted]@127.0.0.1/cam");
  assert.ok(!M.sanitize("stagecap%3Anever-print-this@127.0.0.1").includes("never-print-this"));
  assert.equal(T.readerTimeoutMs({ kind: "clip", deadline: clock + 54000, expiry: clock + 35000 }), 35000, "large offsets never extend a reader past credential expiry");
  assert.equal(T.readerTimeoutMs({ kind: "clip", deadline: clock + 21000, expiry: clock + 35000 }), 21500);
  assert.equal(T.readerTimeoutMs({ kind: "snap", deadline: clock + 6000, expiry: clock + 21000 }), 6000);
});
test("snap re-reads the viewer program, dropping old frames and storing only actually drawn cams", async () => {
  const o = options(), running = await M.start(o); await tick(); assert.equal(readers.length, 2);
  const cover = { kind: "cover", id: "anon-01234567", name: "Frog", veil: "incognito", hood: 1, watch: "cover", pos: 1 };
  program = { layout: "split", src: [cam("alice"), cover] };
  readers.forEach(r => r.finish(frame)); const info = await running.done;
  assert.deepEqual(info.people, ["alice"]); assert.deepEqual(notices.map(x => x.l), ["alice"]); assert.ok(fs.existsSync(o.out)); assert.equal(T.jobs.size, 0);
  assert.equal((await sharp(o.out).metadata()).format, "webp"); assert.equal(fs.existsSync(path.join(tmp, "mic-" + o.id)), false);
});
test("snap readers are capped at four, failed frames become cards and rate limits are per pad", async () => {
  program = { layout: "grid9", src: Array.from({ length: 9 }, (_, i) => cam("person" + i, { pos: i })) };
  const running = await M.start(options()); await tick(); assert.equal(readers.length, 4);
  await assert.rejects(M.start(options()), /wait a moment/);
  while (T.jobs.size) { const pending = readers.filter(r => activeReaders && r); pending.forEach(r => r.kill()); await tick(); if (readers.length === 9 && activeReaders === 0) break; }
  const info = await running.done; assert.equal(maxReaders, 4); assert.deepEqual(info.people, []);
});
test("preview recheck applies current account gates and every actual depicted cam", async () => {
  M.configure({ people: async () => ["alice", "bob"] });
  const capture = { id: id(), room_id: R.id, user_id: U.userId, kind: "photo" };
  assert.equal(await M.recheck(capture), null); hidden.add("bob"); assert.equal(await M.recheck(capture), T.MSG.revoked);
  hidden.clear(); allowed = false; assert.equal(await M.recheck(capture), T.MSG.revoked);
});
test("snap reader permits transfer directly to a waiting job before a fresh caller can acquire", async () => {
  const held = await Promise.all(Array.from({ length: 4 }, () => T.snapSlot()));
  let queuedRelease, freshRelease;
  const queued = T.snapSlot().then(release => { queuedRelease = release; });
  held[0]();
  const fresh = T.snapSlot().then(release => { freshRelease = release; });
  await tick();
  assert.equal(typeof queuedRelease, "function");
  assert.equal(freshRelease, undefined, "the first job's waiter still owns the transferred fourth permit");
  held[1](); await fresh;
  held[2](); held[3](); queuedRelease(); freshRelease(); await queued;
});
test("audio byte positions map hm and private lookback to decoded time, with conservative margins", () => {
  const chunks = Array.from({ length: 8 }, (_, i) => ({ offset: i * 100, bytes: 100, at: i + 1, hm: i === 2 ? 1 : 0, lat: { mp3_ms: 1000 } }));
  const packets = chunks.map(c => ({ pos: c.offset, size: 100, duration_time: 1 }));
  const a = M.audioPlan(chunks, packets, [{ at: -10, private: false }, { at: 5, private: true }, { at: 6, private: false }], 8);
  assert.equal(a.reason, null); assert.ok(a.muted.some(([x, y]) => x <= 1.75 && y >= 3.25));
  assert.ok(a.muted.some(([x, y]) => x <= 6 && y >= 6)); assert.ok(!a.muted.some(([x, y]) => x <= 4 && y >= 4));
  assert.equal(M.audioPlan([{ ...chunks[0], hm: null }], packets, [], 8).reason, "outdated"); assert.equal(M.audioPlan([], [], [], 8).reason, "off");
  const gaps = M.audioPlan([chunks[0], { ...chunks[1], at: 5 }], packets.slice(0, 2), [{ at: -10, private: false }], 8);
  assert.equal(gaps.segments.length, 2); assert.equal(gaps.segments[1].at, 4);
  const unknownStart = M.audioPlan([{ offset: 0, bytes: 100, at: 1.05, hm: 0, lat: { mp3_ms: 1000 } }], [{ pos: 0, size: 100, duration_time: .25 }], [{ at: 0, private: false }], 4);
  assert.ok(unknownStart.muted.length, "a chunk crossing the unobserved pre-recording mic roster is muted");
});
test("positive A/V offset delays video, negative delays audio, null has no shift", () => {
  assert.deepEqual(M.shifts([500, null]), { audio: 0, video: [.5, 0], extra: .5 });
  assert.deepEqual(M.shifts([-500, 0]), { audio: .5, video: [0, .5], extra: .5 });
  assert.deepEqual(M.shifts([12000]), { audio: 0, video: [12], extra: 12 });
});
test("private lookup fails closed on database errors and timestamps the roster before asynchronous work", async () => {
  await assert.rejects(T.privateLoginsStrict(["alice"], async () => { throw Error("fixture unavailable"); }), /fixture unavailable/);
  const profiles = { get: async () => ({ an_rooms: "hidden" }), stateOf: (l, key) => l[key] };
  assert.deepEqual(await T.privateLoginsStrict(["Alice"], async () => [{ userId: "fixture", camfrogUsername: "ALICE" }], profiles), new Set(["alice"]));
  await assert.rejects(T.privateLayoutStrict("fixture", async () => [{ layout: "corrupt json" }], { ready: Promise.resolve(), sanitize: x => x }));
  await assert.rejects(T.privateLayoutStrict("fixture", async () => { throw Error("failed profile read"); }, { ready: Promise.resolve() }), /failed profile read/);
  const job = { R, started: clock, privateHistory: [{ at: 0, private: false }] };
  clock += 5000;
  M.configure({ mic: () => [{ login: "alice" }], privateLogins: async () => { clock += 2000; return new Set(["alice"]); } });
  await T.privateSample(job);
  assert.ok(job.privateHistory.some(x => x.at === 5 && x.private)); assert.ok(job.privateHistory.some(x => x.at === .5 && x.private), "unsampled gap is private");
});
test("private lookup still pending at encoding is already marked unknown, without blocking capture startup", async () => {
  let finish;
  M.configure({ mic: () => [{ login: "alice" }], privateLogins: () => new Promise(r => { finish = r; }) });
  const job = { R, started: clock, privateHistory: [] };
  const pending = T.privateSample(job); assert.deepEqual(job.privateHistory, [{ at: 0, private: true }]);
  const plan = M.audioPlan([{ offset: 0, bytes: 100, at: .25, hm: 0, lat: { mp3_ms: 0 } }], [{ pos: 0, size: 100, duration_time: .25 }], job.privateHistory, 4);
  assert.ok(plan.muted.length); finish(new Set()); await pending; assert.equal(job.privateHistory[0].private, false);
});
test("review fix: a private holder is muted from their hold's since, though the mic list reached the site 1.5 s after the grab", async () => {
  const run = async (listAt, entry) => {
    const job = { R, started: clock, privateHistory: [] };
    let mic = [];
    M.configure({ mic: () => mic, privateLogins: async ls => new Set(ls.filter(l => l === "alice")) });
    for (let t = 0; t <= 6; t += .5) {
      clock = job.started + t * 1000;
      if (t === listAt) mic = [entry(job)];
      await T.privateSample(job);
    }
    clock = job.started;
    return job;
  };
  // 0.25 s MP3 chunks with 0.5 s of pipeline latency: sound from source time s lands at s + 0.5 s in the clip
  const chunks = Array.from({ length: 24 }, (_, i) => ({ offset: i * 100, bytes: 100, at: (i + 1) * .25, hm: 0, lat: { mp3_ms: 500 } }));
  const packets = chunks.map(c => ({ pos: c.offset, size: 100, duration_time: .25 }));
  const muted = (job, t) => M.audioPlan(chunks, packets, job.privateHistory, 6).muted.some(([a, b]) => a <= t && t <= b);
  // alice grabs at 2 s; Pepe's mic list carrying her (since = the grab) reaches the site at 3.5 s
  let job = await run(3.5, j => ({ login: "alice", since: j.started + 2000 }));
  assert.ok(muted(job, 2.6), "her first sound (source 2 s, in the clip at 2.5 s) is muted");
  assert.ok(!muted(job, 1.1), "sound from before her grab is not");
  assert.ok(job.privateHistory.some(h => h.at === 2 && h.private) && job.privateHistory.filter(h => h.at > 2 && h.at < 3.5).every(h => h.private));
  // a hold that began before the clip is clamped to the clip's start; a holder without since goes MIC_LAG (2 s) back
  job = await run(1, j => ({ login: "alice", since: j.started - 60000 }));
  assert.ok(job.privateHistory.every(h => h.private), "held since before the job: private from 0");
  job = await run(3.5, () => ({ login: "alice" }));
  assert.ok(job.privateHistory.some(h => h.at === 1.5 && h.private) && !job.privateHistory.find(h => h.at === 1).private);
});
test("review fix 2: a clip cut while a sample's private-profile lookup is pending still mutes that holder's first sound", async () => {
  // a clip whose ffprobe / ffmpeg are fakes: the probe maps each 0.25 s tap chunk to 0.25 s of audio, the "encode" keeps the graph
  const run = async ({ resolveAfterCut }) => {
    let mic = [], slow = false, finish = null, graph = null;
    reset({ mic: () => mic, privacyWaitMs: resolveAfterCut ? 3000 : 60,
      privateLogins: ls => (slow && ls.includes("alice") ? new Promise(r => { finish = () => r(new Set(["alice"])); }) : Promise.resolve(new Set())),
      fm: () => ({ ...fm, slot: async () => () => {}, run: async (cmd, args) => {
        if (cmd === fm.bin("ffprobe")) return { out: JSON.stringify({ packets: Array.from({ length: 24 }, (_, i) => ({ pos: i * 100, size: 100, duration_time: .25 })) }) };
        graph = args[args.indexOf("-filter_complex") + 1]; fs.writeFileSync(args[args.length - 1], "fixture"); return { out: "" };
      } }) });
    const o = options("clip"), running = await M.start(o); await tick();
    const job = T.jobs.get(o.id); clearInterval(job.timer);                // the samples below run on the fixture clock only
    for (let i = 0; i < 24; i++) {
      const t = (i + 1) * .25;
      clock = job.started + t * 1000;
      if (t === 5.5) { mic = [{ login: "alice", since: job.started + 4000 }]; slow = true; }   // alice grabbed at 4 s; Pepe's list reaches the site at 5.5 s
      taps[0].fn(Buffer.alloc(100, 1), { hm: 0, lat: { mp3_ms: 500 } });   // sound from source time s lands at s + 0.5 s
      if (t % .5 === 0) { const p = T.privateSample(job); if (t < 5.5) await p; }   // 5.5 s: its profile lookup is still pending
    }
    slow = false;
    job.finishEarly(6);                                                    // the clip is cut while that lookup is in flight
    // ... and answers within the wait, but well after the cut would otherwise have planned the audio
    if (resolveAfterCut) setTimeout(() => finish(), 500);
    const info = await running.done;
    const mute = /volume=0:enable='([^']*)'/.exec(graph || "");
    const wins = mute ? [...mute[1].matchAll(/between\(t,([\d.]+),([\d.]+)\)/g)].map(m => [Number(m[1]), Number(m[2])]) : [];
    return { info, muted: x => wins.some(([a, b]) => a <= x && x <= b) };
  };
  let r = await run({ resolveAfterCut: true });
  assert.ok(r.muted(4.6), "her first sound (source 4 s, in the clip at 4.5 s) is muted from her hold's since");
  assert.ok(!r.muted(3), "sound from before her grab is not");
  r = await run({ resolveAfterCut: false });
  assert.ok(r.muted(4.6), "still pending after the wait: private from MIC_LAG before that sample");
  assert.ok(r.info.audio.muted_s > 0 && !r.muted(2), "never further back than that");
});
test("recording fixes tiles, kills departed readers at the sampled time, and discard cleans up", async () => {
  const o = options("clip"), running = await M.start(o); await tick(); const job = T.jobs.get(o.id); assert.equal(readers.length, 2);
  await assert.rejects(M.start(options("clip")), /Someone is clipping/);
  clock += 5000; hidden.add("alice"); program.src.push(cam("newperson", { pos: 2 }));
  await T.sample(job); assert.equal(job.tiles[0].stop, 5); assert.equal(activeReaders, 1); assert.equal(job.tiles.length, 2);
  const args = M.composeArgs({ base: "base.png", tiles: [{ ...job.tiles[0], file: "tile.ts" }], rectangles: M.rects(program), duration: 10, out: "out.mp4" });
  const graph = args[args.indexOf("-filter_complex") + 1]; assert.match(graph, /between\(t,0\.0000,5\.0000\)/); assert.match(graph, /gte\(t,5\.0000\)/);
  assert.equal(M.cancel(o.id), true); await assert.rejects(running.done); assert.equal(activeReaders, 0); assert.equal(taps[0].stopped, true); assert.equal(fs.existsSync(o.out), false); assert.equal(fs.existsSync(job.dir), false);
});
test("1.99ahq stage cover fix 3 + review fix 3 (FID-1): a capture STARTS without waiting on any picture (a photo host that never answers can't hold it up), and the 500 ms samples never wait on one (a slow photo fetch can't delay a privacy cut)", async () => {
  let asked = 0;
  reset({ cover: () => { asked++; return new Promise(() => {}); } });     // a photo host that never answers
  const photo = "https://cdn.discordapp.com/avatars/1/x.png", gtf = "/media/cover/a/1.abc.svg";
  program = { layout: "split", src: [cam("alice", { video: "card", avatar: photo, ck: "photo" }), cam("bob", { pos: 1, avatar: gtf, ck: "gtf" })] };
  const t0 = Date.now();
  const o = options("clip"), running = await M.start(o);
  const waited = Date.now() - t0;
  await tick(); const job = T.jobs.get(o.id);
  assert.ok(waited < 1500, "started at once: " + waited + " ms");
  assert.equal(asked, 0, "no picture asked when a capture starts");
  assert.equal(readers.length, 1, "bob's cam reader opened at once");
  assert.deepEqual(job.tiles.map(t => t.coverUrl), [photo, gtf], "each named tile's cover URL kept for the cut");
  clock += 1000; hidden.add("alice");
  await T.sample(job);
  assert.equal(asked, 0, "no cover asked by the sample");
  assert.equal(job.tiles[0].stop, 1, "the privacy cut landed at once");
  M.cancel(o.id); await assert.rejects(running.done);
  assert.equal(asked, 0, "a cancelled clip loads none either");
});
test("1.99ahq stage cover review fix 3 (FID-1): a tile's consent is read AFTER its picture - someone who goes hidden while a slow picture loads (a snap's final frame) is never drawn by name", async () => {
  let release = null;
  reset({ cover: () => new Promise(r => { release = r; }) });
  const e = cam("alice", { video: "card", avatar: "/media/cover/a/1.abc.svg", ck: "gtf" });
  const pending = T.tileFor(e, R, U);
  await tick(); await tick();
  assert.equal(typeof release, "function", "the picture is asked first");
  hidden.add("alice");                                                    // she goes hidden while it loads
  release({ buf: frame, k: "gtf" });
  const t = await pending;
  assert.equal(t.mode, "blank"); assert.equal(t.name, ""); assert.equal(t.login, undefined); assert.equal(t.cover, undefined);
  hidden.clear();                                                         // control: still public -> her card with the picture
  const p2 = T.tileFor(e, R, U); await tick(); release({ buf: frame, k: "gtf" });
  const t2 = await p2;
  assert.equal(t2.mode, "card"); assert.equal(t2.cover && t2.cover.k, "gtf");
});
test("1.99ahq stage cover review fix 3 (FID-2): a clip draws each card's cover as it is at the END - a picture taken down mid-recording is never in it, a changed one shows the new picture (real ffmpeg)", async () => {
  const solid = (r, g, b) => sharp({ create: { width: 200, height: 200, channels: 3, background: { r, g, b } } }).png().toBuffer();
  const red = await solid(230, 10, 10), blue = await solid(10, 10, 230);
  const up = "/media/cover/u/" + "a".repeat(32) + ".webp", gtf = "/media/cover/a/1.abc.svg";
  let answer = null;
  const asked = [];
  reset({ cover: async u => { asked.push(u); return answer(u); } });
  /** a 5 s clip of alice's name card; `during` runs 1 s in, before the samples (stagecover.captureImage answers `answer` now) */
  async function clipOf(during) {
    answer = u => (u === up ? { buf: red, k: "upload" } : null);
    program = { layout: "single", src: [cam("alice", { name: "Alice", video: "card", avatar: up, ck: "upload" })] };
    asked.length = 0;
    const o = options("clip"), running = await M.start(o); await tick();
    const job = T.jobs.get(o.id);
    clock += 1000; during();
    for (let i = 0; i < 6; i++) { await T.sample(job); clock += 500; }
    job.finishEarly(5);
    const info = await running.done;
    const png = path.join(tmp, o.id + "-at.png");
    ff(["-ss", "4.5", "-i", o.out, "-frames:v", "1", png]);
    const { data, info: im } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const i = (330 * im.width + 640) * im.channels;
    return { info, px: [data[i], data[i + 1], data[i + 2]], asked: asked.slice() };
  }
  const isRed = c => c[0] > 180 && c[1] < 70 && c[2] < 70, isBlue = c => c[2] > 180 && c[0] < 70 && c[1] < 70;
  // control: nothing changes - the uploaded picture is drawn, loaded once (at the cut)
  let r = await clipOf(() => {});
  assert.ok(isRed(r.px), "control: the picture is in the clip " + r.px);
  assert.deepEqual(r.asked, [up]); assert.equal(r.info.veiled, false); assert.deepEqual(r.info.cards, ["alice"]);
  // an admin takes it down 1 s in: the page shows the fallback; captureImage now answers null (localImageChecked) -> the letter
  r = await clipOf(() => { answer = () => null; });
  assert.ok(!isRed(r.px), "the taken-down picture is never in the clip " + r.px);
  assert.deepEqual(r.asked, [up], "read at the cut, after the take-down");
  // alice changes her cover 1 s in (a new program URL): the end state - her new picture - for the whole clip
  r = await clipOf(() => {
    program = { layout: "single", src: [cam("alice", { name: "Alice", video: "card", avatar: gtf, ck: "gtf" })] };
    answer = u => (u === gtf ? { buf: blue, k: "gtf" } : u === up ? { buf: red, k: "upload" } : null);
  });
  assert.ok(isBlue(r.px), "the cover she carries at the end " + r.px);
  assert.deepEqual(r.asked, [gtf]);
});
test("startup sweeps only its own job directories", async () => {
  const own = path.join(tmp, "mic-" + id()), other = path.join(tmp, "other-tool-work");
  fs.mkdirSync(own); fs.writeFileSync(path.join(own, "video.ts"), "fixture"); fs.mkdirSync(other); fs.writeFileSync(path.join(other, "keep.txt"), "keep");
  await M.init(tmp); assert.equal(fs.existsSync(own), false); assert.equal(fs.existsSync(path.join(other, "keep.txt")), true);
});
test("forward clip releases readers before its queued cut, keeps audio before tap end, and cleans files", async () => {
  let slots = 0, cutCalls = 0;
  reset({ reader: (job, tile, file) => { const rd = fakeReader(job, tile, file); fs.copyFileSync(tile.id === "alice" ? videoA : videoB, file); return rd; },
    fm: () => ({ ...fm, slot: async () => { assert.equal(activeReaders, 0); slots++; return () => { slots--; }; } }) });
  const o = options("clip"), running = await M.start(o, { cutting: async () => { cutCalls++; } }); await tick();
  assert.equal(slots, 0); assert.equal(running.ready_by, clock + 11000);
  clock += 4000; taps[0].fn(fs.readFileSync(tone), { hm: 0, lat: { mp3_ms: 0 } }); taps[0].fn.end();
  taps[0].fn(Buffer.from("ignored after end"), { hm: null });
  program = null; await T.sample(T.jobs.get(o.id));
  const info = await running.done;
  assert.equal(cutCalls, 1); assert.equal(slots, 0); assert.equal(info.audio.reason, null); assert.deepEqual(info.people, ["alice", "bob"]);
  assert.equal(info.secs, 4); assert.ok((await fm.probe(o.out, "mov")).audio); assert.equal(fs.existsSync(path.join(tmp, "mic-" + o.id)), false);
});
test("consent changed while composing revokes the output before notification", async () => {
  reset({ reader: (job, tile, file) => { const rd = fakeReader(job, tile, file); fs.copyFileSync(videoA, file); return rd; },
    fm: () => ({ ...fm, run: async (...args) => { const result = await fm.run(...args); if (args[0] === fm.bin("ffmpeg")) hidden.add("alice"); return result; } }) });
  const o = options("clip"), running = await M.start(o); await tick();
  clock += 4000; program = null; await T.sample(T.jobs.get(o.id));
  await assert.rejects(running.done, /turned off captures/); assert.equal(fs.existsSync(o.out), false); assert.deepEqual(notices, []);
});
test("site-wide limits cover both recording kinds and releasing cancelled jobs frees the slots", async () => {
  for (const kind of ["clip", "snap"]) {
    const jobs = [];
    for (let i = 0; i < 2; i++) jobs.push(await M.start({ ...options(kind), R: { ...R, id: "limit-pad-" + kind + i } }));
    await assert.rejects(M.start({ ...options(kind), R: { ...R, id: "limit-pad-third" } }), /Busy/);
    const results = jobs.map(j => j.done.catch(() => null)); jobs.forEach(j => j.cancel()); await Promise.all(results);
    assert.equal(T.jobs.size, 0);
  }
});
test("PiP inset stays visible over a stopped main, including static name cards", async () => {
  const p = { layout: "pip", src: [cam("inset", { video: "card", pin: true }), cam("main", { newest: true })] };
  const ts = await T.tilesFor(p, R, U), rs = M.rects(p, 1280, 688), base = path.join(tmp, "pip.png"), out = path.join(tmp, "pip.mp4");
  ts.find(t => t.id === "main").image = frame;
  await M.renderFrame(p, ts, R, base, { noRing: true });
  const insetRect = rs.find(r => r.id === "inset"), inspect = { left: insetRect.x + 50, top: insetRect.y + 20, width: 1, height: 1 };
  const stillPixel = await sharp(base).extract(inspect).raw().toBuffer(); assert.ok(Math.abs(stillPixel[0] - 16) < 3, "live main must not paint over card inset");
  for (const r of rs) {
    const t = ts.find(x => x.id === r.id); t.staticFile = path.join(tmp, "pip-" + r.id + ".png");
    await sharp(base).extract({ left: r.x, top: r.y, width: r.w, height: r.h }).png().toFile(t.staticFile);
  }
  const main = ts.find(t => t.id === "main"); main.file = videoA; main.stop = 1;
  await fm.run(fm.bin("ffmpeg"), M.composeArgs({ base, tiles: ts, rectangles: rs, duration: 3, out }), { timeoutMs: 30000 });
  const shot = path.join(tmp, "pip-after.png"); ff(["-i", out, "-ss", "2", "-frames:v", "1", shot]);
  const bubble = await sharp(shot).extract({ left: insetRect.x + Math.round(insetRect.w / 2), top: insetRect.y + Math.round(insetRect.h / 2 - 40), width: 1, height: 1 }).raw().toBuffer();
  assert.ok(bubble[0] >= 30 && bubble[2] >= 60, "inset card bubble survives the main stop");
});
test("real ffmpeg composes two tiles plus sine, honors silence windows and strips metadata", async () => {
  const base = path.join(tmp, "compose.png"), out = path.join(tmp, "compose.mp4"), silent = path.join(tmp, "silent.mp4");
  const ts = await T.tilesFor(program, R, U); await M.renderFrame(program, ts, R, base, { noRing: true });
  ts[0].file = videoA; ts[0].stop = 2; ts[1].file = videoB;
  const opts = { base, tiles: ts, rectangles: M.rects(program, 1280, 688), duration: 4, audioFile: tone,
    audio: { reason: null, muted: [[1, 2]], segments: [{ begin: 0, end: 4, at: 0 }] }, out };
  await fm.run(fm.bin("ffmpeg"), M.composeArgs(opts), { timeoutMs: 30000 });
  const p = await fm.probe(out, "mov"); assert.ok(p.audio); assert.ok(p.video); assert.ok(Math.abs(p.secs - 4) < .2); assert.equal(p.video.height, 720);
  const pcm = ff(["-i", out, "-ss", "1.3", "-t", "0.3", "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
  let max = 0; for (let i = 0; i < pcm.length - 1; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i))); assert.ok(max < 12, "mute window should decode as silence: " + max);
  const audible = ff(["-i", out, "-ss", "0.3", "-t", "0.3", "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
  assert.ok([...audible].some(b => b > 50));
  const blank = path.join(tmp, "blank.png"); ff(["-i", out, "-ss", "3", "-frames:v", "1", blank]);
  const pix = await sharp(blank).extract({ left: 100, top: 100, width: 1, height: 1 }).raw().toBuffer(); assert.ok(Math.abs(pix[0] - 16) < 10);
  await fm.run(fm.bin("ffmpeg"), M.composeArgs({ ...opts, out: silent, audio: { reason: "outdated", segments: [] } }), { timeoutMs: 30000 });
  assert.equal((await fm.probe(silent, "mov")).audio, null);
});
// review fix: the VPS runs ffmpeg 4.2.7, which has neither adelay's all= (4.3+) nor amix's normalize= (4.4+).
test("clip audio graph uses only ffmpeg 4.2 options and keeps every segment at full level in its place", async () => {
  const base = path.join(tmp, "audio42.png"), out = path.join(tmp, "audio42.mp4"), ref = path.join(tmp, "audio42-ref.mp4");
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#10151d" } }).png().toFile(base);
  const compose = (segments, file) => M.composeArgs({ base, tiles: [], rectangles: [], duration: 4, audioFile: tone, audio: { reason: null, muted: [], segments }, out: file });
  const args = compose([{ begin: 0, end: 1, at: 0 }, { begin: 2, end: 3, at: 2.5 }], out);
  const graph = args[args.indexOf("-filter_complex") + 1];
  assert.doesNotMatch(graph, /normalize=/); assert.doesNotMatch(graph, /:all=/);
  assert.match(graph, /adelay=2500\|2500,apad,atrim=end=4\.0000\[ad1\]/); assert.match(graph, /amix=inputs=2,volume=2,/);
  // Set FFMPEG_PATH / FFPROBE_PATH to a 4.x build to prove the same graph there.
  await fm.run(fm.bin("ffmpeg"), args, { timeoutMs: 30000 });
  // The reference is the whole tone as one segment through the same AAC/stereo encode: amix's 1/N must be undone.
  await fm.run(fm.bin("ffmpeg"), compose([{ begin: 0, end: 4, at: 0 }], ref), { timeoutMs: 30000 });
  const peak = (file, at, len) => {
    const pcm = ff(["-i", file, "-ss", String(at), "-t", String(len), "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);
    let max = 0; for (let i = 0; i < pcm.length - 1; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i))); return max;
  };
  const level = peak(ref, 0.3, 0.4);
  assert.ok(level > 1000, "the reference is audible: " + level);
  for (const at of [0.3, 2.8]) { const p = peak(out, at, 0.4); assert.ok(p > level * 0.85 && p < level * 1.15, `segment at ${at} s: ${p} vs ${level}`); }
  for (const at of [1.3, 3.7]) assert.ok(peak(out, at, 0.2) < 12, "outside its segments the mix is silent at " + at);
  assert.ok(peak(out, 2.1, 0.3) < 12, "the second segment starts at its own delay, not earlier");
});
// review fix 2: volume's enable is tested once per frame, at its start - after the first segment amix passed on apad's 4096-sample
// packets, so a mute window inside a later segment began up to ~85 ms late. The frames before the mute stage are 256 samples.
test("review fix 2: a mute window inside a later segment silences within ~20 ms of its start, at unchanged levels", async () => {
  const base = path.join(tmp, "mute2.png"), out = path.join(tmp, "mute2.mp4"), ref = path.join(tmp, "mute2-ref.mp4");
  await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#10151d" } }).png().toFile(base);
  const muted = [[2.33, 2.6], [3.0, 3.5], [3.71, 4.2]];               // all inside the second segment (1.8 s - 4.8 s), off frame edges
  const args = M.composeArgs({ base, tiles: [], rectangles: [], duration: 5, audioFile: tone,
    audio: { reason: null, muted, segments: [{ begin: 0, end: 1, at: 0 }, { begin: 1, end: 4, at: 1.8 }] }, out });
  const gi = args.indexOf("-filter_complex") + 1, graph = args[gi];
  assert.match(graph, /adelay=1800\|1800,apad,atrim=end=5\.0000\[ad1\]/);
  assert.match(graph, /amix=inputs=2,volume=2,apad,atrim=duration=5\.0000,asetnsamples=n=256:p=0,volume=0:enable='between\(t,2\.3300,2\.6000\)\+/);
  // Set FFMPEG_PATH / FFPROBE_PATH to a 4.x build to prove the same graph there.
  await fm.run(fm.bin("ffmpeg"), args, { timeoutMs: 30000 });
  const refArgs = args.slice(); refArgs[gi] = graph.replace(",asetnsamples=n=256:p=0", ""); refArgs[refArgs.length - 1] = ref;
  await fm.run(fm.bin("ffmpeg"), refArgs, { timeoutMs: 30000 });
  const SR = 48000, decode = file => ff(["-i", file, "-map", "0:a:0", "-ac", "1", "-ar", String(SR), "-f", "s16le", "pipe:1"]);
  const pcm = decode(out), pcmRef = decode(ref);
  const peak = (buf, a, b) => { let m = 0; for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) m = Math.max(m, Math.abs(buf.readInt16LE(i * 2))); return m; };
  for (const [a, b] of muted) {
    assert.ok(peak(pcm, a - .06, a - .03) > 1000, "audible just before the window at " + a);
    let last = null;
    for (let s = a - .1; s < b - .05; s += .0025) if (peak(pcm, s, s + .0025) > 300) last = s + .0025;
    assert.ok(last - a <= .02, `silent within 20 ms of ${a} s: audible until +${Math.round((last - a) * 1000)} ms`);
  }
  for (const [a, b] of [[1.9, 2.25], [2.7, 2.95]]) {                    // the same levels as without the re-cut
    const p = peak(pcm, a, b), q = peak(pcmRef, a, b);
    assert.ok(q > 1000 && Math.abs(p - q) <= q * .02, `level at ${a} s: ${p} vs ${q}`);
  }
});
test("capture consent uses the strict private-profile lookup and refuses when it fails", async () => {
  // review fix: camRefusal swallows a failed lookup as "public"; the fixture's camRefusal lets everyone through.
  M.configure({ privateLogins: async () => { throw Error("profile read failed"); } });
  assert.equal((await T.tileFor(cam("alice"), R, U)).mode, "blank");
  assert.equal(await T.consent("alice", U.userId), false);
  M.configure({ people: async () => ["alice"] });
  assert.equal(await M.recheck({ id: id(), room_id: R.id, user_id: U.userId, kind: "photo" }), T.MSG.revoked);
  M.configure({ privateLogins: async ls => new Set(ls.filter(l => l === "alice")) });
  assert.equal((await T.tileFor(cam("alice"), R, U)).mode, "blank");
  assert.equal((await T.tileFor(cam("bob"), R, U)).mode, "live");
});

// UI sandbox for the actual stage-capture.js. Append this section to stagemiccap.test.js.
// Block scope keeps its fixtures independent from the server/ffmpeg harness.
{
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const uiRepo = fs.existsSync(path.join(__dirname, '../public/js/stage-capture.js')) ? path.resolve(__dirname, '..') : path.join(__dirname, 'PATV');
const uiSource = fs.readFileSync(path.join(uiRepo, 'public/js/stage-capture.js'), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function uiSandbox(options = {}) {
  let now = 100000, sequence = 0, room = 'alpha';
  const timers = new Map(), events = {}, calls = [];
  const document = { activeElement: null, hidden: false, body: null, addEventListener(k, fn) { (events[k] ||= []).push(fn); }, removeEventListener(k, fn) { events[k] = (events[k] || []).filter(f => f !== fn); } };
  function node(tag) {
    const classes = new Set(), listeners = {};
    const e = { tagName: tag.toUpperCase(), attrs: {}, children: [], parentNode: null, style: {}, textContent: '', disabled: false,
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, value) { const yes = value == null ? !classes.has(c) : !!value; if (yes) classes.add(c); else classes.delete(c); return yes; } },
      get className() { return [...classes].join(' '); }, set className(v) { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => classes.add(c)); },
      get isConnected() { return this === document.body || !!(this.parentNode && this.parentNode.isConnected); },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; if (k === 'value') this.value = v; if (k === 'title') this.title = v; },
      getAttribute(k) { return this.attrs[k]; }, appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; },
      addEventListener(k, fn) { (listeners[k] ||= []).push(fn); }, focus() { document.activeElement = this; },
      dispatch(k, extra = {}) { const event = { target: this, preventDefault() {}, ...extra }; for (let parent = this; parent; parent = parent.parentNode) (parent._listeners[k] || []).forEach(fn => fn(event)); },
      closest(selector) { for (let parent = this; parent; parent = parent.parentNode) if (matches(parent, selector)) return parent; return null; },
      querySelectorAll(selectors) { const result = []; function visit(parent) { parent.children.forEach(child => { if (selectors.split(/,\s*/).some(s => matches(child, s))) result.push(child); visit(child); }); } visit(this); return result; },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }, _listeners: listeners,
    };
    let html = '';
    Object.defineProperty(e, 'innerHTML', { get: () => html, set(value) {
      html = String(value); e.children.forEach(c => { c.parentNode = null; }); e.children = [];
      const stack = [e], tags = /<\/?([a-z][a-z0-9-]*)([^>]*)>|([^<]+)/ig; let match;
      while ((match = tags.exec(html))) {
        if (match[3]) { stack[stack.length - 1].textContent += match[3]; continue; }
        if (match[0][1] === '/') { if (stack.length > 1) stack.pop(); continue; }
        const child = node(match[1]), attr = /([\w-]+)(?:="([^"]*)")?/g; let part;
        while ((part = attr.exec(match[2]))) child.setAttribute(part[1], part[2] == null ? '' : part[2]);
        stack[stack.length - 1].appendChild(child);
        if (!['img', 'input', 'br', 'hr'].includes(match[1].toLowerCase())) stack.push(child);
      }
    } });
    return e;
  }
  function matches(e, s) { if (s[0] === '.') return e.classList.contains(s.slice(1)); const attr = /^\[([^=]+)="([^"]+)"\]$/.exec(s); return attr ? e.getAttribute(attr[1]) === attr[2] : e.tagName.toLowerCase() === s; }
  document.createElement = node; document.body = node('body');
  function timeout(fn, delay, repeat) { const id = ++sequence; timers.set(id, { at: now + (delay || 0), fn, repeat }); return id; }
  const permissions = { ok: true, signed: true, eligible: true, enabled: { snap: true, clip: true }, prices: { snap: 10, clip: 20 }, clip: { def: 20, max: 30 }, mic: { snap: true, clip: true, why: null }, ...options.me };
  let status = { id: 'capture-one', source: 'mic', state: 'recording', secs: 20, kind: 'clip', stream: 'the mic', ready_by: now + 22000, price: 20 };
  const context = { document, console, Promise, Date: { now: () => now }, location: { pathname: options.pathname || '/p/alpha' },
    setTimeout: (fn, ms) => timeout(fn, ms), clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => timeout(fn, ms, ms), clearInterval: id => timers.delete(id),
    fetch(url, init) {
      const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers, at: now }; calls.push(call);
      const result = options.fetch ? options.fetch(call, clone(status), clone(permissions)) : null;
      if (result) return Promise.resolve(result);
      const data = url.includes('/me?') ? permissions : url.endsWith('/discard') ? { ok: true } : { ok: true, capture: status };
      return Promise.resolve({ ok: true, status: 200, json: async () => clone(data) });
    }
  };
  context.window = context; vm.runInNewContext(uiSource, context);
  const host = node('div'); document.body.appendChild(host); const bar = context.PATVStage.capture({ host, room: () => room });
  const selection = { stream: 'mic', capture: false, embed: true, label: 'On the mic' }; bar.update(selection);
  async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms; await flush(); let turns = 0;
    while (true) {
      let next = null; for (const pair of timers) if (pair[1].at <= end && (!next || pair[1].at < next[1].at)) next = pair;
      if (!next) break; if (++turns > 10000) throw new Error('timer loop');
      now = next[1].at; if (next[1].repeat) next[1].at += next[1].repeat; else timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  return { host, bar, document, calls, context, permissions, advance, flush,
    button: kind => host.querySelector('[data-k="' + kind + '"]'), dialog: () => document.body.querySelector('.stcap-dlg'),
    status(value) { status = { ...status, ...value }; }, room(value) { room = value; bar.update(selection); },
    key(key) { (events.keydown || []).slice().forEach(fn => fn({ key, preventDefault() {} })); }
  };
}

test('mic capture UI uses mic gates before embed/capture:false; off hides it and per-kind refusal is greyed', async () => {
  const s = uiSandbox(); await s.flush(); assert.ok(s.button('snap')); assert.ok(s.button('clip')); assert.match(s.host.innerHTML, /Clip the next 20 s/); assert.doesNotMatch(s.host.innerHTML, /YouTube/);
  assert.match(s.calls.find(c => c.url.includes('/me?')).url, /&surface=pad$/);
  s.permissions.mic = { snap: true, clip: false, why: 'Clips off', clip_why: 'Ask a moderator' }; await s.bar.reload();
  assert.equal(s.button('snap').disabled, false); assert.equal(s.button('clip').disabled, true); assert.equal(s.button('clip').title, 'Ask a moderator');
  s.permissions.mic = null; await s.bar.reload(); assert.equal(s.host.innerHTML, ''); assert.equal(s.host.classList.contains('hide'), true);
  s.bar.update({ stream: 'embed-one', embed: true, label: 'YouTube' }); assert.match(s.host.innerHTML, /YouTube and Twitch/);
  s.bar.update({ stream: 'slot-one', capture: true, label: 'Host' }); assert.match(s.host.innerHTML, />last 20 s</);
});

test('mic capture UI records then cuts then opens a fixed capture preview with localized privacy/audio notes', async () => {
  const s = uiSandbox(); await s.flush(); s.button('clip').dispatch('click'); await s.flush();
  const create = s.calls.find(c => c.url === '/api/stage/capture'); assert.equal(create.body.surface, 'pad'); assert.equal(create.body.stream, 'mic'); assert.equal(create.headers['X-Requested-With'], 'fetch');
  assert.match(s.dialog().querySelector('.stcap-msg').textContent, /Recording… 20 s/); assert.equal(s.dialog().querySelector('video'), null);
  await s.advance(1000); assert.match(s.dialog().querySelector('.stcap-msg').textContent, /19 s/);
  s.bar.update({ stream: 'other', capture: true, label: 'Other' }); s.status({ state: 'cutting' }); await s.advance(1000); assert.match(s.dialog().querySelector('.stcap-msg').textContent, /Cutting/);
  s.status({ state: 'preview', preview: '/preview', audio_note: { kind: 'muted', secs: 4.3 } }); await s.advance(2000);
  assert.ok(s.dialog().querySelector('video')); assert.match(s.dialog().innerHTML, /Veiled speakers/); assert.match(s.dialog().innerHTML, /4.3 s muted/);
  assert.ok(s.dialog().querySelector('.stcap-save')); assert.equal(s.calls.filter(c => c.url.endsWith('/discard')).length, 0, 'preview handover never discards the completed job');
});

for (const method of ['close', 'escape']) test('mic capture UI ' + method + ' cancels the server job and ignores late status responses', async () => {
  let resolveStatus;
  const s = uiSandbox({ fetch(call) { if (call.method === 'GET' && call.url.endsWith('/capture-one')) return new Promise(resolve => { resolveStatus = resolve; }); } });
  await s.flush(); s.button('clip').dispatch('click'); await s.flush(); await s.advance(2000);
  if (method === 'close') s.dialog().querySelector('.stcap-x').dispatch('click'); else s.key('Escape'); await s.flush();
  assert.equal(s.dialog(), null); assert.equal(s.calls.filter(c => c.url.endsWith('/discard')).length, 1);
  resolveStatus({ ok: true, json: async () => ({ ok: true, capture: { state: 'preview', preview: '/late', id: 'capture-one' } }) }); await s.advance(20000);
  assert.equal(s.dialog(), null); assert.equal(s.calls.filter(c => c.url.endsWith('/capture-one')).length, 1);
});

test('mic capture UI retries transient status failures and failed cancellation without losing the cancel action', async () => {
  let denyCancel = true, failStatus = true;
  const s = uiSandbox({ fetch(call) {
    if (call.url.endsWith('/discard') && denyCancel) return Promise.reject(new Error('offline'));
    if (call.url.endsWith('/capture-one') && failStatus) return { ok: false, status: 503, json: async () => ({ ok: false, error: 'Busy' }) };
  } });
  await s.flush(); s.button('clip').dispatch('click'); await s.flush(); await s.advance(2000);
  assert.match(s.dialog().querySelector('.stcap-note').textContent, /Checking the recording again/);
  failStatus = false; await s.advance(2000); assert.equal(s.dialog().querySelector('.stcap-note').textContent, '');
  s.key('Escape'); await s.flush(); assert.match(s.dialog().querySelector('.stcap-discard').textContent, /Retry cancellation/);
  denyCancel = false; s.dialog().querySelector('.stcap-discard').dispatch('click'); await s.flush(); assert.equal(s.dialog(), null);
});

test('mic capture UI deadline is seconds plus sixty even if polling hangs; home surface is declared', async () => {
  const s = uiSandbox({ pathname: '/', fetch(call) { if (call.method === 'GET' && call.url.endsWith('/capture-one')) return new Promise(() => {}); } });
  await s.flush(); s.button('clip').dispatch('click'); await s.flush();
  assert.equal(s.calls.find(c => c.url === '/api/stage/capture').body.surface, 'home'); assert.match(s.calls.find(c => c.url.includes('/me?')).url, /&surface=home$/); await s.advance(80000);
  assert.match(s.dialog().querySelector('.stcap-msg').textContent, /took too long/); assert.equal(s.calls.filter(c => c.url.endsWith('/discard')).length, 1);
  assert.equal(s.dialog().querySelector('.stcap-discard').textContent, 'Close'); s.key('Escape'); assert.equal(s.dialog(), null);
});

test('mic capture UI rejects stale pad permissions and preserves the chosen clip duration on settings refresh', async () => {
  let complete;
  const s = uiSandbox({ fetch(call) { if (call.url.includes('/me?room=alpha')) return new Promise(resolve => { complete = resolve; }); } });
  s.room('beta'); await s.flush(); assert.ok(s.button('clip'));
  complete({ ok: true, json: async () => ({ ok: true, mic: null }) }); await s.flush(); assert.ok(s.button('clip'), 'old alpha result does not hide beta controls');
  const select = s.host.querySelector('.stcap-secs'); select.value = '30'; select.dispatch('change'); await s.bar.reload(); assert.match(s.button('clip').textContent, /30 s/);
});

test('mic capture UI explains absent audio and failed recording never offers a broken preview', async () => {
  for (const [kind, pattern] of [['off', /pad&#39;s audio is off/], ['old-pepe', /needs a newer Pepe/]]) {
    const s = uiSandbox(); await s.flush(); s.status({ state: 'preview', kind: 'photo', preview: '/still', audio_note: { kind } });
    s.button('snap').dispatch('click'); await s.flush(); assert.match(s.dialog().innerHTML, pattern); assert.ok(s.dialog().querySelector('img'));
  }
  const s = uiSandbox(); await s.flush(); s.button('clip').dispatch('click'); await s.flush();
  s.status({ state: 'failed', message: 'Recording stopped.' }); await s.advance(2000);
  assert.equal(s.dialog().querySelector('video'), null); assert.equal(s.dialog().querySelector('.stcap-save'), null);
  assert.equal(s.dialog().querySelector('.stcap-msg').textContent, 'Recording stopped.'); s.key('Escape'); assert.equal(s.dialog(), null);
  assert.equal(s.calls.filter(c => c.url.endsWith('/discard')).length, 0, 'failed job already stopped on the server');
});

test('mic capture UI strings match English catalog and the admin checkbox uses normal config serialization', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(uiRepo, 'locales/en.json'), 'utf8'));
  const calls = uiSource.matchAll(/_t\('([^']+)',\s*'((?:\\.|[^'\\])*)'/g);
  for (const call of calls) assert.equal(catalog[call[1]], call[2].replace(/\\'/g, "'"), call[1]);
  const admin = fs.readFileSync(path.join(uiRepo, 'views/stageAdmin.ejs'), 'utf8'), config = fs.readFileSync(path.join(uiRepo, 'mainstage.js'), 'utf8');
  assert.match(admin, /name="stagecap_mic"[^\n]*C\.stagecap_mic === true/); assert.match(config, /stagecap_mic: false/); assert.match(config, /stagecap_mic: onOff\(c\.stagecap_mic, DEFAULTS\.stagecap_mic\)/);
  assert.match(fs.readFileSync(path.join(uiRepo, 'public/js/stage-admin.js'), 'utf8'), /body\[el.name\] = el.type === 'checkbox' \? el.checked : el.value/);
});
}

test("1.99ahp stable slots: a stable program's capture draws each tile in its place's cell - an empty place stays empty (grid), picture in picture's big picture is place 0 (not the newest), dynamic keeps place order with 2 and puts the main in the big cell with 3+", () => {
  const grid = M.rects({ layout: "grid4", stable: true, src: [cam("a", { pos: 0 }), cam("c", { pos: 2 }), cam("d", { pos: 3 })] });
  const r = id => grid.find(x => x.id === id);
  assert.deepEqual([r("a").x, r("a").y], [0, 0]);
  assert.deepEqual([r("c").x, r("c").y > 300], [0, true], "place 2: bottom left - place 1 stays an empty cell");
  assert.ok(r("d").x > 600 && r("d").y > 300);
  const old = M.rects({ layout: "grid4", src: [cam("a", { pos: 0 }), cam("c", { pos: 2 }), cam("d", { pos: 3 })] });
  assert.ok(old.find(x => x.id === "c").x > 600 && old.find(x => x.id === "c").y === 0, "without stable: today's (filled in order)");
  // picture in picture: place 0 fills the frame even while the other one talks
  const pip = M.rects({ layout: "pip", stable: true, src: [cam("a", { pos: 0 }), cam("b", { pos: 1, newest: true })] });
  assert.deepEqual(pip[0], { id: "a", x: 0, y: 0, w: 1280, h: 720 });
  assert.equal(M.rects({ layout: "pip", src: [cam("a", { pos: 0 }), cam("b", { pos: 1, newest: true })] })[0].id, "b", "without stable: the newest");
  // dynamic, 2: place order (the main field never jumps a tile into cell 0)
  const d2 = M.rects({ stable: true, src: [cam("a", { pos: 0 }), cam("b", { pos: 1 })], dyn: { n: 2, t: "d2", main: "b" } });
  assert.deepEqual(d2.map(x => [x.id, x.x === 0]), [["a", true], ["b", false]]);
  // dynamic, 3+: the main in the big cell, trading with place 0 - the others keep their cells
  const d3 = M.rects({ stable: true, src: [cam("a", { pos: 0 }), cam("b", { pos: 1 }), cam("c", { pos: 2 })], dyn: { n: 3, t: "d3", main: "c" } });
  const plain = M.rects({ src: [cam("c", { pos: 0 }), cam("b", { pos: 1 }), cam("a", { pos: 2 })], dyn: { n: 3, t: "d3", main: "c" } });
  assert.deepEqual(d3, plain, "c big, b where it was, a in c's old cell");
});
