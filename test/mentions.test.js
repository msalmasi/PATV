// Room mention alerts (mentions.js, 1.99ii): whole-word matching of your names + custom words (per room or all), quiet
// hours, mute, the per-user rate limit, pad visibility (Approved pads), hidden / anonymous / own / Pepe lines never
// alerting, the 🔔 notice (kind "mention", link to the pad's live chat at the line) and the bridge hand-off (ingest
// queues the batch's chat lines; the sync never waits). Plus the settings API and page.
//   node --test test/mentions.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mentions-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const M = require(path.join(repo, "mentions"));
const bridge = require(path.join(repo, "bridge"));
const quotes = require(path.join(repo, "quotes"));
const PA = require(path.join(repo, "padaccess"));

let T = Date.parse("2026-10-09T15:00:00Z");
M._setClock(() => T);

const ROOM = { id: "Mention.Room", name: "Mention Room" }, OTHER = { id: "Other.Room", name: "Other Room" };
let seq = 0, cur = 1000;
const line = (room, login, text, extra = {}) => ({ roomId: room.id, slug: bridge.slugify(room.name), name: room.name,
  it: { k: "msg", ts: T, c: ++cur, u: { login, display: login.toUpperCase(), ...extra }, text } });
const notices = async (uid) => getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'mention' ORDER BY id", [uid]);
async function run(lines) { M.onLines(lines); await M._idle(); }
function resetRate() { M._sent.clear(); }

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, level INTEGER DEFAULT 5)`);
  const add = (id, u, d, cf, cls = "pleb") => runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES (?, ?, ?, 'x', ?, ?)", [id, u, d, cf, cls]);
  await add("u_alice", "alice", "Alice Wonder", "alicecf");
  await add("u_bob", "bob", "Bob", "bobcf");
  await add("u_carol", "carol", "Carol", null);
  await add("u_dan", "dan", "Dan", "dancf");
  await inbox.ready;
  await M.init();
  await PA.init();
  await M.save("u_alice", { enabled: true, names: true, words: [{ phrase: "olive oil", room: "" }, { phrase: "heist", room: OTHER.id }] });
  await M.save("u_carol", { enabled: true, names: true, words: [] });
  await M.save("u_dan", { enabled: false, names: true, words: [{ phrase: "pizza" }] });       // off: never
});

test("matcher: whole words, any case, phrases across spaces, unicode-safe", () => {
  const re = M.matcher("bob");
  assert.ok(re.test("hey Bob!")); assert.ok(re.test("BOB")); assert.ok(re.test("@bob what"));
  assert.ok(!re.test("bobby")); assert.ok(!re.test("thebob")); assert.ok(!re.test("bob_cat"));
  assert.ok(M.matcher("olive oil").test("i love olive   oil a lot"));
  assert.ok(M.matcher("café").test("the CAFÉ is open")); assert.ok(!M.matcher("caf").test("café"));
  assert.ok(M.matcher("a.b").test("x a.b y") && !M.matcher("a.b").test("axb"), "regex characters are literal");
  assert.equal(M.matcher("x"), null, "too short");
});

test("quiet hours: plain and past-midnight windows, in the member's time zone", () => {
  const at = (iso) => Date.parse(iso);
  assert.equal(M.inQuiet(at("2026-10-09T23:30:00Z"), 23 * 60, 8 * 60, "UTC"), true);
  assert.equal(M.inQuiet(at("2026-10-09T07:59:00Z"), 23 * 60, 8 * 60, "UTC"), true);
  assert.equal(M.inQuiet(at("2026-10-09T12:00:00Z"), 23 * 60, 8 * 60, "UTC"), false);
  assert.equal(M.inQuiet(at("2026-10-09T13:00:00Z"), 12 * 60, 14 * 60, "UTC"), true);
  assert.equal(M.inQuiet(at("2026-10-09T03:30:00Z"), 23 * 60, 8 * 60, "America/New_York"), true, "23:30 in New York");
  assert.equal(M.inQuiet(at("2026-10-09T13:00:00Z"), 0, 0, "UTC"), false, "from == to: no window");
  assert.equal(M.minuteOfDay(at("2026-10-09T15:42:00Z"), "Not/AZone"), 15 * 60 + 42, "an unknown zone is UTC");
});

test("settings: own names listed, words validated + capped, rooms checked, defaults off", async () => {
  const g = await M.get("u_alice");
  assert.deepEqual(g.names, ["alice", "Alice Wonder", "alicecf"]);
  assert.equal(g.prefs.enabled, true);
  assert.deepEqual(g.words, [{ phrase: "olive oil", room: "" }, { phrase: "heist", room: OTHER.id }]);
  const fresh = await M.get("u_bob");
  assert.equal(fresh.prefs.enabled, false, "off until the member turns it on");
  assert.equal(fresh.prefs.names, true, "own names on by default");
  await assert.rejects(M.save("u_bob", { enabled: true, words: [{ phrase: "x" }] }), /too short/);
  await assert.rejects(M.save("u_bob", { enabled: true, words: Array.from({ length: M.WORDS_MAX + 1 }, (_, i) => ({ phrase: "word" + i })) }), /Up to/);
  await assert.rejects(M.save("u_bob", { enabled: true, words: [{ phrase: "hello", room: "Nope.Room" }] }, new Set([ROOM.id])), /isn't a room/);
  const s = await M.save("u_bob", { enabled: false, words: [{ phrase: " Hello\u0000  World " }, { phrase: "hello world" }], quiet: { from: 60, to: 120, tz: "Europe/London" } });
  assert.deepEqual(s.words, [{ phrase: "Hello World", room: "" }], "cleaned + de-duplicated (case-insensitive)");
  assert.deepEqual(s.prefs.quiet, { from: 60, to: 120, tz: "Europe/London" });
  assert.equal((await M.save("u_bob", { enabled: false, quiet: { from: 60, to: null, tz: "Bad/Zone" } })).prefs.quiet, null, "half a window = none");
});

test("a match files a 🔔 notice: room, speaker, line, link to the line in the pad's live chat", async () => {
  resetRate();
  const L = line(ROOM, "bobcf", "has anyone seen Alice today?");
  await run([L]);
  const n = await notices("u_alice");
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "💬 BOBCF mentioned you in Mention Room");
  assert.equal(n[0].body, "BOBCF: has anyone seen Alice today?");
  assert.equal(n[0].link, `/p/mention-room?tab=live&line=${L.it.c}`);
  assert.equal((await inbox.unreadCount("u_alice")) >= 1, true, "the bell counts it");
  assert.equal((await notices("u_dan")).length, 0, "alerts off: nothing");
});

test("custom words: per room or every room; the title quotes the word", async () => {
  resetRate();
  await run([line(ROOM, "bobcf", "the heist starts soon")]);
  assert.equal((await notices("u_alice")).length, 1, "'heist' is only for Other Room");
  resetRate();
  await run([line(OTHER, "bobcf", "HEIST time")]);
  const n = await notices("u_alice");
  assert.equal(n.length, 2);
  assert.equal(n[1].title, "💬 BOBCF said “heist” in Other Room");
  resetRate();
  await run([line(OTHER, "bobcf", "olive oil > butter")]);
  assert.equal((await notices("u_alice")).length, 3, "every-room word");
});

test("never: your own line, Pepe / bots, anonymous, hidden (incognito / !bridge hide) speakers", async () => {
  resetRate();
  const before = (await notices("u_alice")).length;
  await run([line(ROOM, "alicecf", "alice here, hi")]);
  await run([line(ROOM, "pepefrog", "alice won the heist", { self: true })]);
  await run([line(ROOM, "somebot", "alice!", { bot: true })]);
  await run([{ roomId: ROOM.id, slug: "mention-room", name: ROOM.name, it: { k: "msg", ts: T, c: ++cur, u: { anon: true, display: "someone" }, text: "alice" } }]);
  quotes.setHidden([crypto.createHash("sha256").update("pepe-hidden:sneaky").digest("hex").slice(0, 20)]);
  await run([line(ROOM, "sneaky", "alice is cute")]);
  quotes.setHidden([]);
  assert.equal((await notices("u_alice")).length, before);
});

test("rate limit: one per room per minute, a cap an hour; another room still alerts", async () => {
  resetRate();
  const before = (await notices("u_alice")).length;
  await run([line(ROOM, "bobcf", "alice 1"), line(ROOM, "bobcf", "alice 2")]);
  assert.equal((await notices("u_alice")).length, before + 1, "the second line within a minute is dropped");
  await run([line(OTHER, "bobcf", "alice 3")]);
  assert.equal((await notices("u_alice")).length, before + 2, "another room");
  for (let i = 0; i < M.HOUR_MAX + 3; i++) { T += M.ROOM_GAP_MS; await run([line(ROOM, "bobcf", "alice again " + i)]); }
  assert.equal((await notices("u_alice")).length, before + M.HOUR_MAX, "capped per hour");
  T += 3600e3;
});

test("mute and quiet hours: skipped (not queued)", async () => {
  resetRate();
  const before = (await notices("u_alice")).length;
  await M.mute("u_alice", 60);
  await run([line(ROOM, "bobcf", "alice muted?")]);
  assert.equal((await notices("u_alice")).length, before);
  assert.ok((await M.get("u_alice")).prefs.mutedUntil > T);
  await M.mute("u_alice", 0);
  assert.equal((await M.get("u_alice")).prefs.mutedUntil, null);
  const now = new Date(T), m = now.getUTCHours() * 60 + now.getUTCMinutes();
  const g = await M.get("u_alice");
  await M.save("u_alice", { enabled: true, names: true, words: g.words, quiet: { from: (m + 1430) % 1440, to: (m + 10) % 1440, tz: "UTC" } });
  await run([line(ROOM, "bobcf", "alice quiet?")]);
  assert.equal((await notices("u_alice")).length, before, "inside quiet hours");
  await M.save("u_alice", { enabled: true, names: true, words: g.words, quiet: null });
  await run([line(ROOM, "bobcf", "alice awake?")]);
  assert.equal((await notices("u_alice")).length, before + 1, "after the window");
});

test("pad visibility: an Approved pad alerts only the people inside it", async () => {
  resetRate();
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES (?, 'approved')", [ROOM.id]);
  await PA.load();
  const before = (await notices("u_carol")).length;
  await run([line(ROOM, "bobcf", "carol where are you")]);
  assert.equal((await notices("u_carol")).length, before, "carol isn't an approved member");
  await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES (?, 'u_carol', 'approved')", [ROOM.id]);
  await PA.load();
  T += M.ROOM_GAP_MS;
  await run([line(ROOM, "bobcf", "carol where are you")]);
  assert.equal((await notices("u_carol")).length, before + 1, "approved: alerted (and carol has no Camfrog link - names still match)");
  await runQuery("DELETE FROM pad_access WHERE room_id = ?", [ROOM.id]);
  await PA.load();
});

test("bridge.ingest hands the batch's chat lines over without waiting; the alert links to the line's cursor", async () => {
  resetRate();
  T += M.ROOM_GAP_MS;
  const ev = (type, data) => ({ op: "event", id: "m-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
  const r = await bridge.ingest({ events: [ev("message", { user: { id: "bobcf", login: "bobcf", display: "Bobby" }, text: "Alice Wonder you there" }),
                                          ev("member.join", { user: { id: "x", login: "x" } })], rooms: [] });
  assert.equal(r.items, 2);
  await M._idle();
  const n = await notices("u_alice");
  const last = n[n.length - 1];
  assert.equal(last.title, "💬 Bobby mentioned you in Mention Room");
  const R = bridge.bySlug("mention-room");
  const it = R.feed.find((x) => x.k === "msg" && x.text === "Alice Wonder you there");
  assert.equal(last.link, `/p/mention-room?tab=live&line=${it.c}`);
});

test("routes: settings page + JSON API (same site, fetch, signed in), mute", async () => {
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  M.register(app, { addUser });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, user, hdr = {}) => {
    const h = { "X-Requested-With": "fetch", ...hdr };
    if (user) h["x-test-user"] = user;
    if (body) h["Content-Type"] = "application/json";
    const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    const txt = await r.text();
    let d = null; try { d = JSON.parse(txt); } catch (e) { d = txt; }
    return { status: r.status, d, headers: r.headers };
  };
  try {
    assert.equal((await call("GET", "/settings/mentions", null, null)).status, 302, "signed out -> login");
    const page = await call("GET", "/settings/mentions", null, "u_bob");
    assert.equal(page.status, 200);
    assert.match(page.d, /Room mention alerts/);
    assert.match(page.d, /id="mnBoot"/);
    assert.equal((await call("GET", "/api/mentions", null, null)).status, 401);
    assert.equal((await call("GET", "/api/mentions", null, "u_bob", { "X-Requested-With": "" })).status, 403, "fetch only");
    assert.equal((await call("POST", "/api/mentions", { enabled: true }, "u_bob", { Origin: "https://evil.example" })).status, 403, "same site only");
    const s = await call("POST", "/api/mentions", { enabled: true, names: true, words: [{ phrase: "frog", room: "" }], quiet: null }, "u_bob");
    assert.equal(s.status, 200); assert.equal(s.d.prefs.enabled, true); assert.deepEqual(s.d.words, [{ phrase: "frog", room: "" }]);
    const bad = await call("POST", "/api/mentions", { enabled: true, words: [{ phrase: "frog", room: "Not.Bridged" }] }, "u_bob");
    assert.equal(bad.status, 400);
    const mu = await call("POST", "/api/mentions/mute", { minutes: 60 }, "u_bob");
    assert.equal(mu.status, 200); assert.ok(mu.d.prefs.mutedUntil);
  } finally { server.close(); }
});

test("wiring: the 🔔 category, the room page highlights ?line=, the messages ⚙ links the page", () => {
  assert.ok(inbox.KINDS.mention, "inbox kind");
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /\[\?&\]line=/);
  assert.match(room, /\.line\.hl/);
  assert.match(fs.readFileSync(path.join(repo, "views", "messages.ejs"), "utf8"), /href="\/settings\/mentions"/);
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "messages.js"), "utf8"), /k\.key === 'mention'/, "no Camfrog-PM switch for mentions");
  assert.match(fs.readFileSync(path.join(repo, "index.js"), "utf8"), /require\("\.\/mentions"\)\.register\(app/);
});
