// h22 phase 2 (1.99??): guarantees and freerolls (casino/mttbudget.js) - the incentive budget through the budget service (PO-5, hand-off 23
// D3: stubbed here through mttbudget._hooks.budget, with a REAL policy/config and rows in policy_ownership), only from H2b (Tue 2026-12-01
// 14:00:00 UTC). The create gate vs the spend gate, the creation checks (caps, weekly exposure, series, headroom, the group), the overlay paid
// ONCE under its key after the escrow settle (incentives down by O, wallets up by O, nothing from the House / the Fed / a player), every
// non-terminal outcome retried under the same key, a terminal refusal = owed, the owner's retry, payees that vanished or merged, the
// single-destination fallback, a freeroll end to end, and a static guard on every casino/mtt*.js file.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { harness } = require("./fixtures/mtt-harness");
const h = harness("casino-mtt-budget");
const { svc, MT, getQuery, runQuery } = h;
const BUD = require(path.join(h.repo, "casino", "mttbudget"));
const CFG = require(path.join(h.repo, "policy", "config"));
const SEAT = require(path.join(h.repo, "casino", "mttseat"));
SEAT.newSeed = () => "b2".repeat(32);
const opsalerts = require(path.join(h.repo, "opsalerts"));
const alerts = [];
opsalerts.alert = async (a) => { alerts.push(a); return { ok: true }; };
const staffroles = require(path.join(h.repo, "staffroles"));
staffroles.ownerOf = async (u) => (u && u.userId === "ad" ? { userId: "ad", username: "ada" } : null);

const AFTER = Date.UTC(2026, 11, 6, 15, 0, 0);       // Sun 2026-12-06, after H2b
/** the budget service stub (PO-5's in-process contract, open point 1): one keyed spend - incentives down, wallets up, one row */
const stub = {
  calls: [], terminal: null, throwNext: null, room: 10000000, multiLeg: true, refuseLeg: null,
  async spendInTx(b) {
    this.calls.push(JSON.parse(JSON.stringify(b)));
    if (this.throwNext) { const e = this.throwNext; this.throwNext = null; throw e; }
    const done = await getQuery("SELECT result FROM stub_spends WHERE key = ?", [b.key]);
    if (done.length) return JSON.parse(done[0].result);
    if (this.terminal) {
      const r = { ok: false, terminal: true, code: this.terminal };
      await runQuery("INSERT INTO stub_spends (key, amount, result) VALUES (?, 0, ?)", [b.key, JSON.stringify(r)]);
      return r;
    }
    const legs = b.legs || [{ userId: b.to, amount: b.amount, reason: b.reason }];
    if (this.refuseLeg && legs.some((l) => l.userId === this.refuseLeg)) return { ok: false, code: "refused" };
    const total = legs.reduce((s, l) => s + l.amount, 0);
    await runQuery("UPDATE pools SET balance = balance - ? WHERE key = 'incentives'", [total]);
    for (const l of legs) await require(path.join(h.repo, "ledger")).post(l.userId, l.amount, l.reason || "tournament guarantee", { resolveMerged: true });
    await runQuery("INSERT INTO stub_spends (key, amount, result) VALUES (?, ?, ?)", [b.key, total, JSON.stringify({ ok: true })]);
    return { ok: true };
  },
  async remaining() { return this.room; },
  async weekOf(at) { return BUD.weekFallback(at); },
};
BUD._hooks.budget = stub;
async function own(owner, paused) {
  await CFG.init();
  await runQuery(`INSERT INTO policy_ownership (feature, owner, paused) VALUES ('budget', ?, ?) ON CONFLICT(feature) DO UPDATE SET owner = excluded.owner, paused = excluded.paused`, [owner, paused ? 1 : 0]);
  CFG.forget();
}
async function base(o = {}) {
  h.NOW = Math.max(h.NOW, o.at || AFTER);
  await h.fresh(Object.assign({}, o, { settings: Object.assign({ mtt_guarantees: "on" }, o.settings || {}) }));
  await runQuery("CREATE TABLE IF NOT EXISTS stub_spends (key TEXT PRIMARY KEY, amount INTEGER, result TEXT)");
  await runQuery("DELETE FROM stub_spends");
  await require(path.join(h.repo, "pools")).init();
  await runQuery("INSERT OR REPLACE INTO pools (key, label, balance) VALUES ('incentives', 'x', 50000000)");
  Object.assign(stub, { calls: [], terminal: null, throwNext: null, room: 10000000, multiLeg: true, refuseLeg: null });
  BUD._hooks.budget = stub;
  alerts.length = 0;
  await own("site", false);
}
const P = () => h.players;

test.before(async () => { await h.setup(40); });
test.after(() => svc.stop());

test("the gates: refused before 2026-12-01 14:00:00 UTC (to the ms), then each missing condition its own reason; the create gate also needs mtt_guarantees on; H2B_AT is no setting", async () => {
  await base();
  assert.equal(BUD.H2B_AT, Date.UTC(2026, 11, 1, 14, 0, 0, 0));
  assert.deepEqual(await BUD.spendGate(Date.UTC(2026, 11, 1, 13, 59, 59, 999)), { ok: false, why: "before_h2b" });
  assert.deepEqual(await BUD.spendGate(Date.UTC(2026, 11, 1, 14, 0, 0, 0)), { ok: true });
  await own("cutting", false);
  assert.equal((await BUD.spendGate(AFTER)).why, "budget_not_site");
  await own("pepe", false);
  assert.equal((await BUD.spendGate(AFTER)).why, "budget_not_site");
  await own("site", true);
  assert.equal((await BUD.spendGate(AFTER)).why, "budget_paused");
  await own("site", false);
  BUD._hooks.budget = { spendInTx() {} };                  // no remaining / weekOf
  assert.equal((await BUD.spendGate(AFTER)).why, "no_budget_service");
  BUD._hooks.budget = null;                                 // policy/budget.js isn't installed
  assert.equal((await BUD.spendGate(AFTER)).why, "no_budget_service");
  BUD._hooks.budget = stub;
  assert.equal((await BUD.createGate(AFTER, { mtt_guarantees: "off" })).why, "switch_off");
  assert.deepEqual(await BUD.createGate(AFTER, { mtt_guarantees: "on" }), { ok: true });
  for (const k of ["H2B_AT", "mtt_h2b_at", "h2b"]) await assert.rejects(() => svc.setSetting(k, String(Date.now()), "test"));
  // without the module the admin form says why (no_budget_service): never a guarantee
  BUD._hooks.budget = undefined;
  assert.equal((await BUD.spendGate(AFTER)).why, "no_budget_service", "policy/budget.js is not on this branch");
  BUD._hooks.budget = stub;
});

test("before H2b nothing guaranteed can be scheduled (the form refuses a guarantee and a freeroll)", async () => {
  await base({ at: Date.UTC(2026, 10, 20, 12, 0, 0) });
  h.NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
  const r = await svc.locked(() => MT.admin("create", h.admin, null, { title: "Early", start_at: h.NOW + 3600e3, buyin: 1000, guarantee: 20000, min_entries: 2 })).catch((e) => ({ ok: false, error: e.message }));
  assert.equal(r.ok, false);
  assert.match(r.error, /locked until 2026-12-01 14:00 UTC/);
  const f = await svc.locked(() => MT.admin("create", h.admin, null, { title: "Early free", start_at: h.NOW + 3600e3, buyin: 0, guarantee: 20000, min_entries: 2 })).catch((e) => ({ ok: false, error: e.message }));
  assert.equal(f.ok, false);
  h.NOW = AFTER;
});

test("creation checks: the overlay cap, the weekly exposure over both weeks a Sunday-evening ET start touches, a series counted instance by instance, the current week's headroom, the group budget", async () => {
  await base({ settings: { mtt_overlay_cap: 30000, mtt_overlay_week_cap: 50000 } });
  const mk = (form) => svc.locked(() => MT.admin("create", h.admin, null, Object.assign({ title: "Gtd", buyin: 1000, min_entries: 2, max_entries: 20, structure: "standard" }, form))).catch((e) => ({ ok: false, error: e.message }));
  // the most it could add: G - min x buy-in = 40,000 - 2,000 > 30,000 cap
  let r = await mk({ start_at: AFTER + 2 * 3600e3, guarantee: 40000 });
  assert.match(r.error, /over the overlay cap/);
  r = await mk({ start_at: AFTER + 2 * 3600e3, guarantee: 30000, min_entries: 2 });
  assert.ok(r.ok, JSON.stringify(r));                          // X = 28,000
  // the same week again: 28,000 + 28,000 > 50,000
  r = await mk({ start_at: AFTER + 4 * 3600e3, guarantee: 30000 });
  assert.match(r.error, /weekly cap/);
  // a Sunday 9 PM ET start runs past Monday 04:00 UTC: both weeks count (the next week has room; this one doesn't)
  const sunLate = require(path.join(h.repo, "casino", "mtt")).parseEt("2026-12-06T21:00");     // (02:00 UTC Monday: the budget week turns at 04:00 UTC)
  r = await mk({ start_at: sunLate, guarantee: 30000, max_entries: 60 });
  assert.match(r.error, /weekly cap/, "a window straddling two budget weeks counts in both");
  // a series: instances counted against each other (weekly x3: each week alone is fine)
  r = await mk({ start_at: AFTER + 8 * 86400e3, guarantee: 20000, repeat: "weekly", count: 3 });
  assert.ok(r.ok, JSON.stringify(r));
  r = await mk({ start_at: AFTER + 8 * 86400e3 + 3600e3, guarantee: 20000, repeat: "daily", count: 2 });
  assert.match(r.error, /weekly cap/, "the series' first instance already took the week's room");
  // the current week's headroom minus the other unpaid guarantees
  stub.room = 20000;
  r = await mk({ start_at: AFTER + 5 * 3600e3, guarantee: 1000 * 2 + 1500, min_entries: 2 });
  assert.match(r.error, /incentive budget can't cover/);
  stub.room = 10000000;
  // the weekly cap can't exceed the group's budget (roomgames 3.5M by default); misc 350K
  await assert.rejects(() => svc.setSetting("mtt_overlay_week_cap", "4000000", "test"), /budget/);
  await svc.setSetting("mtt_budget_group", "misc", "test");
  await assert.rejects(() => svc.setSetting("mtt_overlay_week_cap", "400000", "test"), /budget/);
  await assert.rejects(() => svc.setSetting("mtt_budget_group", "activity", "test"), /roomgames, misc/);
});

test("freeroll rules: buy-in 0 needs a guarantee, no re-entries; entrants: no auto accounts, level 3+, 7+ days old", async () => {
  await base();
  let r = await svc.locked(() => MT.admin("create", h.admin, null, { title: "Free", buyin: 0, start_at: AFTER + 3600e3, min_entries: 2 })).catch((e) => ({ ok: false, error: e.message }));
  assert.match(r.error, /needs a guarantee/);
  const M = await h.schedule({ buyin: 0, guarantee: 20000, reentry_max: 1, min_entries: 2 });
  assert.equal(M.structure.reentry_max, 0, "forced 0");
  assert.equal(M.money.fee, 0);
  await runQuery("UPDATE users SET level = 1 WHERE userId = ?", [P()[0].uid]);
  r = await h.M(P()[0], "join", [String(M.no)]);
  assert.match(r.reply, /Freerolls are for members with level 3\+ and an account at least 7 days old/);
  await runQuery("UPDATE users SET level = 10, createdAt = ? WHERE userId = ?", [new Date(AFTER - 2 * 86400e3).toISOString().replace("T", " ").slice(0, 19), P()[1].uid]);
  r = await h.M(P()[1], "join", [String(M.no)]);
  assert.match(r.reply, /Freerolls are for members/);
  await runQuery("UPDATE users SET level = 10, createdAt = '2026-01-01 00:00:00'");
});

test("a freeroll end to end: no holds, the finish is a journal row only, the whole prize pool (G) paid once through the budget; unregister / cancel make no escrow call", async () => {
  await base();
  const before = await h.total(), inc0 = await h.incentives();
  const M = await h.schedule({ buyin: 0, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(0, 4));
  assert.equal(await h.held(), 0, "no holds");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE ref = ?", [`TNY-${M.id}`]))[0].n, 0);
  h.NOW += 2500;
  assert.ok((await h.M(P()[3], "leave", [String(M.no)])).ok);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE ref = ?", [`TNY-${M.id}`]))[0].n, 0, "an amount-0 unregister: no escrow call");
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.status, "done");
  const mv = await getQuery("SELECT * FROM escrow_moves WHERE key = ?", [`tny:${M.id}:finish`]);
  assert.equal(mv.length, 1);
  assert.equal(JSON.parse(mv[0].result).freeroll, true, "the finish is a journal row");
  assert.equal(M.finish.overlay.state, "paid");
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].key, `tny:${M.id}:overlay`);
  assert.equal(stub.calls[0].flow, "incentives:casino_mtt");
  assert.equal(inc0 - (await h.incentives()), 20000, "incentives down by G");
  assert.equal(await h.total(), before, "conservation (wallets + held + House + incentives)");
  const ent = await h.entries(M, "state = 'spent'");
  assert.equal(ent.reduce((s, e) => s + e.overlay, 0), 20000);
  // a cancelled freeroll: no escrow call either
  const M2 = await h.schedule({ buyin: 0, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M2, P().slice(10, 13));
  const r = await svc.locked(() => MT.admin("cancel", h.admin, M2, { confirm: true, reason: "test" }));
  assert.ok(r.ok);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE ref = ? AND key <> ?", [`TNY-${M2.id}`, `tny:${M2.id}:cancel`]))[0].n, 0);
  assert.equal(stub.calls.length, 1, "no overlay for a cancelled one");
});

test("a guaranteed buy-in: the overlay (G - pool) is paid once after the escrow settle - incentives -O, wallets +O; no House / Fed / reserve rows; the switch going off after the freeze changes nothing", async () => {
  await base();
  const before = await h.total(), inc0 = await h.incentives(), house0 = await h.house();
  const M = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(0, 4));
  await svc.setSetting("mtt_guarantees", "off", "test");       // after the freeze: the announced guarantee stands
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.status, "done");
  assert.equal(M.finish.overlay.amount, 16000);
  assert.equal(M.finish.overlay.state, "paid");
  assert.equal(inc0 - (await h.incentives()), 16000);
  assert.equal(await h.house() - house0, 400, "the House gets the fee leg only (4 x 100)");
  assert.equal(await h.total(), before);
  assert.equal(stub.calls.length, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims").catch(() => [{ n: 0 }]))[0].n, 0);
  const ent = await h.entries(M, "state = 'spent'");
  for (const e of ent) assert.equal(e.overlay_due, 0);
  assert.equal(ent.reduce((s, e) => s + e.prize + e.overlay, 0), 20000, "prizes = escrow + overlay = G");
});

test("non-terminal outcomes stay pending and retry under the SAME key (paused, the budget not the site's, headroom on a paced Monday, a transient throw); 7 days pending = owed", async () => {
  await base();
  const M = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(0, 3));
  await own("site", true);                                    // paused before the finish
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" });
  await h.later(1);
  assert.equal(M.status, "settled");
  assert.equal(M.finish.overlay.state, "pending");
  assert.equal(M.finish.overlay.last_code, "budget_paused");
  assert.equal(stub.calls.length, 0, "nothing called while paused");
  await own("cutting", false);
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.last_code, "budget_not_site");
  await own("site", false);
  stub.room = 0;
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.last_code, "headroom");
  stub.room = 10000000;
  stub.throwNext = Object.assign(new Error("transient"), { code: "E_BUSY" });
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.state, "pending");
  assert.equal(M.finish.overlay.last_code, "E_BUSY");
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.state, "paid");
  assert.ok(stub.calls.every((c) => c.key === `tny:${M.id}:overlay`), "the same key every time");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stub_spends WHERE result LIKE '%\"ok\":true%'"))[0].n, 1, "paid once");
  // 7 days pending -> owed
  const M2 = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M2, P().slice(10, 13));
  await own("site", true);
  await h.toStart(M2);
  await h.drive(M2, { policy: h.allIn(), until: (m) => m.status !== "running" });
  for (let d = 0; d < 8; d++) { h.NOW += 86400e3; await svc.tickOnce(); }
  assert.equal(M2.finish.overlay.state, "owed");
  assert.ok(alerts.some((a) => /owed/.test(a.title)));
  await own("site", false);
});

test("a terminal refusal (recorded by the budget service and returned) = owed in the same transaction; the owner's retry: only when owed, a new key (...:overlay:a1), never the old one", async () => {
  await base();
  stub.terminal = "E_BUDGET_REFUSED";
  const M = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(0, 3));
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.finish.overlay.state, "owed");
  assert.equal(M.finish.overlay.last_code, "E_BUDGET_REFUSED");
  let r = await svc.locked(() => MT.admin("overlay-retry", h.staff, M, {}));
  assert.equal(r.status, 403, "casino.admin + the owner role");
  stub.terminal = null;
  r = await svc.locked(() => MT.admin("overlay-retry", h.admin, M, {}));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(M.finish.overlay.state, "paid");
  assert.equal(stub.calls[stub.calls.length - 1].key, `tny:${M.id}:overlay:a1`);
  r = await svc.locked(() => MT.admin("overlay-retry", h.admin, M, {}));
  assert.equal(r.ok, false, "only an owed one");
});

test("payees: a vanished account's leg is forfeited (logged, it stays in the incentives pool), a merged one is resolved; account deletion is blocked while a guaranteed part is owed", async () => {
  await base();
  await runQuery("CREATE TABLE IF NOT EXISTS account_merges (old_id TEXT, new_id TEXT)");
  const M = await h.schedule({ buyin: 1000, guarantee: 30000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(20, 24));
  await own("site", true);
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" });
  await h.later(1);
  const paid = M.finish.payouts.filter((p) => p.overlay > 0);
  assert.ok(paid.length >= 2);
  // deletion blocked while overlay_due > 0 (staleaccounts' shared "in flight" check reads a few more user columns)
  for (const c of ["isEmailVerified INTEGER", "created_at TEXT"]) await runQuery(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  const AD = require(path.join(h.repo, "accountdelete"));
  const bl = await AD.blockers(paid[0].user_id).catch((e) => ({ block: [{ code: "error:" + e.message }] }));
  assert.ok(bl.block.some((b) => /tournament entry/.test(b.code)), JSON.stringify(bl.block));
  // one payee vanished, one merged into another account
  await runQuery("DELETE FROM users WHERE userId = ?", [paid[0].user_id]);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES ('merged-into', 'mergedinto', 'MI', 'x', 0)");
  const amCols = (await getQuery("PRAGMA table_info(account_merges)")).map((c) => c.name);
  await runQuery(`INSERT INTO account_merges (old_id, new_id${amCols.includes("merged_at") ? ", merged_at" : ""}) VALUES (?, 'merged-into'${amCols.includes("merged_at") ? ", ?" : ""})`,
                 amCols.includes("merged_at") ? [paid[1].user_id, Date.now()] : [paid[1].user_id]);
  await runQuery("DELETE FROM users WHERE userId = ?", [paid[1].user_id]);
  await own("site", false);
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.state, "paid");
  assert.deepEqual(M.finish.overlay.forfeited, [{ user_id: paid[0].user_id, amount: paid[0].overlay }]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM casino_mtt_log WHERE tid = ? AND kind = 'overlay leg forfeited'", [M.id]))[0].n, 1);
  assert.equal(await h.bal("merged-into"), paid[1].overlay, "the merged account got its share");
  const spent = stub.calls[stub.calls.length - 1].legs.reduce((s, l) => s + l.amount, 0);
  assert.equal(spent, M.finish.overlay.amount - paid[0].overlay, "the forfeited leg was never spent");
});

test("the single-destination fallback: a headroom pre-check, one spend per leg (<key>:<place>), all or nothing in one transaction", async () => {
  await base();
  stub.multiLeg = false;
  stub.refuseLeg = null;
  const M = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(0, 4));
  await h.toStart(M);
  await own("site", true);
  await h.drive(M, { policy: h.allIn(), until: (m) => m.status !== "running" });
  await h.later(1);
  const second = M.finish.payouts.find((p) => p.place === 2);
  stub.refuseLeg = second.user_id;
  await own("site", false);
  const inc0 = await h.incentives();
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.state, "pending", "one leg refused: nothing paid");
  assert.equal(await h.incentives(), inc0, "rolled back");
  stub.refuseLeg = null;
  h.NOW += 5 * 60e3 + 1; await svc.tickOnce();
  assert.equal(M.finish.overlay.state, "paid");
  assert.ok(stub.calls.filter((c) => !c.legs).every((c) => /^tny:m[0-9a-f]{9}:overlay:\d+$/.test(c.key)));
  assert.equal(inc0 - (await h.incentives()), 16000);
});

test("the create gate fails at registration time: it stays scheduled with one alert, then is cancelled at its start with nothing held", async () => {
  await base();
  const M = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 }, { open: false });
  await own("site", true);
  await h.later(1);
  await h.later(1);
  assert.equal(M.status, "scheduled");
  assert.equal(alerts.filter((a) => /can't open registration/.test(a.title)).length, 1, "one alert");
  await h.toStart(M);
  assert.equal(M.status, "cancelled");
  assert.match(M.cancel.reason, /guarantee unavailable/);
  assert.equal(await h.held(), 0);
  await own("site", false);
});

test("static guard: no casino/mtt*.js file moves PAT any other way (money.house, grantInTx, funding., pools.move, the Fed); mttbudget.js alone requires policy/budget", () => {
  const dir = path.join(h.repo, "casino");
  const files = fs.readdirSync(dir).filter((f) => /^mtt.*\.js$/.test(f));
  assert.deepEqual(files.sort(), ["mtt.js", "mttbudget.js", "mttpay.js", "mttseat.js"]);
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    for (const bad of [/money\.house/, /grantInTx/, /\bfunding\./, /pools?\.move\b/, /require\([^)]*fed\//, /\.\.\/fed\b/]) assert.doesNotMatch(src, bad, `${f}: ${bad}`);
    if (f !== "mttbudget.js") assert.doesNotMatch(src, /policy\/budget/, `${f} never requires policy/budget`);
  }
  for (const f of fs.readdirSync(path.join(h.repo, "casino"))) {
    if (f === "mttbudget.js" || !f.endsWith(".js")) continue;
    assert.doesNotMatch(fs.readFileSync(path.join(h.repo, "casino", f), "utf8"), /require\(["']\.\.\/policy\/budget["']\)/, f);
  }
});

test("review: an owner retry that doesn't pay (the budget paused) goes back to owed - the retry button keeps working and the next one pays under a new key; a casino admin who isn't the owner can't void or retry", async () => {
  await base();
  stub.terminal = "E_BUDGET_REFUSED";
  const M = await h.schedule({ buyin: 1000, guarantee: 20000, min_entries: 2, max_entries: 20 });
  await h.reg(M, P().slice(0, 3));
  await h.toStart(M);
  await h.drive(M, { policy: h.allIn() });
  assert.equal(M.finish.overlay.state, "owed");
  stub.terminal = null;
  // a second casino admin (class Admin: casino.admin) who isn't the owner: refused by the OWNER check (not by casino.admin)
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class, points_balance) VALUES ('ad2', 'ada2', 'Ada2', 'x', 'Admin', 1000000)");
  const ad2 = h.mk("ad2", "Ada2");
  let r = await svc.locked(() => MT.admin("overlay-retry", ad2, M, {}));
  assert.equal(r.status, 403, "overlay retry: the owner only");
  assert.equal(r.error, staffroles.OWNER_ONLY);
  r = await svc.locked(() => MT.admin("void", ad2, M, { confirm: true, reason: "x" }));
  assert.equal(r.status, 403, "void: the owner only");
  assert.equal(r.error, staffroles.OWNER_ONLY);
  assert.ok((await svc.locked(() => MT.admin("pause", ad2, M, {}))).status !== 403, "(ad2 is a casino admin: other actions aren't refused as non-admin)");
  // the owner retries while the budget is paused: nothing paid, the overlay goes back to owed (never a pending one no tick looks at)
  await own("site", true);
  r = await svc.locked(() => MT.admin("overlay-retry", h.admin, M, {}));
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(M.finish.overlay.state, "owed");
  assert.equal(M.finish.overlay.last_code, "budget_paused");
  assert.equal(stub.calls.length, 1, "the budget service wasn't called while paused");
  for (let i = 0; i < 3; i++) { h.NOW += 10 * 60e3; await svc.tickOnce(); }
  assert.equal(M.finish.overlay.state, "owed");
  await own("site", false);
  r = await svc.locked(() => MT.admin("overlay-retry", h.admin, M, {}));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(M.finish.overlay.state, "paid");
  assert.equal(stub.calls[stub.calls.length - 1].key, `tny:${M.id}:overlay:a2`, "a new key per retry");
  const ent = await h.entries(M, "state = 'spent'");
  assert.equal(ent.reduce((s, e) => s + e.overlay_due, 0), 0, "nothing owed any more (account merges unblocked)");
});
