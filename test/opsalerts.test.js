// 1.99aai opsalerts.js: POST /api/ops/alert (loopback, not proxied, bot token) -> every site admin's inbox (🛠️ Admin,
// no Telegram from the notice itself) + a Telegram alert of kind "ops" through the alerts outbox (on by default,
// hidden from the member prefs list), idempotent per ref, rate-limited per source.
//   node --test test/opsalerts.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opsalerts-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token-test";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const TG = require(path.join(repo, "telegram"));
const OPS = require(path.join(repo, "opsalerts"));

let server, base;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 5)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER,
                  until INTEGER, PRIMARY KEY (user_id, room_id))`);
  const add = (id, u, cls, archived) => runQuery("INSERT INTO users (userId, username, displayname, password, class, archived_at) VALUES (?, ?, ?, 'x', ?, ?)", [id, u, u, cls, archived || null]);
  await add("a1", "pb", "Admin");
  await add("a2", "ops2", "Admin");
  await add("a3", "oldadmin", "Admin", 1);
  await add("m1", "member", "pleb");
  await TG.init();
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, handle, link_source, proof, linked_at) VALUES ('a1', '111', 'pb', 'self', 'start_code', 1)");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, handle, link_source, proof, linked_at) VALUES ('m1', '333', 'm', 'self', 'start_code', 1)");
  const app = express();
  app.use(express.json());
  OPS.register(app, { isBotToken: (t) => t === "bot-token-test" });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

function post(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(base + "/api/ops/alert", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      let s = ""; res.on("data", (c) => (s += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(s || "{}") }));
    });
    req.on("error", reject); req.end(data);
  });
}

test("refuses a wrong token and anything that came through the proxy", async () => {
  assert.equal((await post({ password: "nope", title: "x" })).status, 403);
  assert.equal((await post({ password: "bot-token-test", title: "x" }, { "X-Forwarded-For": "1.2.3.4" })).status, 403);
  assert.equal((await post({ password: "bot-token-test", title: "x" }, { "X-Real-IP": "1.2.3.4" })).status, 403);
  assert.equal((await post({ password: "bot-token-test", title: "" })).status, 400);
});

test("files an inbox notice + an 'ops' Telegram alert for each active admin, once per ref", async () => {
  const r = await post({ password: "bot-token-test", source: "pepe-relay", ref: "restart-1", title: "Pepe's stream relay restarted", body: "why" });
  assert.equal(r.status, 200);
  assert.deepEqual({ admins: r.json.admins, inbox: r.json.inbox, telegram: r.json.telegram }, { admins: 2, inbox: 2, telegram: 1 });
  const notes = await getQuery("SELECT user_id, kind, title FROM inbox ORDER BY user_id");
  assert.deepEqual(notes.map((n) => n.user_id), ["a1", "a2"]);
  assert.ok(notes.every((n) => n.kind === "admin" && n.title.startsWith("🚨 ")));
  const ob = await getQuery("SELECT user_id, kind, ref, text FROM telegram_outbox");
  assert.equal(ob.length, 1);
  assert.equal(ob[0].user_id, "a1");
  assert.equal(ob[0].kind, "ops");
  assert.match(ob[0].text, /restarted\nwhy/);
  const again = await post({ password: "bot-token-test", source: "pepe-relay", ref: "restart-1", title: "Pepe's stream relay restarted" });
  assert.equal(again.json.inbox, 0);
  assert.equal(again.json.telegram, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM telegram_outbox"))[0].n, 1);
});

test("'ops' is on by default but not a member-facing Telegram switch", async () => {
  assert.ok(TG.DEFAULT_ON.has("ops"));
  const p = await TG.prefs("m1");
  assert.ok(!p.some((k) => k.key === "ops" || k.key === "admin"));
});

test("rate limit per source", async () => {
  OPS._reset();
  for (let i = 0; i < OPS.RATE_MAX; i++) assert.ok(!(await OPS.alert({ source: "flood", ref: "r" + i, title: "t" })).limited);
  assert.equal((await OPS.alert({ source: "flood", ref: "over", title: "t" })).limited, true);
  assert.ok(!(await OPS.alert({ source: "other", ref: "o", title: "t" })).limited);
});
