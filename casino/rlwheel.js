// Shared roulette wheel and ball (roulette v2, O11): one dependency-free module for the web table, the phone mini wheel and
// the OBS board. Served at GET /api/casino/rlwheel.js (casino/routes.js, next to rlbets.js); browser global PATVRlWheel,
// module.exports in Node (test/casino-rlwheel.test.js, golden vectors in test/fixtures/rlwheel_vectors.json).
//
// COSMETIC ONLY. The server decides the pocket (casino/roulette.js draw) and settles at land_at; this file only shows a ball
// that ends in that pocket. It never decides, delays or reveals anything: callers hand it the pocket only once the view
// reports phase 'spinning' (post-commit). Its random choreography is seeded from a PUBLIC value, FNV-1a(tableId + ':' +
// round_no) -> mulberry32, never from round.seed / next.seed or any fairness value.
//
// MODEL (top-down polar, unit wheel radius, fixed step DT = 1/240 s, semi-implicit Euler; the integrator uses + - * / and
// Math.sqrt only, so Node, Chrome, WebKit and OBS's CEF produce bit-identical plans; sin/cos only at render):
// - Rotor: turns at a constant OMEGA from absolute SERVER time (idleAngle), so every surface shows the same wheel with no state.
// - Ball: launched at the spin start on the backtrack (r = GEOM.track) against the rotor, decaying du/dt = -(c0 + c1 u^2);
//   below the critical speed it leaves the track and spirals down the cone (r'' = r w^2 - g, angular momentum L = r^2 w
//   decaying), bounces off the 8 stator diamonds (crossed geometrically), reaches the rotor, hops over frets, rattles and settles.
// - Fit: everything after the ball leaves the track (cone, diamonds, rotor, hops, settle) is simulated once from the public
//   seed in a canonical frame (exit angle and rotor phase seeded, a few seeded variants until its length suits D). The track
//   phase is then integrated BACKWARD from the exit state for exactly the time left, so the settle lands LEAD_MS before
//   land_at; the exit moment is moved earlier by < one pocket's worth of rotor time so the real rotor's phase at the exit
//   equals the canonical one (the rotor geometry repeats every pocket).
// - Exact landing (whole-pocket relabel): the ball settles in geometric slot s of the idle rotor; showing the rotor shifted by
//   k = (WHEEL.indexOf(pocket) - s) mod 37 whole pockets leaves every fret, hop and bounce unchanged and puts the server's
//   number under the ball. The shift ramps in only while the ball is still on the backtrack (it cannot touch the rotor),
//   which reads as the croupier's flick; the rotor never runs backwards.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PATVRlWheel = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var VERSION = 1;
  // European single-zero order (clockwise seen from above) - the same as casino/rlengine.js WHEEL; reds as casino/rlbets.js
  var WHEEL = Object.freeze([
    0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7,
    28, 12, 35, 3, 26,
  ]);
  var RED = Object.freeze([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  var N = 37,
    TAU = 6.283185307179586,
    PITCH = TAU / N,
    IDLE_PERIOD_MS = 3000, //       one rotor turn every 3 s (20 rpm), from absolute server time
    OMEGA = (TAU * 1000) / IDLE_PERIOD_MS, // rad/s, clockwise on screen (angles grow clockwise from 12 o'clock)
    POCKET_MS = IDLE_PERIOD_MS / N, // rotor time for one pocket (~81 ms): the exit moment moves by less than this
    DT = 1 / 240,
    SUB = 4, //                     integrator steps per 60 Hz frame
    FPS = 60,
    FRAME_MS = 1000 / FPS,
    LEAD_MS = 300, //               the ball is still by land_at - LEAD_MS (minus < POCKET_MS)
    SPAN_MIN = 4000, //             a shorter spin is planned as a 4 s one already under way (the ball is seen mid-track)
    SPAN_MAX = 30000, //            a longer one keeps the ball in the croupier's hand until 30 s before land_at
    FIT_MIN = 4000,
    FIT_MAX = 20000;
  var GEOM = Object.freeze({
    rim: 1, //        outer edge of the wooden bowl
    trackOut: 0.955, // outer wall of the ball track
    track: 0.92, //   ball centre while it runs on the backtrack
    trackIn: 0.885, // lip where the track meets the cone
    diamond: 0.8, //  the 8 stator diamonds
    rotor: 0.7, //    outer edge of the rotor (number ring starts)
    numIn: 0.61, //   number ring inner edge = pocket outer wall
    pocket: 0.555, // ball centre at rest in a pocket
    pocketIn: 0.5, // pocket inner wall (rotor cone starts)
    cone: 0.235, //   turret base
    ball: 0.029, //   ball radius
    fret: 0.004, //   fret half-thickness
  });
  // the 8 diamonds: at (i + 1/2) * 45 deg; even ones stand radial ("vertical"), odd ones lie tangential ("horizontal")
  var D_STEP = TAU / 8,
    D_FIRST = TAU / 16,
    D_LONG = 0.05,
    D_SHORT = 0.017;
  // physics constants (wheel radii, seconds, radians)
  var U_CRIT = 6.1, //   |w| below which the backtrack can't hold the ball (~0.97 rev/s)
    G_CONE = 36, //      slope gravity on the cone, inward (just above track * U_CRIT^2 = 34.2: the ball peels off gently)
    G_RING = 3, //       slope gravity on the rotor's number ring, inward
    G_Z = 24, //         gravity for hops (height z)
    K_POCKET = 900, //   pocket floor: radial spring to the rest radius...
    C_POCKET = 30, //    ...and its damping
    SETTLE_W = 22; //    settle spring (critically damped), rad/s
  // mount(): a re-measured server-clock skew within SKEW_JUMP_MS is slewed in at <= 5% clock speed (no visible jump)
  var SKEW_SLEW = 0.05,
    SKEW_JUMP_MS = 1500;

  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }
  function norm(a) {
    a = a % TAU;
    return a < 0 ? a + TAU : a;
  }
  function colorOf(n) {
    return n === 0 ? "zero" : RED.indexOf(n) >= 0 ? "red" : "black";
  }

  // ── public cosmetic seed: FNV-1a 32 over the UTF-8 bytes of tableId + ':' + round_no, then mulberry32 ──
  function fnv1a(str) {
    var h = 0x811c9dc5;
    str = String(str);
    function eat(b) {
      h ^= b;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
        var d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d < 0xe000) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c < 0x80) eat(c);
      else if (c < 0x800) {
        eat(0xc0 | (c >> 6));
        eat(0x80 | (c & 63));
      } else if (c < 0x10000) {
        eat(0xe0 | (c >> 12));
        eat(0x80 | ((c >> 6) & 63));
        eat(0x80 | (c & 63));
      } else {
        eat(0xf0 | (c >> 18));
        eat(0x80 | ((c >> 12) & 63));
        eat(0x80 | ((c >> 6) & 63));
        eat(0x80 | (c & 63));
      }
    }
    return h >>> 0;
  }
  function seedOf(tableId, round) {
    return fnv1a(String(tableId == null ? "" : tableId) + ":" + String(round == null ? "" : round));
  }
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function variantSeed(seed, v) {
    return fnv1a(seed + "/" + v);
  }

  /** The rotor's angle (rad, [0, 2pi)) at a server time: the same on every screen, no state. */
  function idleAngle(siteNowMs) {
    var m = siteNowMs % IDLE_PERIOD_MS;
    if (m < 0) m += IDLE_PERIOD_MS;
    return (m / IDLE_PERIOD_MS) * TAU;
  }
  // the rotor's position in pockets at a server time: [0, 37)
  function idlePockets(siteNowMs) {
    var m = siteNowMs % IDLE_PERIOD_MS;
    if (m < 0) m += IDLE_PERIOD_MS;
    return (m / IDLE_PERIOD_MS) * N;
  }
  function smooth(x) {
    return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
  }

  // ── the canonical after-track simulation: cone, diamonds, rotor, hops, rattle, settle ──
  // Time 0 = the ball leaves the track at world angle P.thetaE with speed U_CRIT; the rotor's angle then is P.rho (mod one
  // pocket). Writes r / theta (world, continuous) / z per step into rec; returns the step count, the phase steps and the slot.
  function postSim(rnd, P, rec, maxSteps) {
    var B = GEOM.ball,
      r = GEOM.track,
      vr = -0.06,
      th = P.thetaE,
      z = 0,
      vz = 0,
      L = r * r * -U_CRIT, // angular momentum per mass (ball runs counter-clockwise: negative)
      muL = P.muL,
      n = 0,
      cool = 0,
      hits = 0,
      hops = 0,
      rattles = 0,
      entry = -1,
      settleStep = -1,
      w,
      ar;
    rec.r[0] = r;
    rec.th[0] = th;
    rec.z[0] = z;
    var coneMax = Math.floor(P.coneMax / DT);
    // cone (stator frame)
    while (r > GEOM.rotor) {
      if (n >= coneMax) muL = muL * 1.02 + 0.02; //  a ball orbiting too long loses grip
      L = L * (1 - muL * DT);
      w = L / (r * r);
      ar = r * w * w - G_CONE;
      vr = (vr + ar * DT) * (1 - P.muR * DT);
      r = r + vr * DT;
      th = th + w * DT;
      if (r > GEOM.track) {
        r = GEOM.track; //               back up against the track wall (below its speed it can't run there again)
        if (vr > 0) vr = -0.3 * vr;
      }
      if (z > 0 || vz > 0) {
        vz = vz - G_Z * DT;
        z = z + vz * DT;
        if (z <= 0) {
          z = 0;
          vz = vz < -0.5 ? -0.32 * vz : 0;
        }
      }
      if (cool > 0) cool = cool - DT;
      else {
        var a = th - D_FIRST,
          kd = Math.floor(a / D_STEP + 0.5),
          da = a - kd * D_STEP,
          radial = (kd & 1) === 0,
          hr = (radial ? D_LONG : D_SHORT) + B,
          ht = (radial ? D_SHORT : D_LONG) + B,
          dr = r - GEOM.diamond;
        if (dr < hr && dr > -hr && da * r < ht && da * r > -ht) {
          hits++;
          cool = 0.16;
          var rough = rnd();
          if (radial) {
            // its long side faces the ball's run: a hard angular knock and a kick outward
            L = L * (0.5 + 0.3 * rough);
            vr = 0.35 * (vr < 0 ? -vr : vr) + 0.3 + 0.35 * rnd();
          } else {
            // its long face lies across the ball's descent: mostly a radial bounce
            L = L * (0.78 + 0.17 * rough);
            vr = 0.5 * (vr < 0 ? -vr : vr) + 0.15 + 0.25 * rnd();
          }
          vz = 0.55 + 0.75 * rnd();
          if (z < 1e-4) z = 1e-4;
        }
      }
      n++;
      rec.r[n] = r;
      rec.th[n] = th;
      rec.z[n] = z;
      if (n >= maxSteps - 2) break;
    }
    entry = n;
    // rotor (rotor frame: phi = theta - psi, psi = P.rho + OMEGA * t)
    var t = n * DT,
      phi = th - (P.rho + OMEGA * t),
      wr = L / (r * r) - OMEGA,
      vHop = P.vHop,
      muP = P.muP,
      rotorMax = Math.floor(P.rotorMax / DT) + n,
      forceAt = maxSteps - Math.floor(0.75 / DT),
      settling = false,
      jc = 0;
    while (true) {
      if (n >= rotorMax || n >= forceAt) {
        vHop = 1e9; //                  no more hops: the ball loses its life and drops in
        muP = muP + 0.35;
      }
      if (settling) {
        var x = phi - jc * PITCH,
          xr = r - GEOM.pocket;
        wr = wr + (-SETTLE_W * SETTLE_W * x - 2 * SETTLE_W * wr) * DT;
        phi = phi + wr * DT;
        vr = vr + (-SETTLE_W * SETTLE_W * xr - 2 * SETTLE_W * vr) * DT;
        r = r + vr * DT;
        if (z > 0) {
          vz = vz - G_Z * DT;
          z = z + vz * DT;
          if (z < 0) z = 0;
        }
        var ax = x < 0 ? -x : x,
          axr = xr < 0 ? -xr : xr,
          aw = wr < 0 ? -wr : wr,
          avr = vr < 0 ? -vr : vr;
        if ((ax < 2e-4 && aw < 0.02 && axr < 2e-4 && avr < 0.01 && z === 0) || n - settleStep > 0.9 / DT || n >= maxSteps - 2) {
          phi = jc * PITCH;
          r = GEOM.pocket;
          z = 0;
          n++;
          t = n * DT;
          rec.r[n] = r;
          rec.th[n] = phi + P.rho + OMEGA * t;
          rec.z[n] = 0;
          break;
        }
      } else if (z > 0 || vz > 0) {
        // in the air: over the frets
        vz = vz - G_Z * DT;
        z = z + vz * DT;
        phi = phi + wr * DT;
        wr = wr * (1 - 0.25 * DT);
        vr = vr * (1 - 0.8 * DT) - 0.6 * DT;
        r = r + vr * DT;
        if (z <= 0) {
          z = 0;
          if (vz < -0.55) vz = -0.3 * vz;
          else vz = 0;
          wr = wr * (0.88 + 0.08 * rnd()); //   a landing scrubs speed
          var jl = Math.floor(phi / PITCH + 0.5),
            lim = PITCH / 2 - (B + GEOM.fret) / r,
            xl = phi - jl * PITCH;
          if (r <= GEOM.numIn) {
            if (xl > lim) phi = jl * PITCH + lim;
            else if (xl < -lim) phi = jl * PITCH - lim;
          }
        }
      } else if (r > GEOM.numIn) {
        // rolling on the number ring, sloping inward
        phi = phi + wr * DT;
        wr = wr * (1 - P.muN * DT);
        vr = (vr - G_RING * DT) * (1 - 1.5 * DT);
        r = r + vr * DT;
      } else {
        // on a pocket floor: the frets
        phi = phi + wr * DT;
        wr = wr * (1 - muP * DT);
        vr = vr + (-K_POCKET * (r - GEOM.pocket) - C_POCKET * vr) * DT;
        r = r + vr * DT;
        var j = Math.floor(phi / PITCH + 0.5),
          lm = PITCH / 2 - (B + GEOM.fret) / r,
          xp = phi - j * PITCH;
        if ((xp > lm && wr > 0) || (xp < -lm && wr < 0)) {
          var v = (wr < 0 ? -wr : wr) * r;
          if (v > vHop) {
            hops++;
            vz = 0.25 + P.hopK * v * (0.45 + 0.4 * rnd());
            if (vz > 1.45) vz = 1.45 + 0.25 * rnd(); //  a hop is a few ball heights at most
            z = 1e-4;
            if (rnd() < P.pRev) {
              // a ricochet: the fret throws it back the way it came
              phi = j * PITCH + (xp > 0 ? lm : -lm);
              wr = -wr * P.eRev * (0.7 + 0.3 * rnd());
            } else wr = wr * P.eHop * (0.8 + 0.18 * rnd());
            vr = vr + (rnd() - 0.25) * 0.4 * v;
          } else {
            rattles++;
            phi = j * PITCH + (xp > 0 ? lm : -lm);
            wr = -wr * P.eBack * (0.55 + 0.4 * rnd());
            if (v > 0.3) {
              vz = 0.1 * v * rnd();
              if (vz > 0) z = 1e-4;
            }
          }
        } else if ((wr < 0 ? -wr : wr) * r < P.vSettle && (vr < 0 ? -vr : vr) < 0.5 && z === 0) {
          settling = true;
          settleStep = n;
          jc = j;
        }
      }
      if (r > GEOM.rotor - B) {
        r = GEOM.rotor - B;
        if (vr > 0) vr = -0.4 * vr;
      } else if (r < GEOM.pocketIn + B) {
        r = GEOM.pocketIn + B;
        if (vr < 0) vr = -0.4 * vr;
      }
      n++;
      t = n * DT;
      rec.r[n] = r;
      rec.th[n] = phi + P.rho + OMEGA * t;
      rec.z[n] = z;
      if (n >= maxSteps - 2 && !settling) {
        settling = true;
        settleStep = n;
        jc = Math.floor(phi / PITCH + 0.5);
        vz = 0;
      }
    }
    return { n: n, entry: entry, settle: settleStep, slot: ((jc % N) + N) % N, hits: hits, hops: hops, rattles: rattles };
  }

  // the seeded shape of one variant (exit angle, rotor phase, liveliness); life in [0, 1] grows with the spin length
  function variantParams(rnd, life) {
    return {
      thetaE: rnd() * TAU,
      rho: rnd() * PITCH,
      muL: (0.15 - 0.06 * life) * (0.7 + 0.6 * rnd()),
      muR: 1.2,
      coneMax: 2.0 + 1.2 * life,
      muN: 0.5,
      muP: 1.2 - 0.4 * life,
      vHop: 0.85 - 0.1 * life,
      hopK: 0.55 + 0.1 * life,
      eHop: (0.9 + 0.05 * life) * (0.92 + 0.1 * rnd()),
      eBack: 0.84 + 0.06 * life,
      pRev: 0.22 + 0.12 * life,
      eRev: 0.5 + 0.1 * life,
      vSettle: 0.16,
      rotorMax: 2.0 + 1.6 * life,
    };
  }
  // how long the after-track part should take for a spin of fitMs (seconds), and the band a variant must fall in
  function postTarget(fitMs) {
    var d = clamp(fitMs, FIT_MIN, FIT_MAX) / 1000;
    return 1.78 + 0.044 * d; // 4 s -> 1.96 s, 12 s -> 2.3 s, 20 s -> 2.66 s
  }

  // backward integration of the backtrack: from the exit (u = U_CRIT at angle thetaE) back to the launch, exactly tTrack s
  function trackBack(tTrack, thetaE, A, out) {
    var c0 = A / tTrack,
      c1 = A / tTrack / (out.u0 * out.u0),
      M = Math.floor(tTrack / DT),
      h = tTrack - M * DT,
      u = U_CRIT,
      th = thetaE;
    if (h > 1e-12) {
      th = th + u * h;
      u = u + (c0 + c1 * u * u) * h;
    }
    out.u[M] = u;
    out.th[M] = th;
    for (var m = M - 1; m >= 0; m--) {
      th = th + u * DT;
      u = u + (c0 + c1 * u * u) * DT;
      out.u[m] = u;
      out.th[m] = th;
    }
    return M;
  }
  // the drag scale A so the launch speed is about u0 (coarse arithmetic bisection; the exact value doesn't matter)
  function solveA(u0) {
    var lo = 0.5,
      hi = 60;
    for (var it = 0; it < 30; it++) {
      var A = 0.5 * (lo + hi),
        u = U_CRIT,
        ds = 1 / 48;
      for (var s = 0; s < 48; s++) u = u + A * (1 + (u * u) / (u0 * u0)) * ds;
      if (u > u0) hi = A;
      else lo = A;
    }
    return 0.5 * (lo + hi);
  }

  function offsetAt(p, t) {
    if (!p || t <= p.rampFrom) return 0;
    if (t >= p.rampTo) return p.off;
    return p.off * smooth((t - p.rampFrom) / (p.rampTo - p.rampFrom));
  }
  // a rotor shift (rad) the same as `want` mod 2pi, starting from `from`: forward (with the rotor), or a gentle slow-down
  // when that is short enough that the rotor still visibly turns forward the whole time
  function rampTarget(from, want, durMs) {
    var d = norm(want - from),
      back = d - TAU,
      dur = Math.max(0.2, durMs / 1000);
    return from + ((1.5 * -back) / dur <= 0.6 * OMEGA ? back : d);
  }

  var cache = { key: "", plan: null };
  /**
   * plan({tableId, round, pocket, startedAt, landAt}) -> the whole spin, pure and deterministic.
   *   frames: Float32Array, 60 Hz from t0, 4 per frame [rotorOffset, r, theta, z] (theta world, [0, 2pi))
   *   s: the idle rotor's slot the ball settles in; k: whole pockets the rotor is shown shifted; settleAt (ms)
   */
  function plan(o) {
    o = o || {};
    var pocket = Number(o.pocket);
    if (!(pocket >= 0 && pocket <= 36 && Math.floor(pocket) === pocket)) throw new TypeError("rlwheel.plan: pocket 0-36");
    var landAt = Number(o.landAt);
    if (!isFinite(landAt)) throw new TypeError("rlwheel.plan: landAt");
    var startedAt = Number(o.startedAt);
    if (!isFinite(startedAt)) startedAt = landAt - 12000;
    var tableId = o.tableId == null ? "" : String(o.tableId),
      round = o.round == null ? "" : String(o.round);
    var key = [VERSION, tableId, round, pocket, startedAt, landAt].join("|");
    if (cache.key === key) return cache.plan;

    var seed = seedOf(tableId, round),
      span = clamp(landAt - startedAt, SPAN_MIN, SPAN_MAX),
      t0 = landAt - span,
      effMs = span - LEAD_MS, //                    launch -> settle, before the pocket alignment
      fit = clamp(landAt - startedAt, FIT_MIN, FIT_MAX),
      life = (fit - FIT_MIN) / (FIT_MAX - FIT_MIN),
      target = postTarget(fit),
      trackMin = 1.25 + life,
      hiBand = Math.min(target * 1.16, (effMs - POCKET_MS) / 1000 - trackMin),
      loBand = Math.min(target * 0.84, hiBand - 0.2);
    var maxSteps = Math.floor(((effMs - POCKET_MS) / 1000 - 1.0) / DT); // the track keeps >= 1 s whatever the variants do
    var rec = { r: new Float64Array(maxSteps + 2), th: new Float64Array(maxSteps + 2), z: new Float64Array(maxSteps + 2) },
      best = null,
      bestErr = Infinity,
      bestRec = null,
      variant = 0;
    for (var v = 0; v < 24; v++) {
      var rnd = mulberry32(variantSeed(seed, v)),
        P = variantParams(rnd, life),
        res = postSim(rnd, P, rec, maxSteps),
        T = res.n * DT,
        err = T < loBand ? loBand - T : T > hiBand ? T - hiBand : 0;
      if (err < bestErr) {
        bestErr = err;
        best = { P: P, res: res };
        variant = v;
        bestRec = { r: rec.r.slice(0, res.n + 1), th: rec.th.slice(0, res.n + 1), z: rec.z.slice(0, res.n + 1) };
        if (err === 0) break;
      }
    }
    var P0 = best.P,
      R = best.res,
      tPost = R.n * DT;
    // the exit moment: nominally effMs - tPost after launch, then earlier by < one pocket of rotor time so the real rotor's
    // phase there equals the canonical P0.rho
    var exitNom = t0 + effMs - tPost * 1000,
      uNom = idlePockets(exitNom),
      uE = P0.rho / PITCH,
      shift = uNom - uE - Math.floor(uNom - uE), //   [0, 1) pockets
      exitAt = exitNom - shift * POCKET_MS,
      q = Math.round(idlePockets(exitAt) - uE),
      tTrack = (exitAt - t0) / 1000;
    q = ((q % N) + N) % N;
    var s = (((R.slot - q) % N) + N) % N,
      idx = WHEEL.indexOf(pocket),
      k = (((idx - s) % N) + N) % N;
    // the backtrack, backward from the exit
    var u0 = TAU * clamp(1.75 + 0.1 * tTrack, 1.85, 3.0),
      A = solveA(u0),
      track = { u: new Float64Array(Math.floor(tTrack / DT) + 2), th: new Float64Array(Math.floor(tTrack / DT) + 2), u0: u0 },
      M = trackBack(tTrack, P0.thetaE, A, track);
    var settleAt = exitAt + tPost * 1000,
      entryAt = exitAt + R.entry * DT * 1000,
      rampFrom = t0,
      rampTo = t0 + 1000 * clamp(0.45 * tTrack, 0.9, 3.2);
    if (rampTo > exitAt - 300) rampTo = Math.max(t0 + 200, exitAt - 300);
    var p = {
      v: VERSION,
      tableId: tableId,
      round: round,
      pocket: pocket,
      startedAt: startedAt,
      landAt: landAt,
      seed: seed,
      variant: variant,
      t0: t0,
      exitAt: exitAt,
      entryAt: entryAt,
      settleAt: settleAt,
      rampFrom: rampFrom,
      rampTo: rampTo,
      s: s,
      k: k,
      off: 0,
      launch: { omega: -track.u[0], theta: norm(track.th[0]) },
      stats: { diamonds: R.hits, hops: R.hops, rattles: R.rattles, track: tTrack, post: tPost },
      fps: FPS,
      n: 0,
      frames: null,
    };
    p.off = rampTarget(0, -k * PITCH, rampTo - rampFrom);
    // 60 Hz frames: the track from the backward integration (grid-aligned to t0: frame i = step 4i), the rest from the record
    var nF = Math.ceil((settleAt - t0) / FRAME_MS) + 2,
      F = new Float32Array(nF * 4),
      nPost = R.n,
      jc = R.slot;
    for (var i = 0; i < nF; i++) {
      var ti = t0 + i * FRAME_MS,
        tau = i / FPS,
        rr,
        th,
        zz;
      if (i * SUB <= M && tau < tTrack) {
        rr = GEOM.track;
        th = track.th[i * SUB];
        zz = 0;
      } else {
        var x = (tau - tTrack) / DT;
        if (x < 0) x = 0;
        var a = Math.floor(x),
          f = x - a;
        if (a >= nPost) {
          rr = GEOM.pocket;
          th = P0.rho + OMEGA * (tau - tTrack) + jc * PITCH;
          zz = 0;
        } else {
          rr = bestRec.r[a] + (bestRec.r[a + 1] - bestRec.r[a]) * f;
          th = bestRec.th[a] + (bestRec.th[a + 1] - bestRec.th[a]) * f;
          zz = bestRec.z[a] + (bestRec.z[a + 1] - bestRec.z[a]) * f;
        }
      }
      F[i * 4] = offsetAt(p, ti);
      F[i * 4 + 1] = rr;
      F[i * 4 + 2] = norm(th);
      F[i * 4 + 3] = zz;
    }
    p.n = nF;
    p.frames = F;
    cache.key = key;
    cache.plan = p;
    return p;
  }

  /**
   * frame(plan, siteNowMs[, out]) -> where everything is at a server time (cheap; no allocation when `out` is passed).
   *   {t, phase: 'idle'|'track'|'cone'|'rotor'|'settled', rotor (shown angle), offset, visible, r, theta, z, x, y, pocket}
   *   x/y: unit wheel coordinates, y down; angles clockwise from 12 o'clock. With no plan: the idle rotor, no ball.
   */
  function frame(p, t, out) {
    out = out || {};
    var off = offsetAt(p, t);
    out.t = t;
    out.offset = off;
    out.rotor = norm(idleAngle(t) + off);
    out.pocket = null;
    if (!p || t < p.t0) {
      out.phase = "idle";
      out.visible = false;
      out.r = 0;
      out.theta = 0;
      out.z = 0;
      out.x = 0;
      out.y = 0;
      return out;
    }
    if (t >= p.settleAt) {
      out.phase = "settled";
      out.r = GEOM.pocket;
      out.theta = norm(out.rotor + WHEEL.indexOf(p.pocket) * PITCH);
      out.z = 0;
      out.pocket = p.pocket;
    } else {
      var x = (t - p.t0) / FRAME_MS,
        i = Math.floor(x),
        f = x - i,
        F = p.frames;
      if (i >= p.n - 1) {
        i = p.n - 2;
        f = 1;
      }
      var a = i * 4,
        b = a + 4,
        d = F[b + 2] - F[a + 2];
      if (d > Math.PI) d -= TAU;
      else if (d < -Math.PI) d += TAU;
      out.r = F[a + 1] + (F[b + 1] - F[a + 1]) * f;
      out.theta = norm(F[a + 2] + d * f);
      out.z = F[a + 3] + (F[b + 3] - F[a + 3]) * f;
      out.phase = t < p.exitAt ? "track" : t < p.entryAt ? "cone" : "rotor";
    }
    out.visible = true;
    out.x = out.r * Math.sin(out.theta);
    out.y = -out.r * Math.cos(out.theta);
    return out;
  }

  /** The pocket under a ball at world angle theta when the rotor shows angle rotor (for tests and readouts). */
  function pocketAt(rotor, theta) {
    var j = Math.round(norm(theta - rotor) / PITCH) % N;
    return WHEEL[j];
  }

  // ── what a caller hands spin(): a table view, an OBS payload, a cz:rl-spin detail or plan() arguments ──
  function spinArgs(v) {
    if (!v || typeof v !== "object") return null;
    if (v.table && typeof v.table === "object") v = v.table; // a whole GET /api/casino/t/:id answer
    if (typeof v.phase === "string" && v.phase !== "spinning") return null; // only a live spin (post-commit), never a replay
    var sp = v.spin && typeof v.spin === "object" ? v.spin : null,
      pick = function () {
        for (var i = 0; i < arguments.length; i++) if (arguments[i] != null && arguments[i] !== "") return arguments[i];
        return null;
      };
    var pocket = Number(pick(sp && sp.number, v.pocket, v.number)),
      landAt = Number(pick(sp && sp.ends_at, v.landAt, v.land_at, v.ends_at)),
      secs = Number(pick(sp && sp.secs, v.secs, v.rules && v.rules.spin_secs, v.limits && v.limits.spin_secs)),
      startedAt = Number(pick(sp && sp.started_at, v.startedAt, v.started_at));
    if (!(pocket >= 0 && pocket <= 36 && Math.floor(pocket) === pocket) || !isFinite(landAt) || landAt <= 0) return null;
    if (!isFinite(startedAt) || startedAt <= 0) startedAt = landAt - (secs > 0 ? secs : 8) * 1000;
    return {
      tableId: String(pick(v.tableId, v.table_id, v.table, v.id) || ""),
      round: String(pick(sp && sp.round_no, v.round, v.round_no) || ""),
      pocket: pocket,
      startedAt: startedAt,
      landAt: landAt,
    };
  }

  // ── rendering (browser only: nothing above this line touches the DOM) ──
  var PALETTES = {
    classic: {
      woodDark: "#2a1307",
      wood: "#6b3a1b",
      woodLight: "#a5683a",
      grain: "rgba(28,10,3,.24)",
      trim: "#d8b06c",
      track: "#130904",
      trackLight: "#6a4224",
      trackSheen: "#3d2413",
      apron: "#4b2b15",
      apronLight: "#7c4b26",
      metal: "#f4eedf",
      metalDark: "#8a7a5c",
      red: "#c41f2a",
      black: "#17171b",
      zero: "#0d8a4b",
      text: "#fbf7ec",
      sep: "#d8b06c",
      cone: "#5c3319",
      coneLight: "#97592b",
      brass: "#dcae55",
      brassDark: "#7c561c",
      brassLight: "#fbe5a5",
      ball: "#fbfbf8",
      ballShade: "#9d9d98",
    },
    hr: {
      woodDark: "#0e0703",
      wood: "#2c180d",
      woodLight: "#5b3a20",
      grain: "rgba(0,0,0,.32)",
      trim: "#f2c65a",
      track: "#070403",
      trackLight: "#4a3018",
      trackSheen: "#24160c",
      apron: "#22140a",
      apronLight: "#45301b",
      metal: "#ffe7a6",
      metalDark: "#9a7224",
      red: "#b5121f",
      black: "#0e0e11",
      zero: "#0a7a42",
      text: "#fff6dc",
      sep: "#f2c65a",
      cone: "#24140a",
      coneLight: "#5a3a1f",
      brass: "#f3c64f",
      brassDark: "#8a6318",
      brassLight: "#fff0b8",
      ball: "#fffdf6",
      ballShade: "#a59d8a",
    },
  };
  function paletteOf(p) {
    var base = PALETTES.classic,
      src = typeof p === "string" ? PALETTES[p] || base : p || {},
      out = {};
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = src[k] != null ? src[k] : base[k];
    return out;
  }
  // my angles run clockwise from 12 o'clock; the canvas's from 3 o'clock
  function arcA(a) {
    return a - Math.PI / 2;
  }
  function disc(g, c, r, fill) {
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.fillStyle = fill;
    g.fill();
  }
  function annulus(g, c, r0, r1, fill) {
    g.beginPath();
    g.arc(c, c, r1, 0, TAU, false);
    g.arc(c, c, r0, TAU, 0, true);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  }
  function hoop(g, c, r, color, width) {
    g.beginPath();
    g.arc(c, c, r, 0, TAU);
    g.strokeStyle = color;
    g.lineWidth = width;
    g.stroke();
  }
  function rgrad(g, c, r0, r1, stops) {
    var gr = g.createRadialGradient(c, c, r0, c, c, r1);
    for (var i = 0; i < stops.length; i++) gr.addColorStop(stops[i][0], stops[i][1]);
    return gr;
  }
  function grain(g, c, r0, r1, count, color, R, seed) {
    var rnd = mulberry32(seed);
    g.strokeStyle = color;
    for (var i = 0; i < count; i++) {
      var rr = r0 + (r1 - r0) * rnd(),
        a0 = rnd() * TAU;
      g.beginPath();
      g.arc(c, c, rr, a0, a0 + 0.5 + 2.6 * rnd());
      g.lineWidth = Math.max(0.6, R * 0.0025 * (0.4 + rnd()));
      g.stroke();
    }
  }
  function layerCanvas(doc, size) {
    var cv = doc.createElement("canvas");
    cv.width = size;
    cv.height = size;
    return cv;
  }
  // the stator: wooden bowl, ball track, cone and the 8 diamonds (never moves)
  function drawStator(g, S, pal, compact) {
    var c = S / 2,
      R = c * 0.975;
    g.save();
    g.shadowColor = "rgba(0,0,0,.5)";
    g.shadowBlur = R * 0.05;
    g.shadowOffsetY = R * 0.02;
    disc(g, c, R, pal.woodDark);
    g.restore();
    annulus(g, c, R * GEOM.trackOut, R, rgrad(g, c, R * GEOM.trackOut, R, [[0, pal.woodLight], [0.4, pal.wood], [1, pal.woodDark]]));
    grain(g, c, R * 0.958, R * 0.995, compact ? 8 : 40, pal.grain, R, 7);
    hoop(g, c, R * 0.998, "rgba(0,0,0,.55)", Math.max(1, R * 0.006));
    hoop(g, c, R * 0.958, pal.trim, Math.max(1, R * 0.005));
    // the ball track: a concave groove - the outer wall in shadow, a sheen where the ball runs, a bright lip
    annulus(g, c, R * GEOM.trackIn, R * 0.955,
      rgrad(g, c, R * GEOM.trackIn, R * 0.955, [[0, pal.trackLight], [0.12, pal.track], [0.48, pal.trackSheen], [0.66, pal.track], [1, "#030201"]]));
    hoop(g, c, R * 0.953, "rgba(0,0,0,.7)", Math.max(1, R * 0.006));
    hoop(g, c, R * (GEOM.trackIn + 0.002), "rgba(255,232,196,.3)", Math.max(1, R * 0.004));
    // the cone (apron) down to the rotor, darker as it falls away
    annulus(g, c, R * 0.705, R * GEOM.trackIn, rgrad(g, c, R * 0.705, R * GEOM.trackIn, [[0, pal.woodDark], [0.3, pal.apron], [1, pal.apronLight]]));
    if (!compact) grain(g, c, R * 0.72, R * 0.875, 26, pal.grain, R, 11);
    // the diamonds
    for (var d = 0; d < 8; d++) {
      var a = D_FIRST + d * D_STEP,
        radial = d % 2 === 0,
        hl = (radial ? D_LONG : D_SHORT) * R,
        hw = (radial ? D_SHORT : D_LONG) * R;
      g.save();
      g.translate(c + R * GEOM.diamond * Math.sin(a), c - R * GEOM.diamond * Math.cos(a));
      g.rotate(a);
      g.shadowColor = "rgba(0,0,0,.55)";
      g.shadowBlur = R * 0.012;
      g.shadowOffsetX = R * 0.006;
      g.shadowOffsetY = R * 0.008;
      g.beginPath();
      g.moveTo(0, -hl);
      g.lineTo(hw, 0);
      g.lineTo(0, hl);
      g.lineTo(-hw, 0);
      g.closePath();
      var lg = g.createLinearGradient(-hw, -hl, hw, hl);
      lg.addColorStop(0, pal.metal);
      lg.addColorStop(0.5, pal.metalDark);
      lg.addColorStop(1, pal.metal);
      g.fillStyle = lg;
      g.fill();
      g.shadowColor = "transparent";
      g.lineWidth = Math.max(0.6, R * 0.002);
      g.strokeStyle = "rgba(0,0,0,.45)";
      g.stroke();
      g.beginPath();
      if (radial) {
        g.moveTo(0, -hl * 0.85);
        g.lineTo(0, hl * 0.85);
      } else {
        g.moveTo(-hw * 0.85, 0);
        g.lineTo(hw * 0.85, 0);
      }
      g.strokeStyle = "rgba(255,255,255,.55)";
      g.stroke();
      g.restore();
    }
    // the gap the rotor sits in
    annulus(g, c, R * (GEOM.rotor - 0.004), R * 0.708, "rgba(0,0,0,.6)");
  }
  // the rotor at angle 0 (zero at 12 o'clock): number ring, pockets, frets, cone and turret
  function drawRotor(g, S, pal, compact) {
    var c = S / 2,
      R = c * 0.975,
      i,
      a0,
      a1,
      n;
    for (i = 0; i < N; i++) {
      n = WHEEL[i];
      a0 = arcA((i - 0.5) * PITCH);
      a1 = arcA((i + 0.5) * PITCH);
      g.beginPath();
      g.arc(c, c, R * GEOM.rotor, a0, a1, false);
      g.arc(c, c, R * GEOM.pocketIn, a1, a0, true);
      g.closePath();
      g.fillStyle = pal[colorOf(n)];
      g.fill();
    }
    // the number ring catches the light; the pockets sit deep
    annulus(g, c, R * GEOM.numIn, R * GEOM.rotor,
      rgrad(g, c, R * GEOM.numIn, R * GEOM.rotor, [[0, "rgba(0,0,0,.18)"], [0.6, "rgba(255,255,255,.06)"], [1, "rgba(255,255,255,.16)"]]));
    annulus(g, c, R * GEOM.pocketIn, R * GEOM.numIn,
      rgrad(g, c, R * GEOM.pocketIn, R * GEOM.numIn, [[0, "rgba(0,0,0,.62)"], [0.4, "rgba(0,0,0,.3)"], [0.75, "rgba(0,0,0,.42)"], [1, "rgba(0,0,0,.72)"]]));
    // separators on the number ring and the frets between pockets
    for (i = 0; i < N; i++) {
      var a = (i + 0.5) * PITCH,
        sx = Math.sin(a),
        sy = -Math.cos(a);
      g.beginPath();
      g.moveTo(c + sx * R * GEOM.numIn, c + sy * R * GEOM.numIn);
      g.lineTo(c + sx * R * GEOM.rotor, c + sy * R * GEOM.rotor);
      g.strokeStyle = pal.sep;
      g.lineWidth = Math.max(0.6, R * 0.004);
      g.stroke();
      g.beginPath();
      g.moveTo(c + sx * R * (GEOM.pocketIn + 0.004), c + sy * R * (GEOM.pocketIn + 0.004));
      g.lineTo(c + sx * R * (GEOM.numIn + 0.002), c + sy * R * (GEOM.numIn + 0.002));
      g.strokeStyle = pal.metalDark;
      g.lineWidth = Math.max(1, R * GEOM.fret * 3.2);
      g.stroke();
      g.strokeStyle = pal.metal;
      g.lineWidth = Math.max(0.6, R * GEOM.fret * 1.3);
      g.stroke();
    }
    hoop(g, c, R * GEOM.rotor, pal.sep, Math.max(1, R * 0.006));
    hoop(g, c, R * GEOM.numIn, pal.metal, Math.max(1, R * 0.006));
    hoop(g, c, R * GEOM.pocketIn, pal.metal, Math.max(1, R * 0.007));
    // the numbers, upright when read from the rim
    if (!compact && R >= 70) {
      var fs = R * 0.06;
      g.fillStyle = pal.text;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "700 " + fs.toFixed(1) + "px Georgia, 'Times New Roman', serif";
      for (i = 0; i < N; i++) {
        g.save();
        g.translate(c, c);
        g.rotate(i * PITCH);
        g.fillText(String(WHEEL[i]), 0, -R * ((GEOM.rotor + GEOM.numIn) / 2));
        g.restore();
      }
    }
    // the rotor cone, then the turret
    annulus(g, c, R * GEOM.cone, R * GEOM.pocketIn - 0.5,
      rgrad(g, c, R * GEOM.cone, R * GEOM.pocketIn, [[0, pal.cone], [0.55, pal.coneLight], [0.92, pal.cone], [1, "rgba(0,0,0,.8)"]]));
    if (!compact) grain(g, c, R * 0.26, R * 0.48, 24, pal.grain, R, 23);
    disc(g, c, R * GEOM.cone, rgrad(g, c, 0, R * GEOM.cone, [[0, pal.brassDark], [0.82, pal.brass], [1, pal.brassDark]]));
    hoop(g, c, R * GEOM.cone, "rgba(0,0,0,.5)", Math.max(1, R * 0.004));
    disc(g, c, R * 0.2, rgrad(g, c, 0, R * 0.2, [[0, pal.cone], [1, pal.woodDark]]));
    for (i = 0; i < 4; i++) {
      g.save();
      g.translate(c, c);
      g.rotate((i * TAU) / 4);
      var w = R * 0.03,
        lg = g.createLinearGradient(-w, 0, w, 0);
      lg.addColorStop(0, pal.brassDark);
      lg.addColorStop(0.5, pal.brassLight);
      lg.addColorStop(1, pal.brassDark);
      g.fillStyle = lg;
      g.beginPath();
      g.moveTo(-w * 0.55, 0);
      g.lineTo(-w * 0.35, -R * 0.17);
      g.lineTo(w * 0.35, -R * 0.17);
      g.lineTo(w * 0.55, 0);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(0, -R * 0.175, R * 0.03, 0, TAU);
      var kg = g.createRadialGradient(0, -R * 0.175, 0, 0, -R * 0.175, R * 0.03);
      kg.addColorStop(0, pal.brassLight);
      kg.addColorStop(0.7, pal.brass);
      kg.addColorStop(1, pal.brassDark);
      g.fillStyle = kg;
      g.fill();
      g.restore();
    }
    disc(g, c, R * 0.075, rgrad(g, c, 0, R * 0.075, [[0, pal.brassLight], [0.6, pal.brass], [1, pal.brassDark]]));
  }
  // light that never turns with the rotor: a sheen from the top left, a vignette, the turret's glint
  function drawLight(g, S) {
    var c = S / 2,
      R = c * 0.975,
      hx = c - R * 0.42,
      hy = c - R * 0.5,
      sh = g.createRadialGradient(hx, hy, 0, hx, hy, R * 1.3);
    sh.addColorStop(0, "rgba(255,247,228,.17)");
    sh.addColorStop(0.45, "rgba(255,247,228,.05)");
    sh.addColorStop(1, "rgba(255,247,228,0)");
    disc(g, c, R, sh);
    var vg = g.createRadialGradient(c + R * 0.25, c + R * 0.3, R * 0.45, c, c, R * 1.02);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,.3)");
    disc(g, c, R, vg);
    var gx = c - R * 0.024,
      gy = c - R * 0.03,
      gl = g.createRadialGradient(gx, gy, 0, gx, gy, R * 0.035);
    gl.addColorStop(0, "rgba(255,255,255,.75)");
    gl.addColorStop(1, "rgba(255,255,255,0)");
    g.beginPath();
    g.arc(gx, gy, R * 0.035, 0, TAU);
    g.fillStyle = gl;
    g.fill();
  }
  function drawBallSprite(g, size, br, pal) {
    var c = size / 2,
      bg = g.createRadialGradient(c - br * 0.38, c - br * 0.42, br * 0.05, c, c, br * 1.02);
    bg.addColorStop(0, "#ffffff");
    bg.addColorStop(0.22, pal.ball);
    bg.addColorStop(0.72, pal.ballShade);
    bg.addColorStop(1, "#5d5d59");
    g.beginPath();
    g.arc(c, c, br, 0, TAU);
    g.fillStyle = bg;
    g.fill();
  }
  function drawShadowSprite(g, size, br) {
    var c = size / 2,
      sg = g.createRadialGradient(c, c, 0, c, c, br * 1.7);
    sg.addColorStop(0, "rgba(0,0,0,.6)");
    sg.addColorStop(0.55, "rgba(0,0,0,.28)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = sg;
    g.fillRect(0, 0, size, size);
  }

  // the canvas's aria-label (role=img): English defaults = locales/en.json js.casino.rl_wheel_* (the page's __t translates)
  var LABELS = Object.freeze({
    rl_wheel_idle: "Roulette wheel",
    rl_wheel_spinning: "Roulette wheel: the ball is spinning",
    rl_wheel_landed: "Roulette wheel: the ball landed on {n}",
    rl_wheel_red: "{n} red",
    rl_wheel_black: "{n} black",
    rl_wheel_zero: "{n} zero",
  });
  function fill(s, v) {
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return v && v[k] != null ? v[k] : m;
    });
  }

  /**
   * mount(canvas, {compact, reduced, palette, tilt, t, onEvent}) -> a live wheel on a <canvas>, drawn by server time.
   *   setSkew(ms)  ms = local clock - server clock (CZ.skew(), the OBS payload's skew_ms); the wheel shows server time
   *                Date.now() - ms (a re-measured skew within 1.5 s is slewed in, so poll jitter never jumps the ball)
   *   idle([siteNow])  bets open: no ball (fades out), the rotor's shift eases back to zero
   *   spin(view)   a table view with .spin, an OBS payload or plan() arguments; joins mid-flight by server time
   *   rest(pocket) the result: the ball sits in that pocket (finishes a running spin within 300 ms; the server wins)
   *   destroy()
   * Options: compact (mini wheel: no numbers, no ghosts), reduced (true/false; unset = follow prefers-reduced-motion),
   * palette ('classic' | 'hr' | {colours}), tilt (deg: the canvas gets a CSS rotateX and hops lift toward the far side),
   * t(key, default, vars) for the aria labels (default window.__t('js.casino.' + key)), onEvent(type, detail) for sound
   * cues: launch, drop, diamond, rotor, hop, settle.
   */
  function mount(canvas, opts) {
    opts = opts || {};
    var win = typeof window !== "undefined" ? window : null,
      doc = (canvas && canvas.ownerDocument) || (typeof document !== "undefined" ? document : null),
      ctx = canvas && canvas.getContext ? canvas.getContext("2d") : null,
      mq = win && win.matchMedia ? win.matchMedia("(prefers-reduced-motion: reduce)") : null,
      ro = null,
      io = null,
      timer = 0;
    var st = {
      skew: 0, //         local clock - server clock, as shown now...
      skewTo: 0, //       ...and where it is heading
      skewAt: 0,
      skewSet: false,
      mode: "idle", //    idle | spin | rest
      plan: null, //      the spin being shown (also while it rests, and while the ball fades out after)
      key: "",
      pocket: null, //    the pocket the ball rests in (rest mode)
      ramp: null, //      the rotor's shift easing: {t0, t1, from, to} in server ms
      base: 0, //         the shift outside a ramp
      warp: null, //      the result came before the animation was done: {a, b, pa, pb}
      fade: null, //      the ball's opacity: {t0, t1, a, b}
      tilt: Number(opts.tilt) || 0,
      compact: !!opts.compact,
      pal: paletteOf(opts.palette),
      forced: opts.reduced === true || opts.reduced === false ? opts.reduced : null,
      raf: 0,
      dead: false,
      onScreen: true,
      size: 0,
      css: 0,
      L: null,
      last: { phase: "idle", z: 0, t: -Infinity },
      label: "",
      f: {},
      g: {},
    };
    function reduced() {
      return st.forced !== null ? st.forced : !!(mq && mq.matches);
    }
    // the server clock. A page re-measures its skew on every poll (it jitters by the poll's latency), so a small change is
    // slewed in at <= SKEW_SLEW of clock speed instead of jumping the ball; the first skew and a big change apply at once
    function now() {
      var l = Date.now();
      if (st.skew !== st.skewTo) {
        var d = st.skewTo - st.skew,
          step = (l - st.skewAt) * SKEW_SLEW;
        if (!(step > 0)) step = 0;
        st.skew = d <= step && d >= -step ? st.skewTo : st.skew + (d > 0 ? step : -step);
      }
      st.skewAt = l;
      return l - st.skew;
    }
    function putSkew(ms) {
      if (!isFinite(ms)) return;
      if (!st.skewSet || Math.abs(ms - st.skew) > SKEW_JUMP_MS) {
        st.skew = ms;
        st.skewTo = ms;
        st.skewAt = Date.now();
        st.skewSet = true;
      } else {
        now(); //                                   (bank the slew so far)
        st.skewTo = ms;
      }
    }
    function T(k, v) {
      if (typeof opts.t === "function") return opts.t(k, LABELS[k], v);
      if (win && typeof win.__t === "function") return win.__t("js.casino." + k, LABELS[k], v);
      return fill(LABELS[k], v);
    }
    function named(n) {
      return T(n === 0 ? "rl_wheel_zero" : RED.indexOf(n) >= 0 ? "rl_wheel_red" : "rl_wheel_black", { n: n });
    }
    function setLabel() {
      if (!canvas || !canvas.setAttribute) return;
      var s =
        st.mode === "rest" && st.pocket != null
          ? T("rl_wheel_landed", { n: named(st.pocket) })
          : st.mode === "spin"
            ? T("rl_wheel_spinning")
            : T("rl_wheel_idle");
      if (s !== st.label) {
        st.label = s;
        canvas.setAttribute("aria-label", s);
      }
    }
    function emit(type, detail) {
      if (typeof opts.onEvent !== "function") return;
      try {
        opts.onEvent(type, detail || {});
      } catch (e) {
        /* a sound cue must never break the wheel */
      }
    }

    // ── the rotor: idle angle from server time + this wheel's shift (the plan's relabel, eased in and out) ──
    function offAt(t) {
      var rp = st.ramp;
      if (!rp) return st.base;
      if (t >= rp.t1) {
        st.base = norm(rp.to);
        st.ramp = null;
        return st.base;
      }
      if (t <= rp.t0) return rp.from;
      return rp.from + (rp.to - rp.from) * smooth((t - rp.t0) / (rp.t1 - rp.t0));
    }
    function rampTo(t0, t1, want, t) {
      var cur = norm(offAt(t));
      st.ramp = { t0: t0, t1: t1, from: cur, to: rampTarget(cur, want, t1 - t0) };
    }
    function rotorAt(t) {
      return reduced() ? 0 : norm(idleAngle(t) + offAt(t));
    }
    function alphaAt(t) {
      var fd = st.fade;
      if (!fd) return 1;
      if (t >= fd.t1) {
        if (fd.b === 0 && st.mode === "idle") {
          st.plan = null; //                       the croupier has the ball again
          st.key = "";
          st.pocket = null;
        }
        st.fade = null;
        return fd.b;
      }
      if (t <= fd.t0) return fd.a;
      return fd.a + (fd.b - fd.a) * ((t - fd.t0) / (fd.t1 - fd.t0));
    }

    // ── layout: the canvas's CSS box x min(devicePixelRatio, 2); the static layers are drawn once per size ──
    function layout() {
      if (st.L) return true;
      if (!ctx || !doc) return false;
      var css = canvas.clientWidth || 0;
      if (!css && canvas.width && !(canvas.style && canvas.style.width)) css = canvas.width; // detached: its own size
      if (!css) return false;
      var dpr = Math.min(2, Math.max(1, (win && win.devicePixelRatio) || 1)),
        size = Math.max(32, Math.round(css * dpr)),
        c = size / 2,
        R = c * 0.975,
        br = Math.max(1.5, R * GEOM.ball),
        bs = Math.ceil(br * 2 + 4),
        ss = Math.ceil(br * 4 + 4),
        compact = st.compact || css < 150;
      st.size = size;
      st.css = css;
      if (canvas.width !== size) canvas.width = size;
      if (canvas.height !== size) canvas.height = size;
      // a canvas with no CSS size takes its pixel size as its box: pin the box, or every relayout would grow it
      if (canvas.style && canvas.clientWidth && Math.abs(canvas.clientWidth - css) > 0.5) {
        canvas.style.width = css + "px";
        canvas.style.height = css + "px";
      }
      var L = {
        stator: layerCanvas(doc, size),
        rotor: layerCanvas(doc, size),
        light: layerCanvas(doc, size),
        ball: layerCanvas(doc, bs),
        shadow: layerCanvas(doc, ss),
        br: br,
        bs: bs,
        ss: ss,
        R: R,
        c: c,
        compact: compact,
      };
      drawStator(L.stator.getContext("2d"), size, st.pal, compact);
      drawRotor(L.rotor.getContext("2d"), size, st.pal, compact || css / 2 < 80);
      drawLight(L.light.getContext("2d"), size);
      drawBallSprite(L.ball.getContext("2d"), bs, br, st.pal);
      drawShadowSprite(L.shadow.getContext("2d"), ss, br);
      st.L = L;
      return true;
    }
    function relayout() {
      st.L = null;
      kick();
    }

    // ── where the ball is at server time t (null: not on the wheel) ──
    function ballAt(t, out) {
      var p = st.plan,
        rot = rotorAt(t);
      if (p && (st.mode === "spin" || st.pocket === p.pocket || (st.mode === "idle" && st.fade))) {
        if (reduced()) {
          if (t < p.landAt && st.mode === "spin") return null; //   no motion: it simply appears in the pocket at land_at
          out.r = GEOM.pocket;
          out.theta = norm(WHEEL.indexOf(p.pocket) * PITCH);
          out.z = 0;
          out.phase = "settled";
          return out;
        }
        var tp = t,
          w = st.warp;
        if (w && t > w.a) tp = t >= w.b ? w.pb : w.pa + ((t - w.a) * (w.pb - w.pa)) / (w.b - w.a);
        frame(p, tp, out);
        if (!out.visible) return null;
        if (out.phase === "settled") out.theta = norm(rot + WHEEL.indexOf(p.pocket) * PITCH);
        else if (tp !== t) out.theta = norm(out.theta + idleAngle(t) - idleAngle(tp)); //  keep it true to the rotor
        return out;
      }
      if (st.pocket != null) {
        out.r = GEOM.pocket;
        out.theta = norm(rot + WHEEL.indexOf(st.pocket) * PITCH);
        out.z = 0;
        out.phase = "settled";
        return out;
      }
      return null;
    }

    // ── one paint at server time t ──
    function paint(t) {
      if (st.dead || !layout()) return;
      var L = st.L,
        g = ctx,
        S = st.size,
        c = L.c,
        R = L.R,
        red = reduced();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      g.drawImage(L.stator, 0, 0);
      var rot = rotorAt(t);
      g.save();
      g.translate(c, c);
      g.rotate(rot);
      g.drawImage(L.rotor, -c, -c);
      g.restore();
      g.drawImage(L.light, 0, 0);
      var b = ballAt(t, st.f),
        alpha = alphaAt(t);
      if (b && red && st.plan && st.mode !== "idle" && st.pocket === null) alpha = alpha * clamp((t - st.plan.landAt) / 400, 0, 1);
      if (b && alpha > 0.01) {
        var lift = st.tilt ? Math.tan((st.tilt * Math.PI) / 180) : 0,
          x = c + R * b.r * Math.sin(b.theta),
          y = c - R * b.r * Math.cos(b.theta),
          z = b.z > 0 ? b.z : 0;
        if (!L.compact && b.phase !== "settled" && !red) {
          // ghost balls at speed: where it was 5, 10, 15 and 20 ms ago
          for (var j = 1; j <= 4; j++) {
            var gb = ballAt(t - 5 * j, st.g);
            if (!gb || gb.phase === "settled") break;
            var hx = c + R * gb.r * Math.sin(gb.theta),
              hy = c - R * gb.r * Math.cos(gb.theta) - (gb.z > 0 ? gb.z : 0) * R * lift;
            if (j === 1 && (hx - x) * (hx - x) + (hy - y) * (hy - y) < L.br * L.br * 0.3) break;
            g.globalAlpha = alpha * (j === 1 ? 0.3 : j === 2 ? 0.18 : j === 3 ? 0.1 : 0.05);
            g.drawImage(L.ball, hx - L.bs / 2, hy - L.bs / 2);
          }
          g.globalAlpha = 1;
        }
        var up = z * R * lift,
          sc = 1 + 0.15 * Math.min(1, z / 0.04),
          off = L.br * (0.22 + 2.4 * z * (lift ? 0.4 : 1)),
          bw = L.bs * sc;
        g.globalAlpha = alpha * (1 - Math.min(0.6, z * 9));
        g.drawImage(L.shadow, x + off - L.ss / 2, y + off - L.ss / 2);
        g.globalAlpha = alpha;
        g.drawImage(L.ball, x - bw / 2, y - up - bw / 2, bw, bw);
        g.globalAlpha = 1;
      }
      cues(t, b);
    }
    // sound cues: only when they are fresh (a background tab catching up, or a page that just opened, stays quiet)
    function cues(t, b) {
      var ph = b ? b.phase : "idle",
        z = b && b.z > 0 ? b.z : 0,
        last = st.last,
        p = st.plan,
        fresh = function (at) {
          return !p || (t - at >= -50 && t - at < 400);
        };
      if (st.mode !== "idle" && t - last.t < 250) {
        if (ph !== last.phase) {
          if (ph === "track" && fresh(p ? p.t0 : t)) emit("launch", { pocket: p ? p.pocket : null });
          else if (ph === "cone" && fresh(p ? p.exitAt : t)) emit("drop");
          else if (ph === "rotor" && fresh(p ? p.entryAt : t)) emit("rotor");
          else if (ph === "settled" && last.phase !== "idle" && fresh(p ? p.settleAt : t)) emit("settle", { pocket: p ? p.pocket : st.pocket });
        } else if (z > 0 && !(last.z > 0) && (ph === "cone" || ph === "rotor")) emit(ph === "cone" ? "diamond" : "hop", { z: z });
      }
      last.phase = ph;
      last.z = z;
      last.t = t;
    }

    // ── the clock: every frame while anything moves; under reduced motion only for a fade or the land_at moment ──
    function nextWake(t) {
      if (!ctx || !st.onScreen) return -1; //                   IntersectionObserver kicks it back on
      if (!reduced() || st.fade || st.ramp) return 0;
      var p = st.plan;
      if (p && st.mode !== "idle" && t < p.landAt + 450) return t < p.landAt - 40 ? p.landAt - 20 : 0;
      return -1;
    }
    function loop() {
      st.raf = 0;
      if (st.dead) return;
      var t = now();
      if (st.onScreen) paint(t);
      plan_next(t);
    }
    function plan_next(t) {
      var w = nextWake(t);
      if (w < 0 || st.dead) return;
      if (w === 0) {
        if (!st.raf) st.raf = win && win.requestAnimationFrame ? win.requestAnimationFrame(loop) : setTimeout(loop, 16);
      } else {
        clearTimeout(timer);
        timer = setTimeout(kick, Math.max(0, w - t));
      }
    }
    function kick() {
      if (st.dead || st.raf) return;
      loop();
    }

    // ── the API ──
    var api = {
      setSkew: function (ms) {
        putSkew(Number(ms));
        return api;
      },
      idle: function (siteNow) {
        if (siteNow != null && isFinite(Number(siteNow))) putSkew(Date.now() - Number(siteNow));
        var t = now();
        if (st.mode !== "idle") {
          var shown = st.mode === "rest" || (st.plan && t >= st.plan.t0);
          st.mode = "idle";
          st.warp = null;
          if (shown && !reduced()) {
            // the croupier takes the ball (it fades), then the rotor eases back to its plain server-time angle
            st.fade = { t0: t, t1: t + 350, a: alphaAt(t), b: 0 };
            rampTo(t + 350, t + 1650, 0, t);
          } else {
            st.fade = null;
            st.plan = null;
            st.key = "";
            st.pocket = null;
            st.ramp = null;
            st.base = 0;
          }
          setLabel();
        }
        kick();
        return api;
      },
      spin: function (view) {
        var a = spinArgs(view);
        if (!a) return null;
        var p = plan(a),
          key = [a.tableId, a.round, a.pocket, a.startedAt, a.landAt].join("|"),
          t = now();
        if (key === st.key && st.plan && st.mode !== "idle") {
          kick(); //                                  the same spin again (every poll): keep going
          return st.plan;
        }
        st.plan = p;
        st.key = key;
        st.pocket = null;
        st.mode = "spin";
        st.warp = null;
        if (t <= p.rampFrom + 60) rampTo(p.rampFrom, p.rampTo, p.off, t);
        else if (t < p.exitAt - 450) rampTo(t, Math.min(t + 900, p.exitAt - 300), p.off, t); // late: catch up on the track
        else {
          st.ramp = null; //                           joined after the drop: nothing on screen to keep continuous
          st.base = norm(p.off);
        }
        var from = t > p.t0 ? t : p.t0;
        st.fade = { t0: from, t1: from + (t > p.t0 + 200 ? 220 : 140), a: 0, b: 1 };
        setLabel();
        kick();
        return p;
      },
      rest: function (pocket) {
        pocket = Number(pocket);
        if (!(pocket >= 0 && pocket <= 36 && Math.floor(pocket) === pocket)) return api;
        var t = now(),
          p = st.plan;
        if (st.mode === "rest" && st.pocket === pocket) return api;
        if (p && p.pocket === pocket && st.mode !== "idle") {
          // the server's result: if the ball is still moving here, finish within 300 ms
          if (t < p.settleAt && !reduced()) st.warp = { a: t, b: t + 300, pa: t, pb: p.settleAt };
        } else {
          // a page opened on the result, or the server says otherwise: no plan, the ball simply sits there
          var was = st.mode === "spin" && p && t >= p.t0 ? 1 : 0;
          st.plan = null;
          st.key = "";
          st.warp = null;
          st.fade = was ? null : { t0: t, t1: t + 220, a: 0, b: 1 };
        }
        st.pocket = pocket;
        st.mode = "rest";
        setLabel();
        kick();
        return api;
      },
      destroy: function () {
        st.dead = true;
        if (st.raf) {
          if (win && win.cancelAnimationFrame) win.cancelAnimationFrame(st.raf);
          clearTimeout(st.raf);
        }
        clearTimeout(timer);
        st.raf = 0;
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        if (mq) {
          if (mq.removeEventListener) mq.removeEventListener("change", kick);
          else if (mq.removeListener) mq.removeListener(kick);
        }
        if (win && win.removeEventListener) win.removeEventListener("resize", relayout);
      },
      /** the per-viewer Quick spin toggle: true / false, or null to follow prefers-reduced-motion again */
      setReduced: function (on) {
        st.forced = on === true || on === false ? on : null;
        kick();
        return api;
      },
      /** a CSS 3D tilt (deg, 0 = top-down): set on the canvas (unless opts.applyTilt === false); hops lift toward the far side */
      setTilt: function (deg) {
        st.tilt = clamp(Number(deg) || 0, 0, 70);
        if (opts.applyTilt !== false && canvas && canvas.style) {
          canvas.style.transform = st.tilt ? "perspective(" + Math.round(Math.max(300, st.css || canvas.clientWidth || 400) * 2.6) + "px) rotateX(" + st.tilt + "deg)" : "";
          canvas.style.transformOrigin = "50% 55%";
        }
        kick();
        return api;
      },
      setPalette: function (p) {
        st.pal = paletteOf(p);
        relayout();
        return api;
      },
      resize: function () {
        relayout();
        return api;
      },
      /** what is on screen now: {mode, phase, pocket, round, rotor, plan} (readouts, tests) */
      state: function () {
        var t = now(),
          b = ballAt(t, {});
        return { mode: st.mode, phase: b ? b.phase : "idle", pocket: st.mode === "rest" ? st.pocket : null, round: st.plan ? st.plan.round : null, rotor: rotorAt(t), plan: st.plan };
      },
      /** draw once at a server time (tests, thumbnails); the wheel keeps its own clock otherwise */
      paint: function (siteNow) {
        paint(siteNow == null ? now() : Number(siteNow));
        return api;
      },
    };
    if (canvas && canvas.setAttribute) {
      canvas.setAttribute("role", "img");
      setLabel();
    }
    if (mq) {
      if (mq.addEventListener) mq.addEventListener("change", kick);
      else if (mq.addListener) mq.addListener(kick);
    }
    if (win && win.ResizeObserver && canvas && canvas.nodeType === 1) {
      ro = new win.ResizeObserver(function () {
        var css = canvas.clientWidth || 0;
        if (css && Math.round(css * Math.min(2, Math.max(1, win.devicePixelRatio || 1))) !== st.size) relayout();
      });
      ro.observe(canvas);
    } else if (win && win.addEventListener) win.addEventListener("resize", relayout);
    if (win && win.IntersectionObserver && canvas && canvas.nodeType === 1) {
      io = new win.IntersectionObserver(function (es) {
        st.onScreen = es.length ? es[es.length - 1].isIntersecting : true;
        if (st.onScreen) kick();
      });
      io.observe(canvas);
    }
    if (st.tilt) api.setTilt(st.tilt);
    kick();
    return api;
  }
  return {
    VERSION: VERSION,
    WHEEL: WHEEL,
    RED: RED,
    PITCH: PITCH,
    OMEGA: OMEGA,
    IDLE_PERIOD_MS: IDLE_PERIOD_MS,
    LEAD_MS: LEAD_MS,
    GEOM: GEOM,
    colorOf: colorOf,
    seedOf: seedOf,
    fnv1a: fnv1a,
    mulberry32: mulberry32,
    idleAngle: idleAngle,
    plan: plan,
    frame: frame,
    pocketAt: pocketAt,
    spinArgs: spinArgs,
    mount: mount,
    PALETTES: PALETTES,
    LABELS: LABELS,
    _rampTarget: rampTarget,
    _sim: { postSim: postSim, variantParams: variantParams, postTarget: postTarget, variantSeed: variantSeed },
  };
});
