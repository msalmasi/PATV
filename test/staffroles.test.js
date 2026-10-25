// 1.99abn: Pepe's roles shared with the site (staffroles.js) - the sync with Pepe (newer change wins, tombstones, never
// without an owner), site classes following the roles for linked accounts, and the class editor (Admins only - Staff
// used to be able to set anyone's class, Admin included; Pepe's hierarchy for Admin / Staff / Assistant).
//   node --test test/staffroles.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "staffroles-test-")));
const { runQuery, getQuery } = require(path.join(__dirname, "..", "dbUtils"));
const R = require(path.join(__dirname, "..", "staffroles"));
let T = 1_800_000_000_000;
R._setClock(() => T);

const cls = async (u) => (await getQuery("SELECT class FROM users WHERE username = ?", [u]))[0].class;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, class TEXT NOT NULL DEFAULT 'pleb', camfrogUsername TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS classes (classId TEXT PRIMARY KEY, class TEXT NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  for (const [id, u, c, cf] of [["u1", "pb", "Admin", "Foamy1111"], ["u2", "alice", "pleb", "alice_cf"], ["u3", "bob", "pleb", null],
                                ["u4", "carol", "Staff", "carol_cf"], ["u5", "pepe", "Bot", "pepefrog"], ["u6", "dave", "pleb", "dave_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, class, camfrogUsername) VALUES (?, ?, ?, ?)", [id, u, c, cf]);
  }
  await R.init();
});

test("Pepe's first sync seeds the list; classes follow for linked accounts only, never Pepe's own", async () => {
  const r = await R.botSync({ roles: { foamy1111: ["owner", 0], alice_cf: ["staff", 0], pepefrog: ["admin", 0] } });
  assert.equal(r.ok, true);
  assert.equal(r.roles.foamy1111[0], "owner");
  assert.equal(await cls("pb"), "Admin");
  assert.equal(await cls("alice"), "Staff");
  assert.equal(await cls("pepe"), "Bot", "Pepe's own account keeps its class");
  assert.equal(await cls("carol"), "Staff", "a login the list never had is left alone");
  const names = (await getQuery("SELECT class FROM classes")).map((x) => x.class);
  assert.ok(names.includes("Assistant") && names.includes("Admin") && names.includes("Staff"), "the picker offers Assistant");
});

test("newer wins per login; a removal travels as a tombstone and drops the class; an older change is ignored", async () => {
  T += 1000;
  await R.botSync({ roles: { alice_cf: ["assistant", T] } });
  assert.equal(await cls("alice"), "Assistant");
  await R.botSync({ roles: { alice_cf: ["admin", T - 5000] } });
  assert.equal(await R.roleOf("alice_cf"), "assistant", "an older change loses");
  T += 1000;
  const r = await R.botSync({ roles: { alice_cf: [null, T] } });
  assert.equal(r.roles.alice_cf[0], null);
  assert.equal(await cls("alice"), "pleb");
  const r2 = await R.botSync({ roles: { foamy1111: [null, T + 1] } });
  assert.equal(r2.roles.foamy1111[0], "owner", "never a list without an owner");
  assert.equal(await cls("pb"), "Admin");
});

test("the class editor: Admins only, linked accounts for Pepe's classes, Pepe's hierarchy, the change reaches Pepe", async () => {
  const admin = { userId: "u1", username: "pb", class: "Admin" };
  const staff = { userId: "u4", username: "carol", class: "Staff" };
  await assert.rejects(R.classUpdate(staff, "dave", "Admin"), (e) => e.status === 403, "Staff can't change classes any more");
  // D11-site-roles (the owner's "no Camfrog dependency"): an account with no linked login takes Staff directly (the site's
  // ladder - pb is an owner), and loses it the same way; no Camfrog link is asked for
  assert.equal((await R.classUpdate(admin, "bob", "Staff")).role, "staff");
  assert.equal(await cls("bob"), "Staff");
  await R.classUpdate(admin, "bob", "pleb");
  assert.equal(await cls("bob"), "pleb");
  await assert.rejects(R.classUpdate(admin, "dave", "Wizard"), (e) => e.status === 400);
  await assert.rejects(R.classUpdate(admin, "pepe", "pleb"), (e) => e.status === 400 || e.status === 409);
  T += 1000;
  const r = await R.classUpdate(admin, "dave", "Assistant");          // pb is linked to an owner
  assert.equal(r.role, "assistant");
  assert.equal(await cls("dave"), "Assistant");
  const sync = await R.botSync({ roles: {} });
  assert.deepEqual(sync.roles.dave_cf, ["assistant", T], "Pepe gets it on his next sync");
  await R.classUpdate(admin, "dave", "pleb");
  assert.equal(await cls("dave"), "pleb");
  assert.equal(await R.roleOf("dave_cf"), null);
  // an admin (not owner) can't make admins
  T += 1000;
  await R.botSync({ roles: { carol_cf: ["admin", T] } });
  const carolAdmin = { userId: "u4", username: "carol", class: "Admin" };
  await assert.rejects(R.classUpdate(carolAdmin, "dave", "Admin"), (e) => e.status === 403);
  await R.classUpdate(carolAdmin, "dave", "Staff");
  assert.equal(await cls("dave"), "Staff");
  await assert.rejects(R.classUpdate(carolAdmin, "pb", "Staff"), (e) => e.status === 403, "an admin can't lower an owner");
});

test("the class list: Admins only; Pepe's classes can't be removed", async () => {
  const admin = { userId: "u1", username: "pb", class: "Admin" };
  await assert.rejects(R.classesEdit({ class: "Staff" }, "add", "VIP"), (e) => e.status === 403);
  assert.match((await R.classesEdit(admin, "add", "VIP")).message, /successfully/);
  await assert.rejects(R.classesEdit(admin, "remove", "Assistant"), (e) => e.status === 409);
  assert.match((await R.classesEdit(admin, "remove", "VIP")).message, /successfully/);
  await assert.rejects(R.classesEdit(admin, "add", "<b>x"), (e) => e.status === 400);
});
