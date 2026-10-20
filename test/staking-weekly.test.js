// Staking fix plan (2026-10-19) + the owner's decisions that day - the weekly payout:
//   * D2: the weekly bonus cap is its own knob (wf_staker_cap_pct; 0 = NO cap -> the stakers' full 20%), and the daily
//     ceiling's knob (VAULT_CEIL_APR / vault_ceil_apr) no longer sets it; D2's safeguard (camfrog-bot 31c65d0): with no cap,
//     a week that isn't WHOLLY time-weighted (patDaysWhole: its bucket and an older one) is paid under the 25% reference cap;
//   * P2.1 (required with D2): the stakers' share is split by PAT-days - capital/vaults.js accruePatDays on the cut-off, policy/
//     engines.js stakers() / patDaysAvg in the waterfall: a stake at the boundary gets 0, a full week gets its full share, a
//     stash that left mid-week its days' share; the buckets (last settled boundary, boundary] count; no bucket = the snapshot;
//   * P2.2: Auto deposits under the staker limit (autoCappedLegs = pepe_vaults.auto_capped_legs), behind a switch (OFF);
//   * the monitoring: what a 25% cap would have paid each week (capital/watch.js capTrack); the owner card's commands.
// The bit-for-bit parity with Pepe is in test/policy-vectors.test.js (the waterfall) and test/vault-ceiling-vectors.test.js
// (the PAT-days buckets).
//   NODE_PATH=G:/PATV/node_modules node --test test/staking-weekly.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const V = require(path.join(__dirname, "..", "capital", "vaults"));
const E = require(path.join(__dirname, "..", "policy", "engines"));
const W = require(path.join(__dirname, "..", "capital", "watch"));

const DAY = 86400;
const B = E.weekStart(Date.UTC(2026, 9, 26, 5) / 1000, 4);          // Monday 2026-10-26 04:00 UTC
const NOW = B + 300;

/** a waterfall input: the House with 10M surplus (20% = 2M for stakers), stashes 1 and 2 holding 5M each right now */
function inputs({ cfg = {}, consts = {}, patDays = null, journal = [{ eid: "W" + new Date((B - 7 * DAY) * 1000).toISOString().slice(0, 10), boundary: B - 7 * DAY, state: "done" }] } = {}) {
  const house = { total: 15e6, holders: [["protocol", 10e6], ["s1", 2.5e6], ["s2", 2.5e6]], basis: 10e6 };
  if (patDays) house.pat_days = patDays;
  return { kind: "epoch", now: NOW, eid: E.epochId(NOW, 4), cfg, consts, flags: { layers: true, tr_live: true },
           pools: { reserve: 50e6, jackpot: 30e6, bank: 0, mm: 0, incentives: 0 }, prices: { house: 2.0, bank: 1, mm: 1, auto: 1 },
           navs: { house: 30e6 }, bank_nav: 0, mm_seeds: 0, vaults: { house }, auto: { total: 0, holders: [] },
           stashes: { 1: true, 2: true, 3: true }, journal, bank_lent: [], fed_loans: [] };
}
const paidTo = (plan) => Object.fromEntries(plan.legs.filter((l) => l.why === "waterfall stakers").map((l) => [l.dst.slice(6), l.amt]));

test("D2: wf_staker_cap_pct 0 = no cap (the stakers' full 20%); 25 caps; the daily ceiling's knob no longer sets it", () => {
  const capped = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 25 } }));
  const h = capped.vaults.house;
  assert.equal(h.surplus, 10e6);
  assert.equal(h.stakers_share, 2e6);
  assert.equal(h.apr_cap, Math.trunc(10e6 * 0.25 * 7 / 365), "25% APR on the 10M staked, 7 days");
  assert.equal(h.stakers, 2 * Math.trunc(h.apr_cap * 5e6 / 10e6));
  // a WHOLLY time-weighted week (the PAT-days ran the week before too - patDaysWhole): s1 and s2 held 5M each all week
  const whole = [[String(B - 7 * DAY), [["1", 1]]], [String(B), [["1", 35e6], ["2", 35e6]]]];
  const open = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: whole }));
  assert.equal(open.vaults.house.apr_cap, 2e6, "0 = no cap: the cap is the whole share");
  assert.equal(open.vaults.house.stakers, 2e6, "the stakers get their full 20%");
  assert.deepEqual(paidTo(open), { 1: 1e6, 2: 1e6 });
  // D2's safeguard (camfrog-bot 31c65d0): no cap in force but no PAT-days at all (the snapshot) - the 25% reference cap
  const refc = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 0 } }));
  assert.equal(refc.vaults.house.apr_cap, h.apr_cap, "the snapshot week is held to 25% APR on the 10M staked");
  // the daily ceiling off (VAULT_CEIL_APR 0) leaves the weekly cap at its own 25%
  const ceilOff = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 25 }, consts: { VAULT_CEIL_APR: 0 } }));
  assert.equal(ceilOff.vaults.house.apr_cap, h.apr_cap);
  assert.equal(E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 50 } })).vaults.house.apr_cap, Math.trunc(10e6 * 0.5 * 7 / 365));
  // PO-0b (D-8): the code defaults are prod's values since the owner's 2026-10-19 decision - no weekly cap, no daily ceiling
  assert.equal(E.DEFAULTS.wf_staker_cap_pct, 0, "the default is 0 = no cap (D-8)");
  assert.equal(E.CONSTS.VAULT_CEIL_APR, 0, "VAULT_CEIL_APR's default is 0 (D-8)");
  const dflt = E.planEpoch(inputs({ patDays: whole }));
  assert.equal(dflt.vaults.house.stakers, 2e6, "with no value pushed, the code default pays the full share (no cap)");
});

test("P2.1: the split is by PAT-days - a stake at the boundary gets 0, a full week its full share, a mid-week leaver its days", () => {
  // s1 held 5M all week (35M PAT-days); s2 staked at the Monday cut-off (holds 5M now, 0 PAT-days); s3 held 5M Mon-Thu, then left
  // (the bucket of the week before exists: the week is wholly time-weighted, so no cap means no cap - D2's safeguard aside)
  const pd = [[String(B - 7 * DAY), [["1", 1]]], [String(B), [["1", 35e6], ["3", 15e6]]]];
  const plan = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: pd }));
  const h = plan.vaults.house;
  assert.ok(Math.abs(h.staked - Math.trunc((35e6 + 15e6) / 7)) <= 1, "staked = the average stake over the week");
  const paid = paidTo(plan);
  assert.equal(paid[2], undefined, "the boundary stake earns nothing this week");
  assert.equal(paid[1], Math.trunc(2e6 * 5e6 / (50e6 / 7)), "the full week: 70%");
  assert.equal(paid[3], Math.trunc(2e6 * (15e6 / 7) / (50e6 / 7)), "Mon-Thu: 30%, though it holds nothing now");
  // with a cap, the cap is 25% APR on the PAT-days (the average stake x days / 365)
  const capped = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 25 }, patDays: pd }));
  assert.equal(capped.vaults.house.apr_cap, Math.trunc((50e6 / 7) * 0.25 * 7 / 365));
  // no bucket for this boundary -> the snapshot (s1 and s2 equally) - under the 25% reference cap (D2's safeguard)
  const snap = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: [[String(B - 7 * DAY), [["1", 35e6]]]] }));
  const ref = Math.trunc(10e6 * 0.25 * 7 / 365);
  assert.equal(snap.vaults.house.apr_cap, ref);
  assert.deepEqual(paidTo(snap), { 1: Math.trunc(ref * 5e6 / 10e6), 2: Math.trunc(ref * 5e6 / 10e6) });
  // a closed stash's PAT-days share rejoins the surplus
  const closed = inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: pd });
  closed.stashes["3"] = false;
  assert.deepEqual(paidTo(E.planEpoch(closed)), { 1: 2e6 });
});

test("P2.1: patDaysAvg sums the buckets (last settled boundary, boundary] (a missed week), reads 's<id>' as the id", () => {
  const st = { pat_days: [[String(B - 7 * DAY), [["1", 7e6], ["s2", 7e6]]], [String(B), [["1", 7e6]]], [String(B - 14 * DAY), [["1", 99e6]]]] };
  const two = E.patDaysAvg(st, B, B - 14 * DAY, 14);
  assert.deepEqual([...two.entries()], [["1", 1e6], ["2", 0.5e6]], "two weeks: (B-14d, B]");
  const one = E.patDaysAvg(st, B, B - 7 * DAY, 7);
  assert.deepEqual([...one.entries()], [["1", 1e6]]);
  assert.deepEqual([...E.patDaysAvg(st, B, 0, 7).entries()], [["1", 1e6]], "no earlier epoch: this boundary's bucket only");
  assert.equal(E.patDaysAvg({ pat_days: [[String(B - 7 * DAY), [["1", 1]]]] }, B, 0, 7), null, "no bucket for B -> null (snapshot)");
  assert.equal(E.patDaysAvg({}, B, 0, 7), null);
});

test("P2.1: the cut-off accrues each stash's look-through stake x days into the bucket of the Monday that settles them", () => {
  const d = { v: { house: { total: 200, holders: { protocol: 100, s1: 50, auto: 50 } }, bank: { total: 10, holders: { protocol: 10 } },
                   mm: { total: 10, holders: { protocol: 10 } } },
              auto: { total: 100, holders: { s2: 60, s3: 40 } } };
  const p = { house: 2.0, bank: 1, mm: 1 };
  // Saturday 04:00 -> Monday 04:00:05: two days into B's bucket, 5 seconds into the next week's
  const added = V.accruePatDays(d, p, B - 2 * DAY, B + 5, 4);
  const pd = d.v.house.pat_days;
  assert.deepEqual(Object.keys(pd).sort(), [String(B), String(B + 7 * DAY)]);
  assert.equal(pd[String(B)]["1"], 100 * 2, "s1: 50 shares x 2.0 x 2 days");
  assert.equal(pd[String(B)]["2"], 60 / 100 * 50 * 2.0 * 2, "s2 through the Auto sleeve");
  assert.equal(pd[String(B)]["3"], 40 / 100 * 50 * 2.0 * 2);
  assert.ok(Math.abs(pd[String(B + 7 * DAY)]["1"] - 100 * 5 / DAY) < 1e-9);
  assert.ok(added.house[String(B)] > 0);
  assert.deepEqual(d.v.bank.pat_days, { [String(B)]: {}, [String(B + 7 * DAY)]: {} }, "a touched bucket exists even with no stakers");
  // the 4 newest buckets stay
  for (let w = 1; w <= 5; w++) V.accruePatDays(d, p, B + w * 7 * DAY, B + w * 7 * DAY + DAY, 4);
  assert.equal(Object.keys(d.v.house.pat_days).length, V.PD_KEEP);
  assert.equal(Math.min(...Object.keys(d.v.house.pat_days).map(Number)), B + 3 * 7 * DAY);
  // what /staking shows for "this week so far"
  const now = V.patDaysNow(d, B + 5 * 7 * DAY + 3600, 4);
  assert.equal(now.boundary, B + 6 * 7 * DAY);
  assert.ok(now.vaults.house && now.vaults.house.total > 0);
});

test("P2.2: Auto deposits under the staker limit - autoCappedLegs (Pepe's auto_capped_legs) and its switch (OFF by default)", () => {
  const nav = { bank: 1000, house: 1000, mm: 1000 }, staked = { bank: 400, house: 600, mm: 100 };
  const legs = [["bank", 300], ["house", 300], ["mm", 300]];
  // bank: min(300, int(0.5 x 1300 - 400) = 250); house: 50 (stakers already own 60%); mm takes the 300 cut (room for it)
  assert.deepEqual(V.autoCappedLegs(legs, nav, staked, 0.5), [["bank", 250], ["house", 50], ["mm", 600]]);
  // every vault at its limit: nothing goes in, the whole deposit is refunded (executeOne: amount - the legs)
  assert.deepEqual(V.autoCappedLegs(legs, nav, { bank: 900, house: 900, mm: 900 }, 0.5), [["bank", 0], ["house", 0], ["mm", 0]]);
  // room everywhere: unchanged
  assert.deepEqual(V.autoCappedLegs(legs, nav, { bank: 0, house: 0, mm: 0 }, 0.5), legs);
  for (const off of [0, "0", 0.7, null, undefined, "off"]) assert.equal(V.autoCapOn({ auto_staker_cap: off }), false, String(off));
  assert.equal(V.autoCapOn({ auto_staker_cap: 1 }), true);
  assert.equal(require(path.join(__dirname, "..", "capital", "core")).DEFAULT_CFG.auto_staker_cap, 0, "ships OFF");
});

test("monitoring (D2): what a 25% cap would have paid each settled week - Pepe's own figure when he sends it", () => {
  const c = { waterfall: [
    { epoch: "W2026-10-19", state: "done", days: 7, staker_share: 0.2, vaults: {
      house: { surplus: 10e6, stakers_share: 2e6, staked: 10e6, apr_cap: 2e6, stakers: 1999998, stakers_n: 2, fed: 4e6, incentives: 4e6 },
      bank: { surplus: 1e6, stakers_share: 2e5, staked: 1e6, apr_cap: 2e5, stakers: 2e5, stakers_n: 1, fed: 4e5, incentives: 4e5, would_cap25: 4790, weighting: "pat_days" } } },
    { epoch: "W2026-10-26", state: "moving", days: 7, vaults: {} },
  ] };
  const rows = W.capTrack(c);
  assert.equal(rows.length, 1, "settled weeks only");
  const r = rows[0];
  assert.equal(r.vaults.house.would25, Math.trunc(10e6 * 0.25 * 7 / 365), "computed: min(pool, int(staked x 25% x days / 365))");
  assert.equal(r.vaults.bank.would25, 4790, "Pepe's own figure wins");
  assert.equal(r.vaults.bank.weighting, "pat_days");
  assert.equal(r.total.paid, 1999998 + 2e5);
  assert.equal(r.total.over, (1999998 - r.vaults.house.would25) + (2e5 - 4790));
});

test("the owner card's command: only the weekly cap (0 = none) goes to Pepe; his admin-panel knobs are refused, never sent", () => {
  assert.deepEqual(W.commandFor("bonus_cap", "0").words, ["set", "wf_staker_cap_pct", "0"]);
  assert.match(W.commandFor("bonus_cap", "0").label, /OFF/);
  assert.deepEqual(W.commandFor("bonus_cap", "25").words, ["set", "wf_staker_cap_pct", "25"]);
  assert.ok(W.commandFor("bonus_cap", "101").error);
  assert.ok(W.commandFor("bonus_cap", "-1").error);
  // the 2026-10-19 review: Pepe's !econ set doesn't take these (they're SINK_RATES knobs; vault_ceil_apr is a FRACTION there,
  // so "25" would be 2500%) - the card shows them and where to set them, and the API refuses them with code "panel"
  for (const [op, knob] of [["ceiling", "vault_ceil_apr"], ["cushion", "vault_ceil_cushion"], ["cushion_days", "vault_ceil_cushion_days"], ["auto_cap", "vault_auto_staker_cap"]]) {
    const r = W.commandFor(op, op === "ceiling" ? "0" : "on");
    assert.equal(r.words, undefined, `${op} is never sent`);
    assert.equal(r.code, "panel");
    assert.match(r.error, new RegExp(knob));
  }
  assert.deepEqual(Object.values(W.KEYS), ["wf_staker_cap_pct"], "the only key the site sends to !econ set");
  assert.ok(W.commandFor("nope", "1").error);
});

test("the cost backfill trusts a row only when the queue is whole and the holding is explained by the requests (else partial)", () => {
  const p1 = { bank: 1.0, house: 2.0, mm: 1.0, auto: 1.0 }, p2 = { bank: 1.0, house: 2.5, mm: 1.0, auto: 1.0 };
  const q = (id, stash, kind, vault, done, legs, prices, extra) => Object.assign({ id, stash, kind, vault, done, ts: done - 60, state: "done", legs, prices }, extra || {});
  const book = (holders, queue, epochs) => ({ v: { house: { total: 1e6, holders }, bank: { total: 0, holders: {} }, mm: { total: 0, holders: {} } },
                                              auto: { total: 0, holders: {} }, queue, epochs });
  const eps = [{ ts: B - 10 * DAY }, { ts: B }];
  // s1: 1,000 then 500 more at a higher price; then a ceiling skim took 1% of its shares (skims only ever lower them) - whole.
  // s2: holds 900 shares but its requests only explain 400 (it held 500 from before the history) - partial.
  // s3: staked 1,000, the skim took a little, then it left with all of its shares - whole, P/L = out - in.
  const s1 = (1000 / 2.0 + 500 / 2.5) * 0.99, s3burn = 500 * 0.99;
  const d = book({ protocol: 1e5, s1, s2: 900 }, {
    a: q("a", "1", "deposit", "house", B - 9 * DAY, { house: 1000 }, p1), b: q("b", "1", "deposit", "house", B - 5 * DAY, { house: 500 }, p2),
    c: q("c", "2", "deposit", "house", B - 8 * DAY, { house: 800 }, p1),
    e: q("e", "3", "deposit", "house", B - 9 * DAY, { house: 1000 }, p1), f: q("f", "3", "withdraw", "house", B - 2 * DAY, { house: Math.trunc(s3burn * 2.5) }, p2, { burn: s3burn }) }, eps);
  const r = V.backfillCost(d);
  assert.equal(r.whole, true);
  assert.deepEqual(r.partial, [["2", "house"]]);
  assert.deepEqual(d.cost["1"].house, { in: 1500, out: 0 });
  assert.equal(d.cost["2"].house.partial, 1);
  assert.deepEqual(d.cost["3"].house, { in: 1000, out: Math.trunc(s3burn * 2.5) });
  // the same book after the 30-day prune began (the newest snapshot more than 30 days after the first): nothing is trusted
  const late = book({ protocol: 1e5, s1 }, { b: q("b", "1", "deposit", "house", B - 5 * DAY, { house: 500 }, p2) }, [{ ts: B - 40 * DAY }, { ts: B }]);
  assert.equal(V.queueWhole(late), false);
  const rl = V.backfillCost(late);
  assert.equal(rl.whole, false);
  assert.equal(late.cost["1"].house.partial, 1, "its 10-05 stake is gone from the queue: unknown, not a gain");
  // a live-path row started on top of an older holding is partial until the backfill clears it
  const live = book({ protocol: 1e5, s1: 500 }, {}, eps);
  const qq = q("z", "1", "deposit", "house", B, { house: 1000 }, p1);
  V.addCost(live, qq, true);
  assert.equal(live.cost["1"].house.partial, 1);
  const fresh = book({ protocol: 1e5 }, {}, eps);
  V.addCost(fresh, Object.assign({}, qq, { costed: 0 }), false);
  assert.equal(fresh.cost["1"].house.partial, undefined, "a first stake: whole from the start");
  V.addCost(fresh, q("y", "1", "withdraw", "bank", B, { bank: 10 }, p1, { burn: 10 }), false);
  assert.equal(fresh.cost["1"].bank.partial, 1, "a withdrawal with no row: the stake it takes from predates the history");
});

test("D2's safeguard: a week is whole only with its bucket AND an older one (Pepe's bucket rule, camfrog-bot 31c65d0)", () => {
  // policy/engines.patDaysWhole on the inputs' lists = pepe_vaults.pat_days_whole (the bot's treasury_test cases)
  const L = (...ks) => ({ pat_days: ks.map((k) => [String(k), []]) });
  assert.equal(E.patDaysWhole(L(B, B - 7 * DAY), B, 0), true, "this week's bucket and an older one");
  assert.equal(E.patDaysWhole({ pat_days: [[String(B), [["1", 5]]]] }, B, 0), false, "only this week's: the PAT-days began mid-week");
  assert.equal(E.patDaysWhole({ pat_days: [[String(B - 7 * DAY), [["1", 5]]]] }, B, 0), false, "no bucket for this week");
  assert.equal(E.patDaysWhole({}, B, 0), false);
  assert.equal(E.patDaysWhole(L(B, B - 7 * DAY, B - 14 * DAY), B, B - 14 * DAY), true, "a missed Monday: a bucket older than the first week it sums");
  assert.equal(E.patDaysWhole(L(B, B - 7 * DAY), B, B - 14 * DAY), false, "...or not (the oldest summed week's start isn't covered)");
  // the site's book (pdWhole / pdPartial: the same rule on {bucket: {stash: PAT-days}}), the vaults that have this week's bucket
  const d = { v: { house: { total: 200, holders: { protocol: 100, s1: 100 } }, bank: { total: 1, holders: { protocol: 1 } }, mm: { total: 1, holders: { protocol: 1 } } },
              auto: { total: 0, holders: {} } };
  assert.equal(V.pdPartial(d, B), true, "no PAT-days yet: partial (the waterfall uses the snapshot - under the reference cap)");
  const p = { house: 1, bank: 1, mm: 1 };
  V.accruePatDays(d, p, B - 2 * DAY, B - DAY, 4);                 // the deploy's first cut-off accrued from Saturday
  d.pd_from = B - 2 * DAY;
  assert.equal(V.pdWhole(d.v.house, B, B - 7 * DAY), false);
  assert.equal(V.pdPartial(d, B, B - 7 * DAY), true, "the week [B - 7 d, B) started before the PAT-days did");
  V.accruePatDays(d, p, B - DAY, B + 5, 4);                        // the Monday cut-off: into B and 5 s of the next week
  assert.equal(V.pdPartial(d, B + 7 * DAY, B), false, "the next week is whole (B's bucket is older than it)");
  // the one case the old pd_from rule called whole: the first interval began at the week's OWN Monday cut-off (a few seconds
  // in) - no bucket older than the week, so Pepe caps it (one extra week under the reference cap)
  const e = JSON.parse(JSON.stringify(d));
  for (const v of V.VAULTS) delete e.v[v].pat_days;
  e.pd_from = B - 7 * DAY + 5;
  V.accruePatDays(e, p, B - 7 * DAY + 5, B + 5, 4);
  assert.deepEqual(Object.keys(e.v.house.pat_days).sort(), [String(B), String(B + 7 * DAY)]);
  assert.equal(V.pdPartial(e, B, B - 7 * DAY), true, "Pepe's bucket rule: not whole (the old pd_from + PD_SLACK rule said whole)");
  // a missing bucket for the week (the cut-off failed all week) is partial however early the PAT-days began
  const m = JSON.parse(JSON.stringify(d));
  for (const v of V.VAULTS) delete m.v[v].pat_days[String(B)];
  assert.equal(V.pdPartial(m, B, B - 7 * DAY), true, "no vault has the week's bucket");
  // this week (the card / /staking) with the last settled boundary from Pepe's records
  const c = { waterfall: [{ epoch: "W" + new Date((B - 7 * DAY) * 1000).toISOString().slice(0, 10), boundary: B - 7 * DAY, state: "done" },
                          { epoch: "W" + new Date(B * 1000).toISOString().slice(0, 10), boundary: B, state: "moving" }] };
  assert.equal(V.lastSettled(c), B - 7 * DAY, "the newest DONE record");
  assert.equal(V.lastSettled(c, c.waterfall[0].epoch), 0, "...other than the epoch asked about");
  // a tagged re-run ("W...-r1", the staging rehearsal) counts in Pepe's lb (_tr_last_boundary / _vault_pd_week take every done
  // journal record): waterfallFrom drops it from cfg.waterfall, so putConfig keeps every done record's boundary in wf_settled
  const raw = c.waterfall.concat([{ epoch: "W" + new Date(B * 1000).toISOString().slice(0, 10) + "-r1", boundary: B, state: "done" },
                                  { epoch: "W2026-01-05-r2", boundary: B + 7 * DAY, state: "moving" }]);
  const cleaned = { waterfall: V.waterfallFrom({ waterfall: raw }) };
  assert.equal(cleaned.waterfall.some((r) => /-r\d$/.test(r.epoch)), false, "/staking's list keeps the plain ids only");
  assert.equal(V.lastSettled(cleaned), B - 7 * DAY, "the cleaned list alone misses the re-run (the review's 2026-10-19 finding)");
  const pushed = Object.assign({}, cleaned, { wf_settled: V.settledFrom(raw) });
  assert.deepEqual(pushed.wf_settled.map((r) => r.epoch), [c.waterfall[0].epoch, raw[2].epoch], "every DONE record, any id; not the moving one");
  assert.equal(V.lastSettled(pushed), B, "the re-run's boundary, as Pepe's journal");
  assert.equal(V.lastSettled(pushed, raw[2].epoch), B - 7 * DAY, "...except the re-run itself");
  assert.deepEqual(V.settledFrom(null), []);
  assert.deepEqual(V.settledFrom([null, { state: "done" }, { state: "done", boundary: "x" }]), [], "no boundary: nothing");
  const now = V.patDaysNow(d, B - DAY / 2, 4, V.lastSettled(c));
  assert.equal(now.partial, true);
  assert.equal(now.from, B - 2 * DAY);
  assert.equal(V.patDaysNow(d, B + DAY, 4, B).partial, false);
});

test("D2's safeguard in the waterfall: no cap in force + a week not wholly time-weighted -> the 25% reference cap (Pepe's _tr_plan)", () => {
  // s1 / s2 held 5M each all week, s9 staked 5M at the cut-off before the payout (no PAT-days) - the PAT-days began mid-week
  const partial = [[String(B), [["1", 35e6], ["2", 35e6]]]];
  const inp = inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: partial });
  inp.vaults.house.holders.push(["s9", 2.5e6]);
  inp.stashes[9] = true;
  const plan = E.planEpoch(inp);
  const hv = plan.vaults.house;
  assert.equal(hv.apr_cap, Math.trunc(10e6 * 0.25 * 7 / 365), "split by its PAT-days, paid under the 25% reference cap");
  assert.ok(hv.stakers <= hv.apr_cap);
  assert.equal(paidTo(plan)[9], undefined, "the last-second stake still gets nothing");
  assert.deepEqual(E.weightingOf(inp, plan), { house: "partial" });
  const tr = E.trackOf(inp, plan);
  const { payout_apr: papr, ...row } = tr.vaults.house;
  assert.deepEqual(row, { pool: 2e6, paid: hv.stakers, cap25: hv.apr_cap, would25: hv.apr_cap, weighting: "partial", cap_pct: 25, fallback: true });
  assert.ok(Math.abs(papr - hv.stakers / hv.staked * 365 / 7) < 1e-6, "the payout's own APR on the stakers' stake (round 6)");
  assert.deepEqual(tr.fallback, ["house"]);
  assert.equal(tr.cap_in_force_pct, 0);
  assert.equal(tr.ref_cap_pct, 25);
  // a cap in force applies as set (no reference cap)
  const ten = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 10 }, patDays: partial }));
  assert.equal(ten.vaults.house.apr_cap, Math.trunc(10e6 * 0.10 * 7 / 365));
  const tr10 = E.trackOf(inputs({ cfg: { wf_staker_cap_pct: 10 }, patDays: partial }), ten);
  assert.equal(tr10.vaults.house.fallback, false);
  assert.equal(tr10.vaults.house.cap_pct, 10);
  // the whole week: no cap means the full 20%
  const whole = [[String(B - 7 * DAY), []], [String(B), [["1", 35e6], ["2", 35e6]]]];
  const wp = E.planEpoch(inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: whole }));
  assert.equal(wp.vaults.house.apr_cap, 2e6);
  const trw = E.trackOf(inputs({ cfg: { wf_staker_cap_pct: 0 }, patDays: whole }), wp);
  assert.equal(trw.vaults.house.weighting, "pat_days");
  assert.equal(trw.vaults.house.fallback, false);
  assert.equal(trw.vaults.house.cap_pct, 0);
  // no pool, no reference cap (Pepe: pool > 0)
  const none = inputs({ cfg: { wf_staker_cap_pct: 0 } });
  none.vaults.house.basis = 20e6;                                  // the protocol below its basis: no surplus
  const np = E.planEpoch(none);
  assert.equal(np.vaults.house.stakers_share, 0);
  assert.equal(np.vaults.house.apr_cap, 0);
  assert.equal(E.trackOf(none, np).vaults.house.fallback, false);
});

test("a Monday cut-off more than an hour late: flagged, and 'lost' when Pepe's settlement for that boundary was already done", () => {
  assert.equal(V.lateMonday(B - DAY + 3, B + 5, 4, {}), null, "on time");
  assert.equal(V.lateMonday(B - DAY + 3, B + 3000, 4, {}), null, "50 min late: Pepe still waits for it");
  const late = V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, {});
  assert.deepEqual(late, { boundary: B, late: 7200, settled: null, lost: false });
  const lost = V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, { waterfall: [{ epoch: "W2026-10-26", boundary: B, state: "done", done: B + 3700 }] });
  assert.equal(lost.lost, true);
  assert.equal(lost.settled, B + 3700);
  assert.equal(V.lateMonday(B + 3, B + DAY + 3, 4, {}), null, "a Tuesday cut-off crosses no boundary");
  // a tagged re-run's record (the staging rehearsal: dropped from cfg.waterfall, kept in cfg.wf_settled) settles the boundary too
  const tag = "W" + new Date(B * 1000).toISOString().slice(0, 10) + "-r1";
  const viaTag = V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, { wf_settled: V.settledFrom([{ epoch: tag, boundary: B, state: "done", done: B + 3700 }]) });
  assert.deepEqual(viaTag, { boundary: B, late: 7200, settled: B + 3700, lost: true }, "the re-run's settlement, as in Pepe's journal");
  // both: the earliest settlement before the cut-off; one done after the cut-off (or not done) doesn't count
  const both = { waterfall: [{ epoch: "W2026-10-26", boundary: B, state: "done", done: B + 3 * 3600 }],
                 wf_settled: [{ epoch: tag, boundary: B, state: "done", done: B + 3650 }, { epoch: "W2026-10-26", boundary: B, state: "done", done: B + 3 * 3600 }] };
  assert.equal(V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, both).settled, B + 3650);
  assert.equal(V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, { waterfall: both.waterfall }).lost, false, "settled after the cut-off: not lost");
  assert.equal(V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, { wf_settled: [{ epoch: tag, boundary: B, state: "moving", done: B + 3650 }] }).lost, false);
  assert.equal(V.lateMonday(B - DAY + 3, B + 2 * 3600, 4, { wf_settled: [{ epoch: tag, boundary: B - 7 * DAY, state: "done", done: B + 3650 }] }).lost, false, "another boundary");
  // the audit's finding
  const f = V.audit({ v: {}, auto: { total: 0, holders: {} }, epochs: [] }, { last: null, snap: { ts: B + 7200, price: {}, nav: {}, staked: {}, staker_index: {} },
                                                                              p: { auto: 1 }, autoH0: {}, F: {}, steps: {}, c: {}, notes: { errors: [], late_monday: lost } });
  const x = f.find((y) => y.code === "I8" && y.vault === "late-monday");
  assert.ok(x && x.level === "alert", JSON.stringify(f));
  assert.match(x.body, /already done/);
});
