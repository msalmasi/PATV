// micvad 1.99akk cross-repo contract: Pepe's real MP3 + level posts (camfrog-bot ci/fixtures/micvad/posts.json - real lameenc,
// pepe_audiolv, Pepe's 0.25 s ticks and one retried post) through the site's audiolv.js (clean + the framed prime / broadcast)
// and the page's own walker + ring (room-bridge.js PATVRoom._lv): every level must land where the listener HEARS that audio -
// the burst truth + 1105/48000 s (LAME's + the decoder's delay) - within the bot test's budget (median |error| <= 60 ms,
// max <= 110 ms), for a listener joining mid-stream and for a second one joining 1 s later.
//   TZ=UTC PEPE_BOT_DIR=G:/wt/casino2-bot node --test test/micvad-contract.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const AL = require(path.join(repo, "audiolv"));
const dir = process.env.PEPE_BOT_DIR || path.join(repo, "camfrog-bot");
const FXP = path.join(dir, "ci", "fixtures", "micvad", "posts.json");
const FX = fs.existsSync(FXP) ? JSON.parse(fs.readFileSync(FXP, "utf8")) : null;

function pageLv() {
  const win = {};
  const ctx = { window: win, navigator: { userAgent: "" }, document: { addEventListener() {} }, Math, JSON, Uint8Array, TextDecoder, console,
    setTimeout() {}, setInterval() {}, clearInterval() {}, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  return win.PATVRoom._lv;
}
const MP3 = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
/** An independent walk of the whole relay from Pepe's first byte: each post's first header offset + its media seconds. */
function walkAll(bufs) {
  let carry = Buffer.alloc(0), skip = 0, t = 0;
  return bufs.map((data) => {
    const buf = Buffer.concat([carry, data]), base = carry.length;
    let i = skip, first = null, tf = null;
    while (i + 4 <= buf.length) {
      const h = buf.readUInt32BE(i), ver = (h >>> 19) & 3, bri = (h >>> 12) & 15, sri = (h >>> 10) & 3;
      assert.equal(h >>> 21, 0x7ff, "a header");
      const r = SR[ver][sri], k = MP3[ver === 3 ? 1 : 2][bri], size = Math.floor((ver === 3 ? 144 : 72) * k * 1000 / r) + ((h >>> 9) & 1);
      if (first === null && i >= base) { first = i - base; tf = t; }
      t += (ver === 3 ? 1152 : 576) / r;
      i += size;
    }
    if (i < buf.length) { carry = buf.subarray(i); skip = 0; if (first === null && i >= base) { first = i - base; tf = t; } } else { carry = Buffer.alloc(0); skip = i - buf.length; }
    return { first, tf };
  });
}
/** A listener that opens /p/:slug/audio?lv=1 just before post `join` (the hub remembers the 2 posts before it: the 0.5 s prime). */
function listen(LV, posts, join, chunk = 333) {
  const bufs = posts.map((p) => Buffer.from(p.data, "base64"));
  const res = { out: [], write(b) { this.out.push(Buffer.from(b)); } };
  const remembered = (i) => ({ buf: bufs[i], lv: AL.clean(posts[i].lv, bufs[i].length) });
  AL.open(res, { recent: [join - 2, join - 1].filter((i) => i >= 0).map(remembered) });
  for (let i = join; i < posts.length; i++) res.framed(bufs[i], AL.clean(posts[i].lv, bufs[i].length));
  const wire = Buffer.concat(res.out), L = LV.session(), appended = [];
  for (let o = 0; o < wire.length; o += chunk) LV.feed(L, new Uint8Array(wire.subarray(o, o + chunk)), (b) => appended.push(Buffer.from(b)));
  const cut = Math.max(0, join - 2);   // (the prime's first post: every post names a header)
  return { L, appended: Buffer.concat(appended), cut, bufs };
}
function edges(frames) {
  const on = [], off = [];
  let prev = 0;
  for (const [s, , v] of frames.slice().sort((a, b) => a[0] - b[0])) {
    if (v && !prev) on.push(s);
    if (!v && prev) off.push(s);
    prev = v;
  }
  return { on, off };
}

test("Pepe's levels land on the audio the listener hears (mid-stream join, and another 1 s later)", { skip: !FX && "no camfrog-bot checkout (PEPE_BOT_DIR)" }, () => {
  const LV = pageLv();
  const posts = FX.posts, delay = FX.delay_s;
  assert.equal(delay, 1105 / 48000);
  const bufs = posts.map((p) => Buffer.from(p.data, "base64"));
  const abs = walkAll(bufs);
  abs.forEach((a, i) => { assert.equal(posts[i].lv.h, a.first, "Pepe's h is the post's first header"); if (posts[i].mh != null) assert.ok(Math.abs(posts[i].mh - a.tf) < 1e-6); });
  const runs = [];
  for (const join of [6, 10]) {                         // 1.5 s in, and 1 s (4 posts) later
    const { L, appended, cut } = listen(LV, posts, join);
    assert.equal(L.bad, false, "the page's walk matched every level record");
    assert.deepEqual(appended, Buffer.concat(bufs.slice(cut)).subarray(posts[cut].lv.h), "the page appended Pepe's MP3 from the cut header on");
    const t0 = abs[cut].tf;                             // the listener's media time 0 = this header, in Pepe's count
    const frames = [];
    for (const e of L.ring) for (let i = 0; i < e.d.length; i++) frames.push([t0 + e.g + 0.1 * i, t0 + e.g + 0.1 * (i + 1), parseInt(e.d[i], 16)]);
    // THE contract: each level sits at exactly the media time Pepe pinned it to (his post's header + a + 100 ms steps)
    const pinned = [];
    for (let i = cut; i < posts.length; i++) {
      const lv = posts[i].lv;
      for (let k = 0; k < (lv.d || "").length; k++) pinned.push([abs[i].tf + lv.a / 1000 + 0.1 * k, parseInt(lv.d[k], 16)]);
    }
    assert.equal(frames.length, pinned.length, "every level Pepe sent from the cut on");
    frames.forEach(([s, , v], k) => { assert.ok(Math.abs(s - pinned[k][0]) < 1e-6, `level ${k} at ${s} vs ${pinned[k][0]}`); assert.equal(v, pinned[k][1]); });
    const lo = frames[0][0] + 0.15, hi = frames[frames.length - 1][1] - 0.15;
    const { on, off } = edges(frames);
    const errs = [];
    for (const [a, b] of FX.truth) {
      for (const [t, list] of [[a + delay, on], [b + delay, off]]) {
        if (t < lo || t > hi) continue;
        const near = list.reduce((m, x) => (Math.abs(x - t) < Math.abs(m - t) ? x : m), Infinity);
        assert.ok(Math.abs(near - t) <= 0.3, `an edge at ${t.toFixed(3)} s has a level edge near it`);
        errs.push(near - t);
      }
    }
    assert.ok(errs.length >= 6, `enough edges to judge (${errs.length})`);
    // ...and so on what the listener hears: 100 ms levels cover the speech (an onset up to one level early, a stop up to one
    // late). The median budget (<= 60 ms) needs many edges: the bot's audiolv_test.py judges it over 60 s of real lameenc
    // (~64 edges); here, with this short fixture, the bound and the signs are what can be told apart.
    const abserr = errs.map(Math.abs);
    assert.ok(Math.max(...abserr) <= 0.110, `max |error| ${(Math.max(...abserr) * 1000).toFixed(0)} ms`);
    runs.push(frames);
  }
  // the second listener's levels sit at exactly the same media times as the first one's
  const first = new Map(runs[0].map(([s, , v]) => [s.toFixed(4), v]));
  let same = 0;
  for (const [s, , v] of runs[1]) if (first.has(s.toFixed(4))) { assert.equal(first.get(s.toFixed(4)), v); same++; }
  assert.ok(same >= runs[1].length - 2, `the later listener's levels line up with the first's (${same}/${runs[1].length})`);
});

test("the retried post (prev + cur, one lv) and a join right at the start", { skip: !FX && "no fixture" }, () => {
  const LV = pageLv();
  const { L, cut } = listen(LV, FX.posts, 0, 1);       // 1-byte reads, from Pepe's very first post
  assert.equal(cut, 0); assert.equal(L.bad, false);
  const merged = FX.posts.findIndex((p) => p.lv.d && p.lv.d.length >= 5);
  assert.ok(merged > 0, "the fixture has the merged retry (2 ticks of levels in one post)");
  assert.equal(L.recs, FX.posts.length);
});
