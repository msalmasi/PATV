// Offline tests for 🎟️ Plex invites (mediainvites.js) against a mocked Wizarr: a store purchase of an invite item makes
// ONE one-time invitation (link days, access days / lifetime, servers + libraries from the settings) and puts the link
// on the buyer's order + a 🔔 notice (never anywhere public); Wizarr down -> the manual queue, retried, or sent by hand;
// switched off -> nothing happens (manual fulfilment as before).
//   node --test test/mediainvites.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "minv-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
process.env.SECRET_KEY = "test-secret";
process.env.WIZARR_API_KEY = "test-wizarr-key";
delete process.env.WIZARR_PUBLIC_URL;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const conf = require(path.join(repo, "mediaconf"));
const I = require(path.join(repo, "mediainvites"));

const W = { posts: [], down: false, n: 0 };
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const send = (st, j) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (W.down) return send(503, { error: "maintenance" });
    if (req.headers["x-api-key"] !== "test-wizarr-key") return send(401, { error: "Unauthorized" });
    if (req.url === "/api/invitations" && req.method === "POST") {
      W.posts.push(JSON.parse(body));
      const code = "INV" + (++W.n);
      return send(201, { message: "Invitation created successfully", invitation: { id: W.n, code, url: `https://wizarr.example.test/j/${code}`, used: false } });
    }
    if (req.url === "/api/servers") return send(200, { servers: [{ id: 1, name: "Plex", server_type: "plex" }] });
    if (req.url === "/api/libraries") return send(200, { libraries: [{ id: 3, name: "Movies", server_id: 1 }] });
    send(404, { error: "not found" });
  });
});

const MONTH = "1c120384-c080-4186-b246-f1227e82ab01", LIFE = "e101bcff-cc8c-4db9-b4ca-302ef5e16871";
let n = 0;
async function mkUser(bal = 100000000) {
  const id = "i" + (++n);
  await runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES (?, ?, 'x', ?)", [id, "buyer" + n, bal]);
  return { userId: id, username: "buyer" + n };
}
const settle = () => new Promise((r) => setTimeout(r, 80));
const buy = (u, prizeId) => shop.purchasePrize({ userId: u.userId, username: u.username, prizeId, source: "website" });

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.WIZARR_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await shop.ready;
  await I.init();
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite 1 Month Access', 1000000, 50)", [MONTH]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite Lifetime Access', 25000000, 50)", [LIFE]);
  await mkUser(0).then((u) => runQuery("UPDATE users SET username = 'pb' WHERE userId = ?", [u.userId]));
  I.register(null, { noTimers: true });
});
test.after(() => server.close());

test("off (the default): buying an invite item creates nothing - fulfilled by hand as before", async () => {
  const u = await mkUser();
  const r = await buy(u, MONTH);
  assert.equal(r.success, true);
  await settle();
  assert.equal(W.posts.length, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM media_invites"))[0].n, 0);
  assert.equal((await shop.getOrder(r.order_id)).seller_note, null);
});

test("on: one one-time invite per purchase, the link only on the buyer's order + a 🔔", async () => {
  await conf.set({ invites_enabled: true, wizarr_server_ids: "1", wizarr_library_ids: "3, 4", wizarr_link_days: 7 }, "test");
  const u = await mkUser();
  const r = await buy(u, MONTH);
  await settle();
  assert.equal(W.posts.length, 1);
  // 1.99jp: Wizarr never expires it by itself (PATV tracks the 30 days: plexmembers.js) unless wizarr_timed is on
  assert.deepEqual(W.posts[0], { expires_in_days: 7, duration: "unlimited", unlimited: true, allow_downloads: false, allow_live_tv: false,
                                 allow_mobile_uploads: false, server_ids: [1], library_ids: [3, 4] });
  const o = await shop.getOrder(r.order_id);
  assert.equal(o.status, "completed");
  assert.match(o.seller_note, /https:\/\/wizarr\.example\.test\/j\/INV1/);
  assert.match(o.seller_note, /30 days of Plex access/);
  const inv = (await getQuery("SELECT * FROM media_invites WHERE order_id = ?", [r.order_id]))[0];
  assert.equal(inv.status, "created");
  const note = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'media'", [u.userId]))[0];
  assert.equal(note.link, `/shop/orders/${r.order_id}`);
  assert.ok(!String(note.body).includes("wizarr"), "the notice points at the order, it doesn't carry the link");
  // lifetime
  const r2 = await buy(u, LIFE);
  await settle();
  assert.equal(W.posts[1].duration, "unlimited");
  assert.equal(W.posts[1].unlimited, true);
  assert.match((await shop.getOrder(r2.order_id)).seller_note, /lifetime/);
  // the hook firing twice for one order makes one invite
  await I.onSale({ orderId: r2.order_id, prizeId: LIFE, title: "x", price: 1, userId: u.userId, username: u.username });
  assert.equal(W.posts.length, 2);
});

test("1.99jp: wizarr_timed on = a timed invite; a subscription renewal and an existing Plex member get no new invite", async () => {
  await conf.set({ wizarr_timed: true }, "test");
  const u = await mkUser();
  await buy(u, MONTH);
  await settle();
  assert.equal(W.posts[W.posts.length - 1].duration, "30");
  assert.equal(W.posts[W.posts.length - 1].unlimited, false);
  await conf.set({ wizarr_timed: false }, "test");
  const before = W.posts.length;
  assert.equal(await I.onSale({ orderId: 99901, prizeId: MONTH, title: "x", price: 1, userId: u.userId, username: u.username, renewal: true }), false);
  // already on the server (an active, linked member): the purchase extends, no invite
  const PM = require(path.join(repo, "plexmembers"));
  await PM.init();
  await runQuery("INSERT INTO plex_members (plex_id, username, on_server, pending, user_id, access) VALUES ('77', 'onplex', 1, 0, ?, 'pre-existing')", [u.userId]);
  await PM.reload();
  const r = await buy(u, MONTH);
  await settle();
  assert.equal(W.posts.length, before, "no new invite");
  assert.equal((await getQuery("SELECT status FROM media_invites WHERE order_id = ?", [r.order_id]))[0].status, "extended");
  assert.match((await shop.getOrder(r.order_id)).seller_note, /already on our Plex server \(as onplex\)/);
});

test("Wizarr down: the order goes to the manual queue, the buyer is told it's coming; the retry sends it", async () => {
  W.down = true;
  const u = await mkUser();
  const r = await buy(u, MONTH);
  await settle();
  let q = (await I.adminState()).queue;
  assert.equal(q.length, 1);
  assert.equal(q[0].order_id, r.order_id);
  assert.match(q[0].error, /503/);
  assert.match((await shop.getOrder(r.order_id)).seller_note, /being prepared/);
  assert.equal(await I.retryDue(), 0, "not due yet");
  W.down = false;
  I._setClock(() => Date.now() + 11 * 60000);
  try { assert.equal(await I.retryDue(), 1); } finally { I._setClock(null); }
  q = (await I.adminState()).queue;
  assert.equal(q.length, 0);
  assert.match((await shop.getOrder(r.order_id)).seller_note, /\/j\/INV/);
});

test("manual queue: an admin retries or records a link sent by hand", async () => {
  W.down = true;
  const u = await mkUser();
  const r = await buy(u, MONTH);
  await settle();
  const row = (await I.adminState()).queue[0];
  await assert.rejects(I.adminRetry(row.id, "admin"), /Still failing/);
  await assert.rejects(I.adminSent(row.id, "hi", "admin"), /Paste the invite link/);
  const ok = await I.adminSent(row.id, "https://wizarr.example.test/j/BYHAND", "admin");
  assert.equal(ok.ok, true);
  assert.match((await shop.getOrder(r.order_id)).seller_note, /BYHAND/);
  assert.equal((await getQuery("SELECT status, done_by FROM media_invites WHERE id = ?", [row.id]))[0].status, "sent");
  await assert.rejects(I.adminSent(row.id, "https://x.test/j/A", "admin"), /Not in the queue/);
  W.down = false;
});

test("Wizarr's servers + libraries for the settings form", async () => {
  const c = await I.catalog();
  assert.deepEqual(c.servers, [{ id: 1, name: "Plex", type: "plex" }]);
  assert.deepEqual(c.libraries, [{ id: 3, name: "Movies", server: 1 }]);
});
