// 1.99ajn padppl: 🚫 Block from the person menu / profile / settings (blocks.js) and the website's bans from the person menu (padbans.js).
//
// Blocks - ONE block (the DM block, dm_blocks) wherever it is made; + login blocks (an unlinked Camfrog login) and frog-name blocks:
//   - the ref is exactly what was clicked (personref.js): a Camfrog login -> its LINKED account, a 🌐 row -> that PATV username (the
//     tricon case: the two never mix), a web line's account key, a veiled roster entry / line -> the hidden person, never said
//   - effects of a NAMED block: tips refused (tips.transferPat: every tip path - words that never say a block exists), web !duel / !brawl /
//     !tip refused. A FROG-NAME block (review fix, THE VEIL RULE) acts only on what they do under a frog name - never their named DMs /
//     tips / people list. 1.99ajw padppl rework (owner: "blocking ANY frog name the person uses"): it hides their VEILED activity from the
//     blocker under any frog name, in any pad - their frog-named lines folded (vb), their frog-named @mentions silent, their web
//     challenges / tips and gifts while incognito refused / withheld - named activity untouched (no unmasking)
//   - the same answer whoever is behind a frog name (an account, an unlinked login, nobody); "That's you" only to yourself
//   - a login block becomes a named block when the login links; the settings list shows frog names by label only
// Bans - on the exact identity, into the existing stores; a veil ban is its own row (a named re-ban never overwrites it), refuses only
//   their website bridge and only while they are under a frog name (review fix: never mainstage.isBanned / postRefusal - no visible
//   effect, no active test). 1.99ajw rework: it is the person's INCOGNITO BAN in that pad - every frog name they use there, now and later,
//   "You can't post incognito on this pad right now." - listed as "🐸 label (identity hidden) - incognito ban"; a named ban on someone of
//   higher rank is refused;
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
  // banfix (owner 2026-11-05: "I can't ban user boogie ... says no such user"): the app is built the way index.js builds the site - its
  // global JSON parser, roomsweb.js's routes (index.js), THEN bridge.js's padbans routes. The pad settings page's stage room-ban form
  // (room-manage.js) owns the SAME paths, POST /api/rooms/:slug/ban + /unban, and answered every person-menu ban first.
  app.use(express.json());
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: () => false });
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
  // under a frog name again (Incognito on): their website bridge here is refused - 1.99ajw rework: an INCOGNITO ban, in plain words (no
  // moderator's reason, no end time)
  await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('sneakcf', 1, ?)`, [Date.now()]);
  const a = await BB.active(ROOM, "snk-0001");
  assert.ok(a && a.feature === "all" && a.incog === true);
  assert.equal(BB.refusalText(a), "You can't post incognito on this pad right now.");
  assert.equal(a.reason, "", "the moderator's reason never reaches them");
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
  assert.equal(vrow.who, "🐸 Soggy Bullfrog (identity hidden) - incognito ban");
  assert.equal(vrow.incog, 1);
  assert.doesNotMatch(JSON.stringify(vrow), /sneak|snk-/, "the pad's owner never sees who it is");
  // the room event names only the label; the audit the real identity
  const ev = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'pad-ban'", [ROOM]);
  assert.ok(ev.some((e) => /🐸 Soggy Bullfrog \(identity hidden\) - incognito ban until /.test(e.detail)));
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

// ── 1.99ajn padppl review fixes ──
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

// ── 1.99ajw padppl rework (owner 2026-11-04: "Maybe this could work by blocking ANY frog name the person uses (essentially blocking the person
// from using incognito in that pad), not just a particular frog name they used.") ──
const INCOG = "You can't post incognito on this pad right now.";
const incogOn = async (login) => { await runQuery(`INSERT OR REPLACE INTO incognito_state (login, "on", updated) VALUES (?, 1, ?)`, [login, Date.now()]); PB._reset(); };
const incogOff = async () => { await runQuery(`DELETE FROM incognito_state`); PB._reset(); };

test("rework: an INCOGNITO ban - the person behind the frog name can't post incognito in this pad under ANY frog name, now and later; named untouched; plain words; nobody learns who", async () => {
  await require(path.join(repo, "incognito")).init();
  await incogOff();
  await runQuery("DELETE FROM veil_bans");
  // the moderator's answers are the same for the person behind 🐸 Soggy Bullfrog (an account), 🐸 Muddy Toad (a login with no account) and
  // the moderator's OWN frog name (nothing is stored for that one - and it doesn't say so)
  LR.members.push(veiled("Damp Peeper", "v-damp00000001", "modlogin"));
  const ans = [];
  for (const id of ["v-soggy000001", "v-muddy0000001", "v-damp00000001"]) {
    const r = await post(`/api/rooms/${SLUG}/ban`, "mod", { ref: { k: "veil", id }, scope: "bridge", dur: "1d", reason: "harassing alice" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.doesNotMatch(JSON.stringify(r.d), /sneak|nolink|modlogin|snk-|mod-0001/, "never who it is");
    ans.push(r.d);
  }
  const shape = (d) => JSON.stringify({ keys: Object.keys(d).sort(), who: { kind: d.who.kind, sub: d.who.sub }, scope: d.scope, wk: Object.keys(d.who).sort() });
  assert.equal(shape(ans[0]), shape(ans[1])); assert.equal(shape(ans[0]), shape(ans[2]), "the moderator's own frog name: the same answer");
  assert.ok(ans.every((d) => d.until > Date.now() + 23 * 3600e3), "the same length");
  // the preview tells the moderator the plain words the person will see
  const pv = await post(`/api/rooms/${SLUG}/ban/preview`, "mod", { ref: { k: "veil", id: "v-soggy000001" } });
  assert.equal(pv.d.refusal.bridge, INCOG);
  // under their OWN name nothing changes
  assert.equal(await BB.active(ROOM, "snk-0001"), null, "named: untouched");
  // incognito again - and a NEW frog session with a NEW frog name (a harasser rotating frog names): still refused, in plain words
  await incogOn("sneakcf");
  LR.members.push(veiled("Leafy Newt", "v-leafy0000001", "sneakcf"));
  for (const f of ["chat", "commands", "clips", "snapshots", "voice", "livecams"]) {
    const why = await BB.refusal(ROOM, "snk-0001", f);
    assert.equal(why, INCOG, f);
  }
  assert.doesNotMatch(await BB.refusal(ROOM, "snk-0001", "chat"), /harassing|until|UTC|mod/, "no reason, no end, no moderator");
  // the website's say route refuses it with those words (bridge-relay: the !bridge block check runs first)
  const relay = require(path.join(repo, "bridge-relay"));
  const say = await relay.sayLine({ userId: "snk-0001", username: "sneaky", displayname: "sneaky", camfrogUsername: "sneakcf" }, LR, "hi again", "cid-rw-1");
  assert.equal(say.status, 403); assert.equal(say.body.error, INCOG); assert.equal(say.body.code, "blocked");
  // and later: another day, another frog name - the ban follows the PERSON (their account and their linked login)
  LR.members.push(veiled("Mossy Croaker", "v-mossy0000001", "sneakcf"));
  assert.equal(await BB.refusal(ROOM, "snk-0001", "chat"), INCOG);
  // only in THIS pad
  assert.equal(await BB.active("another_room", "snk-0001"), null, "another pad: untouched");
  // the person behind Muddy Toad (their login linked an account earlier in this file): by that account, every frog name of theirs
  await incogOn("nolinkcf");
  assert.equal(await BB.refusal(ROOM, "nol-0001", "chat"), INCOG);
  await incogOff();
  assert.equal(await BB.active(ROOM, "snk-0001"), null, "incognito off: they can post under their own name");
  // the pad's list: the frog name it was made on, "identity hidden", "incognito ban" - never who, never the moderator's own frog
  const L = await get(`/api/rooms/${SLUG}/bans`, "owner");
  const rows = L.d.bans.filter((x) => x.kind === "veil");
  assert.deepEqual(rows.map((x) => x.who).sort(), ["🐸 Muddy Toad (identity hidden) - incognito ban", "🐸 Soggy Bullfrog (identity hidden) - incognito ban"]);
  assert.ok(rows.every((x) => x.incog === 1 && x.reason === "harassing alice"), "the reason is for the pad's mods");
  assert.doesNotMatch(JSON.stringify(L.d), /sneak|nolink|snk-|nol-|Damp Peeper/);
  // the room event: the label and "incognito ban"; the audit: the real identity (admins only)
  const ev = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'pad-ban' AND detail LIKE '%incognito ban%'", [ROOM]);
  assert.ok(ev.some((e) => /^🐸 Soggy Bullfrog \(identity hidden\) - incognito ban until /.test(e.detail)));
  assert.ok(!ev.some((e) => /sneak|nolink/.test(e.detail)));
  const au = await getQuery("SELECT target_id, detail FROM admin_audit WHERE action = 'pad_ban' AND detail LIKE '%incognito%'");
  assert.ok(au.some((x) => x.target_id === "snk-0001"));
  // lift: by the list entry, as any website ban
  for (const r of rows) assert.equal((await post(`/api/rooms/${SLUG}/unban`, "owner", { entry: r.entry })).status, 200);
  await incogOn("sneakcf");
  assert.equal(await BB.active(ROOM, "snk-0001"), null, "lifted");
  await incogOff();
  LR.members = LR.members.filter((m) => !["v-damp00000001", "v-leafy0000001", "v-mossy0000001"].includes(m.id));
});

test("rework: a FROG-NAME block hides that person's veiled activity from the blocker - under ANY frog name, in any pad: folded lines, no @mention alert, no challenge / tip; named activity untouched", async () => {
  await runQuery("DELETE FROM veil_blocks"); B._reset();
  await incogOff();
  const r = await post("/api/blocks", "alice", { ref: { k: "veil", id: "v-soggy000001" }, slug: SLUG, on: true });
  assert.equal(r.status, 200);
  // server-side only: the keys behind the frog names she blocked; the blocked person's own view learns nothing
  const keys = await B.veilKeysOf("ali-0001");
  assert.ok(keys.has("sneakcf") && keys.has("u:snk-0001"));
  assert.ok(!keys.has("alicecf") && !keys.has("u:ali-0001"), "never her own keys");
  assert.equal((await B.veilKeysOf("snk-0001")).size, 0);
  const pl = await B.pageList("ali-0001");
  assert.ok(!pl || (!pl.l.includes("sneakcf") && !pl.u.includes("sneaky")), "the page's own (named) list never names the person behind a frog name");
  // lines: dress (the live feed, history and search all dress through it)
  const CL = require(path.join(repo, "chatlog")), CV = require(path.join(repo, "chatlogview"));
  await CL.init(); await CV.init(); await CL.noteSync({ list: [] });
  const T0 = Date.now();
  const frogLine = (c, alias, login, extra = {}) => {
    const it = Object.assign({ k: "msg", c, ts: T0 + c, u: { anon: true, display: "someone", veil: "incognito", alias, id: "v-line" + c }, text: "psst " + c, ah: CV.hashOf(login) }, extra);
    V.hide(it, "_vz", { login, display: login, kind: "incognito" });
    return it;
  };
  const items = [
    frogLine(9001, "Leafy Newt", "sneakcf"),                                      // a NEW frog name (another session, another pad): the same person
    frogLine(9002, "Muddy Toad", "nolinkcf"),                                     // somebody else's frog name
    frogLine(9003, "Mossy Croaker", "sneakcf", { k: "tx", id: "tx-9003" }),       // their 🎙 line under a third frog name
    Object.assign(frogLine(9004, "Leafy Newt", "sneakcf"), { mask: "s", u: { anon: true, display: "someone", veil: "hidden", alias: "Leafy Newt", id: "v-l4" } }),   // a hidden bar
    { k: "msg", c: 9005, ts: T0 + 5, u: { login: "sneakcf", display: "sneaky" }, text: "named" },        // their NAMED line
    { k: "msg", c: 9006, ts: T0 + 6, u: { anon: true, display: "someone" }, ah: CV.hashOf("sneakcf"), text: "someone" },   // "someone"
  ];
  const vbKeys = await B.veilKeysOf("ali-0001");
  const out = CV.dress(items, { lookup: () => undefined, vbKeys });
  const by = (c) => out.find((o) => Number(o.c) === c) || {};
  assert.equal(by(9001).vb, 1, "a new frog name of the same person: folded for her");
  assert.equal(by(9003).vb, 1, "and their 🎙 line under yet another frog name");
  assert.equal(by(9002).vb, undefined, "someone else's frog name: never");
  assert.equal(by(9004).vb, undefined, "a hidden bar: never (no words, no frog name to fold)");
  assert.equal(by(9005).vb, undefined, "their NAMED line: untouched (a frog-name block never unmasks)");
  assert.equal(by(9006).vb, undefined, "a 'someone' line: never (it follows a named exit - folding it would link the two)");
  assert.doesNotMatch(JSON.stringify(out.filter((o) => o.u && o.u.anon)), /sneakcf|snk-|nolink/, "only the flag reaches the page");
  // anyone else (bob blocked nobody): nothing folds; alice with no keys: nothing either
  assert.ok(!CV.dress(items, { lookup: () => undefined, vbKeys: await B.veilKeysOf("bob-0001") }).some((o) => o.vb));
  // the page folds it like a named block's line ("A line from someone you blocked · Show")
  const CR = require(path.join(repo, "public", "js", "chatlog-core"));
  const f1 = String(CR.renderItem(by(9001), {}, CR.htmlH)), f2 = String(CR.renderItem(by(9002), {}, CR.htmlH));
  assert.match(f1, /is-blocked-fold/); assert.match(f1, /A line from someone you blocked/); assert.match(f1, /Leafy Newt/, "the frog name stays on the line");
  assert.doesNotMatch(f2, /is-blocked-fold/);
  // history / search: an archived frog line's identity comes from chat_log_veil, read only for a viewer with such a block
  await runQuery("INSERT OR REPLACE INTO chat_log_veil (c, login, display, kind, at) VALUES (9101, 'sneakcf', 'sneakcf', 'incognito', 1), (9102, 'nolinkcf', 'nolinkcf', 'incognito', 1)");
  const arch = [9101, 9102].map((c) => ({ k: "msg", c, ts: T0 + c, u: { anon: true, display: "someone", veil: "incognito", alias: c === 9101 ? "Pond Skipper" : "Muddy Toad", id: "v-a" + c }, text: "old", ah: CV.hashOf(c === 9101 ? "sneakcf" : "nolinkcf") }));
  const H = await require(path.join(repo, "chatloghist")).dress(ROOM, arch, null, { userId: "ali-0001" }, "alicecf", null);
  assert.equal(H.find((o) => o.c === 9101).vb, 1, "history: folded under the archived frog name too");
  assert.equal(H.find((o) => o.c === 9102).vb, undefined);
  const H2 = await require(path.join(repo, "chatloghist")).dress(ROOM, arch, null, { userId: "bob-0001" }, null, null);
  assert.ok(!H2.some((o) => o.vb), "nobody else");
  // web challenges / tips aimed at her WHILE they're incognito: refused, whatever frog name; under their own name: untouched
  const relay = require(path.join(repo, "bridge-relay"));
  const sneaky = { userId: "snk-0001", camfrogUsername: "sneakcf" };
  assert.equal(await relay.challengeBlocked(sneaky, "!duel", "!duel alicecf 100"), null, "named: untouched");
  await incogOn("sneakcf");
  assert.equal(await relay.challengeBlocked(sneaky, "!duel", "!duel alicecf 100"), "You can't challenge alicecf.");
  assert.equal(await relay.challengeBlocked(sneaky, "!brawl", "!brawl @alicecf"), "You can't challenge alicecf.");
  assert.equal(await relay.challengeBlocked(sneaky, "!tip", "!tip alicecf 50"), "You can't tip alicecf.");
  assert.equal(await relay.challengeBlocked(sneaky, "!duel", "!duel bobcf 100"), null, "only the person who blocked them");
  assert.equal(await relay.challengeBlocked({ userId: "ali-0001", camfrogUsername: "alicecf" }, "!duel", "!duel sneakcf 100"), null, "never the blocker's own actions");
  // @mentions: their frog-named lines never alert her, whatever frog name (mentions.js asks towards(..., { veiled: true }))
  assert.equal(await B.towards("snk-0001", "ali-0001", { veiled: true, fromLogin: "sneakcf" }), true);
  assert.equal(await B.towards("snk-0001", "ali-0001", { fromLogin: "sneakcf" }), false, "a named @mention still alerts her");
  await incogOff();
  // the blocker's list: the frog name at block time, identity hidden
  const L = await get("/api/blocks", "alice");
  assert.deepEqual(L.d.veils.map((v) => v.label), ["Soggy Bullfrog"]);
  assert.doesNotMatch(JSON.stringify(L.d), /sneak|snk-/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["settings.blocked.frog_row"], "🐸 {name} (identity hidden)");
  assert.equal(en["js.block.veil_note"], "Blocking can show you that two frog names are the same person - never who.", "the accepted residual, said on the sheet");
  assert.match(fs.readFileSync(path.join(repo, "views", "settingsBlocked.ejs"), "utf8"), /t\('settings\.blocked\.frog_row', \{ name: b\.label \}\)/);
  // Unblock from Settings: nothing folds any more
  await post("/api/blocks", "alice", { ref: { k: "vb", id: L.d.veils[0].id }, on: false });
  assert.equal((await B.veilKeysOf("ali-0001")).size, 0);
  assert.ok(!CV.dress(items, { lookup: () => undefined, vbKeys: await B.veilKeysOf("ali-0001") }).some((o) => o.vb));
});

test("rework: the live view passes the viewer's frog-name block keys to dress; the sheets / menu say what an incognito ban and a frog-name block do", () => {
  const br = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  assert.match(br, /const vk = await require\("\.\/blocks"\)\.veilKeysOf\(userId\); if \(vk && vk\.size\) vbKeys = vk;/);
  assert.match(br, /CV\.dress\(items, \{ view: V, lookup: \(u\) => L\.get\(nameKey\(u\.login\)\), selfKeys, canReveal, vbKeys \}\)/);
  const win = { __t: null };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8"), { window: win });
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "pad-ban-sheet.js"), "utf8"), { window: win, document: {} });
  const v = JSON.parse(JSON.stringify(win.PATVRoom._modMenuItems(null, { anon: true, veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001" }, { signed: true, wmod: { bridge: true, pad: true }, slug: "p" })));
  assert.equal(v.find((x) => x.id === "ban").label, "⛔ Incognito ban…");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["js.ban.menu_veil"], "Incognito ban…");
  assert.match(en["js.ban.scope_veil_sub"], /Every frog name they use here, now and later/);
  assert.match(en["js.block.veil_body"], /^Whatever frog name they use, in any pad: their lines are folded for you/);
  assert.match(en["js.block.veil_body"], /what they do under their own name doesn't change/);
});

// banfix (owner 2026-11-05, iPhone: "⛔ PATV account @Boogie · 🌐 web, no Camfrog link", Whole site, 7 days, "You know why", networks
// ticked -> "No such user."): roomsweb.js's stage room-ban route (the pad settings page's form, {username} / {userId}) shares the paths
// POST /api/rooms/:slug/ban + /unban with padbans.js and is registered first (index.js), so it answered EVERY person-menu ban - no
// username in a {ref} body -> mainstage.roomBan "No such user." (404) - and every ↩️ Lift ({ok: false}, "Not changed."); nothing written.
test("banfix: the site builds roomsweb.js's routes before bridge.js's padbans routes - this file's app is built in that order", () => {
  const ix = fs.readFileSync(path.join(repo, "index.js"), "utf8"), br = fs.readFileSync(path.join(repo, "bridge.js"), "utf8");
  const rw = ix.indexOf('require("./roomsweb").register(app'), bj = ix.indexOf("bridge.register(app");
  assert.ok(rw > 0 && bj > 0 && rw < bj, "index.js: roomsweb.register, then bridge.register");
  assert.match(br, /require\("\.\/padbans"\)\.register\(app, \{ addUser, bySlug \}\)/);
  // (the shared paths: the pad settings page's stage room-ban form posts {username} / {userId}; the ban sheet {ref, scope, ...} / {entry})
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "room-manage.js"), "utf8"), /post\('\/api\/rooms\/' \+ encodeURIComponent\(slug\) \+ '\/unban', \{ userId: /);
  const sheet = fs.readFileSync(path.join(repo, "public", "js", "pad-ban-sheet.js"), "utf8");
  assert.match(sheet, /api\(base\(o\.slug\) \+ '\/unban', \{ ref: o\.ref, scope: scope \}\)/);
});

test("banfix: a WEB-ONLY account (@Boogie, no Camfrog link) - banned and lifted through the real routes at every scope the sheet offers, with and without its networks; a missing person still gets the right words", async () => {
  const NB = require(path.join(repo, "netban"));
  const MS = require(path.join(repo, "mainstage"));
  const BOOGIE = "0d641146-163f-40bb-b9b9-e66ecf5a7942";
  // (camfrogUsername '' - prod's row has it empty, not NULL)
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES (?, 'Boogie', 'Boogie', 'x', '', 'pleb')", [BOOGIE]);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES ('adm-0001', 'boss', 'boss', 'x', NULL, 'Admin')");
  U.adm = { userId: "adm-0001", username: "boss", class: "Admin", camfrogUsername: null };
  await NB.init();                                   // (init reads the stored switch - turn it on after)
  NB._setOn(true);
  try {
    await MS.init();
    // Boogie's network (as the proxy hands it on: the socket is loopback, the address in CF-Connecting-IP)
    await NB.note(BOOGIE, { socket: { remoteAddress: "127.0.0.1" }, get: (k) => (k.toLowerCase() === "cf-connecting-ip" ? "198.51.100.77" : "") }, "signin");
    const rows = async (sql, args) => (await getQuery(sql, args)).length;
    const state = async () => ({ site: await rows("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = ''", [BOOGIE]),
                                 pad: await rows("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = ?", [BOOGIE, ROOM]),
                                 bridge: await rows("SELECT 1 FROM bridge_blocks WHERE user_id = ? AND room_id = ? AND feature = 'all'", [BOOGIE, ROOM]),
                                 stage: await rows("SELECT 1 FROM stage_room_bans WHERE userId = ?", [BOOGIE]) });
    const want = { site: { site: 1, pad: 0, bridge: 0, stage: 0 }, pad: { site: 0, pad: 1, bridge: 1, stage: 0 }, bridge: { site: 0, pad: 0, bridge: 1, stage: 0 } };
    const none = { site: 0, pad: 0, bridge: 0, stage: 0 };
    const WHO = { kind: "account", title: "PATV account @Boogie", sub: "🌐 web, no Camfrog link" };
    // the people list's 🌐 row (its PATV username) and a web line's account key - the two refs the page sends for a web poster
    for (const ref of [{ k: "user", v: "Boogie" }, { k: "acct", v: "u:" + BOOGIE }]) {
      PB._reset();
      const pv = await post(`/api/rooms/${SLUG}/ban/preview`, "adm", { ref, scope: "bridge" });
      assert.equal(pv.status, 200, JSON.stringify(pv.d));
      assert.deepEqual(pv.d.who, WHO);
      assert.deepEqual(pv.d.scopes, ["bridge", "pad", "site"]);
      assert.deepEqual(pv.d.nets, { on: true, networks: 1, shared: 0, accounts: [] }, "No other account shares them.");
      for (const scope of ["site", "pad", "bridge"]) {
        for (const nets of [true, false]) {
          PB._reset();
          const t0 = Date.now();
          const r = await post(`/api/rooms/${SLUG}/ban`, "adm", { ref, scope, dur: "7d", reason: "You know why", nets, exempt: [] });
          const tag = `${ref.k} ${scope} nets=${nets}`;
          assert.equal(r.status, 200, tag + ": " + JSON.stringify(r.d));
          assert.equal(r.d.ok, true, tag); assert.equal(r.d.scope, scope, tag);
          assert.deepEqual(r.d.who, WHO, tag);
          assert.ok(r.d.until >= t0 + 7 * 86400e3 - 5000 && r.d.until <= Date.now() + 7 * 86400e3, tag + ": 7 days");
          if (nets) assert.equal(r.d.nets && r.d.nets.networks, 1, tag); else assert.equal(r.d.nets, undefined, tag);
          assert.deepEqual(await state(), want[scope], tag + ": the ban's own stores - never the stage form's");
          const au = await getQuery("SELECT reason FROM admin_audit WHERE action = 'pad_ban' AND target_id = ? ORDER BY id DESC LIMIT 1", [BOOGIE]);
          assert.equal(au[0] && au[0].reason, "You know why", tag + ": audited");
          // ↩️ Lift - the sheet's {ref, scope}
          const l = await post(`/api/rooms/${SLUG}/unban`, "adm", { ref, scope });
          assert.equal(l.status, 200, tag + " lift: " + JSON.stringify(l.d));
          assert.equal(l.d.ok, true, tag + " lift");
          assert.deepEqual(await state(), none, tag + ": lifted");
        }
      }
    }
    // the pad's owner (not staff): a whole-pad ban and its Lift, through the same routes
    PB._reset();
    let r = await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "user", v: "Boogie" }, scope: "pad", dur: "1d", reason: "" });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.equal((await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "user", v: "Boogie" }, scope: "pad" })).d.ok, true);
    assert.deepEqual(await state(), none);
    // someone really missing: the ban sheet's own words (404) - nothing written, never the stage form's "No such user."
    for (const ref of [{ k: "user", v: "nosuchperson" }, { k: "acct", v: "u:00000000-0000-0000-0000-000000000000" }]) {
      for (const p of ["/ban/preview", "/ban", "/unban"]) {
        PB._reset();
        const m = await post(`/api/rooms/${SLUG}${p}`, "adm", { ref, scope: "site", dur: "7d", reason: "x" });
        assert.deepEqual([m.status, m.d], [404, { ok: false, error: "That account isn't here any more." }], p + " " + ref.k);
      }
    }
    PB._reset();
    const noRef = await post(`/api/rooms/${SLUG}/ban`, "adm", { scope: "site", dur: "7d", reason: "x" });
    assert.deepEqual([noRef.status, noRef.d.error], [404, "Who? Pick someone from the list."]);
    // the pad settings page's stage room-ban form (room-manage.js) still owns ITS bodies on the same paths
    r = await post(`/api/rooms/${SLUG}/ban`, "owner", { username: "Boogie", reason: "spam" });
    assert.deepEqual([r.status, r.d], [200, { ok: true, username: "Boogie" }]);
    assert.equal((await state()).stage, 1);
    r = await post(`/api/rooms/${SLUG}/ban`, "owner", { username: "nosuchperson", reason: "x" });
    assert.deepEqual([r.status, r.d], [404, { ok: false, error: "No such user." }], "the form's typed name: its own words");
    r = await post(`/api/rooms/${SLUG}/unban`, "owner", { userId: BOOGIE });
    assert.deepEqual([r.status, r.d], [200, { ok: true }]);
    assert.deepEqual(await state(), none);
  } finally {
    NB._setOn(false);
  }
});
