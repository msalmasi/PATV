// Offline tests for 1.99dc: Pepe's feed automod (feedautomod.js), pad rules (padrules.js), Padiquette
// (guidelines.js) and the pad settings hub (padsettings.js).
//   - verdict parsing; the severity -> action mapping (the pad's setting and the model's action are both ceilings,
//     site rules are category-driven, a rule that isn't on the list = no action, CSAM always hides + escalates)
//   - free-speech verdicts ("none", or a made-up rule) change nothing; doxxing / threats / illegal content act
//   - the work queue: only pads with automod on, only content since it was switched on, never Pepe / staff / the
//     pad's owner, the budget (per day + USD) stops it, the master switch
//   - applying: flag = Pepe's report in the owner's queue, hide / remove in that pad, comments too; the author's
//     inbox notice (rule + reason + appeal), the room_events log, idempotent per target
//   - reversal: the owner (not others) puts it back, closes Pepe's report, tells the author, logs it; CSAM = staff only
//   - settings permissions (owner / admin lock / All = admins), pad rules (limits, effective, Padiquette fallback)
//   - pages: the hub (each section), the redirects with anchors, /guidelines, the notice page's access rules
//   NODE_PATH=G:/PATV/node_modules node --test test/feedautomod.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "automod-test-"));
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
const PF = require(path.join(repo, "pepefeed"));
const AM = require(path.join(repo, "feedautomod"));
const RULES = require(path.join(repo, "padrules"));
const G = require(path.join(repo, "guidelines"));

const OWNED = "plant_based_chatting", OTHER = "Side.Room", HOUSE = "PepeFrog.Room";
let base, server, U = {};
const users = new Map();
let clock = Date.parse("2026-10-06T16:00:00Z");
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
  U.sideowner = await mkUser("sideowner", { camfrog: "sidecf" });
  await rooms.init();
  await rooms.setOwner(OWNED, "plantowner", "test");
  await rooms.addRoom(OTHER, "Side Room", "test");
  await rooms.setOwner(OTHER, "sideowner", "test");
  await store.init();
  await terms.init();
  await audit.init();
  await AM.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  for (const u of users.values()) await terms.accept(u.userId);
  PF._setClock(NOW);
  AM._setClock(NOW);
  store._setClock(NOW);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PF.register(app, { addUser, isBotToken: (t) => t === "bot" });
  AM.register(app, { addUser, isBotToken: (t) => t === "bot" });
  RULES.register(app, { addUser });
  G.register(app, { addUser });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, extra) {
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}
const post = (url, u, body, extra) => call("POST", url, u, body, extra);
const get = (url, u) => call("GET", url, u);
const bot = (url, body) => post(url, null, body, { "x-bot-token": "bot" });
async function mkPost(u, body = {}, room = OWNED) {
  const r = await post("/api/feed/posts", u, { body: "hello", community: room, ...body });
  assert.equal(r.status, 200, r.text);
  return r.d.id;
}
async function mkComment(u, postId, body) {
  const r = await post(`/api/feed/posts/${postId}/comments`, u, { body });
  assert.equal(r.status, 200, r.text);
  return r.d.id;
}
const work = async () => { const r = await bot("/api/pepe/feed/sync", {}); assert.equal(r.status, 200, r.text); return r.d.automod; };
const verdict = (target, v, extra = {}) => bot("/api/pepe/feed/automod", { target, room: OWNED, verdict: v, cost: 0.0002, model: "cheap", ...extra });
const V = (action, rule, severity, reason = "because") => ({ action, rule, severity, reason });
const inbox = (u) => getQuery("SELECT * FROM inbox WHERE user_id = ? ORDER BY id", [u.userId]).catch(() => []);
async function turnOn(room = OWNED, patch = {}) {
  clock += 1000;
  const r = await post(`/api/rooms/${room}/automod`, U.owner.userId && room === OWNED ? U.owner : U.admin, { settings: { on: true, ...patch } });
  assert.equal(r.status, 200, r.text);
  clock += 1000;
  return r.d.settings;
}

// ───────────────────────────── pure parts ─────────────────────────────
test("verdict parsing: strict JSON, fenced / with prose, junk -> null, unknown values -> the safe side", () => {
  assert.deepEqual(AM.parseVerdict('{"action":"hide","rule":"doxxing","severity":"severe","reason":"posts an address"}'),
                   { action: "hide", rule: "doxxing", severity: "severe", reason: "posts an address" });
  assert.equal(AM.parseVerdict('ok ```json\n{"action":"FLAG","rule":"[Spam]","severity":"Minor","reason":"ads"}\n``` thanks').rule, "spam");
  assert.deepEqual(AM.parseVerdict({ action: "nuke", rule: "none", severity: "x", reason: "" }), { action: "none", rule: "", severity: "none", reason: "" });
  assert.equal(AM.parseVerdict("looks fine to me"), null);
  assert.equal(AM.parseVerdict('{"action": "flag"'), null);
  assert.equal(AM.parseVerdict(null), null);
  assert.equal(AM.parseVerdict({ action: "flag", rule: "spam", severity: "minor", reason: "x".repeat(900) }).reason.length, 240);
});

test("severity -> action: defaults, the pad's setting and the model's action are ceilings, category-driven site rules, CSAM", async () => {
  const site = (await AM.rulesFor(OTHER)).list;                   // no pad rules: Padiquette
  const D = (v, S = AM.DEFAULTS, list = site) => AM.decide(AM.parseVerdict(v), S, list);
  assert.deepEqual(AM.DEFAULTS, { on: false, minor: "flag", serious: "flag", severe: "hide", admin_lock: false }, "default: flag, auto-hide only severe");
  assert.equal(D(V("remove", "spam", "minor")).action, "flag", "minor -> flag (the pad allows no more)");
  assert.equal(D(V("hide", "harassment", "serious")).action, "flag", "serious -> flag by default");
  assert.equal(D(V("remove", "doxxing", "severe")).action, "hide", "severe -> hide by default (remove needs the owner's OK)");
  assert.equal(D(V("flag", "doxxing", "severe")).action, "flag", "the model unsure (flag) -> only a flag");
  assert.equal(D(V("hide", "doxxing", "minor")).severity, "severe", "site rules: the category decides the severity");
  assert.equal(D(V("hide", "doxxing", "minor")).action, "hide");
  const S = { ...AM.DEFAULTS, severe: "remove" };
  assert.equal(D(V("remove", "threats", "severe"), S).action, "remove", "remove when the owner allows it AND Pepe calls it clear-cut");
  assert.equal(D(V("hide", "threats", "severe"), S).action, "hide", "...otherwise hide");
  assert.equal(D(V("hide", "spam", "minor"), { ...AM.DEFAULTS, minor: "none" }).action, "none", "do nothing");
  // free speech: no action / a rule that isn't on the list -> nothing
  for (const v of [V("none", "", "none", ""), V("flag", "profanity", "minor"), V("hide", "", "serious"), V("flag", "r1", "minor")]) {
    assert.equal(D(v).action, "none", JSON.stringify(v));
  }
  assert.equal(D("not json").action, "none");
  // CSAM: always hide + escalate, even when the pad set severe to nothing
  const c = D(V("flag", "csam", "minor"), { ...AM.DEFAULTS, severe: "none" });
  assert.equal(c.action, "hide"); assert.equal(c.escalate, true); assert.equal(c.report, "csam");
  // pad rules: the model's severity, at most "serious"
  await RULES.set(U.owner, OWNED, { rules: [{ title: "Plants only", desc: "Keep it about plants" }, { title: "No selling" }] });
  const padList = (await AM.rulesFor(OWNED)).list;
  assert.deepEqual(padList.filter((r) => r.pad).map((r) => r.id), ["r1", "r2"]);
  assert.ok(padList.some((r) => r.id === "doxxing") && padList.some((r) => r.id === "spam"), "Padiquette's hard limits always come along, on top of the pad's rules");
  assert.equal(D(V("hide", "r1", "severe"), { ...AM.DEFAULTS, serious: "hide" }, padList).severity, "serious");
  assert.equal(D(V("flag", "r2", "minor"), AM.DEFAULTS, padList).report, "automod");
  await RULES.set(U.owner, OWNED, { rules: [] });
});

test("pad rules: limits, cleaning, renumbering, Padiquette fallback, permissions", async () => {
  assert.equal(await RULES.get(OWNED), null);
  let E = await RULES.effective(OWNED);
  assert.equal(E.source, "site"); assert.equal(E.name, "Padiquette"); assert.equal(E.rules.length, G.RULES.length);
  const many = Array.from({ length: 16 }, (_, i) => ({ title: "Rule " + i }));
  assert.equal((await post(`/api/rooms/${OWNED}/rules`, U.owner, { rules: many })).status, 400, "16 rules is one too many");
  assert.equal((await post(`/api/rooms/${OWNED}/rules`, U.owner, { rules: [{ desc: "no title" }] })).status, 400);
  assert.equal((await post(`/api/rooms/${OWNED}/rules`, U.bob, { rules: [{ title: "mine now" }] })).status, 403);
  assert.equal((await post(`/api/rooms/${OWNED}/rules`, U.sideowner, { rules: [{ title: "x" }] })).status, 403);
  const r = await post(`/api/rooms/${OWNED}/rules`, U.owner, { intro: "Plants!\r\n", rules: [{ title: "  Be kind\n to beginners ", desc: "<b>no</b> gatekeeping" }, { title: "", desc: "" }, { title: "No spam" }] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.rules.rules.map((x) => [x.id, x.title]), [["r1", "Be kind to beginners"], ["r2", "No spam"]], "blank rows dropped, one line, renumbered");
  assert.equal(r.d.effective.source, "pad");
  assert.equal((await post(`/api/rooms/${OWNED}/rules`, U.admin, { rules: [{ title: "Admins can too" }] })).status, 200);
  const ev = await getQuery("SELECT * FROM room_events WHERE room_id = ? AND what = 'feed-rules' ORDER BY ts", [OWNED]);
  assert.ok(ev.length >= 2 && ev.some((e) => e.actor === "boss"));
  assert.equal((await get(`/api/rooms/${OWNED}/rules`, null)).d.rules.rules[0].title, "Admins can too", "public read");
  assert.equal((await post(`/api/rooms/${OWNED}/rules`, U.owner, { intro: "", rules: [] })).status, 200);
  E = await RULES.effective(OWNED);
  assert.equal(E.source, "site", "cleared -> back to Padiquette");
});

// ───────────────────────────── settings ─────────────────────────────
test("settings: off by default; the owner turns it on; admins lock it and own All; owners' pads don't follow All", async () => {
  assert.equal((await AM.settings(OWNED)).on, false);
  assert.equal((await post(`/api/rooms/${OWNED}/automod`, U.bob, { settings: { on: true } })).status, 403);
  assert.equal((await post(`/api/rooms/${OWNED}/automod`, U.sideowner, { settings: { on: true } })).status, 403);
  assert.equal((await post(`/api/feed/admin/automod`, U.owner, { main: { on: true } })).status, 403, "All is admins only");
  const S = await turnOn(OWNED, { minor: "none", severe: "remove", admin_lock: true });
  assert.equal(S.on, true); assert.equal(S.minor, "none"); assert.equal(S.severe, "remove"); assert.equal(S.admin_lock, false, "owners can't lock");
  assert.ok(S.on_since > 0);
  assert.equal((await post(`/api/rooms/${OWNED}/automod`, U.admin, { settings: { admin_lock: true } })).status, 200);
  const locked = await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { on: false } });
  assert.equal(locked.status, 403); assert.match(locked.d.error, /locked/);
  await post(`/api/rooms/${OWNED}/automod`, U.admin, { settings: { admin_lock: false, minor: "flag", severe: "hide" } });
  // All: a house pad without its own follows it; an owner's pad doesn't
  assert.equal((await post(`/api/feed/admin/automod`, U.admin, { main: { on: true }, global: { budget_usd: 0.5 } })).status, 200);
  assert.equal((await AM.settings(HOUSE)).on, true); assert.equal((await AM.settings(HOUSE)).inherited, true);
  assert.equal((await AM.settings(OTHER)).on, false);
  await post(`/api/feed/admin/automod`, U.admin, { main: { on: false }, global: { budget_usd: 0.25 } });
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'feed-automod-settings'", [OWNED])).length);
});

// ───────────────────────────── the work queue ─────────────────────────────
test("work: only pads with it on, only since it was switched on, never Pepe / staff / the pad's owner; the budget stops it", async () => {
  await runQuery("DELETE FROM feed_automod");
  await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { on: false } });
  const before = await mkPost(U.alice, { body: "posted before it was on" });
  clock += 1000;
  await turnOn(OWNED);
  const a = await mkPost(U.alice, { title: "My monstera", body: "look at her go" });
  const byOwner = await mkPost(U.owner, { body: "owner's own" });
  const byStaff = await mkPost(U.staff, { body: "staff post" });
  const elsewhere = await mkPost(U.alice, { body: "side room" }, OTHER);
  const c = await mkComment(U.bob, a, "that's a philodendron, dumbass");
  await mkComment(U.owner, a, "owner comment");
  const W = await work();
  const t = W.items.map((x) => x.target);
  assert.ok(t.includes("p:" + a) && t.includes("c:" + c), JSON.stringify(t));
  for (const x of [before, byOwner, byStaff, elsewhere]) assert.ok(!t.includes("p:" + x), x);
  assert.equal(t.filter((x) => x.startsWith("c:")).length, 1, "not the owner's comment");
  const it = W.items.find((x) => x.target === "p:" + a);
  assert.equal(it.room.id, OWNED); assert.equal(it.post.title, "My monstera"); assert.equal(it.rules.source, "site");
  assert.ok(it.rules.list.some((r) => r.id === "doxxing"));
  const ic = W.items.find((x) => x.target === "c:" + c);
  assert.equal(ic.context.post_title, "My monstera"); assert.match(ic.comment.body, /dumbass/);
  assert.equal(W.caps.enabled, true); assert.equal(W.caps.budget_usd, 0.25);
  // the budget: per day and USD
  await post(`/api/feed/admin/automod`, U.admin, { global: { per_day: 0 } });
  assert.equal((await work()).items.length, 0, "per_day 0 -> nothing");
  await post(`/api/feed/admin/automod`, U.admin, { global: { per_day: 400, budget_usd: 0 } });
  assert.equal((await work()).items.length, 0, "budget $0 -> nothing");
  await post(`/api/feed/admin/automod`, U.admin, { global: { budget_usd: 0.25, enabled: false } });
  assert.equal((await work()).items.length, 0, "master switch off -> nothing");
  await post(`/api/feed/admin/automod`, U.admin, { global: { enabled: true } });
  // old content falls out of the window
  clock += AM.WINDOW + 60e3;
  assert.equal((await work()).items.length, 0, "only fresh content");
});

// ───────────────────────────── applying verdicts ─────────────────────────────
test("free speech: swearing / roasting / politics verdicts change nothing; a made-up rule changes nothing", async () => {
  await runQuery("DELETE FROM feed_automod");
  await turnOn(OWNED);
  const posts = [];
  for (const body of ["Fuck yeah, monstera season", "Roast me, I killed a cactus", "Hot take: politicians are worse than fungus gnats"]) posts.push(await mkPost(U.alice, { body }));
  const r1 = await verdict("p:" + posts[0], V("none", "none", "none", ""));
  const r2 = await verdict("p:" + posts[1], V("hide", "profanity", "minor", "swearing"));
  const r3 = await verdict("p:" + posts[2], V("flag", "", "serious", "political"));
  for (const r of [r1, r2, r3]) { assert.equal(r.status, 200, r.text); assert.equal(r.d.action, "none"); }
  for (const id of posts) {
    assert.ok(!(await getQuery("SELECT 1 FROM feed_reports WHERE post_id = ?", [id])).length, "no report");
    assert.equal((await getQuery("SELECT hidden_at FROM feed_post_rooms WHERE post_id = ?", [id]))[0].hidden_at, null);
  }
  assert.ok(!(await inbox(U.alice)).some((n) => /automod/.test(n.title)), "nobody is told about a non-event");
  const rows = await getQuery("SELECT * FROM feed_automod WHERE target IN (?, ?, ?)", posts.map((x) => "p:" + x));
  assert.ok(rows.every((x) => x.action === "none" && x.state === "clear"));
  assert.equal((await verdict("p:" + posts[0], V("hide", "doxxing", "severe"))).d.already, true, "judged once per target");
});

test("doxxing / threats / illegal content: hidden pending review (default), the owner's queue, the author told, logged", async () => {
  await runQuery("DELETE FROM feed_automod");
  await turnOn(OWNED);
  const dox = await mkPost(U.alice, { body: "he lives at 42 Maple St, go knock" });
  const threat = await mkPost(U.alice, { body: "Kevin I will find you" });
  const drugs = await mkPost(U.alice, { body: "selling pills, DM me" });
  const spam = await mkPost(U.bob, { body: "BUY CHEAP FOLLOWERS" });
  const r = await verdict("p:" + dox, V("remove", "doxxing", "severe", "Posts someone's home address."));
  assert.equal(r.status, 200, r.text); assert.equal(r.d.action, "hide"); assert.equal(r.d.rule, "doxxing");
  assert.equal((await verdict("p:" + threat, V("hide", "threats", "severe", "A threat to hurt someone."))).d.action, "hide");
  assert.equal((await verdict("p:" + drugs, V("remove", "illegal", "severe", "Offers drugs for sale."))).d.action, "hide");
  assert.equal((await verdict("p:" + spam, V("remove", "spam", "minor", "Ad spam."))).d.action, "flag");
  const pl = await getQuery("SELECT post_id, hidden_at, hidden_by FROM feed_post_rooms WHERE post_id IN (?, ?, ?, ?)", [dox, threat, drugs, spam]);
  const hid = Object.fromEntries(pl.map((x) => [x.post_id, x.hidden_by]));
  assert.equal(hid[dox], "pepe-automod"); assert.equal(hid[threat], "pepe-automod"); assert.equal(hid[drugs], "pepe-automod"); assert.equal(hid[spam], null);
  // the flags: Pepe's reports with the rule's category; doxxing/threats/spam in the owner's queue, illegal is admin-only
  const reps = await getQuery("SELECT post_id, reason, note, reporter_id FROM feed_reports WHERE reporter_id = 'pepe-bot'");
  const why = Object.fromEntries(reps.map((x) => [x.post_id, x.reason]));
  assert.equal(why[dox], "personal"); assert.equal(why[threat], "violence"); assert.equal(why[drugs], "illegal"); assert.equal(why[spam], "spam");
  assert.match(reps.find((x) => x.post_id === dox).note, /Pepe automod: Posts someone's home address\. \[No doxxing/);
  const q = (await store.roomReports(OWNED)).map((g) => g.postId);
  assert.ok(q.includes(dox) && q.includes(threat) && q.includes(spam) && !q.includes(drugs));
  // the author's notice: the rule, the reason, the appeal route, a link to the notice page
  const N = (await inbox(U.alice)).filter((n) => /automod/.test(n.title));
  assert.equal(N.length, 3);
  const nd = N.find((n) => n.ref === "automod:" + r.d.id);
  assert.match(nd.title, /Pepe's automod hid your post in p\//);
  assert.match(nd.body, /Rule: No doxxing or private info\. Why: Posts someone's home address\./);
  assert.match(nd.body, /appeal \(\/terms#moderation\)/);
  assert.equal(nd.link, "/feed/automod/" + r.d.id);
  assert.ok((await inbox(U.owner)).some((n) => n.ref === "automod-own:" + r.d.id), "the owner hears about hides");
  // logged
  const ev = await getQuery("SELECT * FROM room_events WHERE room_id = ? AND what = 'feed-automod'", [OWNED]);
  assert.ok(ev.some((e) => e.actor === "Pepe" && /hid post .*No doxxing/.test(e.detail)));
  // a removal the owner allowed: out of the pad
  await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { severe: "remove" } });
  const dox2 = await mkPost(U.alice, { body: "her number is 555-0100" });
  assert.equal((await verdict("p:" + dox2, V("remove", "doxxing", "severe", "Phone number."))).d.action, "remove");
  assert.equal((await getQuery("SELECT removed_by FROM feed_post_rooms WHERE post_id = ?", [dox2]))[0].removed_by, "pepe-automod");
  await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { severe: "hide" } });
  // comments: hidden / removed on their post
  const host = await mkPost(U.bob, { body: "plant swap thread" });
  const cm = await mkComment(U.alice, host, "Kevin I will find you");
  assert.equal((await verdict("c:" + cm, V("hide", "threats", "severe", "A threat."))).d.action, "hide");
  assert.ok((await getQuery("SELECT hidden_at FROM feed_comments WHERE id = ?", [cm]))[0].hidden_at);
});

test("CSAM: always hidden everywhere + the urgent admin path, whatever the pad set; the author is not told", async () => {
  await runQuery("DELETE FROM feed_automod");
  await turnOn(OWNED, { severe: "none" });
  const p = await mkPost(U.alice, { body: "(stand-in text)" });
  const r = await verdict("p:" + p, V("flag", "csam", "minor", "Sexual content involving a minor."));
  assert.equal(r.d.action, "hide");
  assert.ok((await store.getRow(p)).hidden_at, "hidden site-wide");
  assert.equal((await getQuery("SELECT reason FROM feed_reports WHERE post_id = ? AND reporter_id = 'pepe-bot'", [p]))[0].reason, "csam");
  assert.ok((await inbox(U.admin)).some((n) => /URGENT/.test(n.title)), "every admin gets the urgent notice");
  assert.ok(!(await inbox(U.alice)).some((n) => n.ref === "automod:" + r.d.id), "the author isn't tipped off");
  assert.equal((await post(`/api/feed/automod/${r.d.id}/reverse`, U.owner, {})).status, 403, "only staff reverse a CSAM call");
  assert.equal((await get(`/feed/automod/${r.d.id}`, U.owner)).status, 404, "the owner doesn't get the notice page either");
  await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { severe: "hide" } });
});

test("reversal: the owner undoes a hide, closes Pepe's report, the author is told, it's logged; others can't", async () => {
  await runQuery("DELETE FROM feed_automod");
  await turnOn(OWNED);
  const p = await mkPost(U.alice, { body: "this is actually my own address, I'm moving" });
  const r = await verdict("p:" + p, V("hide", "doxxing", "severe", "Posts a home address."));
  const id = r.d.id;
  assert.equal((await post(`/api/feed/automod/${id}/reverse`, U.bob, {})).status, 403);
  assert.equal((await post(`/api/feed/automod/${id}/reverse`, U.sideowner, {})).status, 403);
  assert.equal((await post(`/api/feed/automod/${id}/reverse`, null, {})).status, 401);
  const ok = await post(`/api/feed/automod/${id}/reverse`, U.owner, { note: "it's their own address" });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.d.row.state, "reversed"); assert.equal(ok.d.row.reversed_by, "plantowner");
  assert.equal((await getQuery("SELECT hidden_at FROM feed_post_rooms WHERE post_id = ? AND room_id = ?", [p, OWNED]))[0].hidden_at, null, "back in the pad");
  assert.equal((await getQuery("SELECT action FROM feed_reports WHERE post_id = ? AND reporter_id = 'pepe-bot'", [p]))[0].action, "automod-reversed");
  assert.ok((await inbox(U.alice)).some((n) => n.ref === "automod-rev:" + id && /reversed/.test(n.title)));
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'feed-automod-reverse' AND actor = 'plantowner'", [OWNED])).length);
  assert.equal((await post(`/api/feed/automod/${id}/reverse`, U.owner, {})).status, 200, "idempotent");
  // a removed comment comes back too
  const host = await mkPost(U.bob, { body: "swap" });
  await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { severe: "remove" } });
  const cm = await mkComment(U.alice, host, "call her at 555-0100");
  const rc = await verdict("c:" + cm, V("remove", "doxxing", "severe", "A phone number."));
  assert.equal(rc.d.action, "remove");
  assert.ok((await getQuery("SELECT deleted_at FROM feed_comments WHERE id = ?", [cm]))[0].deleted_at);
  assert.equal((await post(`/api/feed/automod/${rc.d.id}/reverse`, U.admin, {})).status, 200, "admins can reverse anywhere");
  assert.equal((await getQuery("SELECT deleted_at FROM feed_comments WHERE id = ?", [cm]))[0].deleted_at, null);
  await post(`/api/rooms/${OWNED}/automod`, U.owner, { settings: { severe: "hide" } });
  // a "fine" verdict has nothing to reverse
  const fine = await mkPost(U.alice, { body: "fine" });
  const rf = await verdict("p:" + fine, V("none", "none", "none", ""));
  assert.equal((await post(`/api/feed/automod/${rf.d.id}/reverse`, U.owner, {})).status, 409);
});

test("the bot API: token required; skips are recorded; off pads and exempt authors are skipped server-side", async () => {
  await runQuery("DELETE FROM feed_automod");
  await turnOn(OWNED);
  const p = await mkPost(U.alice, { body: "x" });
  assert.equal((await post("/api/pepe/feed/automod", U.admin, { target: "p:" + p, verdict: V("hide", "doxxing", "severe") })).status, 403);
  assert.equal((await bot("/api/pepe/feed/automod", { target: "p:nope", room: OWNED })).status, 404);
  const s = await bot("/api/pepe/feed/automod", { target: "p:" + p, room: OWNED, skip: "no verdict: unparseable reply", cost: 0.0001 });
  assert.equal(s.d.skipped, "no verdict: unparseable reply");
  const o = await mkPost(U.owner, { body: "owner" });
  assert.match((await verdict("p:" + o, V("hide", "doxxing", "severe"))).d.skipped, /exempt: pad owner/);
  const side = await mkPost(U.alice, { body: "side" }, OTHER);
  assert.equal((await bot("/api/pepe/feed/automod", { target: "p:" + side, room: OTHER, verdict: V("hide", "doxxing", "severe") })).d.skipped, "automod is off there");
  assert.equal((await AM.usage()).count, 3, "every verdict / skip counts toward the day");
  assert.ok((await AM.usage()).cost > 0);
});

// ───────────────────────────── pages ─────────────────────────────
test("the settings hub: every section, Pepe's switch on top, the automod + rules forms; owners + staff only", async () => {
  const h = await get(`/p/${OWNED}/settings`, U.owner);
  assert.equal(h.status, 200, h.text.slice(0, 300));
  for (const id of ["general", "stage", "feed", "pepe", "rules", "moderation", "camfrog"]) assert.match(h.text, new RegExp(`<section class="ps-sec[^"]*" id="${id}"`), id);
  for (const a of ["royalties", "announce", "settings", "queue", "reports", "members", "bans", "audit", "automod", "automodlog", "pins"]) assert.match(h.text, new RegExp(`id="${a}"`), "anchor " + a);
  assert.match(h.text, /id="psPepeOn"[^>]* checked/, "Pepe on this pad's feed: a clear switch, on by default");
  assert.match(h.text, /<b>Pepe on this pad's feed<\/b>/);
  assert.match(h.text, /id="psAutomod"/); assert.match(h.text, /name="severe"/);
  assert.ok(!/name="admin_lock"/.test(h.text.split('id="psAutomod"')[1].split("</form>")[0]), "owners get no lock");
  assert.match(h.text, /id="psRules"/);
  assert.match(h.text, /Reverse<\/button>|No automod calls yet|automod-/);
  assert.equal((await get(`/p/${OWNED}/settings`, U.bob)).status, 403);
  assert.equal((await get(`/p/${OWNED}/settings`, null)).status, 302);
  const a = await get(`/p/${OTHER}/settings`, U.admin);
  assert.equal(a.status, 200); assert.match(a.text, /Site staff: you see every pad's hub/); assert.match(a.text, /href="\/feed\/admin#pepe"/);
  // the master switch works and Pepe stays off there
  assert.equal((await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { enabled: false } })).status, 200);
  assert.equal((await PF.scopeSettings(OWNED)).enabled, false);
  assert.match(PF.gate("comment", "mention", await PF.scopeSettings(OWNED), await PF.globalCaps(), await PF.usage(), { scope: OWNED }), /switched off in this pad/);
  assert.match((await get(`/p/${OWNED}/settings`, U.owner)).text, /id="psPepeOn"(?![^>]* checked)/);
  await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { enabled: true } });
});

test("redirects: /manage + /mod (and the old /rooms addresses) land on the hub's tab; the browser keeps #anchors", async () => {
  for (const [from, to] of [[`/p/${OWNED}/manage`, `/p/${OWNED}/settings?tab=stage`], [`/p/${OWNED}/mod`, `/p/${OWNED}/settings?tab=moderation`],
                            [`/rooms/${OWNED}/manage`, `/p/${OWNED}/settings?tab=stage`], [`/rooms/${OWNED}/feed/mod`, `/p/${OWNED}/settings?tab=moderation`]]) {
    const r = await get(from, U.owner);
    assert.equal(r.status, 301, from); assert.equal(r.location, to, from);
  }
  const js = fs.readFileSync(path.join(repo, "public/js/pad-settings.js"), "utf8");
  assert.ok(js.includes("closest('.ps-sec')"), "an old anchor opens the section that holds it");
});

test("/guidelines: Padiquette - the latitude, the hard limits from the same list the automod uses; linked from the footer + Terms", async () => {
  const r = await get("/guidelines", null);
  assert.equal(r.status, 200);
  assert.match(r.text, /Padiquette/);
  assert.match(r.text, /wide latitude to free speech and unfiltered language/);
  for (const x of G.RULES) assert.ok(r.text.includes(`id="rule-${x.id}"`), x.id);
  assert.equal((await get("/padiquette", null)).location, "/guidelines");
  assert.match(fs.readFileSync(path.join(repo, "views/layout.ejs"), "utf8"), /href="\/guidelines"/);
  assert.match(fs.readFileSync(path.join(repo, "views/terms.ejs"), "utf8"), /href="\/guidelines">Padiquette/);
  assert.match(fs.readFileSync(path.join(repo, "public/js/feed-safety.js"), "utf8"), /href: '\/guidelines'/);
  assert.ok(G.SEVERE.includes("csam") && G.SEVERE.includes("doxxing") && G.SEVERE.includes("threats") && G.SEVERE.includes("illegal"));
});

test("the notice page: the author and the pad's managers see it (with Reverse for managers), nobody else", async () => {
  await runQuery("DELETE FROM feed_automod");
  await turnOn(OWNED);
  const p = await mkPost(U.alice, { body: "spammy <b>thing</b>" });
  const r = await verdict("p:" + p, V("flag", "spam", "minor", "Repeated ads for followers."));
  const mine = await get(`/feed/automod/${r.d.id}`, U.alice);
  assert.equal(mine.status, 200);
  assert.match(mine.text, /Pepe flagged your post/); assert.match(mine.text, /No spam/); assert.match(mine.text, /Repeated ads for followers\./);
  assert.match(mine.text, /href="\/terms#moderation"/); assert.match(mine.text, /Think Pepe got it wrong\?/);
  assert.ok(!mine.text.includes("<b>thing</b>"), "escaped");
  assert.ok(!mine.text.includes('id="anReverse"'), "authors can't reverse");
  const own = await get(`/feed/automod/${r.d.id}`, U.owner);
  assert.equal(own.status, 200); assert.match(own.text, /id="anReverse"/);
  assert.equal((await get(`/feed/automod/${r.d.id}`, U.bob)).status, 404);
});

test("the pad page's Rules card + the composer line", async () => {
  await RULES.set(U.owner, OWNED, { intro: "Plants!", rules: [{ title: "Plants only", desc: "Keep it green" }] });
  const ejs = require("ejs");
  const F = await web.roomFeed(OWNED, U.alice, {});
  const html = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: F, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                   room: { name: "Houseplants", slug: OWNED } });
  assert.match(html, /<details class="rf-rules" id="rules">/); assert.match(html, /1 rule for p\//); assert.match(html, /Plants only/); assert.match(html, /Keep it green/);
  assert.ok(!html.includes("/settings#rules"), "members don't get the edit link");
  assert.match(html, /data-rules-for="plant_based_chatting">📜 Posting in <b>p\/[^<]+<\/b>: <a [^>]+>read its 1 rule</);
  await RULES.set(U.owner, OWNED, { rules: [] });
  const F2 = await web.roomFeed(OWNED, U.owner, {});
  const h2 = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: F2, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                 room: { name: "Houseplants", slug: OWNED } });
  assert.match(h2, /This pad follows Padiquette/); assert.match(h2, /\/settings#rules/);
  assert.match(h2, /read the rules<\/a> \(it follows <a href="\/guidelines"/);
});
