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
const TS = { own: AT - 9000, tru: AT - 8000, lag: AT - 7000, tomb: AT - 6000 };
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
    assert.deepEqual(want, ["acct:2001", "acct:2002", "acct:2003", "acct:2006", "acct:2007", "acct:2008", "acct:2009", "acct:2012"]);
    const page = await HO.snapshot(T, null);
    assert.equal(page.complete, true);
    assert.deepEqual(page.rows.map((r) => r.entity), want, "every holder once: 2006-2009 are in both the class and the role list");
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
