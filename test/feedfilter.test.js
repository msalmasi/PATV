// Offline tests for 1.99ux: the cheap content filter (feedfilter.js) for feed posts and comments.
//   - the scan: obfuscated slurs (leetspeak, spacing, punctuation, repeats, homoglyphs, accents, zero-width, full-width)
//     are caught; allowed words / phrases (Nigeria, sniggering, "chink in the armour") and everyday text aren't
//   - doxxing: phones / IDs / cards / public IPs are strong; an email or an address alone is weak; prices, dates, times,
//     versions, PAT amounts, private IPs, famous addresses don't count
//   - threats vs self-harm vs spam (links, floods, scam lines, the same text again and again)
//   - per-pad opt-in (default off), the master switch, the admin default, profile pads, the pad owner / staff exempt
//   - actions: flag (report, author told), hide (stored hidden, no notices), block (refused, nothing stored or charged),
//     the self-harm path (a private helplines note, never hidden or reported unless the pad asked for a flag)
//   - the owner's release, edits, the admin lists editor (stored in the DB), the admin page, performance
//   NODE_PATH=G:/PATV/node_modules node --test test/feedfilter.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feedfilter-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const terms = require(path.join(repo, "terms"));
const audit = require(path.join(repo, "contentaudit"));
const FF = require(path.join(repo, "feedfilter"));

const OWNED = "plant_based_chatting", OTHER = "Side.Room";
let base, server, U = {}, slug = {};
const users = new Map();
let clock = Date.parse("2026-10-12T16:00:00Z");
const NOW = () => clock;

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned, email)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, ?, ?, 0, ?)`, [id, name, name, extra.class || "pleb", extra.camfrog || null, 0, "2026-01-01 00:00:00", name + "@example.com"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT UNIQUE, xp INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.staff = await mkUser("helper", { class: "Staff", camfrog: "helpercf" });
  U.alice = await mkUser("alice", { camfrog: "alicecf" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  U.sideowner = await mkUser("sideowner", { camfrog: "sidecf" });
  await rooms.init();
  await rooms.setOwner(OWNED, "plantowner", "test");
  await rooms.addRoom(OTHER, "Side Room", "test");
  await rooms.setOwner(OTHER, "sideowner", "test");
  await store.init();
  await terms.init();
  await audit.init();
  await FF.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  for (const u of users.values()) await terms.accept(u.userId);
  store._setClock(NOW);
  FF._setClock(NOW);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  FF.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  slug.owned = (await rooms.get(OWNED)).slug;
  slug.other = (await rooms.get(OTHER)).slug;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); FF._reset(); clock += 60e3; });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const post = (url, u, body) => call("POST", url, u, body);
const get = (url, u) => call("GET", url, u);
async function mkPost(u, body = {}, room = OWNED) {
  const r = await post("/api/feed/posts", u, { body: "hello", community: room, ...body });
  return r;
}
const setPad = (u, s, key, value, reset) => post(`/api/rooms/${encodeURIComponent(s)}/owner/filter`, u, reset ? { key, reset: true } : { key, value });
const admin = (body) => post("/api/feed/admin/filter", U.admin, body);
const inbox = (u) => getQuery("SELECT * FROM inbox WHERE user_id = ? ORDER BY id", [u.userId]).catch(() => []);
const placement = (postId, room = OWNED) => getQuery("SELECT * FROM feed_post_rooms WHERE post_id = ? AND room_id = ?", [postId, room]).then((r) => r[0]);
const filterReports = (postId) => getQuery("SELECT * FROM feed_reports WHERE post_id = ? AND reporter_id = ?", [postId, FF.FILTER_ID]);
const cats = (text, opts) => FF.scan(text, opts).map((h) => h.cat + (h.strength ? ":" + h.strength : "")).sort();

// ───────────────────────────── the scan (pure) ─────────────────────────────
test("hate: obfuscated variants are caught", () => {
  const variants = ["n1gg3r", "n i g g e r", "n.i.g.g.e.r", "n-i-g-g-e-r", "niiiiigggggerrr", "NIGGER", "ｎｉｇｇｅｒ", "nіgger" /* Cyrillic і */,
    "n\u200Bigger" /* zero-width space */, "nìggér", "𝐧𝐢𝐠𝐠𝐞𝐫", "f@gg0t", "f4gg0t", "faaaggot", "ret@rded", "k1ke", "what a f a g", "you are a fag",
    "heil hitler", "gas the jews", "go back to africa", "1488", "dirty niggers lol", "SAND-NIGGER"];
  for (const v of variants) assert.deepEqual(cats(v), ["hate"], v);
});

test("hate: allowed words, idioms and ordinary text are not matched (the Scunthorpe problem)", () => {
  const clean = ["Nigeria and Niger are in West Africa", "stop sniggering at the back", "that was the chink in the armour", "a chink in his armor",
    "fancy a fag break?", "fire retardant foam", "Scunthorpe United", "the raccoon ate my snack", "a tycoon in a cocoon", "Pakistan won the cricket",
    "I'm going to the night market", "my snigger got loud", "Dagobah system", "spick and span", "the spice must flow", "assassin's creed",
    "this game is killing me", "I'd kill for a coffee", "we're all going to die lol", "killer queen", "I was dying laughing"];
  for (const v of clean) assert.deepEqual(cats(v), [], v);
});

test("doxxing: strong signals, weak ones, and the false-positive guards", () => {
  for (const v of ["call me 555-867-5309", "(555) 867-5309", "+44 7700 900123", "07700 900123", "text me at 5558675309", "1-800-555-0199",
                   "his ssn is 123-45-6789", "card 4111 1111 1111 1111", "her ip is 81.2.69.160", "2001:db8:85a3::8a2e:370:7334", "NI: AB 12 34 56 C"]) {
    assert.deepEqual(cats(v), ["doxxing:full"], v);
  }
  for (const v of ["email me at joe@example.com", "123 Main Street", "meet at 12 Acacia Close", "postcode SW1A 2AA"]) assert.deepEqual(cats(v), ["doxxing:weak"], v);
  for (const v of ["she lives at 123 Main Street", "joe@example.com 123 Main St", "here is her address: 42 Elm Road"]) assert.deepEqual(cats(v), ["doxxing:full"], v);
  const clean = ["it costs $1,234.56 on 2026-10-12", "version 1.99.123 released 12/10/2026 at 14:30", "build 10.0.19045.1234", "won 1,000,000 PAT",
    "5000000 points in the jackpot", "the server is 192.168.1.10", "use 8.8.8.8 for dns", "5558675309", "score was 100-20-3000", "order #123-456-7890",
    "10 Downing Street is where the PM lives", "1600 Pennsylvania Avenue", "I live 2 friends down the road", "there were 5 people close to me",
    "my 2fa code expired", "it's 12:30:45 now", "£250 000 0000", "ID 123456789012345678", "my mac is aa:bb:cc:dd:ee:ff", "meet me on 5th avenue",
    "the PS5 2PS bundle", "v1.2.3.4 is out", "ring me later"];
  for (const v of clean) assert.deepEqual(cats(v), [], v);
});

test("threats, self-harm and spam are told apart", () => {
  for (const v of ["I'll fucking kill you", "i will kill you", "kill yourself", "kys", "k y s", "i hope you die", "i know where you live", "im gonna swat you"]) {
    assert.deepEqual(cats(v), ["threats"], v);
  }
  for (const v of ["i want to die", "I'm going to kill myself", "i don't want to live anymore", "been feeling suicidal", "I just want to end it all"]) {
    assert.deepEqual(cats(v), ["selfharm"], v);
  }
  assert.deepEqual(cats("check https://a.com https://b.com https://c.com https://d.com https://e.com"), ["spam"]);
  assert.deepEqual(cats("https://a.com https://b.com", { kind: "post" }), [], "two links in a post is fine");
  assert.deepEqual(cats("visit cheap.com deals.net win.org", { kind: "comment" }), ["spam"], "3 links in a comment");
  assert.deepEqual(cats("a".repeat(40)), ["spam"]);
  assert.deepEqual(cats("lol ".repeat(30)), ["spam"]);
  assert.deepEqual(cats("send me your pat and i'll double it"), ["spam"]);
  assert.deepEqual(cats("admin here: your account will be suspended, click to verify"), ["spam"]);
  assert.deepEqual(cats("----------------------------------------"), [], "a divider line isn't a flood");
});

test("the scan never reports the user's own personal data (only the KIND of match)", () => {
  const h = FF.scan("call 555-867-5309 or mail joe@example.com")[0];
  assert.equal(h.cat, "doxxing");
  assert.deepEqual(h.terms, []);
  assert.ok(!JSON.stringify(h).includes("5309") && !JSON.stringify(h).includes("joe@"));
});

test("performance: a typical post scans in well under 5 ms", () => {
  const para = "Had a great night in the room yesterday, thanks everyone who came! The DJ set at 9pm was 🔥 and we raised 25,000 PAT for the jackpot. " +
    "Next event is Saturday 2026-10-17 at 20:00 UTC - bring friends, check https://publicaccess.tv/p/plant for details. ";
  const text = para.repeat(8);                 // ~2.3k characters
  for (let i = 0; i < 20; i++) FF.scan(text);  // warm-up
  const times = [];
  for (let i = 0; i < 200; i++) { const t0 = process.hrtime.bigint(); FF.scan(text); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  times.sort((a, b) => a - b);
  const median = times[100], p95 = times[190];
  assert.ok(median < 5, `median ${median.toFixed(3)} ms`);
  assert.ok(p95 < 15, `p95 ${p95.toFixed(3)} ms`);
  const long = "word ".repeat(4000);           // a 20k-character worst case still finishes quickly
  const t0 = process.hrtime.bigint(); FF.scan(long); assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 100);
});

test("the built-in list file is base64 (no plain slurs in the public repo) and compiles", () => {
  const raw = fs.readFileSync(FF.LIST_FILE, "utf8");
  assert.ok(!/nigg|fagg|kike/i.test(raw), "not plain text");
  const L = FF.cleanLists(FF.decodeFile(JSON.parse(raw)));
  assert.equal(FF.listProblem(L), null);
  assert.ok(L.hate_words.length > 20 && L.threat_phrases.length > 5 && L.selfharm_phrases.length > 5);
  const again = FF.decodeFile(FF.encodeFile(L));
  assert.deepEqual(FF.cleanLists(again), L, "encode/decode round trip");
});

// ───────────────────────────── settings + the post path ─────────────────────────────
test("opt-in: off by default (nothing filtered), the owner switches it on, it hides + reports + tells the author", async () => {
  let r = await mkPost(U.alice, { body: "you are all niggers" });
  assert.equal(r.status, 200, r.text);
  assert.equal((await placement(r.d.id)).hidden_at, null, "off by default");
  assert.equal((await filterReports(r.d.id)).length, 0);

  assert.equal((await setPad(U.alice, slug.owned, "on", true)).status, 403, "not her pad");
  r = await setPad(U.owner, slug.owned, "on", true);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.filter.on.value, true);
  assert.equal(r.d.filter.actions.hate.value, "hide");

  r = await mkPost(U.alice, { title: "hi", body: "you are all n1ggers" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.safety.action, "hide");
  const pl = await placement(r.d.id);
  assert.ok(pl.hidden_at, "stored hidden");
  assert.equal(pl.hidden_by, FF.BY);
  const reps = await filterReports(r.d.id);
  assert.equal(reps.length, 1);
  assert.equal(reps[0].reason, "hate");
  assert.match(reps[0].note, /Content filter: hate/);
  assert.ok((await store.roomReports(OWNED)).some((g) => g.postId === r.d.id), "in the owner's queue");
  assert.ok((await store.reports()).some((g) => g.post.id === r.d.id), "in the admins' queue");
  assert.ok((await inbox(U.alice)).some((n) => /content filter in p\/.* hid your post/.test(n.title)), "the author is told");
  assert.ok((await inbox(U.owner)).some((n) => /content filter hid a post/.test(n.title)), "the owner is told about a hide");
  const row = (await getQuery("SELECT * FROM feed_filter WHERE post_id = ?", [r.d.id]))[0];
  assert.equal(row.action, "hide");
  assert.equal(row.cats, "hate");
  assert.ok(!/n1gg/.test(row.terms || ""), "the log keeps the list entry, not the user's text");
  // the owner's own post isn't filtered; staff aren't either; the other pad isn't on
  r = await mkPost(U.owner, { body: "quoting someone: n1ggers" });
  assert.equal((await placement(r.d.id)).hidden_at, null, "owner exempt");
  r = await mkPost(U.staff, { body: "quoting: n1ggers" });
  assert.equal((await placement(r.d.id)).hidden_at, null, "staff exempt");
  r = await mkPost(U.alice, { body: "n1ggers" }, OTHER);
  assert.equal((await placement(r.d.id, OTHER)).hidden_at, null, "the other pad hasn't opted in");
  // the daily counts
  const day = await FF.daily(2);
  assert.ok(day[0].cats.hate.hide >= 1);
});

test("block: refused with a message saying why, nothing stored, nothing charged; flag: up + reported", async () => {
  assert.equal((await setPad(U.owner, slug.owned, "act_doxxing", "block")).status, 200);
  const before = (await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n;
  let r = await mkPost(U.alice, { body: "his number is 555-867-5309 lol" });
  assert.equal(r.status, 422, r.text);
  assert.match(r.d.error, /content filter stopped your post: it caught what looks like someone's personal information/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n, before);
  const blk = (await getQuery("SELECT * FROM feed_filter WHERE action = 'block' ORDER BY id DESC"))[0];
  assert.equal(blk.state, "blocked");
  assert.equal(blk.post_id, null);
  assert.ok(!/5309/.test(JSON.stringify(blk)), "the number itself is never stored");
  // a weak signal alone is capped at flag even with block chosen
  r = await mkPost(U.alice, { body: "write to me at alice@example.com" });
  assert.equal(r.status, 200, r.text);
  assert.equal((await placement(r.d.id)).hidden_at, null);
  assert.equal((await filterReports(r.d.id))[0].reason, "personal");
  assert.equal(r.d.safety.action, "flag");
  await setPad(U.owner, slug.owned, "act_doxxing", null, true);
  assert.equal((await FF.effective(OWNED)).actions.doxxing, "hide", "reset to the default");
  // a block on a comment too
  await setPad(U.owner, slug.owned, "act_threats", "block");
  const p = (await mkPost(U.bob, { body: "nice day" })).d.id;
  r = await post(`/api/feed/posts/${p}/comments`, U.alice, { body: "i will kill you" });
  assert.equal(r.status, 422);
  assert.match(r.d.error, /reads as a threat/);
  await setPad(U.owner, slug.owned, "act_threats", null, true);
});

test("comments: a hide is stored hidden with no notices; the owner releases it (author told, report closed); others can't", async () => {
  const p = (await mkPost(U.bob, { body: "what's everyone up to" })).d.id;
  const nb = (await inbox(U.bob)).length;
  let r = await post(`/api/feed/posts/${p}/comments`, U.alice, { body: "shut up you f4gg0t" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.safety.action, "hide");
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [r.d.id]))[0];
  assert.ok(c.hidden_at);
  assert.equal((await inbox(U.bob)).length, nb, "the post's author isn't notified of a hidden comment");
  const row = (await getQuery("SELECT * FROM feed_filter WHERE comment_id = ?", [r.d.id]))[0];
  assert.equal(row.kind, "comment");
  const st = await FF.state(OWNED);
  assert.ok(st.recent.some((x) => x.id === row.id && x.releasable));
  assert.equal(st.counts.hate >= 1, true);
  // release
  assert.equal((await post(`/api/rooms/${slug.owned}/owner/filter/release`, U.carol, { id: row.id })).status, 403);
  assert.equal((await post(`/api/rooms/${slug.other}/owner/filter/release`, U.sideowner, { id: row.id })).status, 404, "not that pad's");
  r = await post(`/api/rooms/${slug.owned}/owner/filter/release`, U.owner, { id: row.id });
  assert.equal(r.status, 200, r.text);
  assert.equal((await getQuery("SELECT hidden_at FROM feed_comments WHERE id = ?", [c.id]))[0].hidden_at, null);
  const rep = (await getQuery("SELECT * FROM feed_reports WHERE comment_id = ? AND reporter_id = ?", [c.id, FF.FILTER_ID]))[0];
  assert.equal(rep.action, "filter-released");
  assert.ok((await inbox(U.alice)).some((n) => /was released/.test(n.title)));
  assert.equal((await getQuery("SELECT state FROM feed_filter WHERE id = ?", [row.id]))[0].state, "released");
});

test("a post release by the owner un-hides it in the pad", async () => {
  const r = await mkPost(U.alice, { body: "gas the jews" });
  const row = (await getQuery("SELECT * FROM feed_filter WHERE post_id = ?", [r.d.id]))[0];
  assert.ok((await placement(r.d.id)).hidden_at);
  const rel = await post(`/api/rooms/${slug.owned}/owner/filter/release`, U.owner, { id: row.id });
  assert.equal(rel.status, 200, rel.text);
  assert.equal((await placement(r.d.id)).hidden_at, null);
});

test("self-harm: a private helplines note, never hidden or reported by default; 'flag' adds the owner's queue", async () => {
  const n0 = (await inbox(U.carol)).length;
  let r = await mkPost(U.carol, { body: "honestly i want to die, nothing is working" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.safety.selfharm, "notice");
  assert.match(r.d.safety.message, /988/);
  assert.equal((await placement(r.d.id)).hidden_at, null, "never hidden");
  assert.equal((await filterReports(r.d.id)).length, 0, "not reported");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_filter WHERE post_id = ?", [r.d.id]))[0].n, 0, "a notice isn't logged per person");
  const ib = await inbox(U.carol);
  assert.equal(ib.length, n0 + 1);
  assert.match(ib[ib.length - 1].body, /Samaritans/);
  assert.ok(!/content filter/i.test(ib[ib.length - 1].title), "no punishment wording");
  // the pad asked for a flag too
  assert.equal((await setPad(U.owner, slug.owned, "act_selfharm", "hide")).status, 400, "self-harm can't be hidden");
  assert.equal((await setPad(U.owner, slug.owned, "act_selfharm", "flag")).status, 200);
  r = await mkPost(U.carol, { body: "i'm going to kill myself" });
  assert.equal((await placement(r.d.id)).hidden_at, null);
  assert.equal((await filterReports(r.d.id))[0].reason, "other");
  await setPad(U.owner, slug.owned, "act_selfharm", null, true);
});

test("spam: the same comment again and again is flagged on the third time", async () => {
  const p = (await mkPost(U.bob, { body: "giveaway thread" })).d.id;
  const ids = [];
  for (let i = 0; i < 3; i++) { const r = await post(`/api/feed/posts/${p}/comments`, U.alice, { body: "join my pad for free stuff!!" }); assert.equal(r.status, 200, r.text); ids.push(r.d.id); }
  const rows = await getQuery(`SELECT * FROM feed_filter WHERE comment_id IN (${ids.map(() => "?").join(",")})`, ids);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].comment_id, ids[2]);
  assert.equal(rows[0].cats, "spam");
  assert.equal(rows[0].kinds, "repeat");
});

test("edits go through the filter: a block refuses the edit, a hide hides the post", async () => {
  const r = await mkPost(U.alice, { body: "selling my old bike" });
  assert.equal((await placement(r.d.id)).hidden_at, null);
  let e = await post(`/api/feed/posts/${r.d.id}/edit`, U.alice, { body: "selling my old bike, call 555-867-5309" });
  assert.equal(e.status, 200, e.text);
  assert.ok((await placement(r.d.id)).hidden_at, "hidden after the edit");
  assert.equal((await getQuery("SELECT edit FROM feed_filter WHERE post_id = ?", [r.d.id]))[0].edit, 1);
  await setPad(U.owner, slug.owned, "act_hate", "block");
  const r2 = await mkPost(U.alice, { body: "clean" });
  e = await post(`/api/feed/posts/${r2.d.id}/edit`, U.alice, { body: "k1ke" });
  assert.equal(e.status, 422);
  assert.equal((await store.getRow(r2.d.id)).body, "clean", "the edit wasn't saved");
  await setPad(U.owner, slug.owned, "act_hate", null, true);
});

test("the master switch and the admin default", async () => {
  // master off: nothing runs, even where a pad switched it on
  assert.equal((await post("/api/feed/admin/filter", U.owner, { global: { enabled: false } })).status, 403, "admins only");
  let r = await admin({ global: { enabled: false } });
  assert.equal(r.status, 200, r.text);
  r = await mkPost(U.alice, { body: "n1ggers" });
  assert.equal((await placement(r.d.id)).hidden_at, null, "master off");
  assert.equal((await FF.state(OWNED)).master, false);
  await admin({ global: { enabled: true } });
  // the default: pads that haven't chosen follow it; a pad that chose off stays off
  await admin({ global: { default_on: true, act_spam: "hide" } });
  r = await mkPost(U.alice, { body: "n1ggers" }, OTHER);
  assert.ok((await placement(r.d.id, OTHER)).hidden_at, "default on");
  assert.equal((await FF.effective(OTHER)).actions.spam, "hide");
  assert.equal((await setPad(U.sideowner, slug.other, "on", false)).status, 200);
  r = await mkPost(U.alice, { body: "n1ggers" }, OTHER);
  assert.equal((await placement(r.d.id, OTHER)).hidden_at, null, "the owner chose off");
  assert.equal((await admin({ global: { act_hate: "explode" } })).status, 400);
  await admin({ global: { default_on: false, act_spam: "flag" } });
});

test("profile pads count as pads: their owner opts in and others' comments are filtered", async () => {
  const P = await rooms.ensureProfile(U.bob.userId);
  assert.ok(rooms.isProfile(P.id));
  const r = await post("/api/feed/posts", U.bob, { body: "my thoughts today", community: P.id });
  assert.equal(r.status, 200, r.text);
  assert.equal((await setPad(U.alice, P.slug, "on", true)).status, 403);
  assert.equal((await setPad(U.bob, P.slug, "on", true)).status, 200);
  const c = await post(`/api/feed/posts/${r.d.id}/comments`, U.alice, { body: "you t r a n n y" });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.d.safety.action, "hide");
  const own = await post(`/api/feed/posts/${r.d.id}/comments`, U.bob, { body: "my number is 555-867-5309" });
  assert.equal(own.d.safety, undefined, "the profile's owner isn't filtered on their own profile");
});

test("admin lock: an admin locks a pad's settings; the owner can't change them", async () => {
  assert.equal((await setPad(U.owner, slug.owned, "admin_lock", true)).status, 403, "owners can't lock");
  assert.equal((await setPad(U.admin, slug.owned, "admin_lock", true)).status, 200);
  assert.equal((await setPad(U.owner, slug.owned, "act_spam", "hide")).status, 403);
  assert.equal((await setPad(U.admin, slug.owned, "admin_lock", false)).status, 200);
  assert.equal((await setPad(U.owner, slug.owned, "act_spam", "allow")).status, 200);
  assert.equal((await setPad(U.owner, slug.owned, "act_spam", "nonsense")).status, 400);
  await setPad(U.owner, slug.owned, "act_spam", null, true);
});

test("the admins' list editor: stored in the DB, applies at once, refuses what doesn't compile, resets to the file", async () => {
  assert.deepEqual(cats("you absolute blorpwhistle"), []);
  assert.equal((await post("/api/feed/admin/filter", U.owner, { lists: { hate_words: "x" } })).status, 403);
  const cur = FF.listsView().lists;
  let r = await admin({ lists: { hate_words: cur.hate_words.concat(["blorpwhistle*"]).join("\n") } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.lists.source, "db");
  assert.deepEqual(cats("you absolute bl0rpwhistles"), ["hate"]);
  const kv = (await getQuery("SELECT value FROM feed_kv WHERE key = 'filter:lists'"))[0];
  assert.ok(kv && /blorpwhistle/.test(kv.value), "in the DB");
  assert.ok(!/blorpwhistle/.test(fs.readFileSync(FF.LIST_FILE, "utf8")), "not in the repo file");
  r = await admin({ lists: { threat_phrases: "[unclosed" } });
  assert.equal(r.status, 400, r.text);
  r = await admin({ lists: { selfharm_phrases: "x".repeat(500) } });
  assert.equal(r.status, 400, "too long");
  r = await admin({ test: "call me 555-867-5309" });
  assert.equal(r.d.hits[0].cat, "doxxing");
  assert.ok(typeof r.d.ms === "number");
  r = await admin({ reset_lists: { confirm: true } });
  assert.equal(r.d.lists.source, "file");
  assert.deepEqual(cats("you absolute blorpwhistle"), []);
});

test("the admin page: admins only; renders the switches, counts, log and lists", async () => {
  assert.equal((await get("/feed/admin/filter", U.owner)).status, 403);
  assert.equal((await get("/feed/admin/filter", U.staff)).status, 403, "lists are admins-only");
  const r = await get("/feed/admin/filter", U.admin);
  assert.equal(r.status, 200, r.text.slice(0, 500));
  assert.match(r.text, /Master switch/);
  assert.match(r.text, /Hits per day/);
  assert.match(r.text, /name="hate_words"/);
});

test("Pepe and posts made on someone's behalf are never filtered", async () => {
  assert.equal(await FF.check({ userId: store.PEPE_ID, username: "Pepe" }, [OWNED], { body: "n1ggers" }), null);
  const v = await FF.check(await store.account(U.alice.userId), [OWNED], { body: "n1ggers" });
  assert.equal(v.action, "hide");
  assert.ok(v.ms < 50);
});
