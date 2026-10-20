// Offline tests for the ✂️ Clip chat card's preview (clipmodal site): POST /api/rooms/:slug/quote {cs, preview: true}
// (quotes.js). The preview sits behind every check Post has (sign-in, same-site JSON, the room, the 18+ gate, the picked
// lines) and the Live tab's own gates (members-tier pad access, the 💎 bridge perk), shows exactly what Post would make (the
// stored lines' names - "someone" for anyone private, their names, PATV username and 2-letter names blanked in the other
// lines - never a login), the price (250 PAT, free with quotes.free) or why it can't be posted (an opt-out, the balance, the
// pad's post rules: a ban, a required flair, the post limits), where it goes and who can see it (+ the approval queue),
// stores and charges nothing, never uses one of the quote rate limit's slots (its own light limit), and names at most 5
// opted-out people per 30 min (the budget Post had).
//   NODE_PATH=G:/PATV/node_modules node --test test/quote-preview.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quote-preview-test-"));
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
const quotes = require(path.join(repo, "quotes"));
const likeness = require(path.join(repo, "likeness"));
const adultgate = require(path.join(repo, "adultgate"));

const ROOM = { id: "Preview.Room", name: "Preview Room" };
const SLUG = "preview-room";
let base, server, U = {};
const users = new Map();
let seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "p-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const u = (login, display) => ({ id: login, login, display: display || login });
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.balance == null ? 100000 : extra.balance, extra.camfrog || null]);
  const x = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, x);
  return x;
}
const H = (x) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, x ? { "x-test-user": x.userId } : {});
async function post(url, x, body, headers) {
  const r = await fetch(base + url, { method: "POST", headers: headers || H(x), body: JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const Q = `/api/rooms/${SLUG}/quote`;
const peek = (x, cs) => post(Q, x, { cs, preview: true });
const sync = (body) => post("/api/bridge/sync", null, Object.assign({ password: "bot" }, body));
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + login).digest("hex").slice(0, 20);
// CL3 + the chat-history owner change (decision 9, cl-site rebased onto clipmodal): the site's sticky hidden set knows WHY someone
// is hidden - Pepe's typed privacy.hidden {scope} - and incognito hides WHO, not WHAT: an incognito speaker's lines are quotable
// as "someone"; a !bridge hide speaker's are LEFT OUT (never quotable - the one not_quotable answer). The set is sticky: only
// Pepe's privacy.shown un-hides (one event per sync, as Pepe sends them). His lists ride along like his real sync - the mixed
// hidden_h, the kinded bridge_hidden_h / incog_hidden_h and tx_hidden_h (his CL1 marker) - so both sticky sets, hubhidden.js's
// and the pad chat archive's chatlog.js, know the kind.
const pev = (type, login, scope) => ({ op: "event", id: "p-" + (++seq), ts: new Date().toISOString(), type, data: { h: hash(login), scope } });
const HIDDEN_NOW = new Map();                              // hash -> kind
const lists = () => {
  const all = [...HIDDEN_NOW.keys()];
  return { hidden_h: all, bridge_hidden_h: all.filter((h) => HIDDEN_NOW.get(h) === "bridge"), incog_hidden_h: all.filter((h) => HIDDEN_NOW.get(h) === "incognito"), tx_hidden_h: [] };
};
async function hideAs(scope, logins) {
  for (const l of logins) { HIDDEN_NOW.set(hash(l), scope); assert.equal((await sync({ events: [pev("privacy.hidden", l, scope)], rooms: [], ...lists() })).status, 200); }
  await new Promise((r) => setTimeout(r, 60));
}
async function showAgain(scope, logins) {
  for (const l of logins) { HIDDEN_NOW.delete(hash(l)); assert.equal((await sync({ events: [pev("privacy.shown", l, scope)], rooms: [], ...lists() })).status, 200); }
  await new Promise((r) => setTimeout(r, 60));
}
const cOf = (text) => bridge.bySlug(SLUG).feed.find((it) => it.text === text).c;
const counts = async () => ({
  posts: (await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n,
  quotes: (await getQuery("SELECT COUNT(*) AS n FROM feed_quotes"))[0].n,
  tx: (await getQuery("SELECT COUNT(*) AS n FROM transactions"))[0].n,
  pts: (await getQuery("SELECT SUM(points_balance) AS n FROM users"))[0].n,
});

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
  U.poor = await mkUser("poor", { balance: 100 });
  U.peeker = await mkUser("peeker");
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.peeker2 = await mkUser("peeker2");
  for (let i = 1; i <= 6; i++) U["opt" + i] = await mkUser("opt" + i, { camfrog: "optcf" + i });
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
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const t0 = Date.now() - 60e3;
  const r = await sync({ rooms: [{ room: ROOM, topic: "t", members: [u("alicecf", "Alice CF"), u("bobcf"), u("carolcf"), u("shycf")], count: 4 }],
    events: [
      ev("message", { user: u("alicecf", "Alice CF"), text: "hello room" }, t0),
      ev("message", { user: u("bobcf"), text: "hey alice, how is it going" }, t0 + 1000),
      ev("x.pepe.transcript", { id: "tx-" + "c".repeat(16), user: u("carolcf"), text: "i am talking on the mic" }, t0 + 2000),
      ev("message", { user: u("shycf"), text: "shy says something about bobcf" }, t0 + 3000),
      ev("message", { user: u("bobcf"), text: "that was funny" }, t0 + 5000),
      ev("message", { user: u("jo"), text: "jo was here" }, t0 + 5500),
      ev("message", { user: u("bobcf"), text: "welcome jo, and alice too" }, t0 + 6000),
      ...Array.from({ length: 6 }, (_, i) => ev("message", { user: u("optcf" + (i + 1)), text: "opt line " + (i + 1) }, t0 + 7000 + i * 100)),
    ] });
  assert.equal(r.status, 200);
});
test.after(() => { server.close(); });
test.beforeEach(() => { quotes._hits.clear(); store._gaps.clear(); quotes.setHidden([]); });

test("preview: behind every check Post has (sign-in, same-site JSON, the room, the 18+ gate, the picked lines)", async () => {
  const cs = [cOf("hello room"), cOf("hey alice, how is it going")];
  assert.equal((await peek(null, cs)).status, 401);
  assert.equal((await post(Q, U.bob, { cs, preview: true }, { "content-type": "application/json", "x-test-user": U.bob.userId })).status, 400, "needs X-Requested-With");
  assert.equal((await post("/api/rooms/no-such-room/quote", U.bob, { cs, preview: true })).status, 404);
  let r = await peek(U.bob, [999999]);
  // CL3 (decision 13): the one answer for a line outside the quoter's own view - it never tells a line that doesn't exist from
  // one below the pad's floor or a left-out person's
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "not_quotable");
  assert.equal(r.d.lines, undefined);
  r = await peek(U.bob, Array.from({ length: 21 }, (_, i) => i + 1));
  assert.equal(r.status, 400);
  assert.match(r.d.error, /at most 20/);
  assert.equal((await peek(U.bob, [])).status, 400);
  // the 18+ gate answers before the lines are looked at
  const real = adultgate.refuseJson;
  let asked = 0;
  adultgate.refuseJson = (req, res, roomId) => { asked++; assert.equal(roomId, ROOM.id); res.status(403).json({ ok: false, adult: true, gate: "confirm" }); return true; };
  try {
    r = await peek(U.bob, cs);
    assert.equal(r.status, 403);
    assert.equal(r.d.adult, true);
    assert.equal(r.d.lines, undefined, "no line, name or count");
    assert.equal(asked, 1);
  } finally { adultgate.refuseJson = real; }
  assert.equal((await peek(U.bob, cs)).status, 200);
});

test("preview shows exactly what Post makes: names as the quote card shows them, mic lines, people, your own lines", async () => {
  const cs = [cOf("hello room"), cOf("hey alice, how is it going"), cOf("i am talking on the mic")];
  const pv = await peek(U.carol, cs);
  assert.equal(pv.status, 200, JSON.stringify(pv.d));
  assert.equal(pv.d.preview, true);
  assert.deepEqual(pv.d.lines.map((l) => [l.name, l.text, l.mic, l.me]),
    [["Alice A", "hello room", false, false], ["bob", "hey alice, how is it going", false, false], ["carol", "i am talking on the mic", true, true]],
    "PATV display names for linked logins; carol's own line marked like the feed marks it for her");
  assert.equal(pv.d.speakers, 3);
  assert.deepEqual(pv.d.save, { cost: 250 }, "the quote price on the button");
  assert.equal(pv.d.why, null);
  const made = await post(Q, U.carol, { cs });
  assert.equal(made.status, 200, JSON.stringify(made.d));
  const p = await store.get(made.d.post.id, U.carol);
  assert.deepEqual(pv.d.lines.map((l) => ({ name: l.name, text: l.text, mic: l.mic, me: l.me })),
                   p.quote.lines.map((l) => ({ name: l.name, text: l.text, mic: l.mic, me: l.me })), "the preview is the posted quote");
  assert.equal(pv.d.speakers, p.quote.speakers);
});

test("privacy: anyone private shows as 'someone' (their name blanked inside other lines too), never a login, no avatar or look", async () => {
  await hideAs("incognito", ["shycf", "bobcf"]);
  try {
  const pv = await peek(U.alice, [cOf("hey alice, how is it going"), cOf("shy says something about bobcf"), cOf("that was funny")]);
  assert.equal(pv.status, 200, JSON.stringify(pv.d));
  assert.deepEqual(pv.d.lines.map((l) => l.name), ["someone", "someone", "someone"]);
  assert.equal(pv.d.lines[1].text, "shy says something about someone", "bob's login inside shy's line is blanked");
  assert.equal(pv.d.speakers, 1, "anonymous people aren't told apart (as on the quote card)");
  const json = JSON.stringify(pv.d);
  assert.doesNotMatch(json, /shycf|bobcf|alicecf|login|avatar|flair|look/, "names only - no logins, avatars or looks");
  for (const l of pv.d.lines) assert.deepEqual(Object.keys(l).sort(), ["me", "mic", "name", "pepe", "text"]);
  // what Post then stores is the same
  const made = await post(Q, U.alice, { cs: [cOf("hey alice, how is it going"), cOf("shy says something about bobcf"), cOf("that was funny")] });
  const row = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [made.d.post.id]))[0];
  assert.deepEqual(JSON.parse(row.lines).map((l) => [l.name, l.text]), pv.d.lines.map((l) => [l.name, l.text]));
  } finally { await showAgain("incognito", ["shycf", "bobcf"]); }
  // !bridge hide: LEFT OUT - a selection with their line is refused (preview and Post alike, the one answer), and they aren't
  // even "someone" in a line nobody hid
  await hideAs("bridge", ["shycf"]);
  try {
    quotes._hits.clear();
    for (const r of [await peek(U.alice, [cOf("hey alice, how is it going"), cOf("shy says something about bobcf")]),
                     await post(Q, U.alice, { cs: [cOf("hey alice, how is it going"), cOf("shy says something about bobcf")] })]) {
      assert.equal(r.status, 403, JSON.stringify(r.d));
      assert.equal(r.d.code, "not_quotable");
      assert.doesNotMatch(JSON.stringify(r.d), /shy says|someone/);
    }
    const ok = await peek(U.alice, [cOf("hey alice, how is it going"), cOf("that was funny")]);
    assert.equal(ok.status, 200, JSON.stringify(ok.d));
    assert.deepEqual(ok.d.lines.map((l) => l.name), ["bob", "bob"], "the people nobody hid keep their names");
  } finally { await showAgain("bridge", ["shycf"]); }
  const back = await peek(U.alice, [cOf("hey alice, how is it going"), cOf("shy says something about bobcf")]);
  assert.equal(back.status, 200, "shown again (Pepe's privacy.shown): quotable again - " + JSON.stringify(back.d));
  assert.deepEqual(back.d.lines.map((l) => l.name), ["bob", "shycf"]);
});

test("price and refusals: 250 PAT, free with quotes.free, an opt-out or a short balance says why (save: null)", async () => {
  const cs = [cOf("hello room")];
  assert.deepEqual((await peek(U.bob, cs)).d.save, { cost: 250 });
  assert.deepEqual((await peek(U.admin, cs)).d.save, { cost: 0 }, "site admins quote free (quotes.free)");
  let r = await peek(U.poor, cs);
  assert.equal(r.status, 200);
  assert.equal(r.d.save, null);
  assert.equal(r.d.why, "A quote costs 250 PAT - you have 100.");
  assert.equal(r.d.lines.length, 1, "the preview still shows what it would be");
  assert.equal((await post(Q, U.poor, { cs })).status, 402, "and Post refuses the same way");
  await likeness.setPrefs(U.carol.userId, { clips: false });
  try {
    const mic = [cOf("i am talking on the mic")];
    r = await peek(U.alice, mic);
    assert.equal(r.d.save, null);
    assert.equal(r.d.why, "carol has opted out of being quoted.");
    assert.doesNotMatch(r.d.why, /charged/, "nothing to charge in a preview");
    assert.deepEqual((await peek(U.carol, mic)).d.save, { cost: 250 }, "quoting yourself is fine");
    assert.equal((await post(Q, U.alice, { cs: mic })).status, 403, "Post refuses it too");
  } finally { await likeness.setPrefs(U.carol.userId, { clips: true }); }
});

test("a preview stores and charges nothing and never uses a quote slot; Post's own limits stay", async () => {
  const cs = [cOf("hello room"), cOf("that was funny")];
  const before = await counts();
  for (let i = 0; i < 3; i++) assert.equal((await peek(U.bob, cs)).status, 200);
  assert.deepEqual(await counts(), before, "no post, no quote row, no ledger line, no points moved");
  const made = await post(Q, U.bob, { cs });
  assert.equal(made.status, 200, "previews didn't use the 1-per-20 s slot: " + JSON.stringify(made.d));
  assert.equal((await peek(U.bob, cs)).status, 200, "previewing right after a post is fine");
  assert.equal((await post(Q, U.bob, { cs })).status, 429, "a second post still waits");
});

test("previews have their own light limit (60 a minute per account)", async () => {
  const cs = [cOf("hello room")];
  let t = Date.now();
  quotes._setClock(() => t);
  try {
    for (let i = 0; i < 60; i++) assert.equal((await peek(U.peeker, cs)).status, 200, "preview " + i);
    const r = await peek(U.peeker, cs);
    assert.equal(r.status, 429);
    assert.match(r.d.error, /too many previews/);
    assert.equal((await peek(U.bob, cs)).status, 200, "per account");
    t += 61 * 1000;
    assert.equal((await peek(U.peeker, cs)).status, 200, "a minute later");
  } finally { quotes._setClock(() => Date.now()); }
});

test("preview: only for someone who can see the Live tab (members-tier pad access, the 💎 bridge perk) - before any line is looked at", async () => {
  const PA = require(path.join(repo, "padaccess")), premium = require(path.join(repo, "premium"));
  const cs = [cOf("hello room")];
  const realFull = PA.full, realBridge = premium.bridgeAllowed;
  try {
    PA.full = (x, id) => (id === ROOM.id ? false : realFull(x, id));
    let r = await peek(U.bob, cs);
    assert.equal(r.status, 403);
    assert.equal(r.d.error, "This pad is for approved members.");
    assert.equal(r.d.lines, undefined, "no line, name or count");
    assert.equal((await peek(U.bob, [999999])).status, 403, "not even which lines exist");
    PA.full = realFull;
    premium.bridgeAllowed = (id) => id !== ROOM.id;
    r = await peek(U.bob, cs);
    assert.equal(r.status, 403);
    assert.equal(r.d.locked, "bridge");
    assert.equal(r.d.lines, undefined);
  } finally { PA.full = realFull; premium.bridgeAllowed = realBridge; }
  assert.equal((await peek(U.bob, cs)).status, 200);
});

test("preview: where it goes and who can see it; the pad's own post rules (a ban, a required flair, the limits) and its approval queue", async () => {
  const PA = require(path.join(repo, "padaccess")), flair = require(path.join(repo, "padflair"));
  const cs = [cOf("hello room")];
  let r = await peek(U.bob, cs);
  assert.deepEqual(r.d.where, { pad: (rooms.getCached(ROOM.id) || {}).title || ROOM.name, who: "all", pending: false }, "its PATV title, else the room's name");
  assert.notEqual(r.d.where.pad, ROOM.id, "never the bare room id");
  const realApproved = PA.isApproved, realApplies = adultgate.applies;
  try {
    PA.isApproved = (id) => id === ROOM.id;
    assert.equal((await peek(U.bob, cs)).d.where.who, "approved", "an Approved pad's posts: its members only");
    PA.isApproved = realApproved;
    adultgate.applies = (id) => id === ROOM.id;
    assert.equal((await peek(U.bob, cs)).d.where.who, "adult", "an 18+ pad with the gate on");
  } finally { PA.isApproved = realApproved; adultgate.applies = realApplies; }
  // the approval queue: said before posting, and Post's answer says it waits
  await store.kvSet("room:" + ROOM.id, JSON.stringify({ approval: true }));
  try {
    r = await peek(U.bob, cs);
    assert.equal(r.d.where.pending, true);
    assert.deepEqual(r.d.save, { cost: 250 }, "still postable");
    const made = await post(Q, U.bob, { cs });
    assert.equal(made.status, 200, JSON.stringify(made.d));
    assert.equal(made.d.pending, true);
    assert.equal((await peek(U.admin, cs)).d.where.pending, false, "someone who manages the pad isn't queued");
  } finally { await store.kvSet("room:" + ROOM.id, "{}"); }
  quotes._hits.clear(); store._gaps.clear();
  assert.equal((await post(Q, U.bob, { cs })).d.pending, false);
  // a feed ban in this pad: the preview says so, Post refuses the same way
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, ?, '', 'test', ?, NULL)", [U.carol.userId, ROOM.id, "carol", Date.now()]);
  try {
    r = await peek(U.carol, cs);
    assert.equal(r.d.save, null);
    assert.match(r.d.why, /^You can't post in /);
    assert.equal(r.d.lines.length, 1, "the preview still shows what it would be");
    assert.equal((await post(Q, U.carol, { cs })).status, 403);
  } finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.carol.userId]); }
  // a pad that wants a flair on every post (a quote carries none)
  const made = await flair.save(U.admin, ROOM.id, { name: "News", color: "#33aa55", kind: "post" });
  await flair.setRequired(U.admin, ROOM.id, true);
  try {
    r = await peek(U.alice, cs);
    assert.equal(r.d.save, null);
    assert.equal(r.d.why, "This pad asks for a flair on every post - pick one.");
    quotes._hits.clear();
    assert.equal((await post(Q, U.alice, { cs })).status, 400, "Post refuses it too");
  } finally { await flair.setRequired(U.admin, ROOM.id, false); for (const f of made) await flair.remove(U.admin, ROOM.id, f.id); }
  // the account's post limits, read without using anything up
  await store.setConfig({ posts_per_hour: 1 }, "test");
  try {
    r = await peek(U.bob, cs);
    assert.equal(r.d.why, "You've posted a lot this hour - try again later.");
    assert.equal((await peek(U.bob, cs)).d.why, r.d.why, "a preview didn't count as a post");
    assert.deepEqual((await peek(U.admin, cs)).d.save, { cost: 0 }, "staff aren't limited");
  } finally { await store.setConfig({ posts_per_hour: 1000 }, "test"); }
  assert.deepEqual((await peek(U.bob, cs)).d.save, { cost: 250 });
});

test("naming opt-outs keeps the quote limit's budget: at most 5 different people per 30 min (one already shown is free)", async () => {
  for (let i = 1; i <= 6; i++) await likeness.setPrefs(U["opt" + i].userId, { clips: false });
  let t = Date.now();
  quotes._setClock(() => t);
  try {
    for (let i = 1; i <= 5; i++) assert.equal((await peek(U.peeker2, [cOf("opt line " + i)])).d.why, `opt${i} has opted out of being quoted.`);
    let r = await peek(U.peeker2, [cOf("opt line 6")]);
    assert.equal(r.status, 200);
    assert.equal(r.d.save, null);
    assert.equal(r.d.why, "Slow down — 5 quotes per 30 min.");
    assert.doesNotMatch(JSON.stringify(r.d), /opted out/, "the sixth isn't named");
    assert.equal((await peek(U.peeker2, [cOf("opt line 2")])).d.why, "opt2 has opted out of being quoted.", "one already shown is free");
    assert.equal((await peek(U.bob, [cOf("opt line 6")])).d.why, "opt6 has opted out of being quoted.", "per account");
    t += 31 * 60 * 1000;
    assert.equal((await peek(U.peeker2, [cOf("opt line 6")])).d.why, "opt6 has opted out of being quoted.", "after the window");
  } finally {
    quotes._setClock(() => Date.now());
    for (let i = 1; i <= 6; i++) await likeness.setPrefs(U["opt" + i].userId, { clips: true });
  }
});

test("privacy: a private speaker's PATV username and a 2-letter name are blanked inside the lines too (preview = what Post stores)", async () => {
  await hideAs("incognito", ["alicecf", "jo"]);
  try {
  const cs = [cOf("hello room"), cOf("jo was here"), cOf("welcome jo, and alice too")];
  const pv = await peek(U.bob, cs);
  assert.equal(pv.status, 200, JSON.stringify(pv.d));
  assert.deepEqual(pv.d.lines.map((l) => [l.name, l.text]),
    [["someone", "hello room"], ["someone", "someone was here"], ["bob", "welcome someone, and someone too"]],
    "alice's PATV username (alice) and jo's 2-letter login are blanked, as whole words");
  const made = await post(Q, U.bob, { cs });
  assert.equal(made.status, 200, JSON.stringify(made.d));
  const row = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [made.d.post.id]))[0];
  assert.deepEqual(JSON.parse(row.lines).map((l) => [l.name, l.text]), pv.d.lines.map((l) => [l.name, l.text]));
  assert.doesNotMatch(row.lines, /alice|\bjo\b/i);
  } finally { await showAgain("incognito", ["alicecf", "jo"]); }
});

// train2 merge: hubhidden.js's start-up state (a test stands in for its first read below)
const HH = require(path.join(repo, "hubhidden"));

test("privacy (train2 merge + CL3 decision 13): a LEFT-OUT speaker's line (an older Pepe's mixed list, !bridge hide) is outside the quoter's view - preview and Post give the one not_quotable answer and make nothing; the other lines are still postable (preview = what Post stores); start-up -> why", async (t) => {
  // (an older Pepe's mixed list hides both kinds in both sticky sets: the cleanup shows both again)
  t.after(async () => { await showAgain("bridge", ["carolcf"]); await showAgain("incognito", ["carolcf"]); });
  await sync({ events: [], rooms: [], hidden_h: [hash("carolcf")] });   // an older Pepe's mixed list: left out (fail closed)
  await new Promise((r) => setTimeout(r, 60));                           // (both sticky sets have taken it)
  assert.deepEqual([quotes.isHidden("carolcf"), quotes.isLeftOut("carolcf")], [true, true]);
  const before = await counts();
  const cs = [cOf("hello room"), cOf("i am talking on the mic")];
  const pv = await peek(U.bob, cs);
  assert.equal(pv.status, 403, JSON.stringify(pv.d));
  assert.equal(pv.d.code, "not_quotable", "her line isn't in bob's view: the one answer, never which line or why");
  assert.doesNotMatch(JSON.stringify(pv.d), /carol|talking on the mic/);
  const no = await post(Q, U.bob, { cs });
  assert.equal(no.status, 403, JSON.stringify(no.d));
  assert.equal(no.d.code, "not_quotable", "Post answers as the preview did");
  const only = await peek(U.bob, [cOf("i am talking on the mic")]);
  assert.deepEqual([only.status, only.d.code], [403, "not_quotable"]);
  assert.deepEqual(await counts(), before, "nothing made or charged");
  // the rest alone is postable, and the preview is what Post stores
  const rest = [cOf("hello room")];
  const pv2 = await peek(U.bob, rest);
  assert.equal(pv2.status, 200, JSON.stringify(pv2.d));
  assert.ok(pv2.d.save, JSON.stringify(pv2.d));
  const made = await post(Q, U.bob, { cs: rest });
  assert.equal(made.status, 200, JSON.stringify(made.d));
  assert.deepEqual([made.d.lines, made.d.left_out], [1, 0]);
  const row = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [made.d.post.id]))[0];
  assert.deepEqual(JSON.parse(row.lines).map((l) => [l.name, l.text]), pv2.d.lines.map((l) => [l.name, l.text]), "preview = what Post stores");
  // while the website is still reading the hidden set at start-up: no lines, and the card says why
  const loading = HH.loading;
  HH.loading = () => true;
  try {
    const st = await peek(U.bob, [cOf("hello room")]);
    assert.equal(st.status, 200, JSON.stringify(st.d));
    assert.deepEqual([st.d.lines.length, st.d.save, st.d.why], [0, null, "The website is just starting up - try again in a moment."]);
  } finally { HH.loading = loading; }
});
