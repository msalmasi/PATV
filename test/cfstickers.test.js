"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfstickers-test-"));
process.chdir(tmp); process.env.SECRET_KEY = "fixture-secret"; delete process.env.STAGING;
process.env.CFSTICKER_DIR = path.join(tmp, "art");
const express = require("express"), sharp = require("sharp");
const db = require(path.join(repo, "dbUtils")), CF = require(path.join(repo, "cfstickers")), P = require(path.join(repo, "paddock"));
const relay = require(path.join(repo, "bridge-relay")), PA = require(path.join(repo, "padaccess")), AG = require(path.join(repo, "adultgate"));
const BB = require(path.join(repo, "bridgeblocks"));
const room = { id: "Fixture.Stickers", slug: "fixture-stickers", relay: true, stickers: true, members: [] };
let server, base, png, adminSeq = 0, live = true, gated = false, padAllowed = true, adult = "ok", blocked = null;
const flags = cfg => P.save({ userId: "cfg-" + (++adminSeq), username: "fixture-admin", class: "Admin" }, { cfg });
const headers = user => ({ "content-type": "application/json", "X-Requested-With": "fetch", ...(user ? { "x-test-user": user } : {}) });
async function request(url, body, user = "linked") {
  const response = await fetch(base + url, { method: body === undefined ? "GET" : "POST", headers: headers(user), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: response.status, headers: response.headers, data };
}
const sync = body => request("/api/bridge/cfstickers", { password: "fixture-bot", ...body }, null);
const catalog = user => request("/api/rooms/" + room.slug + "/cfstickers", undefined, user);
const say = (text, cid, user) => request("/api/rooms/" + room.slug + "/say", { text, cid }, user || "linked");
test.before(async () => {
  await db.runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, displayname TEXT, camfrogUsername TEXT, class TEXT)");
  for (const [id, login, cls] of [["linked", "fixture-frog", "pleb"], ["staff", "fixture-staff", "Staff"], ["unlinked", null, "pleb"]])
    await db.runQuery("INSERT INTO users VALUES (?,?,?,?,?)", [id, "fixture-" + id, "", login, cls]);
  PA.fullFor = async () => padAllowed; AG.gate = () => adult; BB.refusal = async () => blocked;
  require(path.join(repo, "streaks")).note = () => {};
  await P.init(); await CF.init();
  png = await sharp({ create: { width: 320, height: 160, channels: 4, background: "#46aa77" } }).withMetadata({ exif: { IFD0: { Artist: "Invented fixture" } } }).png().toBuffer();
  const app = express(), addUser = (req, res, next) => { req.user = req.get("x-test-user") ? { userId: req.get("x-test-user") } : null; next(); };
  relay.register(app, { addUser, isBotToken: t => t === "fixture-bot", bySlug: slug => slug === room.slug ? room : null, isLive: () => live, gated: () => gated });
  CF.register(app, { addUser, isBotToken: t => t === "fixture-bot" });
  app.use((e, req, res, next) => res.status(e.status || 500).json({ ok: false, error: "fixture parser refusal" }));
  await new Promise(resolve => { server = app.listen(0, "127.0.0.1", resolve); }); base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
test.beforeEach(async () => {
  live = true; gated = false; padAllowed = true; adult = "ok"; blocked = null; room.relay = true; room.stickers = true;
  relay._jobs.clear(); relay._hits.clear(); relay._cids.clear();
  await flags({ mode: "everyone", cfstickers: true, gifs: false });
  await CF.syncList([{ id: 421, set: 1642, desc: "Fixture wave" }]);
});

test("bot authentication precedes catalog writes, and malformed identifiers/list shapes are refused atomically", async () => {
  assert.equal((await sync({ password: "wrong", op: "list", items: [] })).status, 403);
  for (const item of [{ id: -1, set: 2, desc: "x" }, { id: 1.5, set: 2, desc: "x" }, { id: "1e2", set: 2, desc: "x" }, { id: 1, set: "../../x", desc: "x" }, { id: 1, set: 2, desc: "x".repeat(241) }]) {
    assert.equal((await sync({ op: "list", items: [item] })).status, 400);
    assert.equal(CF.valid(1642, 421), true);
  }
  assert.equal((await sync({ op: "list", items: [{ id: 1, set: 2, desc: "x" }, { id: 1, set: 2, desc: "y" }] })).status, 400);
  assert.equal((await sync({ op: "unknown", items: [] })).status, 400);
});

test("list returns missing pictures; PNG is re-encoded to <=128px metadata-free WebP and preserved on next sync", async () => {
  const listed = await sync({ op: "list", items: [{ id: 421, set: 1642, desc: '<b>Wave</b> <script>alert(1)</script> & hello' }] });
  assert.deepEqual(listed.data.need, [421]);
  assert.equal((await sync({ op: "pics", items: [{ id: 421, png: png.toString("base64") }] })).status, 200);
  const row = (await db.getQuery("SELECT * FROM cf_stickers WHERE id=421"))[0];
  assert.match(row.file, /^[a-f0-9]{32}\.webp$/);
  const stored = fs.readFileSync(path.join(process.env.CFSTICKER_DIR, row.file)), meta = await sharp(stored).metadata();
  assert.equal(meta.format, "webp"); assert.equal(meta.width, 128); assert.equal(meta.height, 64);
  assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined); assert.equal(meta.xmp, undefined);
  const result = await catalog(); assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "no-store");
  assert.deepEqual(result.data, [{ id: 421, set: 1642, desc: "Wave alert(1) & hello", src: "/media/cfsticker/421.webp" }]);
  assert.deepEqual((await sync({ op: "list", items: [{ id: 421, set: 1642, desc: "Updated" }] })).data.need, []);
});

test("picture upload rejects non-PNG, corrupt PNG, over-limit bytes, unknown ids, duplicates and >20 pictures", async () => {
  for (const data of [Buffer.from("<svg>fixture</svg>"), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(30)])])
    assert.equal((await sync({ op: "pics", items: [{ id: 421, png: data.toString("base64") }] })).status, 415);
  assert.equal((await sync({ op: "pics", items: [{ id: 421, png: Buffer.alloc(CF.MAX_PNG_BYTES + 1).toString("base64") }] })).status, 413);
  assert.equal((await sync({ op: "pics", items: [{ id: 999, png: png.toString("base64") }] })).status, 400);
  assert.equal((await sync({ op: "pics", items: [{ id: 421, png: "%%%%" }] })).status, 400);
  assert.equal((await sync({ op: "pics", items: Array.from({ length: 21 }, () => ({ id: 421, png: "" })) })).status, 400);
  await assert.rejects(CF.syncPics([{ id: 421, png: png.toString("base64") }, { id: 421, png: png.toString("base64") }]), e => e.status === 400);
  assert.equal((await sync({ op: "pics", padding: "x".repeat(700000), items: [] })).status, 413);
});

test("parser accepts a legitimate >100KB body below700KB; media route is public with private cache and hardening headers", async () => {
  const padded = Buffer.concat([png, Buffer.alloc(100000)]);
  const result = await sync({ op: "pics", items: [{ id: 421, png: padded.toString("base64") }] }); assert.equal(result.status, 200);
  const response = await fetch(base + "/media/cfsticker/421.webp");
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), "private, max-age=86400");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff"); assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal((await sharp(Buffer.from(await response.arrayBuffer())).metadata()).format, "webp");
  for (const id of ["999", "0", "01", "1e2", "-1"]) assert.equal((await fetch(base + "/media/cfsticker/" + id + ".webp")).status, 404);
  const source = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(source, /req\.path === "\/api\/bridge\/cfstickers" \|\|/);
});

// 1.99aiw dock: Pepe's sync runs from the moment the bot ships, whatever the switches say - with cfstickers off the site keeps the
// list but takes no art and serves none (the owner's question 3: Camfrog art on the site)
test("1.99aiw dock: cfstickers off - the list is kept but needs no pictures, pictures are refused, the media route serves nothing; on - the next sync asks for them", async () => {
  await CF.syncPics([{ id: 421, png: png.toString("base64") }]);
  assert.equal((await fetch(base + "/media/cfsticker/421.webp")).status, 200, "on: served");
  await flags({ cfstickers: false });
  assert.equal((await fetch(base + "/media/cfsticker/421.webp")).status, 404, "off: nothing served, even art already on disk");
  const listed = await sync({ op: "list", items: [{ id: 421, set: 1642, desc: "Fixture wave" }, { id: 422, set: 1642, desc: "Fixture new" }] });
  assert.equal(listed.status, 200); assert.deepEqual(listed.data.need, [], "off: no pictures asked for");
  assert.equal(CF.valid(1642, 422), true, "the list itself is kept");
  const pics = await sync({ op: "pics", items: [{ id: 422, png: png.toString("base64") }] });
  assert.equal(pics.status, 403); assert.equal(pics.data.code, "off");
  assert.equal((await db.getQuery("SELECT file FROM cf_stickers WHERE id=422"))[0].file, null, "no file recorded");
  await assert.rejects(CF.syncPics([{ id: 422, png: png.toString("base64") }]), e => e.status === 403);
  assert.equal((await catalog()).data.code, "sticker", "the picker stays closed");
  await flags({ cfstickers: true });
  assert.deepEqual((await sync({ op: "list", items: [{ id: 421, set: 1642, desc: "Fixture wave" }, { id: 422, set: 1642, desc: "Fixture new" }] })).data.need, [422], "on: the next sync asks for what is missing");
  assert.equal((await fetch(base + "/media/cfsticker/421.webp")).status, 200);
});

test("full catalog replacement revokes missing and wrong-set pairs and asks for a fresh image after a set change", async () => {
  await CF.syncPics([{ id: 421, png: png.toString("base64") }]);
  const old = (await db.getQuery("SELECT file FROM cf_stickers WHERE id=421"))[0].file;
  assert.deepEqual(await CF.syncList([{ id: 421, set: 1643, desc: "Moved" }]), { need: [421] });
  assert.equal(CF.valid(1642, 421), false); assert.equal(CF.valid(1643, 421), true);
  assert.equal(fs.existsSync(path.join(process.env.CFSTICKER_DIR, old)), false);
  await CF.syncList([]); assert.equal(CF.valid(1643, 421), false);
});

test("catalog requires every say eligibility gate and both sticker switches; current account class controls staff rollout", async () => {
  assert.equal((await catalog(null)).status, 401); assert.equal((await catalog("missing")).status, 401);
  assert.equal((await request("/api/rooms/not-bridged/cfstickers")).status, 404);
  live = false; assert.equal((await catalog()).data.code, "offline"); live = true;
  gated = true; assert.equal((await catalog()).data.code, "gated"); gated = false;
  room.relay = false; assert.equal((await catalog()).data.code, "relay_off"); room.relay = true;
  padAllowed = false; assert.equal((await catalog()).data.code, "pad_access"); padAllowed = true;
  adult = "confirm"; assert.equal((await catalog()).data.adult, true); adult = "ok";
  blocked = "fixture blocked"; assert.equal((await catalog()).data.code, "blocked"); blocked = null;
  assert.equal((await catalog("unlinked")).data.code, "account");
  room.stickers = false; assert.equal((await catalog()).data.code, "sticker"); room.stickers = true;
  await flags({ cfstickers: false }); assert.equal((await catalog()).data.code, "sticker");
  await flags({ cfstickers: true, mode: "off" }); assert.equal((await catalog()).data.code, "dock");
  await flags({ mode: "staff" }); assert.equal((await catalog()).data.code, "dock"); assert.equal((await catalog("staff")).status, 200);
});

test("exact token creates the ordinary say job with media; cid retry and takeJobs never duplicate it", async () => {
  const first = await say("[cfsticker:1642/421]", "sticker-cid1"); assert.equal(first.status, 200, JSON.stringify(first.data));
  const retry = await say("[cfsticker:1642/421]", "sticker-cid1"); assert.equal(retry.data.id, first.data.id);
  const jobs = relay.takeJobs(new Set([room.id])); assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].media, { type: "cfsticker", set: 1642, id: 421 });
  assert.equal(jobs[0].text, "[cfsticker:1642/421]"); assert.equal(jobs[0].camfrog, "fixture-frog"); assert.equal(jobs[0].cid, "sticker-cid1");
  assert.deepEqual(relay.takeJobs(new Set([room.id])), []);
});

test("mixed/malformed/unknown/wrong-set tokens refuse with sticker code and never queue", async () => {
  for (const text of ["prefix [cfsticker:1642/421]", "[cfsticker:1642/421] suffix", "[cfsticker:1642/421][cfsticker:1642/421]", "[cfsticker:wrong/421]", "[cfsticker:1642/421]\n", "[CFSTICKER:1642/421]", "[cfsticker:1642/999]", "[cfsticker:1643/421]", "<b>[cfsticker:1642/421]</b>"]) {
    const out = await say(text); assert.equal(out.data.code, "sticker", text); assert.equal(out.status, 403, text);
  }
  assert.equal(relay._jobs.size, 0);
  await flags({ cfstickers: false }); assert.equal((await say("[cfsticker:1642/421]")).data.code, "sticker");
  await flags({ cfstickers: true }); room.stickers = false; assert.equal((await say("[cfsticker:1642/421]")).data.code, "sticker");
});

test("media still obeys blocks, age and membership; ordinary text keeps its original route while Dock is off", async () => {
  blocked = "fixture blocked"; assert.equal((await say("[cfsticker:1642/421]")).data.code, "blocked"); blocked = null;
  padAllowed = false; assert.equal((await say("[cfsticker:1642/421]")).data.code, "pad_access"); padAllowed = true;
  adult = "confirm"; assert.equal((await say("[cfsticker:1642/421]")).data.adult, true); adult = "ok";
  await flags({ mode: "off" }); assert.equal((await say("[cfsticker:1642/421]")).data.code, "dock");
  const ordinary = await say("ordinary fixture text", "ordinary-1"); assert.equal(ordinary.status, 200);
  assert.equal(relay.takeJobs(new Set([room.id]))[0].media, undefined);
});

test("stickers share text queue and per-minute limits", async () => {
  for (let i = 0; i < relay.SAY_QUEUE_MAX; i++) assert.equal((await say("[cfsticker:1642/421]", "queue-" + i)).status, 200);
  assert.equal((await say("[cfsticker:1642/421]", "queue-full")).data.code, "queue_full");
  relay._jobs.clear(); relay._cids.clear(); relay._hits.clear();
  for (let i = 0; i < relay.SAY_MINUTE_MAX; i++) {
    const out = await say("[cfsticker:1642/421]", "minute-" + i); assert.equal(out.status, 200);
    relay.applyAcks([{ id: out.data.id, ok: true, msg: "sent" }]);
  }
  assert.equal((await say("[cfsticker:1642/421]", "minute-full")).data.code, "rate");
});

// 1.99aiw dock: review - Pepe cuts a description at 240 code points (Python len); the site counted UTF-16 units, so one long
// description with an emoji (two units) refused Pepe's WHOLE atomic list on every 10-minute sync, and the stored cut could end
// in half a surrogate pair
test("1.99aiw dock: review - a 240-code-point description with an emoji is accepted whole; longer is still refused", async () => {
  const desc = "x".repeat(238) + "\u{1F600}\u{1F438}";            // 240 code points, 242 UTF-16 units
  const out = await sync({ op: "list", items: [{ id: 421, set: 1642, desc }] });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(CF.get(1642, 421).desc, desc);
  assert.doesNotMatch(CF.get(1642, 421).desc, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, "no half surrogate pair");
  assert.equal((await sync({ op: "list", items: [{ id: 421, set: 1642, desc: desc + "x" }] })).status, 400);
});

// 1.99aiw dock: review - the picker's GET ran a synchronous fs.existsSync per catalog sticker (up to 10000) on the event loop for
// every signed-in request, with no rate limit: a few clients could stall the site. The list is built once per catalog change
test("1.99aiw dock: review - the picker's catalog is built once per change, not with a file check per sticker per request", async () => {
  assert.equal((await sync({ op: "pics", items: [{ id: 421, png: png.toString("base64") }] })).status, 200);
  const real = fs.existsSync; let stats = 0;
  fs.existsSync = (...args) => { stats++; return real(...args); };
  try {
    const first = await catalog(); assert.equal(first.status, 200); assert.equal(first.data.length, 1);
    const after = stats;
    for (let i = 0; i < 5; i++) assert.deepEqual((await catalog()).data, first.data);
    assert.equal(stats, after, "no file check per request");
    await CF.syncList([{ id: 421, set: 1642, desc: "Renamed" }]);
    assert.equal((await catalog()).data[0].desc, "Renamed", "a new list shows at once");
    await CF.syncList([]);
    assert.deepEqual((await catalog()).data, [], "a sticker gone from the list is gone from the picker at once");
  } finally { fs.existsSync = real; }
});

// 1.99aiw dock: review - Pepe re-sends the whole list every 10 minutes (switches on or off). An unchanged list rewrote every row
// (DELETE + up to 10000 INSERTs in one write transaction, holding the site's write gate) and invalidated the picker's list each time
test("1.99aiw dock: review - an unchanged catalog list writes nothing", async () => {
  const items = [{ id: 421, set: 1642, desc: "Same frog" }, { id: 422, set: 1642, desc: "Other frog" }];
  await CF.syncList(items);
  const before = (await db.getQuery("SELECT MAX(updated) AS u, COUNT(*) AS n FROM cf_stickers"))[0];
  await new Promise(resolve => setTimeout(resolve, 15));
  const again = await CF.syncList(items.map(item => ({ ...item })));
  const after = (await db.getQuery("SELECT MAX(updated) AS u, COUNT(*) AS n FROM cf_stickers"))[0];
  assert.equal(after.n, 2); assert.equal(after.u, before.u, "no rewrite for the same list");
  assert.ok(Array.isArray(again.need));
  await new Promise(resolve => setTimeout(resolve, 15));
  await CF.syncList([{ id: 421, set: 1642, desc: "Renamed frog" }, items[1]]);
  const changed = (await db.getQuery("SELECT descr, updated FROM cf_stickers WHERE id = 421"))[0];
  assert.equal(changed.descr, "Renamed frog"); assert.ok(changed.updated > before.u, "a changed list is written");
});
