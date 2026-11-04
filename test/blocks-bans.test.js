// 1.99?? padppl: 🚫 Block from the person menu / profile / settings (blocks.js) and the website's bans from the person menu (padbans.js).
//
// Blocks - ONE block (the DM block, dm_blocks) wherever it is made; + login blocks (an unlinked Camfrog login) and frog-name blocks:
//   - the ref is exactly what was clicked (personref.js): a Camfrog login -> its LINKED account, a 🌐 row -> that PATV username (the
//     tricon case: the two never mix), a web line's account key, a veiled roster entry / line -> the hidden person, never said
//   - effects of a NAMED block: tips refused (tips.transferPat: every tip path - words that never say a block exists), web !duel / !brawl /
//     !tip refused. A FROG-NAME block (review fix, THE VEIL RULE) acts only on what they do under a frog name (their frog-named @mentions
//     don't alert the blocker) - never their named DMs / tips / people list - and NOTHING changes in what the blocker sees
//   - the same answer whoever is behind a frog name (an account, an unlinked login, nobody); "That's you" only to yourself
//   - a login block becomes a named block when the login links; the settings list shows frog names by label only
// Bans - on the exact identity, into the existing stores; a veil ban is its own row (a named re-ban never overwrites it), refuses only
//   their website bridge and only while they are under a frog name (review fix: never mainstage.isBanned / postRefusal - no visible
//   effect, no active test), lists as "🐸 label · identity hidden"; a named ban on someone of higher rank is refused;
//   who may: bridge = owner / staff / a room mod with kick, pad = owner / staff, site = staff; a login with no account waits in
//   pad_login_bans and lands on the account when it links
//   node --test test/blocks-bans.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "blocks-bans-")));
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const B = require(path.join(repo, "blocks"));
const PB = require(path.join(repo, "padbans"));
const BB = require(path.join(repo, "bridgeblocks"));
const V = require(path.join(repo, "veil"));

const ROOM = "drama_central";
const U = {};
let base, server, SLUG;
// a live room with a named member, a veiled member (incognito, an account behind it), a veil over an unlinked login, and a veiled line
const LR = { id: ROOM, slug: "drama-central", members: [], mic: [], feed: [], mod: {} };
function veiled(alias, id, login) { const e = { anon: true, display: "someone", veil: "incognito", alias, id }; V.hide(e, "_vz", { login, display: login, kind: "incognito" }); return e; }

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER, xp INTEGER DEFAULT 0)`);
  const mk = async (key, id, name, cf, cls = "pleb") => {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 100000)", [id, name, name, cf, cls]);
    U[key] = { userId: id, username: name, class: cls, camfrogUsername: cf };
  };
  await mk("owner", "own-0001", "padowner", "foamy1111");
  await mk("alice", "ali-0001", "alicep", "alicecf");
  await mk("bob", "bob-0001", "bobweb", null);
  await mk("real", "real-0001", "TriconOG", "tricon");
  await mk("har", "har-0001", "tricon", "trlcon");
  await mk("sneak", "snk-0001", "sneaky", "sneakcf");          // the person behind the frog name
  await mk("mod", "mod-0001", "modder", "modlogin");
  await mk("staff", "stf-0001", "staffer", "staffcf", "Staff");
  await rooms.init();
  await rooms.setOwner(ROOM, "foamy1111", "test");
  SLUG = (await rooms.get(ROOM)).slug || ROOM;
  LR.slug = SLUG;
  LR.members = [{ login: "alicecf", display: "Alice" }, veiled("Soggy Bullfrog", "v-soggy000001", "sneakcf"), veiled("Muddy Toad", "v-muddy0000001", "nolinkcf")];
  const line = { k: "msg", c: 501, ts: Date.now(), u: { anon: true, display: "someone", veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001" }, text: "hello" };
  V.hide(line, "_vz", { login: "sneakcf", display: "sneakcf", kind: "incognito" });
  LR.feed = [line];
  // (review fix: a veiled line resolves ONLY through bridge.revealLookup - its forget-me / take-down / identity-row rules; this fixture's
  // room isn't in bridge.js, so its lookup answers for LR's line the way the live room's would)
  const BR = require(path.join(repo, "bridge")), realReveal = BR.revealLookup;
  BR.revealLookup = async (rid, c) => { const it = LR.feed.find((x) => Number(x.c) === Number(c)); return rid === ROOM && it && it._vz && !it.rm_at ? { ts: it.ts, vz: it._vz } : realReveal(rid, c); };
  LR.mod = { modlogin: { actions: ["kick", "ban"], on: true, roles: ["moderator"] } };
  await BB.init(); await B.init(); await PB.init();
  await require(path.join(repo, "feedstore")).init();
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  const bySlug = (s) => (s === SLUG ? LR : null);
  B.register(app, { addUser, bySlug });
  PB.register(app, { addUser, bySlug });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
test.beforeEach(() => { B._reset(); PB._reset(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u } : {});
// (the DM block's own 500 ms burst rule - messages.js - is real; the tests block faster than a person clicks)
const post = (p, u, body) => { try { require(path.join(repo, "messages"))._gaps.clear(); } catch (e) { /* not loaded yet */ }
  return fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() })); };
const get = (p, u) => fetch(base + p, { headers: H(u) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const dm = async (a, b) => !!(await getQuery("SELECT 1 FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?", [a, b]))[0];

test("blocks: a Camfrog login blocks its LINKED account, a 🌐 row's PATV name blocks that account - the tricon pair never mix", async () => {
  let r = await post("/api/blocks", "alice", { ref: { k: "login", v: "tricon" }, on: true });
  assert.equal(r.status, 200); assert.equal(r.d.blocked, true); assert.equal((r.d.user || {}).username, "TriconOG", JSON.stringify(r.d));
  assert.ok(await dm("ali-0001", "real-0001")); assert.ok(!(await dm("ali-0001", "har-0001")));
  r = await post("/api/blocks", "alice", { ref: { k: "user", v: "tricon" }, on: true });
  assert.equal(r.d.user.username, "tricon"); assert.ok(await dm("ali-0001", "har-0001"));
  // the page's own list: logins + usernames she blocked, never "who blocked her"
  assert.deepEqual(await B.pageList("ali-0001"), { l: ["tricon", "trlcon"], u: ["tricon", "triconog"] });
  assert.equal(await B.pageList("real-0001"), null, "the blocked person's page learns nothing");
  r = await post("/api/blocks", "alice", { ref: { k: "user", v: "tricon" }, on: false });
  assert.equal(r.d.blocked, false); assert.ok(!(await dm("ali-0001", "har-0001")));
  await post("/api/blocks", "alice", { ref: { k: "login", v: "tricon" }, on: false });
  // yourself / bad refs
  r = await post("/api/blocks", "alice", { ref: { k: "login", v: "alicecf" }, on: true });
  assert.equal(r.status, 400);
  assert.equal((await post("/api/blocks", "alice", { ref: { k: "user", v: "<script>" } })).status, 404);
  assert.equal((await post("/api/blocks", null, { ref: { k: "user", v: "bobweb" } })).status, 401);
  // JSON + X-Requested-With + same site
  const bad = await fetch(base + "/api/blocks", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "alice" }, body: "{}" });
  assert.equal(bad.status, 400);
});

test("blocks: the effects - tips refused (both ways), web !duel / !tip refused, the DM refusal; Unblock restores them", async () => {
  await post("/api/blocks", "bob", { ref: { k: "login", v: "alicecf" }, on: true });
  const tips = require(path.join(repo, "tips"));
  const t1 = await tips.transferPat("alicep", "bobweb", 10);
  assert.equal(t1.ok, false); assert.equal(t1.status, 403); assert.equal(t1.msg, "That tip didn't go through.", "never says a block exists (Pepe says it in the room)");
  const t2 = await tips.transferPat("bobweb", "alicep", 10);
  assert.equal(t2.ok, false, "either way");
  const relay = require(path.join(repo, "bridge-relay"));
  assert.equal(await relay.challengeBlocked({ userId: "ali-0001" }, "!duel", "!duel bobweb 100"), null, "no Camfrog login: nothing for Pepe to aim at");
  await runQuery("UPDATE users SET camfrogUsername = 'bobcf' WHERE userId = 'bob-0001'");
  assert.equal(await relay.challengeBlocked({ userId: "ali-0001" }, "!duel", "!duel bobcf 100"), "You can't challenge bobcf.");
  assert.equal(await relay.challengeBlocked({ userId: "ali-0001" }, "!tip", "!tip bobcf 100"), "You can't tip bobcf.");
  assert.equal(await relay.challengeBlocked({ userId: "ali-0001" }, "!roast", "!roast bobcf"), null, "not a person-to-person command");
  await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = 'bob-0001'");
  await post("/api/blocks", "bob", { ref: { k: "login", v: "alicecf" }, on: false });
  assert.equal(await B.towards("ali-0001", "bob-0001"), false);
});

test("blocks on a frog name: the account behind it, never said; the same answer for an account, an unlinked login and a line; no Unblock in the menu", async () => {
  const a = await post("/api/blocks", "alice", { ref: { k: "veil", id: "v-soggy000001" }, slug: SLUG, on: true });
  const b = await post("/api/blocks", "alice", { ref: { k: "veil", id: "v-muddy0000001" }, slug: SLUG, on: true });
  const c = await post("/api/blocks", "alice", { ref: { k: "line", c: 501 }, slug: SLUG, on: true });
  for (const [x, label] of [[a, "Soggy Bullfrog"], [b, "Muddy Toad"], [c, "Soggy Bullfrog"]]) {
    assert.equal(x.status, 200);
    assert.deepEqual(Object.keys(x.d).sort(), ["blocked", "label", "ok", "veil"], "the same shape whoever is behind it");
    assert.equal(x.d.label, label);
    assert.doesNotMatch(JSON.stringify(x.d), /sneak|nolink|snk-/);
  }
  // stored by the hidden person, effective ONLY on what they do under a frog name (THE VEIL RULE, review fix): their frog-named @mentions
  assert.equal(await B.towards("snk-0001", "ali-0001", { veiled: true }), true, "a frog-named line of theirs doesn't alert alice");
  assert.equal(await B.towards("snk-0001", "ali-0001"), false, "never their NAMED actions - alice can't test a suspect with a DM / tip / mention");
  assert.equal(await B.hiddenTowards("snk-0001", "ali-0001"), false);
  assert.equal(await B.towards("ali-0001", "snk-0001"), false, "THE VEIL RULE: a frog-name block never changes the blocker's own actions");
  assert.equal(await B.towards("ali-0001", "snk-0001", { veiled: true }), false);
  const M = require(path.join(repo, "messages"));
  await M.init();
  assert.equal(await M.refusal(await M.account("snk-0001"), await M.account("ali-0001")), null, "a named DM is not refused by a frog-name block");
  assert.ok(!(await B.loginBlockersOf("snk-0001")).has("ali-0001"), "and sneaky's people list is unchanged");
  // ...but NOTHING changes for alice: her own page list never names a veil, nor does the menu ever offer Unblock on one
  assert.equal(await B.pageList("ali-0001"), null);
  // the settings list: labels, pads and days only
  const L = await get("/api/blocks", "alice");
  assert.equal(L.d.veils.length, 3);
  assert.doesNotMatch(JSON.stringify(L.d), /sneak|nolink|snk-|blocked_id|blocked_login/);
  // a login that links later: the veil learns the account
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('nol-0001', 'nolinker', 'nolinker', 'x', 'nolinkcf')");
  await B.linked("nol-0001", "nolinkcf");
  assert.equal(await B.towards("nol-0001", "ali-0001", { veiled: true }), true);
  // yourself
  const me = await post("/api/blocks", "sneak", { ref: { k: "veil", id: "v-soggy000001" }, slug: SLUG, on: true });
  assert.equal(me.status, 400); assert.equal(me.d.error, "That's you.");
  // unblock one from the settings list
  for (const v of L.d.veils) await post("/api/blocks", "alice", { ref: { k: "vb", id: v.id }, on: false });
  assert.equal(await B.towards("snk-0001", "ali-0001", { veiled: true }), false);
});

test("blocks on an unlinked Camfrog login become a named block when that login links an account", async () => {
  const r = await post("/api/blocks", "alice", { ref: { k: "login", v: "laterlinker" }, on: true });
  assert.equal(r.d.login, "laterlinker");
  await runQuery("INSERT INTO users (userId, username, displayname, password) VALUES ('lat-0001', 'later', 'later', 'x')");
  await runQuery("UPDATE users SET camfrogUsername = 'laterlinker' WHERE userId = 'lat-0001'");
  await B.linked("lat-0001", "laterlinker");
  assert.ok(await dm("ali-0001", "lat-0001"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM login_blocks WHERE login = 'laterlinker'"))[0].n, 0);
});

test("the person menu (room-mod.js): Block / Unblock, the ban items for web moderators only, never on a veil's Unblock", () => {
  const win = { __t: null };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8"), { window: win });
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-ban-sheet.js"), "utf8"), { window: win, document: {} });
  const MI = (...a) => JSON.parse(JSON.stringify(win.PATVRoom._modMenuItems(...a)));
  const ids = (xs) => xs.map((x) => x.id);
  const alice = { login: "alicecf", display: "Alice", patv: { username: "alicep" } };
  const wmod = { bridge: true, pad: true, site: false };
  assert.deepEqual(ids(MI(null, alice, { signed: true })), ["profile", "block"]);
  // (review fix: ONE "⛔ Website ban…" - the sheet picks where - and ONE "↩️ Lift website ban…", never four look-alikes beside 🔨 Ban…)
  assert.deepEqual(ids(MI(null, alice, { signed: true, wmod, slug: "p" })), ["profile", "block", "ban"]);
  assert.deepEqual(ids(MI(null, Object.assign({ wban: { b: -1, p: 0 } }, alice), { signed: true, wmod, slug: "p" })), ["profile", "block", "ban", "lift"]);
  assert.deepEqual(MI(null, alice, { signed: true, wmod, slug: "p" }).find((x) => x.id === "ban").ref, { k: "login", v: "alicecf" }, "the exact login");
  // a 🌐 web row: by its PATV username; a web line: by its account key
  assert.deepEqual(MI(null, { web: true, display: "tricon", patv: { username: "tricon" } }, { signed: true }).find((x) => x.id === "block").ref, { k: "user", v: "tricon" });
  assert.deepEqual(MI(null, { login: "u:har-0001", acct: true, web: true, display: "tricon", patv: { username: "tricon" } }, { signed: true }).find((x) => x.id === "block").ref, { k: "acct", v: "u:har-0001" });
  // a veil: Block + bans, by its id; never a Lift (no wban on veils)
  const v = MI(null, { anon: true, veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001", wban: { b: -1 } }, { signed: true, wmod, slug: "p" });
  assert.deepEqual(ids(v), ["block", "ban"]);
  assert.ok(v.every((x) => x.veil === true));
  // never Pepe, bots or yourself
  assert.deepEqual(MI(null, { login: "pepe", self: true }, { signed: true, wmod, slug: "p" }), []);
  assert.ok(!ids(MI(null, { login: "botcf", bot: true }, { signed: true, wmod, slug: "p" })).some((x) => /block|ban/.test(x)));
  assert.deepEqual(ids(MI(null, alice, { signed: true, wmod, slug: "p", meName: "alicep" })), ["profile"], "your own row: no Block, no bans");
});

test("bans from the person menu: the EXACT identity, into the existing stores; who may; the sheet's identity kind", async () => {
  // the preview names the kind - and never a veil's identity
  let pv = await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "user", v: "tricon" } });
  assert.equal(pv.status, 200);
  assert.deepEqual(pv.d.who, { kind: "account", title: "PATV account @tricon", sub: "Camfrog login trlcon" });
  pv = await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "login", v: "tricon" } });
  assert.deepEqual(pv.d.who, { kind: "login", title: "Camfrog login tricon", sub: "PATV account @TriconOG" });
  pv = await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "login", v: "nobodyhere" } });
  assert.deepEqual(pv.d.who, { kind: "login", title: "Camfrog login nobodyhere", sub: "not on PATV (applies if it links an account)" });
  pv = await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "veil", id: "v-soggy000001" } });
  assert.deepEqual(pv.d.who, { kind: "veil", title: "The person behind 🐸 Soggy Bullfrog", sub: "identity hidden from you" });
  assert.doesNotMatch(JSON.stringify(pv.d), /sneak/);
  assert.deepEqual(pv.d.scopes, ["bridge"], "a frog name: this pad's website chat (\"pad\" is the same thing for a veil)");
  pv = await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "user", v: "tricon" } });
  assert.deepEqual(pv.d.scopes, ["bridge", "pad"], "the owner: bridge + pad, not site");
  // a pad ban on the harasser's 🌐 row: feed_bans + an 'all' bridge block, both on har-0001 only
  let r = await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "pad", dur: "1d", reason: "harassment" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(await BB.active(ROOM, "har-0001"));
  assert.ok((await getQuery("SELECT 1 FROM feed_bans WHERE user_id = 'har-0001' AND room_id = ?", [ROOM]))[0]);
  assert.equal(await BB.active(ROOM, "real-0001"), null, "the real Tricon is untouched");
  assert.equal(await require(path.join(repo, "mainstage")).isBanned("har-0001", ROOM), true, "no stage booking in the pad either");
  // lift it from the menu
  r = await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "pad" });
  assert.equal(r.status, 200);
  assert.equal(await BB.active(ROOM, "har-0001"), null);
  // who may: a room mod with kick may block from the bridge, not ban from the pad; a plain member neither; site = staff
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "mod", { ref: { k: "user", v: "tricon" }, scope: "bridge", dur: "1h" })).status, 200);
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "mod", { ref: { k: "user", v: "tricon" }, scope: "pad", dur: "1h" })).status, 403);
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "alice", { ref: { k: "user", v: "tricon" }, scope: "bridge", dur: "1h" })).status, 403);
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "site", dur: "1h" })).status, 403);
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "pad", dur: "perm" })).status, 400, "permanent needs a reason");
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "padowner" }, scope: "bridge", dur: "1h" })).status, 400, "That's you");
  // rank (review fix): a pad owner can't ban PATV staff, a room mod can't ban the pad's owner or another room mod
  let rk = await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "staffer" }, scope: "bridge", dur: "1h" });
  assert.equal(rk.status, 403); assert.match(rk.d.error, /PATV staff/);
  rk = await post(`/api/rooms/${SLUG}/ban`, "mod", { ref: { k: "user", v: "padowner" }, scope: "bridge", dur: "1h" });
  assert.equal(rk.status, 403); assert.match(rk.d.error, /pad's owner/);
  LR.mod.alicecf = { actions: ["kick"], on: true };
  rk = await post(`/api/rooms/${SLUG}/ban`, "mod", { ref: { k: "login", v: "alicecf" }, scope: "bridge", dur: "1h" });
  assert.equal(rk.status, 403, "a fellow room mod"); delete LR.mod.alicecf;
  // a frog name's ban is never refused for rank - that answer would say who it is
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "mod", { ref: { k: "veil", id: "v-soggy000001" }, scope: "bridge", dur: "1h" })).status, 200);
  await runQuery("DELETE FROM veil_bans");
  await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "bridge" });
  // the audit names the real identity; the room event too (a named one)
  const au = await getQuery("SELECT action, target_id FROM admin_audit WHERE action IN ('pad_ban','pad_unban') ORDER BY at");
  assert.ok(au.some((x) => x.action === "pad_ban" && x.target_id === "har-0001"));
});

test("a veil ban: its own row, refusals only, no visible effect; a named re-ban never removes it; listed as identity hidden", async () => {
  let r = await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "veil", id: "v-soggy000001" }, scope: "pad", dur: "7d", reason: "spam" });
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.stringify(r.d), /sneak/);
  assert.equal(r.d.scope, "bridge", "stored as this pad's website chat");
  // THE VEIL RULE (review fix): under their OWN name nothing changes - their web bridge, posts, stage booking, a live stage stream and the
  // mic stage (mainstage.isBanned) - so a moderator can't watch who goes quiet, or ask a suspect to post, to learn who the frog is
  await require(path.join(repo, "incognito")).init();
  await runQuery(`DELETE FROM incognito_state`);
  PB._reset();
  assert.equal(await PB.veiledNow("snk-0001", "sneakcf"), false);
  assert.equal(await BB.active(ROOM, "snk-0001"), null, "named: not refused");
  const FS = require(path.join(repo, "feedstore"));
  assert.equal(await FS.postRefusal(Object.assign(await FS.account("snk-0001"), {}), [ROOM]), null, "a post is named: never refused by it");
  assert.equal(await require(path.join(repo, "mainstage")).isBanned("snk-0001", ROOM), false, "never the stage / mic-stage reader (it ends streams, takes tiles)");
  // under a frog name again (Incognito on): their website bridge here is refused, in words that never say it was a frog-name ban
  await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('sneakcf', 1, ?)`, [Date.now()]);
  const a = await BB.active(ROOM, "snk-0001");
  assert.ok(a && a.feature === "all");
  assert.match(BB.refusalText(a), /^A mod of this room blocked you from talking in it from the website until .* \(spam\)\.$/);
  assert.equal(await require(path.join(repo, "mainstage")).isBanned("snk-0001", ROOM), false, "still never the stage");
  await runQuery(`DELETE FROM incognito_state`);
  // no visible effect: nothing in feed_bans / bridge_blocks (the readers that hide posts, end stage slots, take tiles)
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_bans WHERE user_id = 'snk-0001'"))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_blocks WHERE user_id = 'snk-0001'"))[0].n, 0);
  // a named ban of the same person (a mod testing a suspect) adds a row - the 🐸 entry stays
  await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "login", v: "sneakcf" }, scope: "bridge", dur: "1h" });
  const L = await get(`/api/rooms/${SLUG}/bans`, "owner");
  const vrow = L.d.bans.find((x) => x.kind === "veil");
  assert.ok(vrow, "still listed");
  assert.equal(vrow.who, "🐸 Soggy Bullfrog · identity hidden");
  assert.doesNotMatch(JSON.stringify(vrow), /sneak|snk-/, "the pad's owner never sees who it is");
  // the room event names only the label; the audit the real identity
  const ev = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'pad-ban'", [ROOM]);
  assert.ok(ev.some((e) => /🐸 Soggy Bullfrog \(identity hidden\)/.test(e.detail)));
  assert.ok(!ev.some((e) => /sneak/.test(e.detail)));
  const au = await getQuery("SELECT target_id, detail FROM admin_audit WHERE action = 'pad_ban' AND detail LIKE '%veil%'");
  assert.ok(au.some((x) => x.target_id === "snk-0001"));
  // the live view never flags a veiled entry (wban is built by PATV username for NAMED entries only)
  const wb = await PB.wbanMap(ROOM);
  assert.ok(!wb.has("sneaky") || wb.get("sneaky").p === 0, "the veil ban isn't a pad flag");
  // lift it from the list
  r = await post(`/api/rooms/${SLUG}/unban`, "owner", { entry: vrow.entry });
  assert.equal(r.status, 200);
  assert.equal(await PB.veilActive(ROOM, "snk-0001"), null);
  await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "login", v: "sneakcf" }, scope: "bridge" });
});

test("a Camfrog login with no PATV account: pad_login_bans, the mic stage reads it, and it lands on the account when it links", async () => {
  const r = await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "login", v: "futurecf" }, scope: "pad", dur: "7d", reason: "x" });
  assert.equal(r.status, 200);
  assert.equal(r.d.who.kind, "login");
  assert.ok(await PB.loginActive(ROOM, "futurecf"));
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('fut-0001', 'future', 'future', 'x', 'futurecf')");
  await PB.linked("fut-0001", "futurecf");
  assert.ok(await BB.active(ROOM, "fut-0001"), "the bridge block is on the account now");
  assert.ok((await getQuery("SELECT 1 FROM feed_bans WHERE user_id = 'fut-0001' AND room_id = ?", [ROOM]))[0], "and the pad ban");
  assert.equal(await PB.loginActive(ROOM, "futurecf"), null, "the login row is gone");
});

// ── 1.99?? padppl review fixes ──
test("review: the merged list - a bridge-only mod sees bridge rows only, staff see site-wide frog-name / login bans, nobody gets a veil's identity; one row per pad ban; Lift by id", async () => {
  // a pad ban (its bridge block comes with it) + a site-wide frog-name ban by staff
  await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "pad", dur: "1d", reason: "owner's reason" });
  assert.equal((await post(`/api/rooms/${SLUG}/ban`, "staff", { ref: { k: "veil", id: "v-soggy000001" }, scope: "site", dur: "1d", reason: "x" })).status, 200);
  const own = await get(`/api/rooms/${SLUG}/bans`, "owner");
  const harRows = own.d.bans.filter((b) => b.userId === "har-0001");
  assert.deepEqual(harRows.map((b) => b.scope), ["pad"], "a pad ban and the bridge block made with it are ONE row");
  assert.ok(!own.d.bans.some((b) => b.site), "the owner doesn't see staff's site-wide rows");
  assert.ok(!own.d.bans.some((b) => "real" in b), "never the real identity, even for see-through holders");
  const mod = await get(`/api/rooms/${SLUG}/bans`, "mod");
  assert.ok(!mod.d.bans.some((b) => b.reason === "owner's reason"), "a bridge-only mod never sees the owner's pad ban and its reason");
  const st = await get(`/api/rooms/${SLUG}/bans`, "staff");
  const sv = st.d.bans.find((b) => b.kind === "veil" && b.site);
  assert.ok(sv, "staff see the site-wide frog-name ban here - and can lift it");
  assert.doesNotMatch(JSON.stringify(sv), /sneak|snk-/);
  assert.equal((await post(`/api/rooms/${SLUG}/unban`, "owner", { entry: sv.entry })).status, 403, "not the owner's to lift");
  assert.equal((await post(`/api/rooms/${SLUG}/unban`, "staff", { entry: sv.entry })).status, 200);
  // the live view's flags: by the account's CURRENT username (a rename keeps them); never an admin's global block
  await runQuery("UPDATE users SET username = 'tricon_renamed' WHERE userId = 'har-0001'");
  PB._reset();
  let wb = await PB.wbanMap(ROOM);
  assert.ok(wb.get("tricon_renamed") && wb.get("tricon_renamed").p, "still flagged after the rename");
  await BB.block({ roomId: "", target: { userId: "real-0001", username: "TriconOG" }, feature: "all", until: null, reason: "global", by: { userId: "adm", name: "boss", via: "admin" } });
  PB._reset(); wb = await PB.wbanMap(ROOM);
  assert.ok(!wb.has("triconog"), "an admin's site-wide block is no Lift the pad's menu can't do");
  await BB.unblock({ roomId: "", target: { userId: "real-0001", username: "TriconOG" }, feature: null, by: { name: "boss" } });
  // Lift by the account's id - the rename doesn't break it; lifting the pad ban lifts the bridge block made with it
  const row = (await get(`/api/rooms/${SLUG}/bans`, "owner")).d.bans.find((b) => b.userId === "har-0001");
  assert.equal(row.username, "tricon_renamed");
  assert.equal((await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "acct", v: "u:har-0001" }, scope: "pad" })).status, 200);
  assert.equal(await BB.active(ROOM, "har-0001"), null);
  await runQuery("UPDATE users SET username = 'tricon' WHERE userId = 'har-0001'");
  // the Lift sheet's preview says what is lifted (end, reason, who) - a bridge-only mod never gets a pad ban's reason
  await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "pad", dur: "7d", reason: "owner's reason" });
  let pv = await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "user", v: "tricon" } });
  assert.equal(pv.d.current.pad.reason, "owner's reason"); assert.equal(pv.d.current.bridge, null, "its own bridge block is part of the pad ban");
  pv = await post(`/api/rooms/${SLUG}/ban/preview`, "mod", { ref: { k: "user", v: "tricon" } });
  assert.equal(pv.d.current.pad, null);
  await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "acct", v: "u:har-0001" }, scope: "pad" });
  // the Camfrog-room note only for a login, and only for a viewer Pepe gives 🔨 Ban…
  assert.equal((await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "user", v: "tricon" } })).d.room, false, "a 🌐 web row: no Camfrog ban to point at");
});

test("review: a frog name's row / line only in a pad the viewer may see; account deletion keeps pepe_dm_jobs and covers the new tables", async () => {
  const PR = require(path.join(repo, "personref"));
  const PA = require(path.join(repo, "padaccess"));
  const real = PA.full;
  PA.full = () => false;                                   // a private pad this viewer can't see
  try {
    assert.equal(await PR.padOk({ k: "line", c: 501 }, U.alice, { id: ROOM }), false);
    const r = await post("/api/blocks", "alice", { ref: { k: "line", c: 501 }, slug: SLUG, on: true });
    assert.equal(r.status, 404); assert.equal(r.d.error, "That line isn't here any more.", "the same answer as a line that's gone");
    assert.equal((await post(`/api/rooms/${SLUG}/ban/preview`, "owner", { ref: { k: "veil", id: "v-soggy000001" } })).status, 404);
    assert.equal(await PR.padOk({ k: "login", v: "alicecf" }, U.alice, null), true, "named refs need no pad");
  } finally { PA.full = real; }
  const del = fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8");
  assert.match(del, /^\s*\["pepe_dm_jobs", "user_id", "uid"\],$/m, "pepe_dm_jobs is deleted again (it had been commented out)");
  for (const t of ["login_blocks", "veil_blocks", "mention_pad_mutes", "name_clash_ok", "net_seen", "veil_bans"]) assert.ok(del.includes('["' + t + '", "'), t);
  // the in-memory line resolves through bridge.revealLookup's rules only (never the raw _vz)
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "personref.js"), "utf8"), /let vz = it && it\._vz/);
});
