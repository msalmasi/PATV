// 1.99ne: Pepe's funding sync survives a site restart (funding.js persist / restore).
//   A site restart while Pepe is down used to reset funding.state to "never synced": boosts booked the Fort Knox half
//   as a Reserve claim and kept the room half in the escrow, flash liquidity turned off. Each phase below runs in its
//   own node process on one database - a real restart.
//   NODE_PATH=G:/PATV/node_modules node --test test/funding-persist.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "funding-persist-"));

// one phase = one site process: runs `body` (an async function source) with F = funding, B = boosts, q = getQuery
function phase(body) {
  const src = `
    process.chdir(${JSON.stringify(tmp)});
    delete process.env.STAGING;
    const path = require("path");
    const { runQuery, getQuery: q } = require(path.join(${JSON.stringify(repo)}, "dbUtils"));
    const F = require(path.join(${JSON.stringify(repo)}, "funding"));
    (async () => {
      await F.init();
      const out = await (async () => { ${body} })();
      await F._persisted();
      process.stdout.write("@@" +JSON.stringify(out === undefined ? null : out));
      process.exit(0);
    })().catch((e) => { console.error(e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", src], { encoding: "utf8", env: process.env, timeout: 60000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return JSON.parse(r.stdout.split("@@").pop());
}

const SYNC = {
  reserve: 40000000, flows: { boost: "reserve", wheel_shortfall: "jackpot", levelup: "incentives" },
  fortknox: 1234567, room_vaults: { on: true, cap: 50000000 },
  incentives: { balance: 900000, week: "2026-W41", remaining: { grants: 500000 }, groups: { levelup: "grants" } },
  monetary: { flash: { house: true, bank: true, mm: false }, fedloan_room: 8000000, house_hard_floor: 5000000,
              donation: { rate: 500000, bonus_pct: 20 }, grant_weekly_cap: -1, week_start: 0 },
};

test("a never-synced site starts on the defaults (nothing saved yet)", () => {
  const s = phase(`await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
                   return { fk: F.fortknoxLive(), rv: F.roomVaultsLive(), mon: F.state.monetary, restored: F.state.restoredAt };`);
  assert.deepEqual(s, { fk: false, rv: false, mon: null, restored: 0 });
});

test("a sync is saved; the next start (Pepe down) restores it: Fort Knox + room vaults live, flash liquidity on", () => {
  const before = phase(`F.sync(${JSON.stringify(SYNC)}); return { syncedAt: F.state.syncedAt };`);
  assert.ok(before.syncedAt > 0);
  const s = phase(`return { fk: F.fortknoxLive(), rv: F.roomVaultsLive(), state: F.state, restored: F.state.restoredAt > 0,
                            reserve: await F.reserveAvailable(), vault: F.vaultFor("levelup"), house: F.houseBacked() };`);
  assert.equal(s.fk, true, "boosts book the Fort Knox half as fortknox:<flow> again");
  assert.equal(s.rv, true, "the room half goes to the room vault again");
  assert.equal(s.restored, true);
  assert.equal(s.state.syncedAt, before.syncedAt, "the ORIGINAL sync time is kept (stale-sync alerts still fire)");
  assert.deepEqual(s.state.monetary.flash, { house: true, bank: true, mm: false });
  assert.equal(s.state.monetary.fedloan_room, 8000000);
  assert.deepEqual(s.state.room_vaults, { on: true, cap: 50000000 });
  assert.equal(s.state.fortknox, 1234567);
  assert.equal(s.reserve, 40000000, "Reserve-routed grants aren't refused as 'never synced'");
  assert.equal(s.vault, "incentives");
  assert.equal(s.house, true);
});

test("after the restart the House flash liquidity books exactly as before it", () => {
  const s = phase(`
    await runQuery("DELETE FROM jackpot_rakes");
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, amount) VALUES ('seed', 5100000)");
    const r = await F.houseFlashCover("wheel", 300000, "u1", "wheel prize", "spin:x");
    const c = await q("SELECT flow, amount FROM reserve_claims WHERE flow LIKE 'flash:%'");
    return { r, c };`);
  assert.equal(s.r.used, true);
  assert.equal(s.r.gap, 200000);
  assert.deepEqual(s.c, [{ flow: "flash:house:wheel", amount: 200000 }]);
});

test("after the restart a boost is routed like before it: fortknox:boost + room:boost:<pad> claims, not Reserve / escrow", () => {
  const s = phase(`
    const rooms = require(path.join(${JSON.stringify(repo)}, "rooms"));
    rooms.get = async (id) => ({ id, platform: "camfrog" });     // a registered Camfrog pad (vaultEligible)
    rooms.platformOf = () => "camfrog";
    const B = require(path.join(${JSON.stringify(repo)}, "boosts"));
    await runQuery(\`CREATE TABLE IF NOT EXISTS room_flow_ledger (ref TEXT PRIMARY KEY, kind TEXT, room_id TEXT, payer_id TEXT,
      payer_name TEXT, amount INTEGER, fortknox INTEGER, room_vault INTEGER, owner_self INTEGER, via TEXT, created INTEGER,
      detail TEXT, fk_to TEXT, rv_to TEXT)\`);
    const row = await B.routeInTx({ ref: "boost:u1:t1", kind: "boost", room_id: "padx", payer_id: "u1", payer_name: "ann", amount: 1001 });
    const c = await q("SELECT flow, amount FROM reserve_claims WHERE flow NOT LIKE 'flash:%' ORDER BY flow");
    return { row: { fk_to: row.fk_to, rv_to: row.rv_to, fortknox: row.fortknox, room_vault: row.room_vault }, c };`);
  assert.deepEqual(s.row, { fk_to: "fortknox", rv_to: "room", fortknox: 501, room_vault: 500 });
  assert.deepEqual(s.c, [{ flow: "fortknox:boost", amount: -501 }, { flow: "room:boost:padx", amount: -500 }]);
});

test("a live sync after the restart replaces the restored state (and is what the next start restores)", () => {
  const s = phase(`F.sync({ reserve: 1, flows: {} }); return { fk: F.fortknoxLive(), rv: F.roomVaultsLive(), mon: F.state.monetary, restored: F.state.restoredAt };`);
  assert.deepEqual(s, { fk: false, rv: false, mon: null, restored: 0 }, "Pepe turning the layers off still turns them off");
  const s2 = phase(`return { fk: F.fortknoxLive(), mon: F.state.monetary, reserve: F.state.reserve, flows: F.state.flows };`);
  assert.equal(s2.fk, false);
  assert.equal(s2.mon, null);
  assert.equal(s2.reserve, 1);
  assert.equal(s2.flows.boost, "reserve", "flows merge across syncs, as in memory");
});

test("a sync that arrives before the restore finished wins over the saved state", () => {
  phase(`F.sync(${JSON.stringify(SYNC)});`);
  const s = phase(`return { fk: F.fortknoxLive(), restored: F.state.restoredAt > 0 };`);
  assert.equal(s.fk, true);
  // the restore never overwrites a live sync
  const s2 = phase(`F.sync({ reserve: 7 }); F.state.syncedAt = Date.now(); const did = await F.restore(); return { did, reserve: F.state.reserve, fk: F.fortknoxLive() };`);
  assert.deepEqual(s2, { did: false, reserve: 7, fk: false });
});
