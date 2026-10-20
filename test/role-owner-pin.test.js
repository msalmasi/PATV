// PO-0b (economy policy -> site plan, T23 / D-5): the OWNER list is pinned on the site. Pepe's role sync (bot token,
// POST /api/pepe/roles/bot) can't grant or remove "owner" once the site has one: the change is held in pepe_roles_pending,
// the merged answer keeps the site's role (so Pepe's copy goes back too), the existing owners get a notice, and an existing
// owner confirms (or rejects) it on /admin/roles with the password step-up. Every other role change syncs as before; an
// empty site still takes its first owner from Pepe.
//   NODE_PATH=G:/PATV/node_modules node --test test/role-owner-pin.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "role-owner-pin-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
let T = 1_900_000_000_000;
SR._setClock(() => T);
require(path.join(repo, "pepeperms"))._setClock(() => T);

let base, server;
const H = (u) => ({ "x-user": u || "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" });
const post = async (p, u, body) => { const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) }); return { status: r.status, j: await r.json() }; };
const bot = async (roles) => (await fetch(base + "/api/pepe/roles/bot", { method: "POST", headers: { "content-type": "application/json" },
                                                                          body: JSON.stringify({ password: "bot", roles }) })).json();
const pending = () => getQuery("SELECT login, role, ts, was FROM pepe_roles_pending ORDER BY login");
const nonce = async (u) => (await post("/api/admin/roles/nonce", u)).j.nonce;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 0)`);
  const h = await bcrypt.hash("pw-ok", 4);
  for (const [id, name, cls, cf] of [["own", "boss", "Admin", "BossFrog"], ["adm", "admin2", "Admin", "plainadmin"], ["new", "newbie", "pleb", "newowner"],
                                     ["own2", "second", "Admin", "second_owner"], ["adm3", "admin3", "Admin", "norole_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, ?, ?, ?)", [id, name, h, cls, cf]);
  }
  await require(path.join(repo, "adminaudit")).init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  SR.register(app, { isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "adminroles")).register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("an empty site still takes its first owners from Pepe (someone has to confirm the next one)", async () => {
  const r = await bot({ bossfrog: ["owner", 1], plainadmin: ["admin", 1], second_owner: ["owner", 1] });
  assert.equal(r.ok, true);
  assert.equal(await SR.roleOf("bossfrog"), "owner");
  assert.equal(await SR.roleOf("second_owner"), "owner");
  assert.equal(r.held, 0);
  assert.deepEqual(await pending(), []);
});

test("Pepe's sync can't grant owner: held, the answer keeps the site's role (Pepe's copy goes back), the owners get a notice", async () => {
  T += 1000;
  const r = await bot({ newowner: ["owner", T], plainadmin: ["staff", T] });
  assert.equal(r.held, 1);
  assert.equal(await SR.roleOf("newowner"), null, "not an owner on the site");
  assert.equal(r.roles.newowner, undefined, "the merged answer has no such role - Pepe drops his local grant");
  assert.equal(await SR.roleOf("plainadmin"), "staff", "the non-owner change in the same sync goes through");
  assert.deepEqual(await pending(), [{ login: "newowner", role: "owner", ts: T, was: null }]);
  const notes = await getQuery("SELECT user_id, title, link FROM inbox WHERE title LIKE '%Owner change%' ORDER BY user_id");
  assert.deepEqual(notes.map((n) => n.user_id), ["own", "own2"], "every owner's linked account");
  assert.equal(notes[0].link, "/admin/roles#pending");
  // Pepe adopts the answer and re-sends the site's version: nothing new is held, no second notice
  const again = await bot({ newowner: [null, 0] });
  assert.equal(again.held, 0);
  // he sends the same grant again (an older ts than the one held): not a new pending, no new notice
  await bot({ newowner: ["owner", T] });
  assert.equal((await pending()).length, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE title LIKE '%Owner change%'"))[0].n, 2);
});

test("...nor remove or demote one", async () => {
  T += 1000;
  const r = await bot({ second_owner: ["admin", T] });
  assert.equal(r.held, 1);
  assert.equal(await SR.roleOf("second_owner"), "owner");
  assert.deepEqual(r.roles.second_owner[0], "owner", "the answer keeps the site's owner");
  T += 1000;
  await bot({ bossfrog: [null, T] });
  assert.equal(await SR.roleOf("bossfrog"), "owner", "a tombstone for an owner is held too");
  assert.deepEqual((await pending()).map((p) => [p.login, p.role, p.was]), [["bossfrog", null, "owner"], ["newowner", "owner", null], ["second_owner", "admin", "owner"]]);
});

test("only an existing owner confirms - with the password step-up; a Pepe admin (Admin class) can't", async () => {
  // a Pepe ADMIN with the Admin class (made one by Pepe's sync - not an owner change, so it goes through): no nonce, no decision
  T += 1000;
  await bot({ norole_cf: ["admin", T] });
  assert.equal(await SR.roleOf("norole_cf"), "admin");
  assert.equal((await getQuery("SELECT class FROM users WHERE userId = 'adm3'"))[0].class, "Admin");
  assert.equal((await post("/api/admin/roles/nonce", "adm3")).status, 403);
  const no = await post("/api/admin/roles/pending", "adm3", { login: "newowner", action: "confirm", password: "pw-ok", nonce: "x" });
  assert.equal(no.status, 403);
  assert.equal(no.j.code, "owner_only");
  // the owner: a nonce, then the password
  let n = await nonce("own");
  assert.ok(n);
  const bad = await post("/api/admin/roles/pending", "own", { login: "newowner", action: "confirm", nonce: n, password: "nope" });
  assert.equal(bad.status, 403);
  assert.equal(bad.j.code, "password");
  const reused = await post("/api/admin/roles/pending", "own", { login: "newowner", action: "confirm", nonce: n, password: "pw-ok" });
  assert.equal(reused.status, 409, "the nonce is single use");
  assert.equal(await SR.roleOf("newowner"), null, "still nothing");
  // cross-site / not a fetch: refused before anything
  const xs = await fetch(base + "/api/admin/roles/pending", { method: "POST", headers: { "x-user": "own", "content-type": "application/json", origin: "https://evil.example" },
                                                             body: JSON.stringify({ login: "newowner", action: "confirm" }) });
  assert.equal(xs.status, 403);
  n = await nonce("own");
  T += 1000;
  const ok = await post("/api/admin/roles/pending", "own", { login: "newowner", action: "confirm", nonce: n, password: "pw-ok" });
  assert.equal(ok.status, 200, JSON.stringify(ok.j));
  assert.equal(ok.j.confirmed, true);
  assert.equal(await SR.roleOf("newowner"), "owner");
  assert.ok(!(await pending()).some((p) => p.login === "newowner"));
  const sync = await bot({});
  assert.deepEqual(sync.roles.newowner, ["owner", T], "it reaches Pepe on his next sync (newer than both copies)");
  const audit = await getQuery("SELECT admin_name, action, detail FROM admin_audit WHERE action LIKE 'pepe_role_pending%'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].admin_name, "boss");
  assert.deepEqual(JSON.parse(audit[0].detail), { login: "newowner", from: null, to: "owner" });
});

test("reject keeps the site's role; a confirm that would leave no owner is refused; a web change clears what waits", async () => {
  let n = await nonce("own");
  const rej = await post("/api/admin/roles/pending", "own", { login: "second_owner", action: "reject", nonce: n, password: "pw-ok" });
  assert.equal(rej.status, 200, JSON.stringify(rej.j));
  assert.equal(rej.j.rejected, true);
  assert.equal(await SR.roleOf("second_owner"), "owner");
  // the last-owner rule: with only bossfrog left as owner, confirming his removal is refused
  await runQuery("UPDATE pepe_roles SET role = 'admin' WHERE login IN ('second_owner', 'newowner')");
  n = await nonce("own");
  const last = await post("/api/admin/roles/pending", "own", { login: "bossfrog", action: "confirm", nonce: n, password: "pw-ok" });
  assert.equal(last.status, 409);
  assert.equal(await SR.roleOf("bossfrog"), "owner");
  // a web change by an owner decides that login - nothing waits for it any more
  await runQuery("UPDATE pepe_roles SET role = 'owner' WHERE login = 'second_owner'");
  T += 1000;
  await bot({ newowner: ["owner", T] });
  assert.ok((await pending()).some((p) => p.login === "newowner"));
  T += 1000;
  await SR.setRole("bossfrog", "newowner", "staff", "web:boss");
  assert.ok(!(await pending()).some((p) => p.login === "newowner"));
  // nothing waits -> 404
  n = await nonce("own");
  assert.equal((await post("/api/admin/roles/pending", "own", { login: "nobody_here", action: "confirm", nonce: n, password: "pw-ok" })).status, 404);
});

test("/admin/roles shows what waits, with the buttons for an owner only", async () => {
  T += 1000;
  await bot({ plainadmin: ["owner", T] });
  const own = await (await fetch(base + "/admin/roles", { headers: { "x-user": "own" } })).text();
  assert.match(own, /id="pending"/);
  assert.match(own, /data-pending-act="confirm" data-login="plainadmin"/);
  assert.match(own, /id="arPendPw"/);
  const adm = await (await fetch(base + "/admin/roles", { headers: { "x-user": "adm3" } })).text();   // a Pepe admin (Admin class)
  assert.match(adm, /id="pending"/, "an Admin sees what waits");
  assert.doesNotMatch(adm, /data-pending-act=/, "...but no buttons");
  const api = await (await fetch(base + "/api/admin/roles", { headers: { "x-user": "adm3" } })).json();
  assert.deepEqual(api.pending.map((p) => p.login), ["bossfrog", "plainadmin"]);
});
