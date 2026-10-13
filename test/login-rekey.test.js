// 1.99tj: records follow the ACCOUNT, not the Camfrog login (loginrekey.js). The user's rule: when AccountA moves from
// Camfrog login X to Y, everything keyed by X moves to Y; X seen again is a brand-new empty account.
//   * the site's own tables re-key in one transaction (stashes, held escrow holds, escrow game JSON, GTF records with a rev
//     bump + mirror + ops, gang members / boss, voice unlocks); PATV-username fields are never touched; a collision keeps
//     the bigger record and archives the other;
//   * the one-off relink: a dry run that changes nothing, an apply that records the change for Pepe's feed, idempotent;
//   * a takeover (another account verifies X) moves A's X records to u:<A>; an unlink too;
//   * the old login resolves to nobody afterwards.
//   NODE_PATH=G:/PATV/node_modules node --test test/login-rekey.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "login-rekey-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const R = require(path.join(repo, "loginrekey"));
const U = require(path.join(repo, "usernames"));

const one = async (sql, args = []) => (await getQuery(sql, args))[0];
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, points_balance INTEGER DEFAULT 0,
                  camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE stashes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT, balance INTEGER DEFAULT 0, staked INTEGER DEFAULT 0, earned INTEGER DEFAULT 0, created REAL, closed REAL, updated INTEGER)");
  await runQuery("CREATE TABLE stash_members (stash_id TEXT NOT NULL, login TEXT NOT NULL, PRIMARY KEY (stash_id, login))");
  await runQuery(`CREATE TABLE escrow_holds (id TEXT PRIMARY KEY, key TEXT UNIQUE, ref TEXT, kind TEXT, login TEXT, username TEXT, user_id TEXT NOT NULL,
                  amount INTEGER, reason TEXT, cp TEXT, state TEXT, created INTEGER, via TEXT)`);
  await runQuery("CREATE TABLE escrow_games (game TEXT NOT NULL, id INTEGER NOT NULL, status TEXT, deadline INTEGER, data TEXT NOT NULL, updated INTEGER, PRIMARY KEY (game, id))");
  await runQuery("CREATE TABLE gtf_records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT, rev INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, updated INTEGER, PRIMARY KEY (kind, id))");
  await runQuery("CREATE TABLE gtf_meta (key TEXT PRIMARY KEY, value TEXT)");
  await runQuery("CREATE TABLE gtf_mirror (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, display TEXT, updated INTEGER, PRIMARY KEY (kind, id))");
  await runQuery("CREATE TABLE gtf_ops (key TEXT PRIMARY KEY, login TEXT NOT NULL, op TEXT NOT NULL, fields TEXT, user_id TEXT, price INTEGER, created INTEGER NOT NULL, acked INTEGER)");
  await runQuery(`CREATE TABLE gangs (gid TEXT PRIMARY KEY, name TEXT, tag TEXT, boss TEXT, withdrawn TEXT, extra TEXT, updated INTEGER)`);
  await runQuery("CREATE TABLE gang_members (member_key TEXT PRIMARY KEY, gid TEXT NOT NULL, rank TEXT NOT NULL, userId TEXT, seq INTEGER NOT NULL DEFAULT 0, joined INTEGER)");
  await runQuery("CREATE TABLE gang_invites (member_key TEXT PRIMARY KEY, gid TEXT NOT NULL, inviter_key TEXT, created INTEGER)");
  await runQuery("CREATE TABLE voice_owned_logins (login TEXT NOT NULL, voice_id TEXT NOT NULL, source TEXT, created INTEGER, PRIMARY KEY (login, voice_id))");
  // AccountA moved from Camfrog login "oldx" to "newy" (the relink the site never recorded - the prod case)
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername) VALUES ('a1', 'AccA', 'x', 'newy'), ('b1', 'AccB', 'x', 'bee')");
  await runQuery("INSERT INTO stashes (id, owner, name) VALUES ('11', 'oldx', 'mine')");
  await runQuery("INSERT INTO stash_members (stash_id, login) VALUES ('11', 'oldx'), ('11', 'bee')");
  await runQuery("INSERT INTO escrow_holds (id, login, username, user_id, amount, state) VALUES ('h3919', 'oldx', 'AccA', 'a1', 1000, 'held'), ('h1', 'oldx', 'AccA', 'a1', 5, 'spent')");
  await runQuery("INSERT INTO escrow_games (game, id, status, data) VALUES ('bounties', 3, 'open', ?)",
                 [JSON.stringify({ id: 3, creator: "oldx", pot: [{ hid: "h3919", nick: "oldx", amount: 1000, user: "AccA" }], claims: { bee: { ts: 1 } }, users: { creator: "AccA" } })]);
  await runQuery("INSERT INTO escrow_games (game, id, status, data) VALUES ('loans', 23, 'active', ?)",
                 [JSON.stringify({ id: 23, lender: "bee", borrower: "OldX", users: { lender: "AccB" } })]);
  await runQuery("INSERT INTO gtf_meta (key, value) VALUES ('rev', '40')");
  await runQuery("INSERT INTO gtf_records (kind, id, data, rev) VALUES ('sheet', 'oldx', ?, 10), ('sheet', 'newy', ?, 11), ('pvp', '7', ?, 12)",
                 [JSON.stringify({ heists: 40, loot: 900000, stats: { STR: 14 } }), JSON.stringify({ heists: 0 }), JSON.stringify({ a: "oldx", b: "bee" })]);
  await runQuery("INSERT INTO gtf_mirror (kind, id, data) VALUES ('sheet', 'oldx', ?)", [JSON.stringify({ heists: 40 })]);
  await runQuery("INSERT INTO gtf_ops (key, login, op, created) VALUES ('op1', 'oldx', 'reroll', 1)");
  await runQuery("INSERT INTO gangs (gid, name, tag, boss, withdrawn) VALUES ('8c1664c5', 'G', 'G', 'oldx', ?)", [JSON.stringify({ oldx: 100 })]);
  await runQuery("INSERT INTO gang_members (member_key, gid, rank, userId) VALUES ('oldx', '8c1664c5', 'boss', 'a1')");
  await runQuery("INSERT INTO voice_owned_logins (login, voice_id) VALUES ('oldx', 'v1')");
});

test("rekeyValue: logins in keys and values move, PATV-username fields never, a collision keeps the existing one", () => {
  const out = { n: 0, archived: [] };
  const v = R.rekeyValue({ creator: "OldX", users: { creator: "oldx" }, user: "oldx", members: ["oldx", "newy", "bee"], newy: 1, oldx: 2, deep: { oldx: { w: 1 } } },
                         "oldx", "newy", out);
  assert.deepEqual(v, { creator: "newy", users: { creator: "oldx" }, user: "oldx", members: ["newy", "bee"], newy: 1, deep: { newy: { w: 1 } } });
  assert.equal(out.archived.length, 1);
  assert.equal(out.archived[0].value, 2);
});

test("relink dry run: lists the exact site changes and changes nothing", async () => {
  const r = await R.relink("oldx", "a1");
  assert.equal(r.ok && r.dry, true, JSON.stringify(r));
  assert.equal(r.to, "newy");
  const tables = new Set(r.site.map((c) => c.table));
  for (const t of ["stashes", "stash_members", "escrow_holds", "escrow_games", "gtf_records", "gtf_mirror", "gtf_ops", "gang_members", "gangs", "voice_owned_logins"]) {
    assert.ok(tables.has(t), `${t} in ${JSON.stringify(r.site)}`);
  }
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '11'")).owner, "oldx", "rolled back");
  assert.equal((await one("SELECT COUNT(*) AS n FROM login_changes")).n, 0);
  assert.equal((await one("SELECT COUNT(*) AS n FROM login_rekey_archive")).n, 0);
});

test("relink apply: every site record moves to the account's new login, recorded once for Pepe's feed", async () => {
  const r = await R.relink("oldx", "a1", { apply: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.id > 0);
  // 1.99wy: a stash belongs to the ACCOUNT - a row its old login still held becomes "u:a1" (not the new login), and the
  // account isn't a member of its own stash
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '11'")).owner, "u:a1");
  assert.deepEqual((await getQuery("SELECT login FROM stash_members WHERE stash_id = '11' ORDER BY login")).map((x) => x.login), ["bee"]);
  assert.equal((await one("SELECT login FROM escrow_holds WHERE id = 'h3919'")).login, "newy");
  assert.equal((await one("SELECT login FROM escrow_holds WHERE id = 'h1'")).login, "oldx", "a finished hold is history - untouched");
  const b3 = JSON.parse((await one("SELECT data FROM escrow_games WHERE game = 'bounties' AND id = 3")).data);
  assert.equal(b3.creator, "newy");
  assert.equal(b3.pot[0].nick, "newy");
  assert.equal(b3.pot[0].user, "AccA", "the PATV username is the account's - untouched");
  assert.deepEqual(b3.users, { creator: "AccA" });
  assert.equal(JSON.parse((await one("SELECT data FROM escrow_games WHERE game = 'loans' AND id = 23")).data).borrower, "newy");
  // the established sheet (40 heists) wins over the one rolled for the new login; the other is archived; revs bumped
  const sheet = await one("SELECT data, rev, deleted FROM gtf_records WHERE kind = 'sheet' AND id = 'newy'");
  assert.equal(JSON.parse(sheet.data).heists, 40);
  assert.ok(sheet.rev > 40);
  const gone = await one("SELECT data, deleted, rev FROM gtf_records WHERE kind = 'sheet' AND id = 'oldx'");
  assert.equal(gone.deleted, 1);
  assert.ok(gone.rev > 40, "Pepe's mirror sees the old id go");
  assert.equal(JSON.parse((await one("SELECT data FROM gtf_records WHERE kind = 'pvp' AND id = '7'")).data).a, "newy");
  assert.ok(Number(JSON.parse((await one("SELECT value FROM gtf_meta WHERE key = 'rev'")).value)) > 40);
  assert.equal((await one("SELECT COUNT(*) AS n FROM login_rekey_archive WHERE tbl = 'gtf_records'")).n, 1);
  assert.equal((await one("SELECT id FROM gtf_mirror WHERE kind = 'sheet'")).id, "newy");
  assert.equal((await one("SELECT login FROM gtf_ops WHERE key = 'op1'")).login, "newy");
  assert.equal((await one("SELECT member_key FROM gang_members WHERE gid = '8c1664c5'")).member_key, "newy");
  const g = await one("SELECT boss, withdrawn FROM gangs WHERE gid = '8c1664c5'");
  assert.equal(g.boss, "newy");
  assert.deepEqual(JSON.parse(g.withdrawn), { newy: 100 });
  assert.equal((await one("SELECT login FROM voice_owned_logins WHERE voice_id = 'v1'")).login, "newy");
  // Pepe's feed has it; a second run is a no-op; the old login is nobody's now
  const feed = await R.since(0);
  assert.deepEqual(feed.changes.map((c) => [c.userId, c.old_key, c.new_key, c.via]), [["a1", "oldx", "newy", "admin:relink"]]);
  assert.equal((await R.relink("oldx", "a1", { apply: true })).already, true);
  assert.equal((await U.resolveLogin("oldx")).code, U.E_NOT_FOUND);
  assert.equal((await R.relink("newy", "a1")).ok, false, "the login it has today is refused");
});

test("a takeover / unlink: the account keeps its records under u:<userId>; nothing changes for the same key", async () => {
  await runQuery("INSERT INTO stashes (id, owner, name) VALUES ('20', 'bee', 'bees')");
  const id = await R.changed("b1", "bee", null, "camfrog:taken");
  assert.ok(id);
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '20'")).owner, "u:b1");
  assert.deepEqual((await getQuery("SELECT login FROM stash_members WHERE stash_id = '11' ORDER BY login")).map((x) => x.login), ["u:b1"]);
  // the account links a new login later: its stashes stay the ACCOUNT's (1.99wy - were moved to the new login)
  await R.changed("b1", null, "bee2", "camfrog:relink");
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '20'")).owner, "u:b1");
  assert.equal(await R.changed("b1", "Bee2", "bee2", "camfrog:relink"), null, "same key: nothing");
  const feed = await R.since(1);
  assert.deepEqual(feed.changes.map((c) => [c.old_key, c.new_key]), [["bee", "u:b1"], ["u:b1", "bee2"]]);
});
