// Offline tests for 🎬 media requests (mediarequests.js) against a mocked Overseerr: search + availability, who the
// request is made as (admin link / verified email / service user), paying (credit -> PAT through the shop's official
// service charge -> free), immediate refunds when Overseerr refuses, refunds once when it's declined later, the
// 🔔 notice when it's available, the webhook's secret, and the store's request-credit items.
//   node --test test/mediarequests.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mreq-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
process.env.SECRET_KEY = "test-secret";
process.env.OVERSEERR_API_KEY = "test-overseerr-key";
process.env.OVERSEERR_WEBHOOK_SECRET = "hook-secret";

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const conf = require(path.join(repo, "mediaconf"));
const R = require(path.join(repo, "mediarequests"));

// ── a mock Overseerr ──
const O = { requests: new Map(), nextId: 1, posts: [], keyOk: true, fail: null, media: {} };
const TITLES = {
  "movie/11": { id: 11, title: "Star Wars", releaseDate: "1977-05-25", posterPath: "/sw.jpg" },
  "movie/12": { id: 12, title: "Finding Nemo", releaseDate: "2003-05-30", posterPath: "/fn.jpg", mediaInfo: { status: 5 } },
  "movie/13": { id: 13, title: "Already Asked", releaseDate: "2020-01-01", mediaInfo: { status: 3 } },
  "tv/1399": { id: 1399, name: "Game of Thrones", firstAirDate: "2011-04-17", posterPath: "/got.jpg",
               seasons: [{ seasonNumber: 0, episodeCount: 5 }, { seasonNumber: 1, episodeCount: 10 }, { seasonNumber: 2, episodeCount: 10 }],
               mediaInfo: { status: 4, seasons: [{ seasonNumber: 1, status: 5 }] } },
};
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const send = (st, j) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.headers["x-api-key"] !== "test-overseerr-key") return send(403, { message: "bad key" });
    const u = new URL(req.url, "http://x");
    const p = u.pathname.replace(/^\/api\/v1/, "");
    if (p === "/search") return send(200, { results: [{ mediaType: "movie", ...TITLES["movie/11"] }, { mediaType: "tv", ...TITLES["tv/1399"] }, { mediaType: "person", id: 5, name: "Someone" }] });
    let m;
    if ((m = /^\/(movie|tv)\/(\d+)$/.exec(p))) { const t = TITLES[`${m[1]}/${m[2]}`]; return t ? send(200, t) : send(404, {}); }
    if (p === "/user") return send(200, { results: [{ id: 7, email: "Verified@Example.com", username: "vee" }, { id: 8, email: "unverified@example.com" }] });
    if (p === "/request" && req.method === "POST") {
      const b = JSON.parse(body);
      O.posts.push(b);
      if (O.fail) { const f = O.fail; O.fail = null; return send(f.status, f.body || { message: "nope" }); }
      const id = O.nextId++;
      const q = { id, status: 1, media: { status: 2, tmdbId: b.mediaId } };
      O.requests.set(id, q);
      return send(201, q);
    }
    if ((m = /^\/request\/(\d+)$/.exec(p))) { const q = O.requests.get(Number(m[1])); return q ? send(200, q) : send(404, {}); }
    send(404, {});
  });
});

let n = 0;
async function mkUser({ bal = 0, email = null, verified = 0, level = 5 } = {}) {
  const id = "r" + (++n);
  await runQuery("INSERT INTO users (userId, username, password, points_balance, level, email, isEmailVerified) VALUES (?, ?, 'x', ?, ?, ?, ?)",
                 [id, "req" + n, bal, level, email, verified]);
  return { userId: id, username: "req" + n };
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
let pb;

test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.OVERSEERR_URL = `http://127.0.0.1:${server.address().port}`;
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await shop.ready;
  await R.init();
  pb = await mkUser({ bal: 0 });
  await runQuery("UPDATE users SET username = 'pb' WHERE userId = ?", [pb.userId]);
  shop.onOfficialSale(R.onSale);
});
test.after(() => server.close());

test("off until the flag is on (keys alone aren't enough)", async () => {
  const u = await mkUser();
  await assert.rejects(R.search(u, "star"), /switched off/);
  await conf.set({ requests_enabled: true, requests_per_day: 20 }, "test");
  const r = await R.search(u, "star");
  assert.deepEqual(r.map((x) => [x.type, x.title, x.year]), [["movie", "Star Wars", 1977], ["tv", "Game of Thrones", 2011]], "people are left out");
  assert.equal(r[1].availability, "partial");
});

test("free request: made on behalf of the service user, status pending, shows in 'mine'", async () => {
  await conf.set({ overseerr_service_user: "42" }, "test");
  const u = await mkUser();
  const r = await R.request(u, { type: "movie", tmdb: 11 });
  assert.equal(r.status, "pending");
  assert.equal(r.paid_with, "free");
  assert.deepEqual(O.posts.at(-1), { mediaType: "movie", mediaId: 11, userId: 42 });
  const mine = await R.mine(u.userId);
  assert.equal(mine[0].title, "Star Wars");
  assert.equal(mine[0].label, "Waiting for approval");
  await assert.rejects(R.request(u, { type: "movie", tmdb: 11 }), /already asked/);
});

test("already on Plex / already on its way: refused before anything is charged", async () => {
  const u = await mkUser({ bal: 1000 });
  await assert.rejects(R.request(u, { type: "movie", tmdb: 12 }), /already on Plex/);
  await assert.rejects(R.request(u, { type: "movie", tmdb: 13 }), /on its way/);
  assert.equal(await bal(u.userId), 1000);
});

test("who requests: an admin link wins, then a VERIFIED email match, else the service user", async () => {
  const v = await mkUser({ email: "verified@example.com", verified: 1 });
  const nv = await mkUser({ email: "unverified@example.com", verified: 0 });
  R._resetUsers();
  assert.deepEqual(await R.requesterFor(v.userId), { id: 7, how: "email" });
  assert.deepEqual(await R.requesterFor(nv.userId), { id: 42, how: "service" }, "an unverified email doesn't match");
  await R.setLink((await getQuery("SELECT username FROM users WHERE userId = ?", [nv.userId]))[0].username, "9", "admin");
  assert.deepEqual(await R.requesterFor(nv.userId), { id: 9, how: "link" });
  await conf.set({ overseerr_service_user: "" }, "test");
  const x = await mkUser();
  assert.deepEqual(await R.requesterFor(x.userId), { id: null, how: "owner" });
  await R.request(x, { type: "movie", tmdb: 11 });
  assert.equal(O.posts.at(-1).userId, undefined, "the API key's owner: no userId sent");
});

test("PAT price: charged through the shop's official service order (to the store owner); Overseerr refusing = full refund", async () => {
  await conf.set({ request_price_movie: 500, request_price_tv: 800 }, "test");
  const u = await mkUser({ bal: 1000 });
  const pb0 = await bal(pb.userId);
  const r = await R.request(u, { type: "movie", tmdb: 11 });
  assert.equal(r.paid_with, "pat");
  assert.equal(await bal(u.userId), 500);
  assert.equal(await bal(pb.userId), pb0 + 500);
  const row = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [r.id]))[0];
  const order = await shop.getOrder(row.order_id);
  assert.equal(order.official, 1);
  assert.equal(order.status, "completed");
  assert.equal(order.prize_id, null);
  assert.match(order.title, /Star Wars/);
  // not enough PAT: refused, nothing written
  const poor = await mkUser({ bal: 100 });
  await assert.rejects(R.request(poor, { type: "movie", tmdb: 11 }), (e) => e.status === 402);
  assert.equal(await bal(poor.userId), 100);
  // Overseerr says no (quota): the PAT comes straight back
  const u2 = await mkUser({ bal: 1000 });
  O.fail = { status: 403, body: { message: "Movie Quota exceeded." } };
  await assert.rejects(R.request(u2, { type: "movie", tmdb: 11 }), /refused it.*Nothing was charged/);
  assert.equal(await bal(u2.userId), 1000);
  const bad = (await getQuery("SELECT * FROM media_requests WHERE user_id = ?", [u2.userId]))[0];
  assert.equal(bad.status, "error");
  assert.equal((await shop.getOrder(bad.order_id)).status, "refunded");
  // Overseerr down: same
  const keep = process.env.OVERSEERR_URL;
  process.env.OVERSEERR_URL = "http://127.0.0.1:1";
  try { await assert.rejects(R.request(u2, { type: "movie", tmdb: 11 }), (e) => e.status === 502); }
  finally { process.env.OVERSEERR_URL = keep; }
  assert.equal(await bal(u2.userId), 1000);
});

test("a show: the seasons not yet available, credits are used before PAT", async () => {
  const u = await mkUser({ bal: 0 });
  await R.addCredits(u.userId, "tv", 1);
  const r = await R.request(u, { type: "tv", tmdb: 1399, seasons: "all" });
  assert.equal(r.paid_with, "credit");
  assert.deepEqual(O.posts.at(-1).seasons, [2], "season 0 and the available season 1 are left out");
  assert.equal((await R.credits(u.userId)).tv, 0);
  await assert.rejects(R.request(u, { type: "tv", tmdb: 1399, seasons: [1] }), /already available/);
});

test("status sync: approved -> available sends one 🔔; declined later refunds once (credit or PAT)", async () => {
  const u = await mkUser({ bal: 5000 });
  const r = await R.request(u, { type: "movie", tmdb: 11 });
  const row = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [r.id]))[0];
  O.requests.get(row.overseerr_id).status = 2;
  assert.equal(await R.sync(row), "approved");
  O.requests.get(row.overseerr_id).media.status = 5;
  const row2 = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [r.id]))[0];
  assert.equal(await R.sync(row2), "available");
  assert.equal(await R.sync({ ...row2, status: "approved" }), "available");          // a repeat never notifies twice
  const notes = await getQuery("SELECT title FROM inbox WHERE user_id = ? AND kind = 'media'", [u.userId]);
  assert.equal(notes.filter((x) => /is on Plex/.test(x.title)).length, 1);
  assert.ok(notes.some((x) => /approved/.test(x.title)));
  // declined: refunded once
  const r2 = await R.request(u, { type: "tv", tmdb: 1399, seasons: [2] });
  const b0 = await bal(u.userId);
  const q2 = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [r2.id]))[0];
  O.requests.get(q2.overseerr_id).status = 3;
  assert.equal(await R.sync(q2), "declined");
  assert.equal(await bal(u.userId), b0 + 800);
  assert.equal(await R.refund(q2.id, "again"), false, "only once");
  assert.equal(await bal(u.userId), b0 + 800);
});

test("poll re-checks open requests; the webhook needs its secret and only re-reads from the API", async () => {
  const u = await mkUser({ bal: 5000 });
  const r = await R.request(u, { type: "movie", tmdb: 11 });
  const row = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [r.id]))[0];
  O.requests.get(row.overseerr_id).media.status = 5;
  assert.ok((await R.poll({ all: true })) >= 1);
  assert.equal((await getQuery("SELECT status FROM media_requests WHERE id = ?", [r.id]))[0].status, "available");
  // webhook: a lying body can't mark anything available; it only triggers a re-read
  const r2 = await R.request(u, { type: "tv", tmdb: 1399, seasons: [2] });
  const q2 = (await getQuery("SELECT * FROM media_requests WHERE id = ?", [r2.id]))[0];
  assert.equal(await R.webhook({ notification_type: "MEDIA_AVAILABLE", media: { media_type: "tv", tmdbId: 1399, status: "AVAILABLE" }, request: { request_id: String(q2.overseerr_id) } }), 1);
  assert.equal((await getQuery("SELECT status FROM media_requests WHERE id = ?", [r2.id]))[0].status, "pending", "Overseerr's API still says pending");
  // the route refuses a wrong secret
  const express = require("express");
  const app = express();
  app.use(express.json());
  R.register(app, { addUser: (q, s, nx) => { q.user = null; nx(); }, noTimers: true });
  const srv = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const url = `http://127.0.0.1:${srv.address().port}/api/requests/overseerr-webhook`;
  const post = (auth) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: "{}" }).then((x) => x.status);
  assert.equal(await post(null), 401);
  assert.equal(await post("wrong"), 401);
  assert.equal(await post("hook-secret"), 200);
  srv.close();
});

test("store items: a request-credit item adds credits + a note on the order (only while requests are on)", async () => {
  const PRIZE = "ff93ad3b-dde3-40c0-a4a7-7bdf9ab7de59";
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, '10 Additional Movie Requests', 15000, 5)", [PRIZE]);
  const u = await mkUser({ bal: 50000 });
  const r = await shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: PRIZE, source: "website" });
  assert.equal(r.success, true);
  for (let i = 0; i < 20 && !(await R.credits(u.userId)).movie; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal((await R.credits(u.userId)).movie, 10);
  const o = await shop.getOrder(r.order_id);
  assert.match(o.seller_note, /10 movie request credits/);
  await conf.set({ requests_enabled: false }, "test");
  const r2 = await shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: PRIZE, source: "website" });
  await new Promise((x) => setTimeout(x, 50));
  assert.equal((await R.credits(u.userId)).movie, 10, "off = fulfilled by hand, as before");
  assert.equal((await shop.getOrder(r2.order_id)).seller_note, null);
  await conf.set({ requests_enabled: true }, "test");
});

test("rate limit per day", async () => {
  await conf.set({ requests_per_day: 1, request_price_movie: 0 }, "test");
  const u = await mkUser();
  await R.request(u, { type: "movie", tmdb: 11 });
  await assert.rejects(R.request(u, { type: "tv", tmdb: 1399, seasons: [2] }), (e) => e.status === 429);
  await conf.set({ requests_per_day: 20 }, "test");
});
