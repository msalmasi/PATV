"use strict";
// 1.99aot gifs: the FREE mode (KLIPY's free plan - members' browsers call KLIPY; PATV's server never does) beside the partner mode
// (gifs.test.js, unchanged). The server-side half: no KLIPY request at all, the checks on a sent GIF's details and their refusals,
// Pepe's unchanged job shape with the details kept server-side, the per-pad rating, the per-member send limit, the one-time notice,
// the block list, the admin-only setting and the admin card's key states (never a key).
//   NODE_PATH=G:/PATV/node_modules node --test test/gifs-free.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gifs-free-test-"));
process.chdir(tmp); process.env.SECRET_KEY = "fixture-secret"; delete process.env.STAGING;
const express = require("express"), db = require(path.join(repo, "dbUtils")), G = require(path.join(repo, "gifs"));
const P = require(path.join(repo, "paddock")), relay = require(path.join(repo, "bridge-relay")), PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate")), BB = require(path.join(repo, "bridgeblocks"));
const realFetch = global.fetch, browserKey = "fixtureBrowserKey_0123456789", serverKey = "fixture-private-server-credential";
const room = { id: "Fixture.Free", slug: "fixture-free", relay: true, members: [] }, adultRoom = { id: "Fixture.Adult", slug: "fixture-adult", relay: true, members: [] };
let server, base, adminSeq = 0, now = 1000000, calls = [], adult = new Set();
const SLUG = "wave-hello-1";
const details = (over = {}) => ({ src: "https://static1.klipy.com/ii/0123456789abcdef0123456789abcdef/14/af/AbCd1234.webp", w: 220, h: 124,
  title: "<b>Wave</b> hello", page: "https://klipy.com/gifs/" + SLUG, ...over });
const flags = cfg => P.save({ userId: "cfg-" + (++adminSeq), username: "fixture-admin", class: "Admin" }, { cfg });
const headers = (user = "linked") => ({ "content-type": "application/json", "X-Requested-With": "fetch", ...(user ? { "x-test-user": user } : {}) });
async function request(url, { user = "linked", body, extraHeaders = {} } = {}) {
  const r = await realFetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { ...headers(user), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, data: await r.json() };
}
const say = (text, cid, gif, opts = {}) => request("/api/rooms/" + (opts.slug || room.slug) + "/say", { user: opts.user, body: { text, cid, ...(gif === undefined ? {} : { gif }) } });
test.before(async () => {
  await db.runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, displayname TEXT, camfrogUsername TEXT, class TEXT)");
  await db.runQuery("INSERT INTO users VALUES ('linked','fixture-linked','','fixture-frog','pleb'),('other','fixture-other','','fixture-other-frog','pleb'),('admin','fixture-boss','','fixture-boss-frog','Admin'),('staff','fixture-staff','',NULL,'Staff')");
  PA.fullFor = async () => true; AG.gate = () => "ok"; BB.refusal = async () => null;
  AG.isAdultPad = id => adult.has(id);
  require(path.join(repo, "streaks")).note = () => {};
  await P.init(); await G.init();
  const app = express(), addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? { userId: id, class: id === "admin" ? "Admin" : id === "staff" ? "Staff" : "pleb" } : null; next(); };
  app.use(express.json());
  const rooms = { [room.slug]: room, [adultRoom.slug]: adultRoom };
  relay.register(app, { addUser, isBotToken: t => t === "fixture-bot", bySlug: slug => rooms[slug] || null, isLive: () => true, gated: () => false });
  G.register(app, { addUser }); P.register(app, { addUser });
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); base = "http://127.0.0.1:" + server.address().port;
  // ANY request the server makes to KLIPY is recorded - free mode must make none
  global.fetch = async (url) => { calls.push(String(url)); throw new Error("no provider request expected"); };
});
test.after(() => { global.fetch = realFetch; delete process.env.KLIPY_API_KEY; delete process.env.KLIPY_PUBLIC_KEY; if (server) server.close(); });
test.beforeEach(async () => {
  process.env.KLIPY_PUBLIC_KEY = browserKey; process.env.KLIPY_API_KEY = serverKey;
  now = 1000000; G._reset(); G._clock(() => now); calls = []; adult = new Set();
  relay._jobs.clear(); relay._cids.clear(); relay._hits.clear();
  await db.runQuery("DELETE FROM gif_blocks"); await db.runQuery("DELETE FROM gif_notice_seen"); G._resetStore(); await G.init();
  await flags({ mode: "everyone", gifs: "free", cfstickers: false });
});

test("free mode: the server never asks KLIPY - no search, no Posts lookup, no cache refill, no render lookup; the send and the line draw anyway", async () => {
  assert.equal(G.mode(), "free"); assert.equal(G.available(), true); assert.equal(G.freeOn(), true); assert.equal(G.partnerOn(), false);
  const searched = await request("/api/gifs/search", { body: { pad: room.slug, q: "cats" } });
  assert.equal(searched.status, 403); assert.equal(searched.data.code, "gif", "free mode searches from the browser, never here");
  await assert.rejects(G.search("cats"), e => e.refuse && e.status === 403);
  assert.equal(await G.resolve("some_id"), null);
  const cold = G.attach({ k: "msg", u: { web: true }, text: "[gif:cold_id]", md: "gif" });
  assert.equal(cold.gif, undefined, "a line without stored details (a partner-era one) draws as words in free mode");
  const sent = await say("[gif:" + SLUG + "]", "free-send-1", details());
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const job = relay._jobs.get(sent.data.id);
  const echo = relay.echoJob(sent.data.id, room.id);
  const line = G.attach({ k: "msg", u: { web: true }, text: "[gif:" + SLUG + "]", md: "gif" }, { gf: echo.gf });
  assert.deepEqual(line.gif, { src: details().src, w: 220, h: 124, title: "Wave hello" });
  assert.equal(job.gf.r, "high");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [], "fetch was never called");
});

test("free mode send: Pepe's job keeps its old shape {type, id, title, page}; the checked details stay server-side (gf) with the pad's rating", async () => {
  const out = await say("[gif:" + SLUG + "]", "free-shape-1", details());
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const jobs = relay.takeJobs(new Set([room.id])); assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].media, { type: "gif", id: SLUG, title: "Wave hello", page: "https://klipy.com/gifs/" + SLUG });
  assert.equal(jobs[0].text, "[gif:" + SLUG + "]"); assert.equal(jobs[0].gf, undefined, "never in Pepe's payload");
  assert.doesNotMatch(JSON.stringify(jobs[0]), /static1\.klipy|AbCd1234/, "no CDN URL reaches Pepe");
  assert.deepEqual(relay.echoJob(out.data.id, room.id).gf, { src: details().src, w: 220, h: 124, title: "Wave hello", r: "high" });
  // no page link is fine (Pepe posts the title alone)
  const bare = await say("[gif:" + SLUG + "]", "free-shape-2", details({ page: "" }));
  assert.equal(bare.status, 200); assert.equal(relay.takeJobs(new Set([room.id]))[0].media.page, "");
  // a gif query (webp or gif) with a plain query string is taken as KLIPY gave it
  assert.equal((await say("[gif:" + SLUG + "]", "free-shape-3", details({ src: "https://static.klipy.com/ii/aa/bb/x.gif?v=2&t=a-b_c" }))).status, 200);
  assert.deepEqual(calls, []);
});

test("free mode: the per-pad rating is the server's - general pads high, 18+ pads low - on the page data and on the line", async () => {
  adult.add(adultRoom.id);
  assert.deepEqual(G.pageData(room.id, "linked"), { k: browserKey, r: "high", n: false });
  assert.deepEqual(G.pageData(adultRoom.id, "linked"), { k: browserKey, r: "low", n: false });
  assert.equal(G.ratingFor(room.id), G.RATINGS.general); assert.equal(G.ratingFor(adultRoom.id), G.RATINGS.adult);
  assert.deepEqual(G.RATINGS, { general: "high", adult: "low" }, "never off (R) until the 18+ gate is on");
  const out = await say("[gif:" + SLUG + "]", "adult-send-1", { ...details(), r: "off" }, { slug: adultRoom.slug });
  assert.equal(out.status, 200);
  assert.equal(relay.echoJob(out.data.id, adultRoom.id).gf.r, "low", "the page's claim is ignored - the server's rating is kept");
  await flags({ gifs: "partner" }); assert.equal(G.pageData(room.id, "linked"), null, "partner mode: no browser key on the page");
  await flags({ gifs: "off" }); assert.equal(G.pageData(room.id, "linked"), null);
  await flags({ gifs: "free", mode: "off" }); assert.equal(G.pageData(room.id, "linked"), null, "the Room Dock off: nothing");
  await flags({ mode: "everyone" }); delete process.env.KLIPY_PUBLIC_KEY; assert.equal(G.pageData(room.id, "linked"), null, "no browser key: free mode is off");
  process.env.KLIPY_PUBLIC_KEY = "bad key/with?chars"; assert.equal(G.available(), false, "a malformed browser key is no key");
});

test("free mode refuses what it can check without KLIPY: hosts, scheme, URL shape and length, sizes, title, page link - no job", async () => {
  const src = (s) => details({ src: s });
  const bad = [
    ["http", src("http://static.klipy.com/ii/a/b.gif")], ["suffix host", src("https://static.klipy.com.evil.invalid/ii/a/b.gif")],
    ["other host", src("https://evil.invalid/ii/a/b.gif")], ["api host", src("https://api.klipy.com/ii/a/b.gif")], ["page host", src("https://klipy.com/ii/a/b.gif")],
    ["userinfo", src("https://me:pw@static.klipy.com/ii/a/b.gif")], ["port", src("https://static.klipy.com:8443/ii/a/b.gif")],
    ["port 443", src("https://static.klipy.com:443/ii/a/b.gif")], ["upper-case host", src("https://STATIC.klipy.com/ii/a/b.gif")],
    ["dot segment", src("https://static.klipy.com/ii/../b.gif")], ["encoded", src("https://static.klipy.com/ii/%2e%2e/b.gif")],
    ["fragment", src("https://static.klipy.com/ii/a/b.gif#x")], ["backslash", src("https://static.klipy.com\\@evil.invalid/b.gif")],
    ["png", src("https://static.klipy.com/ii/a/b.png")], ["no extension", src("https://static.klipy.com/ii/a/b")],
    ["double dot name", src("https://static.klipy.com/ii/a/b.gif.png")], ["query markup", src("https://static.klipy.com/ii/a/b.gif?x=<b>")],
    ["too long", src("https://static.klipy.com/" + "a/".repeat(260) + "b.gif")], ["deep path", src("https://static.klipy.com/a/b/c/d/e/f/g/h/i/j/k.gif")],
    ["space", src("https://static.klipy.com/ii/a b.gif")], ["not a string", src(["https://static.klipy.com/ii/a/b.gif"])], ["no src", details({ src: undefined })],
    ["w 0", details({ w: 0 })], ["w huge", details({ w: 5000 })], ["w string", details({ w: "220" })], ["w float", details({ w: 1.5 })], ["no h", details({ h: undefined })],
    ["title object", details({ title: { x: 1 } })], ["title too long", details({ title: "x".repeat(201) })],
    ["page other host", details({ page: "https://evil.invalid/gifs/" + SLUG })], ["page other gif", details({ page: "https://klipy.com/gifs/other-gif" })],
    ["page http", details({ page: "http://klipy.com/gifs/" + SLUG })], ["page suffix", details({ page: "https://klipy.com.evil.invalid/gifs/" + SLUG })],
    ["no details", undefined], ["null", null], ["array", [details()]], ["string", "https://static.klipy.com/ii/a/b.gif"],
  ];
  for (const [i, [why, gif]] of bad.entries()) {
    const out = await say("[gif:" + SLUG + "]", "bad-" + i + "-cid", gif);
    assert.equal(out.status, 403, why + ": " + JSON.stringify(out.data)); assert.equal(out.data.code, "gif", why);
  }
  // the title goes through the text guard (Pepe says it in the Camfrog room) - its own words, still no job
  const t = await say("[gif:" + SLUG + "]", "bad-title-cid", details({ title: "kys lol" }));
  assert.equal(t.status, 403); assert.equal(t.data.code, "gif"); assert.match(t.data.error, /title/);
  // the token rules are the partner mode's (an exact token only)
  for (const text of ["hi [gif:" + SLUG + "]", "[gif:" + SLUG + "] hi", "[gif:x/y]", "[gif:" + "x".repeat(65) + "]"]) assert.equal((await say(text, null, details())).data.code, "gif", text);
  assert.equal(relay._jobs.size, 0, "nothing queued"); assert.deepEqual(calls, []);
});

test("free mode: every say gate still applies first (sign-in, the Dock, a link), and 6 GIFs a minute per member", async () => {
  assert.equal((await say("[gif:" + SLUG + "]", "gate-1", details(), { user: null })).status, 401);
  assert.equal((await say("[gif:" + SLUG + "]", "gate-2", details(), { user: "staff" })).data.code, "account", "no chat login: the account rule");
  await flags({ mode: "off" }); assert.equal((await say("[gif:" + SLUG + "]", "gate-3", details())).data.code, "dock"); await flags({ mode: "everyone" });
  for (let i = 0; i < G.SEND_LIMIT; i++) {
    const out = await say("[gif:" + SLUG + "]", "rate-cid-" + i, details());
    assert.equal(out.status, 200, i + ": " + JSON.stringify(out.data)); relay._jobs.clear(); relay._cids.clear(); relay._hits.clear();
  }
  const over = await say("[gif:" + SLUG + "]", "rate-cid-over", details());
  assert.equal(over.status, 429); assert.equal(over.data.code, "rate");
  assert.equal((await say("[gif:" + SLUG + "]", "rate-cid-other", details(), { user: "other" })).status, 200, "per member");
  now += 60000; assert.equal((await say("[gif:" + SLUG + "]", "rate-cid-later", details())).status, 200, "a minute later");
  assert.deepEqual(calls, []);
});

test("a GIF removed everywhere is refused in both modes, never offered by the partner search, and draws as gone", async () => {
  await db.tx(async () => { await G.blockInTx(SLUG, { room: room.id, c: 7, kind: "mod", why: "fixture" }, now); });
  G.noteBlocked(SLUG); assert.equal(G.isBlocked(SLUG), true);
  assert.equal((await say("[gif:" + SLUG + "]", "blocked-1", details())).data.code, "gif");
  assert.deepEqual(G.attach({ k: "msg", u: { web: true }, text: "[gif:" + SLUG + "]", md: "gif" }, { gf: { src: details().src, w: 1, h: 1, title: "x", r: "high" } }).gif, { gone: 1 });
  // reloaded from the database (a restart)
  G._resetStore(); await G.init(); assert.equal(G.isBlocked(SLUG), true);
  // partner mode honours it too: its search never offers it and it isn't sendable
  await flags({ gifs: "partner" });
  global.fetch = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ results: [{ id: SLUG, title: "Blocked", media_formats: { tinygif: { url: "https://static.klipy.com/t.gif", dims: [8, 8] }, gif: { url: "https://static.klipy.com/g.gif", dims: [8, 8] } } }] }), { headers: { "content-type": "application/json" } }); };
  try {
    assert.deepEqual(await G.search(""), []); assert.equal(G.picked(SLUG), null);
    assert.equal((await say("[gif:" + SLUG + "]", "blocked-2")).data.code, "gif");
  } finally { global.fetch = async (url) => { calls.push(String(url)); throw new Error("no provider request expected"); }; }
  calls = [];
});

test("switching modes: a free pick's details are ignored in partner mode (only its own filtered search makes an id sendable), and the other way round", async () => {
  await flags({ gifs: "partner" });
  const out = await say("[gif:" + SLUG + "]", "mode-switch-1", details());
  assert.equal(out.data.code, "gif", "partner mode never takes a browser's details"); assert.equal(relay._jobs.size, 0);
  await flags({ gifs: "off" }); assert.equal((await say("[gif:" + SLUG + "]", "mode-switch-2", details())).data.code, "gif");
  await flags({ gifs: "free" }); assert.equal((await say("[gif:" + SLUG + "]", "mode-switch-3", details())).status, 200);
});

test("the one-time notice: recorded once per account (signed in, same-site fetch, free mode on) and on the page data from then on", async () => {
  assert.equal((await request("/api/gifs/notice", { user: null, body: {} })).status, 401);
  assert.equal((await request("/api/gifs/notice", { body: {}, extraHeaders: { "X-Requested-With": "nope" } })).status, 403);
  assert.equal((await request("/api/gifs/notice", { body: {}, extraHeaders: { Origin: "https://foreign.invalid" } })).status, 403);
  await flags({ gifs: "partner" }); assert.equal((await request("/api/gifs/notice", { body: {} })).status, 403); await flags({ gifs: "free" });
  assert.equal(G.pageData(room.id, "linked").n, false);
  for (let i = 0; i < 2; i++) assert.equal((await request("/api/gifs/notice", { body: {} })).status, 200);
  assert.equal(G.pageData(room.id, "linked").n, true); assert.equal(G.pageData(room.id, "other").n, false, "per account");
  const rows = await db.getQuery("SELECT user_id, v FROM gif_notice_seen");
  assert.deepEqual(rows, [{ user_id: "linked", v: G.NOTICE_V }]);
  G._resetStore(); await G.init(); assert.equal(G.noticeSeen("linked"), true, "kept across a restart");
});

test("the GIF setting and the block list are site admins' only; the admin card says which key is missing - never a key", async () => {
  assert.deepEqual(P.DEFAULTS.gifs, "off", "default off: deploying changes nothing");
  await assert.rejects(P.save({ userId: "other", username: "fixture-other", class: "pleb" }, { cfg: { gifs: "free" } }), e => e.status === 403);
  await assert.rejects(P.save({ userId: "staff", username: "fixture-staff", class: "Staff" }, { cfg: { gifs: "partner" } }), e => e.status === 403);
  assert.equal((await request("/api/admin/paddock", { user: "other" })).status, 403);
  const view = await request("/api/admin/paddock", { user: "admin" });
  assert.equal(view.status, 200); assert.deepEqual(view.data.gifs.keys, { free: "set", partner: "set" }); assert.equal(view.data.gifs.mode, "free");
  assert.doesNotMatch(JSON.stringify(view.data), new RegExp(browserKey + "|" + serverKey), "no key in the admin answer");
  delete process.env.KLIPY_API_KEY; process.env.KLIPY_PUBLIC_KEY = "x";
  assert.deepEqual((await G.adminStatus()).keys, { free: "malformed", partner: "missing" });
  // unblock: signed in, pads.config, same-site fetch; audited
  await db.tx(async () => { await G.blockInTx("to_unblock", { room: room.id, kind: "mod" }, now); }); G.noteBlocked("to_unblock");
  assert.equal((await request("/api/admin/gifs/unblock", { user: null, body: { id: "to_unblock" } })).status, 401);
  assert.equal((await request("/api/admin/gifs/unblock", { user: "other", body: { id: "to_unblock" } })).status, 403);
  assert.equal((await request("/api/admin/gifs/unblock", { user: "staff", body: { id: "to_unblock" } })).status, 403);
  assert.equal((await request("/api/admin/gifs/unblock", { user: "admin", body: { id: "to_unblock" }, extraHeaders: { "X-Requested-With": "x" } })).status, 403);
  assert.equal(G.isBlocked("to_unblock"), true);
  const ok = await request("/api/admin/gifs/unblock", { user: "admin", body: { id: "to_unblock", reason: "fixture review" } });
  assert.equal(ok.status, 200); assert.equal(ok.data.removed, true); assert.equal(G.isBlocked("to_unblock"), false);
  const audit = await db.getQuery("SELECT action, reason FROM admin_audit WHERE action = 'gif_unblock'");
  assert.deepEqual(audit.map(a => [a.action, a.reason]), [["gif_unblock", "fixture review"]]);
});

test("the CSP sources a page with the picker would need are exactly KLIPY's API and CDN hosts", () => {
  assert.deepEqual(G.CSP_SOURCES, { connect: ["https://api.klipy.com"], img: ["https://static.klipy.com", "https://static1.klipy.com", "https://static2.klipy.com"] });
  // the browser code uses the same base the server documents (never a suffix-matched host)
  const picker = fs.readFileSync(path.join(repo, "public", "js", "pad-picker.js"), "utf8");
  assert.ok(picker.includes("'" + G.KLIPY_BROWSER_API + "'"));
  assert.match(picker, /\/\^\(static\|static1\|static2\)\\\.klipy\\\.com\$\//);
});
