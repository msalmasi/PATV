// 1.99?? quick1: "staking seems to fail silently" - a member tried three times; every direct stake into the Bank, the House or
// the Market maker since 10-24 was queued, then refunded in full at the cut-off (stakers already own more of each vault
// than the staker limit lets in). capital/stakeroom.js says it plainly instead, before any PAT moves:
//   * fitOf is executeOne's own cap solved for the amount: the largest stake that goes in whole (checked against the
//     cut-off's expression on random books), less the deposits queued ahead; no limit at smax >= 1
//   * roomOf: full / open per vault, Auto unlimited while vault_auto_staker_cap is off, about the vaults' sum under it
//   * refusal: full (why, what still takes stakes, when it opens - no date), capped (how much fits), Auto under the limit;
//     the text Pepe relays word for word (pepe_capitalstore._cap_err; the bot's pepe_stakeroom.py is the same words -
//     its stakeroom_test.py compares the two with PATV_SITE_DIR set)
//   * /staking: the room line, a full vault's option disabled with the reason, Auto picked by default, the amount check;
//     every vault full or staking paused -> the Stake button disabled with the reason; /wallet's stash cards: the room line
//   The capital engine's refusal (no PAT moves, the website form says the same) is in test/capital.test.js.
//   NODE_PATH=G:/PATV/node_modules node --test test/stakeroom.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stakeroom-test-"));
process.chdir(tmp);
const SR = require(path.join(repo, "capital", "stakeroom"));
const staking = require(path.join(repo, "staking.js"));
const ejs = require("ejs");

// the prod book at the 11-04 cut-off (Pepe's mirror): stakers own 92% / 78% / 89%; staker_max 0.5; Auto skips the limit
const NAV = { bank: 22949599, house: 48496615, mm: 9268695 };
const STAKED = { bank: 21146807, house: 37816643, mm: 8256490 };

test("fitOf: the largest stake the cut-off's cap takes whole (executeOne's expression), less what's queued ahead", () => {
  const cap = (nv, st, s, amt) => Math.max(0, Math.trunc(s * (nv + amt) - st));          // capital/vaults.js executeOne
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 3000; i++) {
    const nv = Math.trunc(rnd() * 5e7), st = Math.trunc(rnd() * nv), s = [0.25, 0.5, 0.6, 0.75, 0.9, 0.99][i % 6];
    const x = SR.fitOf(nv, st, s);
    if (x > 0) {
      assert.ok(cap(nv, st, s, x) >= x, `x=${x} goes in whole (${nv}, ${st}, ${s})`);
      assert.ok(cap(nv, st, s, x + 2) < x + 2, `x+2 doesn't (${nv}, ${st}, ${s})`);
    } else assert.ok(cap(nv, st, s, 1000) < 1000, `0 room: even 1,000 doesn't go in whole (${nv}, ${st}, ${s})`);
  }
  // A queued ahead: it runs first and takes room - the same as a book where it already went in
  assert.equal(SR.fitOf(1e6, 3e5, 0.5, 1e5), SR.fitOf(1.1e6, 4e5, 0.5));
  assert.equal(SR.fitOf(1e6, 3e5, 0.5), 400000, "(0.5 x 1,000,000 - 300,000) / 0.5");
  assert.equal(SR.fitOf(1e6, 9e5, 1), null, "smax 1: no limit");
  assert.equal(SR.fitOf(1e6, 0, 0), 0, "smax 0: nothing");
  for (const v of SR.VAULTS) assert.equal(SR.fitOf(NAV[v], STAKED[v], 0.5), 0, `prod 11-04: the ${v} vault is full`);
});

test("roomOf: full / open per vault; Auto has no limit while vault_auto_staker_cap is off, about the vaults' sum under it", () => {
  const r = SR.roomOf({ nav: NAV, staked: STAKED, smax: 0.5, autoCap: false, minMove: 1000 });
  assert.deepEqual(SR.VAULTS.map((v) => r.vaults[v].full), [true, true, true]);
  assert.equal(Math.round(r.vaults.house.share * 100), 78);
  assert.deepEqual(r.auto, { fit: null, full: false });
  assert.equal(r.anyOpen, true, "Auto still takes stakes");
  const capOn = SR.roomOf({ nav: NAV, staked: STAKED, smax: 0.5, autoCap: true, minMove: 1000 });
  assert.deepEqual(capOn.auto, { fit: 0, full: true });
  assert.equal(capOn.anyOpen, false, "with Auto under the limit too, staking is full");
  const some = SR.roomOf({ nav: { bank: 1e6, house: 1e6, mm: 1e6 }, staked: { bank: 3e5, house: 499800, mm: 6e5 }, smax: 0.5, autoCap: true, minMove: 1000 });
  assert.equal(some.vaults.bank.fit, 400000);
  assert.equal(some.vaults.house.full, true, "room for 400 < the 1,000 minimum = full");
  assert.equal(some.vaults.mm.fit, 0);
  assert.equal(some.auto.fit, 400400, "about the vaults' sum");
  assert.equal(SR.roomOf({ nav: NAV, staked: STAKED, smax: 1, autoCap: true }).vaults.bank.fit, null, "smax 1: no limit anywhere");
});

test("refusal: full says why, what still takes stakes and that there's no date; capped says how much fits; nothing moved", () => {
  const r = SR.roomOf({ nav: NAV, staked: STAKED, smax: 0.5, autoCap: false, minMove: 1000 });
  const full = SR.refusal(r, "house", 100000, { stash: "lavender/nest" });
  assert.equal(full.code, "full");
  assert.equal(full.error, "🏦 The 🎰 House vault is full right now: stakers may own at most 50% of a vault, and they already own 78% of it. "
    + "Nothing moved - your PAT stays in lavender/nest. 🤖 Auto still takes stakes (it spreads them over the three vaults). "
    + "Room opens again when stakers unstake or the vault grows on its own - there's no date for that.");
  assert.equal(SR.refusal(r, "auto", 100000), null, "Auto skips the limit (vault_auto_staker_cap off): it goes in");
  const some = SR.roomOf({ nav: { bank: 1e6, house: 1e6, mm: 1e6 }, staked: { bank: 3e5, house: 499800, mm: 6e5 }, smax: 0.5, autoCap: true, minMove: 1000 });
  const capped = SR.refusal(some, "bank", 500000, { stash: "ann/nest" });
  assert.equal(capped.code, "capped");
  assert.equal(capped.fit, 400000);
  assert.match(capped.error, /^🏦 The 🏦 Bank vault only has room for about PAT 400,000 right now \(stakers may own at most 50% of a vault\)\. Nothing moved - your PAT stays in ann\/nest - stake PAT 400,000 or less\./);
  assert.equal(SR.refusal(some, "bank", 400000), null, "a stake that fits: no refusal");
  assert.match(SR.refusal(some, "mm", 5000).error, /Market maker vault is full right now.*🤖 Auto has room for about PAT 400,400\./);
  const allFull = SR.roomOf({ nav: NAV, staked: STAKED, smax: 0.5, autoCap: true, minMove: 1000 });
  assert.match(SR.refusal(allFull, "auto", 5000, { stash: "x/y" }).error,
               /^🏦 Staking is full right now: every vault is at its staker limit \(stakers may own at most 50% of a vault\), so 🤖 Auto can't take stakes either\. Nothing moved - your PAT stays in x\/y\./);
  assert.match(SR.refusal(allFull, "bank", 5000).error, /Bank vault is full right now: .*Nothing moved\. Room opens again/, "no 'Auto still takes stakes' when it doesn't");
  assert.equal(SR.refusal(some, "auto", 500000, { placed: 300000 }).code, "capped", "Auto under the limit: what its split would place decides");
  assert.match(SR.PAUSED, /^🏦 Staking is paused right now/);
  for (const e of [full.error, capped.error, SR.PAUSED]) {
    assert.ok(e.length < 400, "short enough for one chat line");
    assert.doesNotMatch(e, /\bmoney\b/i, "PAT is points, not money");
  }
});

test("fromSnap: the room from /staking's snapshot (staking.clean keeps min_move + enabled); queued deposits count", () => {
  const snap = staking.clean({ nav: { bank: 1e6, house: 1e6, mm: 1e6 }, staked: { bank: 3e5, house: 3e5, mm: 3e5 },
                               settings: { staker_max: 0.5, auto_staker_cap: false, min_move: 1000, enabled: true },
                               queue: [{ id: "q1", stash: "1", vault: "bank", kind: "deposit", amount: 100000, state: "pending" },
                                       { id: "q2", stash: "1", vault: "house", kind: "deposit", amount: 50000, state: "done" }] });
  assert.equal(snap.settings.min_move, 1000);
  assert.equal(snap.settings.enabled, true);
  assert.equal(staking.clean({ settings: { enabled: false } }).settings.enabled, false);
  assert.equal(staking.clean({ settings: {} }).settings.enabled, true, "an older snapshot: on");
  const r = SR.fromSnap(snap);
  assert.equal(r.vaults.bank.fit, 300000, "the pending 100,000 into the Bank takes its room first");
  assert.equal(r.vaults.house.fit, 400000, "a done one doesn't");
  assert.equal(SR.fromSnap(staking.clean({ settings: {} })), null, "no staker_max: the page can't say");
});

// ── /staking ──
async function render(settings, roomArgs, extra = {}) {
  const snap = staking.clean({ prices: { bank: 1, house: 1.9, mm: 1, auto: 1 }, nav: NAV, staked: STAKED, auto_nav: 3e6,
                               settings: Object.assign({ ceil: 0, floor: 0, topup: false, staker_max: 0.5, auto_staker_cap: false, weighted: true,
                                                         min_move: 1000, enabled: true }, settings),
                               epochs: [], queue: [], positions: {} });
  const room = roomArgs === undefined ? SR.fromSnap(snap) : roomArgs;
  const file = path.join(repo, "views", "staking.ejs");
  return ejs.render(fs.readFileSync(file, "utf8"), Object.assign({
    user: "lavender", signedIn: true, camfrog: "lavender_cf", msg: null, acts: [], now: 1792987200, snap, room,
    mine: [{ id: "9", owner: "lavender_cf", owner_name: "lavender", name: "nest", members: [], hold: {}, cost: {}, paid: null, pd: {},
             total: 0, balance: 250000, owner_me: true, ref: "nest", pending: [] }],
    pnl: staking.pnl, chart: staking.chart([]), rev: [], pending: [], canStake: true,
  }, extra), { filename: file });
}
const form = (h) => h.slice(h.indexOf('id="stakeForm"'), h.indexOf("</form>", h.indexOf('id="stakeForm"')));

test("/staking (prod 11-04: every vault full, Auto open): the room line, full vaults disabled with why, Auto picked", async () => {
  const h = await render({});
  assert.match(h, /id="stakeRoom"/);
  assert.match(h, /Room to stake right now:<\/b>\s*<span class="rv full">🏦 Bank <b>full<\/b><\/span><span class="rv full">🎰 House <b>full<\/b><\/span><span class="rv full">📈 Market maker <b>full<\/b><\/span><span class="rv">🤖 Auto <b>open<\/b><\/span>/);
  assert.match(h, /Stakers may own at most <b>50%<\/b> of a vault, and right now they own Bank 92%, House 78%, Market maker 89%\./);
  assert.match(h, /🤖 Auto still takes stakes: it spreads them over the three vaults and doesn't check the limit\./);
  const f = form(h);
  assert.match(f, /<option value="bank" data-name="🏦 Bank" data-fit="0" disabled>🏦 Bank — full<\/option>/);
  assert.match(f, /<option value="house" data-name="🎰 House" data-fit="0" disabled>🎰 House — full<\/option>/);
  assert.match(f, /<option value="auto" data-name="🤖 Auto" data-fit="" selected>🤖 Auto<\/option>/);
  assert.match(f, /data-full="\{vault\} is full right now\. Pick a vault with room, or try again later\."/);
  assert.match(f, /data-capped="\{vault\} only has room for about PAT \{n\} right now\. Stake that or less\."/);
  assert.match(f, /<p class="sk-why" id="stakeWhy" role="status" aria-live="polite"><\/p>\s*<button type="submit">Stake<\/button>/, "Stake is open (Auto)");
  assert.match(h, /btn\.disabled = !!msg;/, "the amount / vault check before submit");
  if (process.env.STAKE_SHOTS) fs.writeFileSync(path.join(process.env.STAKE_SHOTS, "staking-full-auto-open.html"), h);
});

test("/staking with every vault full (Auto under the limit too) or staking paused: Stake is disabled, with the reason", async () => {
  const h = await render({ auto_staker_cap: true });
  assert.match(h, /class="sk-room shut"/);
  assert.match(h, /<span class="rv full">🤖 Auto <b>full<\/b><\/span>/);
  assert.match(h, /Staking is full right now: every vault is at its staker limit, so nothing can be staked until stakers unstake or the vaults grow on their own\./);
  assert.match(form(h), /id="stakeWhy" role="status" aria-live="polite">Staking is full right now: [^<]+<\/p>\s*<button type="submit" disabled>Stake<\/button>/);
  if (process.env.STAKE_SHOTS) fs.writeFileSync(path.join(process.env.STAKE_SHOTS, "staking-all-full.html"), h);
  const p = await render({ enabled: false });
  assert.match(form(p), /Staking is paused right now \(the vaults are switched off\), so nothing can be staked\.<\/p>\s*<button type="submit" disabled>Stake<\/button>/);
  // a vault with room shows about how much; an older snapshot (no room) renders the form as before
  const some = await render({}, SR.roomOf({ nav: { bank: 1e6, house: 1e6, mm: 1e6 }, staked: { bank: 3e5, house: 6e5, mm: 6e5 }, smax: 0.5, autoCap: false, minMove: 1000 }));
  assert.match(form(some), /<option value="bank" data-name="🏦 Bank" data-fit="400000">🏦 Bank \(about PAT 400,000\)<\/option>/);
  assert.match(some, /<span class="rv">🏦 Bank <b>about PAT 400,000<\/b><\/span>/);
  const old = await render({}, null);
  assert.doesNotMatch(old, /id="stakeRoom"/);
  assert.match(form(old), /<option value="auto" data-name="🤖 Auto" data-fit="" selected>🤖 Auto<\/option>/);
  assert.match(form(old), /<button type="submit">Stake<\/button>/);
});

test("/wallet's stash cards say which vaults take a new stake when one is full (and nothing when all have room)", async () => {
  const loc = (room) => ({ user: "lav", signedIn: true, msg: null, camfrog: "lav_cf", isAdmin: false, now: 1792987200, bal: 1000,
    myStashes: [{ id: "9", owner: "lav_cf", owner_name: "lav", name: "nest", balance: 250000, members: [], member_names: [], owner_me: true, ref: "nest", hold: {}, vaulted: 0 }],
    vaults: null, stashesUpdated: null, borrowed: [], lent: [], loanHistory: [], myRequests: [], reserve: null, positions: [], settledPositions: [],
    myLimit: null, myCredit: null, linked: true, loansOn: false, reserveOn: false, stashOn: true, donateOn: false, welcomeStatus: null, recent: [], acts: [],
    donate: null, stakeRoom: room, ul: (n) => n });
  const file = path.join(repo, "views", "wallet.ejs");
  const h = await ejs.renderFile(file, loc(SR.roomOf({ nav: NAV, staked: STAKED, smax: 0.5, autoCap: false, minMove: 1000 })));
  assert.match(h, /<p class="ds-note warn stake-room" role="note">Room to stake right now: 🏦 Bank <b>full<\/b> · 🎰 House <b>full<\/b> · 📈 Market maker <b>full<\/b> · 🤖 Auto <b>open<\/b> <a href="\/staking#stakeRoom">Why\? ›<\/a><\/p>/);
  const roomy = await ejs.renderFile(file, loc(SR.roomOf({ nav: NAV, staked: { bank: 0, house: 0, mm: 0 }, smax: 0.5, autoCap: false, minMove: 1000 })));
  assert.doesNotMatch(roomy, /stake-room/);
  assert.doesNotMatch(await ejs.renderFile(file, loc(null)), /stake-room/, "no snapshot: nothing claimed");
  assert.match(fs.readFileSync(path.join(repo, "wallet.js"), "utf8"), /stakeRoom: \(\(\) => \{ try \{ return require\("\.\/capital\/stakeroom"\)\.fromSnap\(sk\); \}/);
});
