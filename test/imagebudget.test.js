// 1.99anw review: imagebudget.js - a picture's decode cost from its header (sharp metadata), the format allow-list behind it, and
// the decode slots. The route itself (the profile photo) is test/uploadguard.test.js.
//   NODE_PATH=<repo>/node_modules TZ=UTC node --test test/imagebudget.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const sharp = require("sharp");
const IB = require(path.join(__dirname, "..", "imagebudget"));

const MiB = 1024 * 1024;
const AVATAR = { formats: ["jpeg", "png", "webp", "gif", "heif", "tiff"], maxPixels: 60e6, maxBytes: 128 * MiB };
const meta = (format, w, h, extra = {}) => ({ format, width: w, height: h, channels: 3, depth: "uchar", isProgressive: false, ...extra });

test("decodeBytes: the formats that hold the whole frame cost more per pixel than the ones decoded a strip at a time", () => {
  const px = 7740 * 7740;   // the review's 59.9 Mpx pictures
  const cost = (m) => IB.decodeBytes(m) / px;
  assert.equal(cost(meta("jpeg", 7740, 7740)), 0.25, "baseline JPEG: shrink-on-load");
  assert.ok(Math.abs(cost(meta("jpeg", 7740, 7740, { isProgressive: true })) - 3.3) < 1e-9, "progressive JPEG: every coefficient (3 channels)");
  assert.ok(Math.abs(cost(meta("png", 7740, 7740)) - 1.8) < 1e-9, "8-bit RGB PNG");
  assert.ok(Math.abs(cost(meta("png", 7740, 7740, { channels: 4, depth: "ushort" })) - 4.8) < 1e-9, "16-bit RGBA PNG");
  assert.ok(Math.abs(cost(meta("png", 7740, 7740, { channels: 4, depth: "ushort", isProgressive: true })) - 10.4) < 1e-9, "interlaced 16-bit RGBA PNG");
  assert.equal(cost(meta("gif", 7740, 7740, { channels: 4 })), 8, "GIF: an RGBA frame + the one before it");
  assert.ok(Math.abs(cost(meta("webp", 7740, 7740, { channels: 4 })) - 1.2) < 1e-9);
  assert.equal(cost(meta("heif", 7740, 7740)), 18, "AVIF: the whole picture, in YUV and RGB");
  for (const bad of [meta("svg", 100, 100), meta("pdf", 100, 100), meta("png", 0, 100), meta("png", NaN, 5), null, {}]) assert.equal(IB.decodeBytes(bad), Infinity, JSON.stringify(bad));
  // every measured case (imagebudget.js's table) is under its estimate
  const measured = [[meta("jpeg", 7740, 7740), 0.1], [meta("jpeg", 7740, 7740, { isProgressive: true }), 2.9], [meta("png", 7740, 7740), 1.5],
    [meta("png", 7740, 7740, { channels: 4 }), 2.2], [meta("png", 7740, 7740, { channels: 4, depth: "ushort" }), 4.3],
    [meta("png", 7740, 7740, { channels: 4, isProgressive: true }), 4.9], [meta("png", 7740, 7740, { channels: 4, depth: "ushort", isProgressive: true }), 9.6],
    [meta("gif", 4000, 4000, { channels: 4 }), 7.75], [meta("webp", 7740, 7740, { channels: 4 }), 1.1], [meta("webp", 7740, 7740), 0.5],
    [meta("tiff", 7740, 7740), 1.5], [meta("heif", 4000, 4000), 17]];
  for (const [m, perPx] of measured) assert.ok(IB.decodeBytes(m) >= perPx * m.width * m.height, `${m.format} ${m.channels}ch ${m.depth}${m.isProgressive ? " progressive" : ""}`);
});

test("check: the avatar's formats only, at most 60 Mpx, and an estimated decode within 128 MiB", () => {
  const code = (m) => { const no = IB.check(m, AVATAR); return no ? no.code : "ok"; };
  // what the review measured: refused now
  assert.equal(code(meta("png", 7740, 7740, { channels: 4, depth: "ushort", isProgressive: true })), "TOO_MANY_PIXELS", "interlaced 16-bit PNG, 59.9 Mpx (~550 MB)");
  assert.equal(code(meta("gif", 7740, 7740, { channels: 4 })), "TOO_MANY_PIXELS", "41 KB GIF, 59.9 Mpx (~400 MB)");
  assert.equal(code(meta("heif", 4000, 4000)), "TOO_MANY_PIXELS", "486-byte AVIF, 16 Mpx (273 MB)");
  // what streams (or shrinks on load) keeps the pixel cap
  assert.equal(code(meta("jpeg", 7740, 7740)), "ok", "a 59.9 Mpx baseline JPEG (a phone photo) - 6 MB to decode");
  assert.equal(code(meta("png", 7740, 7740)), "ok", "a 59.9 Mpx 8-bit RGB PNG - 87 MB");
  assert.equal(code(meta("webp", 7740, 7740, { channels: 4 })), "ok");
  assert.equal(code(meta("jpeg", 7800, 7800)), "TOO_MANY_PIXELS", "over 60 Mpx");
  // the edges the route test uses
  assert.equal(code(meta("gif", 4000, 4000, { channels: 4 })), "ok");
  assert.equal(code(meta("gif", 4200, 4200, { channels: 4 })), "TOO_MANY_PIXELS");
  assert.equal(code(meta("png", 3700, 3700, { channels: 4, depth: "ushort" })), "ok");
  assert.equal(code(meta("png", 3700, 3700, { channels: 4, depth: "ushort", isProgressive: true })), "TOO_MANY_PIXELS");
  assert.equal(code(meta("heif", 2000, 2000)), "ok");
  assert.equal(code(meta("heif", 3000, 3000)), "TOO_MANY_PIXELS");
  assert.equal(code(meta("jpeg", 7000, 7000)), "ok");
  assert.equal(code(meta("jpeg", 7000, 7000, { isProgressive: true })), "TOO_MANY_PIXELS");
  // not one of the avatar's formats, whatever the browser called it
  for (const f of ["svg", "pdf", "magick", "jp2", "raw", undefined]) assert.equal(code(meta(f, 100, 100)), "NOT_A_PICTURE", String(f));
  assert.equal(code(null), "NOT_A_PICTURE");
  assert.equal(code(meta("png", 0, 0)), "TOO_MANY_PIXELS", "no size: not priced, not decoded");
  const no = IB.check(meta("gif", 7740, 7740), AVATAR);
  assert.match(no.message, /too large/);
});

test("check reads what sharp's header says: interlaced PNG = isProgressive, AVIF = heif, GIF = 4 channels, SVG = svg", async () => {
  const c = (w, h, ch) => sharp({ create: { width: w, height: h, channels: ch, background: ch === 4 ? { r: 9, g: 99, b: 9, alpha: 0.5 } : { r: 9, g: 99, b: 9 } } });
  const m = async (buf) => sharp(buf).metadata();
  const pi = await m(await c(64, 64, 4).toColourspace("rgb16").png({ progressive: true }).toBuffer());
  assert.equal(pi.format, "png"); assert.equal(pi.isProgressive, true); assert.equal(pi.depth, "ushort"); assert.equal(pi.channels, 4);
  const p = await m(await c(64, 64, 3).png().toBuffer());
  assert.equal(p.isProgressive, false); assert.equal(p.depth, "uchar");
  const a = await m(await c(64, 64, 3).avif({ effort: 0 }).toBuffer());
  assert.equal(a.format, "heif", "sharp calls AVIF heif");
  const g = await m(await c(64, 64, 3).gif().toBuffer());
  assert.equal(g.format, "gif"); assert.equal(g.channels, 4, "a GIF decodes to RGBA");
  const j = await m(await c(64, 64, 3).jpeg({ progressive: true }).toBuffer());
  assert.equal(j.format, "jpeg"); assert.equal(j.isProgressive, true);
  const s = await m(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'/>"));
  assert.equal(s.format, "svg");
  assert.equal(IB.check(s, AVATAR).code, "NOT_A_PICTURE");
  for (const x of [pi, p, a, g, j]) assert.equal(IB.check(x, AVATAR), null, x.format);
});

test("createSlots: at most `size` at once, the rest wait their turn in order, a full queue is refused, a release counts once", async () => {
  const S = IB.createSlots({ size: 2, waiting: 3 });
  const order = [];
  const r1 = await S.acquire(), r2 = await S.acquire();
  assert.deepEqual(S.stats(), { size: 2, active: 2, waiting: 0, peak: 2 });
  const q = [S.acquire(), S.acquire(), S.acquire()];
  q.forEach((p, i) => p.then((rel) => { order.push(i); q[i] = rel; }));
  assert.equal(S.acquire(), null, "the queue is full: the caller answers busy");
  assert.equal(S.stats().waiting, 3);
  r1(); r1();   // twice: one slot freed, not two
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [0]);
  assert.deepEqual(S.stats(), { size: 2, active: 2, waiting: 2, peak: 2 });
  r2();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [0, 1]);
  q[0](); q[1]();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual(S.stats(), { size: 2, active: 1, waiting: 0, peak: 2 });
  q[2]();
  assert.deepEqual(S.stats(), { size: 2, active: 0, waiting: 0, peak: 2 });
  assert.notEqual(S.acquire(), null, "free again");
});

test("the libvips operation cache is off for the whole site (index.js): a cached load kept its decoder's memory, uncounted", async () => {
  const src = require("fs").readFileSync(path.join(__dirname, "..", "index.js"), "utf8").replace(/\r\n/g, "\n");
  assert.match(src, /\nconst sharp = require\("sharp"\);\n(\/\/[^\n]*\n)+sharp\.cache\(false\);\n/, "right after sharp is loaded");
  const fx = require("fs").readFileSync(path.join(__dirname, "fixtures", "uploadguard-server.js"), "utf8");
  assert.match(fx, /\nsharp\.cache\(false\);/, "the route test's child runs the same");
  // the mechanism: with the cache on, every load stays cached after its request - 917 MB after 8 progressive JPEG photos
  // (imagebudget.js / index.js); its memory counter doesn't see the decoder's memory
  const pic = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: { r: 9, g: 99, b: 9 } } }).jpeg({ progressive: true }).toBuffer();
  const before = sharp.cache();
  try {
    sharp.cache(true);
    for (let i = 0; i < 3; i++) await sharp(Buffer.from(pic)).resize(200, 200).jpeg().toBuffer();
    const on = sharp.cache();
    assert.ok(on.items.current > 0, "the loads stayed cached: " + JSON.stringify(on));
    sharp.cache(false);
    assert.equal(sharp.cache().items.current, 0, "dropped");
    for (let i = 0; i < 3; i++) await sharp(Buffer.from(pic)).resize(200, 200).jpeg().toBuffer();
    assert.deepEqual([sharp.cache().items.current, sharp.cache().items.max], [0, 0], "nothing is kept");
  } finally {
    sharp.cache({ memory: before.memory.max, files: before.files.max, items: before.items.max });
  }
});
