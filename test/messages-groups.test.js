// Offline tests for 1.99cz direct-message additions: group chats (create / add / leave / remove / rename / mute,
// permissions, blocks inside groups, limits, system lines, alerts per member with the group's name, reports with
// minimal context), private pictures (upload validation, members-only route + headers, purge on delete, clear /
// leave hide them, admin view logged) and PATV post cards (visibility).
//   node --test test/messages-groups.test.js      (needs the repo's node_modules - sharp; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm2-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.DM_DIR = path.join(tmp, "dmfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.DM_EMBED_HOSTS = "patv.test";
const express = require("express");
const cookieParser = require("cookie-parser");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));
const dmmedia = require(path.join(repo, "dmmedia"));
const dmembeds = require(path.join(repo, "dmembeds"));

let T = Date.now();
dm._setClock(() => T);
const tick = (ms = 1000) => { T += ms; };

let base, server;
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at, discordId)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog === undefined ? name + "cf" : extra.camfrog, extra.level == null ? 5 : extra.level,
                  "2026-01-01 00:00:00", extra.discord || null]);
  return (U[name] = { userId: id, username: name, class: extra.class || "pleb" });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await inbox.ready;
  await follows.init();
  await store.init();
  await dm.init();
  for (const n of ["ann", "ben", "cat", "dan", "eli", "fay", "gus", "hal", "ida", "jo", "kim", "lou", "max", "ned"]) await mkUser(n);
  await mkUser("shy");                                         // "nobody" can message them
  await mkUser("nolink", { camfrog: null, level: 1 });         // level 1, unlinked: new account, can't send pictures
  await mkUser("boss", { class: "Admin" });
  await mkUser("outsider");

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  dm.register(app, { isBotToken: (t) => t === "bot", addUser });
  inbox.register(app, { isBotToken: (t) => t === "bot", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); for (const set of dm._streams.values()) for (const r of set) { try { r.end(); } catch (e) { /* */ } } });
test.beforeEach(() => { dm._gaps.clear(); tick(2000); });

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d, headers: r.headers };
}
const post = (url, u, body) => call("POST", url, u, body);
const get = (url, u) => call("GET", url, u);
const group = (u, members, title) => { tick(1000); return post("/api/messages/groups", u, { title, members }); };
const sayIn = (u, c, body = "hi", extra = {}) => { tick(1000); return post("/api/messages/send", u, { conversation: c, body, ...extra }); };
const claim = () => post("/api/messages/alerts/claim", null, { password: "bot" });
const texts = async (u, c) => (await get(`/api/messages/c/${c}`, u)).d.messages.map((m) => (m.kind === "system" ? "[" + m.system + "]" : m.text));

// ───────────────────────── groups ─────────────────────────
test("create: 2-9 people, a name (or one from the members), the creator owns it, a system line, everyone sees it", async () => {
  assert.equal((await group(U.ann, ["ben"])).status, 400, "one person = a DM, not a group");
  assert.equal((await group(U.ann, ["ben", "ann"])).status, 400, "you don't count as one of the people");
  const ten = ["ben", "cat", "dan", "eli", "fay", "gus", "hal", "ida", "jo", "kim"];
  const big = await group(U.ann, ten);
  assert.equal(big.status, 400);
  assert.match(big.d.error, /up to 10 people/);
  const g = await group(U.ann, ["ben", "@Cat", "ben"], "  Movie   night  ");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  const c = g.d.conversation.id;
  assert.equal(g.d.conversation.kind, "group");
  assert.equal(g.d.conversation.title, "Movie night");
  const h = (await get(`/api/messages/c/${c}?head=1`, U.cat)).d;
  assert.equal(h.conversation.kind, "group");
  assert.deepEqual(h.conversation.members.map((m) => [m.username, m.role]), [["ann", "owner"], ["ben", "member"], ["cat", "member"]]);
  assert.equal(h.conversation.canSend, true);
  assert.equal(h.messages[0].kind, "system");
  assert.equal(h.messages[0].system, "ann created the group “Movie night” with ben and cat");
  const L = (await get("/api/messages/conversations", U.ben)).d.conversations.find((x) => x.id === c);
  assert.equal(L.kind, "group");
  assert.equal(L.title, "Movie night");
  assert.equal(L.count, 3);
  assert.deepEqual(L.members.map((m) => m.username), ["ann", "cat"], "the others, for the initials avatar");
  assert.equal(L.unread, 0, "system lines don't count as unread");
  // default name
  const d = await group(U.dan, ["eli", "fay", "gus"]);
  assert.equal(d.d.conversation.title, "dan, eli and fay +1");
  // a message reaches every member; non-members get 404
  await sayIn(U.ben, c, "popcorn?");
  assert.equal(await dm.unreadTotal(U.ann.userId), 1);
  assert.equal(await dm.unreadTotal(U.cat.userId), 1);
  assert.equal((await get(`/api/messages/c/${c}`, U.outsider)).status, 404);
  assert.equal((await sayIn(U.outsider, c, "let me in")).status, 404);
});

test("adding people: refusal per person under the adder's rules (blocks, who-can-message-me, new accounts); all-or-nothing on create", async () => {
  await post("/api/messages/prefs", U.shy, { who: "nobody" });
  await post("/api/messages/block", U.hal, { username: "ida" });           // hal blocks ida
  // create with someone who can't be added: nothing is created, the reasons come back per person
  const before = (await getQuery("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'group'"))[0].n;
  const r = await group(U.ida, ["jo", "shy", "hal", "nobody_here"]);
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "members");
  const why = Object.fromEntries(r.d.refused.map((x) => [x.username, x.code]));
  assert.deepEqual(why, { shy: "closed", hal: "blocked", nobody_here: "gone" });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'group'"))[0].n, before, "nothing created");
  // the blocker can't add the person they blocked either
  const r2 = await group(U.hal, ["ida", "jo"]);
  assert.equal(r2.d.refused[0].code, "you_blocked");
  // a new (unlinked, level 1) account only adds people who follow them
  const n1 = await group(U.nolink, ["jo", "kim"]);
  assert.deepEqual(n1.d.refused.map((x) => x.code), ["new", "new"]);
  await follows.follow({ userId: U.jo.userId }, "user", U.nolink.userId);
  await follows.follow({ userId: U.kim.userId }, "user", U.nolink.userId);
  assert.equal((await group(U.nolink, ["jo", "kim"])).status, 200, "followers are fine");
  // adding to an existing group: partial - the ones that pass are added, the rest come back with reasons
  const g = await group(U.jo, ["kim", "lou"]);
  const c = g.d.conversation.id;
  await sayIn(U.kim, c, "before max joined");
  const add = await post(`/api/messages/c/${c}/members`, U.lou, { usernames: ["max", "shy", "kim"] });   // any member can add
  assert.equal(add.status, 200);
  assert.deepEqual(add.d.added.map((x) => x.username), ["max"]);
  assert.deepEqual(add.d.refused.map((x) => [x.username, x.code]), [["shy", "closed"], ["kim", "member"]]);
  const mx = await texts(U.max, c);
  assert.deepEqual(mx, ["[lou added max]"], "a new member sees the group from when they were added");
  assert.ok((await texts(U.kim, c)).includes("before max joined"));
  // full at 10
  const big = await group(U.ann, ["ben", "cat", "dan", "eli", "fay", "gus", "hal", "jo", "kim"]);
  assert.equal(big.status, 200, JSON.stringify(big.d));
  const full = await post(`/api/messages/c/${big.d.conversation.id}/members`, U.ben, { usernames: ["lou"] });
  assert.equal(full.d.refused[0].code, "full");
  // a DM conversation isn't a group
  const d1 = await post("/api/messages/send", U.ann, { to: "ben", body: "psst" });
  assert.equal((await post(`/api/messages/c/${d1.d.conversation.id}/members`, U.ann, { usernames: ["cat"] })).status, 400);
});

test("leave, remove (owner only), owner hand-over, rename (any member), mute; system lines", async () => {
  const g = await group(U.eli, ["fay", "gus", "hal"], "Crew");
  const c = g.d.conversation.id;
  // only the owner removes
  const no = await post(`/api/messages/c/${c}/remove`, U.fay, { username: "gus" });
  assert.equal(no.status, 403);
  assert.equal((await post(`/api/messages/c/${c}/remove`, U.eli, { username: "gus" })).status, 200);
  assert.equal((await get(`/api/messages/c/${c}`, U.gus)).status, 404, "removed: no access");
  assert.ok(!(await get("/api/messages/conversations", U.gus)).d.conversations.some((x) => x.id === c));
  // rename by any member
  const rn = await post(`/api/messages/c/${c}/rename`, U.hal, { title: "The Crew" });
  assert.equal(rn.d.title, "The Crew");
  assert.equal((await post(`/api/messages/c/${c}/rename`, U.hal, { title: "   " })).status, 400);
  // the owner leaves: the longest-standing member owns it now
  assert.equal((await post(`/api/messages/c/${c}/leave`, U.eli, {})).status, 200);
  const h = (await get(`/api/messages/c/${c}?head=1`, U.fay)).d;
  assert.deepEqual(h.conversation.members.map((m) => [m.username, m.role]), [["fay", "owner"], ["hal", "member"]]);
  assert.deepEqual(h.messages.filter((m) => m.kind === "system").map((m) => m.system), [
    "eli created the group “Crew” with fay, gus and hal", "eli removed gus", "hal renamed the group to “The Crew”", "eli left", "fay is now the group's owner"]);
  assert.equal((await sayIn(U.eli, c, "still here?")).status, 404, "left: can't post");
  // re-added later: sees only from then on
  await post(`/api/messages/c/${c}/members`, U.hal, { usernames: ["eli"] });
  assert.deepEqual(await texts(U.eli, c), ["[hal added eli]"]);
  // mute: no alerts, out of the nav count, still listed with its unread count
  await post(`/api/messages/c/${c}/mute`, U.fay, { on: true });
  await sayIn(U.hal, c, "anyone?");
  assert.equal(await dm.unreadTotal(U.fay.userId), 0, "a muted conversation isn't in the nav count");
  const L = (await get("/api/messages/conversations", U.fay)).d.conversations.find((x) => x.id === c);
  assert.equal(L.muted, true);
  assert.equal(L.unread, 1);
  tick(dm.ALERT_GAP_MS + dm.ALERT_GRACE_MS + 1000);
  const A = (await claim()).d.alerts;
  assert.ok(!A.some((a) => a.login === "faycf"), "muted: no Camfrog alert");
  assert.ok(A.some((a) => a.login === "elicf" && /in “The Crew”/.test(a.text)), "the others get one, naming the group");
  await post(`/api/messages/c/${c}/mute`, U.fay, { on: false });
  assert.equal(await dm.unreadTotal(U.fay.userId), 1);
  // the last one out: nobody to talk to
  await post(`/api/messages/c/${c}/leave`, U.hal, {});
  await post(`/api/messages/c/${c}/leave`, U.eli, {});
  const alone = await sayIn(U.fay, c, "hello?");
  assert.equal(alone.status, 403);
  assert.equal(alone.d.code, "alone");
});

test("blocks inside a group: the blocked person's messages are collapsed for the blocker only, not unread, no alert", async () => {
  // jo blocks kim; lou (who can message both) puts them in one group - allowed, it doesn't reveal the block
  await post("/api/messages/block", U.jo, { username: "kim" });
  const g = await group(U.lou, ["jo", "kim"], "Mixed");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  const c = g.d.conversation.id;
  await claim(); tick(dm.ALERT_GAP_MS + 1000);
  await sayIn(U.kim, c, "hi everyone");
  const forJo = (await get(`/api/messages/c/${c}`, U.jo)).d.messages.find((m) => m.text === "hi everyone");
  const forLou = (await get(`/api/messages/c/${c}`, U.lou)).d.messages.find((m) => m.text === "hi everyone");
  assert.equal(forJo.blocked, true, "collapsed for the blocker");
  assert.equal(forLou.blocked, false, "nobody else sees a difference");
  assert.equal(await dm.unreadTotal(U.jo.userId), 0, "not unread for the blocker");
  assert.equal(await dm.unreadTotal(U.lou.userId), 1);
  tick(dm.ALERT_GRACE_MS + 1000);
  const A = (await claim()).d.alerts;
  assert.ok(!A.some((a) => a.login === "jocf"), "no alert to the blocker");
  assert.ok(A.some((a) => a.login === "loucf"));
  // the blocked person can still write in the group; the blocker can't add them anywhere
  assert.equal((await sayIn(U.kim, c, "still talking")).status, 200);
  const g2 = await group(U.jo, ["kim", "lou"]);
  assert.equal(g2.d.refused[0].code, "you_blocked");
  const g3 = await group(U.kim, ["jo", "lou"]);
  assert.equal(g3.d.refused[0].code, "blocked", "and they can't add the blocker");
});

test("alerts: batched per member per conversation, the group's name, sender in the preview, 'sent a photo'", async () => {
  await claim(); tick(dm.ALERT_GAP_MS + 1000); await claim();
  const g = await group(U.ann, ["ben", "cat"], "Snack \"club\"");
  const c = g.d.conversation.id;
  await sayIn(U.ben, c, "first");
  await sayIn(U.cat, c, "second thing to say");
  await sayIn(U.ben, c, "third");
  tick(dm.ALERT_GRACE_MS + 1000);
  const A = (await claim()).d.alerts.filter((a) => a.id.startsWith(c));
  const ann = A.find((a) => a.login === "anncf");
  assert.ok(ann, JSON.stringify(A));
  assert.equal(ann.count, 3);
  assert.equal(ann.group, "Snack \"club\"");
  assert.match(ann.text, /^💬 3 new messages in “Snack "club"” on publicaccess\.tv\/messages: "ben: third"$/);
  assert.equal(ann.text_plain, "💬 3 new messages in “Snack \"club\"” on publicaccess.tv/messages");
  assert.equal(ann.from_login, "bencf", "Pepe checks the last sender's !incognito");
  const cat = A.find((a) => a.login === "catcf");
  assert.equal(cat.count, 1, "each member's own unread (cat's own message marked 'first' read)");
  assert.equal(A.filter((a) => a.login === "anncf").length, 1, "one alert per member per conversation");
  // a pictures-only message: "sent a photo", never a link
  tick(dm.ALERT_GAP_MS + 1000);
  await post(`/api/messages/c/${c}/read`, U.cat, {});
  const pid = await uploadPng(U.ben);
  await sayIn(U.ben, c, "", { pictures: [pid] });
  tick(dm.ALERT_GRACE_MS + 1000);
  const P = (await claim()).d.alerts.find((a) => a.login === "catcf" && a.id.startsWith(c));
  assert.equal(P.text, "📷 ben sent a photo in “Snack \"club\"” on publicaccess.tv/messages");
  assert.doesNotMatch(P.text + P.text_plain, /\/messages\/media|\.webp/);
});

// ───────────────────────── pictures ─────────────────────────
async function pngBuf(w = 64, h = 48) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();
}
async function upload(u, buf, { size } = {}) {
  const o = await post("/api/messages/uploads", u, { size: size || buf.length });
  if (o.status !== 200) return o;
  const r = await fetch(`${base}/api/messages/uploads/${o.d.id}?offset=0`, { method: "PUT", body: buf,
    headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", "x-test-user": u.userId } });
  const j = await r.json();
  if (r.status !== 200) return { status: r.status, d: j, id: o.d.id };
  const f = await post(`/api/messages/uploads/${o.d.id}/finish`, u, {});
  for (let i = 0; i < 100; i++) {
    const s = await get(`/api/messages/uploads/${o.d.id}`, u);
    if (s.d.state === "ready" || s.d.state === "failed") return { status: 200, d: s.d, id: o.d.id };
    await new Promise((res) => setTimeout(res, 30));
  }
  return { status: 0, f };
}
async function uploadPng(u) { const r = await upload(u, await pngBuf()); assert.equal(r.d.state, "ready", JSON.stringify(r.d)); return r.id; }
const fetchFile = (url, u, extra = {}) => fetch(base + url, { headers: Object.assign(u ? { "x-test-user": u.userId } : {}, extra) });

test("upload validation: magic bytes, pictures only, size cap, new accounts, EXIF/GPS stripped, up to 4 per message", async () => {
  const html = Buffer.from("<html><script>alert(1)</script></html>".padEnd(64, " "));
  const h = await upload(U.ann, html);
  assert.equal(h.status, 415);
  assert.match(h.d.error, /HTML/);
  const mp3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200, 1)]);
  const a = await upload(U.ann, mp3);
  assert.equal(a.status, 415);
  assert.match(a.d.error, /Only pictures/);
  const lie = await upload(U.ann, await pngBuf(), { size: 20 });               // says 20 bytes, sends more
  assert.equal(lie.status, 413);
  assert.equal((await post("/api/messages/uploads", U.ann, { size: 60 * 1024 * 1024 })).status, 413);
  const nl = await post("/api/messages/uploads", U.nolink, { size: 1000 });
  assert.equal(nl.status, 403, "level 1 and unlinked: no pictures");
  assert.match(nl.d.error, /linked Camfrog name.*level 2/);
  // EXIF + GPS in, nothing out
  const jpg = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#3a6" } }).jpeg()
    .withMetadata({ exif: { IFD0: { Make: "SpyCam", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" } } }).toBuffer();
  assert.ok((await sharp(jpg).metadata()).exif, "the test file does carry EXIF");
  const j = await upload(U.ann, jpg);
  assert.equal(j.d.state, "ready");
  const row = (await getQuery("SELECT * FROM dm_media WHERE id = ?", [j.id]))[0];
  const out = fs.readFileSync(dmmedia.filePath(row.file));
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.exif, undefined, "EXIF stripped");
  assert.equal(meta.icc, undefined);
  assert.ok(!out.includes(Buffer.from("SpyCam")), "no camera make in the bytes");
  assert.ok(dmmedia.filePath(row.file).startsWith(path.join(tmp, "dmfiles")), "in the private DM directory");
  assert.ok(!fs.existsSync(path.join(tmp, "feedfiles", row.file.slice(0, 2), row.file)), "not in the feed's directory");
  // 5 pictures in one message: refused
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await uploadPng(U.ann));
  ids.push(j.id);
  const g = await group(U.ann, ["ben", "cat"]);
  const five = await sayIn(U.ann, g.d.conversation.id, "too many", { pictures: ids });
  assert.equal(five.status, 400);
  assert.match(five.d.error, /Up to 4 pictures/);
  // someone else's upload can't be attached
  const theirs = await uploadPng(U.ben);
  assert.equal((await sayIn(U.ann, g.d.conversation.id, "x", { pictures: [theirs] })).status, 400);
  const ok = await sayIn(U.ann, g.d.conversation.id, "", { pictures: ids.slice(0, 2), nsfw: [ids[1]] });
  assert.equal(ok.status, 200, JSON.stringify(ok.d));
  assert.equal(ok.d.message.images.length, 2);
  assert.deepEqual(ok.d.message.images.map((p) => p.nsfw), [false, true], "the sender's NSFW mark");
  assert.match(ok.d.message.images[0].thumb, /^\/messages\/media\/[a-f0-9]{32}_t\.webp$/);
  assert.equal((await sayIn(U.ann, g.d.conversation.id, "again", { pictures: [ids[0]] })).status, 400, "a picture is sent once");
});

test("private media: members only (404 for everyone else), private no-store headers, clear / leave hide them, uploader sees an unsent upload", async () => {
  const g = await group(U.dan, ["eli", "fay"], "Pics");
  const c = g.d.conversation.id;
  const pid = await uploadPng(U.dan);
  const unsent = (await getQuery("SELECT * FROM dm_media WHERE id = ?", [pid]))[0];
  assert.equal((await fetchFile("/messages/media/" + unsent.thumb, U.dan)).status, 200, "the uploader previews it before sending");
  assert.equal((await fetchFile("/messages/media/" + unsent.thumb, U.eli)).status, 404, "nobody else");
  const s = await sayIn(U.dan, c, "look", { pictures: [pid] });
  const url = s.d.message.images[0].full, thumb = s.d.message.images[0].thumb;
  const r = await fetchFile(url, U.eli);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.match(r.headers.get("cache-control"), /private/);
  assert.match(r.headers.get("cache-control"), /no-store/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.equal(r.headers.get("etag"), null, "no validators to cache by");
  assert.equal(r.headers.get("last-modified"), null);
  assert.equal((await r.arrayBuffer()).byteLength > 0, true);
  for (const [who, why] of [[null, "signed out"], [U.outsider, "not a member"], [U.boss, "an admin isn't a member either"]]) {
    const x = await fetchFile(url, who);
    assert.equal(x.status, 404, why);
    assert.match(x.headers.get("cache-control"), /no-store/, why + ": no caching of the refusal");
  }
  assert.equal((await fetchFile("/messages/media/../../etc/passwd", U.eli)).status, 404);
  assert.equal((await fetchFile("/messages/media/" + "a".repeat(32) + ".webp", U.eli)).status, 404);
  // the feed's public file route never serves it
  assert.equal((await fetchFile("/feed/f/" + url.split("/").pop(), U.eli)).status, 404);
  // clear history hides it from that member only
  await post(`/api/messages/c/${c}/clear`, U.eli, {});
  assert.equal((await fetchFile(thumb, U.eli)).status, 404, "cleared: hidden for eli");
  assert.equal((await fetchFile(thumb, U.fay)).status, 200, "fay still sees it");
  // leaving hides it
  await post(`/api/messages/c/${c}/leave`, U.fay, {});
  assert.equal((await fetchFile(thumb, U.fay)).status, 404, "left: gone for fay");
  assert.equal((await fetchFile(thumb, U.dan)).status, 200);
  // a member added later doesn't see pictures from before
  await post(`/api/messages/c/${c}/members`, U.dan, { usernames: ["gus"] });
  assert.equal((await fetchFile(thumb, U.gus)).status, 404);
});

test("delete: pictures stop at once, the sweep removes the files after the grace period - kept while a report is open", async () => {
  const g = await group(U.ned, ["ida", "jo"], "Del");
  assert.equal(g.status, 200, JSON.stringify(g.d));
  const c = g.d.conversation.id;
  const p1 = await uploadPng(U.ned), p2 = await uploadPng(U.ned);
  const a = await sayIn(U.ned, c, "one", { pictures: [p1] });
  const b = await sayIn(U.ned, c, "two", { pictures: [p2] });
  const f1 = dmmedia.filePath((await getQuery("SELECT file FROM dm_media WHERE id = ?", [p1]))[0].file);
  const f2 = dmmedia.filePath((await getQuery("SELECT file FROM dm_media WHERE id = ?", [p2]))[0].file);
  // ida reports message b; then hal deletes both
  assert.equal((await post(`/api/messages/m/${b.d.message.id}/report`, U.ida, { reason: "abuse" })).status, 200);
  await post(`/api/messages/m/${a.d.message.id}/delete`, U.ned, {});
  await post(`/api/messages/m/${b.d.message.id}/delete`, U.ned, {});
  assert.equal((await fetchFile(a.d.message.images[0].thumb, U.ida)).status, 404, "not served the moment it's deleted");
  assert.equal((await fetchFile(a.d.message.images[0].thumb, U.ned)).status, 404, "not even to the sender");
  const hist = (await get(`/api/messages/c/${c}`, U.jo)).d.messages.find((m) => m.id === a.d.message.id);
  assert.deepEqual(hist.images, []);
  await dmmedia.sweep();
  assert.ok(fs.existsSync(f1), "inside the grace period");
  tick(dmmedia.DELETED_GRACE_MS + 1000);
  let sw = await dmmedia.sweep();
  assert.ok(sw.purged >= 1);
  assert.ok(!fs.existsSync(f1), "deleted message: files gone");
  assert.ok(fs.existsSync(f2), "reported message: kept for the admins");
  assert.equal((await getQuery("SELECT state FROM dm_media WHERE id = ?", [p1]))[0].state, "purged");
  // the admin sees the reported picture (logged), then resolves it -> purged on the next sweep
  const det = await get(`/api/messages/admin/report/${b.d.message.id}?why=check`, U.boss);
  assert.equal(det.status, 200);
  assert.deepEqual(det.d.context, { kind: "group", title: "Del", members: 3 }, "minimal context: kind, name, size");
  assert.equal(det.d.message.pictures.length, 1);
  assert.equal(det.d.messages, undefined, "never other messages");
  const pr = await fetch(base + det.d.message.pictures[0].url, { headers: H(U.boss) });
  assert.equal(pr.status, 200);
  assert.match(pr.headers.get("cache-control"), /no-store/);
  const views = await getQuery("SELECT * FROM content_audit_views WHERE admin_id = ? ORDER BY id", [U.boss.userId]);
  assert.ok(views.some((v) => v.target_kind === "message" && v.target_id === String(b.d.message.id) && /group/.test(v.reason)), "the read is logged");
  assert.ok(views.some((v) => v.target_kind === "message_media" && v.target_id === String(b.d.message.id)), "the picture view is logged");
  assert.equal((await fetch(base + det.d.message.pictures[0].url, { headers: H(U.ida) })).status, 403, "admins only");
  assert.equal((await fetch(base + `/api/messages/admin/report/${a.d.message.id}/media/x.webp`, { headers: H(U.boss) })).status, 404, "only reported messages");
  await post("/api/messages/admin/report-action", U.boss, { message: b.d.message.id, action: "dismiss", notify: false });
  sw = await dmmedia.sweep();
  assert.ok(!fs.existsSync(f2), "resolved: purged");
  // unsent uploads are purged after 6 h
  const orphan = await uploadPng(U.jo);
  const fo = dmmedia.filePath((await getQuery("SELECT file FROM dm_media WHERE id = ?", [orphan]))[0].file);
  tick(dmmedia.ORPHAN_TTL + 1000);
  await dmmedia.sweep();
  assert.ok(!fs.existsSync(fo));
});

test("reports in groups work like DMs: members only, admin-only queue marks group messages", async () => {
  const g = await group(U.kim, ["lou", "max"], "Rep");
  const c = g.d.conversation.id;
  const s = await sayIn(U.lou, c, "rude words");
  assert.equal((await post(`/api/messages/m/${s.d.message.id}/report`, U.outsider, { reason: "abuse" })).status, 404);
  assert.equal((await post(`/api/messages/m/${s.d.message.id}/report`, U.max, { reason: "abuse" })).status, 200);
  const sys = (await get(`/api/messages/c/${c}`, U.max)).d.messages.find((m) => m.kind === "system");
  assert.equal((await post(`/api/messages/m/${sys.id}/report`, U.max, { reason: "abuse" })).status, 400, "system lines can't be reported");
  assert.equal((await post(`/api/messages/m/${sys.id}/delete`, U.kim, {})).status, 403, "or deleted");
  const q = await dm.reportQueue();
  assert.equal(q.find((x) => x.messageId === s.d.message.id).group, true);
  assert.equal((await get(`/api/messages/admin/report/${s.d.message.id}`, U.max)).status, 403);
});

test("limits: new groups per day, people added per hour", async () => {
  await mkUser("hub");
  const names = [];
  for (let i = 0; i < 24; i++) names.push((await mkUser("p" + i)).username);
  let made = 0, last;
  for (let i = 0; i < 6; i++) { last = await group(U.hub, [names[i * 2], names[i * 2 + 1]]); if (last.status === 200) made++; }
  assert.equal(made, dm.LIMITS.groups_per_day);
  assert.equal(last.status, 429);
  tick(86400e3);
  // the adds of yesterday's groups don't count any more; now: 20 people per hour
  const g = await group(U.hub, ["p20", "p21"]);                                   // 2
  const c = g.d.conversation.id;
  const many = await post(`/api/messages/c/${c}/members`, U.hub, { usernames: names.slice(0, 7) });   // 9
  assert.equal(many.d.added.length, 7);
  assert.equal((await group(U.hub, names.slice(10, 19))).status, 200);          // 18
  assert.equal((await group(U.hub, ["p19", "p8"])).status, 200);                // 20
  const over = await group(U.p23, ["p22", "p9"]);
  assert.equal(over.status, 200, "another person has their own allowance");
  const g4 = await group(U.hub, ["p7", "p9"]);
  assert.equal(g4.status, 429, "21 > 20 people added in an hour");
  assert.match(g4.d.error, /add 20 people to groups an hour/);
});

// ───────────────────────── post cards ─────────────────────────
async function mkPost(id, extra = {}) {
  await runQuery(`INSERT INTO feed_posts (id, author_id, title, body, created, score, comments, nsfw, deleted_at, hidden_at) VALUES (?, ?, ?, '', ?, ?, 2, ?, ?, ?)`,
                 [id, U.ann.userId, extra.title || "A post", T, extra.score || 7, extra.nsfw ? 1 : 0, extra.deleted ? T : null, extra.hidden ? T : null]);
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created, removed_at) VALUES (?, 'room1', ?, ?)", [id, T, extra.removed ? T : null]);
}
test("post cards: a PATV post link renders a card; deleted / hidden / removed posts are 'unavailable'; NSFW is flagged; other hosts nothing", async () => {
  await mkPost("PostOk01", { title: "Great clip", score: 12 });
  await mkPost("PostDel1", { deleted: true });
  await mkPost("PostHid1", { hidden: true });
  await mkPost("PostRem1", { removed: true });
  await mkPost("PostNsf1", { nsfw: true, title: "spicy" });
  assert.deepEqual(dmembeds.postIds("see https://publicaccess.tv/feed/p/PostOk01, and http://patv.test/feed/p/PostNsf1 https://evil.example/feed/p/PostDel1 https://publicaccess.tv/feed/p/PostOk01"),
                   ["PostOk01", "PostNsf1"], "known hosts only, de-duplicated");
  assert.deepEqual(dmembeds.postIds("https://publicaccess.tv/feed/p/PostOk01/extra https://publicaccess.tv/p/somepad"), []);
  dmembeds._clear();
  const g = await group(U.ben, ["cat", "dan"], "Links");
  const s = await sayIn(U.ben, g.d.conversation.id, "https://publicaccess.tv/feed/p/PostOk01 https://publicaccess.tv/feed/p/PostDel1 https://publicaccess.tv/feed/p/PostHid1");
  const E = s.d.message.embeds;
  assert.equal(E.length, 3);
  assert.equal(E[0].unavailable, false);
  assert.equal(E[0].title, "Great clip");
  assert.equal(E[0].author.username, "ann");
  assert.equal(E[0].score, 12);
  assert.equal(E[0].href, "/feed/p/PostOk01");
  assert.deepEqual(E.slice(1).map((e) => e.unavailable), [true, true]);
  assert.equal(E[1].title, undefined, "nothing about an unavailable post");
  const n = await sayIn(U.ben, g.d.conversation.id, "https://publicaccess.tv/feed/p/PostRem1 https://publicaccess.tv/feed/p/PostNsf1");
  assert.equal(n.d.message.embeds[0].unavailable, true, "removed from every pad");
  assert.equal(n.d.message.embeds[1].nsfw, true);
  // visibility follows the post later on (decided when shown, not when sent)
  await runQuery("UPDATE feed_posts SET deleted_at = ? WHERE id = 'PostOk01'", [T]);
  dmembeds._clear();
  const later = (await get(`/api/messages/c/${g.d.conversation.id}`, U.cat)).d.messages.find((m) => m.id === s.d.message.id);
  assert.equal(later.embeds[0].unavailable, true);
  // the text still links normally (escaped)
  assert.match(s.d.message.html, /<a href="https:\/\/publicaccess\.tv\/feed\/p\/PostOk01" rel="nofollow noopener noreferrer ugc"/);
});

test("the page: share boot data, the new dialogs and the picture button; can't-send-pictures reason in the boot", async () => {
  const r = await fetch(base + "/messages?share=PostNsf1", { headers: { "x-test-user": U.nolink.userId } });
  const html = await r.text();
  for (const id of ["dmNewDlg", "dmMembersDlg", "dmLightbox", "dmAttach", "dmFile", "dmTray", "dmShare"]) assert.ok(html.includes('id="' + id + '"'), id);
  const B = JSON.parse(html.match(/<script type="application\/json" id="dmBoot">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(B.share, { id: "PostNsf1", url: "https://publicaccess.tv/feed/p/PostNsf1" });
  assert.equal(B.me.pictures, false);
  assert.match(B.me.picturesWhy, /level 2/);
  assert.equal(B.maxPics, 4);
  assert.equal(B.groupMax, 10);
  const bad = await fetch(base + "/messages?share=../../x", { headers: { "x-test-user": U.ann.userId } });
  assert.equal(JSON.parse((await bad.text()).match(/id="dmBoot">([\s\S]*?)<\/script>/)[1]).share, null);
});
