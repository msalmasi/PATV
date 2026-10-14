// 1.99yz: spincfg.js - chat !spin private by default; admins switch it on /admin/games#chatspin; Pepe gets it with each spin.
//   NODE_PATH=G:/PATV/node_modules node --test test/spincfg.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "spincfg-test-")));
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const SC = require(path.join(repo, "spincfg"));

let base, server, who = null;
test.before(async () => {
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, class TEXT)");
  await runQuery("INSERT INTO users VALUES ('a1', 'boss', 'Admin'), ('p1', 'pleb', 'pleb')");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const h = req.headers["x-test-user"]; who = h ? { userId: h, username: h } : null; next(); });
  SC.register(app, { addUser: (req, res, next) => { req.user = who; next(); } });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const call = (method, user, body, extra = {}) => fetch(base + "/api/admin/spin-cfg", { method, headers: Object.assign({ "Content-Type": "application/json", "x-test-user": user || "" }, extra),
  body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("private by default", async () => {
  assert.equal(await SC.chatPrivate(), true);
  assert.deepEqual((await call("GET", "a1")).body.cfg, { chat_private: true });
});

test("admins only, same-site fetch, booleans only; the next spin sees the change", async () => {
  assert.equal((await call("GET", "p1")).status, 403);
  assert.equal((await call("POST", "p1", { chat_private: false }, { "X-Requested-With": "fetch" })).status, 403);
  assert.equal((await call("POST", "a1", { chat_private: false })).status, 403, "not a fetch");
  assert.equal((await call("POST", "a1", { chat_private: "no" }, { "X-Requested-With": "fetch" })).status, 400);
  const r = await call("POST", "a1", { chat_private: false }, { "X-Requested-With": "fetch" });
  assert.equal(r.status, 200);
  assert.equal(r.body.cfg.chat_private, false);
  assert.equal(await SC.chatPrivate(), false);
  await call("POST", "a1", { chat_private: true }, { "X-Requested-With": "fetch" });
  assert.equal(await SC.chatPrivate(), true);
});
