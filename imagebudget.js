// imagebudget.js - 1.99anw (review): what a picture will cost to decode, read from its header before it is decoded, and how many
// decodes may run at once. The profile photo (user.controller updateAvatar) uses both.
//
// Why: sharp's limitInputPixels counts pixels, not bytes. Some formats can't be decoded a strip at a time, so libvips holds the
// whole frame in memory: an interlaced 16-bit PNG of 720 KB at 59.9 Mpx took ~550 MB, a 41 KB GIF ~400 MB, and a 486-byte AVIF
// of 16 Mpx 273 MB. Eight of those at once took the site from 72 MB to 2.3 GB and held all 4 libuv threads, so the database and
// the file system waited about a second. That is an OOM-kill on a smaller VPS. decodeBytes() estimates the peak from the header
// (sharp(...).metadata(), which reads the header only) and check() refuses a picture over the budget. createSlots() caps how many
// decodes run at once, so a burst can't take every libuv thread. One more piece is in index.js: sharp.cache(false). libvips'
// operation cache kept each load it had cached, with its decoder's memory, and the cache's 50 MB limit doesn't count that memory.
// 8 photos uploaded one after another (40 Mpx progressive JPEGs) left the process 917 MB bigger, and 4 MB without the cache.
"use strict";

const MiB = 1024 * 1024;
const SAMPLE_BYTES = { uchar: 1, char: 1, ushort: 2, short: 2, uint: 4, int: 4, float: 4, double: 8, complex: 8, dpcomplex: 16 };

// Bytes per pixel at the decode's peak, measured with sharp 0.33.5 / libvips 8.15.3 on the avatar's pipeline
// (resize(200, 200).jpeg(), one decode in a fresh process, 7740 x 7740 = 59.9 Mpx unless noted). Each factor is rounded up:
//   jpeg baseline 0.1 (shrink-on-load)        jpeg progressive 2.9 (3 channels; libjpeg keeps every coefficient)
//   png rgb8 1.5   rgba8 2.2   rgba16 4.3      png interlaced: rgba8 4.9   rgba16 9.6
//   gif 7.75 at 16 Mpx (an RGBA frame + the one before it)                  webp lossy 0.05   alpha 1.1   lossless 0.5
//   tiff rgb8 deflate 1.5                      heif (AVIF) 17 at 16 Mpx, 3 channels
const FACTOR = Object.freeze({
  jpeg: (m, ch) => (m.isProgressive ? 1.1 * ch : 0.25),
  png: (m, ch, b) => ch * b * (m.isProgressive ? 1.3 : 0.6),
  gif: () => 8,
  webp: (m, ch) => 0.3 * ch,
  tiff: (m, ch, b) => 1.3 * ch * b,
  heif: (m, ch) => 6 * ch,
});

/** sharp metadata -> the estimated peak bytes of decoding it at full size (Infinity: a format or a size we can't price). */
function decodeBytes(meta) {
  const w = Number(meta && meta.width), h = Number(meta && meta.height);
  if (!(w > 0 && h > 0) || !Object.prototype.hasOwnProperty.call(FACTOR, meta.format)) return Infinity;
  const ch = Math.max(1, Math.floor(Number(meta.channels)) || 4), b = SAMPLE_BYTES[meta.depth] || 1;
  return w * h * FACTOR[meta.format](meta, ch, b);
}

/** -> null when the picture may be decoded, else { code, message } (the caller answers 400).
 *  opts: formats (sharp's names), maxPixels, maxBytes (decodeBytes' estimate). */
function check(meta, opts = {}) {
  const formats = opts.formats || Object.keys(FACTOR);
  if (!meta || !formats.includes(meta.format)) return { code: "NOT_A_PICTURE", message: "That isn't a picture - use a JPEG, PNG, WebP, GIF or AVIF." };
  const px = Number(meta.width) * Number(meta.height);
  const tooBig = { code: "TOO_MANY_PIXELS", message: "That picture is too large to process - try a smaller one (a JPEG works best)." };
  if (!(px > 0) || (opts.maxPixels && px > opts.maxPixels)) return tooBig;
  if (opts.maxBytes && decodeBytes(meta) > opts.maxBytes) return tooBig;
  return null;
}

/** At most `size` holders at once, at most `waiting` queued behind them. acquire() -> a promise of a release function (call it
 *  once; more calls do nothing), or null when the queue is full (the caller answers "busy"). */
function createSlots({ size = 2, waiting = 16 } = {}) {
  let active = 0, peak = 0;
  const queue = [];
  const take = () => {
    peak = Math.max(peak, active);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      if (next) next(); else active--;   // the slot passes straight to the next in line
    };
  };
  return {
    acquire() {
      if (active < size) { active++; return Promise.resolve(take()); }
      if (queue.length >= waiting) return null;
      return new Promise((resolve) => queue.push(() => resolve(take())));
    },
    stats: () => ({ size, active, waiting: queue.length, peak }),
  };
}

module.exports = { MiB, FACTOR, decodeBytes, check, createSlots };
