// Staking fix plan (2026-10-19) D1 + P1.2: the daily APR ceiling (capital/vaults.js ceilingOn / ceilingDay / ceilingStep).
//   * D1 (the owner): ceil_apr 0 means NO ceiling - nothing skimmed, nothing given back, the cushion untouched, the stakers'
//     index follows the price; the high-water mark keeps TRACKING the price (ceilingOffStep, camfrog-bot 31c65d0), so the
//     ceiling switched back on caps only new highs. Not "cap = peak" (which would skim every gain above the peak).
//   * option A (the protocol cushion, built dark - ships OFF): the up day skims and records, a loss is covered from the
//     window's skims (oldest first, never more than the protocol holds), the peak is re-based (no double recovery), entries
//     age out, switch off = the old maths.
// The bit-for-bit parity with Pepe's cut-off is test/vault-ceiling-vectors.test.js.
//   NODE_PATH=G:/PATV/node_modules node --test test/capital-ceiling.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const V = require(path.join(__dirname, "..", "capital", "vaults"));

const DAY = 86400;
const T0 = 1792900800;                                  // a Monday 04:00 UTC-ish base
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
function book(holders, extra = {}) {
  const h = Object.assign({}, holders);
  const total = Object.values(h).reduce((s, x) => s + x, 0);
  return { v: { house: Object.assign({ total, holders: h }, extra), bank: { total: 1, holders: { protocol: 1 } }, mm: { total: 1, holders: { protocol: 1 } } },
           auto: { total: 0, holders: {} } };
}
const stakers = (st) => Object.entries(st.holders).filter(([k]) => k !== "protocol").reduce((s, [, x]) => s + x, 0);
const cfg = (o = {}) => Object.assign({ ceil_apr: 0.25, ceil_cushion: 0, ceil_cushion_days: 8 }, o);
const day = (d, pa, pb, now, c) => V.ceilingDay(d, { ts: now - DAY, price: { house: pa, bank: 1, mm: 1 } }, { house: pb, bank: 1, mm: 1 }, now, c);

test("D1: ceil_apr 0 (or anything not a positive number) is NO ceiling - nothing moves, only the high-water mark tracks the price", () => {
  for (const off of [0, "0", 0.0, null, undefined, "", -0.25, NaN, Infinity, "off"]) assert.equal(V.ceilingOn({ ceil_apr: off }), false, String(off));
  for (const on of [0.25, "0.25", 2, 1e-9]) assert.equal(V.ceilingOn({ ceil_apr: on }), true, String(on));
  // a +30% day: with the ceiling on it would skim almost all of it; off, the holders and the cushion are exactly as they were
  const d = book({ protocol: 500, s1: 300, auto: 200 }, { peak_price: 1.0, cushion: [[T0 - 2 * DAY, 5]] });
  const keep = (x) => JSON.stringify([x.v.house.holders, x.v.house.total, x.v.house.cushion, x.v.bank.holders, x.v.mm.holders, x.auto]);
  const before = keep(d);
  const r = day(d, 1.0, 1.3, T0, cfg({ ceil_apr: 0, ceil_cushion: 1 }));
  assert.equal(keep(d), before, "holders and cushion untouched");
  assert.equal(d.v.house.peak_price, 1.3, "the high-water mark TRACKS the price (camfrog-bot 31c65d0: ceiling_off_step)");
  assert.equal(r.peak_off.house, 1.3);
  assert.deepEqual(r.steps, {}, "no step record (the vectors list only the vaults whose ceiling ran)");
  assert.deepEqual(r.F, {});
  assert.deepEqual(r.skim, {});
  // ...and a losing day with the cushion switched on gives nothing back either (the cushion only works under a ceiling); the
  // mark keeps the high
  const r2 = day(d, 1.3, 1.1, T0 + DAY, cfg({ ceil_apr: 0, ceil_cushion: 1 }));
  assert.equal(keep(d), before);
  assert.deepEqual(r2.giveback, {});
  assert.equal(d.v.house.peak_price, 1.3, "max(max(pa, peak), pb): the high stays through the loss");
  assert.equal(V.ceilingOffStep({ peak_price: 0.9 }, 1.2, 1.1), 1.2, "max(pa, peak) first: yesterday's price above an old peak");
  assert.equal(V.ceilingOffStep({}, 1.2, 1.25), 1.25, "no peak yet: from pa");
  // the stakers' index follows the vault's price exactly (f = 1)
  const si = V.stakerIndex({ price: { house: 1.0, bank: 1, mm: 1 }, staker_index: { house: 1.0, bank: 1, mm: 1 } }, { house: 1.3, bank: 1, mm: 1 }, r.F);
  assert.equal(si.house, 1.3);
});

test("D1 then back on (the review of d366b94): 3.0 with the ceiling off -> a Monday draw to 2.9 -> on again -> back to 3.0 skims nothing", () => {
  const d = book({ protocol: 500, s1: 300, auto: 200 }, { peak_price: 2.0039 });
  day(d, 2.0, 3.0, T0, cfg({ ceil_apr: 0 }));                       // off: up to 3.0
  day(d, 3.0, 2.9, T0 + DAY, cfg({ ceil_apr: 0 }));                 // off: the draw
  const S1 = stakers(d.v.house);
  const r = day(d, 2.9, 3.0, T0 + 2 * DAY, cfg());                 // back on: the recovery to the high reached while off
  assert.equal(stakers(d.v.house), S1, "the recovery isn't skimmed");
  assert.deepEqual(r.skim, {});
  assert.ok(close(d.v.house.peak_price, 3.0));
  // growth ABOVE that high is capped from it (+25% APR for the day)
  const r2 = day(d, 3.0, 3.3, T0 + 3 * DAY, cfg());
  assert.ok(close(r2.steps.house.peak, 3.0) && close(r2.steps.house.cap, 3.0 * Math.pow(1.25, 1 / 365)));
  assert.ok(r2.skim.house > 0);
  // the replay over snapshots does the same, each cut-off by its own recorded rule (ceil_apr on the snapshot, else the default)
  const eps = [{ ts: T0 - DAY, price: { house: 2.0 } }, { ts: T0, price: { house: 3.0 }, ceil_apr: 0 }, { ts: T0 + DAY, price: { house: 2.9 }, ceil_apr: 0 },
               { ts: T0 + 2 * DAY, price: { house: 3.0 }, ceil_apr: 0.25 }];
  const rp = V.replayCeiling(eps, 0.25);
  assert.equal(rp.peak.house, 3.0, "the off days tracked the mark");
  assert.deepEqual(rp.skims, [], "no skim on the off days nor on the recovery");
  const old = V.replayCeiling(eps.map((e) => { const x = Object.assign({}, e); delete x.ceil_apr; return x; }), 0.25);
  assert.equal(old.skims.length, 1, "snapshots with no rule replay by the default (here: on - the first up day skims)");
  assert.equal(V.replayCeiling(eps.map((e) => Object.assign({}, e, { ceil_apr: null })), 0.25).skims.length, 0, "a recorded null reads as off (rule_at)");
  // no ceil given: an unrecorded snapshot replays at REPLAY_CEIL = 25% (pepe_stakingreplay.DEFAULT_CEIL), not as off - the
  // cushion backfill passes it rather than today's setting (0 once the ceiling is off)
  assert.equal(V.REPLAY_CEIL, 0.25);
  const unrec = eps.map((e) => { const x = Object.assign({}, e); delete x.ceil_apr; return x; });
  assert.deepEqual(V.replayCeiling(unrec), old, "the default is the 25% the old cut-offs ran with");
  assert.equal(V.replayCeiling(unrec, 0).skims.length, 0, "today's 0 would have replayed them as off");
});

test("the ceiling on: a gain above the cap is skimmed to the cap; a loss passes through; 0 never means cap = peak", () => {
  const d = book({ protocol: 500, s1: 300, auto: 200 });
  const r = day(d, 1.0, 1.3, T0, cfg());
  const st = d.v.house;
  const cap = 1.0 * Math.pow(1.25, 1 / 365);
  assert.ok(close(r.steps.house.cap, cap));
  assert.ok(close(stakers(st) * 1.3, 500 * cap), "stakers' value = their shares x the cap price");
  assert.ok(close(st.holders.s1 / st.holders.auto, 1.5), "pro rata, the Auto sleeve included");
  assert.ok(close(st.total, 1000), "total shares unchanged (the price doesn't move)");
  assert.equal(st.peak_price, cap);
  assert.equal(st.cushion.length, 1, "the skim is recorded with the cushion OFF too");
  assert.ok(close(st.cushion[0][1], r.skim.house));
  // a loss: nothing moves with the switch off; the peak stays (the stakers recover uncapped up to it)
  const h0 = JSON.stringify(st.holders);
  const r2 = day(d, 1.3, 1.2, T0 + DAY, cfg());
  assert.equal(JSON.stringify(st.holders), h0);
  assert.deepEqual(r2.giveback, {});
  assert.equal(st.peak_price, Math.max(1.3, Math.min(1.2, r2.steps.house.cap)), "peak = max(pa, min(pb, cap)) as before");
});

test("option A (the cushion ON): a loss is covered from the window's skims - stakers' value unchanged, total unchanged, peak re-based", () => {
  const d = book({ protocol: 500, s1: 300, auto: 200 });
  day(d, 1.0, 1.3, T0, cfg());                                   // skim day: the cushion fills
  const st = d.v.house;
  const S0 = stakers(st), tot0 = st.total;
  const r = day(d, 1.3, 1.25, T0 + DAY, cfg({ ceil_cushion: 1 }));   // a 3.8% loss
  const g = r.giveback.house;
  assert.ok(g && g.shares > 0, "gave back");
  assert.ok(close(stakers(st) * 1.25, S0 * 1.3), "the stakers' value is where it was (pa)");
  assert.ok(close(st.total, tot0), "total shares unchanged");
  assert.ok(close(g.covered, 1), "fully covered");
  assert.ok(close(st.peak_price, 1.25), "peak re-based to pb (the covered loss can't be recovered uncapped)");
  assert.ok(g.shares <= g.cushion_before + 1e-9, "never more than the cushion");
});

test("option A: a partial cushion, a protocol short of shares, expiry after the window (oldest first)", () => {
  // partial: a tiny cushion covers part of the loss; the peak formula with c < 1
  const d = book({ protocol: 500, s1: 500 }, { peak_price: 1.3, cushion: [[T0 - DAY, 1.0]] });
  const r = day(d, 1.3, 1.17, T0, cfg({ ceil_cushion: 1 }));
  const g = r.giveback.house;
  assert.ok(close(g.shares, 1.0), "the whole cushion");
  assert.ok(g.covered > 0 && g.covered < 1);
  assert.ok(close(d.v.house.peak_price, 1.3 * 1.17 / (1.17 + g.covered * (1.3 - 1.17))));
  assert.equal(d.v.house.cushion.length, 0, "used up");
  // a protocol short of shares: g is capped at what it holds
  const d2 = book({ protocol: 0.5, s1: 1000 }, { cushion: [[T0 - DAY, 50]] });
  const r2 = day(d2, 1.0, 0.9, T0, cfg({ ceil_cushion: 1 }));
  assert.ok(close(r2.giveback.house.shares, 0.5), "only the protocol's 0.5 shares");
  assert.ok(d2.v.house.holders.protocol >= -1e-9);
  // expiry: an entry older than the window can't be used (and the oldest in the window goes first)
  const d3 = book({ protocol: 500, s1: 500 }, { cushion: [[T0 - 9 * DAY, 40], [T0 - 3 * DAY, 2], [T0 - DAY, 3]] });
  const r3 = day(d3, 1.0, 0.993, T0, cfg({ ceil_cushion: 1, ceil_cushion_days: 8 }));   // need = 500 x 0.007 / 0.993 = 3.52
  assert.ok(close(r3.giveback.house.cushion_before, 5), "only the 2 + 3 inside 8 days");
  assert.ok(close(r3.giveback.house.shares, 500 * 0.007 / 0.993));
  assert.deepEqual(d3.v.house.cushion.map((e) => e[0]), [T0 - 9 * DAY, T0 - DAY], "the 3-day-old entry went first; the 9-day-old one is kept (31-day retention) but unused");
  assert.ok(close(d3.v.house.cushion[1][1], 5 - 500 * 0.007 / 0.993), "the newer one partly used");
  assert.equal(d3.v.house.cushion[0][1], 40);
});

test("the cushion switch off is the old maths, and its window reads like Pepe's (on = int(x) > 0, days 0..31, else 8)", () => {
  const a = book({ protocol: 500, s1: 300, auto: 200 }, { peak_price: 1.4, cushion: [[T0 - DAY, 30]] });
  const b = JSON.parse(JSON.stringify(a));
  day(a, 1.4, 1.2, T0, cfg({ ceil_cushion: 0 }));
  // the old code: no skim (a loss), peak = max(peak, min(pb, cap)), holders untouched
  assert.equal(JSON.stringify(a.v.house.holders), JSON.stringify(b.v.house.holders));
  assert.equal(a.v.house.peak_price, 1.4);
  assert.deepEqual(V.cushionCfg({ ceil_cushion: 0.9 }), { on: false, days: 8 });
  assert.deepEqual(V.cushionCfg({ ceil_cushion: 1, ceil_cushion_days: 99 }), { on: true, days: 31 });
  assert.deepEqual(V.cushionCfg({ ceil_cushion: "1", ceil_cushion_days: -2 }), { on: true, days: 8 });
  assert.deepEqual(V.cushionCfg({ ceil_cushion_days: 0 }), { on: false, days: 0 });
});

test("the prod shape: House up ~1.5%/day for 6 days, then -3.04% on the Monday draw - with the cushion the stakers are flat on the loss day", () => {
  for (const on of [0, 1]) {
    const d = book({ protocol: 4600, s1: 3000, auto: 2400 });
    let p = 1.0, now = T0;
    for (let i = 0; i < 6; i++) { const nb = p * 1.015; day(d, p, nb, now, cfg({ ceil_cushion: on })); p = nb; now += DAY; }
    const S0 = stakers(d.v.house);
    const pb = p * (1 - 0.0304);
    day(d, p, pb, now, cfg({ ceil_cushion: on }));
    const before = S0 * p, after = stakers(d.v.house) * pb;
    if (on) assert.ok(close(after, before), `cushion on: the stakers' value holds (${before} -> ${after})`);
    else assert.ok(close(after / before, 1 - 0.0304), "cushion off: the full 3.04% lands on them");
  }
});
