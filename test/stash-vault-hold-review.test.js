// 1.99akz stashhold review fixes (owner 2026-11-05: "Yes fix both checks." - the reviews of 1.99akv/akz's stash vault holds):
//   * account deletion: the vault check, the balance withdrawal and the close are ONE transaction (a stake landing in between
//     can't close a stash with a stake waiting; a refusal moves nothing), the close must close exactly that row, a member added
//     since blockers() stops it, and the vault check runs BEFORE anything is settled (renewals etc. stay as they were)
//   * the helper fails closed on the book's SHAPE (holders that aren't a plain object, a vault map that isn't one, a queue that
//     isn't one), counts every vault the book lists, and - with a book that isn't inited - an unreadable snapshot is an error
//   * stashes.close: the withdrawal is inside the closing transaction - a refusal there leaves the balance in the stash
//   * the stale notice refresh never clears a warning because the vault book couldn't be read (undecided, left pending)
//   * coverage: a share-free sole-owned stash is still emptied and closed by a deletion while an inited vault book exists
//   TZ=UTC node --test test/stash-vault-hold-review.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stashhold-review-test-"));
process.chdir(dir);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const DAY = 86400000;
const NOW = Date.now();
const ago = (d) => new Date(NOW - d * DAY).toISOString().replace("T", " ").slice(0, 19);
let D, SS, stale, runQuery, getQuery;

const PRICES = { bank: 1.02, house: 2.37, mm: 1.13, auto: 1.066 };
function bookWith(holders = {}, queue = {}) {
  const d = { inited: 1791150237.16, seq: 200, v: {}, auto: { total: 0, holders: {} }, queue, epochs: [], cost: {} };
  for (const v of ["bank", "house", "mm"]) d.v[v] = { total: 1e9, holders: { protocol: 1e8 } };
  for (const [id, h] of Object.entries(holders)) {
    for (const [v, sh] of Object.entries(h)) {
      if (v === "auto") { d.auto.holders["s" + id] = sh; d.auto.total += sh; } else d.v[v].holders["s" + id] = sh;
    }
  }
  return d;
}
// the normal book: someone else's stash (70) holds shares; the stashes these tests delete / close hold none
const NORMAL = () => bookWith({ 70: { auto: 1_000_000 } });
const putBook = async (d) => runQuery("INSERT INTO capital_docs (key, data, updated) VALUES ('vaults', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated",
                                      [typeof d === "string" ? d : JSON.stringify(d), Date.now()]);
const putSnap = async (s) => runQuery("INSERT INTO staking_state (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
                                      [typeof s === "string" ? s : JSON.stringify(s), Date.now()]);
const sqlStr = (x) => JSON.stringify(x).replace(/'/g, "''");
async function user(id, username, login, bal = 0) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, created_at)
                  VALUES (?, ?, ?, NULL, 'x', 'pleb', ?, ?, ?)`, [id, username, username, login, bal, ago(300)]);
}
async function stash(id, owner, name, balance = 0, members = []) {
  await runQuery("INSERT INTO stashes (id, owner, name, balance, staked, created, updated) VALUES (?, ?, ?, ?, 0, 1, 1)", [id, owner, name, balance]);
  for (const m of members) await runQuery("INSERT INTO stash_members (stash_id, login) VALUES (?, ?)", [id, m]);
}
const bal = async (id) => Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b);
const row = async (id) => (await getQuery("SELECT balance, closed FROM stashes WHERE id = ?", [String(id)]))[0];
const renewer = async (target) => (await getQuery("SELECT renewer_id AS r FROM premium_subs WHERE target = ?", [target]))[0].r;
const cancel = (uid) => runQuery("UPDATE account_deletions SET state = 'cancelled' WHERE user_id = ? AND state IN ('scheduled','held')", [uid]);

let setupP = null;
const setup = () => setupP || (setupP = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  D = require(path.join(repo, "accountdelete"));
  SS = require(path.join(repo, "stashes"));
  stale = require(path.join(repo, "staleaccounts"));
  D._setClock(() => NOW);
  await D.init();
  await require(path.join(repo, "sessions")).init();
  await require(path.join(repo, "ledger")).ensure();
  await stale.ensure();
  await SS.init();
  await runQuery("INSERT OR REPLACE INTO stash_meta (key, value) VALUES ('imported', '{\"at\":1}')");
  await user("o7", "CFother001", "other_cf");
  await stash("70", "u:o7", "others");                // someone else's stash, in the vaults
  await putBook(NORMAL());
  await putSnap({ prices: PRICES, positions: {}, queue: [], epochs: [] });
})());

test("deletion: a stake landing DURING the stash withdrawal keeps the stash open with its balance - nothing moves, the job stops", async () => {
  await setup();
  await putBook(NORMAL());
  await user("r1", "CFracerR01", "racerr_cf", 50);
  await stash("60", "u:r1", "slipdel", 700);
  const landedBook = bookWith({ 70: { auto: 1_000_000 } }, { q501: { id: "q501", stash: "60", vault: "auto", kind: "deposit", amount: 300, state: "pending", held: true, ts: 1 } });
  const landed = sqlStr(landedBook);
  await runQuery(`CREATE TRIGGER review_r1 AFTER INSERT ON stash_moves WHEN NEW.key = 'acctdel-r1-stash-60'
                  BEGIN UPDATE capital_docs SET data = '${landed}' WHERE key = 'vaults'; END`);
  try {
    assert.deepEqual((await D.blockers("r1")).block, [], "nothing in the vaults at blockers()");
    await D.schedule({ userId: "r1", username: "CFracerR01" });
    await assert.rejects(D.execute("r1", { force: true }), /stash 60 has PAT in the vaults/);
    assert.deepEqual(await row(60), { balance: 700, closed: null }, "open, with its balance (the withdrawal rolled back with the refusal)");
    assert.equal(await bal("r1"), 50, "nothing paid out, nothing routed");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stash_moves WHERE key = 'acctdel-r1-stash-60'"))[0].n, 0);
  } finally { await runQuery("DROP TRIGGER IF EXISTS review_r1"); }
  // (the trigger's write rolled back with the transaction - on the real chain the stake commits after it:) the next run holds the
  // deletion with the reason, the stash still open
  await putBook(landedBook);
  const r = await D.execute("r1", { force: true });
  assert.equal(r.state, "held");
  assert.match((await D.pendingOf("r1")).held_reason, /PAT in the vaults/);
  assert.equal((await row(60)).closed, null);
  await cancel("r1");
  await putBook(NORMAL());
});

test("deletion: the close must close exactly that stash - PAT landing in it during the run stops the job (nothing moves)", async () => {
  await setup();
  await putBook(NORMAL());
  await user("r2", "CFracerR02", "racerr2_cf", 50);
  await stash("61", "u:r2", "topup", 700);
  // a deposit landing right after the withdrawal took the balance: the close's "balance = 0" no longer holds
  await runQuery(`CREATE TRIGGER review_r2 AFTER INSERT ON stash_moves WHEN NEW.key = 'acctdel-r2-stash-61'
                  BEGIN UPDATE stashes SET balance = balance + 5 WHERE id = '61'; END`);
  try {
    await D.schedule({ userId: "r2", username: "CFracerR02" });
    await assert.rejects(D.execute("r2", { force: true }), /stash 61 couldn't be emptied - not closed/);
    assert.deepEqual(await row(61), { balance: 700, closed: null }, "rolled back: never an open stash with PAT left under a deleted account");
    assert.equal(await bal("r2"), 50);
    assert.ok(await D.pendingOf("r2"), "the deletion is still pending (the next run tries again)");
  } finally { await runQuery("DROP TRIGGER IF EXISTS review_r2"); }
  await cancel("r2");
});

test("deletion: a member joining the stash after blockers() stops the job - the stash is never closed under them", async () => {
  await setup();
  await putBook(NORMAL());
  await user("r3", "CFracerR03", "racerr3_cf", 50);
  await user("m3", "CFmember03", "member3_cf", 0);
  await stash("62", "u:r3", "joined", 700);
  await runQuery("INSERT INTO premium_subs (tier, target, paid_through, renewer_id, status, started, updated) VALUES ('season', 'r3', 9e15, 'r3', 'active', 1, 1)");
  // settle() clears the renewal before the stashes: a trigger there plays a member being added in between
  await runQuery(`CREATE TRIGGER review_r3 AFTER UPDATE OF renewer_id ON premium_subs WHEN OLD.renewer_id = 'r3'
                  BEGIN INSERT INTO stash_members (stash_id, login) VALUES ('62', 'u:m3'); END`);
  try {
    assert.deepEqual((await D.blockers("r3")).block, [], "theirs alone at blockers()");
    await D.schedule({ userId: "r3", username: "CFracerR03" });
    await assert.rejects(D.execute("r3", { force: true }), /stash 62 has other members now - not closed/);
    assert.deepEqual(await row(62), { balance: 700, closed: null });
    assert.equal(await bal("r3"), 50);
  } finally { await runQuery("DROP TRIGGER IF EXISTS review_r3"); }
  // the next run holds it (blockers: a stash with other members)
  assert.equal((await D.execute("r3", { force: true })).state, "held");
  await cancel("r3");
});

test("deletion: a stake landing between blockers() and settle() stops the job BEFORE anything is settled", async () => {
  await setup();
  await putBook(NORMAL());
  await user("r4", "CFracerR04", "racerr4_cf", 50);
  await stash("63", "u:r4", "early", 700);
  await runQuery("INSERT INTO premium_subs (tier, target, paid_through, renewer_id, status, started, updated) VALUES ('season', 'r4', 9e15, 'r4', 'active', 1, 1)");
  // the stash plan asks the helper for exactly ["63"] - once in blockers(), then in settle(): the stake lands before the second ask
  const real = SS.vaultHoldings;
  let asks = 0;
  SS.vaultHoldings = async (ids) => {
    if (Array.isArray(ids) && ids.length === 1 && String(ids[0]) === "63" && ++asks === 2) {
      await putBook(bookWith({ 70: { auto: 1_000_000 }, 63: { auto: 400 } }));
    }
    return real(ids);
  };
  try {
    await D.schedule({ userId: "r4", username: "CFracerR04" });
    await assert.rejects(D.execute("r4", { force: true }), /stash 63 has PAT in the vaults/);
    assert.ok(asks >= 2, `the helper was asked ${asks} time(s)`);
    assert.equal(await renewer("r4"), "r4", "the Season Pass renewal is untouched - nothing was settled");
    assert.deepEqual(await row(63), { balance: 700, closed: null });
    assert.equal(await bal("r4"), 50);
  } finally { SS.vaultHoldings = real; }
  assert.equal((await D.execute("r4", { force: true })).state, "held");
  await cancel("r4");
  await putBook(NORMAL());
});

test("coverage: with an inited vault book (others' shares in it), a share-free sole-owned stash is emptied and closed by the deletion", async () => {
  await setup();
  await putBook(NORMAL());
  await user("r5", "CFplainR05", "plainr5_cf", 100);
  await stash("64", "u:r5", "plain", 900);
  assert.deepEqual((await D.blockers("r5")).block, []);
  assert.ok((await D.blockers("r5")).settle.some((x) => x.code === "stash"), "listed as settled automatically");
  await D.schedule({ userId: "r5", username: "CFplainR05" });
  const r = await D.execute("r5", { force: true });
  assert.equal(r.state, "done", JSON.stringify(r));
  const s = await row(64);
  assert.equal(s.balance, 0);
  assert.ok(s.closed > 0, "closed");
  assert.equal(r.report.settled.stash_pat, 900);
  assert.equal(r.report.route.amount, 1000, "the stash's 900 + the wallet's 100 go to the routing");
  assert.equal((await row(70)).closed, null, "someone else's stash (in the vaults) untouched");
});

test("the helper fails closed on the book's SHAPE: holders / vaults / the vault map / the queue that aren't plain objects", async () => {
  await setup();
  await user("r6", "CFshapeR06", "shaper6_cf", 0);
  await stash("65", "u:r6", "shape", 0);
  const cases = [
    ["auto holders as a pair list (policy/gather.js's wire shape)", (d) => { d.auto.holders = [["s65", 5000]]; }],
    ["a vault's holders as a string", (d) => { d.v.bank.holders = "corrupt"; }],
    ["a vault's holders missing", (d) => { delete d.v.house.holders; }],
    ["a vault that isn't an object", (d) => { d.v.mm = 7; }],
    ["the vault map as a list", (d) => { d.v = [d.v.bank]; }],
    ["no vault map in an inited book", (d) => { delete d.v; }],
    ["the auto fund as a string", (d) => { d.auto = "x"; }],
    ["the queue as a list", (d) => { d.queue = [{ id: "q1", stash: "65", kind: "deposit", state: "pending" }]; }],
    ["a queue item that isn't an object", (d) => { d.queue = { q1: "pending" }; }],
  ];
  for (const [what, spoil] of cases) {
    const d = NORMAL();
    spoil(d);
    await putBook(d);
    const h = await SS.stashHoldings("65");
    assert.match(String(h.error), /vault book can't be read/, what);
    assert.equal(h.held, true, what);
    await assert.rejects(SS.close({ stashId: "65", ownerUserId: "r6", key: `web:r6:close:shape${cases.findIndex((c) => c[0] === what)}` }),
                         (e) => e.code === "E_VAULTS_UNREADABLE", what);
    assert.equal((await row(65)).closed, null, what);
  }
  // every vault the book lists counts - not a fixed list
  const d = NORMAL();
  d.v.lend = { total: 10, holders: { s65: 3 } };
  await putBook(d);
  const h = await SS.stashHoldings("65");
  assert.equal(h.error, null);
  assert.deepEqual(h.shares, { lend: 3 });
  assert.equal(h.inVaults, true);
  // a book without Auto (older books) is fine; the normal book reads clean
  const noAuto = NORMAL();
  delete noAuto.auto;
  await putBook(noAuto);
  assert.deepEqual([(await SS.stashHoldings("65")).error, (await SS.stashHoldings("65")).inVaults], [null, false]);
  await putBook(NORMAL());
  assert.deepEqual([(await SS.stashHoldings("65")).error, (await SS.stashHoldings("65")).inVaults], [null, false]);
});

test("the helper: with a book that isn't inited, the snapshot is the view - unreadable or malformed, it's an error", async () => {
  await setup();
  await user("r7", "CFsnapR007", "snapr7_cf", 0);
  await stash("66", "u:r7", "snaponly", 0);
  const notInited = NORMAL();
  notInited.inited = 0;
  await putBook(notInited);
  await putSnap("{oops");
  let h = await SS.stashHoldings("66");
  assert.match(String(h.error), /staking snapshot can't be read/);
  assert.equal(h.held, true);
  for (const [what, snap] of [["positions as a list", { prices: PRICES, positions: [], queue: [] }],
                              ["a position's holdings as a string", { prices: PRICES, positions: { 66: { hold: "x" } }, queue: [] }],
                              ["the queue as an object", { prices: PRICES, positions: {}, queue: { q1: {} } }]]) {
    await putSnap(snap);
    assert.match(String((await SS.stashHoldings("66")).error), /can't be read/, what);
  }
  // a vault the snapshot lists beyond the usual four counts
  await putSnap({ prices: PRICES, positions: { 66: { hold: { lend: { shares: 4, value: 4 } } } }, queue: [] });
  h = await SS.stashHoldings("66");
  assert.deepEqual([h.error, h.shares, h.inVaults], [null, { lend: 4 }, true]);
  // the inited book decides on its own: an unreadable snapshot doesn't matter then
  await putBook(NORMAL());
  await putSnap("{oops");
  h = await SS.stashHoldings("66");
  assert.deepEqual([h.source, h.error, h.inVaults], ["book", null, false]);
  await putSnap({ prices: PRICES, positions: {}, queue: [], epochs: [] });
});

test("closing a stash: a stake slipping in during the balance withdrawal is refused with NOTHING moved", async () => {
  await setup();
  await putBook(NORMAL());
  await user("r8", "CFcloseR08", "closer8_cf", 0);
  await stash("67", "u:r8", "slip", 500);
  const landed = sqlStr(bookWith({ 70: { auto: 1_000_000 }, 67: { auto: 400 } }));
  await runQuery(`CREATE TRIGGER review_r8 AFTER INSERT ON stash_moves WHEN NEW.key = 'web:r8:close:dddd0001:empty'
                  BEGIN UPDATE capital_docs SET data = '${landed}' WHERE key = 'vaults'; END`);
  try {
    await assert.rejects(SS.close({ stashId: "67", ownerUserId: "r8", key: "web:r8:close:dddd0001" }),
                         (e) => e.code === "E_STASH_IN_VAULTS" && !/went to your wallet/.test(e.message));
    assert.deepEqual(await row(67), { balance: 500, closed: null }, "the balance stays in the stash");
    assert.equal(await bal("r8"), 0, "nothing paid to the wallet");
  } finally { await runQuery("DROP TRIGGER IF EXISTS review_r8"); }
  // an unreadable book inside the transaction: refused (503), nothing moved either - "nothing moved" is what Pepe says
  await putBook(NORMAL());
  const bad = sqlStr("{not json").slice(1, -1);
  await runQuery(`CREATE TRIGGER review_r8b AFTER INSERT ON stash_moves WHEN NEW.key = 'web:r8:close:dddd0002:empty'
                  BEGIN UPDATE capital_docs SET data = '${bad}' WHERE key = 'vaults'; END`);
  try {
    await assert.rejects(SS.close({ stashId: "67", ownerUserId: "r8", key: "web:r8:close:dddd0002" }), (e) => e.code === "E_VAULTS_UNREADABLE" && e.status === 503);
    assert.deepEqual(await row(67), { balance: 500, closed: null });
    assert.equal(await bal("r8"), 0);
  } finally { await runQuery("DROP TRIGGER IF EXISTS review_r8b"); }
  // and with nothing in the vaults it closes as ever, the balance to the wallet
  await putBook(NORMAL());
  const ok = await SS.close({ stashId: "67", ownerUserId: "r8", key: "web:r8:close:dddd0003" });
  assert.deepEqual([ok.ok, ok.paid], [true, 500]);
  assert.ok((await row(67)).closed > 0);
  assert.equal(await bal("r8"), 500);
});

test("stale notice refresh: an unreadable vault book never clears a warning (undecided, left pending); a real hold still clears", async () => {
  await setup();
  await stale.ensureNotice();
  await user("n1", "CFnotice01", "notice1_cf", 0);    // owns an empty stash
  await user("n2", "CFnotice02", "notice2_cf", 0);    // owns a stash with shares
  await user("n3", "CFnotice03", "notice3_cf", 0);    // no stash at all
  await stash("68", "u:n1", "quiet", 0);
  await stash("69", "u:n2", "staked", 0);
  const book = () => bookWith({ 70: { auto: 1_000_000 }, 69: { bank: 10_000 } });
  for (const id of ["n1", "n2", "n3"]) {
    await runQuery(`INSERT INTO stale_notice (userId, run_id, tier, balance, login, username, noticed_at, apply_on, state) VALUES (?, 'stale-test', 'A', 0, ?, ?, ?, '2099-01-01', 'pending')`,
                   [id, id + "_cf", id, NOW]);
  }
  await stale.reloadNotice();                          // the web process's pending set (a notice run is another process)
  const state = async (id) => (await getQuery("SELECT state, cleared_via FROM stale_notice WHERE userId = ?", [id]))[0];
  // the book can't be read: the stash owners are held "stash vaults unreadable" - that says nothing about activity
  await putBook("{not json");
  let r = await stale.refreshNotice({ now: NOW });
  assert.equal((await state("n1")).state, "pending", "not cleared for good over a read error");
  assert.equal((await state("n2")).state, "pending");
  assert.equal((await state("n3")).state, "pending", "still tier A");
  assert.ok(r.undecided >= 2, JSON.stringify(r));
  const p = await stale.plan({ now: NOW, supply: { total: 1, wallets: 1 } });
  const r1 = p.rows.find((r) => r.f.userId === "n1");
  assert.equal(r1.tier, "X", "held meanwhile - never archived while the book can't be read");
  assert.equal(stale.unsureHold(r1), true);
  assert.equal(stale.unsureHold(p.rows.find((r) => r.f.userId === "n3")), false);
  // readable again: the stash with shares is a real hold (cleared, as any hold is); the empty stash's owner stays pending
  await putBook(book());
  r = await stale.refreshNotice({ now: NOW });
  assert.equal((await state("n1")).state, "pending");
  assert.equal((await state("n2")).state, "cleared");
  assert.match((await state("n2")).cleared_via, /activity \(now X\)/);
  assert.equal((await state("n3")).state, "pending");
  await runQuery("DELETE FROM stale_notice WHERE run_id = 'stale-test'");
  await putBook(NORMAL());
});
