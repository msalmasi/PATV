// 1.99?? padppl: 🚫 Block from the person menu / profile / settings (blocks.js) and the website's bans from the person menu (padbans.js).
//
// Blocks - ONE block (the DM block, dm_blocks) wherever it is made; + login blocks (an unlinked Camfrog login) and frog-name blocks:
//   - the ref is exactly what was clicked (personref.js): a Camfrog login -> its LINKED account, a 🌐 row -> that PATV username (the
//     tricon case: the two never mix), a web line's account key, a veiled roster entry / line -> the hidden person, never said
//   - effects: tips refused (tips.transferPat: every tip path), web !duel / !brawl / !tip refused, DMs refused with the generic text for a
//     frog-name block, the blocker missing from the blocked person's people list; NOTHING changes in what the blocker sees for a veil
//   - the same answer whoever is behind a frog name (an account, an unlinked login, nobody); "That's you" only to yourself
//   - a login block becomes a named block when the login links; the settings list shows frog names by label only
// Bans - on the exact identity, into the existing stores; a veil ban is its own row (a named re-ban never overwrites it), refuses only
//   (bridgeblocks.active / feedstore.postRefusal / mainstage.isBanned), has no visible effect, lists as "🐸 label · identity hidden";
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
  assert.equal(t1.ok, false); assert.equal(t1.status, 403); assert.match(t1.msg, /You can't tip bobweb\./);
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
  // stored by the hidden person, effective on them: no tip, no DM, and alice is off sneaky's people list
  assert.equal(await B.towards("snk-0001", "ali-0001"), true);
  assert.equal(await B.hiddenTowards("snk-0001", "ali-0001"), true);
  assert.equal(await B.towards("ali-0001", "snk-0001"), false, "THE VEIL RULE: a frog-name block never changes the blocker's own actions");
  const M = require(path.join(repo, "messages"));
  await M.init();
  const why = await M.refusal(await M.account("snk-0001"), await M.account("ali-0001"));
  assert.match(why.message, /^You can't message alicep\.$/, "the generic text, like any other refusal");
  assert.ok((await B.veilBlockersOf("snk-0001")).has("ali-0001"), "the people list leaves alice out for sneaky");
  // ...but NOTHING changes for alice: her own page list never names a veil, nor does the menu ever offer Unblock on one
  assert.equal(await B.pageList("ali-0001"), null);
  // the settings list: labels, pads and days only
  const L = await get("/api/blocks", "alice");
  assert.equal(L.d.veils.length, 3);
  assert.doesNotMatch(JSON.stringify(L.d), /sneak|nolink|snk-|blocked_id|blocked_login/);
  // a login that links later: the veil learns the account
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('nol-0001', 'nolinker', 'nolinker', 'x', 'nolinkcf')");
  await B.linked("nol-0001", "nolinkcf");
  assert.equal(await B.towards("nol-0001", "ali-0001"), true);
  // yourself
  const me = await post("/api/blocks", "sneak", { ref: { k: "veil", id: "v-soggy000001" }, slug: SLUG, on: true });
  assert.equal(me.status, 400); assert.equal(me.d.error, "That's you.");
  // unblock one from the settings list
  for (const v of L.d.veils) await post("/api/blocks", "alice", { ref: { k: "vb", id: v.id }, on: false });
  assert.equal(await B.towards("snk-0001", "ali-0001"), false);
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
  assert.deepEqual(ids(MI(null, alice, { signed: true, wmod, slug: "p" })), ["profile", "block", "ban_bridge", "ban_pad"]);
  assert.deepEqual(ids(MI(null, Object.assign({ wban: { b: -1, p: 0 } }, alice), { signed: true, wmod, slug: "p" })), ["profile", "block", "lift_bridge", "ban_pad"]);
  assert.deepEqual(MI(null, alice, { signed: true, wmod, slug: "p" }).find((x) => x.id === "ban_pad").ref, { k: "login", v: "alicecf" }, "the exact login");
  // a 🌐 web row: by its PATV username; a web line: by its account key
  assert.deepEqual(MI(null, { web: true, display: "tricon", patv: { username: "tricon" } }, { signed: true }).find((x) => x.id === "block").ref, { k: "user", v: "tricon" });
  assert.deepEqual(MI(null, { login: "u:har-0001", acct: true, web: true, display: "tricon", patv: { username: "tricon" } }, { signed: true }).find((x) => x.id === "block").ref, { k: "acct", v: "u:har-0001" });
  // a veil: Block + bans, by its id; never a Lift (no wban on veils)
  const v = MI(null, { anon: true, veil: "incognito", alias: "Soggy Bullfrog", id: "v-soggy000001", wban: { b: -1 } }, { signed: true, wmod, slug: "p" });
  assert.deepEqual(ids(v), ["block", "ban_bridge", "ban_pad"]);
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
  await post(`/api/rooms/${SLUG}/unban`, "owner", { ref: { k: "user", v: "tricon" }, scope: "bridge" });
  // the audit names the real identity; the room event too (a named one)
  const au = await getQuery("SELECT action, target_id FROM admin_audit WHERE action IN ('pad_ban','pad_unban') ORDER BY at");
  assert.ok(au.some((x) => x.action === "pad_ban" && x.target_id === "har-0001"));
});

test("a veil ban: its own row, refusals only, no visible effect; a named re-ban never removes it; listed as identity hidden", async () => {
  let r = await post(`/api/rooms/${SLUG}/ban`, "owner", { ref: { k: "veil", id: "v-soggy000001" }, scope: "pad", dur: "7d", reason: "spam" });
  assert.equal(r.status, 200);
  assert.doesNotMatch(JSON.stringify(r.d), /sneak/);
  // refusals: the web bridge (bridgeblocks.active - every relay path asks it), posting in the pad, booking its stage
  const a = await BB.active(ROOM, "snk-0001");
  assert.ok(a && a.feature === "all");
  assert.match(BB.refusalText(a), /^A mod of this room blocked you from talking in it from the website until .* \(spam\)\.$/);
  const FS = require(path.join(repo, "feedstore"));
  const pr = await FS.postRefusal(Object.assign(await FS.account("snk-0001"), {}), [ROOM]);
  assert.ok(pr && pr.status === 403);
  assert.equal(await require(path.join(repo, "mainstage")).isBanned("snk-0001", ROOM), true);
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
