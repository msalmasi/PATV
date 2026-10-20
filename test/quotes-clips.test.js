// Offline tests for 1.99fp "clip it": chat quotes (quotes.js) and mic clips (micclip.js).
//   quotes: made from the bridge's own copy of the room only (web selection by feed id, Pepe's !quote last / @user / range),
//   never PMs, private people (Pepe's hidden_h) shown as "someone" - also after the fact -, "Remove me" anonymises only
//   the person asking, the text can't be edited, rate limits, the card on the feed / post page / Hop / /p/<pad>/quotes.
//   mic clips: the 🔊 Clip preview request (signed in, linked, the line in the feed, not private, the room's !clip with
//   the admin exemption, one job offered once), Pepe's preview only for the asker, Post = the "micclip.save" action
//   with the trim (pricing is Pepe's: the preview carries the !clip price and save rule), the publish route (a pad post
//   credited to the clipper + who is heard in it) and their "Remove me".
//   NODE_PATH=G:/PATV/node_modules node --test test/quotes-clips.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quotes-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.MICCLIP_DIR = path.join(tmp, "micclip");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const quotes = require(path.join(repo, "quotes"));
const micclip = require(path.join(repo, "micclip"));
const hop = require(path.join(repo, "hop"));

const ROOM = { id: "Quote.Room", name: "Quote Room" };
const SLUG = "quote-room";
let base, server, U = {};
const users = new Map();
let seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "q-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const u = (login, display) => ({ id: login, login, display: display || login });
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  const x = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, x);
  return x;
}
const H = (x) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, x ? { "x-test-user": x.userId } : {});
async function call(method, url, x, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(x), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, r };
}
const post = (url, x, body, headers) => call("POST", url, x, body, headers);
const get = (url, x) => call("GET", url, x);
const sync = (body) => post("/api/bridge/sync", null, Object.assign({ password: "bot" }, body));
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + login).digest("hex").slice(0, 20);
const feedOf = () => bridge.bySlug(SLUG).feed;
const cOf = (text) => feedOf().find((it) => it.text === text).c;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.alice = await mkUser("alice", { camfrog: "alicecf", display: "Alice A" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  U.nolink = await mkUser("nolink");
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  // 1.99qw: a quote costs quote_price PAT (likeness.js) - everyone can afford a few
  await runQuery("UPDATE users SET points_balance = 100000");
  await require(path.join(repo, "funding")).init().catch(() => {});
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await require(path.join(repo, "pepefeed")).ensureAccount();
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  hop.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const t0 = Date.now() - 60e3;
  const r = await sync({ rooms: [{ room: ROOM, topic: "t", members: [u("alicecf", "Alice CF"), u("bobcf"), u("carolcf"), u("shycf")], count: 5, clip: false }],
    events: [
      ev("message", { user: u("alicecf", "Alice CF"), text: "hello room" }, t0),
      ev("message", { user: u("bobcf"), text: "hey alice, how is it going" }, t0 + 1000),
      ev("message.private", { user: u("bobcf"), text: "psst secret pm" }, t0 + 1500),
      ev("message", { user: { id: "anon-1", display: "someone", anonymous: true }, text: "incognito words" }, t0 + 1800),
      ev("x.pepe.transcript", { id: "tx-" + "a".repeat(16), user: u("carolcf"), text: "i am talking on the mic" }, t0 + 2000),
      ev("message", { user: u("shycf"), text: "shy says something about bobcf" }, t0 + 3000),
      ev("message", { user: u("alicecf", "Alice CF"), text: "!balance" }, t0 + 4000),
      ev("message", { user: u("bobcf"), text: "that was funny" }, t0 + 5000),
      ev("message", { user: u("alicecf", "Alice CF"), text: "lol goodbye now" }, t0 + 6000),
    ] });
  assert.equal(r.status, 200);
});
test.after(() => { server.close(); });
test.beforeEach(() => { quotes._hits.clear(); relay._hits.clear(); store._gaps.clear(); quotes.setHidden([]); });

test("pick(): exactly the bridge's lines - no PMs, no anonymous lines, commands only when picked by hand", () => {
  const F = feedOf();
  assert.ok(!F.some((it) => /secret pm|incognito words/.test(it.text || "")), "the bridge never kept them");
  let r = quotes.pick(F, { mode: "last", n: 3 });
  assert.deepEqual(r.items.map((x) => x.text), ["shy says something about bobcf", "that was funny", "lol goodbye now"], "commands are skipped");
  r = quotes.pick(F, { mode: "user", login: "bobcf", n: 1 });
  assert.deepEqual(r.items.map((x) => x.text), ["shy says something about bobcf", "that was funny", "lol goodbye now"], "their last line with one line of context each side");
  r = quotes.pick(F, { mode: "range", from: "hey alice", to: "mic" });
  assert.deepEqual(r.items.map((x) => x.text), ["hey alice, how is it going", "i am talking on the mic"]);
  assert.match(quotes.pick(F, { mode: "range", from: "zzz", to: "funny" }).error, /No line before/);
  assert.match(quotes.pick(F, { mode: "user", login: "nobody", n: 2 }).error, /No recent lines/);
  const cut = F.find((x) => x.text === "that was funny").ts - 1;
  assert.deepEqual(quotes.pick(F, { mode: "last", n: 2 }, cut).items.map((x) => x.text), ["i am talking on the mic", "shy says something about bobcf"], "nothing after the command");
  assert.equal(quotes.pick(F, { cs: [cOf("!balance")] }).items.length, 1, "a hand-picked command line is allowed");
  assert.match(quotes.pick(F, { cs: [999999] }).error, /aren't in the room's feed/);
  assert.match(quotes.pick(F, { cs: Array.from({ length: 21 }, (_, i) => i + 1) }).error, /at most 20/);
});

test("web: ✂️ Clip chat posts a quote card from the picked lines (signed in, same-site JSON, rate-limited)", async () => {
  const cs = [cOf("hello room"), cOf("hey alice, how is it going"), cOf("i am talking on the mic")];
  assert.equal((await post(`/api/rooms/${SLUG}/quote`, null, { cs })).status, 401);
  assert.equal((await post(`/api/rooms/${SLUG}/quote`, U.bob, { cs }, { "content-type": "application/json", "x-test-user": U.bob.userId })).status, 400, "needs X-Requested-With");
  const r = await post(`/api/rooms/${SLUG}/quote`, U.bob, { cs, title: "the start", profile: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.lines, 3);
  const p = await store.get(r.d.post.id, U.carol);
  assert.equal(p.title, "the start");
  assert.equal(p.author.username, "bob");
  assert.deepEqual(p.quote.lines.map((l) => [l.name, l.mic]), [["Alice A", false], ["bob", false], ["carol", true]], "names as the bridge shows them (PATV display names for linked logins), mic lines marked");
  assert.equal(p.quote.speakers, 3);
  assert.equal(p.quote.canRemoveMe, true, "carol is quoted");
  assert.match(p.body, /<Alice A> hello room\n<bob> hey alice/);
  assert.ok(r.d.profile && !r.d.profile.error, "also on bob's profile (a crosspost)");
  // the card renders on the post page
  const html = await (await fetch(base + p.url, { headers: { "x-test-user": U.carol.userId } })).text();
  assert.match(html, /class="fq is-detail"/);
  assert.match(html, /&lt;Alice A&gt;/);
  assert.match(html, /data-act="quote-rm"/, "carol gets Remove me");
  // rate limit
  const again = await post(`/api/rooms/${SLUG}/quote`, U.bob, { cs: [cOf("that was funny")] });
  assert.equal(again.status, 429);
  // the text can't be edited, the title can
  const ed = await post(`/api/feed/posts/${p.id}/edit`, U.bob, { title: "new title", body: "<Alice A> I said something else" });
  assert.equal(ed.status, 200, JSON.stringify(ed.d));
  const p2 = await store.get(p.id, U.bob);
  assert.equal(p2.title, "new title");
  assert.equal(p2.body, p.body, "a quote's words can't be rewritten");
});

test("private people (the owner's decision-9 change): incognito only = 'someone' with their words, !bridge hide or a list that doesn't say why = left out - at creation and after the fact; their name is blanked inside other lines", async () => {
  // a line of bob's that names shy (said before shy hides)
  await sync({ rooms: [], events: [ev("message", { user: u("bobcf"), text: "ask shycf about the vault" })] });
  // (Pepe CL1: a !bridge hide is an event AND a list entry - CL2 fix-up: the event says which kind, so !bridge show un-hides it)
  await sync({ events: [{ op: "event", id: "q-hidden-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", data: { h: hash("shycf"), scope: "bridge" } }],
               rooms: [], hidden_h: [hash("shycf")] });
  assert.equal(quotes.isHidden("shycf"), true);
  const CV = require(path.join(repo, "chatlogview"));
  const CL0 = require(path.join(repo, "chatlog"));
  for (let i = 0; i < 50 && !CL0.isHiddenKey("shycf"); i++) await new Promise((res) => setTimeout(res, 20));   // the sync never waits for the set
  await CV.scheduleNames();
  // CL3: a hidden person's own line is out of every viewer's view (left out, never "someone") - the web route refuses to
  // quote it, with the one answer it gives for any line outside the quoter's view
  const r = await post(`/api/rooms/${SLUG}/quote`, U.alice, { cs: [cOf("shy says something about bobcf"), cOf("that was funny")] });
  assert.equal(r.status, 403, JSON.stringify(r.d));
  assert.equal(r.d.code, "not_quotable");
  // CL3 fix-up: a quote of someone ELSE's line takes the live chat's redaction - the hidden person's name inside it is "someone",
  // in the stored lines and the post's text (it was republished as written while /live showed "someone")
  quotes._hits.clear();
  const rw = await post(`/api/rooms/${SLUG}/quote`, U.alice, { cs: [cOf("ask shycf about the vault")] });
  assert.equal(rw.status, 200, JSON.stringify(rw.d));
  const pw = await store.get(rw.d.post.id, U.alice);
  assert.equal(pw.quote.lines[0].text, "ask someone about the vault");
  const roww = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [pw.id]))[0];
  assert.doesNotMatch(roww.lines + roww.logins + (await store.getRow(pw.id)).body, /shycf/, "never stored");
  // Pepe's own !quote: a hidden person's lines are left out of what it picks, and their name inside other lines is "someone"
  const pq = await post("/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "alicecf", spec: { mode: "last", n: 3 } });
  assert.equal(pq.status, 200, JSON.stringify(pq.d));
  const row = (await getQuery("SELECT * FROM feed_quotes ORDER BY rowid DESC LIMIT 1"))[0];
  assert.doesNotMatch(row.lines + row.logins + (await store.getRow(row.post_id)).body, /shycf|shy says/, "never stored");
  assert.match(row.lines, /ask someone about the vault/);
  // shy shows again (Pepe's explicit un-hide - the sticky set never forgets on its own), then bob goes private later: shown
  // and stored as someone from then on, also inside other lines
  await sync({ events: [{ op: "event", id: "q-shown-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "bridge" } }],
               rooms: [], hidden_h: [] });
  const CL = require(path.join(repo, "chatlog"));
  for (let i = 0; i < 50 && CL.isHiddenKey("shycf"); i++) await new Promise((res) => setTimeout(res, 20));   // the sync never waits for the set
  assert.equal(CL.isHiddenKey("shycf"), false, "un-hidden by Pepe's explicit event");
  quotes.setHidden([]);
  quotes._hits.clear();
  const r2 = await post(`/api/rooms/${SLUG}/quote`, U.alice, { cs: [cOf("hey alice, how is it going"), cOf("shy says something about bobcf")] });
  // the owner's decision-9 change: they go INCOGNITO (Pepe's report - the sticky set says why): shown as someone, with their words
  // (hubhidden's half: setHidden(all, leftOut) - none of them left out)
  quotes.setHidden([hash("shycf"), hash("bobcf")], []);
  await CL.hideNow(["shycf", "bobcf"], "pepe", "incognito");
  await CV.scheduleNames();
  let p2 = await store.get(r2.d.post.id, U.alice);
  assert.deepEqual(p2.quote.lines.map((l) => l.name), ["someone", "someone"]);
  assert.match(p2.quote.lines[1].text, /about someone/, "bob's login inside shy's line is blanked");
  const row2 = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [p2.id]))[0];
  assert.doesNotMatch(row2.lines + row2.logins + (await store.getRow(p2.id)).body, /bobcf/, "anonymised for good");
  assert.deepEqual(JSON.parse(row2.lines).map((l) => l.h), [hash("bobcf"), hash("shycf")], "the stored lines keep only the one-way hash");
  // shy also types !bridge hide: her line is LEFT OUT - the card, the post's text (search, previews, the address) and the count
  await CL.hideNow(["shycf"], "pepe", "bridge");
  p2 = await store.get(r2.d.post.id, U.alice);
  assert.deepEqual(p2.quote.lines.map((l) => [l.name, l.text]), [["someone", "hey alice, how is it going"]]);
  assert.equal(p2.quote.left_out, 1);
  assert.doesNotMatch(p2.body + (await store.getRow(p2.id)).body, /shy says/, "her words are gone from the stored text too");
  // (hubhidden-site's card: the count says a line isn't shown - never whose or what)
  let html = await (await fetch(base + p2.url, { headers: { "x-test-user": U.carol.userId } })).text();
  assert.match(html, /1 line not shown \(private\)/);
  assert.doesNotMatch(html, /shy says/);
  // ...and !bridge show again (still incognito): her line is back, as "someone"
  await sync({ events: [{ op: "event", id: "q-shown-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "bridge" } }], rooms: [] });
  for (let i = 0; i < 50 && CL.hiddenKind(hash("shycf")) !== "anon"; i++) await new Promise((res) => setTimeout(res, 20));
  p2 = await store.get(r2.d.post.id, U.alice);
  assert.deepEqual([p2.quote.lines.length, p2.quote.left_out], [2, 0]);
  assert.match((await store.getRow(p2.id)).body, /<someone> shy says something about someone/);
  // an older Pepe's list alone (hidden_h; the sticky set doesn't know why yet): left out - fail closed
  quotes.setHidden([hash("shycf"), hash("bobcf"), hash("carolcf")]);
  assert.deepEqual([quotes.isHidden("carolcf"), quotes.isLeftOut("carolcf")], [true, true]);
  quotes._hits.clear();
  const r3 = await post(`/api/rooms/${SLUG}/quote`, U.alice, { cs: [cOf("hello room"), cOf("i am talking on the mic")] });
  assert.equal(r3.status, 200, JSON.stringify(r3.d));
  assert.deepEqual([r3.d.lines, r3.d.left_out], [1, 1], "carol's line is not quoted at all");
  assert.doesNotMatch(JSON.stringify(await getQuery("SELECT lines, logins FROM feed_quotes WHERE post_id = ?", [r3.d.post.id])), /carol|talking on the mic/);
  quotes._hits.clear();
  const r4 = await post(`/api/rooms/${SLUG}/quote`, U.alice, { cs: [cOf("i am talking on the mic")] });
  assert.equal(r4.status, 400, "only her lines: nothing to quote");
  // (hubhidden-site's card) a quote whose every line is left out now shows a note - never the stored text
  const p3 = await store.get(r3.d.post.id, U.carol);
  quotes.setHidden([hash("shycf"), hash("bobcf"), hash("carolcf"), hash("alicecf")]);
  const p5 = await store.get(r3.d.post.id, U.carol);
  assert.equal(p3.quote.lines.length, 1);
  assert.deepEqual([p5.quote.lines.length, p5.quote.left_out, p5.body], [0, 1, ""]);
  html = await (await fetch(base + p5.url, { headers: { "x-test-user": U.carol.userId } })).text();
  assert.match(html, /keep their lines private now/);
  assert.doesNotMatch(html, /hello room/);
  quotes.setHidden([hash("shycf"), hash("bobcf"), hash("carolcf")]);
  // either sticky set still reading at start-up (here hubhidden's): no quote is made, a card shows no line and nothing is stored,
  // and tips, mentions, boost and go-live (quotes.isHidden) hide everyone meanwhile
  const HH = require(path.join(repo, "hubhidden"));
  const hhLoading = HH.loading;
  HH.loading = () => true;
  try {
    quotes._hits.clear();
    assert.equal((await post(`/api/rooms/${SLUG}/quote`, U.bob, { cs: [cOf("that was funny")] })).status, 503);
    const before = (await store.getRow(rw.d.post.id)).body;
    const pl = await store.get(rw.d.post.id, U.alice);
    assert.deepEqual([pl.quote.lines.length, (await store.getRow(rw.d.post.id)).body], [0, before], "nothing shown, nothing stored");
    assert.equal(quotes.isHidden("anyonecf"), true);
  } finally { HH.loading = hhLoading; }
  // Pepe's !quote refuses a private target outright (any kind)
  const q = await post("/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "alicecf", spec: { mode: "user", login: "bobcf", n: 2 } });
  assert.equal(q.status, 400);
  // (the next tests quote and clip carol, bob and shy: they show themselves again)
  quotes.setHidden([]);
  for (const l of ["shycf", "bobcf"]) {             // (one sync each: two un-hides at once in a small set are held for an operator)
    await sync({ events: [{ op: "event", id: "q-shown-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash(l), scope: "incognito" } }], rooms: [] });
  }
  for (let i = 0; i < 50 && (CL.isHiddenKey("shycf") || CL.isHiddenKey("bobcf")); i++) await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual([CL.hiddenKind(hash("shycf")), CL.hiddenKind(hash("bobcf"))], [null, null]);
});

test("Remove me: only someone quoted; anonymises just them; idempotent; the author is told", async () => {
  const r = await post(`/api/rooms/${SLUG}/quote`, U.bob, { cs: [cOf("hello room"), cOf("hey alice, how is it going"), cOf("i am talking on the mic")] });
  const id = r.d.post.id;
  assert.equal((await post(`/api/feed/posts/${id}/quote-remove-me`, U.nolink, {})).status, 403, "not linked, not quoted");
  assert.equal((await post(`/api/feed/posts/${id}/quote-remove-me`, U.admin, {})).status, 403, "even an admin isn't quoted");
  const rm = await post(`/api/feed/posts/${id}/quote-remove-me`, U.alice, {});
  assert.equal(rm.status, 200, JSON.stringify(rm.d));
  let p = await store.get(id, U.alice);
  assert.deepEqual(p.quote.lines.map((l) => l.name), ["someone", "bob", "carol"]);
  assert.match(p.quote.lines[1].text, /hey someone, how is it going/, "her name inside bob's line too");
  assert.equal(p.quote.canRemoveMe, false);
  assert.equal(p.quote.removedMe, true);
  assert.doesNotMatch(p.body, /Alice|alicecf/);
  assert.equal((await post(`/api/feed/posts/${id}/quote-remove-me`, U.alice, {})).d.again, true, "idempotent");
  p = await store.get(id, U.carol);
  assert.equal(p.quote.canRemoveMe, true, "the others still can");
  const n = await getQuery("SELECT * FROM inbox WHERE ref = ?", ["quote-rm:" + id]).catch(() => []);
  assert.equal(n.length, 1, "the quote's author is told");
});

test("chat !quote: Pepe's bridge route picks from the feed, credits the linked account (else Pepe), bot token only", async () => {
  assert.equal((await post("/api/bridge/quote", null, { password: "nope", room: ROOM.id, spec: { mode: "last", n: 2 } })).status, 403);
  let r = await post("/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "carolcf", spec: { mode: "last", n: 2 }, title: "bye" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.lines, 2);
  assert.match(r.d.url, /^\/p\/quote-room\/posts\//);
  let p = await store.get(r.d.id, null);
  assert.equal(p.author.username, "carol");
  assert.equal(p.quote.source, "chat");
  r = await post("/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "", spec: { mode: "range", from: "hello", to: "how is" } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  p = await store.get(r.d.id, null);
  assert.equal(p.author.userId, store.PEPE_ID, "a private / unlinked requester: Pepe posts it");
  r = await post("/api/bridge/quote", null, { password: "bot", room: "No.Room", camfrog: "carolcf", spec: { mode: "last", n: 2 } });
  assert.equal(r.status, 404);
  r = await post("/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "carolcf", spec: { mode: "last", n: 2 } });
  assert.equal(r.status, 429, "rate-limited per room + login");
  quotes._hits.clear();
  r = await post("/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "carolcf", spec: { mode: "range", from: "qqq", to: "www" } });
  assert.equal(r.status, 400);
});

test("quotes in the feed list, Hop and /p/<pad>/quotes (with the quote of the day)", async () => {
  const L = await store.list({ room: ROOM.id, quotes: true, sort: "new", viewer: U.alice });
  assert.ok(L.posts.length >= 4 && L.posts.every((p) => p.quote), "the quotes filter");
  const S = await hop.resolveScope("p/" + SLUG);
  const pg = await hop.page(U.alice, S, { sort: "new" });
  const it = pg.items.find((x) => x.media[0] && x.media[0].kind === "quote");
  assert.ok(it, "Hop shows quote cards");
  assert.ok(it.media[0].lines.length >= 1 && it.media[0].lines[0].name);
  // the feeds' Gallery: a quote is a tile with its first line
  const G = require(path.join(repo, "feedgallery"));
  const GS = await G.resolveScope("p/" + SLUG);
  const gp = await G.page(U.alice, GS, { sort: "new" });
  const tile = gp.tiles.find((x) => x.quote);
  assert.ok(tile && tile.quote.name && tile.quote.text && tile.kind === "quote", "gallery quote tile");
  // votes -> quote of the day
  const top = L.posts[L.posts.length - 1];
  await post(`/api/feed/posts/${top.id}/vote`, U.carol, { dir: 1 });
  await post(`/api/feed/posts/${top.id}/vote`, U.admin, { dir: 1 });
  const q = await quotes.quoteOfDay(ROOM.id, null);
  assert.ok(q && q.post.id === top.id, "the best-voted quote of the day");
  const html = await (await fetch(base + `/p/${SLUG}/quotes`, { headers: { "x-test-user": U.alice.userId } })).text();
  assert.match(html, /Quotes from/);
  assert.match(html, /Quote of the day/);
  assert.match(html, /class="fq"/);
});

// ───────────────────────── mic clips ─────────────────────────
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(400, 1)]);
const TX = "tx-" + "a".repeat(16);
async function setClip(on) { await sync({ rooms: [{ room: ROOM, topic: "t", members: [u("alicecf"), u("bobcf"), u("carolcf")], count: 4, clip: on }], events: [] }); }
function takeMicJobs() { return relay.takeJobs(new Set([ROOM.id])).filter((j) => j.kind === "micclip"); }

test("🔊 Clip: the request's rules (signed in, linked, the line in the feed, the !clip switch + the admin exemption)", async () => {
  takeMicJobs();
  await setClip(false);
  assert.equal((await post(`/api/rooms/${SLUG}/micclip`, null, { tx: TX })).status, 401);
  assert.equal((await post(`/api/rooms/${SLUG}/micclip`, U.nolink, { tx: TX })).status, 403, "needs a linked Camfrog name");
  let r = await post(`/api/rooms/${SLUG}/micclip`, U.alice, { tx: TX });
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "E_FEATURE_OFF", "!clip off");
  r = await post(`/api/rooms/${SLUG}/micclip`, U.admin, { tx: TX });
  assert.equal(r.status, 200, "a site admin is exempt (Pepe makes the final call)");
  await setClip(true);
  // CL3 fix-up: a line that isn't there gets the same one answer as one outside the clipper's view (no existence oracle)
  for (const tx of ["tx-" + "f".repeat(16), "nope"]) {
    const x = await post(`/api/rooms/${SLUG}/micclip`, U.alice, { tx });
    assert.deepEqual([x.status, x.d.code, x.d.error], [403, "not_quotable", "That mic line can't be clipped."], "a line that isn't in the feed: " + tx);
  }
  r = await post(`/api/rooms/${SLUG}/micclip`, U.alice, { tx: TX });
  assert.equal(r.status, 200);
  const again = await post(`/api/rooms/${SLUG}/micclip`, U.alice, { tx: TX });
  assert.equal(again.d.id, r.d.id, "asking twice for the same line is the same preview");
  const jobs = takeMicJobs();
  const j = jobs.find((x) => x.id === r.d.id);
  assert.ok(j && j.tx === TX && j.target === "carolcf" && j.camfrog === "alicecf", "Pepe gets the line id, the speaker and the requester's linked name");
  relay._jobs.get(j.id).claimed = Date.now() - 10 * 60e3;
  assert.equal(takeMicJobs().length, 0, "offered once - a re-offer can never start a second clip");
});

test("🔊 Clip on Pepe's own 🎙 line (1.99md): allowed like anyone's, the job targets Pepe's login", async () => {
  takeMicJobs();
  await setClip(true);
  const PTX = "tx-" + "b".repeat(16);
  await sync({ rooms: [{ room: ROOM, topic: "t", members: [u("alicecf"), u("bobcf"), u("carolcf")], count: 4, clip: true }],
    events: [ev("x.pepe.transcript", { id: PTX, user: { id: "pepebeta", login: "pepebeta", display: "PepeBeta", is_self: true }, text: "the vault is open" })] });
  const line = feedOf().find((it) => it.k === "tx" && it.id === PTX);
  assert.ok(line && line.u.self, "Pepe's 🎙 line is in the feed, marked as Pepe");
  U.dave = U.dave || await mkUser("dave", { camfrog: "davecf" });
  const r = await post(`/api/rooms/${SLUG}/micclip`, U.dave, { tx: PTX });
  assert.equal(r.status, 200, "no more \"That's Pepe.\"");
  const j = takeMicJobs().find((x) => x.id === r.d.id);
  assert.ok(j && j.tx === PTX && j.target === "pepebeta" && j.camfrog === "davecf", "Pepe gets his own line's id with himself as the speaker");
  micclip._clips.clear();
});

test("🔊 Clip: the preview is only the asker's; Post queues micclip.save with the trim; Pepe fetches it back by account", async () => {
  await setClip(true);
  micclip._clips.clear();
  const r = await post(`/api/rooms/${SLUG}/micclip`, U.bob, { tx: TX });
  const id = r.d.id;
  assert.equal((await post("/api/bridge/micclip", null, { password: "x", id, state: "ok" })).status, 403);
  let v = (await get(`/api/rooms/${SLUG}/micclip/${id}`, U.bob)).d;
  assert.equal(v.state, "pending");
  assert.equal((await post("/api/bridge/micclip", null, { password: "bot", id, state: "ok", status: "ok", target: "carolcf", secs: 6.0, text: "i am talking on the mic",
    data: M4A.toString("base64"), save: "on", viewer_ok: true, cost: 5000 })).status, 200);
  v = (await get(`/api/rooms/${SLUG}/micclip/${id}`, U.bob)).d;
  assert.equal(v.state, "ready");
  assert.deepEqual(v.save, { cost: 5000, id: null }, "the !clip price, shown before paying");
  assert.equal(v.text, "i am talking on the mic");
  const au = await fetch(base + v.audio, { headers: { "x-test-user": U.bob.userId } });
  assert.equal(au.status, 200);
  assert.equal(au.headers.get("content-type"), "audio/mp4");
  assert.equal((await fetch(base + v.audio, { headers: { "x-test-user": U.alice.userId } })).status, 404, "only the asker hears the preview");
  assert.equal((await get(`/api/rooms/${SLUG}/micclip/${id}`, U.alice)).status, 404);
  assert.equal((await post(`/api/rooms/${SLUG}/micclip/${id}/save`, U.bob, { start: 2000, end: 2500 })).status, 400, "at least 1 second");
  const s = await post(`/api/rooms/${SLUG}/micclip/${id}/save`, U.bob, { start: 1000, end: 99999 });
  assert.equal(s.status, 200, JSON.stringify(s.d));
  const a = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [s.d.id]))[0];
  assert.equal(a.kind, "micclip.save");
  assert.deepEqual(JSON.parse(a.args), [ROOM.id, "carolcf", id, 1000, 6000], "room, speaker, clip, start, end (clamped to the clip)");
  assert.equal(a.camfrog, "bobcf", "Pepe runs it (and charges it) as the viewer's linked name");
  assert.equal((await post("/api/bridge/micclipdata", null, { password: "bot", id, user: "alice" })).status, 404, "another account can't fetch it");
  const d = (await post("/api/bridge/micclipdata", null, { password: "bot", id, user: "bob" })).d;
  assert.equal(d.target, "carolcf");
  assert.equal(Buffer.from(d.data, "base64").length, M4A.length);
  // !clip switched off meanwhile: no saving for members
  await setClip(false);
  micclip._clips.get(id).save = null;
  relay._hits.clear();
  const off = await post(`/api/rooms/${SLUG}/micclip/${id}/save`, U.bob, { start: 0, end: 6000 });
  assert.equal(off.status, 403);
  assert.equal(off.d.code, "E_FEATURE_OFF");
  await setClip(true);
  // Pepe says this viewer may not save (the !clip role gate)
  const r2 = await post(`/api/rooms/${SLUG}/micclip`, U.carol, { tx: TX });
  await post("/api/bridge/micclip", null, { password: "bot", id: r2.d.id, state: "ok", target: "carolcf", secs: 6, data: M4A.toString("base64"), viewer_ok: false, cost: 5000 });
  assert.equal((await get(`/api/rooms/${SLUG}/micclip/${r2.d.id}`, U.carol)).d.save, null);
  assert.equal((await post(`/api/rooms/${SLUG}/micclip/${r2.d.id}/save`, U.carol, { start: 0, end: 6000 })).status, 403);
  // Pepe refused (e.g. the mic-up expired)
  micclip._clips.clear();
  const r3 = await post(`/api/rooms/${SLUG}/micclip`, U.alice, { tx: TX });
  await post("/api/bridge/micclip", null, { password: "bot", id: r3.d.id, state: "failed", status: "Pepe doesn't have that mic-up any more" });
  const v3 = (await get(`/api/rooms/${SLUG}/micclip/${r3.d.id}`, U.alice)).d;
  assert.equal(v3.state, "failed");
  assert.match(v3.status, /doesn't have/);
});

test("publishing a mic clip: a pad post credited to the clipper (waveform card, transcript caption) + Remove me for each voice", async () => {
  const mid = "ab".repeat(8);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, mid + ".m4a"), M4A);
  const now = Date.now();
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, subject_login)
                  VALUES (?, 'audio', 'audio/mp4', ?, ?, 6, 'carolcf & alicecf', 'bobcf', ?, ?, ?, 0, 0, NULL)`, [mid, mid + ".m4a", M4A.length, ROOM.id, now, now + 86400e3]);
  micclip._setDeps({ makePoster: async () => true });
  assert.equal((await post("/api/bridge/micclip/post", null, { password: "no", media: mid })).status, 403);
  const r = await post("/api/bridge/micclip/post", null, { password: "bot", media: mid, by: "bobcf", user: "bob", speakers: ["carolcf", "alicecf"],
    caption: "i am talking on the mic", secs: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const p = await store.get(r.d.id, U.carol);
  assert.equal(p.author.username, "bob", "credited to the clipper");
  assert.equal(p.audio.length, 1);
  assert.match(p.title, /i am talking on the mic/);
  assert.equal(p.voice.canRemoveMe, true, "carol is heard in it");
  assert.equal((await store.get(r.d.id, U.alice)).voice.canRemoveMe, true, "so is alice (a merged clip)");
  assert.equal((await store.get(r.d.id, U.bob)).voice.canRemoveMe, false, "the clipper isn't");
  const again = await post("/api/bridge/micclip/post", null, { password: "bot", media: mid, by: "bobcf", user: "bob", speakers: ["carolcf", "alicecf"], caption: "x" });
  assert.equal(again.d.id, r.d.id, "one post per capture");
  assert.equal((await post(`/api/feed/posts/${r.d.id}/voice-remove-me`, U.nolink, {})).status, 403);
  const rm = await post(`/api/feed/posts/${r.d.id}/voice-remove-me`, U.alice, {});
  assert.equal(rm.status, 200, JSON.stringify(rm.d));
  assert.equal((await store.getRow(r.d.id)).deleted_by, "subject", "the post comes down");
  // a capture whose clipper has no PATV account can't become a post (the story capture stays)
  const mid2 = "cd".repeat(8);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, mid2 + ".m4a"), M4A);
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon) VALUES (?, 'audio', 'audio/mp4', ?, 10, 6, 'x', 'ghostcf', ?, ?, ?, 0, 0)`,
                 [mid2, mid2 + ".m4a", ROOM.id, now, now + 86400e3]);
  assert.equal((await post("/api/bridge/micclip/post", null, { password: "bot", media: mid2, by: "ghostcf", speakers: ["carolcf"] })).status, 409);
});

test("the live view tells the page about the room's !clip switch (🔊 Clip shows where it's on)", async () => {
  await setClip(true);
  const v = (await get(`/api/rooms/${SLUG}/live`, U.alice)).d;
  assert.equal(v.room.clip, true);
  const it = v.feed.find((x) => x.k === "tx");
  assert.equal(it.id, TX, "the 🎙 line carries the id the 🔊 Clip button sends");
});

// ── 1.99sh: the open-clip cap (OPEN_PER_USER) frees up: posted clips, discards, and requests Pepe never answered ──
async function micLines(n, tag) {
  const ids = [];
  const evs = [];
  for (let i = 0; i < n; i++) { const id = "tx-" + tag + String(i).padStart(15, "0"); ids.push(id); evs.push(ev("x.pepe.transcript", { id, user: u("carolcf"), text: "line " + tag + i })); }
  await sync({ rooms: [{ room: ROOM, topic: "t", members: [u("alicecf"), u("bobcf"), u("carolcf")], count: 4, clip: true }], events: evs });
  return ids;
}
async function askClip(x, tx) { relay._hits.clear(); return post(`/api/rooms/${SLUG}/micclip`, x, { tx }); }
async function answer(id) {
  return post("/api/bridge/micclip", null, { password: "bot", id, state: "ok", target: "carolcf", secs: 5, text: "hi", data: M4A.toString("base64"), viewer_ok: true, cost: 0 });
}

test("🔊 Clip cap (1.99sh): post two clips -> can clip a third", async () => {
  micclip._clips.clear(); takeMicJobs();
  U.erin = U.erin || await mkUser("erin", { camfrog: "erincf" });
  const tx = await micLines(3, "1");
  for (const t of tx.slice(0, 2)) {
    const r = await askClip(U.erin, t);
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.equal((await answer(r.d.id)).status, 200);
    relay._hits.clear();
    const s = await post(`/api/rooms/${SLUG}/micclip/${r.d.id}/save`, U.erin, { start: 0, end: 5000 });
    assert.equal(s.status, 200, JSON.stringify(s.d));
  }
  const r3 = await askClip(U.erin, tx[2]);
  assert.equal(r3.status, 200, "posted clips don't count against the cap: " + JSON.stringify(r3.d));
  micclip._clips.clear();
});

test("🔊 Clip cap (1.99sh): two open previews refuse a third, list them with their room, and a discard frees a slot", async () => {
  micclip._clips.clear(); takeMicJobs();
  U.finn = U.finn || await mkUser("finn", { camfrog: "finncf" });
  const tx = await micLines(3, "2");
  const ids = [];
  for (const t of tx.slice(0, 2)) { const r = await askClip(U.finn, t); ids.push(r.d.id); await answer(r.d.id); }
  const no = await askClip(U.finn, tx[2]);
  assert.equal(no.status, 429);
  assert.equal(no.d.code, "E_CLIPS_OPEN");
  assert.deepEqual(no.d.open.map((o) => o.id), ids, "the open ones, oldest first");
  assert.ok(no.d.open.every((o) => o.room === SLUG && o.state === "ready" && o.until > Date.now()), "each with its pad + when it frees itself");
  const d = await post(`/api/rooms/${no.d.open[0].room}/micclip/${ids[0]}/discard`, U.finn, {});
  assert.equal(d.status, 200);
  assert.equal((await askClip(U.finn, tx[2])).status, 200, "discard -> can clip again");
  micclip._clips.clear();
});

test("🔊 Clip cap (1.99sh): a request Pepe never answers stops holding a slot after PENDING_HOLD; a late answer is turned away", async () => {
  micclip._clips.clear(); takeMicJobs();
  U.gus = U.gus || await mkUser("gus", { camfrog: "guscf" });
  const tx = await micLines(3, "3");
  const a = await askClip(U.gus, tx[0]);
  const b = await askClip(U.gus, tx[1]);
  assert.equal((await askClip(U.gus, tx[2])).status, 429, "two in flight = the cap");
  takeMicJobs();   // Pepe took them ... and never answers
  const t0 = Date.now();
  try {
    micclip._setClock(() => t0 + micclip.PENDING_HOLD - 1000);
    assert.equal((await askClip(U.gus, tx[2])).status, 429, "still waiting");
    micclip._setClock(() => t0 + micclip.PENDING_HOLD + 1000);
    const v = (await get(`/api/rooms/${SLUG}/micclip/${a.d.id}`, U.gus)).d;
    assert.equal(v.state, "failed");
    assert.equal(v.code, "E_TIMEOUT");
    const late = await answer(b.d.id);
    assert.equal(late.status, 410, "a late answer doesn't bring it back as an open preview");
    assert.equal(micclip._clips.get(b.d.id).state, "failed");
    const c = await askClip(U.gus, tx[2]);
    assert.equal(c.status, 200, "freed after the timeout: " + JSON.stringify(c.d));
    // a request discarded before Pepe took it is withdrawn from the relay too
    const d = await askClip(U.gus, tx[0]);
    assert.ok(relay._jobs.has(d.d.id));
    assert.equal((await post(`/api/rooms/${SLUG}/micclip/${d.d.id}/discard`, U.gus, {})).status, 200);
    assert.equal(relay._jobs.has(d.d.id), false, "Pepe never gets a discarded request");
  } finally { micclip._setClock(() => Date.now()); micclip._clips.clear(); }
});

test("CL3 fix-up: a mic clip's caption (the transcript, republished on the pad) takes the live chat's redaction of hidden names", async () => {
  const CV = require(path.join(repo, "chatlogview"));
  const CL = require(path.join(repo, "chatlog"));
  await sync({ rooms: [], events: [ev("message", { user: u("zedcf", "Zed Z"), text: "zed was here" })] });
  await sync({ events: [{ op: "event", id: "q-zh-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", data: { h: hash("zedcf"), scope: "bridge" } }], rooms: [] });
  for (let i = 0; i < 50 && !CL.isHiddenKey("zedcf"); i++) await new Promise((res) => setTimeout(res, 20));
  await CV.scheduleNames();
  const mid = "ef".repeat(8);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, mid + ".m4a"), M4A);
  const now = Date.now();
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, subject_login)
                  VALUES (?, 'audio', 'audio/mp4', ?, ?, 6, 'carolcf', 'bobcf', ?, ?, ?, 0, 0, NULL)`, [mid, mid + ".m4a", M4A.length, ROOM.id, now, now + 86400e3]);
  micclip._setDeps({ makePoster: async () => true });
  const r = await post("/api/bridge/micclip/post", null, { password: "bot", media: mid, by: "bobcf", user: "bob", speakers: ["carolcf"],
    caption: "Zed Z and @zedcf owe me one", secs: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const row = await store.getRow(r.d.id);
  assert.doesNotMatch(String(row.title) + String(row.body), /zed/i, "the hidden person's names never reach the post");
  assert.match(String(row.title), /someone and someone owe me one/);
  await sync({ events: [{ op: "event", id: "q-zs-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("zedcf"), scope: "bridge" } }], rooms: [] });
});
