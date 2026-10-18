// Offline tests for 1.99acw 📺 pictures and links on Pepe's OBS - the media pipeline (onairmedia.js):
//   * the chat grammar (parseChat): captions (plain, quoted, smart quotes), options in any order, `for` forms and clamping,
//     corner variants, with sound, missing rights, contradictions, unknown words, a first token that isn't a link
//   * URL rules: schemes / credentials / ports / length, private + mapped + .local addresses, a DNS answer with one private
//     address among public ones, a redirect to a private address
//   * the fetch pipeline against a local fixture server: PNG / JPEG / GIF / WebP re-encoded to webp (EXIF GPS gone), HTML refused
//     with the !onair link hint, SVG / too big / >200 frames / >20 s loop / 9000x10 refused; the same link reused
//   * the broadcast safety check (stubbed classifier): clearly safe only; suggestive 0.35 refused under the 0.30 margin;
//     minor_risk refused + flagged; a timeout refused (fail-closed); Pepe not pulling refused at once; a refused picture refused
//     again by its sha256 without a second classification; every distinct frame of an animation classified, frames merged only
//     when every pixel of every channel matches within 12 (even-brightness colour line art behind a mosaic is its own frame)
//   * link cards (text filter, a refused preview picture -> the card without it, favicons, YouTube hint), direct pictures (type
//     probe, redirects), live pages (own hosts / live_deny / private refused)
//   * uploads (purpose "onair": staff only, consumed after ingest, never attachable to a post), jobs + rate limit, the sweep
//   node --test test/onairmedia.test.js      (temp DB + dirs; a fixture server on 127.0.0.3)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onairmedia-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.ONAIR_MEDIA_DIR = path.join(tmp, "onairfiles");
process.env.IMAGESAFETY_DIR = path.join(tmp, "isf");
const express = require("express");
const sharp = require("sharp");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const lp = require(path.join(repo, "linkpreview"));
const ISF = require(path.join(repo, "imagesafety"));
const M = require(path.join(repo, "onairmedia"));
const fm = require(path.join(repo, "feedmedia"));
const store = require(path.join(repo, "feedstore"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);

const CFG = require(path.join(repo, "onair")).DEFAULTS;

// ── fixtures ──
/** A hand-built animated GIF: `frames` 1x1 frames (alternating colours), each `delayCs` hundredths of a second. */
function gif(frames, delayCs) {
  const parts = [Buffer.from("GIF89a", "latin1")];
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(1, 0); lsd.writeUInt16LE(1, 2); lsd[4] = 0x80; parts.push(lsd);
  parts.push(Buffer.from([0, 0, 0, 255, 255, 255]));
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([3, 1, 0, 0, 0]));
  for (let i = 0; i < frames; i++) {
    const gce = Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]); gce.writeUInt16LE(delayCs, 4); parts.push(gce);
    const id = Buffer.alloc(10); id[0] = 0x2c; id.writeUInt16LE(1, 5); id.writeUInt16LE(1, 7); parts.push(id);
    parts.push(Buffer.from([2, 2, i % 2 ? 0x4c : 0x44, 0x01, 0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
/** A GIF of real frames: palette (<= 128 [r, g, b]), frames [{px: Uint8Array of palette indices (w x h), delayCs}]. Uncompressed LZW
 *  (8-bit codes, a clear code every 126 pixels) - enough for test pictures. */
function gifOf(w, h, palette, frames) {
  const parts = [Buffer.from("GIF89a", "latin1")];
  const lsd = Buffer.alloc(7); lsd.writeUInt16LE(w, 0); lsd.writeUInt16LE(h, 2); lsd[4] = 0x80 | 0x70 | 6; parts.push(lsd);
  const gct = Buffer.alloc(128 * 3);
  palette.forEach((c, i) => { gct[i * 3] = c[0]; gct[i * 3 + 1] = c[1]; gct[i * 3 + 2] = c[2]; });
  parts.push(gct, Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([3, 1, 0, 0, 0]));
  for (const f of frames) {
    const gce = Buffer.from([0x21, 0xf9, 4, 0, 0, 0, 0, 0]); gce.writeUInt16LE(f.delayCs, 4); parts.push(gce);
    const id = Buffer.alloc(10); id[0] = 0x2c; id.writeUInt16LE(w, 5); id.writeUInt16LE(h, 7); parts.push(id, Buffer.from([7]));
    const codes = [];
    for (let i = 0; i < f.px.length; i++) { if (i % 126 === 0) codes.push(128); codes.push(f.px[i]); }
    codes.push(129);
    const data = Buffer.from(codes);
    for (let o = 0; o < data.length; o += 255) { const c = data.subarray(o, o + 255); parts.push(Buffer.from([c.length]), c); }
    parts.push(Buffer.from([0]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}
const GREY = Array.from({ length: 128 }, (_, i) => [i * 2, i * 2, i * 2]);
/** A 48x48 frame: dark grey, a 12x12 white square at slot `k` (k < 0: none), or all white. */
function squareFrame(k, delayCs = 10, white = false) {
  const W = 48, px = new Uint8Array(W * W).fill(white ? 127 : 10);
  if (k >= 0) { const x0 = (k % 4) * 12, y0 = Math.floor(k / 4) * 12; for (let y = y0; y < y0 + 12; y++) for (let x = x0; x < x0 + 12; x++) px[y * W + x] = 127; }
  return { px, delayCs };
}
const isWhiteFrame = async (jpeg) => (await sharp(jpeg).stats()).channels[0].mean > 200;
const IMG = {};
let server, port, hits = {};
const FIX = new Map();                         // path -> [status, headers, body]
const page = (title, extra = "") => `<html><head><title>${title}</title>${extra}</head><body>hi</body></html>`;
async function fixtures() {
  IMG.png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 90 } } }).png().toBuffer();
  IMG.png2 = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 160, b: 90 } } }).png().toBuffer();
  IMG.png3 = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 60, b: 190 } } }).png().toBuffer();
  IMG.jpg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#3a6" } })
    .withMetadata({ exif: { IFD0: { Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } } }).jpeg().toBuffer();
  IMG.gif = gif(3, 10);
  IMG.webp = await sharp(gif(3, 20), { animated: true }).webp().toBuffer();
  IMG.gif201 = gif(201, 2);
  IMG.gifLong = gif(3, 1000);
  IMG.wide = await sharp({ create: { width: 9000, height: 10, channels: 3, background: "#123" } }).png().toBuffer();
  const raw = Buffer.alloc(800 * 800 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  IMG.big = await sharp(raw, { raw: { width: 800, height: 800, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  IMG.svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
  IMG.ico = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0, 0x16, 0, 0, 0]);
  const img = (p, ct, body) => FIX.set(p, [200, { "content-type": ct }, body]);
  img("/a.png", "image/png", IMG.png); img("/b.png", "image/png", IMG.png2); img("/c.png", "image/png", IMG.png3);
  img("/again.png", "image/png", IMG.png);
  img("/a.jpg", "image/jpeg", IMG.jpg); img("/a.gif", "image/gif", IMG.gif); img("/a.webp", "image/webp", IMG.webp);
  img("/many.gif", "image/gif", IMG.gif201); img("/long.gif", "image/gif", IMG.gifLong); img("/wide.png", "image/png", IMG.wide);
  img("/big.png", "image/png", IMG.big); img("/x.svg", "image/svg+xml", IMG.svg); img("/icon.png", "image/png", IMG.png3);
  img("/favicon.ico", "image/x-icon", IMG.ico); img("/text.txt", "text/plain", Buffer.from("just some text here, no picture"));
  img("/lie.png", "image/png", Buffer.from("<html><body>not a picture</body></html>"));
  FIX.set("/page", [200, { "content-type": "text/html; charset=utf-8" }, page("Frogs &amp; Friends",
    `<meta property="og:title" content="Frogs &amp; Friends"><meta property="og:description" content="All about frogs">` +
    `<meta property="og:site_name" content="FrogNet"><meta property="og:image" content="/b.png"><link rel="icon" href="/icon.png">`)]);
  FIX.set("/page-ico", [200, { "content-type": "text/html" }, page("Ico page", `<meta property="og:image" content="/c.png"><link rel="shortcut icon" href="/favicon.ico">`)]);
  FIX.set("/page-bad", [200, { "content-type": "text/html" }, page("kys loser", "")]);
  FIX.set("/page-script", [200, { "content-type": "text/html" }, page("&lt;script&gt;alert(1)&lt;/script&gt; Frogs", `<meta property="og:image" content="/c.png">`)]);
  FIX.set("/to-private", [302, { location: "http://10.0.0.1/a.png" }, Buffer.alloc(0)]);
  FIX.set("/to-meta", [302, { location: "http://169.254.169.254/latest/meta-data/" }, Buffer.alloc(0)]);
  FIX.set("/to-local", [301, { location: "http://router.local/a.png" }, Buffer.alloc(0)]);
}
// fake DNS: *.example.com -> the fixture (anything else: not found)
const fakeDns = (map) => async (host) => {
  const v = map[host];
  if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return (Array.isArray(v) ? v : [v]).map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 }));
};
const DNS = fakeDns({ "img.example.com": "127.0.0.3", "cdn.example.com": "127.0.0.3", "page.example.com": "127.0.0.3",
                      "mixed.example.com": ["93.184.216.34", "10.0.0.5"], "lan.example.com": "192.168.1.10" });
const U = (p, host = "img.example.com") => `http://${host}:${port}${p}`;

// the stubbed classifier (Pepe's vision)
let ANSWER = { verdict: "allow", scores: { nudity_explicit: 0.01 } };
let CALLS = 0;
const stub = () => ISF.setClassifier(async () => { CALLS++; return typeof ANSWER === "function" ? ANSWER() : ANSWER; });
const CLEAN = { verdict: "allow", scores: { nudity_explicit: 0.01, sexual: 0.02, suggestive: 0.1, minor_risk: 0, gore: 0, hate_symbols: 0 }, reason: "a frog" };
/** every category scored (a broadcast check refuses an answer with one missing) */
const sc = (patch) => ({ ...CLEAN.scores, ...patch });
async function safety(patch = {}) { ISF._reset(); stub(); await ISF.setConfig({ ...ISF.DEFAULTS, timeout_secs: 2, ...patch }, "test"); }

const users = new Map();
async function mkUser(name, cls = "pleb") {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, cls, name + "_cf"]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}
let app, base, webSrv, STAFF, MEMBER;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await fixtures();
  server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    hits[p] = (hits[p] || 0) + 1;
    const f = FIX.get(p);
    if (!f) { res.writeHead(404); return res.end("no"); }
    res.writeHead(f[0], f[1]);
    res.end(f[2]);
  });
  await new Promise((r) => server.listen(0, "127.0.0.3", r));
  port = server.address().port;
  lp._testAllow("127.0.0.3", port);
  await M.init();
  await ISF.init();
  await rooms.init();
  await store.init();
  await require(path.join(repo, "userstories")).init();
  await require(path.join(repo, "inbox")).ready;
  STAFF = await mkUser("staffer", "Staff");
  MEMBER = await mkUser("member");
  await mkUser("boss", "Admin");
  app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  M.register(app);
  webSrv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  base = "http://127.0.0.1:" + webSrv.address().port;
  await safety();
});
test.after(() => { server.close(); if (webSrv) webSrv.close(); ISF._reset(); });
test.beforeEach(async () => { ANSWER = CLEAN; CALLS = 0; });

const refusedWith = (code) => (e) => e instanceof M.MediaError && e.code === code;

// ───────────────────────── the chat grammar ─────────────────────────
test("parseChat: captions (plain / quoted / smart quotes), options in any order, the link must come first", () => {
  let s = M.parseChat("image", ["https://i.example.com/a.png", "Look", "at", "this", "frog", "rights"], CFG);
  assert.deepEqual([s.mode, s.url, s.caption, s.lane, s.corner, s.secs, s.direct, s.clamped], ["image", "https://i.example.com/a.png", "Look at this frog", "main", null, 30, false, false]);
  s = M.parseChat("img", "i.example.com/a.png rights for 45s corner", CFG);
  assert.deepEqual([s.url, s.caption, s.lane, s.corner, s.secs], ["https://i.example.com/a.png", null, "corner", "tr", 45]);
  s = M.parseChat("pic", ["https://x.example.com/a.png", '"full', "moon", "for", 'you"', "corner", "bl", "for", "2m", "rights"], CFG);
  assert.deepEqual([s.caption, s.lane, s.corner, s.secs], ["full moon for you", "corner", "bl", 120]);
  s = M.parseChat("image", ["https://x.example.com/a.png", "“live", "with", "sound”", "rights", "br"], CFG);
  assert.deepEqual([s.caption, s.corner, s.sound], ["live with sound", "br", false], "a quoted caption is literal");
  // a caption word that is also an option only counts at the end
  s = M.parseChat("image", ["https://x.example.com/a.png", "a", "full", "moon", "rights"], CFG);
  assert.deepEqual([s.caption, s.lane], ["a full moon", "main"]);
  assert.throws(() => M.parseChat("image", ["https://x.example.com/a.png", '"hi"', "banana", "rights"], CFG), (e) => e.code === "usage" && /didn't understand 'banana'/.test(e.message));
  for (const first of ["look", "data:image/png;base64,AAAA", "javascript:alert(1)", "", "ftp://x"]) {
    assert.throws(() => M.parseChat("image", [first, "rights"], CFG), (e) => e.code === "which" && /Which picture\?/.test(e.message), first);
  }
  assert.throws(() => M.parseChat("link", ["nope", "rights"], CFG), (e) => /Which page\?/.test(e.message));
  assert.throws(() => M.parseChat("video", ["https://x.example.com", "rights"], CFG), (e) => e.code === "usage");
});

test("parseChat: for forms, defaults and clamping (the reply says so), corners, with sound, rights, contradictions", () => {
  const secs = (...w) => M.parseChat("image", ["https://x.example.com/a.png", ...w, "rights"], CFG);
  assert.equal(secs("for", "30s").secs, 30);
  assert.equal(secs("for", "90").secs, 90);
  assert.equal(secs("for", "2m").secs, 120);
  assert.equal(secs("for", "1m30s").secs, 90);
  assert.equal(secs("for", "10min").secs, 600);
  assert.equal(secs("for", "2", "min").secs, 120);
  let s = secs("for", "20m");
  assert.deepEqual([s.secs, s.clamped], [600, true], "clamped to media_max_s");
  s = secs("for", "2s");
  assert.deepEqual([s.secs, s.clamped], [5, true], "at least 5 s");
  s = secs("direct", "for", "10m");
  assert.deepEqual([s.direct, s.secs, s.clamped], [true, 120, true], "direct: direct_max_s");
  s = M.parseChat("link", ["https://example.com/", "live", "for", "15m", "rights"], CFG);
  assert.deepEqual([s.mode, s.secs, s.clamped, s.sound], ["live", 600, true, false]);
  s = M.parseChat("link", ["https://example.com/", "rights", "with", "sound", "live"], CFG);
  assert.deepEqual([s.mode, s.secs, s.sound], ["live", 60, true], "a live page defaults to 60 s");
  assert.equal(M.parseChat("link", ["https://example.com/", "live", "sound", "rights"], CFG).sound, true);
  s = M.parseChat("page", ["https://example.com/", "rights"], CFG);
  assert.deepEqual([s.mode, s.secs], ["card", 30], "a link is a card by default");
  assert.deepEqual([secs("corner").corner, secs("corner", "tl").corner, secs("br").corner, secs("full").lane], ["tr", "tl", "br", "main"]);
  assert.throws(() => M.parseChat("image", ["https://x.example.com/a.png", "nice"], CFG), (e) => e.code === "rights" && /"rights"/.test(e.message));
  assert.throws(() => M.parseChat("image", ["https://x.example.com/a.png", "live", "rights"], CFG), refusedWith("contradiction"));
  assert.throws(() => M.parseChat("link", ["https://x.example.com/", "direct", "rights"], CFG), refusedWith("contradiction"));
  assert.throws(() => M.parseChat("link", ["https://x.example.com/", "with", "sound", "rights"], CFG), refusedWith("contradiction"));
  assert.throws(() => M.parseChat("image", ["https://x.example.com/a.png", "sound", "rights"], CFG), refusedWith("contradiction"));
  assert.throws(() => M.parseChat("image", ["https://x.example.com/a.png", "full", "corner", "rights"], CFG), refusedWith("contradiction"));
  assert.equal(M.fmtDur(30), "30 s");
  assert.equal(M.fmtDur(90), "1 min 30 s");
  assert.equal(M.fmtDur(600), "10 min");
});

test("captions: one plain line, at most 120 characters, no links, nothing the guards refuse", () => {
  assert.equal(M.cleanCaption("  hello‮   there\u0007 "), "hello there");
  assert.equal(M.cleanCaption(""), null);
  assert.throws(() => M.cleanCaption("x".repeat(121)), refusedWith("caption"));
  for (const bad of ["see https://evil.example", "go to www.evil.example", "kys", "call 555-123-4567", "PATV-AB12CD"]) {
    assert.throws(() => M.cleanCaption(bad), refusedWith("caption"), bad);
  }
  assert.throws(() => M.parseChat("image", ["https://x.example.com/a.png", "kys", "rights"], CFG), refusedWith("caption"));
});

// ───────────────────────── URL rules ─────────────────────────
test("URL rules: http(s) only, normal ports, no credentials, at most 2048 characters; private / mapped / .local / mixed DNS refused", async () => {
  const spec = (url) => M.validateSpec({ mode: "image", url, rights: true }, CFG);
  for (const bad of ["data:image/png;base64,AAAA", "javascript:alert(1)", "ftp://example.com/a.png", "https://user:pw@example.com/a.png",
                     "https://example.com:8080/a.png", "https://example.com/" + "a".repeat(2049)]) {
    assert.throws(() => spec(bad), refusedWith("bad_link"), bad.slice(0, 40));
  }
  assert.equal(spec("example.com/a.png").url, "https://example.com/a.png");
  for (const u of ["http://10.0.0.1/a.png", "http://[::ffff:a9fe:a9fe]/a.png", "http://router.local/a.png", "http://mixed.example.com/a.png", "http://lan.example.com/a.png"]) {
    await assert.rejects(M.fetchImage(u, { lookup: DNS }), refusedWith("private"), u);
    await assert.rejects(M.checkLive(u, CFG, { lookup: DNS }), (e) => e.refuse && ["private", "ipv6"].includes(e.code), u);
  }
  await assert.rejects(M.checkDirect("http://10.0.0.1/a.png", { lookup: DNS }), refusedWith("private"));
  await assert.rejects(M.checkDirect("http://[::ffff:a9fe:a9fe]/a.png", { lookup: DNS }), refusedWith("ipv6"));
  await assert.rejects(M.checkDirect("http://mixed.example.com/a.png", { lookup: DNS }), refusedWith("private"));
  // redirects are checked hop by hop: to a private address, the metadata address, a .local name
  for (const p of ["/to-private", "/to-meta", "/to-local"]) {
    await assert.rejects(M.fetchImage(U(p), { lookup: DNS }), refusedWith("private"), p);
    await assert.rejects(M.checkDirect(U(p), { lookup: DNS }), refusedWith("private"), p);
  }
});

// ───────────────────────── the fetch pipeline ─────────────────────────
test("pictures: PNG / JPEG / GIF / WebP fetched, re-encoded to webp (animation kept, EXIF + GPS gone), stored outside the code tree", async () => {
  const jm = await sharp(IMG.jpg).metadata();
  assert.ok(jm.exif, "the fixture JPEG has EXIF");
  for (const [p, anim] of [["/a.png", false], ["/a.jpg", false], ["/a.gif", true], ["/a.webp", true]]) {
    const a = await M.fetchImage(U(p), { lookup: DNS });
    assert.match(a.file, M.FILE_RE, p);
    const file = path.join(process.env.ONAIR_MEDIA_DIR, a.file);
    assert.ok(fs.existsSync(file), p);
    const md = await sharp(file, { animated: true }).metadata();
    assert.equal(md.format, "webp", p);
    assert.equal(!!md.exif, false, p + " no EXIF");
    assert.equal(!!md.xmp, false, p + " no XMP");
    assert.equal(a.animated, anim, p);
    if (anim) assert.equal(md.pages, 3, p + " every frame kept");
    assert.equal(a.host, "img.example.com");
    const row = (await getQuery("SELECT * FROM onair_media WHERE id = ?", [a.id]))[0];
    assert.deepEqual([row.status, row.src_kind, row.src_url, row.src_host], ["ready", "url", U(p), "img.example.com"]);
    assert.ok(row.safety_log, "the check's log row is kept");
  }
  assert.ok(!path.resolve(process.env.ONAIR_MEDIA_DIR).startsWith(repo), "outside the code tree");
  // the same link again within a day: no second fetch, no second check
  const n = CALLS, h = hits["/a.png"];
  const again = await M.fetchImage(U("/a.png"), { lookup: DNS });
  assert.equal(CALLS, n, "no second classification");
  assert.equal(hits["/a.png"], h, "no second fetch");
  // the same picture from another link: reused by its sha256 (fetched, never re-checked)
  const other = await M.fetchImage(U("/again.png"), { lookup: DNS });
  assert.equal(other.id, again.id);
  assert.equal(CALLS, n);
});

test("pictures refused: a page (the !onair link hint), SVG / text / a lie, too big, >200 frames, a loop over 20 s, 9000x10", async () => {
  await assert.rejects(M.fetchImage(U("/page", "page.example.com"), { lookup: DNS }), (e) => e.code === "page" && /!onair link/.test(e.message));
  for (const p of ["/x.svg", "/text.txt", "/lie.png", "/favicon.ico"]) await assert.rejects(M.fetchImage(U(p), { lookup: DNS }), refusedWith("type"), p);
  await assert.rejects(M.fetchImage(U("/big.png"), { lookup: DNS, maxMb: 1 }), (e) => e.code === "too_big" && /bigger than 1 MB/.test(e.message));
  await assert.rejects(M.fetchImage(U("/many.gif"), { lookup: DNS }), refusedWith("frames"));
  await assert.rejects(M.fetchImage(U("/long.gif"), { lookup: DNS }), (e) => e.code === "loop" && /20 s/.test(e.message));
  await assert.rejects(M.fetchImage(U("/wide.png"), { lookup: DNS }), refusedWith("dims"));
  await assert.rejects(M.fetchImage(U("/nope.png"), { lookup: DNS }), refusedWith("status"));
  assert.equal(CALLS, 0, "nothing refused here ever reached the classifier");
});

// ───────────────────────── the broadcast check ─────────────────────────
test("broadcast check: only clearly safe passes - suggestive 0.35 refused (margin 0.30), minor_risk refused + flagged, recorded", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM image_safety_log WHERE surface = 'onair'"))[0].n;
  ANSWER = { verdict: "allow", scores: sc({ suggestive: 0.35 }), reason: "swimwear" };
  const buf1 = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#909" } }).png().toBuffer();
  await assert.rejects(M.ingestBuffer(buf1, "png", {}), (e) => e.code === "unsafe" && /isn't clearly safe for Pepe's stream/.test(e.message));
  let row = (await getQuery("SELECT * FROM image_safety_log WHERE surface = 'onair' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([row.action, row.would, row.flagged], ["refuse", "allow", 0], "under its threshold - but not clearly safe");
  ANSWER = { verdict: "refuse", scores: sc({ minor_risk: 0.8 }), reason: "possible minor" };
  const buf2 = await sharp({ create: { width: 30, height: 30, channels: 3, background: "#099" } }).png().toBuffer();
  await assert.rejects(M.ingestBuffer(buf2, "png", {}), refusedWith("unsafe"));
  row = (await getQuery("SELECT * FROM image_safety_log WHERE surface = 'onair' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([row.action, row.flagged], ["refuse", 1]);
  // the margin is the admins' (bounded): at 0.4 the same suggestive picture passes
  await safety({ broadcast_max_score: 0.4 });
  ANSWER = { verdict: "allow", scores: sc({ suggestive: 0.35 }) };
  const buf3 = await sharp({ create: { width: 31, height: 30, channels: 3, background: "#909" } }).png().toBuffer();
  assert.ok((await M.ingestBuffer(buf3, "png", {})).id);
  await safety();
  const after = (await getQuery("SELECT COUNT(*) AS n FROM image_safety_log WHERE surface = 'onair'"))[0].n;
  assert.equal(after - before, 3, "every decision recorded under surface onair");
  // nothing refused is stored
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM onair_media"))[0].n, (await getQuery("SELECT COUNT(*) AS n FROM onair_media WHERE status = 'ready'"))[0].n);
});

test("broadcast check: fail-closed - a timeout, Pepe not pulling (refused at once); a refused picture is refused again by its sha256 without a call", async () => {
  await safety({ timeout_secs: 0.3 });
  ANSWER = () => new Promise(() => {});                         // never answers
  const b1 = await sharp({ create: { width: 33, height: 30, channels: 3, background: "#330" } }).png().toBuffer();
  await assert.rejects(M.ingestBuffer(b1, "png", {}), (e) => e.code === "unchecked" && /nothing was shown/.test(e.message));
  let row = (await getQuery("SELECT * FROM image_safety_log WHERE surface = 'onair' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(row.action, "failclosed");
  // the real queue, Pepe hasn't pulled for a minute: refused at once, nothing queued
  ISF._reset();
  await ISF.setConfig({ ...ISF.DEFAULTS }, "test");
  ISF._setLastPull(Date.now() - 120e3);
  const t0 = Date.now();
  await assert.rejects(M.ingestBuffer(b1, "png", {}), (e) => e.code === "unchecked" && /isn't available right now/.test(e.message));
  assert.ok(Date.now() - t0 < 1500, "at once");
  assert.equal(ISF.queueStats().queued, 0);
  // a refused picture: remembered by its sha256 (30 days) - the same picture from another link is refused with no call
  await safety();
  ANSWER = { verdict: "nsfw", scores: sc({ nudity_explicit: 0.9 }) };
  await assert.rejects(M.fetchImage(U("/c.png"), { lookup: DNS }), refusedWith("unsafe"));
  const n = CALLS;
  ANSWER = CLEAN;
  FIX.set("/c-copy.png", FIX.get("/c.png"));
  await assert.rejects(M.fetchImage(U("/c-copy.png"), { lookup: DNS }), refusedWith("unsafe"));
  assert.equal(CALLS, n, "no second classification");
  const h = hits["/c.png"];
  await assert.rejects(M.fetchImage(U("/c.png"), { lookup: DNS }), refusedWith("unsafe"));
  assert.equal(hits["/c.png"], h, "a link refused in the last hour isn't even fetched again");
  M._reset();                                                   // (forget the link memory for the tests below)
  await runQuery("DELETE FROM onair_refused");
});

// ───────────────────────── cards, direct, live ─────────────────────────
test("cards: the feed's preview data, its picture + favicon proxied and checked; ICO never decoded; text guarded; YouTube hint", async () => {
  const c = await M.buildCard(U("/page", "page.example.com"), { lookup: DNS });
  assert.deepEqual([c.card.title, c.card.description, c.card.site, c.card.domain], ["Frogs & Friends", "All about frogs", "FrogNet", "page.example.com"]);
  assert.ok(c.asset && M.FILE_RE.test(c.asset.file), "the page's picture, proxied");
  assert.ok(M.FILE_RE.test(c.card.icon), "the favicon, proxied");
  assert.equal((await getQuery("SELECT src_kind FROM onair_media WHERE file = ?", [c.card.icon]))[0].src_kind, "icon");
  const ico = await M.buildCard(U("/page-ico", "page.example.com"), { lookup: DNS });
  assert.equal(ico.card.icon, null, "an ICO favicon: a letter badge instead");
  await assert.rejects(M.buildCard(U("/page-bad", "page.example.com"), { lookup: DNS }), refusedWith("card_text"));
  // 1.99acw review: its OWN picture isn't clearly safe -> the whole card is refused (the strongest hint the page is adult)
  ANSWER = { verdict: "nsfw", scores: sc({ sexual: 0.9 }) };
  FIX.set("/page-nsfw", [200, { "content-type": "text/html" }, page("Fine title", `<meta property="og:image" content="/nsfw.png">`)]);
  FIX.set("/nsfw.png", [200, { "content-type": "image/png" }, await sharp({ create: { width: 20, height: 20, channels: 3, background: "#f0f" } }).png().toBuffer()]);
  await assert.rejects(M.buildCard(U("/page-nsfw", "page.example.com"), { lookup: DNS }),
    (e) => e.code === "card_unsafe" && e.status === 422 && /own picture isn't clearly safe/.test(e.message) && e.logId > 0);
  ANSWER = CLEAN;
  // ...an unsafe favicon too (the page's picture itself fine): the stub flags only the magenta icon
  FIX.set("/page-badicon", [200, { "content-type": "text/html" }, page("Fine title 2", `<meta property="og:image" content="/b.png"><link rel="icon" href="/nsfw-icon.png">`)]);
  FIX.set("/nsfw-icon.png", [200, { "content-type": "image/png" }, await sharp({ create: { width: 16, height: 16, channels: 3, background: "#e010e0" } }).png().toBuffer()]);
  ISF.setClassifier(async ({ frames }) => {
    CALLS++;
    const st = await sharp(frames[0]).stats();
    return st.channels[0].mean > 180 && st.channels[1].mean < 60 ? { verdict: "nsfw", scores: sc({ sexual: 0.9 }) } : CLEAN;
  });
  await assert.rejects(M.buildCard(U("/page-badicon", "page.example.com"), { lookup: DNS }), refusedWith("card_unsafe"));
  stub();
  // a picture that can't be used (not a picture format) still keeps the card, without it
  FIX.set("/page-svgpic", [200, { "content-type": "text/html" }, page("Svg pic", `<meta property="og:image" content="/x.svg">`)]);
  const svgc = await M.buildCard(U("/page-svgpic", "page.example.com"), { lookup: DNS });
  assert.equal(svgc.asset, null);
  assert.match(svgc.note, /shown without it/);
  const yt = await M.buildCard("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { lookup: fakeDns({}) });
  assert.match(yt.note, /!onair <link> rights/);
  // markup in the title stays plain text, and the show page escapes it
  const scr = await M.buildCard(U("/page-script", "page.example.com"), { lookup: DNS });
  assert.match(scr.card.title, /^<script>alert\(1\)<\/script> Frogs$/);
  const html = await ejs.renderFile(path.join(repo, "views", "onairShow.ejs"), {
    item: { kind: "card", lane: "main", corner: "tr", pct: 30, until: 1, caption: "<b>cap</b>", direct: false, src: null,
            card: { ...scr.card, img: "/onair/m/" + scr.asset.file, icon: null, letter: "P" } }, token: "abc.def" });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Frogs/);
  assert.match(html, /&lt;b&gt;cap&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<a\s/i, "no links on the show page");
  assert.doesNotMatch(html, /style=/i, "no inline style (the CSP allows none)");
  assert.equal((html.match(/<script/g) || []).length, 1, "one script, our own file");
  assert.match(html, /<script src="\/public\/js\/onair-show\.js\?v=1"><\/script>/);
});

test("direct pictures: no proxy, no scan - a public host, a type probe (a page / text refused), redirects followed to their end", async () => {
  const d = await M.checkDirect(U("/a.png", "cdn.example.com"), { lookup: DNS });
  assert.deepEqual(d, { url: U("/a.png", "cdn.example.com"), origin: `http://cdn.example.com:${port}`, host: "cdn.example.com" });
  assert.equal(CALLS, 0, "never classified");
  await assert.rejects(M.checkDirect(U("/page", "page.example.com"), { lookup: DNS }), refusedWith("page"));
  await assert.rejects(M.checkDirect(U("/text.txt"), { lookup: DNS }), refusedWith("type"));
  // a big picture: the probe reads only the first 64 KB (no size refusal)
  const big = await M.checkDirect(U("/big.png"), { lookup: DNS });
  assert.equal(big.host, "img.example.com");
  FIX.set("/hop", [302, { location: U("/b.png", "cdn.example.com") }, Buffer.alloc(0)]);
  const hop = await M.checkDirect(U("/hop"), { lookup: DNS });
  assert.deepEqual([hop.host, hop.url], ["cdn.example.com", U("/b.png", "cdn.example.com")], "OBS loads where the redirects end");
  assert.ok(M.ORIGIN_RE.test(hop.origin));
});

test("live pages: the site's own hosts and live_deny are refused, a private address too; a public one passes", async () => {
  for (const u of ["https://publicaccess.tv/", "https://www.publicaccess.tv/x", "https://staging.publicaccess.tv/", "https://stream.publicaccess.tv/"]) {
    await assert.rejects(M.checkLive(u, CFG, { lookup: DNS }), refusedWith("denied"), u);
  }
  const cfg = { ...CFG, live_deny: "evil.example.com, other.example" };
  await assert.rejects(M.checkLive("https://evil.example.com/", cfg, { lookup: DNS }), refusedWith("denied"));
  await assert.rejects(M.checkLive("https://a.b.other.example/", cfg, { lookup: DNS }), refusedWith("denied"));
  await assert.rejects(M.checkLive("https://lan.example.com/", cfg, { lookup: DNS }), refusedWith("private"));
  const ok = await M.checkLive(U("/page", "page.example.com"), cfg, { lookup: DNS });
  assert.deepEqual(ok, { url: U("/page", "page.example.com"), host: "page.example.com" });
});

// ───────────────────────── uploads ─────────────────────────
async function onairUpload(u, { purpose = "onair", fmt = "png" } = {}) {
  const out = await fm.processImage(await sharp({ create: { width: 24, height: 18, channels: 3, background: "#4a4" } }).png().toBuffer(), "png");
  const id = require("crypto").randomBytes(12).toString("hex");
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, w, h, bytes, state, created, size_declared, received, purpose, sniff)
                  VALUES (?, ?, 'image', 'image/webp', ?, ?, ?, ?, ?, 'ready', ?, 100, 100, ?, ?)`,
                 [id, u.userId, out.file, out.thumb, out.w, out.h, out.bytes, Date.now(), purpose, JSON.stringify({ kind: "image", fmt })]);
  return { id, out };
}
test("uploads: purpose onair is for on-air operators only, pictures only; ingest consumes the attachment; never attachable to a post", async () => {
  const H = (u) => ({ "content-type": "application/json", "x-requested-with": "fetch", ...(u ? { "x-test-user": u.userId } : {}) });
  const open = (u, body) => fetch(base + "/api/feed/uploads", { method: "POST", headers: H(u), body: JSON.stringify(body) });
  assert.equal((await open(MEMBER, { kind: "image", size: 1000, purpose: "onair" })).status, 403, "a member");
  assert.equal((await open(STAFF, { kind: "video", size: 1000, purpose: "onair" })).status, 400, "pictures only");
  assert.equal((await open(STAFF, { kind: "image", size: 9 * 1024 * 1024, purpose: "onair" })).status, 413, "the on-air size cap");
  const r = await open(STAFF, { kind: "image", size: 1000, purpose: "onair" });
  assert.equal(r.status, 200);
  const made = (await r.json()).id;
  assert.equal((await getQuery("SELECT purpose FROM feed_attachments WHERE id = ?", [made]))[0].purpose, "onair");
  // ingest: the picture is checked + stored, the attachment and its files are gone
  const { id, out } = await onairUpload(STAFF);
  await assert.rejects(M.ingestUpload(MEMBER.userId, id), refusedWith("upload"), "someone else's");
  const a = await M.ingestUpload(STAFF.userId, id);
  assert.ok(M.FILE_RE.test(a.file));
  assert.equal(CALLS, 1, "the broadcast check ran on it");
  assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id = ?", [id]))[0].state, "deleted");
  assert.equal(fs.existsSync(fm.filePath(out.file)), false, "its feed files removed");
  await assert.rejects(M.ingestUpload(STAFF.userId, id), refusedWith("upload"), "used once");
  const story = await onairUpload(STAFF, { purpose: "story" });
  await assert.rejects(M.ingestUpload(STAFF.userId, story.id), refusedWith("upload"), "a story upload isn't an on-air one");
  const heic = await onairUpload(STAFF, { fmt: "heic" });
  await assert.rejects(M.ingestUpload(STAFF.userId, heic.id), refusedWith("type"), "only png / jpeg / gif / webp originals");
  // a post can't take an on-air upload
  const another = await onairUpload(STAFF);
  await assert.rejects(store.create(STAFF.userId, { title: "x", body: "y", community: "plant_based_chatting", attachments: [another.id] }),
    (e) => /isn't yours or is already posted|That pad isn't on PATV/.test(e.message));
  await rooms.addRoom("Onair.Pad", "Onair Pad", "test").catch(() => {});
  await assert.rejects(store.create(STAFF.userId, { title: "x", body: "y", community: "Onair.Pad", attachments: [another.id] }),
    (e) => /isn't yours or is already posted/.test(e.message));
});

// ───────────────────────── jobs, rate limit, the file route, the sweep ─────────────────────────
test("jobs: one in flight per person, two site-wide; the answer at once when quick; only the starter sees it; rate limit per 10 min", async () => {
  M._reset();
  let release;
  const slow = new Promise((r) => { release = r; });
  const j1 = M.startJob({ actor: "web:a", run: async (j) => { j.state = "checking"; j.msg = "Checking…"; await slow; return { msg: "done!" }; } });
  assert.throws(() => M.startJob({ actor: "web:a", run: async () => ({}) }), (e) => e.code === "busy" && e.status === 429);
  const j2 = M.startJob({ actor: "web:b", run: async () => { await slow; return { msg: "b" }; } });
  assert.throws(() => M.startJob({ actor: "web:c", run: async () => ({}) }), (e) => e.code === "busy", "two site-wide");
  const v = await M.race(j1, 50);
  assert.deepEqual([v.final, v.state, v.msg], [false, "checking", "Checking…"]);
  assert.equal(M.job(j1.id, "web:b"), null, "someone else's job: unknown");
  assert.equal(M.job(j1.id, "web:b", { any: true }).id, j1.id);
  release();
  const done = await M.race(j1, 1000);
  assert.deepEqual([done.final, done.state, done.msg], [true, "done", "done!"]);
  await j2.promise;
  const bad = M.startJob({ actor: "web:a", run: async () => { throw new M.MediaError(422, "nope", "unsafe"); } });
  const bv = await M.race(bad, 1000);
  assert.deepEqual([bv.state, bv.msg, bv.code], ["refused", "nope", "unsafe"]);
  assert.equal(M.jobsFor("web:a").length, 2);
  // 1.99acw review: the rate limit is per PERSON and kept in the database (a restart doesn't reset it)
  await M.rateCheck("cf:x", 2);
  await M.rateCheck("cf:x", 2);
  await assert.rejects(M.rateCheck("cf:x", 2), (e) => e.code === "rate" && e.status === 429);
  M._reset(); await M.init();                                   // "a restart"
  await assert.rejects(M.rateCheck("cf:x", 2), (e) => e.code === "rate", "still counted after a restart");
  await M.rateCheck("cf:y", 2);
  assert.equal(M.personKey({ userId: "u1", login: "Frog" }), "u:u1", "a linked login is its account");
  assert.equal(M.personKey({ login: "Frog" }), "cf:frog");
  // one job in flight per person, whatever the actor (a linked login's chat job blocks their web job)
  let rel;
  const hold = new Promise((r) => { rel = r; });
  const jc = M.startJob({ actor: "chat:frog", person: "u:u1", run: async () => { await hold; return {}; } });
  assert.throws(() => M.startJob({ actor: "web:u1", person: "u:u1", run: async () => ({}) }), (e) => e.code === "busy");
  rel(); await jc.promise;
});

test("/onair/m/<file>: only stored ready pictures, image/webp with nosniff + a sandbox CSP + CORP same-origin, never cached at the edge", async () => {
  const a = await M.fetchImage(U("/b.png"), { lookup: DNS });
  const r = await fetch(base + "/onair/m/" + a.file);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(r.headers.get("cache-control"), "private, max-age=600");
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.equal((await fetch(base + "/onair/m/" + "0".repeat(32) + ".webp")).status, 404, "unknown");
  assert.equal((await fetch(base + "/onair/m/..%2f..%2fetc%2fpasswd")).status, 404);
  fs.writeFileSync(path.join(process.env.ONAIR_MEDIA_DIR, "f".repeat(32) + ".webp"), "x");
  assert.equal((await fetch(base + "/onair/m/" + "f".repeat(32) + ".webp")).status, 404, "a file with no ready row");
});

test("sweep: unused pictures past 30 days go (file + row) unless something on air / queued refers to them; refusal memory expires", async () => {
  const t = Date.now();
  const mk = async (id, created, used) => {
    const file = require("crypto").randomBytes(16).toString("hex") + ".webp";
    fs.writeFileSync(path.join(process.env.ONAIR_MEDIA_DIR, file), "x");
    await runQuery("INSERT INTO onair_media (id, file, created, last_used, status) VALUES (?, ?, ?, ?, 'ready')", [id, file, created, used]);
    return file;
  };
  const old = await mk("old1", t - 40 * 86400e3, null);
  const kept = await mk("kept1", t - 40 * 86400e3, null);
  const used = await mk("used1", t - 40 * 86400e3, t - 86400e3);
  const fresh = await mk("fresh1", t - 86400e3, null);
  await runQuery("INSERT INTO onair_refused (sha256, at, reason) VALUES ('a', ?, 'x'), ('b', ?, 'y')", [t - 40 * 86400e3, t]);
  const n = await M.sweep(new Set(["kept1"]), t);
  assert.equal(n, 1);
  const ids = (await getQuery("SELECT id FROM onair_media WHERE id IN ('old1','kept1','used1','fresh1') ORDER BY id")).map((r) => r.id);
  assert.deepEqual(ids, ["fresh1", "kept1", "used1"]);
  assert.equal(fs.existsSync(path.join(process.env.ONAIR_MEDIA_DIR, old)), false);
  for (const f of [kept, used, fresh]) assert.ok(fs.existsSync(path.join(process.env.ONAIR_MEDIA_DIR, f)));
  assert.deepEqual((await getQuery("SELECT sha256 FROM onair_refused WHERE sha256 IN ('a','b')")).map((r) => r.sha256), ["b"]);
});

// ───────────────────────── 1.99acw review fixes ─────────────────────────
test("SAFETY-1: content hidden in the alpha channel - stored opaque on the show page's dark frame, classified exactly as shown", async () => {
  const W = 64, H = 48, rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const o = (y * W + x) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = 255; rgba[o + 3] = x < W / 2 ? 0 : 255; }
  const png = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  let seen = null;
  ISF.setClassifier(async ({ frames }) => { CALLS++; seen = frames; return CLEAN; });
  try {
    const a = await M.ingestBuffer(png, "png", { by: "web:t" });
    const file = path.join(process.env.ONAIR_MEDIA_DIR, a.file);
    assert.equal((await sharp(file).metadata()).hasAlpha, false, "stored without an alpha channel");
    const { data, info } = await sharp(seen[0]).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => data[(y * info.width + x) * info.channels];
    assert.ok(px(2, 2) < 40, "the classifier sees the dark frame where the picture is transparent (flattened on white it was all white)");
    assert.ok(px(W - 3, 2) > 220, "the opaque part as it is");
    const raw = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    assert.ok(raw.data[(2 * raw.info.width + 2) * raw.info.channels] < 40, "the stored file shows the same dark half");
    // an animation: every page flattened before encoding - WebP may still code a later frame as a part-transparent delta over
    // the previous one, but every page as shown (composited) is fully opaque
    const fr = [squareFrame(0), squareFrame(5)].map((f) => { for (let i = 0; i < 48 * 8; i++) f.px[i] = 127; return f; });
    const g = gifOf(48, 48, GREY, fr);
    const ga = await M.ingestBuffer(g, "gif", { by: "web:t" });
    const all = await sharp(path.join(process.env.ONAIR_MEDIA_DIR, ga.file), { animated: true }).raw().toBuffer({ resolveWithObject: true });
    if (all.info.channels === 4) {
      let minA = 255;
      for (let i = 3; i < all.data.length; i += 4) minA = Math.min(minA, all.data[i]);
      assert.equal(minA, 255, "every composited page is opaque");
    }
    assert.equal(all.info.height / all.info.pageHeight, 2);
  } finally { stub(); }
});

test("SAFETY-2 / SEC-5: every DISTINCT frame of an animation is classified - a long-held frame between 'sampled' ones reaches the classifier", async () => {
  // 7 different frames, frame 3 (white, 15 s) is the one the old evenly spaced sample (0,1,2,4,5,6) never looked at
  const frames = [0, 1, 2, -1, 4, 5, 6].map((k, i) => (i === 3 ? squareFrame(-1, 1500, true) : squareFrame(k, 10)));
  const g = gifOf(48, 48, GREY, frames);
  const fr = await ISF.broadcastFrames(g);
  assert.equal(fr.distinct, 7, "all 7 distinct frames");
  let jobs = [];
  ISF.setClassifier(async ({ frames: fs2 }) => {
    CALLS++;
    const white = [];
    for (const f of fs2) white.push(await isWhiteFrame(f));
    jobs.push({ n: fs2.length, white });
    return white.some(Boolean) ? { verdict: "nsfw", scores: sc({ nudity_explicit: 0.95 }) } : CLEAN;
  });
  try {
    await assert.rejects(M.ingestBuffer(g, "gif", { by: "web:t" }), refusedWith("unsafe"));
    assert.equal(jobs.length, 2, "7 frames = two jobs (Pepe looks at 6 per job)");
    assert.ok(jobs.every((j) => j.n <= ISF.BROADCAST_BATCH));
    assert.ok(jobs.some((j) => j.white.some(Boolean)), "the long-held white frame reached the classifier");
    // 200 frames, only frame 17 different (A/B alternating so nothing merges): it is classified and the picture refused
    jobs = [];
    const many = Array.from({ length: 200 }, (_, i) => (i === 17 ? squareFrame(-1, 10, true) : squareFrame(i % 2 ? 2 : 9, 10)));
    const g200 = gifOf(48, 48, GREY, many);
    const f200 = await ISF.broadcastFrames(g200);
    assert.equal(f200.distinct, 3, "A, B and the odd frame");
    await assert.rejects(M.ingestBuffer(g200, "gif", { by: "web:t" }), refusedWith("unsafe"));
    assert.ok(jobs.some((j) => j.white.some(Boolean)), "frame 17 of 200 was looked at");
    // a clean animation passes (every job must pass)
    jobs = [];
    const okg = gifOf(48, 48, GREY, [0, 1, 2, 3, 4, 5, 6, 7].map((k) => squareFrame(k, 10)));
    assert.ok((await M.ingestBuffer(okg, "gif", { by: "web:t" })).id);
    assert.deepEqual(jobs.map((j) => j.n).sort(), [2, 6]);
    // more than 36 different frames: refused before any classification (not a safety verdict, not remembered)
    jobs = [];
    const lots = gifOf(48, 48, GREY, Array.from({ length: 40 }, (_, i) => {
      const f = squareFrame(-1, 10); const x0 = (i % 8) * 6, y0 = Math.floor(i / 8) * 6;
      for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) f.px[y * 48 + x] = 127;
      return f;
    }));
    await assert.rejects(M.ingestBuffer(lots, "gif", { by: "web:t" }), (e) => e.code === "frames" && /too many different frames/.test(e.message));
    assert.equal(jobs.length, 0);
  } finally { stub(); }
  // the other surfaces keep their two frames
  assert.equal((await ISF.imageFrames(gif(20, 10))).length, 2);
});

test("SAFETY-2 / SEC-5 round 2: frames merge only when every pixel matches - even-brightness colour line art behind a 100 ms mosaic is classified", async () => {
  // the verifier's case: 768x768; frame 0 = a flat 24 px mosaic (100 ms), frame 1 = crisp red (255, 0, 0) line art on grey 76 -
  // the same brightness, so a luma spread stays ~0 - shown 15 s. The old per-cell mean + luma-spread signature merged frame 1
  // into frame 0: the classifier got ONE frame (the mosaic) and the line art played 99% of every loop unchecked.
  const W = 768, C = 24, Q = 100;
  const pal = [[76, 76, 76], [255, 0, 0]];
  for (let k = 0; k < Q; k++) { const f = k / (Q - 1); pal.push([Math.round(76 + 179 * f), Math.round(76 - 76 * f), Math.round(76 - 76 * f)]); }
  const art = new Uint8Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - 384, y - 384);
    const line = Math.abs(r - 250) < 5 || Math.abs(r - 120) < 5 || Math.abs(x - y) < 5 || Math.abs(x + y - W) < 5 ||
                 (y > 600 && y < 700 && (Math.abs(x - 100) < 5 || Math.abs(x - 200) < 5 || (Math.abs(y - 650) < 5 && x > 100 && x < 200)));
    art[y * W + x] = line ? 1 : 0;
  }
  const mosaic = new Uint8Array(W * W);
  for (let cy = 0; cy < W / C; cy++) for (let cx = 0; cx < W / C; cx++) {
    let n = 0;
    for (let y = cy * C; y < cy * C + C; y++) for (let x = cx * C; x < cx * C + C; x++) n += art[y * W + x];
    const k = Math.round((n / (C * C)) * (Q - 1));
    for (let y = cy * C; y < cy * C + C; y++) for (let x = cx * C; x < cx * C + C; x++) mosaic[y * W + x] = 2 + k;
  }
  const g = gifOf(W, W, pal, [{ px: mosaic, delayCs: 10 }, { px: art, delayCs: 1500 }]);
  const fr = await ISF.broadcastFrames(g);
  assert.equal(fr.distinct, 2, "the line art is its own frame");
  assert.deepEqual(fr.kept, [0, 1]);
  const redPx = async (jpeg) => {
    const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
    let n = 0;
    for (let i = 0; i < data.length; i += info.channels) if (data[i] > 200 && data[i + 1] < 70 && data[i + 2] < 70) n++;
    return n;
  };
  assert.ok((await redPx(fr.frames[1])) > 5000 && (await redPx(fr.frames[0])) < 3000, "frame 1 is the crisp line art, frame 0 the mosaic");
  const jobs = [];
  ISF.setClassifier(async ({ frames: fs2 }) => {
    CALLS++;
    const red = [];
    for (const f of fs2) red.push(await redPx(f));
    jobs.push({ n: fs2.length, red });
    return red.some((n) => n > 5000) ? { verdict: "refuse", scores: sc({ hate_symbols: 0.9 }) } : CLEAN;
  });
  try {
    // through the real pipeline (the stored lossy WebP is what's checked): both pages reach the classifier, the picture is refused
    await assert.rejects(M.ingestBuffer(g, "gif", { by: "web:t" }), refusedWith("unsafe"));
    assert.equal(jobs.reduce((a, j) => a + j.n, 0), 2, "both frames classified (one was before)");
    assert.ok(jobs.some((j) => j.red.some((n) => n > 5000)), "the 15 s line-art frame reached the classifier");
  } finally { stub(); }

  // the rule itself (on the GIF's exact decode): within BSAME_PIXEL on every channel of every pixel merges; one pixel further
  // apart, or a change in one channel only, does not - no slack, no averaging
  assert.equal(ISF.BSAME_PIXEL, 12);
  const flat = (idx, patch) => { const px = new Uint8Array(48 * 48).fill(idx); if (patch) patch(px); return { px, delayCs: 10 }; };
  const pal2 = GREY.slice(0, 120).concat([[40, 20, 20], [20, 40, 20], [20, 20, 40], [60, 20, 20], [20, 20, 20], [20, 20, 20], [20, 20, 20], [20, 20, 20]]);
  const distinct = async (frames) => (await ISF.broadcastFrames(gifOf(48, 48, pal2, frames))).distinct;
  assert.equal(await distinct([flat(10), flat(13), flat(10)]), 1, "grey 20 vs 26 (6 apart): the same picture");
  assert.equal(await distinct([flat(10), flat(17)]), 2, "grey 20 vs 34 (14 apart): different");
  assert.equal(await distinct([flat(10), flat(10, (px) => { px[48 * 30 + 7] = 30; })]), 2, "ONE pixel 40 levels off: different");
  assert.equal(await distinct([flat(10), flat(10, (px) => { for (let i = 0; i < 48 * 48; i += 16) px[i] = 120; })]), 2,
    "a sparse dot pattern (1 pixel in 16, red +20): different");
  assert.equal(await distinct([flat(10), flat(10, (px) => { for (let i = 0; i < 48 * 48; i += 16) px[i] = 123; })]), 2,
    "red 60 dots on grey 20 (one channel only): different");
});

test("SAFETY-6 / SEC-6: an answer that left a category unscored is not 'clearly safe' - refused (fail-closed)", async () => {
  let k = 0;
  for (const ans of [{ verdict: "allow" }, { verdict: "allow", scores: { nudity_explicit: 0, sexual: 0, suggestive: 0, minor_risk: 0, gore: 0 } },
                     { verdict: "allow", scores: { ...CLEAN.scores, hate_symbols: null } }]) {
    ANSWER = ans;
    const buf = await sharp({ create: { width: 21 + k++, height: 20, channels: 3, background: "#456" } }).png().toBuffer();
    await assert.rejects(M.ingestBuffer(buf, "png", { by: "web:t" }), (e) => e.code === "unchecked", JSON.stringify(ans));
    const row = (await getQuery("SELECT action, reason FROM image_safety_log WHERE surface = 'onair' ORDER BY id DESC LIMIT 1"))[0];
    assert.equal(row.action, "failclosed");
    assert.match(row.reason, /^unscored: /);
  }
  assert.deepEqual(ISF.cleanVerdict({ verdict: "allow", scores: { gore: 0.1 } }).scored, ["gore"]);
});

test("SAFETY-3: the broadcast explicit-terms list - captions, card text, domains, hosts; link-shaped caption words; adult sites refused", async () => {
  for (const t of ["Hot XXX videos", "free p0rn here", "p o r n", "Sex Pistols live", "leaked nudes", "OnlyFans drop", "adult content inside", "r34 art"]) {
    assert.equal(M.explicitText(t), true, t);
  }
  for (const t of ["Essex county news", "an analysis of frogs", "Formula X results", "Sussex frogs", "classic cocktails", "sextant navigation"]) {
    assert.equal(M.explicitText(t), false, t);
  }
  for (const h of ["www.pornhub.com", "cdn.onlyfans.com", "frogs.xxx", "free-porn-site.example", "nsfw.example.org"]) assert.equal(M.adultHost(h), true, h);
  for (const h of ["essex.ac.uk", "analytics.example.com", "x.com", "example.com", "93.184.216.34"]) assert.equal(M.adultHost(h), false, h);
  for (const c of ["visit example.com now", "see evil.example/x", "(frogs.net)", "Nude frogs"]) assert.throws(() => M.cleanCaption(c), refusedWith("caption"), c);
  for (const c of ["e.g. this frog", "node v1.2 rocks", "3.5 stars"]) assert.equal(M.cleanCaption(c), c, c);
  assert.throws(() => M.validateSpec({ mode: "image", url: "https://www.pornhub.com/x.png", rights: true }, CFG), refusedWith("adult"));
  assert.throws(() => M.validateSpec({ mode: "card", url: "https://frogs.xxx/", rights: true }, CFG), refusedWith("adult"));
  // a card: an explicit title / description; an adult host behind the link (its redirect)
  FIX.set("/page-x", [200, { "content-type": "text/html" }, page("Totally normal", `<meta property="og:description" content="The hottest xxx clips">`)]);
  await assert.rejects(M.buildCard(U("/page-x", "page.example.com"), { lookup: DNS }), refusedWith("card_text"));
  FIX.set("/to-adult", [302, { location: `http://porn.example.com:${port}/page` }, Buffer.alloc(0)]);
  const D2 = fakeDns({ "page.example.com": "127.0.0.3", "porn.example.com": "127.0.0.3" });
  await assert.rejects(M.buildCard(U("/to-adult", "page.example.com"), { lookup: D2 }), (e) => e.code === "adult" || e.code === "card_text");
  await assert.rejects(M.checkLive("https://www.pornhub.com/", CFG, { lookup: DNS }), refusedWith("adult"));
});

test("SAFETY-4: block - the stored picture 'blocked' (never served or reused), its file deleted, its hash + link remembered for good", async () => {
  FIX.set("/blockme.png", [200, { "content-type": "image/png" }, await sharp({ create: { width: 26, height: 22, channels: 3, background: "#5a5" } }).png().toBuffer()]);
  const a = await M.fetchImage(U("/blockme.png"), { lookup: DNS, by: "web:t" });
  const file = path.join(process.env.ONAIR_MEDIA_DIR, a.file);
  assert.equal((await fetch(base + "/onair/m/" + a.file)).status, 200);
  const b = await M.block({ refs: [a.id] }, "web:boss");
  assert.deepEqual(b.assets.map((x) => x.id), [a.id]);
  assert.deepEqual(b.urls, [U("/blockme.png")]);
  assert.equal((await getQuery("SELECT status FROM onair_media WHERE id = ?", [a.id]))[0].status, "blocked");
  assert.equal(fs.existsSync(file), false, "the file is gone");
  assert.equal((await fetch(base + "/onair/m/" + a.file)).status, 404, "never served again");
  const h = hits["/blockme.png"], n = CALLS;
  await assert.rejects(M.fetchImage(U("/blockme.png"), { lookup: DNS }), refusedWith("blocked"));
  assert.equal(hits["/blockme.png"], h, "the blocked link isn't even fetched");
  FIX.set("/blockme-copy.png", FIX.get("/blockme.png"));
  await assert.rejects(M.fetchImage(U("/blockme-copy.png"), { lookup: DNS }), refusedWith("blocked"));
  assert.equal(CALLS, n, "the same picture from another link: refused by its hash, no vision call");
  const r = (await M.recentAssets(1))[0];
  assert.equal(r.id, a.id);
  assert.deepEqual([r.status, r.file], ["blocked", null], "the staff list shows it blocked, without its file");
  // blocks outlive the 30-day refusal memory
  await M.sweep(new Set(), Date.now() + 40 * 86400e3);
  await assert.rejects(M.fetchImage(U("/blockme-copy.png"), { lookup: DNS }), refusedWith("blocked"));
  // a blocked link for a direct picture / live page / card
  await M.blockUrl(U("/a.png", "cdn.example.com"), "web:boss", "test");
  await assert.rejects(M.checkDirect(U("/a.png", "cdn.example.com"), { lookup: DNS }), refusedWith("blocked"));
  await M.blockUrl(U("/page", "page.example.com"), "web:boss", "test");
  await assert.rejects(M.buildCard(U("/page", "page.example.com"), { lookup: DNS }), refusedWith("blocked"));
  await assert.rejects(M.checkLive(U("/page", "page.example.com"), CFG, { lookup: DNS }), refusedWith("blocked"));
  await runQuery("DELETE FROM onair_refused WHERE sha256 LIKE 'url:%'");
  M._reset(); await M.init();
});

test("SAFETY-5: the safety check names who sent it and where from (ref + src + the account); strikes block the person", async () => {
  ANSWER = { verdict: "nsfw", scores: sc({ nudity_explicit: 0.9 }) };
  FIX.set("/strike.png", [200, { "content-type": "image/png" }, await sharp({ create: { width: 27, height: 22, channels: 3, background: "#a5a" } }).png().toBuffer()]);
  await assert.rejects(M.fetchImage(U("/strike.png"), { lookup: DNS, by: "pepe:frogfan", userId: STAFF.userId }), (e) => e.code === "unsafe" && e.logId > 0);
  const row = (await getQuery("SELECT ref, src, user_id FROM image_safety_log WHERE surface = 'onair' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([row.ref, row.src, row.user_id], ["onair:pepe:frogfan", U("/strike.png"), STAFF.userId]);
  assert.equal((await ISF.recent({ filter: "all", limit: 1 }))[0].src, U("/strike.png"));
  ANSWER = CLEAN;
  // three unsafe refusals in 24 h -> blocked 24 h; a possible-minor flag -> blocked at once
  const who = "u:strikes1";
  for (let i = 0; i < 3; i++) {
    const id = await M.rateCheck(who, 50);
    const out = await M.noteOutcome(id, who, { state: "refused", code: "unsafe", label: "tester" });
    assert.equal(!!out.blocked, i === 2, "blocked on the third");
  }
  await assert.rejects(M.assertPersonOk(who), (e) => e.code === "person_blocked" && e.status === 403);
  assert.ok((await M.personBlocks()).some((p) => p.who === who));
  assert.equal(await M.liftPerson(who, "web:boss"), true);
  await M.assertPersonOk(who);
  const m2 = "u:minor1";
  const id2 = await M.rateCheck(m2, 50);
  const out2 = await M.noteOutcome(id2, m2, { state: "refused", code: "unsafe", minor: true });
  assert.ok(out2.blocked > Date.now() + 29 * 86400e3, "a possible-minor flag: blocked at once, for 30 days");
  await assert.rejects(M.assertPersonOk(m2), (e) => e.code === "person_blocked");
  // a chat login linked to an account is that account (one bucket)
  assert.equal(await M.userIdForLogin("STAFFER_cf"), STAFF.userId);
  assert.equal(await M.userIdForLogin("nobody_here"), null);
});
