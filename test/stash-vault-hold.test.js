// 1.99akv stashhold (owner 2026-11-05: "Yes fix both checks."): the stale-account cleanup and account deletion counted a stash
// as holding PAT only by its balance (or the dead 1.90 `staked` column) - never its VAULT SHARES. Since 1.92 a stake IS vault
// shares (holder "s<id>" in capital/vaults.js's book), so a stash with balance 0 and millions in shares (prod: stash 40, ~9.4M PAT
// in 🤖 Auto) held nobody: deletion closed it, and its shares were stuck (the weekly payout skips closed stashes; an unstake
// needs an open one). Now ONE helper (stashes.vaultHoldings / stashHoldings) answers for every check:
//   * the helper: shares per vault from the vault book (the staking snapshot when there's no inited book), their value at the
//     snapshot's prices, the stash's stake / unstake requests still in the queue; a book that can't be read is an ERROR
//   * staleaccounts: "stash in vaults" holds the owner AND members (tier X), "stash vaults unreadable" when the book can't be
//     read (fail closed); a stash with nothing anywhere changes nothing
//   * accountdelete: such a stash is never auto-closed - the deletion is blocked / held with a clear reason; the job checks
//     again right before it closes a stash
//   * stashes.close (website + Pepe's chat): refused with shares / a request waiting / an unreadable book; re-checked in the
//     closing transaction
//   TZ=UTC node --test test/stash-vault-hold.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stashhold-test-"));
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

// prod's numbers (2026-11-05 19:17Z): stash 40 "made" - balance 0, 8,814,423.76 🤖 Auto shares at 1.0665 = PAT 9,400,582
const PRICES = { bank: 1.024782161111687, house: 2.3728289367185336, mm: 1.1368896408489675, auto: 1.066499911502443 };
const S40_AUTO = 8814423.757626599;
let book = null;
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
const putBook = async (d) => {
  book = d;
  await runQuery("INSERT INTO capital_docs (key, data, updated) VALUES ('vaults', ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated",
                 [typeof d === "string" ? d : JSON.stringify(d), Date.now()]);
};
const putSnap = async (s) => runQuery("INSERT INTO staking_state (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated = excluded.updated",
                                      [JSON.stringify(s), Date.now()]);
const dropBook = () => runQuery("DELETE FROM capital_docs WHERE key = 'vaults'");
const dropSnap = () => runQuery("DELETE FROM staking_state");
// the normal state: stash 40 (shares only), 43 (shared, bank shares only), 44 (a stake waiting in the queue)
const NORMAL = () => bookWith({ 40: { auto: S40_AUTO }, 43: { bank: 50_000 } },
                              { q90: { id: "q90", stash: "44", vault: "auto", kind: "deposit", amount: 5_000, state: "pending", held: true, ts: 1 },
                                q80: { id: "q80", stash: "45", vault: "auto", kind: "deposit", amount: 5_000, state: "done", ts: 1 },
                                q81: { id: "q81", stash: "45", vault: "bank", kind: "withdraw", shares: 10, state: "failed", ts: 1 } });

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
const tiers = async () => {
  const p = await stale.plan({ now: NOW, supply: { total: 1, wallets: 1 } });
  return Object.fromEntries(p.rows.map((r) => [r.f.userId, { tier: r.tier, why: r.why }]));
};

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
  // auto "CF" accounts, no activity of their own, unseen 300 days: tier A - unless something holds them
  await user("mk", "CFmaker001", "maker_cf");          // owns 40 "made": balance 0, shares only
  await user("ow", "CFowner001", "owner_cf");          // owns 43 "shared": balance 0, bank shares only, member fr
  await user("fr", "CFfriend01", "friend_cf");         // a member of 43
  await user("pd", "CFpendin01", "pend_cf");           // owns 44 "waiting": balance 0, no shares, a stake waiting in the queue
  await user("em", "CFempty001", "empty_cf");          // owns 45 "empty": nothing anywhere (its requests are done / failed)
  await user("ns", "CFnostsh01", "nostash_cf");        // no stash at all
  await stash("40", "u:mk", "made");
  await stash("43", "u:ow", "shared", 0, ["u:fr"]);
  await stash("44", "u:pd", "waiting");
  await stash("45", "u:em", "empty");
  await putBook(NORMAL());
  await putSnap({ prices: PRICES, positions: {}, queue: [], epochs: [] });
})());

test("the helper: a shares-only stash holds (its shares, their value); a pending request holds; an empty stash doesn't", async () => {
  await setup();
  await putBook(NORMAL());
  const H = await SS.vaultHoldings(["40", "43", "44", "45"]);
  const s40 = H.get("40");
  assert.equal(s40.source, "book");
  assert.equal(s40.error, null);
  assert.deepEqual(s40.shares, { auto: S40_AUTO });
  assert.equal(s40.value, 9_400_582, "at the snapshot's prices (prod: positions[40].hold.auto.value 9,400,582)");
  assert.equal(s40.balance, 0);
  assert.equal(s40.inVaults, true);
  assert.equal(s40.held, true, "balance 0, staked 0 - and still holding");
  assert.deepEqual(H.get("43").shares, { bank: 50_000 });
  assert.equal(H.get("43").value, Math.trunc(50_000 * PRICES.bank));
  const s44 = H.get("44");
  assert.deepEqual(s44.shares, {});
  assert.equal(s44.value, 0);
  assert.deepEqual(s44.pending.map((q) => [q.id, q.kind, q.amount, q.state]), [["q90", "deposit", 5000, "pending"]]);
  assert.equal(s44.inVaults, true, "PAT going in (a stake waiting for the cut-off) holds");
  const s45 = H.get("45");
  assert.deepEqual([s45.inVaults, s45.held, s45.pending.length], [false, false, 0], "done / failed requests are history");
  assert.equal((await SS.stashHoldings(40)).value, 9_400_582, "the one-stash form");
  // an unstake still running ("moving") holds too
  await putBook(bookWith({}, { q91: { id: "q91", stash: "45", vault: "bank", kind: "withdraw", shares: 3, state: "moving", ts: 1 } }));
  assert.equal((await SS.stashHoldings("45")).inVaults, true);
  await putBook(NORMAL());
});

test("the helper fails closed: a vault book that can't be read is an error (held), never 'nothing staked'", async () => {
  await setup();
  await putBook("{not json");
  const h = await SS.stashHoldings("45");
  assert.match(h.error, /vault book can't be read/);
  assert.equal(h.held, true);
  assert.equal(h.inVaults, false);
  await putBook(Object.assign(NORMAL(), { auto: { total: 1, holders: { s45: "lots" } } }));
  assert.match((await SS.stashHoldings("45")).error, /aren't a number/);
  await putBook(NORMAL());
  assert.equal((await SS.stashHoldings("45")).error, null);
});

test("the helper with no inited book: the staking snapshot stands in (Pepe's book); neither -> nothing in the vaults", async () => {
  await setup();
  await dropBook();
  await putSnap({ prices: PRICES, positions: { 40: { hold: { auto: { shares: S40_AUTO, value: 9_400_582 } } } },
                  queue: [{ id: "q7", stash: "44", vault: "bank", kind: "deposit", amount: 900, state: "pending" }], epochs: [] });
  const H = await SS.vaultHoldings(["40", "44", "45"]);
  assert.equal(H.get("40").source, "snapshot");
  assert.deepEqual([H.get("40").inVaults, H.get("40").value], [true, 9_400_582]);
  assert.equal(H.get("44").inVaults, true);
  assert.equal(H.get("45").inVaults, false);
  await runQuery("UPDATE staking_state SET data = '{oops' WHERE id = 1");
  assert.match((await SS.stashHoldings("40")).error, /staking snapshot can't be read/, "with no book the snapshot IS the view - unreadable holds");
  await dropSnap();
  const none = await SS.stashHoldings("40");
  assert.deepEqual([none.source, none.error, none.inVaults], ["none", null, false]);
  await putBook(NORMAL());
  await putSnap({ prices: PRICES, positions: {}, queue: [], epochs: [] });
});

test("stale cleanup: a shares-only stash holds its owner AND members; a waiting stake holds; an empty stash changes nothing", async () => {
  await setup();
  await putBook(NORMAL());
  const t = await tiers();
  for (const id of ["mk", "ow", "fr", "pd"]) {
    assert.equal(t[id].tier, "X", `${id}: ${JSON.stringify(t[id])}`);
    assert.match(t[id].why, /stash in vaults/);
  }
  assert.equal(t.em.tier, "A", "a stash with nothing in it or the vaults holds nobody (as before)");
  assert.equal(t.ns.tier, "A");
  assert.deepEqual(await stale.holdsFor("mk", { now: NOW }), ["stash in vaults"], "holdsFor - account deletion and provider merges see it");
  // a balance AND shares: both reasons
  await runQuery("UPDATE stashes SET balance = 700 WHERE id = '40'");
  assert.deepEqual((await stale.holdsFor("mk", { now: NOW })).sort(), ["stash", "stash in vaults"]);
  await runQuery("UPDATE stashes SET balance = 0 WHERE id = '40'");
});

test("stale cleanup fails closed: an unreadable vault book holds every open stash's people, nobody else", async () => {
  await setup();
  await putBook("{not json");
  const t = await tiers();
  for (const id of ["mk", "ow", "fr", "pd", "em"]) {
    assert.equal(t[id].tier, "X", id);
    assert.match(t[id].why, /stash vaults unreadable/);
  }
  assert.equal(t.ns.tier, "A", "no stash -> nothing to check");
  await putBook(NORMAL());
});

test("account deletion: a stash with shares (or a stake waiting) blocks, with a clear reason - and is never closed", async () => {
  await setup();
  await putBook(NORMAL());
  const b = await D.blockers("mk");
  assert.deepEqual(b.block.map((x) => x.code), ["hold:stash in vaults"]);
  assert.match(b.block[0].label, /PAT in the vaults/);
  assert.equal(b.block[0].href, "/staking");
  assert.ok(!b.settle.some((x) => x.code === "stash"));
  assert.deepEqual((await D.blockers("pd")).block.map((x) => x.code), ["hold:stash in vaults"], "a stake waiting for the cut-off");
  // a shared stash with shares: the owner (others in it + shares) and the member
  assert.deepEqual((await D.blockers("ow")).block.map((x) => x.code).sort(), ["hold:stash", "hold:stash in vaults"]);
  assert.deepEqual((await D.blockers("fr")).block.map((x) => x.code).sort(), ["hold:stash", "hold:stash in vaults"]);
  // the empty stash: auto-closed as before
  assert.deepEqual((await D.blockers("em")).block, []);
  // the job: held with the reason (what the member is told), stash 40 still open with its shares
  await D.schedule({ userId: "mk", username: "CFmaker001" });
  const r = await D.execute("mk", { force: true });
  assert.equal(r.state, "held");
  const p = await D.pendingOf("mk");
  assert.equal(p.state, "held");
  assert.match(p.held_reason, /A stash with PAT in the vaults/);
  assert.equal((await row(40)).closed, null, "never closed with 9.4M in shares");
  const note = (await getQuery("SELECT title, body FROM inbox WHERE user_id = 'mk' ORDER BY rowid DESC LIMIT 1"))[0];
  assert.match(note.title, /on hold/);
  assert.match(note.body, /PAT in the vaults/);
  await runQuery("UPDATE account_deletions SET state = 'cancelled' WHERE user_id = 'mk'");
});

test("account deletion fails closed: an unreadable vault book blocks a stash owner (try again), nobody without a stash", async () => {
  await setup();
  await putBook("{not json");
  const b = await D.blockers("em");
  assert.ok(b.block.some((x) => x.code === "hold:stash vaults unreadable"), JSON.stringify(b.block));
  assert.match(b.block.find((x) => x.code === "hold:stash vaults unreadable").label, /couldn't check/);
  assert.deepEqual((await D.blockers("ns")).block, []);
  await putBook(NORMAL());
});

test("account deletion: a stake landing after the blockers check stops the job before the stash moves or closes", async () => {
  await setup();
  await putBook(NORMAL());
  await user("rc", "CFracer001", "racer_cf", 50);
  await stash("46", "u:rc", "race", 700);
  // a Season Pass renewal it pays (settled automatically - settle() clears it BEFORE the stashes): a trigger there plays a stake
  // landing in the vaults between blockers() and the stash close
  await runQuery("INSERT INTO premium_subs (tier, target, paid_through, renewer_id, status, started, updated) VALUES ('season', 'rc', 9e15, 'rc', 'active', 1, 1)");
  const landed = JSON.stringify(bookWith({ 40: { auto: S40_AUTO }, 43: { bank: 50_000 }, 46: { auto: 650 } }, NORMAL().queue)).replace(/'/g, "''");
  await runQuery(`CREATE TRIGGER stashhold_race AFTER UPDATE OF renewer_id ON premium_subs WHEN OLD.renewer_id = 'rc'
                  BEGIN UPDATE capital_docs SET data = '${landed}' WHERE key = 'vaults'; END`);
  assert.deepEqual((await D.blockers("rc")).block, [], "nothing in the vaults yet");
  await D.schedule({ userId: "rc", username: "CFracer001" });
  await assert.rejects(D.execute("rc", { force: true }), /stash 46 has PAT in the vaults/);
  assert.deepEqual(await row(46), { balance: 700, closed: null }, "the stash didn't move or close");
  assert.equal(await bal("rc"), 50, "nothing routed");
  await runQuery("DROP TRIGGER stashhold_race");
  // the next run holds it, with the reason
  const r = await D.execute("rc", { force: true });
  assert.equal(r.state, "held");
  assert.match((await D.pendingOf("rc")).held_reason, /PAT in the vaults/);
  await runQuery("UPDATE account_deletions SET state = 'cancelled' WHERE user_id = 'rc'");
  await putBook(NORMAL());
});

test("closing a stash (website + Pepe's chat): refused with shares / a waiting stake / an unreadable book; empty closes", async () => {
  await setup();
  await putBook(NORMAL());
  await assert.rejects(SS.close({ stashId: "40", ownerUserId: "mk", key: "web:mk:close:aaaa0001" }),
                       (e) => e.code === "E_STASH_IN_VAULTS" && e.status === 409 && /'made' still has PAT in the vaults \(9,400,582 PAT staked\)/.test(e.message));
  assert.equal((await row(40)).closed, null);
  await assert.rejects(SS.close({ stashId: "44", ownerUserId: "pd", key: "web:pd:close:aaaa0002" }),
                       (e) => e.code === "E_STASH_IN_VAULTS" && /a stake waiting for the cut-off/.test(e.message));
  // the website form says it with the stash emoji
  assert.match(await SS.fromForm("mk", ["close", "made"], "idemclose01"), /^🔐 'made' still has PAT in the vaults \(9,400,582 PAT staked\) - unstake it all first/);
  // Pepe's chat close (/api/stash/bot/act): the 409 and its words, which he relays
  const express = require("express");
  const app = express();
  app.use(express.json());
  SS.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/stash/bot/act`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bot", op: "close", stash: "40", login: "maker_cf", user_id: "mk", unstake: true, key: "pv-close-0001" }) });
    const j = await res.json();
    assert.equal(res.status, 409);
    assert.equal(j.code, "E_STASH_IN_VAULTS");
    assert.match(j.error, /still has PAT in the vaults/);
  } finally { server.close(); }
  assert.equal((await row(40)).closed, null);
  // unreadable book: refused (503), still open
  await putBook("{not json");
  await assert.rejects(SS.close({ stashId: "45", ownerUserId: "em", key: "web:em:close:aaaa0003" }), (e) => e.code === "E_VAULTS_UNREADABLE" && e.status === 503);
  assert.equal((await row(45)).closed, null);
  await putBook(NORMAL());
  const ok = await SS.close({ stashId: "45", ownerUserId: "em", key: "web:em:close:aaaa0004" });
  assert.equal(ok.ok, true);
  assert.ok((await row(45)).closed > 0, "nothing in the vaults -> closes as before");
});

test("closing a stash: a stake that slips in after the first check is caught in the closing transaction", async () => {
  await setup();
  await putBook(NORMAL());
  await user("tx", "CFtxuser01", "tx_cf", 0);
  await stash("47", "u:tx", "slip", 500);
  const landed = JSON.stringify(bookWith({ 40: { auto: S40_AUTO }, 43: { bank: 50_000 }, 47: { auto: 400 } }, NORMAL().queue)).replace(/'/g, "''");
  // the balance withdrawal records its move ("<key>:empty") - a stake landing right then
  await runQuery(`CREATE TRIGGER stashhold_slip AFTER INSERT ON stash_moves WHEN NEW.key = 'web:tx:close:bbbb0001:empty'
                  BEGIN UPDATE capital_docs SET data = '${landed}' WHERE key = 'vaults'; END`);
  // 1.99akz review fix: the withdrawal is inside the closing transaction now - the refusal rolls it back (nothing moved)
  await assert.rejects(SS.close({ stashId: "47", ownerUserId: "tx", key: "web:tx:close:bbbb0001" }),
                       (e) => e.code === "E_STASH_IN_VAULTS" && !/went to your wallet/.test(e.message));
  assert.deepEqual(await row(47), { balance: 500, closed: null }, "open, its balance still in it: its shares can still be unstaked into it");
  assert.equal(await bal("tx"), 0, "nothing paid to the wallet");
  await runQuery("DROP TRIGGER stashhold_slip");
  await putBook(NORMAL());
});
