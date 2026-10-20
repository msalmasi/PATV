// CL2 the "Chat archive" card's API (/admin/bridge; chatlog.js): site Admins only (chatlog.admin, privacy-locked), changes need a
// same-origin fetch; the notice switch, the archive's 7-day guard (409 with when it opens), the held un-hides (approve / reject),
// the full index check; counters only (never a count(*) over the archive) and never a line's text.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-admin.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-admin-test-")));
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const CL = require(path.join(repo, "chatlog"));
const DAY = 86400000;

const USERS = { boss: { userId: "u_boss", username: "boss", class: "Admin" }, helper: { userId: "u_helper", username: "helper", class: "Staff" },
                rando: { userId: "u_rando", username: "rando", class: "pleb" } };
let base, server, clockAt = Date.now();
CL._setClock(() => clockAt);
const pepeHash = (l) => crypto.createHash("sha256").update("pepe-hidden:" + l).digest("hex").slice(0, 20);
// node:http, not the global fetch (Node 16 has none)
function call(method, url, who, body, { csrf = true } = {}) {
  const headers = { "content-type": "application/json", ...(who ? { "x-test-user": who } : {}), ...(csrf ? { "x-requested-with": "fetch", origin: base } : {}) };
  const data = body === undefined ? null : JSON.stringify(body);
  if (data) headers["content-length"] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const req = require("http").request(base + url, { method, headers }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (x) => { s += x; });
      res.on("end", () => { try { resolve({ status: res.statusCode, d: JSON.parse(s) }); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// (a promise every test awaits - Node 16's runner doesn't wait for a top-level test.before)
const setup = (async () => {
  await CL.init();
  await runQuery("CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT)");
  const app = express();
  const addUser = (req, res, next) => { req.user = USERS[req.get("x-test-user")] || null; next(); };
  CL.register(app, { addUser });
  server = app.listen(0);
  server.unref();                                   // (the process ends with the tests, whatever the runner does with after hooks)
  base = "http://127.0.0.1:" + server.address().port;
})();
test.after(() => { if (server) server.close(); });

test("site Admins only; staff, members and visitors are refused", async () => {
  await setup;
  for (const who of [null, "rando", "helper"]) assert.equal((await call("GET", "/api/admin/chatlog", who)).status, 403, String(who));
  const r = await call("GET", "/api/admin/chatlog", "boss");
  assert.equal(r.status, 200);
  assert.equal(r.d.cfg.notice, false);
  assert.equal(r.d.cfg.archive, false);
  assert.equal(r.d.cfg.purge, true);
  assert.equal(r.d.location, "myapp.db");
  assert.deepEqual(r.d.totals, { rooms: 0, rows: 0, indexed: 0, bytes: 0 });
  assert.ok(r.d.private_cmds.includes("!verify"));
  for (const who of ["rando", "helper"]) assert.equal((await call("POST", "/api/admin/chatlog/switch", who, { name: "notice", on: true })).status, 403);
});

test("a change needs a same-origin fetch", async () => {
  await setup;
  const r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "notice", on: true }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(CL.cfg().notice, false);
});

test("the notice, then the archive only 7 days later (409 says when)", async () => {
  await setup;
  let r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "archive", on: true });
  assert.equal(r.status, 409);
  assert.equal(r.d.code, "notice_off");
  r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "notice", on: true });
  assert.equal(r.status, 200);
  assert.equal(r.d.cfg.notice, true);
  assert.equal(r.d.cfg.by, "boss");
  r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "archive", on: true });
  assert.equal(r.status, 409);
  assert.equal(r.d.code, "notice_wait");
  assert.equal(r.d.opens_at, CL.cfg().notice_at + 7 * DAY);
  clockAt += 7 * DAY + 1;
  r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "archive", on: true });
  assert.equal(r.status, 200);
  assert.equal(r.d.cfg.archive, true);
  assert.ok(r.d.seed, "the seed ran");
  r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "notice", on: false });
  assert.equal(r.status, 409, "never the policy text off while the archive writes");
  assert.equal(r.d.code, "archive_on");
  assert.equal((await call("GET", "/api/admin/chatlog", "boss")).d.archive_error, null, "CL2 fix-up: no archive error to show");
  r = await call("POST", "/api/admin/chatlog/switch", "boss", { name: "nope", on: true });
  assert.equal(r.status, 400);
});

test("held un-hides: listed by count (never the hashes), approve / reject", async () => {
  await setup;
  const hs = Array.from({ length: 6 }, (_, i) => pepeHash("adm" + i));
  let seq = 0;
  await CL.noteSync({ events: hs.map((h) => ({ type: "privacy.hidden", id: "x" + (++seq), data: { h, scope: "bridge" } })) });
  await CL.noteSync({ events: hs.map((h) => ({ type: "privacy.shown", id: "x" + (++seq), data: { h, scope: "bridge" } })) });
  let r = await call("GET", "/api/admin/chatlog", "boss");
  assert.equal(r.d.held.length, 1);
  assert.deepEqual(Object.keys(r.d.held[0]).sort(), ["at", "id", "kind", "n"]);
  assert.equal(r.d.held[0].n, 6);
  assert.equal((await call("POST", "/api/admin/chatlog/held", "boss", { id: r.d.held[0].id, action: "maybe" })).status, 400);
  r = await call("POST", "/api/admin/chatlog/held", "boss", { id: r.d.held[0].id, action: "approve" });
  assert.equal(r.status, 200);
  assert.equal(r.d.removed, 6);
  assert.equal((await call("GET", "/api/admin/chatlog", "boss")).d.held.length, 0);
  // CL2 fix-up: the card counts each kind (left out / incognito only) and says the set is loaded
  const v = (await call("GET", "/api/admin/chatlog", "boss")).d.hidden;
  assert.deepEqual(Object.keys(v).sort(), ["anon", "hidden", "out", "ready", "tx"]);
  assert.equal(v.ready, true);
});

test("the index: a full check from the card", async () => {
  await setup;
  const r = await call("POST", "/api/admin/chatlog/fts", "boss", { action: "check" });
  assert.equal(r.status, 200);
  assert.equal(r.d.check.ok, true);
  assert.equal(r.d.fts.on, true);
  assert.equal((await call("POST", "/api/admin/chatlog/fts", "boss", { action: "rebuild" })).status, 400, "no 'rebuild'");
});
