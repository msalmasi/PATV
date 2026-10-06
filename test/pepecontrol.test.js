// Offline tests for the admin-only Pepe control panel (pepecontrol.js): role gating (page + API),
// CSRF, step-up password, single-use nonce, 2-minute pickup expiry, 3-per-10-min rate limit, the
// VM's atomic claim + idempotent ack, heartbeat status and the audit log.
//   node --test test/pepecontrol.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepectl-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
delete process.env.PEPE_CONTROL_SECRET;
const express = require("express");
const ejs = require("ejs");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pepecontrol"));

let T = 1_800_000_000_000;
P._setClock(() => T);
const adv = (ms) => { T += ms; };
const BOT = { "x-bot-token": "bot-token", "content-type": "application/json" };

let base, server;
test.before(async () => {
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb')");
  const h = await bcrypt.hash("right-pass", 4);
  await runQuery("INSERT INTO users VALUES ('a1', 'boss', ?, 'Admin'), ('a2', 'boss2', ?, 'Admin'), ('s1', 'staffer', ?, 'Staff'), ('p1', 'pleb', ?, 'pleb'), ('a3', 'nopw', '', 'Admin'), ('a4', 'lockme', ?, 'Admin')", [h, h, h, h, h]);
  await P.init();
  const app = express();
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  P.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());
test.beforeEach(async () => {
  await runQuery("DELETE FROM pepe_control_cmds");
  await runQuery("DELETE FROM pepe_control_audit");
  adv(60 * 60 * 1000);                   // fresh rate window + lockouts gone
});

const H = (u, csrf) => Object.assign({ "content-type": "application/json" }, u ? { "x-test-user": u } : {}, csrf ? { "x-csrf-token": csrf } : {});
const tok = (name) => P.csrfToken(name);
async function call(p, u, body, csrf, extra = {}) {
  const r = await fetch(base + p, body === undefined ? { headers: Object.assign(H(u, csrf), extra) }
    : { method: "POST", headers: Object.assign(H(u, csrf), extra), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function nonce(u = "a1", name = "boss") { const r = await call("/api/pepe/control/nonce", u, {}, tok(name)); assert.equal(r.status, 200); return r.body.nonce; }
async function command(kind = "pepe", mode = "now", { u = "a1", name = "boss", pw = "right-pass", n } = {}) {
  return call("/api/pepe/control/command", u, { kind, mode, nonce: n || (await nonce(u, name)), password: pw }, tok(name));
}
const pending = () => call("/api/pepe/control/pending", null, undefined, null, { "x-bot-token": "bot-token" });
const ack = (body, token = "bot-token") => fetch(base + "/api/pepe/control/ack", { method: "POST", headers: { "content-type": "application/json", "x-bot-token": token }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("role gating: the panel renders for admins only, and the API refuses everyone else", async () => {
  const file = path.join(repo, "views", "partials", "pepe-control.ejs");
  const html = (me) => ejs.renderFile(file, { me, pepeCtlCsrf: P.csrfToken });
  assert.match(await html({ username: "boss", class: "Admin" }), /Pepe control panel/);
  for (const me of [null, { username: "staffer", class: "Staff" }, { username: "pleb", class: "pleb" }]) {
    assert.equal((await html(me)).trim(), "", "no markup for " + JSON.stringify(me));
  }
  assert.equal((await call("/api/pepe/control/status", null)).status, 401);
  assert.equal((await call("/api/pepe/control/status", "s1")).status, 403);
  assert.equal((await call("/api/pepe/control/status", "p1")).status, 403);
  assert.equal((await call("/api/pepe/control/status", "a1")).status, 200);
  // a non-admin with a perfectly good token for their own name still can't command
  assert.equal((await call("/api/pepe/control/nonce", "s1", {}, tok("staffer"))).status, 403);
  assert.equal((await call("/api/pepe/control/command", "p1", { kind: "pepe", mode: "now", nonce: "x", password: "right-pass" }, tok("pleb"))).status, 403);
  // the bot endpoints want the bot token
  assert.equal((await call("/api/pepe/control/pending", "a1")).status, 403);
  assert.equal((await ack({ id: "0".repeat(16), nonce: "x", status: "done" }, "nope")).status, 403);
  assert.equal((await call("/api/pepe/control/heartbeat", null, { status: {} }, null, { "x-bot-token": "wrong" })).status, 403);
});

test("CSRF: missing, forged, other-user, expired tokens and a cross-site Origin are refused", async () => {
  assert.equal((await call("/api/pepe/control/nonce", "a1", {})).status, 403);
  assert.equal((await call("/api/pepe/control/nonce", "a1", {}, "abc.def")).status, 403);
  assert.equal((await call("/api/pepe/control/nonce", "a1", {}, tok("boss2"))).status, 403, "token of another admin");
  const old = tok("boss");
  adv(13 * 3600 * 1000);
  assert.equal((await call("/api/pepe/control/nonce", "a1", {}, old)).status, 403, "expired token");
  assert.equal((await call("/api/pepe/control/nonce", "a1", {}, tok("boss"), { origin: "https://evil.example" })).status, 403);
  const n = await nonce();
  const r = await call("/api/pepe/control/command", "a1", { kind: "pepe", mode: "now", nonce: n, password: "right-pass" }, "bad.token");
  assert.equal(r.status, 403);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_control_cmds"))[0].n, 0);
  const a = await getQuery("SELECT action, result FROM pepe_control_audit");
  assert.ok(a.some((x) => x.action === "denied" && /CSRF/.test(x.result)));
});

test("step-up: wrong password refused + audited, lockout after 5, no-password account refused", async () => {
  const L = { u: "a4", name: "lockme" };
  let r = await command("pepe", "now", { ...L, pw: "wrong" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /Wrong password/);
  for (let i = 0; i < 4; i++) await command("pepe", "now", { ...L, pw: "wrong" });
  r = await command("pepe", "now", L);                  // right password, but locked out now
  assert.equal(r.status, 429);
  r = await command("pepe", "now", { u: "a3", name: "nopw", pw: "" });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /no password/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_control_cmds"))[0].n, 0);
  const a = await getQuery("SELECT action, result, ip_hash FROM pepe_control_audit WHERE action = 'denied'");
  assert.ok(a.length >= 7);
  assert.ok(a.every((x) => x.ip_hash && x.ip_hash !== "127.0.0.1" && !/127\.0\.0\.1/.test(x.ip_hash)), "IP is stored hashed");
});

test("nonce: single use (a replay is refused even with the right password), bound to the admin, expires", async () => {
  const n = await nonce();
  let r = await command("pepe", "now", { n });
  assert.equal(r.status, 200);
  r = await command("pepe", "now", { n });
  assert.equal(r.status, 409, "reused nonce");
  // a wrong-password try still burns the nonce
  const n2 = await nonce();
  assert.equal((await command("pepe", "games", { n: n2, pw: "nope" })).status, 403);
  assert.equal((await command("pepe", "games", { n: n2 })).status, 409);
  // another admin's nonce
  const n3 = await nonce("a2", "boss2");
  assert.equal((await command("pepe", "games", { n: n3 })).status, 409);
  // expired nonce
  const n4 = await nonce();
  adv(6 * 60 * 1000);
  assert.equal((await command("pepe", "games", { n: n4 })).status, 409);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_control_cmds"))[0].n, 1);
});

test("unknown kinds/modes never reach the VM", async () => {
  assert.equal((await command("shutdown", "now")).status, 400);
  assert.equal((await command("pepe", "later")).status, 400);
  assert.equal((await command("__proto__", "now")).status, 400);
  assert.equal((await pending()).body.command, null);
});

test("claim is atomic + at most once; ack is idempotent; nonce must match", async () => {
  const r = await command("full", "games");
  assert.equal(r.status, 200);
  const c = (await pending()).body.command;
  assert.equal(c.id, r.body.command.id);
  assert.equal(c.kind, "full");
  assert.equal(c.mode, "games");
  assert.equal(c.by, "boss");
  assert.equal((await pending()).body.command, null, "handed out once");
  assert.equal((await ack({ id: c.id, nonce: "wrong", status: "accepted" })).status, 404);
  assert.equal((await ack({ id: c.id, nonce: c.nonce, status: "exploded" })).status, 400);
  assert.equal((await ack({ id: c.id, nonce: c.nonce, status: "accepted" })).status, 200);
  assert.equal((await ack({ id: c.id, nonce: c.nonce, status: "waiting", detail: "waiting for: a heist" })).status, 200);
  // a waiting restart can be overridden by a new one; anything else in flight blocks
  let d = (await call("/api/pepe/control/status", "a1")).body;
  assert.equal(d.active.status, "waiting");
  assert.equal((await ack({ id: c.id, nonce: c.nonce, status: "done", detail: "Pepe back up" })).body.status, "done");
  const again = await ack({ id: c.id, nonce: c.nonce, status: "failed", detail: "late" });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true);
  const row = (await getQuery("SELECT status, detail FROM pepe_control_cmds WHERE id = ?", [c.id]))[0];
  assert.deepEqual(row, { status: "done", detail: "Pepe back up" });
  d = (await call("/api/pepe/control/status", "a1")).body;
  assert.equal(d.active, null);
  assert.equal(d.last.id, c.id);
  assert.ok(d.audit.some((x) => x.action === "result" && /^done/.test(x.result)));
  assert.ok(d.audit.some((x) => x.action === "requested" && x.username === "boss"));
});

test("one at a time: a running restart blocks a second; a waiting one does not", async () => {
  assert.equal((await command("pepe", "now")).status, 200);
  assert.equal((await command("full", "now")).status, 409, "pending blocks");
  const c = (await pending()).body.command;
  await ack({ id: c.id, nonce: c.nonce, status: "waiting" });
  assert.equal((await command("pepe", "now")).status, 200, "waiting can be overridden");
});

test("expiry: a command nobody picks up within 2 minutes expires and is never handed out", async () => {
  const r = await command("pepe", "now");
  adv(2 * 60 * 1000 + 1);
  assert.equal((await pending()).body.command, null);
  const row = (await getQuery("SELECT status FROM pepe_control_cmds WHERE id = ?", [r.body.command.id]))[0];
  assert.equal(row.status, "expired");
  assert.equal((await ack({ id: r.body.command.id, nonce: "x", status: "done" })).status, 404);
  const a = await getQuery("SELECT result FROM pepe_control_audit WHERE action = 'result'");
  assert.ok(a.some((x) => /expired/.test(x.result)));
  // just inside the window is fine
  const r2 = await command("pepe", "now");
  adv(2 * 60 * 1000 - 1000);
  assert.equal((await pending()).body.command.id, r2.body.command.id);
});

test("a claimed command the VM never reports on fails after 15 min instead of blocking forever", async () => {
  await command("pepe", "now");
  const c = (await pending()).body.command;
  assert.equal((await command("pepe", "now")).status, 409);
  adv(15 * 60 * 1000 + 1);
  const d = (await call("/api/pepe/control/status", "a1")).body;
  assert.equal(d.active, null);
  assert.equal((await getQuery("SELECT status FROM pepe_control_cmds WHERE id = ?", [c.id]))[0].status, "failed");
  assert.equal((await command("pepe", "now")).status, 200);
});

test("rate limit: 3 commands per 10 minutes across admins", async () => {
  for (let i = 0; i < 3; i++) {
    const r = await command("pepe", "games", i === 1 ? { u: "a2", name: "boss2" } : {});
    assert.equal(r.status, 200, "command " + i);
    const c = (await pending()).body.command;
    await ack({ id: c.id, nonce: c.nonce, status: "done" });
    adv(60 * 1000);
  }
  const r = await command("pepe", "games");
  assert.equal(r.status, 429);
  assert.match(r.body.error, /3 restarts per 10 minutes/);
  adv(8 * 60 * 1000);
  assert.equal((await command("pepe", "games")).status, 200, "window passed");
});

test("heartbeat: status shows online, goes offline after 60 s, oversize refused", async () => {
  const st = { version: "1.99bc", pepe: { pid: 42, running: true, rooms: ["PepeLab"] } };
  assert.equal((await call("/api/pepe/control/heartbeat", null, { status: st }, null, { "x-bot-token": "bot-token" })).status, 200);
  let d = (await call("/api/pepe/control/status", "a1")).body;
  assert.equal(d.online, true);
  assert.deepEqual(d.status.pepe.rooms, ["PepeLab"]);
  adv(61 * 1000);
  d = (await call("/api/pepe/control/status", "a1")).body;
  assert.equal(d.online, false);
  const big = { x: "y".repeat(20000) };
  assert.equal((await call("/api/pepe/control/heartbeat", null, { status: big }, null, { "x-bot-token": "bot-token" })).status, 413);
});
