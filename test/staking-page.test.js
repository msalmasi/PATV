// Staking fix plan (2026-10-19) P0.3 + the owner's new rule (no daily APR ceiling, no weekly payout cap, a time-weighted
// weekly payout, stakers carry the House's swings incl. the Monday draws) on the pages - the copy the owner approved
// 2026-10-19, always following the LIVE settings:
//   * staking.clean keeps the payouts, cost, P/L, PAT-days and the new switches; drops junk;
//   * /staking shows the weekly settlement, each stash's staked / value / P/L / payouts, "this week so far" by PAT-days, and
//     says what's in force (ceiling off/on, cap none/on, time-weighted) - never "Stakers' shares are never touched";
//   * /economy's staking section words the ceiling / cap / weighting from the live rules (econpage.stakingRules);
//   * /admin/economy's staking card (the owner's controls) renders with the new switches and the 25%-cap tracker.
//   NODE_PATH=G:/PATV/node_modules node --test test/staking-page.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staking-page-test-"));
process.chdir(tmp);
const staking = require(path.join(repo, "staking.js"));
const ejs = require("ejs");

const NOW = 1792987200 + 3 * 86400;
function body(settings) {
  return {
    prices: { bank: 1.0168, house: 1.9429, mm: 1.0887, auto: 0.9842 }, nav: { bank: 5e6, house: 30e6, mm: 2e6 },
    staked: { bank: 4e6, house: 20e6, mm: 1.7e6 }, auto_nav: 3e6,
    apr: { bank: { 7: 0.02, 30: null }, house: { 7: 0.9, 30: null }, mm: { 7: 0.1, 30: null }, auto: { 7: 0.05, 30: null } },
    so_far: {}, targets: { bank: 0.5, house: 0.3, mm: 0.2 },
    settings: Object.assign({ ceil: 0, floor: 0, topup: false, staker_max: 0.5, bank_min: 0.4, house_max: 0.35, mm_max: 0.25,
                              cushion: false, cushion_days: 8, bonus_cap: 0, auto_staker_cap: false, weighted: true }, settings),
    epochs: [], queue: [],
    staker_index: { bank: 1.003, house: 0.95, mm: 0.967 },
    waterfall: [{ epoch: "W2026-10-19", boundary: 1792382400, days: 7, done: 1792382500, state: "done", staker_share: 0.2, staker_cap_pct: 25,
                  vaults: { house: { surplus: 10502634, fed_loan_repaid: 0, stakers_share: 2100526, staked: 20e6, apr_cap: 95890, stakers: 95880, stakers_n: 7,
                                     fed: 4203377, incentives: 4203377, would_cap25: 95880, weighting: "snapshot", junk: "x" } } },
                { epoch: "bogus" }],
    pd_week: { boundary: 1792987200 + 7 * 86400, total: { house: 140e6, bank: 0, mm: 0 } },
    positions: {
      7: { owner: "ann_cf", name: "plantstash", owner_id: "u1", owner_name: "ann", members: [],
           hold: { house: { shares: 1000, value: 1943 }, auto: { shares: 5000, value: 4921 } },
           cost: { house: { in: 2000, out: 0 }, auto: { in: 5000, out: 0 }, junk: { in: 1 } },
           paid: { d7: 164, all: 1259, corr: 675 }, pd: { house: 14e6, nope: 5 } },
    },
  };
}
async function renderStaking(settings, mineOverride, snapOverride) {
  const snap = snapOverride || staking.clean(body(settings));
  const file = path.join(repo, "views", "staking.ejs");
  const p = snap.positions["7"];
  const mine = mineOverride || [{ id: "7", owner: "ann_cf", owner_name: "ann", name: "plantstash", members: [], hold: p.hold, cost: p.cost, paid: p.paid, pd: p.pd,
                                  total: staking.holdValue(p), balance: 100, owner_me: true, ref: "plantstash", pending: [] }];
  return ejs.render(fs.readFileSync(file, "utf8"), {
    user: "ann", signedIn: true, camfrog: "ann_cf", msg: null, acts: [], now: NOW, snap, mine, pnl: staking.pnl,
    chart: staking.chart(snap.epochs || []), rev: [], pending: [], canStake: true,
  }, { filename: file });
}

test("clean keeps the weekly records (incl. the 25%-cap figure), cost, payouts, PAT-days and the new switches; drops junk", () => {
  const c = staking.clean(body({ auto_staker_cap: 1 }));
  assert.equal(c.waterfall.length, 1, "a record without a valid epoch id is dropped");
  const h = c.waterfall[0].vaults.house;
  assert.equal(h.stakers, 95880);
  assert.equal(h.would_cap25, 95880);
  assert.equal(h.weighting, "snapshot");
  assert.equal(h.junk, undefined);
  assert.equal(c.waterfall[0].staker_cap_pct, 25);
  const p = c.positions["7"];
  assert.deepEqual(p.cost, { house: { in: 2000, out: 0 }, auto: { in: 5000, out: 0 } });
  assert.deepEqual(p.paid, { d7: 164, all: 1259, corr: 675 });
  assert.deepEqual(p.pd, { house: 14e6 });
  assert.equal(c.settings.weighted, true);
  assert.equal(c.settings.auto_staker_cap, true);
  assert.equal(c.settings.bonus_cap, 0);
  assert.equal(c.pd_week.total.house, 140e6);
  const old = staking.clean({});                                   // an older snapshot: nothing breaks
  assert.deepEqual(old.waterfall, []);
  assert.equal(old.settings.weighted, false);
  assert.equal(h.cap_pct, null, "an older Pepe's record: the applied cap isn't known");
  assert.equal(h.fallback, null);
});

test("D2's safeguard on /staking (camfrog-bot 31c65d0): a record's partial weighting / cap_pct / fallback are kept and shown", async () => {
  const b = body({ bonus_cap: 0 });
  const r = b.waterfall[0];
  r.staker_cap_pct = 0;
  Object.assign(r.vaults.house, { weighting: "partial", cap_pct: 25, fallback: true });
  r.vaults.bank = { surplus: 1e6, stakers_share: 2e5, staked: 1e6, apr_cap: 2e5, stakers: 2e5, stakers_n: 1, fed: 4e5, incentives: 4e5,
                    would_cap25: 4794, weighting: "pat_days", cap_pct: 0, fallback: false };
  r.vaults.mm = { surplus: 0, stakers_share: 0, weighting: "bogus", cap_pct: "x", fallback: "yes" };
  b.pd_week.partial = true;
  b.pd_week.from = NOW - 2 * 86400;
  const c = staking.clean(b);
  const w = c.waterfall[0].vaults;
  assert.deepEqual([w.house.weighting, w.house.cap_pct, w.house.fallback], ["partial", 25, true]);
  assert.deepEqual([w.bank.weighting, w.bank.cap_pct, w.bank.fallback], ["pat_days", 0, false]);
  assert.deepEqual([w.mm.weighting, w.mm.cap_pct, w.mm.fallback], [null, null, null], "junk is dropped");
  const html = await renderStaking(null, null, c);
  assert.match(html, /95,890 †/, "the House's cap cell is marked: the reference cap");
  assert.doesNotMatch(html, /200,000 †/, "the Bank (wholly time-weighted, no cap) isn't");
  assert.match(html, /No weekly cap is set, but that week wasn&#39;t fully time-weighted|No weekly cap is set, but that week wasn't fully time-weighted/);
  assert.match(html, /a week that isn't fully time-weighted, like this one, still holds the stakers' payout to <b>25% a year<\/b>/);
  // "the first week of the time-weighting" only when the PAT-days began inside the week this Monday settles; a later partial
  // week (Pepe's bucket rule: began in an earlier week of a longer stretch, a pruned oldest week) or no pd_from (Pepe's local
  // snapshot) gets the plain sentence - never an old date called the first week
  assert.match(html, /This is the first week of the time-weighting/);
  assert.doesNotMatch(html, /the PAT-days don't cover all of the time since the last settlement/);
  for (const from of [b.pd_week.boundary - 10 * 86400, b.pd_week.boundary - 7 * 86400 - 1, null]) {
    const later = staking.clean(Object.assign(body({ bonus_cap: 0 }), { pd_week: Object.assign({}, b.pd_week, { from }) }));
    const h2 = await renderStaking(null, null, later);
    assert.doesNotMatch(h2, /This is the first week of the time-weighting/, `pd_from ${from}: not the week's own`);
    assert.match(h2, /This week isn&#39;t fully time-weighted|This week isn't fully time-weighted: the PAT-days don't cover all of the time since the last settlement/, `pd_from ${from}`);
  }
  const edge = staking.clean(Object.assign(body({ bonus_cap: 0 }), { pd_week: Object.assign({}, b.pd_week, { from: b.pd_week.boundary - 7 * 86400 + 30 }) }));
  assert.match(await renderStaking(null, null, edge), /This is the first week of the time-weighting/, "PAT-days that began at the week's own Monday cut-off: its first week");
  const whole = staking.clean(Object.assign(body({ bonus_cap: 0 }), { pd_week: Object.assign({}, b.pd_week, { partial: false }) }));
  assert.doesNotMatch(await renderStaking(null, null, whole), /first week of the time-weighting|isn't fully time-weighted: the PAT-days/, "a whole week: neither");
  // the cap set: no reference-cap sentence for this week
  const capped = staking.clean(Object.assign(body({ bonus_cap: 0.25 }), { pd_week: b.pd_week }));
  assert.doesNotMatch(await renderStaking(null, null, capped), /like this one, still holds/);
  // the vaults' own record (capital/vaults.js waterfallFrom) reads the same fields
  const V = require(path.join(repo, "capital", "vaults.js"));
  const wf = V.waterfallFrom({ waterfall: [r] })[0].vaults;
  assert.deepEqual([wf.house.weighting, wf.house.cap_pct, wf.house.fallback, wf.mm.weighting, wf.mm.fallback], ["partial", 25, true, null, null]);
});

test("P/L: staked = in - out, P/L = value + out - in; payouts are not in it (they land in the stash's balance)", () => {
  const r = staking.pnl({ hold: { house: { value: 1943 } }, cost: { house: { in: 2000, out: 300 } } });
  assert.deepEqual(r.rows.house, { in: 2000, out: 300, staked: 1700, value: 1943, pl: 243, has: true, partial: false });
  // the 2026-10-19 review: a holding with no cost record was "Staked 0" - unknown now, and so are the totals
  const unknown = staking.pnl({ hold: { mm: { value: 10 } }, cost: {} });
  assert.equal(unknown.rows.mm.staked, null, "no cost record: Staked unknown, not 0");
  assert.equal(unknown.rows.mm.pl, null);
  assert.equal(unknown.total.pl, null, "a stake older than the cost history: unknown, not a fake loss");
  assert.equal(unknown.total.staked, null);
  // a stash that held 1M before the deploy and staked 100k after it: the row is partial - no +1.0M "gain"
  const part = staking.pnl({ hold: { house: { value: 1.1e6 }, bank: { value: 500 } }, cost: { house: { in: 100000, out: 0, partial: 1 }, bank: { in: 500, out: 0 } } });
  assert.equal(part.rows.house.pl, null);
  assert.equal(part.rows.house.staked, null);
  assert.equal(part.rows.house.partial, true);
  assert.equal(part.rows.bank.pl, 0, "the whole row next to it still shows");
  assert.equal(part.total.pl, null);
  assert.equal(part.total.staked, null);
  // clean() keeps the flag
  const b = body({});
  b.positions[7].cost.house.partial = 1;
  assert.deepEqual(staking.clean(b).positions["7"].cost.house, { in: 2000, out: 0, partial: 1 });
});

test("/staking shows a partial or missing cost history as '—' (never Staked 0 or a fake gain), and payouts unknown as '—'", async () => {
  const b = body({});
  const p = b.positions[7];
  p.cost = { house: { in: 2000, out: 0, partial: 1 } };          // auto: no record at all
  p.paid = null;                                                 // the payouts query failed
  const snap = staking.clean(b);
  const cp = snap.positions["7"];
  const html = await renderStaking({}, [{ id: "7", owner: "ann_cf", owner_name: "ann", name: "plantstash", members: [], hold: cp.hold, cost: cp.cost, paid: cp.paid, pd: cp.pd,
                                         total: staking.holdValue(cp), balance: 100, owner_me: true, ref: "plantstash", pending: [] }]);
  const rows = html.split("<tr>").filter((x) => /plantstash|🤖 Auto/.test(x) && /<td class="r">/.test(x));
  assert.ok(rows.length >= 2, "the house and auto rows");
  for (const r of rows) assert.doesNotMatch(r, /<td class="r">0<\/td>/, "no 'Staked 0'");
  assert.match(html, /older than the cost history/);
  assert.doesNotMatch(html, /−57/, "no P/L for a partial row");
  assert.doesNotMatch(html, /\+0 \/ \+0/, "no made-up payouts");
});

test("/staking renders only the viewer's own stashes: another stash's cost, payouts and PAT-days never reach the page", async () => {
  // the route hands the view a snapshot without positions / queue (staking.js); the view itself only reads `mine`
  const b = body({});
  b.positions[8] = { owner: "zed_cf", name: "secretstash", owner_id: "u9", owner_name: "zed", members: [],
                     hold: { house: { shares: 777, value: 1515151 } }, cost: { house: { in: 9090909, out: 0 } },
                     paid: { d7: 4242424, all: 4343434, corr: 0 }, pd: { house: 31313131 } };
  const clean = staking.clean(b);
  staking.setCache(clean, Date.now());
  const routes = {};
  const app = { locals: {}, response: { render: () => {} }, get: (p, ...h) => { routes["GET " + p] = h; }, post: (p, ...h) => { routes["POST " + p] = h; },
                use: () => {}, set: () => {} };
  staking.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  let seen = null;
  const h = routes["GET /staking"];
  await h[h.length - 1]({ query: {}, user: null }, { render: (view, locals) => { seen = locals; }, status: () => ({ send: () => {} }) });
  assert.ok(seen && seen.snap, "rendered");
  assert.deepEqual(seen.snap.positions, {}, "no other stash's position is handed to the view");
  assert.deepEqual(seen.snap.queue, []);
  const mine = clean.positions["7"];
  const html = await renderStaking({}, [{ id: "7", owner: "ann_cf", owner_name: "ann", name: "plantstash", members: [], hold: mine.hold, cost: mine.cost, paid: mine.paid, pd: mine.pd,
                                         total: staking.holdValue(mine), balance: 100, owner_me: true, ref: "plantstash", pending: [] }], clean);
  for (const n of ["secretstash", "1,515,151", "9,090,909", "4,242,424", "4,343,434", "zed"]) assert.doesNotMatch(html, new RegExp(n), n);
});

test("/staking under the new rule (no ceiling, no cap, time-weighted): says so, shows payouts / P/L / this week's share", async () => {
  const html = await renderStaking({});
  assert.doesNotMatch(html, /never touched/);
  assert.match(html, /no daily APR ceiling/);
  assert.match(html, /Monday Pepeball draw/);
  assert.match(html, /PAT-days/);
  assert.doesNotMatch(html, /capped at <b>/, "no weekly cap sentence while the cap is 0");
  assert.match(html, /weekly payout cap <b>none<\/b>/);
  assert.match(html, /time-weighted payout <b>on<\/b>/);
  assert.match(html, /APR ceiling <b>off<\/b>/);
  // the weekly settlement table + the stash's numbers
  assert.match(html, /Week of 2026-10-19/);
  assert.match(html, /95,880/);
  assert.match(html, /plantstash/);
  assert.match(html, /\+164 \/ \+1,259/, "payouts 7 d / all");
  assert.match(html, /incl\. corrections 675/);
  assert.match(html, /−57/, "the House P/L: 1,943 - 2,000");
  assert.match(html, /🎰 House 10\.0%/, "this week's share of the House stakers' PAT-days (14M of 140M)");
});

test("/staking with the ceiling and a cap ON says that instead (the copy follows the live settings)", async () => {
  const html = await renderStaking({ ceil: 0.25, bonus_cap: 0.25, cushion: true, weighted: false });
  assert.match(html, /keeps stakers&#39; share-price growth to the APR ceiling|keeps stakers' share-price growth to the APR ceiling/);
  assert.match(html, /gives stakers back up to what it kept/);
  assert.match(html, /capped at <b>25% a year<\/b>/);
  assert.match(html, /split by what each stash has staked when the week settles/);
  assert.doesNotMatch(html, /no daily APR ceiling/);
  assert.doesNotMatch(html, /never touched/);
});

test("/economy words staking from the live rules: no ceiling / no cap / PAT-days, or the ceiling and cap when they're on", async () => {
  const view = path.join(repo, "views", "economy.ejs");
  const render = (staking) => ejs.renderFile(view, { user: null, treasury: null, roomVaults: null, ogBase: "http://t", staking }, { views: [path.join(repo, "views")] });
  const off = await render({ ceil: 0, bonus_cap: 0, weighted: true, cushion: false, auto_staker_cap: true, staker_max: 0.5, staker_share: 0.2 });
  assert.match(off, /there&#39;s no daily APR ceiling|there's no daily APR ceiling/);
  assert.match(off, /<b>No daily APR ceiling<\/b>/);
  assert.match(off, /<b>No weekly payout cap<\/b>/);
  assert.match(off, /shared by <b>PAT-days<\/b>/);
  assert.match(off, /\(Auto deposits included\)/);
  assert.doesNotMatch(off, /Staking yield cap/);
  // the 2026-10-19 review: the surplus is the PROTOCOL's earnings (not the vault's profit) - the copy says so
  assert.match(off, /what the protocol&#39;s own shares in the vault are worth above what the protocol put in|what the protocol's own shares in the vault are worth above what the protocol put in/);
  assert.match(off, /not of everything the vault earned/);
  assert.match(off, /<a href="#incentives">incentive budget<\/a>/);
  const on = await render({ ceil: 0.25, bonus_cap: 0.25, weighted: false, cushion: false, staker_max: 0.5 });
  assert.match(on, /up to the daily APR ceiling \(25% a year/);
  assert.match(on, /<b>Daily APR ceiling:<\/b> at each daily cut-off, stakers&#39; share-price growth above 25%|<b>Daily APR ceiling:<\/b> at each daily cut-off, stakers' share-price growth above 25%/);
  assert.match(on, /<b>Weekly payout cap:<\/b> stakers&#39; share of a week is capped at 25%|<b>Weekly payout cap:<\/b> stakers' share of a week is capped at 25%/);
  assert.match(on, /Staking yield cap/);
  assert.match(on, /split by what each stash has staked when the week settles/);
  // the 50% limit isn't claimed for Auto while vault_auto_staker_cap is off - what stakers own right now is shown instead
  const direct = await render({ ceil: 0, bonus_cap: 0, weighted: true, auto_staker_cap: false, staker_max: 0.5, own: { bank: 0.878, house: 0.735, mm: 0.874 } });
  assert.doesNotMatch(direct, /Stakers can own at most/);
  assert.match(direct, /Auto deposits don&#39;t check that limit yet|Auto deposits don't check that limit yet/);
  assert.match(direct, /right now: 🏦 Bank 88%, 🎰 House 74%, 📈 Market maker 87%/);
  // rules not known (no staking snapshot): no sentence about the ceiling, the cap or the limit - never a guess
  const unknown = await render(null);
  assert.doesNotMatch(unknown, /no daily APR ceiling|No daily APR ceiling|Daily APR ceiling:/);
  assert.doesNotMatch(unknown, /No weekly payout cap|Weekly payout cap:|Staking yield cap/);
  assert.doesNotMatch(unknown, /Stakers can own at most|A direct stake is cut back/);
  assert.match(unknown, /Your share of the vault&#39;s earnings compounds inside the price\.|Your share of the vault's earnings compounds inside the price\./);
});

test("/staking with the rules unknown (an older snapshot): no ceiling or cap claim, '—' in the settings line", async () => {
  const html = await renderStaking({ ceil: null, bonus_cap: null });
  assert.doesNotMatch(html, /no daily APR ceiling/);
  assert.doesNotMatch(html, /keeps stakers/);
  assert.doesNotMatch(html, /capped at <b>/);
  assert.match(html, /APR ceiling <b>—<\/b>/);
  assert.match(html, /weekly payout cap <b>—<\/b>/);
  // the surplus is defined as the protocol's part; the staker limit isn't claimed for Auto while its switch is off
  assert.match(html, /protocol&#39;s own shares in the vault|protocol's own shares in the vault/);
  assert.match(html, /Auto deposits don&#39;t check it yet|Auto deposits don't check it yet/);
});

test("/admin/economy's staking card: the weekly cap is the one control; the panel knobs are shown; the tracker and the round trips", async () => {
  const file = path.join(repo, "views", "partials", "econ-staking.ejs");
  const html = await ejs.renderFile(file, { isAdmin: true, me: { username: "boss" }, canEdit: true }, { views: [path.join(repo, "views")] });
  for (const id of ["stkCap", "stkSetCap", "stkTrack", "stkVaults", "stkRt"]) assert.match(html, new RegExp(`id="${id}"`), id);
  // the 2026-10-19 review: no controls Pepe's !econ set would refuse (or read as a fraction)
  for (const id of ["stkCeil", "stkCushion", "stkDays", "stkAuto", "stkSetCeil", "stkSetAuto", "stkSetCushion", "stkSetDays"]) assert.doesNotMatch(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /Pepe&#39;s admin-panel settings|Pepe's admin-panel settings/);
  assert.match(html, /<code>vault_ceil_apr<\/code> as a fraction/);
  assert.match(html, /Weekly payout vs a 25% cap/);
  assert.match(html, /Round trips around Monday&#39;s draw|Round trips around Monday's draw/);
  assert.match(html, /admin-staking\.js\?v=5/);
  // the 2026-10-19 final check: D2's safeguard is automatic - the card no longer asks the operator to keep the cap on by hand,
  // and no longer hard-codes the stakers' 20% / the 50% staker limit (both are settings)
  assert.doesNotMatch(html, /keep the cap on/);
  assert.match(html, /held to the 25% reference cap automatically/);
  assert.doesNotMatch(html, /stakers&#39; 20%|stakers' 20%|the 50% limit/);
  const ro = await ejs.renderFile(file, { isAdmin: true, me: { username: "admin" }, canEdit: false }, { views: [path.join(repo, "views")] });
  assert.match(ro, /id="stkSetCap" disabled/, "an admin who isn't a Pepe owner sees the card read-only");
  const no = await ejs.renderFile(file, { isAdmin: false, me: null }, { views: [path.join(repo, "views")] });
  assert.doesNotMatch(no, /id="stkForm"/);
});

test("the payout notice: 'your part of' the protocol's earnings, time-weighted words only when every paid vault was, the cap or the reference cap", async () => {
  const A = require(path.join(repo, "policy", "apply.js"));
  const S = require(path.join(repo, "stashes.js"));
  const inbox = require(path.join(repo, "inbox.js"));
  const got = [];
  const o1 = S.get, o2 = inbox.addSafe;
  S.get = async (id) => ({ id, owner: "ann_cf", owner_id: "u1", owner_name: "ann", name: "plantstash" });
  inbox.addSafe = async (uid, n) => { got.push(n); return true; };
  try {
    const plan = { staker_share: 0.2, vaults: { house: { stakers: 900 }, bank: { stakers: 100 } },
                   legs: [{ why: "waterfall stakers", dst: "stash:7", amt: 900, vault: "house" }, { why: "waterfall stakers", dst: "stash:7", amt: 100, vault: "bank" }] };
    // the record's track (engines.trackOf = pepe_treasury._tr_track): the cap in force, each vault's weighting / fallback
    const tr = (cin, h, b) => ({ cap_in_force_pct: cin, vaults: { house: Object.assign({ paid: 900 }, h), bank: Object.assign({ paid: 100 }, b) } });
    await A.notifyStakers("W2026-10-26", plan, tr(0, { weighting: "pat_days", fallback: false }, { weighting: "pat_days", fallback: false }));
    assert.equal(got[0].title, "Staking payout: +1,000 PAT");
    assert.match(got[0].body, /It's your part of 20% of the protocol's own weekly earnings in each vault - shared by how much you staked and for how long\.$/);
    assert.equal(got[0].ref, "wf:W2026-10-26:s7");
    await A.notifyStakers("W2026-10-26", plan, tr(25, { weighting: "pat_days", fallback: false }, { weighting: "snapshot", fallback: false }));
    assert.match(got[1].body, /It's your part of 20% of the protocol's own weekly earnings in each vault, capped at 25% a year on your stake\.$/, "one vault by the snapshot: no time-weighting claim");
    // D2's safeguard (camfrog-bot 31c65d0): no cap in force, the week not wholly time-weighted - Pepe's words, word for word
    await A.notifyStakers("W2026-10-26", plan, tr(0, { weighting: "partial", fallback: true }, { weighting: "partial", fallback: true }));
    assert.match(got[2].body, /each vault - shared by how much you staked and for how long; this week 🎰 House and 🏦 Bank paid at most 25% a year on your stake \(time-weighting started mid-week\)\.$/);
    await A.notifyStakers("W2026-10-26", plan, tr(0, { weighting: "snapshot", fallback: true }, { weighting: "pat_days", fallback: false }));
    assert.match(got[3].body, /each vault; this week 🎰 House paid at most 25% a year on your stake \(this week couldn't be fully time-weighted\)\.$/);
    // Pepe's int(round(x * 100)) is half-even on the exact double: 20.5% -> 20%, 12.5% -> 12%, 21.5% -> 22% (Math.round said
    // 21% / 13%); the cap is his round(cap * 100, 2):g - 12.345% -> 12.35 (the double 12.345 lies above the half), 33.333 -> 33.33
    const pw = (share, cin) => A.notifyStakers("W2026-10-26", Object.assign({}, plan, { staker_share: share }),
                                               tr(cin, { weighting: "pat_days", fallback: false }, { weighting: "pat_days", fallback: false }));
    for (const [sh, want] of [[0.205, 20], [0.125, 12], [0.215, 22], [0.2, 20]]) {
      await pw(sh, 0);
      assert.match(got[got.length - 1].body, new RegExp(`It's your part of ${want}% of the protocol's own`), `staker_share ${sh}`);
    }
    for (const [cin, want] of [[12.345, "12.35"], [33.3333, "33.33"], [25, "25"], [0.5, "0.5"]]) {
      await pw(0.2, cin);
      assert.match(got[got.length - 1].body, new RegExp(`, capped at ${want.replace(".", "\\.")}% a year on your stake\\.$`), `cap ${cin}`);
    }
    // no track (trackOf failed and the settlement went on, as Pepe's _tr_track try / except): the cap in force from the inputs
    // (Pepe's _tr_staker_cap()), no "how long" claim, no safeguard clause
    await A.notifyStakers("W2026-10-26", plan, null, 0.1);
    assert.match(got[got.length - 1].body, /It's your part of 20% of the protocol's own weekly earnings in each vault, capped at 10% a year on your stake\.$/);
    await A.notifyStakers("W2026-10-26", plan, null, 0);
    assert.match(got[got.length - 1].body, /It's your part of 20% of the protocol's own weekly earnings in each vault\.$/);
    await A.notifyStakers("W2026-10-26", plan, null);
    assert.match(got[got.length - 1].body, /in each vault\.$/, "no cap given: none claimed");
    await A.notifyStakers("W2026-10-26", plan, tr(0, { weighting: "pat_days", fallback: false }, { weighting: "pat_days", fallback: false }), 0.1);
    assert.match(got[got.length - 1].body, /for how long\.$/, "a track's cap in force (0) wins over capIn");
  } finally { S.get = o1; inbox.addSafe = o2; }
});
