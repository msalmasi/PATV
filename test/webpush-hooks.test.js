// 1.99acd: browser notifications through the real paths (webpush.js hooks in messages.js, mentions.js, feedmentions.js): a DM, a
// group message, Pepe's answer, a room mention / alert word on a bridged pad, a feed @mention each queue one content-free push -
// and only after the feature's own rules passed (mute, blocks, quiet hours, pad visibility, the feed switch). Push-only rules on
// top: a late bridge line and a blocked speaker stay inbox-only; an Approved pad is never named; reading the notice first cancels.
//   node --test test/webpush-hooks.test.js      (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "webpush-hooks-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const C = require(path.join(repo, "webpushcrypto"));
const W = require(path.join(repo, "webpush"));
const S = require(path.join(repo, "sessions"));
const dm = require(path.join(repo, "messages"));
const inbox = require(path.join(repo, "inbox"));
const M = require(path.join(repo, "mentions"));
const PA = require(path.join(repo, "padaccess"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);

let T = Date.now();
W._setClock(() => T);
dm._setClock(() => T);
M._setClock(() => T);
const KEYS = C.generate();
const SENT = [];
W._setTransport(async (url, opts) => { SENT.push({ url, opts }); return { status: 201, headers: { get: () => null } }; });

const U = {}, B = {};
async function mkUser(name, o = {}) {
  const id = o.id || "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, o.display || name, o.class || "pleb", o.cf === undefined ? name + "cf" : o.cf]);
  U[name] = { userId: id, username: name, class: o.class || "pleb" };
}
/** A browser with notifications on for `name` (every kind), bound to a live sign-in. */
async function browserFor(name, kinds = "dm,mention,keyword") {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  const b = { endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${crypto.randomBytes(8).toString("hex")}`, priv: e.getPrivateKey(),
              p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  const sid = (await S.create({ get: () => "" }, U[name].userId, "password")).id;
  await runQuery(`INSERT INTO webpush_subs (endpoint, p256dh, auth, user_id, kinds, session_id, vapid_kid, ua, locale, created, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'Chrome on Windows', 'en', ?, ?)`, [b.endpoint, b.p256dh, b.auth, U[name].userId, kinds, sid, KEYS.kid, T, T]);
  B[name] = b;
}
function open(body, b) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(b.priv);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", ecdh.computeSecret(asPublic), Buffer.from(b.auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = out.length - 1;
  while (end >= 0 && out[end] === 0) end--;                 // the padding (zero bytes after the 0x02 delimiter)
  assert.equal(out[end], 0x02, "the last-record delimiter");
  return out.subarray(0, end).toString("utf8");
}
const rowsOf = (name) => getQuery("SELECT * FROM webpush_outbox WHERE user_id = ? ORDER BY id", [U[name].userId]);
const idle = async () => { await M._idle(); await W._idle(); };
const tick = (ms = 1000) => { T += ms; };

const ROOM = { id: "Mention.Room", name: "Mention Room" }, SECRET = { id: "Secret.Room", name: "Secret Room" };
let cur = 5000;
const line = (room, login, text, extra = {}) => ({ roomId: room.id, slug: room.name.toLowerCase().replace(/\s+/g, "-"), name: room.name,
  it: Object.assign({ k: "msg", ts: T, c: ++cur, u: { login, display: login.toUpperCase() }, text }, extra) });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  await mkUser("boss", { class: "Admin" });
  await mkUser("alice", { display: "Alice Sender" });
  await mkUser("bob");
  await mkUser("carol");
  await mkUser("dave");
  await mkUser("plantowner");
  await mkUser("Pepe", { id: "pepe-bot", class: "Bot", cf: null });
  await S.init();
  await inbox.ready;
  await dm.init();
  await M.init();
  await PA.init();
  await rooms.init();
  await rooms.setOwner("plant_based_chatting", "plantowner", "test");
  await rooms.addRoom(SECRET.id, SECRET.name, "test");
  await rooms.setOwner(SECRET.id, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await W.init();
  await W._loadKeys({ VAPID_PUBLIC_KEY: KEYS.publicKey, VAPID_PRIVATE_KEY: KEYS.privateKey, VAPID_SUBJECT: "mailto:ops@example.com" });
  await W.saveSettings({ webpush_enabled: 1, webpush_audience: "everyone" }, U.boss);
  for (const n of ["alice", "bob", "carol", "dave"]) await browserFor(n);
  await browserFor("Pepe");                        // even if Pepe's account had a browser, a DM to him never pushes
  await W.sweep(T);                                // loads the "who has a browser" set
});

test("a DM: one push for the recipient - never the sender; the payload carries no text and no sender", async () => {
  SENT.length = 0;
  const r = await dm.send(U.alice, { to: "bob", body: "SECRET-TEXT-123 meet me at 5" });
  await idle();
  const b = await rowsOf("bob");
  assert.equal(b.length, 1);
  assert.equal(b[0].kind, "dm");
  assert.equal(b[0].url, "/messages/c/" + r.conversation.id);
  assert.equal((await rowsOf("alice")).length, 0, "not the sender");
  await W.drain();
  const req = SENT.find((s) => s.url === B.bob.endpoint);
  const plain = open(req.opts.body, B.bob);
  const p = JSON.parse(plain);
  assert.equal(p.t, "New message");
  assert.equal(p.u, "/messages/c/" + r.conversation.id);
  for (const leak of ["SECRET-TEXT-123", "meet me", "alice", "Alice", "Sender"]) assert.ok(!plain.includes(leak), "no " + leak + " in the payload");
  const row = (await getQuery("SELECT * FROM webpush_outbox WHERE user_id = 'u_bob'"))[0];
  assert.ok(!JSON.stringify(row).includes("SECRET"), "nothing of the text is stored either");
});

test("a muted conversation, a recipient who blocked the sender (in a group too) and Pepe get no push", async () => {
  tick(40e3);
  const r = await dm.send(U.alice, { to: "carol", body: "hello carol" });
  await idle();
  assert.equal((await rowsOf("carol")).length, 1);
  await dm.setMute(U.carol, r.conversation.id, true);
  tick(40e3);
  await dm.send(U.alice, { to: "carol", body: "still there?" });
  await idle();
  assert.equal((await rowsOf("carol")).length, 1, "muted: nothing new");
  await dm.setMute(U.carol, r.conversation.id, false);
  // a group: dave blocks alice after the group exists -> alice's group line pushes to bob, not dave
  tick(1000);
  const g = await dm.createGroup(U.bob, { title: "Plans", members: ["alice", "dave"] });
  await idle();
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_dave', 'u_alice', 1)");
  const d0 = (await rowsOf("dave")).length, b0 = (await rowsOf("bob")).length;
  tick(40e3);
  await dm.send(U.alice, { conversation: g.conversation.id, body: "group hi" });
  await idle();
  assert.equal((await rowsOf("dave")).length, d0, "dave blocks alice: no push");
  assert.equal((await rowsOf("bob")).length, b0 + 1, "bob gets it");
  await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'u_dave'");
  // a message to Pepe: never a push to Pepe's account
  tick(1000);
  const pr = await dm.send(U.carol, { to: "Pepe", body: "hi pepe" });
  await idle();
  assert.equal((await rowsOf("Pepe")).length, 0);
  // Pepe's answer reaches the member
  tick(40e3);
  const c0 = (await rowsOf("carol")).length;
  const ans = await dm.pepeReply({ conversation: pr.conversation.id, upto: 0, text: "ribbit" });
  await idle();
  assert.ok(ans.message);
  const cr = await rowsOf("carol");
  assert.equal(cr.length, c0 + 1);
  assert.equal(cr[cr.length - 1].url, "/messages/c/" + pr.conversation.id);
});

test("room mentions: your name -> a mention push, your word -> an alert-word push; the pad named (not an Approved one)", async () => {
  await W.drain();                                  // the DMs above go out first
  await M.save("u_bob", { enabled: true, names: true, words: [{ phrase: "pizza", room: "" }] });
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES (?, 'public')", [ROOM.id]);
  await PA.load();
  M._sent.clear();
  const b0 = (await rowsOf("bob")).length;
  M.onLines([line(ROOM, "carolcf", "hey bob you around")]);
  await idle();
  let rs = await rowsOf("bob");
  assert.equal(rs.length, b0 + 1);
  const men = rs[rs.length - 1];
  assert.equal(men.kind, "mention");
  assert.equal(men.room_id, ROOM.id);
  assert.match(men.src_key, /^mention:Mention\.Room:/);
  assert.equal(men.check_ref, "inbox:" + men.src_key);
  assert.equal(men.due_at, T + 15e3, "the mention grace");
  tick(61e3);
  M.onLines([line(ROOM, "carolcf", "who wants pizza tonight")]);
  await idle();
  rs = await rowsOf("bob");
  assert.equal(rs[rs.length - 1].kind, "keyword");
  assert.equal(rs[rs.length - 1].due_at, T + 60e3, "the alert-word grace");
  SENT.length = 0;
  tick(61e3);
  await W.drain();
  const titles = SENT.filter((s) => s.url === B.bob.endpoint).map((s) => JSON.parse(open(s.opts.body, B.bob)));
  assert.deepEqual(titles.map((p) => p.t).sort(), ["One of your alert words came up in Mention Room", "You were mentioned in Mention Room"]);
  for (const p of titles) {
    assert.match(p.u, /^\/p\/mention-room\?tab=live&line=\d+$/);
    assert.ok(!JSON.stringify(p).includes("carol") && !JSON.stringify(p).includes("pizza"), "no speaker, no line");
  }
  // an Approved pad bob is inside: alerted, but the push never names the pad
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES (?, 'approved')", [SECRET.id]);
  await runQuery("INSERT OR REPLACE INTO pad_members (room_id, user_id, status) VALUES (?, 'u_bob', 'approved')", [SECRET.id]);
  await PA.load();
  M._sent.clear();
  M.onLines([line(SECRET, "carolcf", "bob, the secret plan")]);
  await idle();
  SENT.length = 0;
  tick(16e3);
  await W.drain();
  const sp = JSON.parse(open(SENT.find((s) => s.url === B.bob.endpoint).opts.body, B.bob));
  assert.equal(sp.t, "You were mentioned");
  assert.ok(!sp.t.includes("Secret") && !sp.b.includes("Secret"), "the text never names an Approved pad (the link still opens it)");
});

test("room mentions: a late bridge line or a blocked speaker -> the notice, no push; muted -> neither (upstream)", async () => {
  const notices = async () => (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u_bob' AND kind = 'mention'"))[0].n;
  M._sent.clear();
  tick(61e3);
  let n0 = await notices(), r0 = (await rowsOf("bob")).length;
  M.onLines([line(ROOM, "carolcf", "bob from ten minutes ago", { ts: T - 10 * 60e3 })]);
  await idle();
  assert.equal(await notices(), n0 + 1, "the 🔔 notice is filed");
  assert.equal((await rowsOf("bob")).length, r0, "a backlog line: no push");
  // bob blocked carol's account (DMs): the notice stays, no push
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_bob', 'u_carol', 1)");
  M._sent.clear();
  tick(61e3);
  n0 = await notices();
  M.onLines([line(ROOM, "carolcf", "bob I'm blocked?")]);
  await idle();
  assert.equal(await notices(), n0 + 1);
  assert.equal((await rowsOf("bob")).length, r0, "a speaker bob blocked: no push");
  // a web-relay line by the blocked account (login u:<userId>) too
  M._sent.clear();
  tick(61e3);
  M.onLines([line(ROOM, "u:u_carol", "bob via the web")]);
  await idle();
  assert.equal((await rowsOf("bob")).length, r0);
  await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'u_bob'");
  // muted: no notice and no push (mentions.js decides that, unchanged)
  await M.mute("u_bob", 60);
  M._sent.clear();
  tick(61e3);
  n0 = await notices();
  M.onLines([line(ROOM, "carolcf", "bob are you muted")]);
  await idle();
  assert.equal(await notices(), n0);
  assert.equal((await rowsOf("bob")).length, r0);
  await M.mute("u_bob", 0);
});

test("reading the 🔔 notice before the grace runs out cancels the push", async () => {
  M._sent.clear();
  tick(61e3);
  M.onLines([line(ROOM, "carolcf", "bob read this quickly")]);
  await idle();
  const r = (await rowsOf("bob")).pop();
  const n = (await getQuery("SELECT id FROM inbox WHERE user_id = 'u_bob' AND ref = ?", [r.src_key]))[0];
  await inbox.markRead("u_bob", n.id);
  SENT.length = 0;
  tick(16e3);
  await W.drain();
  assert.equal((await getQuery("SELECT outcome FROM webpush_outbox WHERE id = ?", [r.id]))[0].outcome, "read");
  assert.equal(SENT.length, 0);
});

test("feed @mentions: a post and a comment push (ctx post / comment); blocks and can't-see stop them upstream", async () => {
  const d0 = (await rowsOf("dave")).length;
  const P = await store.create(U.alice.userId, { community: "plant_based_chatting", title: "Monstera", body: "help me @dave" });
  await idle();
  let rs = await rowsOf("dave");
  assert.equal(rs.length, d0 + 1);
  assert.equal(rs[rs.length - 1].ctx, "post");
  assert.equal(rs[rs.length - 1].tag, "mention:feed");
  assert.equal(rs[rs.length - 1].room_id, null);
  assert.match(rs[rs.length - 1].url, new RegExp(P.id));
  await store.comment(U.carol, P.id, { body: "@dave look at this" });
  await idle();
  rs = await rowsOf("dave");
  assert.equal(rs.length, d0 + 2);
  assert.equal(rs[rs.length - 1].ctx, "comment");
  SENT.length = 0;
  tick(16e3);
  await W.drain();
  const ts = SENT.filter((s) => s.url === B.dave.endpoint).map((s) => JSON.parse(open(s.opts.body, B.dave)).t).sort();
  assert.deepEqual(ts, ["You were mentioned in a comment", "You were mentioned in a post"]);
  // blocked either way: no notice, no push
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_dave', 'u_carol', 1)");
  await store.comment(U.carol, P.id, { body: "@dave again" });
  await idle();
  assert.equal((await rowsOf("dave")).length, d0 + 2);
  await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'u_dave'");
  // a post dave can't see (an Approved pad he's outside of)
  await PA.setLevel(U.plantowner, await rooms.get(SECRET.id), "approved");
  await store.create(U.plantowner.userId, { community: SECRET.id, title: "inside", body: "hi @dave" });
  await idle();
  assert.equal((await rowsOf("dave")).length, d0 + 2);
});

test("users without a browser cost nothing: no queue work, no rows", async () => {
  await mkUser("nobrowser");
  W.onDm("u_nobrowser", { conversationId: "abc", messageId: 1 });
  W.onMention("u_nobrowser", { kind: "mention", srcKey: "x:1", roomId: null });
  await W._idle();
  assert.equal((await rowsOf("nobrowser")).length, 0);
  assert.ok(!W._subsUsers.has("u_nobrowser"));
});
