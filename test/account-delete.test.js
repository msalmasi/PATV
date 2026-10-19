// Account deletion (accountdelete.js, docs/account-deletion.md, 1.99wj): blockers (owed to others / in flight / pads) refuse it with
// a list; admins can't delete themselves; re-authentication (password or a fresh sign-in) + the typed username; a 14-day grace
// that signs every device out and that a sign-in cancels; the job routes the balance by the PAT Routing row (supply exact, keyed,
// a later credit swept too), anonymises replied-to posts / deletes the rest, deletes sent DMs and personal rows, pseudonymises
// kept records, releases the Camfrog login and asks Pepe to forget it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctdel-test-"));
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
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

let D, S, runQuery, getQuery, tx, P;
const DAY = 86400000;
let clockAt = Date.UTC(2026, 9, 13, 12);
const bcrypt = require("bcrypt");

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, twitchId, twitchDisplayname, isEmailVerified)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
                 [id, o.username || id, o.display || id, o.email === undefined ? `${id}@example.com` : o.email, o.password || "x", o.class || "pleb", o.cf || null,
                  o.bal || 0, o.twitch || null, o.twitch ? "Tw_" + id : null]);
}
const bal = async (id) => Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b);
const wallets = async () => Number((await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w);
const house = async () => Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS j FROM jackpot_rakes"))[0].j);
const claims = async () => -Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS c FROM reserve_claims WHERE flow = 'account_deleted'"))[0].c);
const poolsTotal = async () => { try { return (await P.total()).amount; } catch (e) { return 0; } };
const supply = async () => (await wallets()) + (await house()) + (await claims()) + (await poolsTotal());
const reqOf = (uid, sid = null) => ({ user: { userId: uid }, loginSession: sid ? { id: sid, userId: uid } : null });

test.before(async () => {
  await built;
  ({ runQuery, getQuery, tx } = require(path.join(repo, "dbUtils")));
  D = require(path.join(repo, "accountdelete"));
  S = require(path.join(repo, "sessions"));
  P = require(path.join(repo, "pools"));
  D._setClock(() => clockAt);
  S._setClock(() => clockAt);
  await D.init();
  await S.init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
});

test("blockers: owed-to-others / in-flight things and owned pads block, with a list; renewals and the balance are settled", async () => {
  await user("blk", { username: "blocky", cf: "blockycf", bal: 1000 });
  await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, owner_user_id) VALUES ('r1', 'blockpad', 'Block Pad', 'user', 'blk')");
  await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, owner_user_id) VALUES ('user:blk', 'blocky', 'profile', 'user', 'blk')");
  await runQuery("INSERT INTO escrow_holds (key, ref, kind, login, username, user_id, amount, state, created) VALUES ('h1', 'W1', 'wager', 'blockycf', 'blocky', 'blk', 500, 'held', 1)");
  await runQuery("INSERT INTO creator_subs (fan_id, creator_id, tier, price, status, paid_through, created, updated) VALUES ('someone', 'blk', 1, 100, 'active', 9e15, 1, 1)");
  await runQuery("INSERT INTO premium_subs (tier, target, paid_through, stripe_sub, status, started, updated) VALUES ('season', 'blk', 9e15, 'sub_123', 'active', 1, 1)");
  await runQuery("INSERT INTO creator_subs (fan_id, creator_id, tier, price, status, paid_through, created, updated) VALUES ('blk', 'someone', 1, 100, 'active', 9e15, 1, 1)");
  const b = await D.blockers("blk");
  const codes = b.block.map((x) => x.code).sort();
  assert.deepEqual(codes, ["card", "creator", "hold:escrow hold", "pad:r1"]);
  assert.ok(b.block.find((x) => x.code === "pad:r1").label.includes("Block Pad"), "the pad is named");
  assert.ok(!codes.includes("pad:user:blk"), "a profile pad is part of the account, not a blocker");
  assert.deepEqual(b.settle.map((x) => x.code).sort(), ["balance", "fansubs"]);
  // the request is refused with the list
  const c = await bcrypt.hash("pw-12345678", 4);
  await runQuery("UPDATE users SET password = ? WHERE userId = 'blk'", [c]);
  await assert.rejects(D.request(reqOf("blk"), { password: "pw-12345678", confirm: "blocky" }), (e) => e.code === "E_BLOCKED" && e.block.length === 4);
  // a negative balance blocks too
  await user("neg", { bal: -5 });
  assert.ok((await D.blockers("neg")).block.some((x) => x.code === "negative"));
});

test("admins / staff / moderators can't delete themselves; another admin schedules it", async () => {
  await user("adm", { class: "Admin", password: await bcrypt.hash("pw-12345678", 4) });
  await user("mod", { password: await bcrypt.hash("pw-12345678", 4) });
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('mod', 'Moderator')");
  await assert.rejects(D.request(reqOf("adm"), { password: "pw-12345678", confirm: "adm" }), (e) => e.code === "E_ELEVATED");
  await assert.rejects(D.request(reqOf("mod"), { password: "pw-12345678", confirm: "mod" }), (e) => e.code === "E_ELEVATED");
  const r = await D.schedule({ userId: "mod", username: "mod" }, { by: "admin:adm", reauth: "admin" });
  assert.equal(r.ok, true);
  assert.equal((await D.pendingOf("mod")).requested_by, "admin:adm");
});

test("re-authentication: the password, or a fresh sign-in (not a converted old cookie); the username typed exactly", async () => {
  await user("re", { username: "reauth", password: await bcrypt.hash("right-password", 4) });
  await assert.rejects(D.request(reqOf("re"), { password: "right-password", confirm: "Reauth" }), (e) => e.code === "E_CONFIRM");
  await assert.rejects(D.request(reqOf("re"), { password: "wrong-password", confirm: "reauth" }), (e) => e.code === "E_REAUTH");
  await assert.rejects(D.request(reqOf("re"), { confirm: "reauth" }), (e) => e.code === "E_REAUTH", "no password, no fresh sign-in");
  const old = await S.create({ get: () => "" }, "re", "password", { at: clockAt - 3600000 });
  await assert.rejects(D.request(reqOf("re", old.id), { confirm: "reauth" }), (e) => e.code === "E_REAUTH", "an hour-old sign-in isn't fresh");
  const fresh = await S.create({ get: () => "" }, "re", "google");
  const r = await D.request(reqOf("re", fresh.id), { confirm: "reauth" });
  assert.equal(r.ok, true);
  assert.equal((await D.pendingOf("re")).reauth, "fresh-sign-in");
});

test("the grace period: every device signed out; signing in cancels it (with a notice); the job waits for the date", async () => {
  await user("gr", { username: "gracey", password: await bcrypt.hash("pw-12345678", 4), bal: 10 });
  const s1 = await S.create({ get: () => "" }, "gr", "password");
  const r = await D.request(reqOf("gr", s1.id), { password: "pw-12345678", confirm: "gracey" });
  assert.equal(r.execute_at, clockAt + 14 * DAY);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'gr' AND revoked_at IS NULL"))[0].n, 0, "signed out everywhere");
  assert.deepEqual(await D.execute("gr"), { ok: false, state: "waiting" });
  // a sign-in (any method) cancels it
  const res = { cookie() {} };
  await S.signIn({ get: () => "", cookies: {} }, res, { userId: "gr", username: "gracey", class: "pleb" }, "plex");
  assert.equal(await D.pendingOf("gr"), null);
  assert.equal((await getQuery("SELECT state, cancel_via FROM account_deletions WHERE user_id = 'gr'"))[0].cancel_via, "sign-in:plex");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'gr' AND title = 'Account deletion cancelled'"))[0].n, 1);
  assert.equal(await bal("gr"), 10, "nothing happened");
});

test("the job: balance routed by the PAT Routing row (supply exact, keyed), posts / DMs / personal rows handled, records pseudonymised, Camfrog released, Pepe told", async () => {
  await user("del", { username: "deleteme", cf: "DelCF", bal: 12345, twitch: "tw-999", password: await bcrypt.hash("pw-12345678", 4) });
  await user("oth", { username: "otherperson", cf: "othercf" });
  // posts: one someone replied to (anonymised), one nobody did (deleted)
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES (101, 'del', 'replied', 'keep me', 1), (102, 'del', 'alone', 'delete me', 1), (103, 'oth', 'theirs', 'x', 1)");
  await runQuery("INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, created) VALUES (201, 101, NULL, 'oth', 'nice', 2), (202, 103, NULL, 'del', 'my comment with a reply', 2), (203, 202, NULL, 'del', 'lonely comment', 2)");
  await runQuery("INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, created) VALUES (204, 103, 202, 'oth', 'reply to del', 3)");
  // a DM
  await runQuery("INSERT INTO conversations (id, kind, dm_key, created_by, created_at) VALUES (301, 'dm', 'del|oth', 'del', 1)");
  await runQuery("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (301, 'del', 1), (301, 'oth', 1)");
  await runQuery("INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (401, 301, 'del', 'my private words', 1), (402, 301, 'oth', 'their words', 2)");
  // personal rows + kept records
  await runQuery("INSERT INTO inbox (user_id, kind, title, created) VALUES ('del', 'system', 'hello', 1)");
  await runQuery("INSERT INTO sso_links (provider, subject, user_id, link_source, proof, email, linked_at) VALUES ('google', 'g-1', 'del', 'self', 'oidc', 'me@gmail.test', 1)");
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t-old', 'del', 'wheel', 345)");
  await runQuery("INSERT INTO escrow_holds (key, ref, kind, login, username, user_id, amount, state, created) VALUES ('h-done', 'W9', 'wager', 'delcf', 'deleteme', 'del', 50, 'paid', 1)");
  await runQuery("INSERT INTO camfrog_userstats (login, data, updated) VALUES ('delcf', '{\"lines\": 5}', 1)");
  await runQuery("INSERT INTO username_history (userId, old_username, new_username, at, via) VALUES ('del', 'oldname', 'deleteme', 1, 'rename:web')");
  // 1.99acd: browser notifications (webpush.js)
  await runQuery("INSERT INTO webpush_subs (endpoint, p256dh, auth, user_id, kinds, vapid_kid, created, updated) VALUES ('https://fcm.googleapis.com/fcm/send/del', 'p', 'a', 'del', 'dm', 'k', 1, 1)");
  await runQuery("INSERT INTO webpush_outbox (user_id, kind, src_key, url, tag, due_at, created) VALUES ('del', 'dm', 'dm:x:1', '/messages', 'dm:x', 1, 1)");
  // adultgate site: the age confirmation (users.age_confirmed_at) + the Creators one (age_attest); the 18+ gate knows them
  await runQuery("UPDATE users SET age_confirmed_at = 1760000000000, age_confirmed_v = '2026-10-19' WHERE userId = 'del'");
  await runQuery("INSERT INTO age_attest (user_id, version, at) VALUES ('del', '2026-10-11', 1)");
  // ...and the 18+ gate's switch row names them as the owner who last flipped it (shown on /pads/admin#adult)
  await runQuery("INSERT INTO adult_gate_cfg (key, value, updated, by) VALUES ('enabled', '0', 1, 'deleteme')");
  const AG = require(path.join(repo, "adultgate"));
  AG.note("del");
  await S.create({ get: () => "" }, "del", "password");
  // the request, then the date
  const fresh = await S.create({ get: () => "" }, "del", "password");
  await D.request(reqOf("del", fresh.id), { password: "pw-12345678", confirm: "deleteme" });
  const s0 = await supply(), w0 = await wallets();
  clockAt += 14 * DAY + 1;
  await D.tick();
  const row = (await getQuery("SELECT * FROM account_deletions WHERE user_id = 'del'"))[0];
  assert.equal(row.state, "done");
  // PAT: out of the wallet, into the routing destination (the Fed by default - a Reserve claim while the pools live in Pepe)
  assert.equal(await bal("del"), 0);
  assert.equal(await wallets(), w0 - 12345);
  assert.equal(await supply(), s0, "nothing vanished from supply");
  const legs = await getQuery("SELECT claimId, amount FROM reserve_claims WHERE flow = 'account_deleted'");
  assert.deepEqual(legs.map((x) => x.amount), [-12345]);
  assert.equal((await getQuery("SELECT type, points FROM transactions WHERE userId = 'del' AND type = 'account-deleted'"))[0].points, -12345);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM account_deletion_routes WHERE user_id = 'del'"))[0].n, 1, "journaled under its key");
  // keyed: running again moves nothing
  await D.execute("del", { force: true });
  assert.equal(await supply(), s0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'account_deleted'"))[0].n, 1);
  // the tombstone
  const u = (await getQuery("SELECT * FROM users WHERE userId = 'del'"))[0];
  assert.match(u.username, /^deleted-[0-9a-f]{10}$/);
  assert.equal(u.displayname, "Deleted user");
  assert.equal(u.email, null);
  assert.equal(u.twitchId, null);
  assert.equal(u.camfrogUsername, null, "the Camfrog login is released");
  assert.equal(await bcrypt.compare("pw-12345678", u.password), false, "nobody can sign in to it");
  assert.equal(u.age_confirmed_at, null, "adultgate site: the age confirmation goes with the person");
  assert.equal(u.age_confirmed_v, null, "with its wording's version");
  assert.equal((await getQuery("SELECT by FROM adult_gate_cfg WHERE key = 'enabled'"))[0].by, u.username, "the switch's 'last changed by' is pseudonymised");
  assert.ok(D.NAME_COLUMNS.includes("adult_gate_cfg.by"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM age_attest WHERE user_id = 'del'"))[0].n, 0, "so does the Creators one");
  assert.equal(AG.confirmedSync("del"), false, "and the 18+ gate forgets the account");
  // another account can link the login now
  await runQuery("UPDATE users SET camfrogUsername = 'delcf' WHERE userId = 'oth'");
  // posts / comments: anonymised where someone replied, deleted otherwise
  const posts = await getQuery("SELECT id, author_id, body, deleted_at FROM feed_posts WHERE author_id = 'del' ORDER BY id");
  assert.equal(posts[0].body, "keep me"); assert.equal(posts[0].deleted_at, null);
  assert.equal(posts[1].body, ""); assert.ok(posts[1].deleted_at);
  const cm = await getQuery("SELECT id, body, deleted_at FROM feed_comments WHERE author_id = 'del' ORDER BY id");
  assert.equal(cm[0].body, "my comment with a reply"); assert.equal(cm[0].deleted_at, null);
  assert.equal(cm[1].body, ""); assert.ok(cm[1].deleted_at);
  // DMs: their messages deleted, the other side's kept; they left the conversation
  const ms = await getQuery("SELECT id, body, deleted_at FROM messages ORDER BY id");
  assert.equal(ms[0].body, ""); assert.ok(ms[0].deleted_at);
  assert.equal(ms[1].body, "their words");
  assert.ok((await getQuery("SELECT left_at FROM conversation_members WHERE user_id = 'del'"))[0].left_at);
  // personal rows gone
  for (const [t, c] of [["inbox", "user_id"], ["sso_links", "user_id"], ["sessions", "user_id"], ["username_history", "userId"], ["webpush_subs", "user_id"], ["webpush_outbox", "user_id"]]) {
    assert.equal((await getQuery(`SELECT COUNT(*) AS n FROM ${t} WHERE ${c} = 'del'`))[0].n, 0, t);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM camfrog_userstats WHERE login = 'delcf'"))[0].n, 0, "chat statistics for the login");
  // kept records, pseudonymised
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = 'del'"))[0].n, 2, "the ledger stays");
  const h = (await getQuery("SELECT login, username FROM escrow_holds WHERE key = 'h-done'"))[0];
  assert.equal(h.login, u.username); assert.equal(h.username, u.username);
  // never revived by the stale cleanup
  assert.equal((await getQuery("SELECT tier FROM account_archive WHERE userId = 'del'"))[0].tier, "DELETED");
  assert.equal(await require(path.join(repo, "staleaccounts")).restore("del", "sign-in"), null);
  // Pepe: forget the login (a website action), retried when it expired, the login scrubbed afterwards
  const a = await getQuery("SELECT * FROM pepe_actions WHERE user_id = 'del' AND kind = 'privacy.forget'");
  assert.equal(a.length, 1); assert.equal(a[0].camfrog, "delcf"); assert.equal(a[0].username, u.username);
  await runQuery("UPDATE pepe_actions SET status = 'failed', updated = ? WHERE id = ?", [clockAt - 60000, a[0].id]);
  await D.retryForget();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE user_id = 'del' AND kind = 'privacy.forget'"))[0].n, 1, "not retried at once");
  await runQuery("UPDATE pepe_actions SET updated = ? WHERE id = ?", [clockAt - 7 * 3600000, a[0].id]);
  await D.retryForget();
  const a2 = await getQuery("SELECT id, camfrog, status FROM pepe_actions WHERE user_id = 'del' AND kind = 'privacy.forget' ORDER BY id");
  assert.equal(a2.length, 2); assert.equal(a2[0].camfrog, null); assert.equal(a2[1].camfrog, "delcf");
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE id = ?", [a2[1].id]);
  await D.retryForget();
  assert.equal((await getQuery("SELECT camfrog FROM pepe_actions WHERE id = ?", [a2[1].id]))[0].camfrog, null);
});

test("a deleted account credited later is swept to the routing row too; the routing row decides (House + pools when the site owns them)", async () => {
  const s0 = await supply();
  await require(path.join(repo, "ledger")).post("del", 77, "late refund");
  assert.equal(await supply(), s0 + 77);
  assert.equal(await D.sweepTombstones(), 77);
  assert.equal(await bal("del"), 0);
  assert.equal(await supply(), s0 + 77, "moved, not lost");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM account_deletion_routes WHERE user_id = 'del'"))[0].n, 2);
  // the admin's routing override: half to the House
  const ES = require(path.join(repo, "econstore"));
  await ES.init();
  await ES.putSettings({ pat_routes: { account_deleted: [["jackpot", 50]] } });
  await user("rt", { bal: 1000 });
  await D.schedule({ userId: "rt", username: "rt" });
  const s1 = await supply(), h1 = await house();
  await D.execute("rt", { force: true });
  assert.equal(await house(), h1 + 500);
  assert.equal(await supply(), s1);
  await ES.putSettings({ pat_routes: {} });
});

test("a sole-owned stash (site-owned) is emptied into the routing; a shared one blocks", async () => {
  const SS = require(path.join(repo, "stashes"));
  await SS.init();
  await runQuery("INSERT OR REPLACE INTO stash_meta (key, value) VALUES ('imported', '{\"at\":1}')");
  await user("st", { username: "stashy", cf: "stashcf", bal: 100 });
  await runQuery("INSERT INTO stashes (id, owner, name, balance, staked, created, updated) VALUES ('91', 'stashcf', 'mine', 900, 0, 1, 1)");
  await runQuery("INSERT INTO stashes (id, owner, name, balance, staked, created, updated) VALUES ('92', 'stashcf', 'shared', 50, 0, 1, 1)");
  await runQuery("INSERT INTO stash_members (stash_id, login) VALUES ('92', 'friendcf')");
  assert.ok((await D.blockers("st")).block.some((x) => x.code === "hold:stash"), "a stash with other members blocks");
  await runQuery("DELETE FROM stash_members WHERE stash_id = '92'");
  await runQuery("UPDATE stashes SET balance = 0 WHERE id = '92'");
  const b = await D.blockers("st");
  assert.deepEqual(b.block, []);
  assert.ok(b.settle.some((x) => x.code === "stash"));
  await D.schedule({ userId: "st", username: "stashy" });
  const s0 = await supply() + 900;                                        // the stash is supply too
  await D.execute("st", { force: true });
  assert.equal((await getQuery("SELECT balance, closed FROM stashes WHERE id = '91'"))[0].balance, 0);
  assert.ok((await getQuery("SELECT closed FROM stashes WHERE id = '91'"))[0].closed);
  assert.equal(await bal("st"), 0);
  assert.equal(await supply(), s0, "wallet 100 + stash 900 -> the routing, exactly");
  assert.equal((await getQuery("SELECT amount FROM account_deletion_routes WHERE user_id = 'st'"))[0].amount, 1000);
});

test("held: something new in flight at the date holds it (one notice); the doc and the routes exist", async () => {
  await user("hd", { username: "holdy", bal: 5 });
  await D.schedule({ userId: "hd", username: "holdy" });
  await runQuery("INSERT INTO escrow_holds (key, ref, kind, login, username, user_id, amount, state, created) VALUES ('h-new', 'W2', 'wager', 'x', 'holdy', 'hd', 5, 'held', 1)");
  clockAt += 15 * DAY;
  await D.tick();
  assert.equal((await D.pendingOf("hd")).state, "held");
  await D.tick();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'hd' AND title = 'Your account deletion is on hold'"))[0].n, 1);
  await runQuery("UPDATE escrow_holds SET state = 'paid' WHERE key = 'h-new'");
  await D.tick();
  assert.equal((await getQuery("SELECT state FROM account_deletions WHERE user_id = 'hd' ORDER BY id DESC"))[0].state, "done");
  const doc = fs.readFileSync(path.join(repo, "docs", "account-deletion.md"), "utf8");
  for (const w of ["14", "PAT Routing", "account_deleted", "pseudonym", "privacy.forget", "TAKE IT DOWN"]) assert.ok(doc.includes(w), "doc mentions " + w);
});

test("1.99acm: the chat hub's privacy/account-deleted row commits with the deletion (and rolls back with it); no login, no login hash", async () => {
  const HO = require(path.join(repo, "huboutbox"));
  const H = require(path.join(repo, "hubhidden"));
  await HO.init();
  await HO.setSettings({ erasure: true });
  process.env.CHAT_GENESIS_NS = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
  try {
    await user("hubdel", { username: "hubdeleter", cf: "HubDelCF" });
    await D.schedule({ userId: "hubdel", username: "hubdeleter" }, { by: "self", reauth: "password" });
    // a failure inside the deletion's transaction: neither the deletion nor the hub row lands
    const emit = HO.emit;
    HO.emit = async (...a) => { await emit(...a); throw new Error("boom"); };
    try { await assert.rejects(D.execute("hubdel", { force: true }), /boom/); } finally { HO.emit = emit; }
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM hub_outbox WHERE topic = 'privacy/account-deleted'"))[0].n, 0, "rolled back with the deletion");
    assert.equal((await getQuery("SELECT state FROM account_deletions WHERE user_id = 'hubdel' ORDER BY id DESC LIMIT 1"))[0].state, "scheduled");
    const r = await D.execute("hubdel", { force: true });
    assert.equal(r.state, "done");
    const d = (await getQuery("SELECT id, pseudonym, done_at FROM account_deletions WHERE user_id = 'hubdel' AND state = 'done'"))[0];
    const cols = (await getQuery("SELECT name FROM pragma_table_info('account_deletions')")).map((c) => c.name);
    assert.ok(!cols.includes("hub_login_h"), "1.99acm: no login hash kept with the deletion (an unkeyed hash of a login is reversible)");
    const row = (await getQuery("SELECT entity, payload, dedupe_key FROM hub_outbox WHERE topic = 'privacy/account-deleted'"))[0];
    assert.equal(row.entity, "acct:hubdel");
    assert.equal(row.dedupe_key, "acctdel:" + d.id);
    assert.deepEqual(JSON.parse(row.payload), { acct: require(path.join(repo, "chatticket")).subjectOf("hubdel"), v1_user: "hubdel", pseudonym: d.pseudonym,
                                                remove_public: false, request: d.id, at: d.done_at });
    assert.ok(!row.payload.includes("hubdelcf") && !row.payload.includes("HubDelCF"), "no login in the row");
    assert.ok(!row.payload.includes(H.loginHash("hubdelcf")), "...nor its hash");
    assert.deepEqual(D.hubRow(d).request, d.id, "the snapshot's builder is the same");
  } finally {
    delete process.env.CHAT_GENESIS_NS;
    await HO.setSettings({ erasure: false });
  }
});
