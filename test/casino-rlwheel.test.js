// casino/rlwheel.js - the shared roulette wheel and ball (roulette v2, O11). Cosmetic only, but it must ALWAYS show the
// server's pocket: every pocket x 20 public seeds x D in {4, 8, 12, 20} s lands in the right pocket at the right time, the
// plan is deterministic (golden vectors, shared with the bot's OBS test), time only moves forward, the rotor never runs
// backwards, the relabel shift happens while the ball is still on the backtrack (a forward flick that only coasts down, for
// on-time and late viewers alike), the ball never passes through a diamond or teleports, and nothing is seeded from a secret.
// Regenerate the vectors (only when the model changes on purpose, with VERSION bumped): RLWHEEL_WRITE_VECTORS=1 node --test test/casino-rlwheel.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const W = require("../casino/rlwheel");
const engine = require("../casino/rlengine");
const bets = require("../casino/rlbets");

const repo = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "casino", "rlwheel.js"), "utf8");
const VECTORS = path.join(__dirname, "fixtures", "rlwheel_vectors.json");
const TAU = 2 * Math.PI;
const POCKET_MS = W.IDLE_PERIOD_MS / 37;
const DURATIONS = [4000, 8000, 12000, 20000];
const BASE = 1795000000000; // 2026-11-17-ish, integer ms like the server's clock()
const SEEDS = Array.from({ length: 20 }, (_, i) => ({ tableId: (0x3a5c0f00 + i * 0x1f3d5).toString(16).padStart(10, "0"), round: 1 + i * 37 }));
const norm = (a) => ((a % TAU) + TAU) % TAU;
const startOf = (si, di) => BASE + si * 7919 + di * 104729;
// how far the ball sits from its pocket's centre (rad) when the rotor shows `rotor`
const centreErr = (f, pocket) => {
  const d = norm(f.theta - f.rotor - W.WHEEL.indexOf(pocket) * W.PITCH);
  return Math.min(d, TAU - d);
};
const PHASES = ["idle", "track", "cone", "rotor", "settled"];

function fnvBytes(u8) {
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 0x01000193) >>> 0;
  return h >>> 0;
}
// a checksum of the ball's path (r, theta, z columns: the same for every pocket of a seed - only the rotor shift differs)
function ballSum(p) {
  const cols = new Float32Array(p.n * 3);
  for (let i = 0; i < p.n; i++) {
    cols[i * 3] = p.frames[i * 4 + 1];
    cols[i * 3 + 1] = p.frames[i * 4 + 2];
    cols[i * 3 + 2] = p.frames[i * 4 + 3];
  }
  return fnvBytes(new Uint8Array(cols.buffer));
}
function sample(p, t) {
  const f = W.frame(p, t);
  return [t - p.landAt, f.rotor, f.r, f.theta, f.z, PHASES.indexOf(f.phase)];
}
function buildVectors() {
  const cases = [];
  SEEDS.forEach((sd, si) =>
    DURATIONS.forEach((D, di) => {
      const startedAt = startOf(si, di),
        landAt = startedAt + D,
        ks = [];
      let p0 = null;
      for (let pocket = 0; pocket < 37; pocket++) {
        const p = W.plan({ ...sd, pocket, startedAt, landAt });
        ks.push(p.k);
        if (pocket === (si * 4 + di) % 37) p0 = p;
      }
      cases.push({
        tableId: sd.tableId, round: sd.round, D, startedAt, landAt,
        seed: p0.seed, variant: p0.variant, s: p0.s, n: p0.n,
        exitAt: p0.exitAt, entryAt: p0.entryAt, settleAt: p0.settleAt, rampTo: p0.rampTo,
        ball: ballSum(p0), k: ks,
        pocket: p0.pocket,
        samples: [p0.t0 + 400, p0.rampTo, p0.exitAt + 120, p0.entryAt + 90, p0.settleAt - 40, landAt, landAt + 2500].map((t) => sample(p0, t)),
      });
    }),
  );
  return {
    about: "Golden vectors for casino/rlwheel.js (the shared roulette wheel: site test test/casino-rlwheel.test.js and the bot's " +
      "obs_casino_scene_test). Each case: plan({tableId, round, pocket, startedAt, landAt = startedAt + D}). k[pocket] = whole pockets " +
      "the rotor is shown shifted; s = the idle rotor's slot the ball settles in (pocket-independent); ball = FNV-1a over the Float32 " +
      "bytes of the frames' r/theta/z columns; samples = [t - landAt, rotor, r, theta, z, phase(0 idle,1 track,2 cone,3 rotor,4 settled)] " +
      "for the case's own pocket. Regenerate only when the model changes on purpose (bump VERSION): RLWHEEL_WRITE_VECTORS=1 node --test test/casino-rlwheel.test.js",
    version: W.VERSION,
    idle_period_ms: W.IDLE_PERIOD_MS,
    lead_ms: W.LEAD_MS,
    wheel: W.WHEEL.slice(),
    fnv1a: ["", "a", "foobar", "3a5c0f00:1", "ab12cd34ef:17", "é:1"].map((s) => [s, W.fnv1a(s)]),
    mulberry32: { seed: 0x9e3779b9, first: (() => { const r = W.mulberry32(0x9e3779b9); return [r(), r(), r(), r()]; })() },
    cases,
  };
}

if (process.env.RLWHEEL_WRITE_VECTORS === "1") {
  fs.writeFileSync(VECTORS, JSON.stringify(buildVectors()) + "\n");
  console.log("wrote", VECTORS);
}
const V = JSON.parse(fs.readFileSync(VECTORS, "utf8"));

test("the wheel matches the engine: European order, reds, colours", () => {
  assert.deepEqual([...W.WHEEL], [...engine.WHEEL]);
  assert.deepEqual([...W.RED], [...bets.red]);
  assert.equal(new Set(W.WHEEL).size, 37);
  for (let n = 0; n <= 36; n++) assert.equal(W.colorOf(n), n === 0 ? "zero" : engine.color(n) === "red" ? "red" : "black");
  assert.ok(Math.abs(W.PITCH - TAU / 37) < 1e-15);
});

test("UMD: the browser global is the same module (bit-identical plans)", () => {
  const ctx = vm.createContext({});
  vm.runInContext(SRC, ctx);
  const B = ctx.PATVRlWheel;
  assert.ok(B && typeof B.plan === "function" && typeof B.mount === "function" && typeof B.frame === "function");
  const args = { tableId: "ab12cd34ef", round: 41, pocket: 26, startedAt: BASE + 5, landAt: BASE + 12005 };
  const a = W.plan(args), b = B.plan(args);
  assert.equal(a.k, b.k);
  assert.equal(a.s, b.s);
  assert.equal(a.settleAt, b.settleAt);
  assert.deepEqual(Buffer.from(a.frames.buffer), Buffer.from(b.frames.buffer));
});

test("public cosmetic seed: FNV-1a(tableId:round) -> mulberry32, pinned", () => {
  assert.equal(W.fnv1a(""), 0x811c9dc5);
  assert.equal(W.fnv1a("a"), 0xe40c292c);
  assert.equal(W.fnv1a("foobar"), 0xbf9cf968);
  for (const [s, h] of V.fnv1a) assert.equal(W.fnv1a(s), h, s);
  assert.equal(W.seedOf("ab12cd34ef", 17), W.fnv1a("ab12cd34ef:17"));
  const r = W.mulberry32(V.mulberry32.seed);
  assert.deepEqual([r(), r(), r(), r()], V.mulberry32.first);
  const p = W.plan({ tableId: "ab12cd34ef", round: 17, pocket: 3, startedAt: BASE, landAt: BASE + 8000 });
  assert.equal(p.seed, W.fnv1a("ab12cd34ef:17"));
});

test("never derived from a secret: no seed / commitment inputs, extra fields change nothing", () => {
  // the source never reads a fairness value or the server's seeds, and loads nothing (code only: the header names them)
  const code = SRC.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const bad of [/round\.seed/, /next\.seed/, /\.commitment/, /server_?seed/i, /client_?seed/i, /require\(/, /\bfetch\(/, /XMLHttpRequest/, /localStorage/])
    assert.doesNotMatch(code, bad);
  assert.match(SRC, /never from round\.seed \/ next\.seed/, "the header says so");
  const args = { tableId: "0f1e2d3c4b", round: 9, pocket: 32, startedAt: BASE + 11, landAt: BASE + 12011 };
  const a = W.plan(args);
  W._clearCache();
  const b = W.plan({ ...args, seed: "f".repeat(64), next: { seed: "e".repeat(64) }, commitment: "a".repeat(64), client_seed: "00" });
  assert.notEqual(a, b);
  assert.deepEqual(Buffer.from(a.frames.buffer), Buffer.from(b.frames.buffer));
  assert.equal(a.k, b.k);
  // spinArgs (what mount().spin reads from a view) keeps only the public fields
  const view = { id: "0f1e2d3c4b", phase: "spinning", commitment: "c".repeat(64), next_commitment: "d".repeat(64), client_seed: "11",
    spin: { round_no: 9, number: 32, color: "red", started_at: BASE + 11, ends_at: BASE + 12011, secs: 12 } };
  assert.deepEqual(W.spinArgs(view), { tableId: "0f1e2d3c4b", round: "9", pocket: 32, startedAt: BASE + 11, landAt: BASE + 12011 });
});

test("every pocket x 20 seeds x D in {4, 8, 12, 20} s: lands in the right pocket, at the right time, from the backtrack", () => {
  let n = 0;
  SEEDS.forEach((sd, si) =>
    DURATIONS.forEach((D, di) => {
      const startedAt = startOf(si, di), landAt = startedAt + D;
      for (let pocket = 0; pocket < 37; pocket++) {
        const p = W.plan({ ...sd, pocket, startedAt, landAt }), tag = `${sd.tableId}:${sd.round} D=${D} pocket ${pocket}`;
        n++;
        // the time: still LEAD_MS before land_at, moved earlier by less than one pocket of rotor time
        assert.ok(p.settleAt <= landAt - W.LEAD_MS + 1e-6, tag + " settles by land_at - 300 ms");
        assert.ok(p.settleAt > landAt - W.LEAD_MS - POCKET_MS - 1e-6, tag + " not early");
        assert.ok(p.t0 === startedAt && p.t0 < p.rampTo && p.rampTo <= p.exitAt - 300 + 1e-6 && p.exitAt < p.entryAt && p.entryAt < p.settleAt, tag + " phase order");
        assert.ok(p.exitAt - p.t0 >= 1000, tag + " the ball runs on the track for at least 1 s");
        // the slot: k whole pockets of shift put the server's number under the ball
        assert.equal(p.k, (((W.WHEEL.indexOf(pocket) - p.s) % 37) + 37) % 37, tag);
        assert.ok(Number.isInteger(p.k) && Number.isInteger(p.s));
        assert.ok(Math.abs(norm(p.off) - norm(-p.k * W.PITCH)) < 1e-9 || Math.abs(Math.abs(norm(p.off) - norm(-p.k * W.PITCH)) - TAU) < 1e-9, tag + " shift");
        for (const t of [p.settleAt, p.settleAt + 1, landAt, landAt + 5000, landAt + 60000]) {
          const f = W.frame(p, t);
          assert.equal(f.phase, "settled", tag);
          assert.equal(f.pocket, pocket, tag);
          assert.equal(W.pocketAt(f.rotor, f.theta), pocket, tag + " under the ball at " + (t - landAt));
          assert.ok(centreErr(f, pocket) < 1e-9, tag + " at the pocket's centre");
          assert.equal(f.r, W.GEOM.pocket);
          assert.equal(f.z, 0);
        }
        // the last stored frames already show it in its pocket (the analytic rest takes over seamlessly)
        const before = W.frame(p, p.settleAt - 1);
        assert.equal(W.pocketAt(before.rotor, before.theta), pocket, tag + " just before settle");
        assert.ok(centreErr(before, pocket) < 0.01, tag + " just before settle, centred");
        // the relabel shift is done while the ball is on the backtrack, and it never touched the rotor before entry
        for (let t = p.t0; t <= p.rampTo; t += 50) assert.ok(Math.abs(W.frame(p, t).r - W.GEOM.track) < 1e-6, tag + " on the track during the shift");
        assert.equal(W.frame(p, p.rampTo).phase, "track");
        assert.equal(W.frame(p, p.rampTo).offset, p.off);
        // no NaN anywhere
        for (let i = 0; i < p.frames.length; i++) if (!Number.isFinite(p.frames[i])) assert.fail(tag + " NaN at " + i);
      }
    }),
  );
  assert.equal(n, 37 * 20 * 4);
});

test("time only moves forward: phases in order, the rotor never runs backwards, the ball never jumps", () => {
  SEEDS.forEach((sd, si) =>
    DURATIONS.forEach((D, di) => {
      const startedAt = startOf(si, di), landAt = startedAt + D, pocket = (si * 7 + di * 11) % 37;
      const p = W.plan({ ...sd, pocket, startedAt, landAt }), tag = `${sd.tableId} D=${D}`;
      let prev = null, lastPhase = 0, rotorUnwrapped = 0;
      for (let t = p.t0 - 400; t <= landAt + 1500; t += 5) {
        const f = W.frame(p, t), ph = PHASES.indexOf(f.phase);
        assert.ok(ph >= lastPhase, tag + " phase went back at " + (t - p.t0));
        lastPhase = ph;
        if (prev) {
          let dr = f.rotor - prev.rotor;
          if (dr < -Math.PI) dr += TAU;
          assert.ok(dr > 0, tag + " the rotor ran backwards at " + (t - p.t0));
          assert.ok(dr < 0.2, tag + " rotor jump " + dr);
          rotorUnwrapped += dr;
          if (prev.visible && f.visible) {
            const step = Math.hypot(f.x - prev.x, f.y - prev.y);
            assert.ok(step < 0.12, tag + ` the ball jumped ${step.toFixed(3)} at ${t - p.t0}`);
            assert.ok(Math.abs(f.z - prev.z) < 0.03, tag + " hop jump");
          }
        }
        if (f.visible) {
          assert.ok(f.r >= W.GEOM.pocketIn && f.r <= W.GEOM.track + 1e-6, tag + " r " + f.r);
          assert.ok(f.z >= 0 && f.z < 0.12, tag + " z " + f.z);
          if (f.phase === "track") assert.ok(Math.abs(f.r - W.GEOM.track) < 0.002, tag + " on the track");
          if (f.phase !== "rotor" && f.phase !== "settled") assert.ok(f.r > W.GEOM.rotor - 0.03, tag + " touched the rotor early");
        }
        prev = f;
      }
      assert.ok(rotorUnwrapped > 0);
    }),
  );
});

test("the rotor relabel: a forward flick that only coasts down - never slower than idle, never re-accelerating", () => {
  for (let k = 0; k < 37; k++) {
    const want = -k * W.PITCH;
    for (const from of [0, 1, 4.5]) {
      const fwd = W._rampTarget(from, want, false), near = W._rampTarget(from, want, true);
      for (const to of [fwd, near]) assert.ok(Math.abs(Math.sin((to - want) / 2)) < 1e-9, "the same angle mod 2pi");
      assert.ok(fwd >= from && fwd < from + TAU, "forward, less than one turn");
      assert.ok(Math.abs(near - from) <= Math.PI + 1e-9, "the ease back goes the shorter way");
    }
  }
  SEEDS.slice(0, 8).forEach((sd, si) =>
    DURATIONS.forEach((D, di) => {
      for (const pocket of [0, 5, 13, 26, 36]) {
        const startedAt = startOf(si, di), p = W.plan({ ...sd, pocket, startedAt, landAt: startedAt + D }), tag = `${sd.tableId} D=${D} ${pocket}`;
        assert.ok(p.off >= 0 && p.off < TAU, tag + " off in [0, 2pi)");
        if (D >= 8000) assert.ok(p.rampTo - p.t0 >= 4900, tag + " a long, gentle flick: " + (p.rampTo - p.t0));
        let prevOff = 0, prevRate = Infinity;
        for (let t = p.t0 + 10; t <= p.rampTo + 50; t += 10) {
          const o = W.frame(p, t).offset, rate = (o - prevOff) / 0.01;
          assert.ok(o >= prevOff - 1e-12, tag + " the shift never goes back");
          if (t > p.t0) assert.ok(rate <= prevRate + 1e-6, tag + " the extra speed only falls (no re-acceleration)");
          prevOff = o;
          prevRate = rate;
        }
        // top extra speed = 2 off / ramp: within 1.2x idle for D >= 8 s (the rotor peaks at <= 2.2x idle)
        if (D >= 8000) assert.ok((2 * p.off) / ((p.rampTo - p.t0) / 1000) <= 1.25 * W.OMEGA, tag);
      }
    }),
  );
});

// the chosen variant's 240 Hz record (cone, diamonds, rotor), for the physics checks below
const D_STEP = TAU / 8, D_FIRST = TAU / 16, D_LONG = 0.05, D_SHORT = 0.017;
function distToRhomb(x, y, hx, hy) {
  x = Math.abs(x);
  y = Math.abs(y);
  let s = ((hx - x) * hx + y * hy) / (hx * hx + hy * hy);
  s = Math.max(0, Math.min(1, s));
  const d = Math.hypot(x - (hx - s * hx), y - s * hy);
  return x / hx + y / hy <= 1 ? -d : d;
}
function physicsRuns(count) {
  const runs = [];
  for (const D of [4000, 12000, 20000])
    for (let s = 0; s < count; s++) {
      const startedAt = BASE + s * 7919, p = W.plan({ tableId: "t" + (s % 7), round: s, pocket: s % 37, startedAt, landAt: startedAt + D });
      runs.push({ D, s, p, ...W._sim.replay(p) });
    }
  return runs;
}
const RUNS = physicsRuns(150);

test("diamonds: the ball never rolls flat through one, and every knock starts at the drawn rhombus", () => {
  const G = W.GEOM, B = G.ball;
  let flat = 0, knocks = 0, early = 0, first = "";
  for (const { rec, res, D, s } of RUNS) {
    for (let i = 1; i <= res.entry; i++) {
      const r = rec.r[i], th = rec.th[i], z = rec.z[i];
      const kd = Math.floor((th - D_FIRST) / D_STEP + 0.5), ac = D_FIRST + kd * D_STEP;
      const dx = r * Math.sin(th) - G.diamond * Math.sin(ac), dy = -r * Math.cos(th) + G.diamond * Math.cos(ac);
      const radialOff = dx * Math.sin(ac) - dy * Math.cos(ac), tanOff = dx * Math.cos(ac) + dy * Math.sin(ac);
      const radial = (((kd % 8) + 8) % 8) % 2 === 0, d = distToRhomb(tanOff, radialOff, radial ? D_SHORT : D_LONG, radial ? D_LONG : D_SHORT);
      if (z === 0 && d < 0 && !flat++) first = `D=${D} s=${s} step ${i}`;
      if (z === 1e-4 && rec.z[i - 1] === 0) {
        knocks++;
        if (d - B > 0.1 * B) early++; //               (the integrator is polar: a few hundredths of a ball radius of slack)
      }
    }
  }
  assert.equal(flat, 0, "the ball's centre inside a diamond on the ground, first at " + first);
  assert.ok(knocks > RUNS.length, "diamonds are hit: " + knocks);
  assert.equal(early, 0, "no knock off thin air beside the rhombus");
  // the exact test: the rhombus grown by the ball's radius
  const nr = W._sim.nearRhomb;
  assert.equal(nr(0, 0.05 + 0.029 - 1e-6, 0.017, 0.05, 0.029), true, "at the tip");
  assert.equal(nr(0, 0.05 + 0.029 + 1e-6, 0.017, 0.05, 0.029), false, "just past the tip");
  assert.equal(nr(0.017 + 0.029 * 0.95, 0.05 * 0.05, 0.017, 0.05, 0.029), true, "beside the waist");
  assert.equal(nr(0.04, 0.06, 0.017, 0.05, 0.029), false, "inside the old hit box, but clear of the rhombus");
});

test("on the rotor: no sideways teleports at a landing or off the number ring, and the rim is a slope, not a wall", () => {
  const G = W.GEOM, B = G.ball, DT = 1 / 240, om = W.OMEGA * DT;
  let teleports = 0, walls = 0, worst = 0;
  for (const { rec, res, D, s } of RUNS) {
    const ph = (i) => rec.th[i] - om * i; //              in the rotor's frame: the ball against the frets
    const d = (k) => (Math.abs(ph(k) - ph(k - 1)) * rec.r[k]) / B;
    for (let i = res.entry + 2; i < res.n - 1; i++) {
      // a step that moves the ball much further than the steps either side of it
      const di = d(i), nb = Math.max(d(i - 1), d(i + 1));
      if (di > 0.3 && di > 4 * nb) teleports++, (worst = Math.max(worst, di));
      const v0 = (rec.r[i - 1] - rec.r[i - 2]) / DT, v1 = (rec.r[i] - rec.r[i - 1]) / DT;
      if (rec.r[i - 1] >= G.rotor - B - 0.004 && v0 > 0 && v1 < 0 && v0 - v1 > 0.3) walls++;
      assert.ok(rec.r[i] <= G.rotor + 1e-9, `D=${D} s=${s} r ${rec.r[i]}`);
    }
    // entering the rotor carries the radius on (no inward snap of a ball radius at the rim)
    assert.ok(Math.abs(rec.r[res.entry + 1] - rec.r[res.entry]) < 0.6 * B, `D=${D} s=${s} entry`);
  }
  assert.equal(teleports, 0, "teleports up to " + worst.toFixed(2) + " ball radii");
  assert.ok(walls <= RUNS.length * 0.06, "rim bounces " + walls + " in " + RUNS.length + " spins");
});

test("golden vectors: plans are bit-for-bit what the fixture says (the bot's OBS test reads the same file)", () => {
  assert.equal(V.version, W.VERSION, "a model change bumps VERSION and regenerates the vectors");
  assert.equal(V.idle_period_ms, W.IDLE_PERIOD_MS);
  assert.equal(V.lead_ms, W.LEAD_MS);
  assert.deepEqual(V.wheel, [...W.WHEEL]);
  assert.equal(V.cases.length, 80);
  for (const c of V.cases) {
    const tag = `${c.tableId}:${c.round} D=${c.D}`;
    for (let pocket = 0; pocket < 37; pocket++) {
      const p = W.plan({ tableId: c.tableId, round: c.round, pocket, startedAt: c.startedAt, landAt: c.landAt });
      assert.equal(p.k, c.k[pocket], tag + " k for " + pocket);
      assert.equal(p.s, c.s, tag);
      if (pocket !== c.pocket) continue;
      assert.equal(p.seed, c.seed, tag);
      assert.equal(p.variant, c.variant, tag);
      assert.equal(p.n, c.n, tag);
      assert.equal(p.exitAt, c.exitAt, tag);
      assert.equal(p.entryAt, c.entryAt, tag);
      assert.equal(p.settleAt, c.settleAt, tag);
      assert.equal(p.rampTo, c.rampTo, tag);
      assert.equal(ballSum(p), c.ball, tag + " ball path checksum");
      for (const want of c.samples) {
        const got = sample(p, want[0] + c.landAt);
        got.forEach((x, i) => assert.ok(Math.abs(x - want[i]) < 1e-9, `${tag} sample ${want[0]} [${i}] ${x} != ${want[i]}`));
        if (got[5] === 4) assert.equal(W.pocketAt(got[1], got[3]), pocket, tag + " settled sample");
      }
    }
  }
});

test("deterministic across runs and callers; frame() is a pure function of server time (late joiners)", () => {
  const args = { tableId: "77aa88bb99", round: 5, pocket: 0, startedAt: BASE + 3, landAt: BASE + 12003 };
  const a = W.plan(args);
  W._clearCache();
  const b = W.plan(args);
  assert.notEqual(a, b);
  assert.deepEqual(Buffer.from(a.frames.buffer), Buffer.from(b.frames.buffer));
  // a viewer arriving mid-spin samples the same frame as one who watched from the start
  const mid = args.landAt - 2345;
  const watched = [];
  for (let t = a.t0; t <= mid; t += 16.7) watched.push(W.frame(a, t));
  assert.deepEqual(W.frame(a, mid), W.frame(b, mid));
  const out = {};
  assert.equal(W.frame(a, mid, out), out, "frame() can reuse an object (no allocation per paint)");
  // frames are 60 Hz from t0
  assert.equal(a.fps, 60);
  assert.equal(a.frames.length, a.n * 4);
  assert.ok(a.t0 + (a.n - 1) * (1000 / 60) >= a.settleAt);
  // the plan cache holds a few spins (a lobby or a dock shows several wheels): alternating between them builds nothing new
  W._clearCache();
  const tables = ["aa", "bb", "cc", "dd"].map((id, i) => ({ tableId: id, round: 3, pocket: i, startedAt: BASE, landAt: BASE + 12000 }));
  const first = tables.map((x) => W.plan(x)), built = W._builds();
  for (let i = 0; i < 40; i++) assert.equal(W.plan(tables[i % 4]), first[i % 4]);
  assert.equal(W._builds(), built, "no rebuild while polls alternate between four tables");
});

test("idle rotor: a function of server time only, one turn per IDLE_PERIOD_MS", () => {
  for (const t of [0, 1, 1499, BASE, BASE + 1234, BASE + 2999]) {
    const a = W.idleAngle(t);
    assert.ok(a >= 0 && a < TAU);
    assert.equal(W.idleAngle(t + W.IDLE_PERIOD_MS), a);
  }
  assert.ok(Math.abs(W.idleAngle(BASE + W.IDLE_PERIOD_MS / 4) - norm(W.idleAngle(BASE) + TAU / 4)) < 1e-9);
  const f = W.frame(null, BASE + 10);
  assert.equal(f.phase, "idle");
  assert.equal(f.visible, false);
  assert.equal(f.rotor, W.idleAngle(BASE + 10));
});

test("odd spin lengths and inputs still land exactly", () => {
  const cases = [
    [2000, "a 2 s spin is shown as a 4 s one already under way"],
    [400, "very short"],
    [0, "no time at all"],
    [-500, "land_at before start (clock trouble)"],
    [30000, "long"],
    [90000, "very long: the ball waits in the croupier's hand"],
  ];
  for (const [D, why] of cases)
    for (const pocket of [0, 17, 26, 36]) {
      const startedAt = BASE + 77, landAt = startedAt + D;
      const p = W.plan({ tableId: "edge", round: D, pocket, startedAt, landAt });
      assert.ok(p.settleAt <= landAt - W.LEAD_MS + 1e-6, why);
      assert.ok(p.t0 >= landAt - 30000 && p.t0 <= landAt - 4000, why);
      const f = W.frame(p, landAt);
      assert.equal(W.pocketAt(f.rotor, f.theta), pocket, why);
    }
  // no start time: 12 s before land_at
  const p = W.plan({ tableId: "x", round: 1, pocket: 9, landAt: BASE + 20000 });
  assert.equal(p.startedAt, BASE + 8000);
  assert.throws(() => W.plan({ tableId: "x", round: 1, pocket: 37, startedAt: BASE, landAt: BASE + 8000 }), TypeError);
  assert.throws(() => W.plan({ tableId: "x", round: 1, pocket: 1.5, startedAt: BASE, landAt: BASE + 8000 }), TypeError);
  assert.throws(() => W.plan({ tableId: "x", round: 1, pocket: 3, startedAt: BASE }), TypeError);
});

test("spinArgs reads every shape a consumer has: table view, OBS payload, cz:rl-spin detail, plan args", () => {
  const view = { id: "ab12cd34ef", spin: { round_no: 7, number: 17, color: "black", ends_at: BASE + 12000, started_at: BASE, secs: 12 } };
  assert.deepEqual(W.spinArgs(view), { tableId: "ab12cd34ef", round: "7", pocket: 17, startedAt: BASE, landAt: BASE + 12000 });
  // an older server: no started_at -> land_at minus the spin length (spin.secs, rules.spin_secs, the limits() settings
  // snapshot's rl_spin_secs, else D6's 12 s - the same default plan() takes, so both paths draw the same spin)
  const old = { id: "ab12cd34ef", rules: { spin_secs: 10 }, spin: { round_no: 7, number: 17, color: "black", ends_at: BASE + 12000 } };
  assert.equal(W.spinArgs(old).startedAt, BASE + 2000);
  delete old.rules;
  old.limits = { rl_min_bet: 100, rl_spin_secs: 9, rl_bet_secs: 25 }; //   casino/roulette.js limits(): the rl_* settings
  assert.equal(W.spinArgs(old).startedAt, BASE + 3000);
  delete old.limits;
  assert.equal(W.spinArgs(old).startedAt, BASE + 12000 - W.DEFAULT_SPIN_MS);
  assert.equal(W.DEFAULT_SPIN_MS, 12000);
  assert.equal(W.spinArgs(old).startedAt, W.plan({ tableId: "ab12cd34ef", round: 7, pocket: 17, landAt: BASE + 12000 }).startedAt);
  // an OBS v2 payload's limits.spin is the per-spin bet cap (PAT), never a time
  const capOnly = { action: "state", v: 2, table_id: "ab12cd34ef", round_no: 7, phase: "spinning", land_at: BASE + 12000, number: 17, limits: { min: 100, straight: 2500, outside: 50000, spin: 100000 } };
  assert.equal(W.spinArgs(capOnly).startedAt, BASE + 12000 - W.DEFAULT_SPIN_MS);
  const obs = { action: "state", v: 2, table_id: "ab12cd34ef", round_no: 7, phase: "spinning", started_at: BASE, land_at: BASE + 12000, number: 17, skew_ms: 40 };
  assert.deepEqual(W.spinArgs(obs), { tableId: "ab12cd34ef", round: "7", pocket: 17, startedAt: BASE, landAt: BASE + 12000 });
  const ev = { table: "ab12cd34ef", round: 7, pocket: 17, startedAt: BASE, landAt: BASE + 12000 };
  assert.deepEqual(W.spinArgs(ev), { tableId: "ab12cd34ef", round: "7", pocket: 17, startedAt: BASE, landAt: BASE + 12000 });
  assert.deepEqual(W.spinArgs({ table: view }), W.spinArgs(view), "a whole GET /api/casino/t/:id answer");
  // nothing to show yet: no pocket, no land time
  assert.equal(W.spinArgs({ id: "x", spin: null }), null);
  assert.equal(W.spinArgs({ id: "x", spin: { round_no: 1, number: 40, ends_at: BASE } }), null);
  assert.equal(W.spinArgs(null), null);
  // only a live spin: a betting / result view or payload never replays one
  assert.equal(W.spinArgs({ ...obs, phase: "result" }), null);
  assert.equal(W.spinArgs({ ...view, phase: "betting" }), null);
  assert.ok(W.spinArgs({ ...view, phase: "spinning" }));
});

// ── mount(): the browser build in a vm with a fake window, document and 2D context ──
// raf: false = no requestAnimationFrame (the setTimeout fallback); observers: a ResizeObserver like every target browser
function browser({ reduced = false, css = 320, dpr = 3, raf = true, observers = true } = {}) {
  let clock = BASE;
  const frames = [], timers = [], made = [], cleared = [], winL = {}, media = {};
  const gradient = () => ({ addColorStop() {} });
  function context(owner) {
    const calls = [];
    const state = { calls, owner, paints: 0 };
    const ctx = new Proxy(state, {
      get(target, key) {
        if (key in target) return target[key];
        if (key === "createRadialGradient" || key === "createLinearGradient") return gradient;
        return (...args) => {
          if (key === "clearRect") (calls.length = 0), state.paints++; //   keep one paint's calls (last() reads from the last clearRect)
          calls.push([key, ...args]);
        };
      },
      set(target, key, value) { calls.push(["set:" + String(key), value]); return true; },
    });
    return ctx;
  }
  function canvasEl(width = 0) {
    const el = { nodeType: 1, width, height: width, clientWidth: 0, style: {}, attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; } };
    el.ctx = context(el);
    el.getContext = () => el.ctx;
    return el;
  }
  const doc = { createElement: () => { const c = canvasEl(); made.push(c); return c; } };
  // one MediaQueryList per query, with its listeners (prefers-reduced-motion, the resolution watch)
  const matchMedia = (q) => (media[q] = media[q] || { query: q, matches: /reduced-motion/.test(q) ? reduced : false, ls: [],
    addEventListener(type, fn) { this.ls.push(fn); }, removeEventListener(type, fn) { this.ls = this.ls.filter((f) => f !== fn); } });
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  let ids = 0;
  const g = {
    Date: { now: () => clock },
    devicePixelRatio: dpr,
    document: doc,
    matchMedia,
    cancelAnimationFrame: () => {},
    // animation frames and timers count from 1 on separate counters, like a browser's
    setTimeout: (fn, ms) => { timers.push([clock + ms, fn, ++ids]); return ids; },
    clearTimeout: (id) => { cleared.push(id); for (let i = timers.length - 1; i >= 0; i--) if (timers[i][2] === id) timers.splice(i, 1); },
    addEventListener: (type, fn) => { (winL[type] = winL[type] || []).push(fn); },
    removeEventListener: (type, fn) => { winL[type] = (winL[type] || []).filter((f) => f !== fn); },
    Math, Object, String, Number, Array, Float32Array, Float64Array, Buffer, isFinite, TypeError, Infinity, Proxy,
  };
  let rafIds = 0;
  if (raf) g.requestAnimationFrame = (fn) => { frames.push(fn); return ++rafIds; };
  if (observers) g.ResizeObserver = class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} };
  g.window = g;
  g.self = g;
  const ctx = vm.createContext(g);
  vm.runInContext(SRC, ctx);
  const cv = canvasEl();
  cv.clientWidth = css;
  cv.ownerDocument = doc;
  const B = {
    W: ctx.PATVRlWheel, cv, made, mq, media, winL, cleared, g,
    set(t) { clock = t; },
    get now() { return clock; },
    get pendingRaf() { return frames.length ? rafIds : 0; },
    get paints() { return cv.ctx.paints; },
    // run animation frames until (server) time t, 16 ms apart
    run(t, step = 16) {
      while (clock < t) {
        clock = Math.min(t, clock + step);
        const fs = frames.splice(0);
        fs.forEach((fn) => fn(clock));
        for (const tm of timers.splice(0)) if (tm[0] <= clock) tm[1](); else timers.push(tm);
      }
    },
    // the last rotor angle and ball drawn on the main canvas: {rotor, ball: {x, y, w, h, alpha} | null, shadow, streak, ghosts}
    last() {
      const paint = cv.ctx.calls, set = Math.floor((made.length - 1) / 5) * 5, ballCv = made[set + 3], shadowCv = made[set + 4];
      const rot = paint.find((c) => c[0] === "rotate");
      const balls = paint.filter((c) => c[0] === "drawImage" && c[1] === ballCv && c.length === 6);
      const b = balls.length ? balls[balls.length - 1] : null;
      const alpha = b ? [...paint.slice(0, paint.indexOf(b))].reverse().find((c) => c[0] === "set:globalAlpha") : null;
      const sh = paint.filter((c) => c[0] === "drawImage" && c[1] === shadowCv).pop();
      return {
        rotor: rot ? rot[1] : null,
        ball: b ? { x: b[2] + b[4] / 2, y: b[3] + b[5] / 2, w: b[4], h: b[5], alpha: alpha ? alpha[1] : 1 } : null,
        shadow: sh ? { x: sh[2] + (sh.length === 6 ? sh[4] : shadowCv.width) / 2, y: sh[3] + (sh.length === 6 ? sh[5] : shadowCv.height) / 2 } : null,
        streak: paint.filter((c) => c[0] === "fill").length, //   the motion-blur band (the only fill on the main canvas)
        ghosts: paint.filter((c) => c[0] === "drawImage" && c[1] === ballCv && c.length === 4).length,
      };
    },
    // the drawn rotor's speed over the next frames, in multiples of the idle speed: {peak, min}
    rotorSpeeds(until, step = 16) {
      let prev = B.last().rotor, peak = 0, min = Infinity;
      for (let t = B.now + step; t <= until; t += step) {
        B.run(t, step);
        const r = B.last().rotor;
        let d = r - prev;
        if (d < -Math.PI) d += TAU;
        else if (d > Math.PI) d -= TAU;
        prev = r;
        const x = d / (step / 1000) / W.OMEGA;
        peak = Math.max(peak, x);
        min = Math.min(min, x);
      }
      return { peak, min };
    },
  };
  return B;
}
// the pocket under a drawn ball (canvas pixels), given the rotor angle that was drawn
function drawnPocket(B, d) {
  const c = B.cv.width / 2, theta = Math.atan2(d.ball.x - c, -(d.ball.y - c));
  return W.pocketAt(d.rotor, norm(theta));
}

test("mount: draws a top-down wheel by server time, DPR capped at 2, role=img with a phase label", () => {
  const B = browser({ css: 320, dpr: 3 });
  const m = B.W.mount(B.cv, {});
  assert.equal(B.cv.width, 640, "320 css px x min(3, 2)");
  assert.equal(B.cv.attrs.role, "img");
  assert.equal(B.cv.attrs["aria-label"], "Roulette wheel");
  assert.equal(B.made.length, 5, "stator, rotor, light, ball and shadow layers drawn once");
  B.run(BASE + 500);
  let d = B.last();
  assert.equal(d.ball, null, "no ball while bets are open");
  assert.ok(Math.abs(d.rotor - W.idleAngle(B.now)) < 1e-9, "the idle rotor is the server-time angle");
  m.setSkew(-2000); //                                              the server is 2 s ahead of this clock
  B.run(B.now + 16);
  assert.ok(Math.abs(B.last().rotor - W.idleAngle(B.now + 2000)) < 1e-9);
  m.setSkew(0);
  // a spin: the ball appears on the track and the label follows
  const view = { id: "ab12cd34ef", spin: { round_no: 7, number: 17, ends_at: B.now + 12000, started_at: B.now, secs: 12 } };
  const p = m.spin(view);
  assert.equal(B.cv.attrs["aria-label"], "Roulette wheel: the ball is spinning");
  B.run(B.now + 800);
  d = B.last();
  assert.ok(d.ball && d.ball.alpha > 0.99);
  assert.equal(d.streak, 1, "one motion-blur streak at speed");
  assert.equal(d.ghosts, 0, "not a row of ghost balls");
  // after the settle the drawn ball sits in pocket 17, and the drawn rotor matches the plan's
  B.run(p.settleAt + 50);
  d = B.last();
  assert.equal(drawnPocket(B, d), 17);
  assert.ok(Math.abs(norm(d.rotor - W.frame(p, B.now).rotor)) < 1e-9 || Math.abs(norm(d.rotor - W.frame(p, B.now).rotor) - TAU) < 1e-9);
  assert.equal(d.streak, 0);
  m.rest(17);
  assert.equal(B.cv.attrs["aria-label"], "Roulette wheel: the ball landed on 17 black");
  B.run(B.now + 3000);
  assert.equal(drawnPocket(B, B.last()), 17, "it rides the rotor in its pocket");
  // bets open again: the ball fades out, the rotor eases back to the plain server-time angle (slowly: BACK_MS)
  m.idle();
  B.run(B.now + 350 + W.BACK_MS + 50);
  d = B.last();
  assert.equal(d.ball, null);
  const back = norm(d.rotor - W.idleAngle(B.now));
  assert.ok(back < 1e-9 || TAU - back < 1e-9, "shift back to zero");
  assert.equal(B.cv.attrs["aria-label"], "Roulette wheel");
  m.destroy();
});

test("mount: the same spin every poll doesn't restart; a late view catches up on the track; the rotor never jumps", () => {
  const B = browser();
  const m = B.W.mount(B.cv, {});
  B.run(BASE + 300);
  const start = B.now;
  const view = { table_id: "c0ffee0001", round_no: 12, number: 0, started_at: start, land_at: start + 12000 };
  B.run(start + 1100); //                     the poll brought it 1.1 s late (the idle wheel kept turning meanwhile)
  const p = m.spin(view);
  let prev = null, maxStep = 0;
  for (let t = B.now; t < p.landAt + 500; t += 16) {
    B.run(t);
    if (t % 1000 < 16) {
      // the same spin again (every poll): no plan() call at all, even with the module's plan cache gone (another wheel
      // on the page filled it)
      B.W._clearCache();
      const built = B.W._builds();
      assert.equal(m.spin(view), p, "the same spin again");
      assert.equal(B.W._builds(), built, "a repeated poll builds no plan");
    }
    const d = B.last();
    if (prev !== null) {
      let step = d.rotor - prev;
      if (step < -Math.PI) step += TAU;
      maxStep = Math.max(maxStep, Math.abs(step));
      assert.ok(step > 0, "the rotor never runs backwards");
    }
    prev = d.rotor;
  }
  // the catch-up flick ends with the plan's own: at most 3x the idle speed (one 16 ms frame at 3x idle = 0.1 rad)
  assert.ok(maxStep <= 3 * W.OMEGA * 0.016, "a gentle catch-up, " + (maxStep / (W.OMEGA * 0.016)).toFixed(2) + "x idle");
  assert.equal(drawnPocket(B, B.last()), 0);
  assert.equal(m.state().phase, "settled");
  m.destroy();
});

test("mount: late viewers (a 1 Hz poll) see the same gentle flick - never a whip, never a slow-down; very late ones a placed rotor", () => {
  for (const D of [8000, 12000, 20000])
    for (const late of [0, 50, 100, 300, 600, 1000, 1400])
      for (const pocket of [0, 9, 18, 27, 36]) {
        const B = browser({ dpr: 1 }), m = B.W.mount(B.cv, {});
        B.run(BASE + 300 + pocket * 13);
        const start = B.now;
        B.run(start + late);
        const p = m.spin({ tableId: "1a7e" + D, round: pocket, pocket, startedAt: start, landAt: start + D }), tag = `D=${D} late ${late} pocket ${pocket}`;
        const v = B.rotorSpeeds(p.exitAt);
        assert.ok(v.peak <= 3, tag + " peak " + v.peak.toFixed(2) + "x idle");
        assert.ok(v.min >= 0.99, tag + " slowest " + v.min.toFixed(2) + "x idle (a flick only coasts down)");
        B.run(p.landAt + 20);
        assert.equal(drawnPocket(B, B.last()), pocket, tag);
      }
  // the shortest spin, and a page opened close to the drop: still exact (a placed rotor behind the ball's fade-in)
  for (const [D, late] of [[4000, 0], [4000, 700], [4000, 1100], [12000, 8800], [12000, 9300]]) {
    const B = browser({ dpr: 1 }), m = B.W.mount(B.cv, {});
    B.run(BASE + 300);
    const start = B.now;
    B.run(start + late);
    const p = m.spin({ tableId: "edge", round: late, pocket: 23, startedAt: start, landAt: start + D });
    assert.ok(B.rotorSpeeds(p.exitAt).min >= 0.99 || late > 0, "an on-time 4 s spin flicks forward too");
    B.run(p.landAt + 20);
    assert.equal(drawnPocket(B, B.last()), 23, `D=${D} late ${late}`);
  }
});

test("mount: after the result the rotor eases back to the server-time angle within ~0.7x-1.3x of idle (no lurch)", () => {
  for (const pocket of [0, 4, 11, 19, 26, 33, 36]) {
    const B = browser({ dpr: 1 }), m = B.W.mount(B.cv, {});
    B.run(BASE + 300);
    const start = B.now, p = m.spin({ tableId: "ba5e", round: pocket, pocket, startedAt: start, landAt: start + 12000 });
    B.run(p.landAt);
    m.rest(pocket);
    B.run(p.landAt + 4000);
    m.idle();
    const v = B.rotorSpeeds(B.now + 350 + W.BACK_MS + 100);
    assert.ok(v.peak <= 1.35 && v.min >= 0.65, `pocket ${pocket}: ${v.min.toFixed(2)}x-${v.peak.toFixed(2)}x idle`);
    const back = norm(B.last().rotor - W.idleAngle(B.now));
    assert.ok(Math.min(back, TAU - back) < 1e-9, "every screen shows the same idle wheel again");
  }
});

test("mount: poll-to-poll skew jitter is slewed in (the ball never jumps); a big correction applies at once", () => {
  const B = browser();
  const m = B.W.mount(B.cv, {});
  m.setSkew(0);
  B.run(BASE + 200);
  const start = B.now;
  const p = m.spin({ tableId: "5ca1ab1e00", round: 6, pocket: 14, startedAt: start, landAt: start + 12000 });
  B.run(start + 1500); //                                             the ball is flying round the track
  const shown = () => {
    const d = B.last(), c = B.cv.width / 2;
    return norm(Math.atan2(d.ball.x - c, -(d.ball.y - c)));
  };
  let prev = shown(), maxStep = 0;
  const jitter = [35, -20, 60, 10, -45, 25];
  for (let i = 0; i < 60; i++) {
    if (i % 10 === 0) m.setSkew(jitter[i / 10]); //                a new measurement every poll
    B.run(B.now + 16);
    const a = shown();
    const step = Math.min(norm(a - prev), norm(prev - a));
    maxStep = Math.max(maxStep, step);
    prev = a;
  }
  // the ball runs at up to ~19 rad/s here: one 16 ms frame is ~0.3 rad; a jump of 60 ms would be ~1.1 rad
  assert.ok(maxStep < 0.42, "no jump: " + maxStep.toFixed(3));
  B.run(B.now + 2000);
  m.setSkew(25);
  B.run(B.now + 1500);
  assert.ok(Math.abs(B.last().rotor - norm(W.frame(p, B.now - 25).rotor)) < 1e-6, "converges on the measured skew");
  m.setSkew(-5000); //                                                 a real clock change: applied at once
  B.run(B.now + 16);
  assert.ok(Math.abs(norm(B.last().rotor - W.frame(p, B.now + 5000).rotor)) < 1e-6 || Math.abs(norm(B.last().rotor - W.frame(p, B.now + 5000).rotor) - TAU) < 1e-6);
  m.destroy();
});

test("mount: the result arriving early finishes within 300 ms; a different pocket from the server wins at once", () => {
  const B = browser();
  const m = B.W.mount(B.cv, {});
  const start = BASE + 50;
  B.run(start);
  const p = m.spin({ tableId: "beefbeef01", round: 3, pocket: 26, startedAt: start, landAt: start + 8000 });
  B.run(p.entryAt + 100); //                                          mid-hops
  m.rest(26);
  B.run(B.now + 320);
  assert.equal(m.state().phase, "settled");
  assert.equal(drawnPocket(B, B.last()), 26);
  // the server says otherwise (it can't by construction - but the server wins)
  const q = m.spin({ tableId: "beefbeef01", round: 4, pocket: 5, startedAt: B.now, landAt: B.now + 8000 });
  B.run(q.exitAt + 200);
  m.rest(11);
  B.run(B.now + 20);
  assert.equal(drawnPocket(B, B.last()), 11);
  assert.equal(m.state().pocket, 11);
  // a page opened on the result: no plan, the ball just sits there
  const C = browser();
  const n = C.W.mount(C.cv, {});
  n.rest(32);
  C.run(C.now + 400);
  assert.equal(drawnPocket(C, C.last()), 32);
  m.destroy();
  n.destroy();
});

test("mount: reduced motion - a still wheel, the ball fades into the pocket at land_at", () => {
  const B = browser({ reduced: true });
  const m = B.W.mount(B.cv, {});
  B.run(BASE + 100);
  assert.equal(B.last().rotor, 0, "no idle motion");
  const start = B.now;
  const p = m.spin({ tableId: "deaf000001", round: 8, pocket: 19, startedAt: start, landAt: start + 12000 });
  B.run(p.exitAt + 500);
  B.cv.ctx.calls.length = 0;
  m.paint();
  assert.equal(B.last().ball, null, "nothing moves during the spin");
  assert.equal(B.last().rotor, 0);
  B.run(p.landAt + 600);
  m.paint();
  const d = B.last();
  assert.equal(d.rotor, 0);
  assert.equal(drawnPocket(B, d), 19);
  assert.equal(d.ghosts, 0);
  // the Quick spin toggle flips it at runtime
  m.setReduced(false);
  m.paint();
  assert.notEqual(B.last().rotor, 0);
  m.destroy();
});

test("mount: reduced motion sleeps - it repaints around land_at only, not 60 times a second for a shift nobody sees", () => {
  const B = browser({ reduced: true });
  const m = B.W.mount(B.cv, {});
  B.run(BASE + 300);
  const start = B.now, p = m.spin({ tableId: "deaf000002", round: 1, pocket: 5, startedAt: start, landAt: start + 12000 });
  const a = B.paints;
  B.run(p.landAt - 50);
  const during = B.paints - a;
  m.rest(5);
  B.run(p.landAt + 4000);
  const after = B.paints - a - during;
  assert.ok(during <= 20, "repaints during a 12 s spin: " + during);
  assert.ok(after <= 45, "repaints over the land_at fade and a 4 s result: " + after);
  assert.equal(drawnPocket(B, B.last()), 5);
  // Quick spin switched on while the rotor eases back after a result: the wheel goes still and sleeps
  const C = browser();
  const n = C.W.mount(C.cv, {});
  C.run(BASE + 300);
  const s2 = C.now, q = n.spin({ tableId: "deaf000003", round: 2, pocket: 9, startedAt: s2, landAt: s2 + 12000 });
  C.run(q.landAt);
  n.rest(9);
  C.run(q.landAt + 4000);
  n.idle();
  C.run(C.now + 500);
  n.setReduced(true);
  const b = C.paints;
  C.run(C.now + 10000);
  assert.ok(C.paints - b <= 3, "repaints over 10 s of Quick spin: " + (C.paints - b));
  n.setReduced(false); //                                            back on: it turns at the server-time angle again
  C.run(C.now + 32);
  const back = norm(C.last().rotor - W.idleAngle(C.now));
  assert.ok(Math.min(back, TAU - back) < 1e-9);
  m.destroy();
  n.destroy();
});

test("mount: sound cues in order while watching, none from a background tab catching up", () => {
  const B = browser();
  const seen = [];
  const m = B.W.mount(B.cv, { onEvent: (type) => seen.push(type) });
  B.run(BASE + 100);
  const start = B.now;
  const p = m.spin({ tableId: "f00d000001", round: 2, pocket: 7, startedAt: start, landAt: start + 8000 });
  B.run(p.landAt);
  const order = seen.filter((e) => e !== "hop" && e !== "diamond");
  assert.deepEqual(order, ["launch", "drop", "rotor", "settle"]);
  assert.ok(seen.includes("hop"));
  m.destroy();
  // a hidden tab: frames stop, then one paint long after - no burst of stale cues
  const C = browser();
  const late = [];
  const n = C.W.mount(C.cv, { onEvent: (type) => late.push(type) });
  C.run(BASE + 100);
  n.spin({ tableId: "f00d000001", round: 2, pocket: 7, startedAt: C.now, landAt: C.now + 8000 });
  C.run(C.now + 32);
  C.set(C.now + 7000);
  C.run(C.now + 16);
  assert.deepEqual(late.filter((e) => e !== "launch"), []);
  n.destroy();
});

test("mount: tilt, palettes, compact mini wheel, and no crash without a canvas context", () => {
  const B = browser({ css: 140, dpr: 2 });
  const m = B.W.mount(B.cv, { compact: true, tilt: 40, palette: "hr" });
  assert.match(B.cv.style.transform, /perspective\(\d+px\) rotateX\(40deg\)/);
  B.run(BASE + 50);
  m.setTilt(0);
  assert.equal(B.cv.style.transform, "");
  const p = m.spin({ tableId: "aa", round: 1, pocket: 4, startedAt: B.now, landAt: B.now + 6000 });
  B.run(B.now + 400);
  assert.equal(B.last().ghosts + B.last().streak, 0, "the mini wheel draws no speed streak");
  m.setPalette({ red: "#ff0000" });
  B.run(p.landAt);
  assert.equal(drawnPocket(B, B.last()), 4);
  m.destroy();
  const none = W.mount({ getContext: () => null }, {});
  for (const k of ["setSkew", "idle", "spin", "rest", "destroy", "setReduced", "setTilt", "setPalette", "state"]) assert.equal(typeof none[k], "function");
  none.spin({ tableId: "a", round: 1, pocket: 2, startedAt: BASE, landAt: BASE + 8000 });
  none.rest(2);
  none.destroy();
});

// the highest hop on the rotor in a plan: {t, z}
function hopPeak(p) {
  let best = { t: 0, z: 0 };
  for (let i = 0; i < p.n; i++) {
    const t = p.t0 + (i * 1000) / 60;
    if (t > p.entryAt && t < p.settleAt && p.frames[i * 4 + 3] > best.z) best = { t, z: p.frames[i * 4 + 3] };
  }
  return best;
}

test("mount: a hop shows top-down - the shadow slides away from the ball by about its height (phones)", () => {
  let checked = 0;
  for (let round = 1; round <= 30 && checked < 5; round++) {
    const B = browser({ css: 320, dpr: 2 }); //                   a phone: top-down, 640 device px
    const m = B.W.mount(B.cv, {});
    B.run(BASE + 100);
    const start = B.now, p = m.spin({ tableId: "4097", round, pocket: round % 37, startedAt: start, landAt: start + 12000 });
    const peak = hopPeak(p);
    if (peak.z < 0.04) continue;
    checked++;
    B.run(peak.t - 8);
    m.paint(peak.t);
    const d = B.last(), R = (B.cv.width / 2) * 0.975, br = R * W.GEOM.ball;
    const dx = d.shadow.x - d.ball.x, dy = d.shadow.y - d.ball.y;
    assert.ok(dx >= 0.8 * peak.z * R && dy >= 0.8 * peak.z * R, `the shadow moved ${(dx / br).toFixed(2)} ball radii at z = ${peak.z.toFixed(3)}`);
    assert.ok(dx >= br, "at least a ball radius at the top of a real hop");
    m.destroy();
  }
  assert.ok(checked >= 3, "found hops to look at: " + checked);
});

test("mount: under the desktop tilt the ball stays round (its sprite is pre-stretched by 1/cos(tilt)); the shadow lies flat", () => {
  for (const tilt of [0, 38, 40]) {
    const B = browser({ css: 460, dpr: 1 });
    const m = B.W.mount(B.cv, { tilt });
    B.run(BASE + 100);
    const p = m.spin({ tableId: "711", round: tilt, pocket: 8, startedAt: B.now, landAt: B.now + 12000 });
    B.run(p.settleAt + 100);
    const d = B.last(), want = tilt ? 1 / Math.cos((tilt * Math.PI) / 180) : 1;
    assert.ok(Math.abs(d.ball.h / d.ball.w - want) < 1e-9, `tilt ${tilt}: ${d.ball.h / d.ball.w}`);
    assert.ok(Math.abs(d.shadow.y - d.shadow.x - (d.ball.y - d.ball.x)) < 1e-6, "the shadow is offset equally across and down (not stretched)");
    assert.equal(drawnPocket(B, d), 8, "the stretch keeps the ball's centre");
    m.destroy();
  }
});

test("mount: the speed streak is one tapered band that fades toward the tail, only at speed", () => {
  const B = browser({ css: 320, dpr: 2 });
  const m = B.W.mount(B.cv, {});
  B.run(BASE + 100);
  const start = B.now, p = m.spin({ tableId: "5717", round: 2, pocket: 30, startedAt: start, landAt: start + 12000 });
  B.run(start + 1500); //                                          on the backtrack at speed
  const d = B.last(), paint = B.cv.ctx.calls;
  assert.equal(d.streak, 1);
  assert.equal(d.ghosts, 0, "no separate ghost balls");
  const fillAt = paint.findIndex((c) => c[0] === "fill"), ballAt = paint.findIndex((c) => c[0] === "drawImage" && c.length === 6 && c[4] === d.ball.w);
  assert.ok(fillAt >= 0 && fillAt < ballAt, "drawn under the ball");
  // the band's outline: about a ball wide at the head, a point at the tail
  const pts = paint.slice(paint.findIndex((c) => c[0] === "beginPath"), fillAt).filter((c) => c[0] === "moveTo" || c[0] === "lineTo");
  assert.ok(pts.length >= 6, "a polygon along the path: " + pts.length);
  const R = (B.cv.width / 2) * 0.975, br = R * W.GEOM.ball, head = Math.hypot(pts[0][1] - pts[pts.length - 1][1], pts[0][2] - pts[pts.length - 1][2]);
  assert.ok(head > 1.5 * br && head < 2.2 * br, "head width " + (head / br).toFixed(2) + " ball radii");
  const mid = pts.length / 2, tail = Math.hypot(pts[mid - 1][1] - pts[mid][1], pts[mid - 1][2] - pts[mid][2]);
  assert.ok(tail < 1e-6, "a point at the tail");
  B.run(p.settleAt + 50);
  assert.equal(B.last().streak, 0, "none once the ball sits still");
  m.destroy();
});

test("mount: a new pixel ratio (zoom, another monitor) redraws the layers at the new resolution", () => {
  const B = browser({ css: 300, dpr: 1 }); //                       a ResizeObserver is there, like every target browser
  const m = B.W.mount(B.cv, {});
  B.run(BASE + 50);
  assert.equal(B.cv.width, 300);
  const q1 = Object.keys(B.media).find((q) => /resolution/.test(q));
  assert.ok(q1, "watches the pixel ratio");
  B.g.devicePixelRatio = 2; //                                     moved to a 2x screen: the CSS box is unchanged
  B.media[q1].ls.slice().forEach((fn) => fn({ matches: false }));
  B.run(B.now + 32);
  assert.equal(B.cv.width, 600, "redrawn at 2x");
  assert.equal(B.media[q1].ls.length, 0, "the old query is released");
  const q2 = Object.keys(B.media).find((q) => /resolution/.test(q) && q !== q1);
  assert.ok(q2 && B.media[q2].ls.length === 1, "and the new ratio is watched");
  B.g.devicePixelRatio = 1.5; //                                   browser zoom also fires window resize
  (B.winL.resize || []).forEach((fn) => fn());
  B.run(B.now + 32);
  assert.equal(B.cv.width, 450);
  const made = B.made.length;
  (B.winL.resize || []).forEach((fn) => fn()); //                  nothing changed: no redraw
  B.run(B.now + 32);
  assert.equal(B.made.length, made);
  m.destroy();
  assert.equal((B.winL.resize || []).length, 0, "destroy() unhooks the resize listener");
  assert.ok(Object.values(B.media).every((x) => /reduced-motion/.test(x.query) || x.ls.length === 0), "and the pixel-ratio watch");
  // a detached canvas (thumbnails) keeps its size across relayouts
  const C = browser({ css: 0, dpr: 2 });
  C.cv.width = 200;
  C.cv.height = 200;
  const n = C.W.mount(C.cv, {});
  n.paint(BASE);
  const w = C.cv.width;
  n.setPalette("hr");
  n.paint(BASE + 16);
  n.setPalette("classic");
  n.paint(BASE + 32);
  assert.equal(C.cv.width, w, "no growth on relayout");
  n.destroy();
});

test("mount: destroy() cancels an animation frame with cancelAnimationFrame only (never clearTimeout with its id)", () => {
  const B = browser();
  const m = B.W.mount(B.cv, {});
  B.run(BASE + 100);
  m.spin({ tableId: "de57", round: 1, pocket: 3, startedAt: B.now, landAt: B.now + 8000 });
  B.run(B.now + 200);
  const raf = B.pendingRaf;
  assert.ok(raf > 0, "a frame is pending");
  B.cleared.length = 0;
  m.destroy();
  assert.ok(!B.cleared.includes(raf), "clearTimeout(" + raf + ") would cancel an unrelated page timer");
  // without requestAnimationFrame the fallback timer is cleared
  const C = browser({ raf: false });
  const n = C.W.mount(C.cv, {});
  n.spin({ tableId: "de57", round: 2, pocket: 3, startedAt: C.now, landAt: C.now + 8000 });
  C.run(C.now + 100);
  C.cleared.length = 0;
  n.destroy();
  assert.ok(C.cleared.length >= 1, "the fallback timer is cleared");
  const ticks = C.paints;
  C.run(C.now + 500);
  assert.equal(C.paints, ticks, "nothing runs after destroy()");
});

test("aria labels: English defaults equal locales/en.json, and a page's __t translates them", () => {
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const [k, v] of Object.entries(W.LABELS)) assert.equal(EN["js.casino." + k], v, k);
  const B = browser();
  const asked = [];
  B.W.mount(B.cv, { t: (k, d, v) => (asked.push(k), "[" + k + "]" + (v && v.n != null ? v.n : "")) }).rest(0);
  assert.equal(B.cv.attrs["aria-label"], "[rl_wheel_landed][rl_wheel_zero]0");
  assert.ok(asked.every((k) => k in W.LABELS));
});

test("served next to rlbets.js; the demo page uses only the public module", () => {
  const routes = fs.readFileSync(path.join(repo, "casino", "routes.js"), "utf8");
  assert.match(routes, /app\.get\("\/api\/casino\/rlwheel\.js", \(req, res\) => res\.type\("application\/javascript"\)\.sendFile\(path\.join\(__dirname, "rlwheel\.js"\)\)\);/);
  const html = fs.readFileSync(path.join(repo, "public", "rlwheel-demo.html"), "utf8");
  const srcs = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].split("?")[0]);
  assert.deepEqual(srcs, ["/api/casino/rlwheel.js", "/public/js/rlwheel-demo.js"]);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "rlwheel-demo.js"), "utf8");
  for (const bad of [/\bfetch\(/, /XMLHttpRequest/, /\/api\//, /localStorage/, /cookie/i]) assert.doesNotMatch(js, bad);
  // not linked from any page or view
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(repo, "views"))) assert.doesNotMatch(fs.readFileSync(f, "utf8"), /rlwheel-demo/, f);
});

test("plan() is cheap: well inside the 10 ms phone budget", () => {
  // Node on a desktop runs a plan in ~0.1-0.3 ms (about 1-3 ms with the JIT off); a phone's WebKit is within ~3-5x of that
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < 40; i++) for (const D of DURATIONS) { W.plan({ tableId: "perf", round: i, pocket: i % 37, startedAt: BASE + i, landAt: BASE + i + D }); n++; }
  const each = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  assert.ok(each < 2.5, `plan() took ${each.toFixed(2)} ms on average`);
  const p = W.plan({ tableId: "perf", round: 1, pocket: 1, startedAt: BASE, landAt: BASE + 12000 }), out = {};
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 20000; i++) W.frame(p, BASE + (i % 12000), out);
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 / 20000 < 0.02, "frame() is a lookup and a lerp");
});
