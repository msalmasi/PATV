// /admin/accounts (accountsadmin.js, 1.99wl): Admins only (Staff, members and signed-out visitors refused); the people search
// (long names, Camfrog logins); a member's sessions + deletion status; "Sign out everywhere", "Schedule deletion" and "Cancel
// deletion" each need a reason + the username typed, and are written to admin_audit; the pending list and the event feed.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctadmin-test-"));
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
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "auto_source TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

let runQuery, getQuery, S, server, base;
const LONG = "a_really_long_member_name_well_past_forty_chars";
const H = (u, extra = {}) => Object.assign({ "x-user": u || "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" }, extra);
const get = (p, u) => fetch(base + p, { redirect: "manual", headers: H(u) });
const post = (p, u, body) => fetch(base + p, { method: "POST", redirect: "manual", headers: H(u), body: JSON.stringify(body || {}) });
const audits = async (action) => getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id", [action]);

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  S = require(path.join(repo, "sessions"));
  await S.init();
  await require(path.join(repo, "accountdelete")).init();
  const mk = (id, name, cls, cf) => runQuery("INSERT INTO users (userId, username, email, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, id + "@example.com", cls || "pleb", cf || null]);
  await mk("adm", "boss", "Admin"); await mk("adm2", "boss2", "Admin"); await mk("stf", "staffer", "Staff");
  await mk("mem", LONG, "pleb", "longcf_login"); await mk("mod", "moddy", "pleb");
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('mod', 'Moderator')");
  await S.create({ get: (h) => (h === "user-agent" ? "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36" : "") }, "mem", "google");
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  S.register(app, { addUser });
  require(path.join(repo, "accountdelete")).register(app, { addUser });
  require(path.join(repo, "accountsadmin")).register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("admins only: Staff, members and signed-out visitors are refused everywhere", async () => {
  assert.equal((await get("/admin/accounts", "")).status, 302);
  assert.equal((await get("/admin/accounts", "stf")).status, 403);
  assert.equal((await get("/admin/accounts", "mem")).status, 403);
  for (const p of ["/api/admin/accounts/people?q=lon", "/api/admin/accounts/user?u=mem", "/api/admin/accounts/deletions", "/api/admin/accounts/events"]) {
    assert.equal((await get(p, "stf")).status, 403, p);
    assert.equal((await get(p, "")).status, 401, p);
  }
  assert.equal((await post("/api/admin/users/mem/sessions/revoke", "stf", { reason: "x", confirm: LONG })).status, 403);
  assert.equal((await post("/api/admin/users/mod/delete", "stf", { reason: "xyz", confirm: "moddy" })).status, 403);
  const page = await get("/admin/accounts", "adm");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Account security/);
  assert.match(html, /href="\/admin\/accounts"/, "in the admin nav");
});

test("the people search finds long names and Camfrog logins; the member view shows sessions and deletion status", async () => {
  const p = await (await get("/api/admin/accounts/people?q=" + encodeURIComponent("well_past"), "adm")).json();
  assert.equal(p.people[0].username, LONG);
  const c = await (await get("/api/admin/accounts/people?q=longcf", "adm")).json();
  assert.equal(c.people[0].camfrog, "longcf_login");
  const u = await (await get("/api/admin/accounts/user?u=LONGCF_LOGIN", "adm")).json();
  assert.equal(u.user.username, LONG);
  assert.equal(u.sessions.length, 1);
  assert.equal(u.sessions[0].device, "Chrome on Windows");
  assert.equal(u.sessions[0].method, "google");
  assert.equal(u.sessions[0].id.length, 12, "never the whole session id");
  assert.deepEqual(u.deletion, { state: "none" });
  assert.equal((await get("/api/admin/accounts/user?u=nobody", "adm")).status, 404);
});

test("sign out everywhere needs a reason and the username, and is audit-logged", async () => {
  let r = await post("/api/admin/users/mem/sessions/revoke", "adm", { reason: "compromised" });
  assert.equal((await r.json()).code, "E_CONFIRM");
  r = await post("/api/admin/users/mem/sessions/revoke", "adm", { confirm: LONG });
  assert.equal((await r.json()).code, "E_REASON");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'mem' AND revoked_at IS NULL"))[0].n, 1, "nothing happened yet");
  r = await post("/api/admin/users/mem/sessions/revoke", "adm", { confirm: LONG, reason: "compromised" });
  assert.equal((await r.json()).revoked, 1);
  const a = await audits("sessions.revoke_all");
  assert.equal(a.length, 1);
  assert.equal(a[0].target_id, "mem"); assert.equal(a[0].admin_id, "adm"); assert.equal(a[0].reason, "compromised");
  const ev = await (await get("/api/admin/accounts/events", "adm")).json();
  assert.ok(ev.events.some((e) => e.kind === "revoked" && e.user_id === "mem"));
  assert.ok(ev.events.some((e) => e.kind === "sessions.revoke_all" && e.username === LONG));
});

test("schedule / cancel a deletion (a staff account included): reason + confirm, audit-logged, never your own; the pending list", async () => {
  let r = await post("/api/admin/users/mod/delete", "adm", { reason: "asked us by email" });
  assert.equal((await r.json()).code, "E_CONFIRM");
  r = await post("/api/admin/users/mod/delete", "adm", { confirm: "moddy" });
  assert.equal((await r.json()).code, "E_REASON");
  r = await post("/api/admin/users/adm/delete", "adm", { confirm: "boss", reason: "me" });
  assert.equal((await r.json()).code, "E_SELF", "two-admin rule");
  r = await post("/api/admin/users/mod/delete", "adm", { confirm: "moddy", reason: "asked us by email" });
  assert.equal((await r.json()).ok, true);
  assert.equal((await audits("account.delete")).length, 1);
  const u = await (await get("/api/admin/accounts/user?u=moddy", "adm")).json();
  assert.equal(u.deletion.state, "scheduled");
  assert.ok(u.deletion.execute_at > Date.now() + 13 * 86400000);
  assert.deepEqual(u.deletion.blockers, []);
  const list = await (await get("/api/admin/accounts/deletions", "adm")).json();
  assert.deepEqual(list.rows.map((x) => [x.username, x.state]), [["moddy", "scheduled"]]);
  const html = await (await get("/admin/accounts", "adm2")).text();
  assert.match(html, /@moddy/);
  // cancel: reason + confirm, audited
  r = await post(`/api/admin/account-deletions/${u.deletion.id}/cancel`, "adm2", { reason: "changed their mind" });
  assert.equal((await r.json()).code, "E_CONFIRM");
  r = await post(`/api/admin/account-deletions/${u.deletion.id}/cancel`, "adm2", { reason: "changed their mind", confirm: "moddy" });
  assert.equal((await r.json()).ok, true);
  const c = await audits("account.delete_cancel");
  assert.equal(c.length, 1); assert.equal(c[0].admin_id, "adm2"); assert.equal(c[0].target_id, "mod");
  assert.equal((await (await get("/api/admin/accounts/user?u=moddy", "adm")).json()).deletion.state, "cancelled");
});

test("linked from /admin/users, the reported-users cards and the admin nav", () => {
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  assert.match(src("views/admin/users.ejs"), /href="\/admin\/accounts"/);
  assert.match(src("views/feedAdmin.ejs"), /\/admin\/accounts\?u=/);
  assert.match(src("views/partials/admin-nav.ejs"), /\['accounts', '\/admin\/accounts'/);
});
