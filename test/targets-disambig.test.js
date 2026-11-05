// 1.99ajn padppl: the "tricon" name collision (owner, 2026-11-04) - the regression, ported from the spec fixture.
//
// Someone made a PATV account whose USERNAME is a Camfrog user's login ("tricon") to harass him; the owner's `!bridge block tricon`
// landed on the REAL Tricon. Now:
//   - every typed moderation name goes through targets.js: a bare name that means two people is a 409 with the choices (Pepe's room
//     reply prints the error text), cf:<login> / @name / 🌐name / u:<id> are exact
//   - bridge blocks (Pepe, the owner page, admins) and feed / pad bans (feedstore.ban) agree on who a name is
//   - the Camfrog-name tag (cfnames.js). 1.99ajw padppl rework (owner: "Wouldn't this prevent people legit creating a PATV account with
//     their own username? ... I don't like this part."): NOBODY is refused a name Pepe has seen on Camfrog - sign-up, rename, Pepe's
//     rename, the OAuth / SSO username pickers all take it; a gentle hint follows ("Is <name> your Camfrog name? Link it in Settings so
//     people know it's you." - the same words whether or not someone else has that login linked). Existing clashes are listed for admins;
//     the pad SHOWS a clashing name as it is - a web account's and (rework) a linked login's display name alike. dock3 (owner 2026-11-05:
//     "we don't need to flair users with 'not the Camfrog user', it's just confusing") 1.99??: no tag on any viewer-facing surface - the
//     neutral markers (🌐, the login tooltip, the @ list's second line, the block sheet's who line) tell two same-named people apart
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

test("4. rework: nobody is refused a name Pepe has seen on Camfrog - a gentle hint instead, the same words whoever has that login", async () => {
  assert.equal(guard.checkUsername("tricon"), null, "the charset rule alone allows it");
  assert.equal(CF.nameRefusal, undefined, "the sign-up / rename guard is gone (owner: \"I don't like this part\")");
  const HINT = (n) => `Is ${n} your Camfrog name? Link it in Settings so people know it's you.`;
  // the SAME words for a login someone else has linked (tricon -> TriconOG) and for one nobody linked - it says nothing about who has it
  assert.equal(await CF.nameHint("tricon", null), HINT("tricon"));
  assert.equal(await CF.nameHint("NeverLinked", null), HINT("NeverLinked"));
  assert.equal(await CF.nameHint("tricon", "har-0001"), HINT("tricon"), "the harasser's account (linked to trlcon): the same hint, never 'taken'");
  assert.equal(await CF.nameHint("tricon", "real-0001"), null, "his own linked login: nothing to link");
  assert.equal(await CF.nameHint("brandnewname", null), null, "a name Pepe never saw: no hint");
  assert.equal(await CF.nameHint("CFauto123", null), null, "CF auto accounts are the login itself");
  assert.equal(await CF.nameHint("tric0n", null), null, "only an exact login - a look-alike gets the tag on the pad, not a hint");
  // 1.99ajw padppl verify: a login Pepe only ever saw behind VEILED lines (chat_log_veil) never answers the hint - typing it as a new
  // name can't confirm that an incognito / hidden person was there. A named chat line (chat_log.who) still does.
  await runQuery("CREATE TABLE IF NOT EXISTS chat_log (c INTEGER PRIMARY KEY, rk INTEGER NOT NULL, ts INTEGER NOT NULL, k TEXT NOT NULL, who TEXT, text TEXT, rt TEXT NOT NULL, aud TEXT NOT NULL, d TEXT NOT NULL)");
  await runQuery("CREATE TABLE IF NOT EXISTS chat_log_veil (c INTEGER PRIMARY KEY, login TEXT NOT NULL, display TEXT, kind TEXT NOT NULL, words TEXT, at INTEGER)");
  await runQuery("INSERT INTO chat_log_veil (c, login, display, kind, at) VALUES (7001, 'onlyveiledcf', 'onlyveiledcf', 'incognito', 1)");
  await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (7002, 1, 1, 'chat', 'namedlinecf', 'hi', 'x', 'all', '{}')");
  assert.equal(await CF.seen("onlyveiledcf"), true, "the server still knows (moderation targets)");
  assert.equal(await CF.nameHint("onlyveiledcf", null), null, "only seen veiled: no hint");
  assert.equal(await CF.nameHint("namedlinecf", null), HINT("namedlinecf"), "seen on a named line: the hint");
  // translated when the page has the string
  const tr = Object.assign((k, v) => `T:${k}:${v.name}`, { has: (k) => k === "auth.hint.camfrog_name" });
  assert.equal(await CF.nameHint("tricon", null, { t: tr }), "T:auth.hint.camfrog_name:tricon");
  // hintAfter: a note for the next page (the welcome line's flash list), never an error, never blocking
  const fl = [];
  const req = { flash: (k, v) => fl.push([k, v]) };
  assert.equal(await CF.hintAfter(req, null, "NeverLinked"), HINT("NeverLinked"));
  assert.equal(await CF.hintAfter(req, null, "brandnewname"), null);
  assert.deepEqual(fl, [["success", HINT("NeverLinked")]]);
  assert.equal(await CF.hintAfter({}, null, "tricon"), HINT("tricon"), "no flash on the request: still no throw");
  // the OAuth / SSO username picker takes a seen login as it is (someone signing up with Twitch as their own Camfrog name)
  const UC = require(path.join(repo, "user.controller"));
  assert.equal(await UC.generateUniqueUsername("NeverLinked"), "NeverLinked");
  assert.match(await UC.generateUniqueUsername("tricon"), /^tricon\d+$/, "only another PATV account's username counts as taken");
  // every account-creating / renaming path: no refusal, the hint instead
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  for (const f of ["user.controller.js", "index.js", "plexsso.js", "ssolinks.js", "cfnames.js"]) assert.doesNotMatch(src(f), /nameRefusal\(/, f);
  const uc = src("user.controller.js");
  assert.match(uc, /req\.t\('auth\.welcome'[^\n]*\r?\n\s*await require\("\.\/cfnames"\)\.hintAfter\(req, userId, username\);/, "sign-up: the hint after the welcome line");
  assert.match(uc, /req\.flash\('success', 'Username changed\.'\);\r?\n\s*await require\('\.\/cfnames'\)\.hintAfter\(req, userId, username\);/, "rename");
  assert.match(uc, /const hint = await require\("\.\/cfnames"\)\.nameHint\(username, userId, req\);\r?\n\s*return \{ user: \{ userId, username, class: "pleb" \}, \.\.\.\(hint \? \{ hint \} : \{\}\) \};/, "SSO accounts hand it back");
  for (const f of ["plexsso.js", "ssolinks.js"]) assert.match(src(f), /if \(r\.hint\) req\.flash\("success", r\.hint\);/, f + ": after its welcome line");
  assert.equal((src("index.js").match(/require\("\.\/cfnames"\)\.hintAfter\(req, newUser\.userId, newUser\.username\);/g) || []).length, 2, "Twitch and Discord accounts");
  assert.doesNotMatch(src("index.js"), /that name belongs to another Camfrog user/, "Pepe's rename: no 409 for a seen name");
  // the admin rename tool (it exists to END a clash) still won't make a new one
  assert.match(await CF.adminNameRefusal("NeverLinked", "har-0002"), /Camfrog login Pepe has seen/);
  assert.equal(await CF.adminNameRefusal("tricon", "real-0001"), null, "his own login");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["auth.hint.camfrog_name"], "Is {name} your Camfrog name? Link it in Settings so people know it's you.");
});

test("5. existing clashes: listed for admins; the pad SHOWS a clashing name WITHOUT a tag (dock3) - a web account's and a linked login's display name", async () => {
  await CF.rebuild();
  const list = await CF.clashes();
  const ids = list.map((x) => x.userId).sort();
  assert.deepEqual(ids, ["har-0001", "har-0002"], "both harasser accounts - never the real Tricon");
  const h1 = list.find((x) => x.userId === "har-0001");
  assert.equal(h1.login, "tricon"); assert.equal(h1.loginOwner, "TriconOG"); assert.equal(h1.by, "username");
  const B = require(path.join(repo, "bridge"));
  const C = await B.resolveNames([{ login: "trlcon" }, { login: "tricon" }, { login: "u:har-0002" }]);
  // 1.99ajw rework: the harasser's lines from his alt login 'trlcon' show his PATV display name 'tricon' (it used to be the login); dock3: no tag
  const hl = B.withPatv({ login: "trlcon", display: "trlcon" }, C);
  assert.equal(hl.display, "tricon"); assert.equal(hl.clash, undefined, "shown, never tagged 'not the Camfrog user' (dock3)");
  assert.equal(hl.login, "trlcon", "the login stays (the name's tooltip - the neutral marker)");
  const rl = B.withPatv({ login: "tricon", display: "tricon" }, C);
  assert.equal(rl.display, "Tricon", "the real one keeps his PATV display name"); assert.equal(rl.clash, undefined, "and is never tagged");
  const w = B.withPatv({ login: "u:har-0002", display: "tricon2", acct: true, web: true }, C);
  assert.equal(w.clash, undefined, "a web account named like a Camfrog user carries no tag either (dock3)"); assert.equal(w.web, true, "its 🌐 marks it");
  // the owner's real case: PATV brocklee258, linked to login ritchiecuh, display name "brocklee258" - also a login Pepe has seen (maybe his
  // own alt, through a CF auto account) - shows as "brocklee258" (dock3: no tag), never as "ritchiecuh"
  await runQuery("INSERT INTO camfrog_userstats (login, data, updated) VALUES ('brocklee258', '{}', 1)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('brk-0001', 'brocklee258', 'brocklee258', 'x', 'ritchiecuh')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('cfa-0001', 'CFsa1p1bz8', 'brocklee258', 'x', 'brocklee258')");
  await CF.rebuild();
  const C2 = await B.resolveNames([{ login: "ritchiecuh" }, { login: "brocklee258" }]);
  const bk = B.withPatv({ login: "ritchiecuh", display: "ritchiecuh" }, C2);
  assert.equal(bk.display, "brocklee258"); assert.equal(bk.clash, undefined); assert.equal(bk.patv.username, "brocklee258"); assert.equal(bk.login, "ritchiecuh");
  assert.equal(B.withPatv({ login: "brocklee258", display: "brocklee258" }, C2).clash, undefined, "the Camfrog login itself is never tagged");
  // every list that names people through withPatv says the same: the people list / mic list entries, the person menu, the @ list
  assert.equal(B.withPatv({ login: "ritchiecuh", display: "ritchiecuh", on_mic: true }, C2).display, "brocklee258");
  // an admin's Mark OK (it is his own alt): off the admins' list - the name stays
  assert.ok((await CF.clashes()).some((x) => x.userId === "brk-0001"), "listed for admins");
  await CF.markOk({ userId: "adm", username: "boss" }, "brk-0001", "brocklee258");
  assert.ok(!(await CF.clashes()).some((x) => x.userId === "brk-0001"), "marked OK");
  assert.equal(B.withPatv({ login: "ritchiecuh", display: "ritchiecuh" }, C2).display, "brocklee258");
  // an admin marks one OK (same person who hasn't linked yet): no tag, no list entry
  await CF.markOk({ userId: "adm", username: "boss" }, "har-0002", "tricon");
  assert.ok(!(await CF.clashes()).some((x) => x.userId === "har-0002"));
  // dock3: no surface carries or draws the tag - the mic stage (micfollow viewFor, stage-mic.js), the web people (padweb), the @ lists, the
  // block sheet's who line, the stylesheet
  const src = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
  for (const f of [["micfollow.js"], ["padweb.js"], ["bridge.js"], ["public", "js", "stage-mic.js"], ["public", "js", "room-bridge.js"], ["public", "js", "home-dock.js"],
    ["public", "js", "room-mod.js"], ["public", "js", "chatlog-core.js"], ["public", "css", "person-sheet.css"], ["views", "room.ejs"]]) {
    assert.doesNotMatch(src(...f), /\.clash\b|clash:|clash-tag|clashTag|who-clash|js\.pad\.chat\.clash|kind_clash/, f.join("/") + ": no clash tag");
  }
});

test("6. dock3: the chat line renderer draws no tag - a web line keeps its 🌐, a linked login's line its login tooltip; the keys are gone", () => {
  const CR = require(path.join(repo, "public", "js", "chatlog-core"));
  // (an old payload that still carries `clash` draws nothing extra either)
  const html = String(CR.renderItem({ k: "msg", c: 1, ts: Date.now(), text: "hi", u: { login: "u:har-0001", display: "tricon", web: true, acct: true, clash: "tricon", patv: { username: "tricon" } } }, {}, CR.htmlH));
  assert.doesNotMatch(html, /clash|not the Camfrog user/);
  assert.match(html, /<span class="who-web"><a class="who"[^>]*>tricon<\/a><span class="web-mark" title="Sent from the website">/);
  const cf = String(CR.renderItem({ k: "msg", c: 2, ts: Date.now(), text: "yo", u: { login: "ritchiecuh", display: "brocklee258", clash: "brocklee258", patv: { username: "brocklee258" } } }, {}, CR.htmlH));
  assert.doesNotMatch(cf, /clash|not the Camfrog user/);
  assert.match(cf, /<a class="who"[^>]*title="ritchiecuh"/, "the login is still the name's tooltip");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["js.pad.chat.clash", "js.pad.chat.clash_title", "js.pad.chat.clash_title_cf", "js.block.kind_clash"]) assert.equal(en[k], undefined, k + " is gone");
  assert.ok(en["siteperm.k.accounts.name_clash"], "the admins' list stays");
});

test("7. review: look-alikes of a seen login are tagged ('Тricon', 'tric0n', 'tricon_'); never against the account's own login; Mark OK by username reaches pad lines", async () => {
  await CF.rebuild();
  for (const n of ["tric0n", "tricon_", "TRICON.", "neverIinked"]) assert.ok(CF.clashOf("x-2", n, n, null), n + " is tagged");
  for (const n of ["tric0n", "tricon_", "TRICON.", "neverIinked"]) assert.match(await CF.adminNameRefusal(n, null), /Camfrog login Pepe has seen/, n + ": the admin rename tool won't make a new clash");
  assert.equal(CF.clashOf("real-0001", "Tricon_", "Tricon_", "tricon"), null, "the real Tricon's own login, dressed up, is still his");
  assert.equal(CF.clashOf("x-3", "triconfan", "triconfan", null), null, "a different name passes");
  assert.equal(CF.clashOf("x-1", "Тricon", "Тricon", null), "tricon", "a Cyrillic capital Te passes for T");
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
