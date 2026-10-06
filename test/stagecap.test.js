// Offline tests for stage snaps / clips (1.99cr, stagecap.js): who may capture, the stream resolved
// through the stage registry only (path / name injection refused, embeds excluded, the streamer's
// opt-out honoured), rate limits, the real ffmpeg extraction from a generated testsrc HLS, the
// website action Pepe charges through (check -> publish, idempotent, gone -> Pepe refunds), the pad's
// story (label fields, NSFW), deleting, and the content_audit row.
//   node --test test/stagecap.test.js      (needs the repo's node_modules, ffmpeg + ffprobe on PATH; temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stagecap-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.MEDIA_DIR = path.join(tmp, "media");
process.env.FEED_DIR = path.join(tmp, "feed");
process.env.FEED_NO_NICE = "1";
const HLS = path.join(tmp, "hls"), PEPE = path.join(tmp, "hls-pepe");
fs.mkdirSync(HLS, { recursive: true }); fs.mkdirSync(PEPE, { recursive: true });

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SC = require(path.join(repo, "stagecap"));
const MS = require(path.join(repo, "mainstage"));
const media = require(path.join(repo, "media"));
const stories = require(path.join(repo, "stories"));
require(path.join(repo, "actions"));

const ROOM = { id: "Room.One", slug: "room-one", title: "Room One" };
const OTHER = { id: "Room.Two", slug: "room-two", title: "Room Two" };
const U = {
  linked: { userId: "u1", username: "linky", class: "pleb" },
  lvl2: { userId: "u2", username: "leveltwo", class: "pleb" },
  newbie: { userId: "u3", username: "newbie", class: "pleb" },
  owner: { userId: "u4", username: "padowner", class: "pleb" },
  staff: { userId: "u5", username: "boss", class: "Admin" },
  streamer: { userId: "u6", username: "streamer", class: "pleb" },
  other: { userId: "u7", username: "rando", class: "pleb" },
};
let pepeHere = true;
let T0 = 0;                              // clock offset (rate limits); stays small so the HLS files look fresh
SC._setClock(() => Date.now() + T0);
const adv = (ms) => { T0 += ms; };

function ff(args) { execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { stdio: "ignore" }); }
/** A live-looking HLS stream: `secs` of testsrc + a tone in 2 s segments, the playlist listing the last `list` of them. */
function makeHls(dir, name, { secs = 12, list = 0 } = {}) {
  ff(["-f", "lavfi", "-i", "testsrc=size=1280x720:rate=25", "-f", "lavfi", "-i", "sine=frequency=440", "-t", String(secs),
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "50", "-keyint_min", "50", "-sc_threshold", "0", "-c:a", "aac",
      "-metadata", "title=SECRETMARK", "-f", "hls", "-hls_time", "2", "-hls_list_size", String(list),
      "-hls_segment_filename", path.join(dir, name + "-%d.ts"), path.join(dir, name + ".m3u8")]);
}

let base, server, slotLive, slotEmbed, slotOff, slotOther;
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function post(p, body, u, headers) {
  const r = await fetch(base + p, { method: "POST", headers: headers || H(u), body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function get(p, u) { const r = await fetch(base + p, { headers: H(u) }); return { status: r.status, d: await r.json().catch(() => ({})) }; }
const snap = (u, stream, extra = {}) => post("/api/stage/capture", Object.assign({ room: ROOM.slug, stream, kind: "snap" }, extra), u);

async function mkSlot(id, roomId, user, extra = {}) {
  const stream = extra.stream || "stage-" + id.replace(/[^a-f0-9]/g, "").padEnd(16, "0").slice(0, 16);
  await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held, stream, publishing, beat,
                  room_id, kind, mode, embed, start_at, went_live) VALUES (?, ?, ?, ?, 'active', ?, 30, 0, 0, ?, 1, ?, ?, 'slot', ?, ?, ?, ?)`,
    [id, user.userId, user.username, extra.display || user.username, Date.now(), stream, Date.now() + 3600e3, roomId, extra.mode || "stream",
     extra.embed || null, Date.now(), Date.now()]);
  return { id, stream };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 1,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, discordId TEXT, twitchId TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  const rows = [[U.linked, "linkycf", 1], [U.lvl2, null, 2], [U.newbie, null, 1], [U.owner, "ownercf", 3], [U.staff, null, 1], [U.streamer, "streamcf", 4], [U.other, "randocf", 2]];
  for (const [u, cf, lvl] of rows) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                   [u.userId, u.username, u.username.toUpperCase(), u.class, cf, lvl]);
  }
  await MS.init();
  await SC.init();
  SC._setDirs(HLS, PEPE);
  SC._setDeps({
    resolveRoom: async (s) => (s === ROOM.slug ? ROOM : s === OTHER.slug ? OTHER : null),
    pepeIn: () => pepeHere,
    roomCmds: (rid) => (rid === ROOM.id ? { "!snap": 30000, "!clip": 60000 } : {}),
    canManage: async (u, rid) => !!u && (u.class === "Admin" || (u.userId === U.owner.userId && rid === ROOM.id)),
    isStaff: (u) => !!u && (u.class === "Admin" || u.class === "Staff"),
  });
  slotLive = await mkSlot("aaaaaaaa-1111", ROOM.id, U.streamer, { display: "Streamy" });
  slotEmbed = await mkSlot("bbbbbbbb-2222", ROOM.id, U.other, { mode: "embed", embed: JSON.stringify({ p: "youtube", t: "video", id: "dQw4w9WgXcQ" }) });
  slotOff = await mkSlot("cccccccc-3333", ROOM.id, U.other);
  slotOther = await mkSlot("dddddddd-4444", OTHER.id, U.other);
  makeHls(HLS, slotLive.stream, { secs: 40, list: 5 });       // 20 segments on disk, the playlist lists the last 5 (10 s)
  makeHls(HLS, slotOff.stream, { secs: 6 });
  makeHls(HLS, slotOther.stream, { secs: 6 });
  makeHls(PEPE, "broadcast", { secs: 8 });
  const app = express();
  const byId = Object.fromEntries(Object.values(U).map((u) => [u.userId, u]));
  const addUser = (req, res, next) => { req.user = byId[req.get("x-test-user")] || null; next(); };
  SC.register(app, { addUser, isBotToken: (t) => t === "bot-token", noTimers: true });
  media.register(app, { addUser, isBotToken: (t) => t === "bot-token" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());
test.beforeEach(() => {
  SC._hits.clear();
  // nginx-rtmp rewrites a live playlist every fragment: keep ours looking live (the hostile one goes stale on purpose)
  const now = Date.now() / 1000;
  for (const [d, n] of [[HLS, slotLive.stream], [HLS, slotOff.stream], [HLS, slotOther.stream], [PEPE, "broadcast"]]) fs.utimesSync(path.join(d, n + ".m3u8"), now, now);
});

// ───────────────────────────── who may capture ─────────────────────────────
test("permissions: signed out 401, unlinked level-1 403, a linked name or level >= 2 may; CSRF header required", async () => {
  assert.equal((await snap(null, "pepe")).status, 401);
  const n = await snap(U.newbie, "pepe");
  assert.equal(n.status, 403);
  assert.match(n.d.error, /linked Camfrog name/);
  assert.equal((await post("/api/stage/capture", { room: ROOM.slug, stream: "pepe", kind: "snap" }, U.linked, { "content-type": "application/json", "x-test-user": "u1" })).status, 403, "no X-Requested-With");
  assert.equal((await post("/api/stage/capture", { room: ROOM.slug, stream: "pepe", kind: "snap" }, U.linked, H(U.linked, { origin: "https://evil.example" }))).status, 403, "cross-site");
  const a = await snap(U.linked, "pepe");
  assert.equal(a.status, 200, a.d.error);
  const b = await snap(U.lvl2, slotLive.id);
  assert.equal(b.status, 200, b.d.error);
  const me = (await get("/api/stage/captures/me?room=" + ROOM.slug, U.newbie)).d;
  assert.equal(me.eligible, false);
  assert.deepEqual(me.prices, { snap: 30000, clip: 60000 }, "the room's !snap / !clip prices from Pepe's command menu");
  assert.deepEqual((await get("/api/stage/captures/me?room=" + OTHER.slug, U.linked)).d.prices, { snap: SC.PRICES.snap, clip: SC.PRICES.clip }, "else his defaults");
  for (const c of [a.d.capture, b.d.capture]) await post("/api/stage/captures/" + c.id + "/discard", {}, c === a.d.capture ? U.linked : U.lvl2);
});

// ───────────────────────────── the stream: registry only ─────────────────────────────
test("path validation: names and paths from the browser are refused; only a slot of THIS pad resolves", async () => {
  for (const bad of ["../../etc/passwd", "..\\..\\x", "broadcast", "stage-0000000000000000", slotLive.stream, "pepe/../x", "/mnt/hls/broadcast.m3u8",
                     "http://evil/x.m3u8", "aaaa", "", "x".repeat(200)]) {
    const r = await snap(U.linked, bad);
    assert.ok([400, 404].includes(r.status), `${bad} -> ${r.status} ${r.d.error}`);
    SC._hits.clear();
  }
  const other = await snap(U.linked, slotOther.id);
  assert.equal(other.status, 404, "another pad's slot isn't on this stage");
  assert.equal((await post("/api/stage/capture", { room: "../room-one", stream: "pepe", kind: "snap" }, U.linked)).status, 404);
  // the HLS helpers themselves
  assert.equal(SC.playlistPath(HLS, "../x"), null);
  assert.equal(SC.playlistPath(HLS, "a/b"), null);
  assert.equal(SC.playlistPath(HLS, "a.b"), null);
  assert.equal(SC.playlistPath(HLS, "stage-abc"), path.join(HLS, "stage-abc.m3u8"));
  assert.throws(() => SC.liveSegments(HLS, "../hls/" + slotLive.stream), /can't be captured/);
});

test("a hostile playlist: only '<stream>-<n>.ts' files inside the HLS dir are ever read", async () => {
  const name = "stage-feedfacefeedface";
  fs.writeFileSync(path.join(tmp, "secret.ts"), "nope");
  fs.copyFileSync(path.join(HLS, slotOff.stream + "-0.ts"), path.join(HLS, name + "-7.ts"));
  fs.writeFileSync(path.join(HLS, name + ".m3u8"), ["#EXTM3U", "#EXT-X-TARGETDURATION:2",
    "#EXTINF:2.0,", "../secret.ts", "#EXTINF:2.0,", path.join(tmp, "secret.ts"), "#EXTINF:2.0,", "http://169.254.169.254/latest.ts",
    "#EXTINF:2.0,", "file:///etc/passwd", "#EXTINF:2.0,", slotOff.stream + "-0.ts", "#EXTINF:2.0,", name + "-7.ts", ""].join("\n"));
  const segs = SC.liveSegments(HLS, name);
  assert.deepEqual(segs.map((s) => s.file), [name + "-7.ts"]);
  // a symlinked segment is not a plain file (skipped where the OS lets us make one)
  try {
    fs.symlinkSync(path.join(tmp, "secret.ts"), path.join(HLS, name + "-8.ts"));
    fs.appendFileSync(path.join(HLS, name + ".m3u8"), "#EXTINF:2.0,\n" + name + "-8.ts\n");
    assert.deepEqual(SC.liveSegments(HLS, name).map((s) => s.file), [name + "-7.ts"]);
  } catch (e) { if (!/EPERM|EACCES/.test(String(e.code || e.message))) throw e; }
  // stale playlist = not live
  const old = (Date.now() - 120e3) / 1000;
  fs.utimesSync(path.join(HLS, name + ".m3u8"), old, old);
  assert.throws(() => SC.liveSegments(HLS, name), /isn't live/);
});

test("embeds can't be captured; Pepe's stream only while he's in the pad's room", async () => {
  const e = await snap(U.linked, slotEmbed.id);
  assert.equal(e.status, 409);
  assert.match(e.d.error, /YouTube and Twitch/);
  pepeHere = false;
  const p = await snap(U.linked, "pepe");
  assert.equal(p.status, 409);
  assert.match(p.d.error, /Pepe's stream isn't on this pad's stage/);
  pepeHere = true;
});

// ───────────────────────────── the streamer's opt-out + NSFW ─────────────────────────────
test("opt-out: the streamer (or the pad's managers) switch captures off; nobody else can; then it's refused", async () => {
  assert.equal((await post("/api/stage/slots/" + slotOff.id + "/capture", { allow: false }, U.linked)).status, 403, "not their slot");
  const r = await post("/api/stage/slots/" + slotOff.id + "/capture", { allow: false }, U.other);
  assert.equal(r.status, 200);
  assert.equal(r.d.capture, false);
  const s = await snap(U.linked, slotOff.id);
  assert.equal(s.status, 403);
  assert.match(s.d.error, /turned off snaps and clips/);
  const pub = (await MS.publicSlots(ROOM.id)).find((x) => x.id === slotOff.id);
  assert.equal(pub.capture, false, "the player hides the buttons");
  assert.equal((await post("/api/stage/slots/" + slotOff.id + "/capture", { allow: true }, U.owner)).d.capture, true, "the pad owner can switch it back");
  SC._hits.clear();
  assert.equal((await snap(U.linked, slotOff.id)).status, 200);
  assert.equal((MS.view(await MS.getSlot(slotOff.id))).capture, true, "default allowed");
});

// ───────────────────────────── rate limits ─────────────────────────────
test("rate limits: one snap / 10 s and one clip / 60 s per user; one snap / 3 s per stream", async () => {
  await runQuery("UPDATE stage_captures SET state = 'discarded'");
  const a = await snap(U.linked, "pepe");
  assert.equal(a.status, 200, a.d.error);
  const again = await snap(U.linked, "pepe");
  assert.equal(again.status, 429);
  assert.match(again.d.error, /one snap every 10 s/);
  const someoneElse = await snap(U.lvl2, "pepe");
  assert.equal(someoneElse.status, 429, "the same stream within 3 s");
  assert.match(someoneElse.d.error, /Someone just snapped/);
  adv(3500);
  assert.equal((await snap(U.lvl2, "pepe")).status, 200, "the stream's gap has passed");
  adv(7000);
  assert.equal((await snap(U.linked, "pepe")).status, 200, "the user's 10 s have passed");
  const c1 = await post("/api/stage/capture", { room: ROOM.slug, stream: slotLive.id, kind: "clip", secs: 4 }, U.other);
  assert.equal(c1.status, 200, c1.d.error);
  adv(25000);
  const c2 = await post("/api/stage/capture", { room: ROOM.slug, stream: slotLive.id, kind: "clip", secs: 4 }, U.other);
  assert.equal(c2.status, 429);
  assert.match(c2.d.error, /one clip every 60 s/);
  // at most 3 open previews each
  await runQuery("UPDATE stage_captures SET state = 'discarded'");
  for (let i = 0; i < 3; i++) { adv(11000); assert.equal((await snap(U.lvl2, "pepe")).status, 200); }
  adv(11000);
  const more = await snap(U.lvl2, "pepe");
  assert.equal(more.status, 429);
  assert.match(more.d.error, /Save or discard/);
  await runQuery("UPDATE stage_captures SET state = 'discarded'");
});

// ───────────────────────────── extraction (real ffmpeg) ─────────────────────────────
test("snap = a webp from the newest segment; clip = H.264/AAC mp4 <= 720p of the last N s, metadata dropped", async () => {
  adv(70000);
  const s = await snap(U.linked, slotLive.id);
  assert.equal(s.status, 200, s.d.error);
  const cs = (await getQuery("SELECT * FROM stage_captures WHERE id = ?", [s.d.capture.id]))[0];
  const sp = path.join(media.DIR, "stagecap-tmp", cs.id + ".webp");
  const head = fs.readFileSync(sp).subarray(0, 12).toString("latin1");
  assert.ok(head.startsWith("RIFF") && head.endsWith("WEBP"), "a webp");
  const meta = await require("sharp")(sp).metadata();
  assert.equal(meta.width, 1280);
  assert.ok(!meta.exif && !meta.xmp);
  // the preview is only for its maker
  assert.equal((await fetch(base + s.d.capture.preview, { headers: H(U.other) })).status, 404);
  const pv = await fetch(base + s.d.capture.preview, { headers: H(U.linked) });
  assert.equal(pv.status, 200);
  assert.equal(pv.headers.get("content-type"), "image/webp");
  assert.equal(pv.headers.get("x-content-type-options"), "nosniff");

  // 25 s asked: the playlist lists only 10 s, older segments on disk extend it (the cap is 30)
  const c = await post("/api/stage/capture", { room: ROOM.slug, stream: slotLive.id, kind: "clip", secs: 25 }, U.lvl2);
  assert.equal(c.status, 200, c.d.error);
  assert.ok(Math.abs(c.d.capture.secs - 25) <= 1.5, "about 25 s: " + c.d.capture.secs);
  const cp = path.join(media.DIR, "stagecap-tmp", c.d.capture.id + ".mp4");
  const pr = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height:format_tags", "-of", "json", cp]).toString());
  const v = pr.streams.find((x) => x.codec_type === "video"), a = pr.streams.find((x) => x.codec_type === "audio");
  assert.equal(v.codec_name, "h264");
  assert.ok(v.height <= 720 && v.width <= 1280);
  assert.equal(a.codec_name, "aac", "with audio");
  assert.ok(!fs.readFileSync(cp).toString("latin1").includes("SECRETMARK"), "metadata dropped");
  // 99 s asked -> capped at 30
  adv(70000);
  const big = await post("/api/stage/capture", { room: ROOM.slug, stream: slotLive.id, kind: "clip", secs: 99 }, U.other);
  assert.equal(big.status, 200, big.d.error);
  assert.ok(big.d.capture.secs <= SC.CLIP_MAX + 0.5, "capped: " + big.d.capture.secs);
  for (const [cap, u] of [[s.d.capture, U.linked], [c.d.capture, U.lvl2], [big.d.capture, U.other]]) await post("/api/stage/captures/" + cap.id + "/discard", {}, u);
  assert.ok(!fs.existsSync(cp), "a discarded preview's file is gone");
});

// ───────────────────────────── save: the website action Pepe charges ─────────────────────────────
test("save -> a stagecap.save action; Pepe checks, (charges,) publishes; the pad's story shows it; a gone capture = refund", async () => {
  adv(70000);
  const s = await snap(U.linked, slotLive.id);
  const id = s.d.capture.id;
  assert.equal(s.d.capture.price, 30000);
  assert.equal((await post("/api/stage/captures/" + id + "/save", {}, U.other)).status, 404, "not yours");
  const sv = await post("/api/stage/captures/" + id + "/save", { idem: "idem-" + id }, U.linked);
  assert.equal(sv.status, 200, sv.d.error);
  assert.equal(sv.d.capture.state, "saving");
  const act = (await getQuery("SELECT * FROM pepe_actions WHERE kind = 'stagecap.save' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(JSON.parse(act.args), [ROOM.id, id, "snap"]);
  assert.equal(act.camfrog, "linkycf");
  assert.equal((await post("/api/stage/captures/" + id + "/save", {}, U.linked)).d.capture.state, "saving", "a second click doesn't queue twice");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'stagecap.save' AND args LIKE ?", ["%" + id + "%"]))[0].n, 1);
  // Pepe's side: bot token + the account the action was queued for
  assert.equal((await post("/api/stage/captures/check", { password: "nope", id, user: "linky" })).status, 403);
  assert.equal((await post("/api/stage/captures/check", { password: "bot-token", id, user: "rando" })).status, 404);
  const ck = await post("/api/stage/captures/check", { password: "bot-token", id, user: "linky" });
  assert.deepEqual([ck.status, ck.d.kind, ck.d.room, ck.d.stream, ck.d.source], [200, "snap", ROOM.id, "Streamy", "slot"]);
  const pb = await post("/api/stage/captures/publish", { password: "bot-token", id, user: "linky", hours: 24, by: "LinkyCF" });
  assert.equal(pb.status, 200, pb.d.error);
  assert.match(pb.d.url, /^\/media\/[a-f0-9]{24}$/);
  const again = await post("/api/stage/captures/publish", { password: "bot-token", id, user: "linky", hours: 24 });
  assert.equal(again.d.url, pb.d.url, "a retried publish gets the same capture");
  const m = (await getQuery("SELECT * FROM media WHERE id = ?", [pb.d.id]))[0];
  assert.deepEqual([m.source, m.kind, m.ct, m.subject, m.by_user, m.room, m.by_user_id, m.slot_id, m.nsfw],
                   ["stage", "photo", "image/webp", "Streamy", "LinkyCF", ROOM.id, U.linked.userId, slotLive.id, 0]);
  assert.ok(media.fileExists(m), "webp files count as live captures");
  assert.equal((await get("/api/stage/captures/" + id, U.linked)).d.capture.url, pb.d.url);
  // the pad's story
  const st = await stories.forViewer({ userId: U.other.userId });
  const pad = st.find((r) => r.id === ROOM.id);
  const it = pad.items.find((x) => x.id === pb.d.id);
  assert.deepEqual([it.source, it.kind, it.subject, it.by, it.nsfw], ["stage", "photo", "Streamy", "LinkyCF", false]);
  assert.equal(pad.cover, it.src);
  // the captures feed
  assert.equal((await get("/api/stage/captures?pad=" + ROOM.slug, null)).status, 401);
  assert.ok((await get("/api/stage/captures?pad=" + ROOM.slug, U.other)).d.items.some((x) => x.id === pb.d.id));
  // the abuse record (admin-only) for the capturer
  const au = (await getQuery("SELECT * FROM content_audit WHERE kind = 'capture' AND target_id = ?", [pb.d.id]))[0];
  assert.equal(au.user_id, U.linked.userId);

  // a capture that expired before Pepe got to it: check and publish both say gone -> Pepe refunds
  adv(11000);
  const s2 = await snap(U.linked, "pepe");
  await post("/api/stage/captures/" + s2.d.capture.id + "/save", {}, U.linked);
  fs.unlinkSync(path.join(media.DIR, "stagecap-tmp", s2.d.capture.id + ".webp"));
  assert.equal((await post("/api/stage/captures/check", { password: "bot-token", id: s2.d.capture.id, user: "linky" })).status, 404);
  assert.equal((await post("/api/stage/captures/publish", { password: "bot-token", id: s2.d.capture.id, user: "linky" })).status, 410);
});

test("Pepe refused (not enough PAT): the capture goes back to preview with his reason; nothing published", async () => {
  adv(11000);
  const s = await snap(U.lvl2, "pepe");
  const id = s.d.capture.id;
  await post("/api/stage/captures/" + id + "/save", {}, U.lvl2);
  const act = (await getQuery("SELECT * FROM pepe_actions WHERE kind = 'stagecap.save' AND args LIKE ?", ["%" + id + "%"]))[0];
  assert.equal(act.camfrog, null, "an unlinked level-2 account: Pepe charges the PATV account");
  await runQuery("UPDATE pepe_actions SET status = 'failed', message = ? WHERE id = ?", ["a snap costs 25,000 PAT - you have 10", act.id]);
  const st = (await get("/api/stage/captures/" + id, U.lvl2)).d.capture;
  assert.equal(st.state, "preview");
  assert.match(st.message, /costs 25,000 PAT/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media WHERE stream = 'pepe' AND by_user_id = ?", [U.lvl2.userId]))[0].n, 0);
  await post("/api/stage/captures/" + id + "/discard", {}, U.lvl2);
});

test("NSFW slot: its captures are NSFW (story item flagged, never the cover); delete rights", async () => {
  await post("/api/stage/slots/" + slotLive.id + "/capture", { nsfw: true }, U.streamer);
  adv(11000);
  const s = await snap(U.other, slotLive.id);
  assert.equal(s.d.capture.nsfw, true);
  await post("/api/stage/captures/" + s.d.capture.id + "/save", {}, U.other);
  const pb = await post("/api/stage/captures/publish", { password: "bot-token", id: s.d.capture.id, user: "rando", by_anon: true });
  assert.equal(pb.status, 200);
  const m = (await getQuery("SELECT * FROM media WHERE id = ?", [pb.d.id]))[0];
  assert.equal(m.nsfw, 1);
  assert.equal(m.by_user, "someone", "an incognito capturer isn't named");
  const pad = (await stories.forViewer({ userId: U.linked.userId })).find((r) => r.id === ROOM.id);
  const it = pad.items.find((x) => x.id === pb.d.id);
  assert.equal(it.nsfw, true);
  assert.notEqual(pad.cover, it.src, "an NSFW snap is never the story's cover");
  await post("/api/stage/slots/" + slotLive.id + "/capture", { nsfw: false }, U.streamer);
  // delete: a random member no; the streamer, the capturer, the pad owner and staff yes
  assert.equal((await post("/api/stage/captures/media/" + pb.d.id + "/delete", {}, U.lvl2)).status, 403);
  assert.equal(await SC.canDelete(U.streamer, m), true);
  assert.equal(await SC.canDelete(U.other, m), true);
  assert.equal(await SC.canDelete(U.owner, m), true);
  assert.equal(await SC.canDelete(U.staff, m), true);
  assert.equal(await SC.canDelete(U.owner, { ...m, room: OTHER.id }), false, "not the owner of another pad");
  assert.equal((await post("/api/stage/captures/media/" + pb.d.id + "/delete", {}, U.owner)).status, 200);
  assert.equal((await getQuery("SELECT deleted FROM media WHERE id = ?", [pb.d.id]))[0].deleted, 1);
  assert.ok(!fs.existsSync(path.join(media.DIR, m.file)));
  assert.ok(!(await stories.forViewer({ userId: U.linked.userId })).some((r) => (r.items || []).some((x) => x.id === pb.d.id)));
});

test("sweep: unsaved previews expire and their files go", async () => {
  adv(11000);
  const s = await snap(U.linked, "pepe");
  const f = path.join(media.DIR, "stagecap-tmp", s.d.capture.id + ".webp");
  assert.ok(fs.existsSync(f));
  adv(SC.SAVE_TTL + 1000);
  await SC.sweep();
  assert.ok(!fs.existsSync(f));
  assert.equal((await getQuery("SELECT state FROM stage_captures WHERE id = ?", [s.d.capture.id]))[0].state, "expired");
  T0 = 0;
});
