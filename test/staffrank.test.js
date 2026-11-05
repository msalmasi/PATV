// rankrule (the owner, 2026-11-05: "Rank rule - refuse actions on equal or higher-ranked staff."): staffrank.js, the one rank rule.
//   - the ladder: Assistant 1 < Staff 2 < Admin 3 (siteperms-core classRank) and the site's owner (an Admin whose linked Camfrog login
//     holds Pepe's owner role on the site's list) 4; rows read fresh - a stale session class claims nothing
//   - the rule: refused when the target's rank is > 0 and >= the actor's (every actor x target); yourself and your own alt (the same
//     linked Camfrog login) are "self"; a lift is never refused for rank (only yourself); a member target: anyone the route lets act
//   - the words: one English string per refusal in locales/en.json, said in the request's language (req.t), a code for the page
//   - padbans.rankRefusal and the profile's Admin group (profilemod.eligible) use it: the owner may now act on an Admin there
//   TZ=UTC node --test test/staffrank.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staffrank-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffrank"));
const EN = require(path.join(repo, "locales", "en.json"));

const U = {};
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, archived_at INTEGER)`);
  const mk = async (key, id, name, cls = "pleb", cf = null) => {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, cf]);
    U[key] = { userId: id, username: name, class: cls, camfrogUsername: cf };
  };
  await mk("owner", "own-0001", "theowner", "Admin", "OwnerCF");
  await mk("owner2", "own-0002", "ownertwo", "Admin", "owner2cf");
  await mk("admin", "adm-0001", "adminone", "Admin", "admincf");
  await mk("admin2", "adm-0002", "admintwo", "Admin");
  await mk("staff", "stf-0001", "staffer", "Staff", "staffcf");
  await mk("staff2", "stf-0002", "stafftwo", "Staff");
  await mk("asst", "ast-0001", "helper", "Assistant");
  await mk("asst2", "ast-0002", "helpertwo", "Assistant");
  await mk("member", "mem-0001", "member", "pleb", "membercf");
  await mk("alt", "alt-0001", "stafferalt", "pleb", " StaffCF ");
  await mk("fake", "fak-0001", "notowner", "Staff", "fakeownercf");      // the owner role on a login, but not the Admin class
  await require(path.join(repo, "staffroles")).init();
  for (const [login, role] of [["ownercf", "owner"], ["owner2cf", "owner"], ["admincf", "admin"], ["fakeownercf", "owner"]]) {
    await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES (?, ?, 1)", [login, role]);
  }
});

test("the ladder: Assistant 1 < Staff 2 < Admin 3 < the owner 4 (the Admin class + a linked login with Pepe's owner role)", async () => {
  const rank = async (k) => SR.rankOf(await SR.rowOf(U[k].userId));
  assert.equal(await rank("member"), 0);
  assert.equal(await rank("asst"), 1);
  assert.equal(await rank("staff"), 2);
  assert.equal(await rank("admin"), 3, "Pepe's admin role is an Admin, not the owner");
  assert.equal(await rank("admin2"), 3);
  assert.equal(await rank("owner"), 4, "the login is matched trimmed and case-blind");
  assert.equal(await rank("owner2"), 4);
  assert.equal(await rank("fake"), 2, "the owner role on a Staff-class account gives nothing extra");
  assert.equal(SR.OWNER_RANK, 4);
  assert.equal(SR.RANK_ON_LIFTS, false, "the documented decision: lifts are not refused for rank");
});

test("every actor x target: refused when the target is staff of the actor's rank or above; yourself and your alt are 'self'", async () => {
  const actors = ["asst", "staff", "admin", "owner"];
  const targets = ["member", "asst2", "staff2", "admin2", "owner2"];
  const rankOf = { member: 0, asst: 1, asst2: 1, staff: 2, staff2: 2, admin: 3, admin2: 3, owner: 4, owner2: 4 };
  for (const a of actors) {
    for (const t of targets) {
      const want = rankOf[t] > 0 && rankOf[t] >= rankOf[a] ? "rank" : null;
      assert.equal(await SR.check(U[a], U[t].userId), want, `${a} -> ${t}`);
      // a lift: never refused for rank
      assert.equal(await SR.check(U[a], U[t].userId, { lift: true }), null, `${a} lifts ${t}`);
    }
    assert.equal(await SR.check(U[a], U[a].userId), "self", a + " -> themself");
    assert.equal(await SR.check(U[a], U[a].userId, { lift: true }), "self", a + " never lifts their own");
  }
  // your own alt: another account with the same linked Camfrog login (trimmed, case-blind)
  assert.equal(await SR.check(U.staff, U.alt.userId), "self");
  assert.equal(await SR.check(U.alt, U.staff.userId), "self");
  // self: false leaves the self check to the route (padbans has its own words); the rank check still runs
  assert.equal(await SR.check(U.staff, U.staff.userId, { self: false }), "rank");
  assert.equal(await SR.check(U.staff, U.alt.userId, { self: false }), null, "the alt is a member");
  // a member target: anyone (the route's own capability decides who may act at all)
  assert.equal(await SR.check(U.member, U.alt.userId), null);
  // an actor without an account row (a synthetic one): rank 0 - never on staff
  assert.equal(await SR.check({ userId: "nobody" }, U.asst.userId), "rank");
  assert.equal(await SR.check({ userId: "nobody" }, U.member.userId), null);
  // an unknown target: no answer here (the route says its own "no such account")
  assert.equal(await SR.check(U.admin, "no-such-id"), null);
  assert.equal(await SR.check(U.admin, ""), null);
});

test("the actor's class is read fresh: a session that still says Admin, or the owner, claims nothing once the row says otherwise", async () => {
  assert.equal(await SR.check(Object.assign({}, U.member, { class: "Admin" }), U.staff.userId), "rank", "a stale class claim");
  assert.equal(await SR.check({ userId: U.staff.userId, class: "Admin", camfrogUsername: "ownercf" }, U.admin.userId), "rank");
  await runQuery("UPDATE users SET class = 'Staff' WHERE userId = ?", [U.owner2.userId]);
  try {
    assert.equal(await SR.check(U.owner, U.owner2.userId), null, "a demoted owner is Staff now");
    assert.equal(await SR.check(U.owner2, U.admin.userId), "rank");
  } finally { await runQuery("UPDATE users SET class = 'Admin' WHERE userId = ?", [U.owner2.userId]); }
  // the roles list can't be read: nobody is the owner (no extra power from a failure)
  assert.equal(await SR.isOwner({ class: "Admin", camfrogUsername: "" }), false);
});

test("the words: one English string each in en.json, said in the request's language; the error carries status + code", async () => {
  assert.equal(EN["staffrank.refused"], "You can't do that to PATV staff of your rank or above.");
  assert.equal(EN["staffrank.self"], "That's you.");
  assert.equal(SR.TEXT.rank, EN["staffrank.refused"]);
  const e = new SR.StaffRankError("rank");
  assert.equal(e.status, 403); assert.equal(e.code, "staff_rank"); assert.equal(e.message, EN["staffrank.refused"]); assert.equal(e.refuse, true);
  const s = new SR.StaffRankError("self");
  assert.equal(s.status, 400); assert.equal(s.code, "self"); assert.equal(s.message, "That's you.");
  await assert.rejects(SR.assert(U.staff, U.admin.userId), (x) => x instanceof SR.StaffRankError && x.code === "staff_rank");
  await assert.doesNotReject(SR.assert(U.admin, U.staff.userId));
  // req.t (i18n.js) says it in the viewer's language; without one, English
  const req = { t: (k) => (k === "staffrank.refused" ? "Das darfst du bei PATV-Staff deines Rangs oder darüber nicht." : k) };
  assert.equal(SR.text(req, e), "Das darfst du bei PATV-Staff deines Rangs oder darüber nicht.");
  assert.equal(SR.text(null, e), EN["staffrank.refused"]);
  assert.equal(SR.msg({ req }, e), "Das darfst du bei PATV-Staff deines Rangs oder darüber nicht.", "a route's fail(res, e): res.req.t");
  const other = new Error("Something else."); other.status = 400;
  assert.equal(SR.msg({ req }, other), "Something else.", "any other refusal keeps its own words");
  // send(): the route's answer
  let sent = null;
  const res = { status(c) { sent = { c }; return this; }, json(b) { sent.b = b; return this; } };
  SR.send(req, res, "self");
  assert.deepEqual(sent, { c: 400, b: { ok: false, error: "staffrank.self", code: "self" } }, "(this req.t answers other keys with the key)");
});

test("padbans.rankRefusal says the shared words and lets the owner act on an Admin; profilemod.eligible follows the same rule", async () => {
  const rooms = require(path.join(repo, "rooms"));
  await rooms.init();
  const PB = require(path.join(repo, "padbans"));
  const R = { id: "Rank.Room" };
  const me = async (k) => (await SR.rowOf(U[k].userId));
  assert.equal(await PB.rankRefusal(await me("admin"), R, null, { userId: U.admin2.userId }), EN["staffrank.refused"]);
  assert.equal(await PB.rankRefusal(await me("staff"), R, null, { userId: U.admin.userId }), EN["staffrank.refused"]);
  assert.equal(await PB.rankRefusal(await me("owner"), R, null, { userId: U.admin.userId }), null, "the owner is above every Admin");
  assert.equal(await PB.rankRefusal(await me("owner"), R, null, { userId: U.owner2.userId }), EN["staffrank.refused"], "never on another owner");
  assert.equal(await PB.rankRefusal(await me("admin"), R, null, { userId: U.owner.userId }), EN["staffrank.refused"]);
  assert.equal(await PB.rankRefusal(await me("asst"), R, null, { userId: U.member.userId }), null);
  assert.equal(await PB.rankRefusal(await me("admin"), R, null, { veil: true, userId: U.admin2.userId }), null, "never for a frog name (that answer would say who)");
  const PM = require(path.join(repo, "profilemod"));
  const T = async (k) => ({ userId: U[k].userId, username: U[k].username, class: U[k].class });
  assert.ok(await PM.eligible(U.owner, await T("admin")), "the owner gets the Admin group on an Admin");
  assert.equal(await PM.eligible(U.admin, await T("owner")), null, "an Admin none on the owner");
  assert.equal(await PM.eligible(U.owner, await T("owner2")), null, "an owner none on another owner");
  assert.equal(await PM.eligible(U.admin, await T("admin2")), null);
  assert.ok(await PM.eligible(U.admin, await T("staff")));
  assert.equal(await PM.eligible(U.staff, await T("alt")), null, "your own alt");
  assert.ok(await PM.eligible(U.asst, await T("member")), "a member by any staff class (the items still need their keys)");
});
