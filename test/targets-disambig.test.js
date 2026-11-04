// 1.99ajn padppl: the "tricon" name collision (owner, 2026-11-04) - the regression, ported from the spec fixture.
//
// Someone made a PATV account whose USERNAME is a Camfrog user's login ("tricon") to harass him; the owner's `!bridge block tricon`
// landed on the REAL Tricon. Now:
//   - every typed moderation name goes through targets.js: a bare name that means two people is a 409 with the choices (Pepe's room
//     reply prints the error text), cf:<login> / @name / 🌐name / u:<id> are exact
//   - bridge blocks (Pepe, the owner page, admins) and feed / pad bans (feedstore.ban) agree on who a name is
//   - the impersonation guard (cfnames.js): a new account or a rename can't take a Camfrog login Pepe has seen unless it is that
//     account's own linked login; the OAuth username picker skips such names; existing clashes are listed for admins; the pad shows a
//     linked login's clashing display name as the login, and a web account's as "not the Camfrog user"
//   node --test test/targets-disambig.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "targets-disambig-")));
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const BB = require(path.join(repo, "bridgeblocks"));
const rooms = require(path.join(repo, "rooms"));
const T = require(path.join(repo, "targets"));
const CF = require(path.join(repo, "cfnames"));
const guard = require(path.join(repo, "middleware", "authGuard"));

const ROOM = "drama_central";
let base, server;
const U = {};
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  const mk = async (key, id, name, disp, cf, cls = "pleb") => {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, disp, cf, cls]);
    U[key] = { userId: id, username: name, class: cls, camfrogUsername: cf };
  };
  await mk("real", "real-0001", "TriconOG", "Tricon", "tricon");          // the real Camfrog user, linked
  await mk("har", "har-0001", "tricon", "tricon", "trlcon");              // the harasser (case A: linked to an alt login)
  await mk("har2", "har-0002", "tricon2", "tricon", null);                // a second harasser account (case B: no login)
  await mk("owner", "own-0001", "padowner", "padowner", "foamy1111");
  await mk("staff", "stf-0001", "staffer", "staffer", "staffcf", "Staff");
  await mk("plain", "pln-0001", "alice", "Alice", "alicecf");
  await runQuery("CREATE TABLE IF NOT EXISTS camfrog_userstats (login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
  await runQuery("INSERT INTO camfrog_userstats (login, data, updated) VALUES ('neverlinked', '{}', 1)");   // a Camfrog user who never linked
  await rooms.init();
  await rooms.setOwner(ROOM, "foamy1111", "test");
  await BB.init();
  CF._reset();
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  BB.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: () => null });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

const bot = (body) => fetch(base + "/api/bridge/blocks", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify(Object.assign({ password: "bot-token", room: ROOM, by: "foamy1111", reason: "harassment" }, body)) }).then(async (r) => ({ status: r.status, d: await r.json() }));

test("1. Pepe's `!bridge block tricon` no longer guesses: 409 'two people' with the choices, nobody blocked", async () => {
  const r = await bot({ op: "block", target: "tricon" });
  assert.equal(r.status, 409);
  assert.equal(r.d.code, "ambiguous");
  assert.match(r.d.error, /^'tricon' is two people: Camfrog login tricon \(PATV @TriconOG\) and the PATV account 🌐tricon\. Say cf:tricon or 🌐tricon\.$/);
  assert.ok(r.d.error.length <= 200, "fits Pepe's room reply");
  assert.deepEqual(r.d.choices.map((c) => c.ref), ["cf:tricon", "🌐tricon"]);
  assert.equal(await BB.active(ROOM, "real-0001"), null, "the victim is NOT blocked");
  assert.equal(await BB.active(ROOM, "har-0001"), null);
});

test("2. the explicit forms are exact: 🌐tricon / @tricon = the PATV account, cf:tricon = the Camfrog login's account", async () => {
  const a = await bot({ op: "block", target: "🌐tricon", key: "k1" });
  assert.equal(a.status, 200); assert.equal(a.d.target.userId, "har-0001");
  assert.ok(await BB.active(ROOM, "har-0001"), "the harasser is blocked");
  assert.equal(await BB.active(ROOM, "real-0001"), null, "the real Tricon isn't");
  assert.equal((await T.resolve("@tricon")).userId, "har-0001");
  assert.equal((await T.resolve("cf:tricon")).userId, "real-0001");
  assert.equal((await T.resolve("u:real-0001")).userId, "real-0001");
  await bot({ op: "unblock", target: "🌐tricon" });
});

test("3. every resolver agrees: bridge blocks and feed / pad bans give the same 409 for a bare 'tricon'", async () => {
  const bb = await BB.resolveTarget("tricon");
  assert.equal(bb.ambiguous, true);
  const FS = require(path.join(repo, "feedstore"));
  await FS.init();
  await assert.rejects(FS.ban(U.owner, "tricon", { room: ROOM, days: 1 }), (e) => e.status === 409 && Array.isArray(e.choices) && e.choices.length === 2);
  const ok = await FS.ban(U.owner, "cf:tricon", { room: ROOM, days: 1 });
  assert.equal(ok.userId, "real-0001", "cf:<login> bans the login's account");
  await FS.unban(U.owner, "real-0001", ROOM);
  // one identity reachable both ways is ONE person (a username equal to its own linked login)
  await runQuery("UPDATE users SET username = 'alicecf' WHERE userId = 'pln-0001'");
  assert.equal((await T.resolve("alicecf")).userId, "pln-0001");
  await runQuery("UPDATE users SET username = 'alice' WHERE userId = 'pln-0001'");
  // the audit has the unban now (it had none)
  const a = await getQuery("SELECT action FROM admin_audit WHERE action IN ('pad_ban', 'pad_unban') ORDER BY at");
  assert.deepEqual(a.map((x) => x.action), ["pad_ban", "pad_unban"]);
});

test("4. the name guard: a new account or a rename can't take a Camfrog login Pepe has seen - unless it's their own linked login", async () => {
  assert.equal(guard.checkUsername("tricon"), null, "the charset rule alone still allows it");
  assert.match(await CF.nameRefusal("tricon", null), /belongs to a Camfrog user/, "a linked login");
  assert.match(await CF.nameRefusal("NeverLinked", null), /belongs to a Camfrog user/, "a login Pepe has seen that nobody linked");
  assert.equal(await CF.nameRefusal("tricon", "real-0001"), null, "the real Tricon may take his own login as a username");
  assert.equal(await CF.nameRefusal("brandnewname", null), null);
  assert.equal(await CF.nameRefusal("CFauto123", null), null, "CF auto accounts are exempt");
  // the OAuth picker moves to the next free candidate
  const UC = require(path.join(repo, "user.controller"));
  const picked = await UC.generateUniqueUsername("NeverLinked");
  assert.notEqual(picked.toLowerCase(), "neverlinked");
  assert.match(picked, /^neverlinked\d+$/i);
});

test("5. existing clashes: listed for admins; the pad shows a clashing linked display name as the login and tags a web account", async () => {
  await CF.rebuild();
  const list = await CF.clashes();
  const ids = list.map((x) => x.userId).sort();
  assert.deepEqual(ids, ["har-0001", "har-0002"], "both harasser accounts - never the real Tricon");
  const h1 = list.find((x) => x.userId === "har-0001");
  assert.equal(h1.login, "tricon"); assert.equal(h1.loginOwner, "TriconOG"); assert.equal(h1.by, "username");
  // bridge.withPatv: the harasser's lines from his alt login 'trlcon' would show his PATV display name 'tricon' - now the login
  const B = require(path.join(repo, "bridge"));
  const C = await B.resolveNames([{ login: "trlcon" }, { login: "tricon" }, { login: "u:har-0002" }]);
  assert.equal(B.withPatv({ login: "trlcon", display: "trlcon" }, C).display, "trlcon", "never shown as 'tricon'");
  assert.equal(B.withPatv({ login: "tricon", display: "tricon" }, C).display, "Tricon", "the real one keeps his PATV display name");
  const w = B.withPatv({ login: "u:har-0002", display: "tricon2", acct: true, web: true }, C);
  assert.equal(w.clash, "tricon", "a web account named like a Camfrog user carries the tag");
  // an admin marks one OK (same person who hasn't linked yet): no tag, no list entry
  await CF.markOk({ userId: "adm", username: "boss" }, "har-0002", "tricon");
  assert.ok(!(await CF.clashes()).some((x) => x.userId === "har-0002"));
});

test("6. the chat line renderer draws the tag with its explanation (textContent-safe)", () => {
  const CR = require(path.join(repo, "public", "js", "chatlog-core"));
  const html = String(CR.renderItem({ k: "msg", c: 1, ts: Date.now(), text: "hi", u: { login: "u:har-0001", display: "tricon", web: true, acct: true, clash: "tricon", patv: { username: "tricon" } } }, {}, CR.htmlH));
  assert.match(html, /<span class="clash-tag" title="This is a PATV web account\. It is not the Camfrog user called tricon\.">not the Camfrog user<\/span>/);
});

test("7. review: look-alikes of a seen login are refused / tagged too ('Тricon', 'tric0n', 'tricon_'); never against the account's own login; Mark OK by username reaches pad lines", async () => {
  await CF.rebuild();
  for (const n of ["tric0n", "tricon_", "TRICON.", "neverIinked"]) assert.match(await CF.nameRefusal(n, null), /belongs to a Camfrog user/, n);
  assert.equal(await CF.nameRefusal("Tricon_", "real-0001"), null, "the real Tricon's own login, dressed up, is still his");
  assert.equal(await CF.nameRefusal("triconfan", null), null, "a different name passes");
  assert.equal(CF.clashOf("x-1", "\u0422ricon", "\u0422ricon", null), "tricon", "a Cyrillic capital Te passes for T");
  assert.equal(CF.clashOf("real-0001", "TriconOG", "Tricon", "tricon"), null, "the real Tricon is never tagged");
  // an admin's Mark OK reaches a linked account's display name on pad lines too (bridge.withPatv knows the username, not the id)
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('fan-0001', 'tricon_fan', 'tric0n', 'x', 'triconfancf')");
  await CF.rebuild();
  assert.equal(CF.clashOf(null, "tricon_fan", "tric0n", "triconfancf", { onlyShown: true }), "tricon");
  await CF.markOk({ userId: "adm", username: "boss" }, "fan-0001", "tricon");
  assert.equal(CF.clashOf(null, "tricon_fan", "tric0n", "triconfancf", { onlyShown: true }), null, "marked OK: no tag on the pad either");
});

test("8. verify: a legacy pair of usernames that differ only in case - a person-menu ref lands on the exact spelling it carried", async () => {
  const PR = require(path.join(repo, "personref"));
  await runQuery("INSERT INTO users (userId, username, displayname, password) VALUES ('cas-0001', 'CaseyQ', 'Casey', 'x'), ('cas-0002', 'caseyq', 'casey', 'x')");
  assert.equal((await PR.resolve({ k: "user", v: "caseyq" })).userId, "cas-0002");
  assert.equal((await PR.resolve({ k: "user", v: "CaseyQ" })).userId, "cas-0001");
  assert.equal((await PR.accountByUsername("CASEYQ")).userId.startsWith("cas-000"), true, "no exact spelling: still one of them, as before");
});
