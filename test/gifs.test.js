"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gifs-test-"));
process.chdir(tmp); process.env.SECRET_KEY = "fixture-secret"; delete process.env.STAGING;
const express = require("express"), db = require(path.join(repo, "dbUtils")), G = require(path.join(repo, "gifs"));
const P = require(path.join(repo, "paddock")), relay = require(path.join(repo, "bridge-relay")), PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate")), BB = require(path.join(repo, "bridgeblocks"));
const realFetch = global.fetch, fixtureKey = "fixture-private-klipy-credential", room = { id: "Fixture.Gifs", slug: "fixture-gifs", relay: true, members: [] };
let server, base, adminSeq = 0, now = 1000000, live = true, gated = false, padAllowed = true, adult = "ok", blocked = null, calls = [], provider;
const fixture = (id = "gif_fixture_1") => ({ id, title: "<b>Fixture</b> wave", itemurl: "https://klipy.com/gifs/fixture-wave", flags: "",
  media_formats: { tinygif: { url: "https://static1.klipy.com/fixture/tiny.gif?keep=1", dims: [80, 40] }, gif: { url: "https://static.klipy.com/fixture/full.gif?keep=1", dims: [320, 160] } } });
const response = items => new Response(JSON.stringify({ results: items }), { headers: { "content-type": "application/json" } });
const flags = cfg => P.save({ userId: "cfg-" + (++adminSeq), username: "fixture-admin", class: "Admin" }, { cfg });
const headers = (user = "linked") => ({ "content-type": "application/json", "X-Requested-With": "fetch", ...(user ? { "x-test-user": user } : {}) });
async function request(url, { user = "linked", body, extraHeaders = {} } = {}) {
  const r = await realFetch(base + url, { method: body === undefined ? "GET" : "POST", headers: { ...headers(user), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, headers: r.headers, data: await r.json() };
}
const search = (q = "", opts) => request("/api/gifs/search?pad=" + room.slug + "&q=" + encodeURIComponent(q), opts);
const say = (text, cid) => request("/api/rooms/" + room.slug + "/say", { body: { text, cid } });
test.before(async () => {
  await db.runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, displayname TEXT, camfrogUsername TEXT, class TEXT)");
  await db.runQuery("INSERT INTO users VALUES ('linked','fixture-linked','','fixture-frog','pleb'),('other','fixture-other','','fixture-other-frog','pleb'),('unlinked','fixture-unlinked','',NULL,'pleb')");
  PA.fullFor = async () => padAllowed; AG.gate = () => adult; BB.refusal = async () => blocked;
  require(path.join(repo, "streaks")).note = () => {};
  await P.init();
  const app = express(), addUser = (req, res, next) => { req.user = req.get("x-test-user") ? { userId: req.get("x-test-user") } : null; next(); };
  relay.register(app, { addUser, isBotToken: t => t === "fixture-bot", bySlug: slug => slug === room.slug ? room : null, isLive: () => live, gated: () => gated });
  G.register(app, { addUser });
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); base = "http://127.0.0.1:" + server.address().port;
  global.fetch = async (url, options) => { const value = new URL(url); assert.equal(value.origin, "https://api.klipy.com", "provider requests stay on official API origin"); calls.push({ url: value, options }); return provider(value, options); };
});
test.after(() => { global.fetch = realFetch; delete process.env.KLIPY_API_KEY; if (server) server.close(); });
test.beforeEach(async () => {
  process.env.KLIPY_API_KEY = fixtureKey; now = 1000000; G._reset(); G._clock(() => now); calls = [];
  provider = async () => response([fixture()]); live = true; gated = false; padAllowed = true; adult = "ok"; blocked = null; room.relay = true;
  relay._jobs.clear(); relay._cids.clear(); relay._hits.clear();
  await flags({ mode: "everyone", gifs: true, cfstickers: false });
});

test("no call-time key or disabled switch means unavailable, no provider request and no token job", async () => {
  delete process.env.KLIPY_API_KEY;
  assert.equal(G.available(), false); assert.equal((await search()).data.code, "gif"); assert.equal((await say("[gif:gif_fixture_1]")).data.code, "gif");
  process.env.KLIPY_API_KEY = fixtureKey; assert.equal(G.available(), true);
  await flags({ gifs: false }); assert.equal(G.available(), false); assert.equal((await search()).status, 403);
  assert.equal(calls.length, 0); assert.equal(relay._jobs.size, 0);
});

test("search and empty-query featured use documented v2 endpoints, high filter and unchanged returned URLs", async () => {
  const found = await search("fixture & hello"); assert.equal(found.status, 200);
  assert.deepEqual(found.data, [{ id: "gif_fixture_1", title: "Fixture wave", preview: { src: "https://static1.klipy.com/fixture/tiny.gif?keep=1", w: 80, h: 40 },
    media: { src: "https://static.klipy.com/fixture/full.gif?keep=1", w: 320, h: 160 }, page: "https://klipy.com/gifs/fixture-wave" }]);
  assert.equal(found.headers.get("cache-control"), "no-store");
  const call = calls[0]; assert.equal(call.url.pathname, "/v2/search"); assert.equal(call.url.searchParams.get("q"), "fixture & hello");
  assert.equal(call.url.searchParams.get("contentfilter"), "high"); assert.equal(call.url.searchParams.get("media_filter"), "tinygif,gif");
  assert.equal(call.url.searchParams.get("key"), fixtureKey); assert.equal(call.options.redirect, "error"); assert.ok(call.options.signal);
  await search(); assert.equal(calls[1].url.pathname, "/v2/featured"); assert.equal(calls[1].url.searchParams.has("q"), false);
});

test("normalization drops non-HTTPS, suffix/spoof hosts, credentials, unexpected ports, bad dimensions and malformed IDs", async () => {
  const invalid = ["http://static.klipy.com/x.gif", "https://static.klipy.com.evil.invalid/x.gif", "https://evil.invalid/x.gif", "https://me:pw@static.klipy.com/x.gif", "https://static.klipy.com:8443/x.gif", "https://static.klipy.com\\@evil.invalid/x.gif"];
  const items = invalid.map((src, i) => { const item = fixture("bad" + i); item.media_formats.gif.url = src; return item; });
  const badPage = fixture("badpage"); badPage.itemurl = "https://static.klipy.com/page"; items.push(badPage);
  const badId = fixture("x".repeat(65)); items.push(badId);
  const badDim = fixture("baddim"); badDim.media_formats.gif.dims = [Infinity, 10]; items.push(badDim);
  const thirdHost = fixture("good3"); thirdHost.media_formats.gif.url = "https://static2.klipy.com/file.gif"; items.push(thirdHost);
  provider = async () => response(items); const out = await search(); assert.deepEqual(out.data.map(x => x.id), ["good3"]);
  const absentPage = fixture(); delete absentPage.itemurl; assert.equal(G.normalize(absentPage).page, "");
});

test("key and query never appear in browser responses or captured logs, even when fetch errors include their URL", async () => {
  const log = [], oldLog = console.log, oldError = console.error, oldWarn = console.warn;
  console.log = console.error = console.warn = (...args) => log.push(args.join(" "));
  try {
    provider = async url => { throw new Error("provider failed " + url.href); };
    const result = await search("private fixture search"); assert.equal(result.status, 503);
    assert.doesNotMatch(JSON.stringify({ result: result.data, log }), /fixture-private-klipy-credential|private fixture search/);
    provider = async () => response([{ ...fixture(), title: fixtureKey }]);
    assert.deepEqual((await search()).data, []);
    process.env.KLIPY_API_KEY = "fixture credential/+?=#";
    const encoded = encodeURIComponent(process.env.KLIPY_API_KEY), reflected = fixture("encoded_key");
    reflected.media_formats.gif.url += "&credential=" + encoded;
    provider = async () => response([reflected]);
    assert.deepEqual((await search()).data, [], "URL-encoded credentials must not be reflected either");
    assert.equal(G.peek("encoded_key"), null);
  } finally { console.log = oldLog; console.error = oldError; console.warn = oldWarn; }
});

test("same-site fetch, query length, sign-in and every existing say gate are required before searching", async () => {
  assert.equal((await search("", { extraHeaders: { Origin: "https://foreign.invalid" } })).data.code, "security");
  assert.equal((await search("", { extraHeaders: { "X-Requested-With": "wrong" } })).data.code, "security");
  assert.equal((await search("x".repeat(51))).data.code, "query"); assert.equal((await search("", { user: null })).status, 401);
  assert.equal((await request("/api/gifs/search?pad=unbridged")).data.code, "offline");
  live = false; assert.equal((await search()).data.code, "offline"); live = true;
  gated = true; assert.equal((await search()).data.code, "gated"); gated = false;
  room.relay = false; assert.equal((await search()).data.code, "relay_off"); room.relay = true;
  padAllowed = false; assert.equal((await search()).data.code, "pad_access"); padAllowed = true;
  adult = "confirm"; assert.equal((await search()).data.adult, true); adult = "ok";
  blocked = "blocked fixture"; assert.equal((await search()).data.code, "blocked"); blocked = null;
  assert.equal((await search("", { user: "unlinked" })).data.code, "account");
  await flags({ mode: "off" }); assert.equal((await search()).data.code, "dock"); assert.equal(calls.length, 0);
});

test("search rate is20/minute/account and resets after the window", async () => {
  for (let i = 0; i < 20; i++) assert.equal((await search("fixture")).status, 200);
  assert.equal((await search("fixture")).status, 429); assert.equal(calls.length, 20);
  assert.equal((await search("fixture", { user: "other" })).status, 200);
  now += 60000; assert.equal((await search("fixture")).status, 200);
});

test("metadata cache clones data, stores no bytes, expires at24h and remains bounded", async () => {
  await G.search(""); const item = G.peek("gif_fixture_1"); item.media.src = "tamper";
  assert.equal(G.peek("gif_fixture_1").media.src, fixture().media_formats.gif.url);
  assert.equal(Buffer.isBuffer(G.peek("gif_fixture_1")), false);
  assert.deepEqual(Object.keys(G.peek("gif_fixture_1")).sort(), ["id", "media", "page", "preview", "title"]);
  now += G.CACHE_TTL_MS - 1; assert.ok(G.peek("gif_fixture_1")); now++; assert.equal(G.peek("gif_fixture_1"), null);
  let count = 0; provider = async () => response(Array.from({ length: 50 }, () => fixture("item_" + (++count))));
  for (let i = 0; i < G.CACHE_MAX / 50 + 1; i++) await G.search("");
  assert.equal(G.peek("item_1"), null); assert.ok(G.peek("item_" + count));
  assert.deepEqual(fs.readdirSync(tmp).filter(name => /gif|\.gif$|\.webp$/.test(name)), [], "no downloaded media files");
});

test("lookup uses exact ID Posts endpoint, deduplicates in-flight work, rejects mismatched IDs and backs off misses", async () => {
  let finish; provider = () => new Promise(resolve => { finish = resolve; });
  const a = G.resolve("lookup_id"), b = G.resolve("lookup_id"); assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/v2/posts"); assert.equal(calls[0].url.searchParams.get("ids"), "lookup_id");
  assert.equal(calls[0].url.searchParams.has("contentfilter"), false, "Posts has no documented rating parameter");
  finish(response([fixture("lookup_id")])); assert.deepEqual(await a, await b);
  provider = async () => response([fixture("different_id")]); assert.equal(await G.resolve("missing_id"), null);
  const before = calls.length; assert.equal(await G.resolve("missing_id"), null); assert.equal(calls.length, before);
  now += G.LOOKUP_RETRY_MS; assert.equal(await G.resolve("missing_id"), null); assert.equal(calls.length, before + 1);
});

test("background lookups are globally bounded and never accept invalid IDs", async () => {
  provider = async () => response([]);
  for (let i = 0; i < G.LOOKUP_LIMIT + 5; i++) await G.resolve("miss_" + i);
  assert.equal(calls.length, G.LOOKUP_LIMIT);
  for (const id of ["bad/id", "", "x".repeat(65), null, 123]) assert.equal(await G.resolve(id), null);
  assert.equal(calls.length, G.LOOKUP_LIMIT);
});

test("attach is synchronous/cache-only; only named web message tokens get metadata and privacy bars never fetch", async () => {
  let finish; provider = () => new Promise(resolve => { finish = resolve; });
  const input = { k: "msg", u: { web: true }, text: "[gif:gif_fixture_1]" }, same = G.attach(input);
  assert.equal(same === input, true); assert.equal(same.gif, undefined); assert.equal(typeof same.then, "undefined"); assert.equal(calls.length, 1);
  for (const item of [{ ...input, u: { web: false } }, { ...input, u: { web: true, anon: true } }, { ...input, mask: "m" }, { ...input, removed: { at: 1 } }, { ...input, k: "tx" }, { ...input, text: "prefix [gif:other]" }]) {
    item.gif = { src: "stale" }; G.attach(item); assert.equal(item.gif, undefined);
  }
  assert.equal(calls.length, 1);
  finish(response([fixture()])); await G.resolve("gif_fixture_1");
  assert.deepEqual(G.attach({ ...input }).gif, { src: fixture().media_formats.gif.url, w: 320, h: 160, title: "Fixture wave" });
  await flags({ gifs: false }); assert.equal(G.attach({ ...input }).gif, undefined, "off suppresses new remote loads even with warm metadata");
  await flags({ gifs: true }); delete process.env.KLIPY_API_KEY; assert.equal(G.attach({ ...input }).gif, undefined);
});

test("exact GIF creates media job; concurrent cid retries during lookup enqueue only once", async () => {
  let finish; provider = () => new Promise(resolve => { finish = resolve; });
  const a = say("[gif:gif_fixture_1]", "gif-lookup-cid");
  for (let i = 0; i < 50 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof finish, "function");
  const b = say("[gif:gif_fixture_1]", "gif-lookup-cid"); finish(response([fixture()]));
  const results = await Promise.all([a, b]); assert.equal(results[0].status, 200, JSON.stringify(results[0].data)); assert.equal(results[1].data.id, results[0].data.id);
  const jobs = relay.takeJobs(new Set([room.id])); assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].media, { type: "gif", id: "gif_fixture_1", title: "Fixture wave", page: "https://klipy.com/gifs/fixture-wave" });
  assert.equal(jobs[0].text, "[gif:gif_fixture_1]"); assert.equal(jobs[0].cid, "gif-lookup-cid"); assert.equal(calls.length, 1);
});

test("mixed/malformed/unknown tokens return gif refusal without jobs", async () => {
  provider = async () => response([]);
  for (const text of ["before [gif:gif_fixture_1]", "[gif:gif_fixture_1] after", "[gif:x][gif:y]", "[gif:x/y]", "[gif:" + "x".repeat(65) + "]", "[gif:x]\n", "[GIF:x]", "[gif:missing]"])
    assert.equal((await say(text)).data.code, "gif", text);
  assert.equal(relay._jobs.size, 0);
});

// 1.99?? dock: only a token's own opening ("[gif:" / "[cfsticker:", any case) makes a line a media send. The package's /\[gif\b/i
// refused every line that merely mentioned "[GIF]" - for everyone, Dock on or off - so a dark ship changed ordinary chat
test("1.99?? dock: every switch off - words that mention [GIF] / [gif] / [cfsticker] relay as text; a token inside text or one cleaned into shape never does", async () => {
  await flags({ mode: "off", gifs: false, cfstickers: false });
  const plain = ["[GIF] lol", "[gif] that one", "look [gifs] [cfsticker] [Sticker]", "a [Gif] and [CFSTICKER] mention"];
  for (const [i, text] of plain.entries()) {
    const out = await say(text, "plain-" + i); assert.equal(out.status, 200, text + ": " + JSON.stringify(out.data));
  }
  const jobs = relay.takeJobs(new Set([room.id]));
  assert.deepEqual(jobs.map(j => j.text), plain); assert.ok(jobs.every(j => j.media === undefined), "plain say jobs, no media");
  relay._jobs.clear(); relay._cids.clear(); relay._hits.clear();
  for (const text of ["hi [gif:abc]", "[GIF:abc] hi", "[gif:abc", "[gif: funny]"]) assert.equal((await say(text)).data.code, "gif", text);
  for (const text of ["hi [cfsticker:1/2]", "[CfSticker:1/2]"]) assert.equal((await say(text)).data.code, "sticker", text);
  assert.equal((await say("[gif:abc]")).data.code, "dock", "an exact token is a pick - never relayed as text while the Dock is off");
  // markup the say route cleans out cannot turn a line into a token that skips the media gates (sayLine checks the cleaned text)
  assert.equal((await say("[gi<b>f:abc]")).data.code, "dock");
  assert.equal((await say("x [gi<b>f:abc]")).data.code, "gif");
  assert.equal(relay._jobs.size, 0, "none of these queued");
  assert.equal(calls.length, 0, "no provider request");
});

test("concurrent distinct GIF picks cannot overfill the shared five-message queue", async () => {
  let finish; provider = () => new Promise(resolve => { finish = resolve; });
  const sends = Array.from({ length: 6 }, (_, i) => say("[gif:gif_fixture_1]", "concurrent-" + i));
  for (let i = 0; i < 50 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(typeof finish, "function"); finish(response([fixture()]));
  const results = await Promise.all(sends);
  assert.equal(results.filter(x => x.status === 200).length, 5);
  assert.equal(results.filter(x => x.data.code === "queue_full").length, 1);
  assert.equal(relay._jobs.size, 5);
});

test("a gate or key revoked during provider work prevents response/job delivery", async () => {
  provider = async () => { padAllowed = false; return response([fixture()]); };
  assert.equal((await search()).data.code, "pad_access");
  padAllowed = true; G._reset(); G._clock(() => now);
  provider = async () => { blocked = "new block"; return response([fixture()]); };
  assert.equal((await say("[gif:gif_fixture_1]", "new-block-cid")).data.code, "blocked"); assert.equal(relay._jobs.size, 0);
  blocked = null; G._reset(); provider = async () => { process.env.KLIPY_API_KEY = "fixture-rotated"; return response([fixture()]); };
  assert.equal((await search()).status, 503); assert.equal(G.peek("gif_fixture_1"), null);
});

test("oversized or malformed upstream bodies return generic errors and do not fill cache", async () => {
  provider = async () => new Response("{}", { headers: { "content-length": String(G.RESPONSE_MAX_BYTES + 1) } });
  assert.equal((await search()).status, 503);
  provider = async () => new Response("x".repeat(G.RESPONSE_MAX_BYTES + 1)); assert.equal((await search()).status, 503);
  provider = async () => new Response("<html>upstream unavailable</html>"); assert.equal((await search()).status, 503);
  assert.equal(G.peek("gif_fixture_1"), null);
});
