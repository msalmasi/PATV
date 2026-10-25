// D11-site-roles (the owner's answer of 2026-10-25: "the chat server should accept the site's Admin/Staff label - there should be
// no Camfrog dependency"; ADR 0007 D11 as changed then): the seam's roles/changed topic carries the SITE's role of an account,
// by account - its class (Admin / Staff / Assistant, the site's own ladder) or the Pepe role of its linked Camfrog login,
// whichever ranks higher - so a site Admin or Staff member with no linked login holds the hub's global role (and is inside every
// Approved pad on the hub, as on the site: padaccess.inside / pads.approved_inside).
//   * staffroles.globalRolesOf: every combination of class and linked role, exact class names only, owner and trusted only
//     from the role list, role_at only when the role list decides;
//   * hubroles.build: the unchanged payload shape for an Admin without a login;
//   * the triggers: a class change is a role change for any account; an account inserted or deleted with a role-giving class
//     posts, a plain one doesn't; never with the switch off;
//   * the snapshot: class-only role holders listed, each account once, in byte order, paged across both kinds.
// The review of the first build (the owner's "there should be no Camfrog dependency" applies to the site too):
//   * the class picker (staffroles.classUpdate) gives and takes Admin / Staff / Assistant on an account with no linked login,
//     on the site's ladder (only a Pepe owner touches Admin; Admins give and take Staff and Assistant), with no Camfrog words;
//   * an unlink or a !verify that moves the login away drops the class that login's role gave (the unlink trigger), through
//     the real routes (user.controller's unlink and verifyCamfrogLink); a class that wasn't the login's stays;
//   * the site's Banned and Bot classes hold no role, whatever the linked login's role; a tie keeps the role list's role_at.
//   node --test test/hubroles-site-class.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hubroles-site-class-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.HUB_V1_URL; delete process.env.HUB_V1_PROXY;
delete process.env.CHAT_GENESIS_NS;
process.env.HUB_V1_ENV = "test";
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";            // verifyCamfrogLink's bot token (botkeys.isBotToken)
const repo = path.resolve(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {                        // the real schema: a staging dump + every CREATE in the source
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const AT = 1760727590000;
const TS = { own: AT - 9000, tru: AT - 8000, lag: AT - 7000, tomb: AT - 6000, tie: AT - 5000, ban: AT - 4000, bot: AT - 3000 };
/** A hub account id per v1 user id (the tests' stand-in for chatticket.subjectOf). */
const acctOf = (id) => `0192a5b4-${String(id).padStart(4, "0").slice(-4)}-7c2d-8e3f-4a5b6c7d8e9f`;

let runQuery, getQuery, HO, HR, SR;
const T = "roles/changed";
const entitiesOf = async () => (await getQuery("SELECT entity FROM hub_outbox WHERE topic = ? ORDER BY id", [T])).map((r) => r.entity);
const clearOutbox = () => runQuery("DELETE FROM hub_outbox");
const step = async (label, sql, args, want) => {
  await clearOutbox();
  await runQuery(sql, args || []);
  assert.deepEqual(await entitiesOf(), want, label);
};

async function addUser(id, username, cls, login) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level) VALUES (?, ?, ?, 'x', ?, ?, 1)`,
                 [id, username, username, cls, login == null ? null : login]);
}

// the accounts: [userId, username, class, Camfrog login, the Pepe role of that login (row), what globalRolesOf answers]
const PEOPLE = [
  ["2001", "ann", "Admin", null, null, { role: "admin", role_at: null }],             // a site Admin who never linked Camfrog
  ["2002", "sam", "Staff", null, null, { role: "staff", role_at: null }],
  ["2003", "asa", "Assistant", null, null, { role: "assistant", role_at: null }],
  ["2004", "ple", "pleb", null, null, { role: null, role_at: null }],
  ["2005", "pip", "Bot", null, null, { role: null, role_at: null }],
  ["2006", "own", "Admin", "own_cf", ["owner", TS.own], { role: "owner", role_at: TS.own }],        // the role list ranks higher
  ["2007", "tru", "Staff", "tru_cf", ["trusted", TS.tru], { role: "staff", role_at: null }],        // the class ranks higher
  ["2008", "lag", "Assistant", "lag_cf", ["staff", TS.lag], { role: "staff", role_at: TS.lag }],    // a class lagging Pepe's sync
  ["2009", "tomb", "Admin", "tomb_cf", [null, TS.tomb], { role: "admin", role_at: null }],          // Pepe's tombstone, class kept
  ["2011", "low", "admin", null, null, { role: null, role_at: null }],               // exact class names only (as siteperms)
  ["2012", "blank", "Staff", "  ", null, { role: "staff", role_at: null }],           // a blank login is no link
  ["2013", "tie", "Staff", "tie_cf", ["staff", TS.tie], { role: "staff", role_at: TS.tie }],       // a tie: the role list's row
  ["2014", "ban", "Banned", "ban_cf", ["staff", TS.ban], { role: null, role_at: null }],            // the site's Banned: no role
  ["2015", "bot", "Bot", "bot_cf", ["admin", TS.bot], { role: null, role_at: null }],               // the site's Bot: no role
];

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  HO = require(path.join(repo, "huboutbox"));
  HR = require(path.join(repo, "hubroles"));
  SR = require(path.join(repo, "staffroles"));
  HO._setAccountOf((id) => (/^\d+$/.test(String(id)) ? acctOf(id) : null));
  HO._setClock(() => AT);
  await HO.init();
  const st = await HO.status();
  assert.equal(st.l1.ready, true, "release L1's topics are set up: " + st.l1.error);
  for (const [id, u, cls, login, row] of PEOPLE) {
    await addUser(id, u, cls, login);
    if (row) await runQuery("INSERT INTO pepe_roles (login, role, ts, by, via) VALUES (?, ?, ?, 'pepe', 'chat')", [login, row[0], row[1]]);
  }
  await clearOutbox();
});
test.after(() => { HO.stop(); });

test("globalRolesOf: the site class gives its role by account (no Camfrog login); the higher of class and Pepe role wins", async () => {
  const got = await SR.globalRolesOf(PEOPLE.map((p) => p[0]).concat(["2099"]));
  for (const [id, u, cls, login, , want] of PEOPLE) {
    const lg = login == null || !login.trim() ? null : login.trim().toLowerCase();
    assert.deepEqual(got.get(id), { login: lg, role: want.role, role_at: want.role_at, cls }, u);
  }
  assert.equal(got.has("2099"), false, "no users row: left out (gone)");
  // the class map is the site's ladder, exact names, no prototype keys
  assert.deepEqual(["Admin", "Staff", "Assistant", "pleb", "Bot", "Banned", "admin", "constructor", "__proto__", null].map(SR.roleOfClass),
                   ["admin", "staff", "assistant", null, null, null, null, null, null, null]);
  assert.deepEqual([...SR.NO_ROLE_CLASSES].sort(), ["Banned", "Bot"]);
  // no class ever gives "owner": the site's owners are its pinned list (pepe_roles, PO-0b)
  assert.ok(!Object.values(SR.ROLE_OF_CLASS).includes("owner"));
  assert.deepEqual(await SR.globalRoleOf("2001"), { login: null, role: "admin", role_at: null, cls: "Admin" });
});

test("build: an Admin with no linked login posts role admin - the roles/changed payload's shape is unchanged", async () => {
  const got = await HR.build(["acct:2001", "acct:2004", "acct:2006", "acct:2099"]);
  assert.deepEqual(got.get("acct:2001"), { account: acctOf("2001"), v1_user: "2001", role: "admin", cls: "Admin", role_at: null });
  assert.deepEqual(got.get("acct:2004"), { account: acctOf("2004"), v1_user: "2004", role: null, cls: "pleb", role_at: null },
                   "no role: the hub tombstones its row, if any");
  assert.deepEqual(got.get("acct:2006"), { account: acctOf("2006"), v1_user: "2006", role: "owner", cls: "Admin", role_at: TS.own });
  assert.deepEqual(got.get("acct:2099"), { account: acctOf("2099"), v1_user: "2099", gone: true });
});

test("triggers: a class change is a role change for any account; an account made or deleted with a role-giving class posts", async () => {
  await clearOutbox();
  await runQuery("UPDATE users SET class = 'Staff' WHERE userId = '2004'");
  assert.deepEqual(await entitiesOf(), [], "switch off: nothing");
  await runQuery("UPDATE users SET class = 'pleb' WHERE userId = '2004'");
  await HO.setSettings({ roles: true });
  try {
    await step("an unlinked account made Staff", "UPDATE users SET class = 'Staff' WHERE userId = '2004'", [], ["acct:2004"]);
    assert.equal((await HR.build(["acct:2004"])).get("acct:2004").role, "staff");
    await step("...and back to pleb (the hub tombstones the role)", "UPDATE users SET class = 'pleb' WHERE userId = '2004'", [], ["acct:2004"]);
    assert.equal((await HR.build(["acct:2004"])).get("acct:2004").role, null);
    await step("the same class again: nothing", "UPDATE users SET class = 'pleb' WHERE userId = '2004'", [], []);
    await step("an unlinked Admin demoted to Staff", "UPDATE users SET class = 'Staff' WHERE userId = '2001'", [], ["acct:2001"]);
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = '2001'");
    await step("an account created as Staff, no login (a script, an import)",
               "INSERT INTO users (userId, username, password, class) VALUES ('2020', 'nia', 'x', 'Staff')", [], ["acct:2020"]);
    await step("...deleted", "DELETE FROM users WHERE userId = '2020'", [], ["acct:2020"]);
    assert.deepEqual((await HR.build(["acct:2020"])).get("acct:2020"), { account: acctOf("2020"), v1_user: "2020", gone: true });
    await step("a plain sign-up without a login: nothing", "INSERT INTO users (userId, username, password, class) VALUES ('2021', 'oli', 'x', 'pleb')", [], []);
    await step("...deleted: nothing", "DELETE FROM users WHERE userId = '2021'", [], []);
    await step("a class no role comes from: nothing at insert", "INSERT INTO users (userId, username, password, class) VALUES ('2022', 'ray', 'x', 'VIP')", [], []);
    await step("...nor at delete", "DELETE FROM users WHERE userId = '2022'", [], []);
    await step("points, xp, level of a site Admin: never", "UPDATE users SET points_balance = points_balance + 5, xp = xp + 3, level = 9 WHERE userId = '2001'", [], []);
    await step("a sign-up with a linked login still posts (its Pepe role)",
               "INSERT INTO users (userId, username, password, class, camfrogUsername) VALUES ('2023', 'sue', 'x', 'pleb', 'sue_cf')", [], ["acct:2023"]);
    await step("...and its deletion", "DELETE FROM users WHERE userId = '2023'", [], ["acct:2023"]);
    await HO.setSettings({ roles: false });
    await step("off again", "UPDATE users SET class = 'Staff' WHERE userId = '2004'", [], []);
  } finally {
    await HO.setSettings({ roles: false });
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = '2004'");
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = '2001'");
    await runQuery("DELETE FROM users WHERE userId IN ('2020', '2021', '2022', '2023')");
    await clearOutbox();
  }
});

test("snapshot: the class-only role holders too, each account once, in byte order, paged across both kinds", async () => {
  assert.equal(await HO.snapshot(T, null), null, "404 while the switch is off");
  await HO.setSettings({ roles: true });
  try {
    const want = PEOPLE.filter((p) => p[5].role).map((p) => "acct:" + p[0]).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(want, ["acct:2001", "acct:2002", "acct:2003", "acct:2006", "acct:2007", "acct:2008", "acct:2009", "acct:2012", "acct:2013"]);
    const page = await HO.snapshot(T, null);
    assert.equal(page.complete, true);
    assert.deepEqual(page.rows.map((r) => r.entity), want,
                     "every holder once: 2006-2009 and 2013 are in both the class and the role list; Banned 2014 and Bot 2015 in neither");
    for (const r of page.rows) assert.deepEqual(r.payload, (await HR.build([r.entity])).get(r.entity), r.entity);
    // pages of 1 and 3: the cursor walks the merged list without a gap or a repeat
    for (const limit of [1, 3]) {
      const seen = [];
      let cursor = null;
      for (let i = 0; i < 20; i++) {
        const p = await HO.snapshot(T, cursor, { limit });
        seen.push(...p.rows.map((r) => r.entity));
        if (p.complete) break;
        cursor = p.next;
      }
      assert.deepEqual(seen, want, "limit " + limit);
    }
    // a site Admin demoted to pleb with no login leaves the snapshot (the hub's absent reset tombstones the row it holds)
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = '2001'");
    assert.ok(!(await HO.snapshot(T, null)).rows.some((r) => r.entity === "acct:2001"));
  } finally {
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = '2001'");
    await HO.setSettings({ roles: false });
    await clearOutbox();
  }
});

// ── the review of the first build: the site's own tools, with no Camfrog dependency ──
const clsOf = async (id) => ((await getQuery("SELECT class FROM users WHERE userId = ?", [id]))[0] || {}).class;
const roleNow = async (id) => { const g = await SR.globalRoleOf(id); return g ? g.role : undefined; };
const actorOf = (id, username, cls) => ({ userId: id, username, class: cls });
const audits = async () => (await getQuery("SELECT admin_name, target_name, detail FROM admin_audit WHERE action = 'class_direct' ORDER BY id"))
  .map((r) => [r.admin_name, r.target_name, JSON.parse(r.detail)]);
const refusedWith = (status, re) => (e) => {
  assert.equal(e.status, status, e.message);
  if (re) assert.match(e.message, re);
  assert.doesNotMatch(e.message, /camfrog/i, "no Camfrog words in the class picker's answer");
  return true;
};

test("the class picker on an account with no linked login: the site's ladder, no Camfrog link asked for (the review's grant AND removal)", async () => {
  // the actors: a Pepe owner (the Admin class + a linked login with the owner role), a site Admin who never linked Camfrog,
  // a Pepe admin (linked, not an owner), a Staff member; the targets: unlinked accounts
  await addUser("2101", "boss", "Admin", "boss_cf");
  await runQuery("INSERT INTO pepe_roles (login, role, ts, by, via) VALUES ('boss_cf', 'owner', ?, 'pepe', 'chat')", [AT]);
  await addUser("2102", "adm", "Admin", null);
  await addUser("2103", "padm", "Admin", "padm_cf");
  await runQuery("INSERT INTO pepe_roles (login, role, ts, by, via) VALUES ('padm_cf', 'admin', ?, 'pepe', 'chat')", [AT]);
  await addUser("2104", "stf", "Staff", null);
  for (const [id, u] of [["2110", "t1"], ["2111", "t2"], ["2112", "t3"]]) await addUser(id, u, "pleb", null);
  const boss = actorOf("2101", "boss", "Admin"), adm = actorOf("2102", "adm", "Admin"), padm = actorOf("2103", "padm", "Admin");
  try {
    // the owner gives Admin to an unlinked account - the hub role follows the class
    assert.deepEqual(await SR.classUpdate(boss, "t1", "Admin"), { message: "User class updated successfully.", login: null, role: "admin" });
    assert.equal(await clsOf("2110"), "Admin");
    assert.equal(await roleNow("2110"), "admin");
    // the review's repro: an owner demoting the unlinked Admin "ann" (2001) to Staff, then to pleb - both refused 409 before
    await SR.classUpdate(boss, "ann", "Staff");
    assert.equal(await clsOf("2001"), "Staff");
    assert.equal(await roleNow("2001"), "staff");
    await SR.classUpdate(boss, "ann", "pleb");
    assert.equal(await clsOf("2001"), "pleb");
    assert.equal(await roleNow("2001"), null, "the class-only role is gone: the hub tombstones it");
    await SR.classUpdate(boss, "ann", "Admin");
    assert.equal(await roleNow("2001"), "admin");

    // a site Admin with no Camfrog link at all gives and takes Staff / Assistant on accounts below Admin
    await SR.classUpdate(adm, "t2", "Staff");
    assert.equal(await roleNow("2111"), "staff");
    await SR.classUpdate(adm, "t2", "Assistant");
    assert.equal(await roleNow("2111"), "assistant");
    await SR.classUpdate(adm, "t2", "pleb");
    assert.equal(await clsOf("2111"), "pleb");
    assert.equal(await roleNow("2111"), null);
    await SR.classUpdate(adm, "stf", "pleb");
    assert.equal(await clsOf("2104"), "pleb", "an Admin takes Staff away from an unlinked Staff member");
    await SR.classUpdate(adm, "stf", "Staff");

    // only an owner touches Admin: not a site Admin, not a Pepe admin - giving it or taking it away
    await assert.rejects(SR.classUpdate(adm, "t3", "Admin"), refusedWith(403, /Only an owner gives or takes the Admin class/));
    await assert.rejects(SR.classUpdate(padm, "t3", "Admin"), refusedWith(403, /owner/));
    await assert.rejects(SR.classUpdate(adm, "ann", "Staff"), refusedWith(403, /owner/), "an Admin can't lower another Admin");
    await assert.rejects(SR.classUpdate(adm, "t1", "pleb"), refusedWith(403, /owner/));
    assert.equal(await clsOf("2112"), "pleb");
    assert.equal(await clsOf("2001"), "Admin");
    assert.equal(await clsOf("2110"), "Admin");
    // Staff never changes classes; a session whose class went stale is read fresh
    await assert.rejects(SR.classUpdate(actorOf("2104", "stf", "Staff"), "t3", "Assistant"), refusedWith(403));
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = '2102'");
    await assert.rejects(SR.classUpdate(adm, "t3", "Staff"), refusedWith(403), "the actor's class is read from the database");
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = '2102'");
    // the same class again changes nothing (and writes no audit row)
    const before = (await audits()).length;
    await SR.classUpdate(adm, "stf", "Staff");
    assert.equal((await audits()).length, before);
    // each direct change is in admin_audit: who, whom, from -> to
    assert.deepEqual((await audits()).slice(0, 3), [["boss", "t1", { from: "pleb", to: "Admin" }], ["boss", "ann", { from: "Admin", to: "Staff" }],
                                                    ["boss", "ann", { from: "Staff", to: "pleb" }]]);
    // a linked account still goes through Pepe's roles: the owner's Staff for it is a role-list row, and the class follows
    await addUser("2113", "lnk", "pleb", "lnk_cf");
    await SR.classUpdate(boss, "lnk", "Staff");
    assert.equal(await SR.roleOf("lnk_cf"), "staff");
    assert.equal(await clsOf("2113"), "Staff");

    // review 3: an Admin given directly, who then links a login the role list never had, keeps the class (the unlink
    // trigger leaves it) - and still only an owner takes it away: not a Pepe admin (setRole would see a login with no role),
    // not a site Admin (pleb skipped setRole outright and wrote the class)
    await addUser("2114", "dla", "pleb", null);
    await SR.classUpdate(boss, "dla", "Admin");
    await runQuery("UPDATE users SET camfrogUsername = 'dla_cf' WHERE userId = '2114'");
    assert.equal(await clsOf("2114"), "Admin");
    assert.equal(await roleNow("2114"), "admin");
    for (const [who, actor] of [["a Pepe admin", padm], ["a site Admin", adm]]) {
      for (const to of ["pleb", "Staff", "Assistant"]) {
        await assert.rejects(SR.classUpdate(actor, "dla", to), refusedWith(403, /Only an owner gives or takes the Admin class/), `${who} -> ${to}`);
      }
    }
    assert.equal(await clsOf("2114"), "Admin");
    assert.equal(await SR.roleOf("dla_cf"), null, "no role-list row was written by a refused change");
    await SR.classUpdate(boss, "dla", "Staff");                       // the owner can: a role-list row, the class follows
    assert.equal(await SR.roleOf("dla_cf"), "staff");
    assert.equal(await clsOf("2114"), "Staff");
    // ...and a Pepe admin keeps their !role rules below Admin on that linked account
    await SR.classUpdate(padm, "dla", "Assistant");
    assert.equal(await clsOf("2114"), "Assistant");
    // an Admin class the login's role backs is setRole's to guard, as before: a Pepe admin can't lower a Pepe admin
    await assert.rejects(SR.classUpdate(padm, "padm", "Staff"), (e) => e.status === 403);
    assert.equal(await clsOf("2103"), "Admin");
  } finally {
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = '2001'");
    await runQuery("DELETE FROM users WHERE userId IN ('2101', '2102', '2103', '2104', '2110', '2111', '2112', '2113', '2114')");
    await runQuery("DELETE FROM pepe_roles WHERE login IN ('boss_cf', 'padm_cf', 'lnk_cf', 'dla_cf')");
    await clearOutbox();
  }
});

test("an unlink or a moved login takes the class that login gave (the unlink trigger), through the real routes", async () => {
  const UC = require(path.join(repo, "user.controller"));
  const unlink = async (userId) => {
    let went = null;
    await UC.updateCamfrogUsername({ body: { camfrogUsername: "" }, user: { userId, username: "x" }, flash() {} }, { redirect(u) { went = u; } });
    assert.ok(went, "the unlink route answered");
  };
  let n = 0;
  const verify = async (userId, login) => {
    const code = "D11V" + String(++n).padStart(2, "0");
    await runQuery("INSERT INTO pending_camfrog_links (code, userId, camfrogUsername, expires_at) VALUES (?, ?, ?, ?)",
                   [code, userId, login, new Date(Date.now() + 600000).toISOString()]);
    let out = null;
    const res = { status() { return this; }, json(d) { out = d; return this; } };
    await UC.verifyCamfrogLink({ body: { code, camfrogUsername: login, password: "bot-token" } }, res);
    assert.equal(out && out.success, true, JSON.stringify(out));
    return out;
  };
  assert.equal((await getQuery("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?", [SR.UNLINK_TRIGGER])).length, 1, "installed");
  const owner = "boss2_cf";
  await runQuery("INSERT INTO pepe_roles (login, role, ts, by, via) VALUES (?, 'owner', ?, 'pepe', 'chat')", [owner, AT]);
  await HO.setSettings({ roles: true });
  try {
    // R4: a linked Staff member (Pepe's staff role; reconcile gives the class) unlinks - the class goes with the login, so a
    // later removal of the login's role can't miss them
    await addUser("2201", "r4", "pleb", "r4_cf");
    await SR.setRole(owner, "r4_cf", "staff", "test");
    assert.equal(await clsOf("2201"), "Staff");
    await clearOutbox();
    await unlink("2201");
    assert.equal(await clsOf("2201"), "pleb", "the unlink dropped the Staff class the login gave");
    assert.equal(await roleNow("2201"), null);
    assert.ok((await entitiesOf()).includes("acct:2201"), "the hub hears it");
    await SR.setRole(owner, "r4_cf", null, "test");
    await SR.reconcile(["r4_cf"]);
    assert.equal(await roleNow("2201"), null);

    // R2: !verify moves an Admin's login to another account ("camfrog:taken") - the old account keeps nothing, the new one
    // takes the login's role and, at once, its class
    await addUser("2202", "r2a", "pleb", "r2_cf");
    await SR.setRole(owner, "r2_cf", "admin", "test");
    assert.equal(await clsOf("2202"), "Admin");
    await addUser("2203", "r2b", "pleb", null);
    const out = await verify("2203", "r2_cf");
    assert.equal(out.unlinkedFrom, "r2a");
    assert.equal(await clsOf("2202"), "pleb");
    assert.equal(await roleNow("2202"), null, "the old account is no hub admin any more");
    assert.equal(await clsOf("2203"), "Admin", "the new account's class follows the login now (verifyCamfrogLink reconciles)");
    assert.equal(await roleNow("2203"), "admin");

    // a relink from one staff login to another: the class drops with the old login and comes back with the new one
    await addUser("2204", "rel", "pleb", "rel1_cf");
    await SR.setRole(owner, "rel1_cf", "staff", "test");
    await SR.setRole(owner, "rel2_cf", "staff", "test");
    assert.equal(await clsOf("2204"), "Staff");
    await verify("2204", "rel2_cf");
    assert.equal(await clsOf("2204"), "Staff");
    assert.equal(await roleNow("2204"), "staff");

    // a class that wasn't the login's stays: an unlinked account made Staff directly links a login the role list never had,
    // then unlinks it
    await addUser("2205", "dir", "Staff", null);
    await verify("2205", "dir_cf");
    assert.equal(await clsOf("2205"), "Staff");
    await unlink("2205");
    assert.equal(await clsOf("2205"), "Staff", "dir_cf gave nothing, so its unlink takes nothing");
    assert.equal(await roleNow("2205"), "staff");

    // the same login saved again in another case is no unlink; Bot / Banned are never touched (they aren't managed)
    await runQuery("UPDATE users SET camfrogUsername = 'REL2_CF ' WHERE userId = '2204'");
    assert.equal(await clsOf("2204"), "Staff");
    await addUser("2206", "bnd", "Banned", "bnd_cf");
    await SR.setRole(owner, "bnd_cf", "staff", "test");
    await unlink("2206");
    assert.equal(await clsOf("2206"), "Banned");
    // a login freed in SQL (a merge, the stale-account cleanup): the same trigger
    await addUser("2207", "mva", "pleb", "mv_cf");
    await SR.setRole(owner, "mv_cf", "assistant", "test");
    assert.equal(await clsOf("2207"), "Assistant");
    await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = '2207'");
    assert.equal(await clsOf("2207"), "pleb");
  } finally {
    await HO.setSettings({ roles: false });
    await runQuery("DELETE FROM users WHERE userId IN ('2201', '2202', '2203', '2204', '2205', '2206', '2207')");
    await runQuery("DELETE FROM pepe_roles WHERE login IN ('boss2_cf', 'r4_cf', 'r2_cf', 'rel1_cf', 'rel2_cf', 'bnd_cf', 'mv_cf')");
    await clearOutbox();
  }
});
