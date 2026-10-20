// Staking fix plan (2026-10-19) §6: the cut-off's audit (capital/vaults.js audit) and the alerts (capital/watch.js).
//   * a clean day raises nothing; a corrupted Auto sleeve fires I1; Auto moving differently from its sleeves (the old
//     skim-before-feed slip) fires I2; holders not adding up fire I3; stakers down >2% in a week fire I4 - an ALERT while a
//     daily ceiling is on, a WARNING with it off (D1: stakers then move with the vault by design); stakers over the limit
//     fire I5 (worded by the Auto-cap switch); a give-back bigger than its cushion fires I10;
//   * the alerts: info is never sent, warn at most weekly, the same ref never twice, staging never alerts; the 25%-cap tracker
//     keeps a year of weeks (no second digest - Pepe sends it).
//   NODE_PATH=G:/PATV/node_modules node --test test/staking-audit.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staking-audit-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const V = require(path.join(repo, "capital", "vaults"));
const W = require(path.join(repo, "capital", "watch"));
const C = require(path.join(repo, "capital", "core"));

const DAY = 86400, T = 1792987200;
function world() {
  const d = { v: { bank: { total: 1000, holders: { protocol: 600, s1: 200, auto: 200 }, basis: 600 },
                   house: { total: 1000, holders: { protocol: 600, s2: 100, auto: 300 }, basis: 600 },
                   mm: { total: 100, holders: { protocol: 100 } } },
              auto: { total: 500, holders: { s1: 300, s3: 200 } }, epochs: [] };
  const p = { bank: 1.0, house: 2.0, mm: 1.0 };
  p.auto = (200 * p.bank + 300 * p.house) / 500;
  const snap = (ts, price, si) => ({ ts, price: Object.assign({}, price), nav: { bank: 1000 * price.bank, house: 1000 * price.house, mm: 100 },
                                     staked: { bank: 400 * price.bank, house: 400 * price.house, mm: 0 }, staker_index: si });
  return { d, p, snap };
}
const codes = (f) => f.map((x) => `${x.code}:${x.vault}:${x.level}`).sort();
const C25 = { ceil_apr: 0.25, staker_max: 0.5 }, C0 = { ceil_apr: 0, staker_max: 0.5 };

test("a clean day raises nothing", () => {
  const { d, p, snap } = world();
  const last = snap(T - DAY, { bank: 1.0, house: 2.0, mm: 1.0, auto: p.auto }, { bank: 1, house: 1, mm: 1 });
  const s = snap(T, p, { bank: 1, house: 1, mm: 1 });
  d.epochs = [last, s];
  const autoH0 = { bank: 200, house: 300, mm: 0 };
  assert.deepEqual(V.audit(d, { last, snap: s, p, autoH0, F: {}, steps: {}, c: C25, notes: { errors: [] } }), []);
});

test("I1 / I3: a corrupted Auto sleeve or holders that don't add up", () => {
  const { d, p, snap } = world();
  const s = snap(T, p, { bank: 1, house: 1, mm: 1 });
  d.epochs = [s];
  d.v.house.holders.auto = 350;                                  // the sleeve grew without Auto's total (and the vault's) moving
  const f = V.audit(d, { last: null, snap: s, p, autoH0: {}, F: {}, steps: {}, c: C25, notes: { errors: [] } });
  assert.ok(codes(f).includes("I1:auto:alert"), JSON.stringify(codes(f)));
  assert.ok(codes(f).includes("I3:house:alert"));
});

test("I2: Auto moving differently from its sleeves (the old skim-before-feed slip) is caught on its first day", () => {
  const { d, p, snap } = world();
  const last = snap(T - DAY, { bank: 1.0, house: 2.0, mm: 1.0, auto: p.auto }, { bank: 1, house: 1, mm: 1 });
  // the House sleeve was skimmed (F 0.99) but Auto's price says it wasn't: a 0.6% gap
  const s = snap(T, p, { bank: 1, house: 0.99, mm: 1 });
  d.epochs = [last, s];
  const f = V.audit(d, { last, snap: s, p, autoH0: { bank: 200, house: 300, mm: 0 }, F: { house: 0.99 }, steps: {}, c: C25, notes: { errors: [] } });
  assert.ok(codes(f).includes("I2:auto:alert"), JSON.stringify(codes(f)));
});

test("I4: stakers down >2% in a week - an alert with a ceiling on, a warning with it off (they move with the vault)", () => {
  const { d, p, snap } = world();
  const wk = snap(T - 7 * DAY, { bank: 1.0, house: 2.0, mm: 1.0, auto: p.auto }, { bank: 1, house: 1, mm: 1 });
  const s = snap(T, { bank: 1.0, house: 1.94, mm: 1.0, auto: p.auto }, { bank: 1, house: 0.97, mm: 1 });
  d.epochs = [wk, s];
  const on = V.audit(d, { last: null, snap: s, p, autoH0: {}, F: {}, steps: {}, c: C25, notes: { errors: [] } });
  assert.ok(codes(on).includes("I4:house:alert"), JSON.stringify(codes(on)));
  const off = V.audit(d, { last: null, snap: s, p, autoH0: {}, F: {}, steps: {}, c: C0, notes: { errors: [] } });
  assert.ok(codes(off).includes("I4:house:warn"), JSON.stringify(codes(off)));
  // the vault up 27.8% while its stakers are down (the 10-19 shape): a warning either way
  const s2 = snap(T, { bank: 1.0, house: 2.556, mm: 1.0, auto: p.auto }, { bank: 1, house: 0.995, mm: 1 });
  d.epochs = [wk, s2];
  assert.ok(codes(V.audit(d, { last: null, snap: s2, p, autoH0: {}, F: {}, steps: {}, c: C25, notes: { errors: [] } })).includes("I4:house:warn"));
});

test("I5 (stakers over the limit, worded by the Auto-cap switch) and I10 (the cushion, the protocol under its basis)", () => {
  const { d, p, snap } = world();
  const s = snap(T, p, { bank: 1, house: 1, mm: 1 });
  s.staked.house = 0.735 * s.nav.house;
  d.epochs = [s];
  d.v.house.basis = 2e9;                                         // the protocol far under its basis
  const steps = { house: { giveback: 10, cushion_before: 5 } };
  const f = V.audit(d, { last: null, snap: s, p, autoH0: {}, F: {}, steps, c: C25, notes: { errors: [] } });
  // the 2026-10-19 review: with Auto skipping the limit (P2.2 off) prod is far over it every day - info on the card, not a weekly
  // warning to every admin; with the switch on, being over the limit is news (a warning)
  assert.ok(codes(f).includes("I5:house:info"), JSON.stringify(codes(f)));
  assert.match(f.find((x) => x.code === "I5").body, /don't check it while vault_auto_staker_cap is off/);
  assert.ok(codes(f).includes("I10:house:alert"), "a give-back bigger than its cushion");
  assert.ok(codes(f).includes("I10:house:info"));
  const f2 = V.audit(d, { last: null, snap: s, p, autoH0: {}, F: {}, steps: {}, c: Object.assign({ auto_staker_cap: 1 }, C25), notes: { errors: [] } });
  assert.match(f2.find((x) => x.code === "I5").body, /Auto deposits obey it too/);
  assert.equal(f2.find((x) => x.code === "I5").level, "warn");
  const f3 = V.audit(d, { last: null, snap: s, p, autoH0: {}, F: {}, steps: {}, c: C25,
                          notes: { errors: [["queue q9", "boom"]], items: [{ id: "q7", kind: "deposit", vault: "house", legs: {}, refund: 5000 }] } });
  // a step that failed is an alert; a direct stake refunded at the staker limit is the rule working (info)
  assert.ok(codes(f3).includes("I8:null:alert") && codes(f3).includes("I8:refund:info"), JSON.stringify(codes(f3)));
});

test("round trips around the Monday draw: out at the cut-off before it, back in at the one after - counted with the drop skipped", () => {
  const E = require(path.join(repo, "policy", "engines"));
  const B = E.weekStart(Date.UTC(2026, 9, 26, 5) / 1000, 4);
  const pSun = { bank: 1.0, house: 2.0, mm: 1.0, auto: 1.5 }, pMon = { bank: 1.0, house: 1.94, mm: 1.0, auto: 1.48 };
  const q = (id, stash, kind, vault, done, legs, prices, extra) => Object.assign({ id, stash, kind, vault, done, ts: done - 600, state: "done", legs, prices }, extra || {});
  const d = { queue: {
    a: q("a", "5", "withdraw", "house", B - DAY + 4, { house: 100000 }, pSun, { burn: 50000 }),       // out before the draw
    b: q("b", "5", "deposit", "house", B + 4, { house: 100000 }, pMon, { amount: 100000 }),           // back after it
    c: q("c", "6", "withdraw", "auto", B - DAY + 4, { bank: 40000, house: 30000, mm: 30000 }, pSun),  // Auto out...
    e: q("e", "6", "deposit", "auto", B + 4, { bank: 25000, house: 15000, mm: 10000 }, pMon, { amount: 50000 }),   // ...half back
    g: q("g", "7", "withdraw", "house", B - DAY + 4, { house: 5000 }, pSun),                           // left for good: not a round trip
    h: q("h", "8", "deposit", "house", B + 4, { house: 5000 }, pMon),                                  // a new stake: not one either
    i: q("i", "9", "withdraw", "house", B + 4, { house: 5000 }, pMon),                                 // out AFTER the draw: no
    j: q("j", "9", "deposit", "house", B + DAY + 4, { house: 5000 }, pMon) } };
  const r = W.roundTrips(d, B);
  assert.equal(r.pairs, 2);
  assert.deepEqual(r.stashes.sort(), ["5", "6"]);
  assert.equal(r.out, 200000);
  assert.equal(r.in, 150000);
  // stash 5: 100,000 x 3% = 3,000; stash 6: the House leg 30,000 x 3% x (50k back / 100k out) = 450
  assert.equal(r.dodged, 3000 + 450);
  assert.deepEqual(W.roundTrips({ queue: {} }, B), { boundary: B, pairs: 0, stashes: [], out: 0, in: 0, dodged: 0 });
});

test("weekly(): a late settlement alerts ONCE, is re-checked until done, then cross-checked; no cap on a partial PAT-days week alerts", async () => {
  await C.init();
  await require(path.join(repo, "stashes")).init();               // stash_moves: the payout cross-check reads it per paid vault
  const E = require(path.join(repo, "policy", "engines"));
  const B = E.weekStart(Date.UTC(2026, 9, 26, 5) / 1000, 4);
  const eid = E.epochId(B + 10, 4);
  await C.setMeta("live", true);
  C.forgetLive();
  // the site's book: PAT-days started Saturday (the deploy's first cut-off) -> the week settling at B has only its own bucket,
  // so it isn't wholly time-weighted (Pepe's bucket rule); the next week's bucket (B + 7 d) has B's before it: whole.
  // stash 5 left before Sunday's cut-off and came back at Monday's (a round trip)
  const pSun = { bank: 1, house: 2.0, mm: 1, auto: 1 }, pMon = { bank: 1, house: 1.9, mm: 1, auto: 1 };
  const pdays = { [String(B)]: { 1: 7e5 }, [String(B + 7 * DAY)]: { 1: 7e5 } };
  await V.store({ inited: true, v: { house: { total: 100, holders: { protocol: 100 }, pat_days: pdays } }, auto: { total: 0, holders: {} }, seq: 2, epochs: [{ ts: B - DAY + 3 }, { ts: B + 3 }],
                  queue: { q1: { id: "q1", stash: "5", kind: "withdraw", vault: "house", state: "done", done: B - DAY + 4, legs: { house: 200000 }, prices: pSun, burn: 1e5 },
                           q2: { id: "q2", stash: "5", kind: "deposit", vault: "house", state: "done", done: B + 4, legs: { house: 200000 }, prices: pMon, amount: 200000 } },
                  pd_from: B - 2 * DAY });
  const sent = [];
  W._setAlert(async (a) => { sent.push(a.ref); return { admins: 1 }; });
  let now = B + 3 * 3600;
  W._setClock(() => now);
  try {
    const c = { tr_live: true, epoch_hour: 4, waterfall: [{ epoch: eid, boundary: B, state: "moving", vaults: {} }] };
    const f1 = await W.weekly(c);
    assert.ok(f1.some((x) => x.code === "I6" && x.level === "alert" && /isn't done/.test(x.title)), JSON.stringify(f1));
    assert.equal(await W.weekly(c), null, "alerted once - not every tick");
    assert.equal(await C.meta(`wf_watch:${eid}`), null, "the cross-check marker waits for a DONE record");
    // round trips ran (the Monday cut-off is in): stash 5 skipped 5% of 200,000
    const rt = await C.meta("watch_roundtrips");
    assert.equal(rt[rt.length - 1].eid, eid);
    assert.equal(rt[rt.length - 1].dodged, 10000);
    assert.ok(sent.some((r) => r.endsWith(":I11:roundtrip")), "a round trip that skipped >= 1,000 PAT is a warning: " + JSON.stringify(sent));
    // Pepe finishes it later the same day - uncapped on that week: an older Pepe (no cap_pct / fallback; his "pat_days" only
    // meant "a bucket exists") - the site's book says the week wasn't wholly time-weighted: ALERT
    now += 3600;
    const row = (o) => Object.assign({ surplus: 5000, stakers_share: 1000, staked: 1e5, apr_cap: 1000, stakers: 1000, stakers_n: 1, fed: 2000, incentives: 2000 }, o);
    c.waterfall = [{ epoch: eid, boundary: B, state: "done", done: now - 60, days: 7, staker_cap_pct: 0, vaults: { house: row({ weighting: "pat_days" }) } }];
    const f2 = await W.weekly(c);
    const al = f2.find((x) => x.vault === "partial-week-house");
    assert.ok(al && al.level === "alert" && /the site's book: not wholly time-weighted/.test(al.body), JSON.stringify(f2));
    assert.ok(f2.some((x) => x.vault === "late" && x.level === "info"), "noted as settled late");
    assert.ok(await C.meta(`wf_watch:${eid}`), "checked now");
    assert.equal(await W.weekly(c), null, "once a week");
    // a whole week with the cap off is fine; a settlement of more than 3 weeks warns that the oldest PAT-days were pruned
    now += 7 * DAY;
    const eid2 = E.epochId(now, 4);
    const rec2 = (o) => ({ tr_live: true, epoch_hour: 4, waterfall: [{ epoch: eid2, boundary: B + 7 * DAY, state: "done", done: B + 7 * DAY + 60, days: 28, staker_cap_pct: 0,
                                                                        vaults: { house: row(o) } }] });
    const f3 = await W.weekly(rec2({ weighting: "pat_days", cap_pct: 0, fallback: false }));
    assert.ok(!f3.some((x) => /^partial-week/.test(String(x.vault))), "the second week is whole: " + JSON.stringify(f3));
    assert.ok(f3.some((x) => x.vault === "pd-pruned" && x.level === "warn"));
    // Pepe 31c65d0 on that same week: his record says "partial" with no cap applied (no safeguard) - ALERT from his own word
    await C.setMeta(`wf_watch:${eid2}`, null);
    const f4 = await W.weekly(rec2({ weighting: "partial", cap_pct: 0, fallback: false }));
    assert.ok(f4.some((x) => x.vault === "partial-week-house" && x.level === "alert" && /weighted by partial/.test(x.body)), JSON.stringify(f4));
    // ...and the safeguard at work (the reference cap, fallback) is info - never sent
    await C.setMeta(`wf_watch:${eid2}`, null);
    const nSent = sent.length;
    const f5 = await W.weekly(rec2({ weighting: "partial", cap_pct: 25, fallback: true }));
    assert.ok(!f5.some((x) => /^partial-week/.test(String(x.vault))), JSON.stringify(f5));
    assert.ok(f5.some((x) => x.vault === "refcap-house" && x.level === "info" && /25% a year/.test(x.body)));
    assert.ok(!sent.slice(nSent).some((r) => /refcap/.test(r)), "info isn't sent");
    // a record whose cap isn't known at all (no staker_cap_pct, no cap_pct): nothing claimed
    await C.setMeta(`wf_watch:${eid2}`, null);
    const unk = rec2({ weighting: "partial" });
    delete unk.waterfall[0].staker_cap_pct;
    assert.ok(!(await W.weekly(unk)).some((x) => /^(partial-week|refcap)/.test(String(x.vault))));
    // the site judges its book AFTER the settlement: Pepe settled 21 days (lb = B - 14 d, before the Monday cut-off that adds
    // next week's bucket and prunes the oldest) on a book that still had an older bucket and paid it whole ("pat_days", no
    // cap); the site's book now has nothing older than B -> not whole. A 31c65d0+ record (cap_pct reported) decides: info
    // (pd-view), never a false partial-week alert
    const withLb = (o) => { const x = rec2(o); x.waterfall[0].days = 21; x.waterfall.unshift({ epoch: "W-older", boundary: B - 14 * DAY, state: "done", done: B - 14 * DAY + 60, vaults: {} }); return x; };
    assert.equal(V.pdWhole((await V.load()).v.house, B + 7 * DAY, B - 14 * DAY), false, "the site's book: nothing older than the first summed bucket");
    await C.setMeta(`wf_watch:${eid2}`, null);
    const f6 = await W.weekly(withLb({ weighting: "pat_days", cap_pct: 0, fallback: false }));
    assert.ok(!f6.some((x) => /^partial-week/.test(String(x.vault))), "Pepe's word decides: " + JSON.stringify(f6));
    const pv = f6.find((x) => x.vault === "pd-view-house");
    assert.ok(pv && pv.level === "info" && /Pepe's weighting is what was paid/.test(pv.body), JSON.stringify(f6));
    // ...an older Pepe's record (no cap_pct: his "pat_days" only meant a bucket existed) is still judged by the site's book
    await C.setMeta(`wf_watch:${eid2}`, null);
    const f7 = await W.weekly(withLb({ weighting: "pat_days" }));
    assert.ok(f7.some((x) => x.vault === "partial-week-house" && x.level === "alert"), JSON.stringify(f7));
    assert.ok(!f7.some((x) => x.vault === "pd-view-house"));
  } finally {
    W._setAlert(null); W._setClock(null);
    await C.setMeta("live", false); C.forgetLive();
    for (const k of ["wf_cap_track", "watch_refs", "watch_sent", "watch_weekly"]) await C.setMeta(k, null);   // the next test starts clean
  }
});

test("alerts: info never sent, warn once a week, a ref once, staging never; the tracker keeps the weeks without a second digest", async () => {
  await C.init();
  const sent = [];
  W._setAlert(async (a) => { sent.push(a.ref); return { admins: 1 }; });
  let now = T;
  W._setClock(() => now);
  try {
    const f = [{ code: "I4", vault: "house", level: "warn", title: "w", body: "" }, { code: "I10", vault: "bank", level: "info", title: "i", body: "" },
               { code: "I1", vault: "auto", level: "alert", title: "a", body: "" }];
    await W.send(f, "2026-10-26");
    assert.deepEqual(sent.sort(), ["2026-10-26:I1:auto", "2026-10-26:I4:house"]);
    await W.send(f, "2026-10-26");
    assert.equal(sent.length, 2, "the same refs aren't sent twice");
    now += DAY;
    await W.send(f, "2026-10-27");
    assert.deepEqual(sent.slice(2), ["2026-10-27:I1:auto"], "the warning waits a week; the alert repeats daily");
    now += 7 * DAY;
    await W.send(f, "2026-11-03");
    assert.equal(sent.filter((r) => r.includes("I4")).length, 2, "a week later the warning goes again");
    process.env.STAGING = "1";
    const n = sent.length;
    await W.send([{ code: "I1", vault: "auto", level: "alert", title: "a", body: "" }], "2026-11-04");
    assert.equal(sent.length, n, "staging never alerts");
    delete process.env.STAGING;
    // the 25%-cap tracker: merged by week, no ops digest of its own (Pepe's wf-digest)
    const rec = (ep) => ({ epoch: ep, state: "done", days: 7, vaults: { house: { stakers_share: 1000, staked: 1e6, stakers: 1000 } } });
    const before = sent.length;
    await W.trackCap({ waterfall: [rec("W2026-10-12"), rec("W2026-10-19")] });
    await W.trackCap({ waterfall: [rec("W2026-10-19"), rec("W2026-10-26")] });
    const kept = await C.meta("wf_cap_track");
    assert.deepEqual(kept.map((x) => x.eid), ["W2026-10-12", "W2026-10-19", "W2026-10-26"]);
    assert.equal(kept[0].vaults.house.would25, Math.min(1000, Math.trunc(1e6 * 0.25 * 7 / 365)));
    assert.equal(sent.length, before, "no digest from the site");
  } finally { W._setAlert(null); W._setClock(null); }
});
