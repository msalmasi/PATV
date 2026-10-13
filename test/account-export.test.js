// "Download my data" (accountexport.js, 1.99wj): the zip has the member's own data (profile, connections, wallet, holdings,
// posts, the DMs they sent, notices, achievements, cosmetics, purchases, subscriptions, likeness, sessions, chat data), never a
// secret or another person's private data; one export a day; ready -> a notice; the download is the owner's only, 7 days.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctexp-test-"));
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
  await new Promise((r) => db.close(r));
})();

let X, runQuery, getQuery, server, base;
let clockAt = Date.UTC(2026, 9, 13, 12);
const SECRETS = ["$2b$12$SECRETPASSWORDHASHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "RESETTOKEN123456", "STREAMKEY999999", "EMAILVERIFYTOKEN77",
                 "TGCODEHASH5555", "CHATTOKENHASH444", "WALLETSIGNATURE333", "OTHERS-PRIVATE-DM-TEXT", "BUYER-HOME-ADDRESS-42",
                 "PAYER-WHO-USED-MY-FACE", "LEGACYKEYHASH", "sub_STRIPE_SUB_ID", "cus_STRIPE_CUSTOMER"];

/** The single file in a zip of ours (local header, deflate). */
function unzip(buf) {
  const files = {};
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const csize = buf.readUInt32LE(o + 18), nlen = buf.readUInt16LE(o + 26), xlen = buf.readUInt16LE(o + 28);
    const name = buf.slice(o + 30, o + 30 + nlen).toString("utf8");
    const data = buf.slice(o + 30 + nlen + xlen, o + 30 + nlen + xlen + csize);
    files[name] = zlib.inflateRawSync(data);
    o += 30 + nlen + xlen + csize;
  }
  return files;
}

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  X = require(path.join(repo, "accountexport"));
  X._setClock(() => clockAt);
  await X.init();
  await require(path.join(repo, "sessions")).init();
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, camfrogUsername, points_balance, streamKey, resetPasswordToken, emailVerificationToken, twitchId, twitchDisplayname)
                  VALUES ('me', 'exporter', 'Ex Porter', 'me@example.com', ?, 'mecf', 4321, ?, ?, ?, 'tw-1', 'TwMe')`, [SECRETS[0], SECRETS[2], SECRETS[1], SECRETS[3]]);
  await runQuery("INSERT INTO users (userId, username, email, password) VALUES ('you', 'someoneelse', 'you@example.com', 'x')");
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t1', 'me', 'wheel', 4321)");
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES (1, 'me', 'My post', 'MY-POST-BODY', 1)");
  await runQuery("INSERT INTO conversations (id, kind, dm_key, created_by, created_at) VALUES (5, 'dm', 'me|you', 'me', 1)");
  await runQuery("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (5, 'me', 1), (5, 'you', 1)");
  await runQuery("INSERT INTO messages (id, conversation_id, sender_id, body, created_at) VALUES (1, 5, 'me', 'MY-DM-TEXT', 1), (2, 5, 'you', ?, 2)", [SECRETS[7]]);
  await runQuery("INSERT INTO inbox (user_id, kind, title, created) VALUES ('me', 'system', 'MY-NOTICE', 1)");
  await runQuery("INSERT INTO telegram_codes (code_hash, user_id, created, expires) VALUES (?, 'me', 1, 2)", [SECRETS[4]]);
  await runQuery("INSERT INTO chat_signin_tokens (token_hash, user_id, login, created, expires) VALUES (?, 'me', 'mecf', 1, 2)", [SECRETS[5]]);
  await runQuery("INSERT INTO crypto_wallets (user_id, family, address, link_source, message, signature, created) VALUES ('me', 'evm', '0xabc', 'self', 'msg', ?, 1)", [SECRETS[6]]);
  await runQuery("INSERT INTO shop_orders (prize_id, buyer_id, seller_id, title, price, status, buyer_input, created) VALUES (1, 'you', 'me', 'Thing', 10, 'completed', ?, 1)", [SECRETS[8]]);
  await runQuery("INSERT INTO likeness_ledger (ref, subject_user_id, subject_login, payer_user_id, payer_login, kind, amount, status, created) VALUES ('l1', 'me', 'mecf', 'you', ?, 'clip', 5, 'released', 1)", [SECRETS[9]]);
  await runQuery("INSERT INTO sessions (id, user_id, created, last_seen, expires, device, method, legacy_key) VALUES ('s1', 'me', 1, 2, 3, 'Chrome on Windows', 'google', ?)", [SECRETS[10]]);
  await runQuery("INSERT INTO premium_subs (tier, target, paid_through, stripe_sub, stripe_customer, status, started, updated) VALUES ('season', 'me', 5, ?, ?, 'active', 1, 1)", [SECRETS[11], SECRETS[12]]);
  await runQuery("INSERT INTO user_badges (userId, badgeId, awardedAt) VALUES ('me', 'fresh_meat', '2026-01-01')");
  await runQuery("INSERT INTO camfrog_userstats (login, data, updated) VALUES ('mecf', '{\"lines\": 99}', 1)");
  await runQuery("INSERT INTO user_reports (target_id, reporter_id, reason, created) VALUES ('me', 'you', 'REPORT-ABOUT-ME', 1)");
  // the routes, with a header-picked user
  const express = require("express");
  const app = express();
  app.use(express.json());
  X.register(app, { addUser: (req, res, next) => { const u = req.get("x-user"); req.user = u ? { userId: u } : null; next(); } });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("the contents: the member's own data, by section", async () => {
  const d = await X.collect("me");
  assert.equal(d.account.profile.username, "exporter");
  assert.equal(d.account.profile.email, "me@example.com");
  assert.deepEqual(d.connections.twitch, { id: "tw-1", name: "TwMe", login: null });
  assert.equal(d.connections.camfrog, "mecf");
  assert.equal(d.wallet.balance, 4321);
  assert.equal(d.wallet.transactions[0].points, 4321);
  assert.equal(d.posts.posts[0].body, "MY-POST-BODY");
  assert.deepEqual(d.messages.conversations[0].messages_you_sent.map((m) => m.body), ["MY-DM-TEXT"]);
  assert.equal(d.notices.inbox[0].title, "MY-NOTICE");
  assert.equal(d.achievements.badges[0].badgeId, "fresh_meat");
  assert.equal(d.purchases.orders_you_sold.length, 1);
  assert.equal(d.likeness.earnings[0].amount, 5);
  assert.equal(d.security.sessions[0].method, "google");
  assert.equal(d.chat.statistics.data.lines, 99);
  assert.equal(d.subscriptions.season_pass_and_prime_time.length, 1);
});

test("never a secret, never someone else's private data", async () => {
  const s = JSON.stringify(await X.collect("me"));
  for (const v of SECRETS) assert.ok(!s.includes(v), "leaked: " + v);
  assert.ok(!s.includes("REPORT-ABOUT-ME"), "reports others filed about them are not theirs to read");
  assert.ok(!/"(password|resetPasswordToken|streamKey|emailVerificationToken|token_hash|code_hash|signature)"/.test(s), "no secret columns at all");
});

test("the job: a zip with patv-data.json + README, a notice, the owner's download only; one a day; files expire", async () => {
  const r = await X.request("me");
  assert.equal(r.ok, true);
  await X.run(r.id);
  const j = (await getQuery("SELECT * FROM account_exports WHERE id = ?", [r.id]))[0];
  assert.equal(j.state, "ready");
  assert.equal(j.expires, clockAt + 7 * 86400000);
  const files = unzip(fs.readFileSync(path.join(X._dir(), j.file)));
  assert.deepEqual(Object.keys(files).sort(), ["README.txt", "patv-data.json"]);
  assert.equal(JSON.parse(files["patv-data.json"]).account.profile.username, "exporter");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'me' AND title = 'Your data export is ready'"))[0].n, 1);
  // the CRC in the zip is right (any unzip tool checks it)
  assert.equal(X.crc32(Buffer.from("123456789")), 0xcbf43926);
  // the download: the owner, signed in; nobody else
  const mine = await fetch(`${base}/settings/account/export/${r.id}`, { headers: { "x-user": "me" } });
  assert.equal(mine.status, 200);
  assert.match(mine.headers.get("content-disposition") || "", /patv-data-\d{4}-\d{2}-\d{2}\.zip/);
  assert.equal((await fetch(`${base}/settings/account/export/${r.id}`, { headers: { "x-user": "you" } })).status, 410);
  assert.equal((await fetch(`${base}/settings/account/export/${r.id}`, { redirect: "manual" })).status, 302, "signed out -> sign in");
  // the rate limit: one a day (the route says when)
  const again = await fetch(`${base}/api/account/export`, { method: "POST", headers: { "x-user": "me", origin: base, "x-requested-with": "fetch" } });
  assert.equal(again.status, 429);
  assert.equal((await again.json()).retry_at, clockAt + 86400000);
  assert.equal((await fetch(`${base}/api/account/export`, { method: "POST", headers: { "x-user": "me", origin: "https://evil.example", "x-requested-with": "fetch" } })).status, 403);
  clockAt += 86400000 + 1;
  assert.equal((await X.request("me")).ok, true, "a day later");
  // after 7 days the file goes
  clockAt += 7 * 86400000;
  await X.tick();
  assert.equal((await getQuery("SELECT state FROM account_exports WHERE id = ?", [r.id]))[0].state, "expired");
  assert.ok(!fs.existsSync(path.join(X._dir(), j.file)));
});
