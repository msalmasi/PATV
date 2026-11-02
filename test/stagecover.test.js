// Offline tests for 1.99?? the 🎙 STAGE COVER (stagecover.js): the picture the mic stage shows for a person it names while their
// cam isn't live - the owner's "show their GTF avatar as a default cover (but give every user the ability to configure their default
// cover as anything)".
//   * the default chain (GTF avatar while the profile's GTF section is public -> profile photo -> letter), every choice and its
//     fallback, Camfrog-only logins (Pepe's synced seed), a real account before an automatic CF one
//   * privacy: a hidden / incognito login never has a cover (whatever is cached); the GTF URL names no login / user id; the route
//     renders only signed specs
//   * uploads ONLY through the image-safety check while it ENFORCES (off / shadow -> refused; fail-open -> refused, nothing stored);
//     a flagged picture is HELD (not served to others, falls back) until a review; fp puts it up, fn / ok takes it down; admins take
//     one down; the files are served only while held by a row, immutable, re-encoded (no metadata), named without a user id
//   * Settings -> 🎙 Stage cover: the page (signed in only), saving (refusals), the hub row
//   * review fixes (1.99??): a take-down sticks (hash block + held uploads), short caches for uploaded covers, per-account caps,
//     restricted accounts, fp -> ok, the sweep keeps a cover's check, a missing file, accountOf / incognito fail closed, the GTF render
//     version, "Automatic", the Settings preview, the stage's small cells and wrapping reasons
//   * review fixes 2 (1.99??): a take-down review of a picture the member already replaced / removed still sticks (blocked, held,
//     copies down, one strike per check); a short reason in a small cell stays on one line (a full-width column)
//   * the stage page (stage-mic.js): the picture on the card with the reason kept, set only when the URL changes, never on a cover /
//     a reported tile, the letter after a failed load; stage-room.js repaints on a new picture
//   * the capture (stagemiccap.js): a name card draws the cover picture; never the network
//   * review fixes 3 (1.99??): IPv6 photo addresses global unicast only; a block / a take-down's hold that lands while an upload
//     waits for its row's transaction (refused / held - every upload goes to held/ first); legacy rows' hashes (held/ too)
//   node --test test/stagecover.test.js      (temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stagecover-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.IMAGESAFETY_DIR = path.join(tmp, "isf");
process.env.COVER_DIR = path.join(tmp, "cover");
const express = require("express");
const sharp = require("sharp");
const DB = require(path.join(repo, "dbUtils"));
// (review fix PRIV-3's test: make chosen reads fail like a locked database - before any module binds getQuery)
let FAIL_SQL = null;
const realGet = DB.getQuery;
DB.getQuery = (sql, params) => (FAIL_SQL && FAIL_SQL.test(String(sql)) ? Promise.reject(new Error("SQLITE_BUSY: database is locked")) : realGet(sql, params));
const { runQuery, getQuery } = DB;
const SC = require(path.join(repo, "stagecover"));
const ISF = require(path.join(repo, "imagesafety"));
const STK = require(path.join(repo, "stickers"));
const PLY = require(path.join(repo, "profilelayout"));
const Q = require(path.join(repo, "quotes"));
const EN = require(path.join(repo, "locales", "en.json"));

const users = new Map();
const U = {};
let server, base;
async function mkUser(name, { cls = "pleb", camfrog = null, avatar = null } = {}) {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, avatar) VALUES (?, ?, ?, 'x', ?, ?, ?)", [id, name, name, cls, camfrog, avatar]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}
const seed = (login, s) => runQuery("INSERT OR REPLACE INTO cosmetic_avatar_seeds (camfrog, seed, updated) VALUES (?, ?, 1)", [login, s]);
const png = (w = 300, h = 200, c = { r: 220, g: 30, b: 40 }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
const CLEAN = { verdict: "allow", scores: { nudity_explicit: 0.01 }, reason: "a frog" };
const HATE = { verdict: "allow", scores: { hate_symbols: 0.9 }, reason: "a symbol" };            // profile policy: hate_symbols -> flag
const EXPLICIT = { verdict: "nsfw", scores: { nudity_explicit: 0.95, sexual: 0.8 }, reason: "explicit" };
let ANSWER = CLEAN;
async function safety(patch) {
  ISF._reset();
  ISF.setClassifier(async () => (typeof ANSWER === "function" ? ANSWER() : ANSWER));
  return ISF.setConfig({ ...ISF.DEFAULTS, ...patch }, "test");
}
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, extra) {
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, headers: r.headers };
}
/** The browser's flow: open -> PUT chunks -> finish. */
async function upload(u, buf) {
  const o = await call("POST", "/api/stage-cover/uploads", u, { size: buf.length });
  if (!o.d || !o.d.ok) return o;
  for (let off = 0; off < buf.length; off += o.d.chunk) {
    const part = buf.subarray(off, Math.min(buf.length, off + o.d.chunk));
    const r = await fetch(base + `/api/stage-cover/uploads/${o.d.id}?offset=${off}`, { method: "PUT", body: part,
      headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", origin: base, "x-test-user": u.userId } });
    const d = await r.json();
    if (!d.ok) return { status: r.status, d };
  }
  return call("POST", `/api/stage-cover/uploads/${o.d.id}/finish`, u, {});
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  casino_banned INTEGER DEFAULT 0, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS cosmetic_avatar_seeds (camfrog TEXT PRIMARY KEY, seed INTEGER, updated INTEGER)");
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER NOT NULL DEFAULT 0, updated INTEGER)`);
  await require(path.join(repo, "chatlog")).init();          // the site's hidden set (quotes.isHidden) - loaded, nobody hidden
  ISF.init && (await ISF.init());
  await SC.init();
  await STK.init();
  U.ann = await mkUser("ann", { camfrog: "AnnCF", avatar: "https://cdn.example.test/ann.png" });
  U.bo = await mkUser("bo", { camfrog: "bocf" });
  U.cy = await mkUser("cy", { camfrog: "cycf", avatar: "https://cdn.example.test/cy.png" });
  U.dee = await mkUser("dee");                                  // no Camfrog login
  U.admin = await mkUser("boss", { cls: "Admin" });
  U.staff = await mkUser("helper", { cls: "Staff" });
  await mkUser("CFab12cd34", { camfrog: "dupcf", avatar: "https://cdn.example.test/auto.png" });   // an automatic account on dupcf ...
  U.dup = await mkUser("realdup", { camfrog: "dupcf", avatar: "https://cdn.example.test/real.png" });   // ... and the real one
  await seed("anncf", 1111); await seed("bocf", 2222); await seed("loneCF".toLowerCase(), 3333); await seed("dupcf", 4444);
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = (req, res, next) => { const h = req.get("x-test-user"); req.user = h ? users.get(h) || null : null; next(); };
  SC.register(app, { addUser, noTimers: true });
  ISF.register(app, { addUser, isBotToken: () => false, noTimers: true });
  require(path.join(repo, "settingshub")).register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); ISF.setClassifier(null); });
test.beforeEach(async () => { SC.invalidate(); });

// ── the default chain and every choice ──
test("default: the GTF avatar (signed URL naming no login / user id) while the profile's GTF section is public; private -> the profile photo; no seed -> photo; nothing -> the letter", async () => {
  const a = await SC.coverOf("AnnCF");
  assert.equal(a.k, "gtf");
  assert.equal(a.url, SC.gtfUrl(1111, {}));
  assert.match(a.url, /^\/media\/cover\/a\/1111\.[a-f0-9]{20}\.svg$/);
  for (const bad of ["ann", "anncf", "u_ann"]) assert.ok(!a.url.toLowerCase().includes(bad), "the URL names " + bad);
  // the profile's GTF section not public (hidden): by default no GTF avatar -> the profile photo (the stage's look before)
  await PLY.save(U.ann.userId, { ...PLY.DEFAULT, hidden: ["gtf"] });          // (a section is public or hidden - the boards' "not public")
  SC.invalidate();
  assert.deepEqual(await SC.coverOf("anncf"), { url: "https://cdn.example.test/ann.png", k: "photo" });
  // picked here, it shows anyway
  await SC.save(U.ann.userId, { kind: "gtf" });
  assert.equal((await SC.coverOf("anncf")).k, "gtf");
  await PLY.reset(U.ann.userId); await runQuery("DELETE FROM stage_covers"); SC.invalidate();
  // no seed: the photo; no photo either: the letter
  assert.deepEqual(await SC.coverOf("cycf"), { url: "https://cdn.example.test/cy.png", k: "photo" });
  assert.equal(await SC.coverOf("nobody_here"), null);
  // a Camfrog-only login (no account): Pepe's synced seed, else the letter
  assert.deepEqual(await SC.coverOf("LoneCF"), { url: SC.gtfUrl(3333, {}), k: "gtf" });
  // a real account beats an automatic CF one on the same login
  assert.equal((await SC.coverOf("dupcf")).url, SC.gtfUrl(4444, {}));
  await SC.save(U.dup.userId, { kind: "photo" });
  assert.equal((await SC.coverOf("dupcf")).url, "https://cdn.example.test/real.png", "the real account's choice, not the CF one's");
});

test("choices: photo, sticker (only from a pack you own), plain card; anything that can't show falls back to the default", async () => {
  await SC.save(U.ann.userId, { kind: "photo" });
  assert.equal((await SC.coverOf("anncf")).k, "photo");
  await SC.save(U.ann.userId, { kind: "card" });
  assert.equal(await SC.coverOf("anncf"), null, "the plain card: the letter");
  // a sticker: refused until she owns the pack
  const pack = STK.CAT.packs.find((p) => !p.perk && !p.retired);
  const ref = pack.id + "/" + pack.stickers[0].id;
  await assert.rejects(SC.save(U.ann.userId, { kind: "sticker", sticker: ref }), /pack you own/);
  await assert.rejects(SC.save(U.ann.userId, { kind: "sticker", sticker: "../../etc/passwd" }), /pack you own/);
  await STK.grantComp(U.ann.userId, pack.id, "test");
  await SC.save(U.ann.userId, { kind: "sticker", sticker: ref });
  assert.deepEqual(await SC.coverOf("anncf"), { url: `/public/stickers/${ref}.svg`, k: "sticker" });
  // the pack goes: the default again
  await runQuery("DELETE FROM user_sticker_packs WHERE user_id = ?", [U.ann.userId]); SC.invalidate();
  assert.equal((await SC.coverOf("anncf")).k, "gtf");
  // refusals
  await assert.rejects(SC.save(U.ann.userId, { kind: "nope" }), /Pick one/);
  await assert.rejects(SC.save(U.bo.userId, { kind: "photo" }), /profile picture/);
  await assert.rejects(SC.save(U.ann.userId, { kind: "upload" }), /Upload a picture first/);
  await runQuery("DELETE FROM stage_covers");
});

test("privacy: a login the site hides now (incognito / !bridge hide - quotes.isHidden) or that Pepe reports incognito never has a cover, cached or not", async () => {
  assert.ok(await SC.coverOf("anncf"), "a cover while she's shown by name (now cached)");
  const hid0 = Q.isHidden;
  Q.isHidden = (l) => String(l).toLowerCase() === "anncf" || hid0(l);
  try { assert.equal(await SC.coverOf("anncf"), null, "hidden now: none, though one is cached"); } finally { Q.isHidden = hid0; }
  await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('bocf', 1, 1)`);
  assert.equal(await SC.coverOf("bocf"), null, "Pepe reports her incognito");
  await runQuery("DELETE FROM incognito_state"); SC.invalidate();
  assert.equal((await SC.coverOf("bocf")).k, "gtf");
  for (const bad of ["", "a b", "x".repeat(41), "../x", null]) assert.equal(await SC.coverOf(bad), null, String(bad));
});

test("the GTF route: a signed spec renders the avatar (immutable, nosniff, sandboxed SVG); a tampered signature, an unknown layer or a junk name is 404", async () => {
  const url = SC.gtfUrl(1111, {});
  const r = await fetch(base + url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type").split(";")[0], "image/svg+xml");
  assert.match(r.headers.get("cache-control"), /immutable/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  const svg = await r.text();
  assert.match(svg, /^<svg [^>]*shape-rendering="crispEdges"/);
  assert.doesNotMatch(svg, /<script|on\w+=/i);
  const forged = url.replace(/\.([a-f0-9]{20})\.svg$/, (m, s) => "." + (s[0] === "a" ? "b" : "a") + s.slice(1) + ".svg");
  for (const u of [forged, url.replace("1111", "1112"), "/media/cover/a/1111~hat-nosuchhat." + "0".repeat(20) + ".svg", "/media/cover/a/..%2F..%2Fx.svg", "/media/cover/a/x"]) {
    assert.equal((await fetch(base + u)).status, 404, u);
  }
  // equipped layers ride in the spec (only known ids)
  const L = (() => { require(path.join(repo, "public", "js", "avatar.js")); return globalThis.pepeAvatarLayers; })();
  const withHat = SC.gtfUrl(1111, { hat: L.hat[0], bogus: "x", mask: "nosuchmask" });
  assert.match(withHat, new RegExp("^/media/cover/a/1111~hat-" + L.hat[0] + "\\.[a-f0-9]{20}\\.svg$"));
  assert.equal((await fetch(base + withHat)).status, 200);
  assert.deepEqual(SC.parseGtf(withHat.split("/").pop()), { seed: 1111, layers: { hat: L.hat[0] } });
});

// ── uploads: only through the safety check while it enforces, fail-closed ──
test("uploads are OFF while the safety checks don't enforce for stage_cover (off, shadow, the surface off): the routes refuse, nothing stored", async () => {
  const buf = await png();
  for (const cfg of [{ enabled: false }, { enabled: false, shadow: true }, { enabled: true, shadow: true }, { enabled: true, surfaces: { ...ISF.DEFAULTS.surfaces, stage_cover: false } }]) {
    await safety(cfg);
    assert.equal(await SC.uploadsOn(), false, JSON.stringify(cfg));
    const o = await call("POST", "/api/stage-cover/uploads", U.ann, { size: buf.length });
    assert.equal(o.status, 409, JSON.stringify(cfg)); assert.equal(o.d.code, "off");
    await assert.rejects(SC.setUpload(U.ann.userId, buf), /off until/);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_covers WHERE upload IS NOT NULL"))[0].n, 0);
  assert.ok(ISF.SURFACES.includes("stage_cover") && ISF.GROUP.stage_cover === "profile", "a surface of its own, the strict profile policy");
});

test("an upload while enforcing: re-encoded webp (no metadata, a random name), served public with a SHORT cache (never immutable), picked as the cover; a refused one is never stored; a fail-open pass is refused", async () => {
  await safety({ enabled: true });
  assert.equal(await SC.uploadsOn(), true);
  ANSWER = CLEAN;
  const src = await sharp({ create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 200, b: 90 } } }).jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "secret-gps-owner" } } }).toBuffer();
  const r = await upload(U.bo, src);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.held, false);
  assert.equal(r.d.kind, "upload");
  const url = r.d.upload.url;
  assert.match(url, /^\/media\/cover\/u\/[a-f0-9]{32}\.webp$/);
  assert.ok(!url.includes("bo") || /^\/media\/cover\/u\/[a-f0-9]{32}\.webp$/.test(url));
  assert.deepEqual(await SC.coverOf("bocf"), { url, k: "upload" });
  const f = await fetch(base + url);
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("content-type"), "image/webp");
  // review fix SC-SAFE-2 / PRIV-4 / COMPAT-2: a take-down must reach caches within minutes - short browser + CDN-edge lifetimes, an ETag
  assert.equal(f.headers.get("cache-control"), "public, max-age=" + SC.UPLOAD_MAX_AGE);
  assert.ok(SC.UPLOAD_MAX_AGE <= 3600 && SC.UPLOAD_CDN_MAX_AGE <= 600);
  assert.equal(f.headers.get("cdn-cache-control"), "max-age=" + SC.UPLOAD_CDN_MAX_AGE);
  assert.equal(f.headers.get("cloudflare-cdn-cache-control"), "max-age=" + SC.UPLOAD_CDN_MAX_AGE);
  const etag = f.headers.get("etag");
  assert.ok(etag, "an ETag: the browser revalidates instead of refetching");
  // (a browser's own revalidation - node's fetch would add "Cache-Control: no-cache" to a hand-made conditional request)
  const revalidated = await new Promise((ok, no) => require("http").get(base + url, { headers: { "if-none-match": etag } }, (res) => { res.resume(); ok(res.statusCode); }).on("error", no));
  assert.equal(revalidated, 304);
  const out = Buffer.from(await f.arrayBuffer());
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, "webp"); assert.ok(meta.width <= SC.COVER_PX && meta.height <= SC.COVER_PX);
  assert.ok(!out.includes(Buffer.from("secret-gps-owner")), "metadata dropped");
  const row = (await getQuery("SELECT * FROM image_safety_log ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(row.surface, "stage_cover"); assert.equal(row.mode, "enforce");
  // refused (explicit): nothing new stored, the old picture stays
  ANSWER = EXPLICIT;
  const bad = await upload(U.bo, await png(200, 200, { r: 1, g: 2, b: 3 }));
  assert.equal(bad.status, 422, JSON.stringify(bad.d));
  assert.equal((await getQuery("SELECT upload FROM stage_covers WHERE user_id = ?", [U.bo.userId]))[0].upload, url.split("/").pop());
  // no classification in time + fail mode OPEN: still refused here (fail-closed), nothing stored
  await safety({ enabled: true, timeout_secs: 0.2, fail_mode: "open" });
  ANSWER = () => new Promise(() => {});
  const late = await upload(U.bo, await png(210, 200, { r: 9, g: 9, b: 9 }));
  assert.equal(late.status, 503, JSON.stringify(late.d)); assert.equal(late.d.code, "unchecked");
  assert.equal((await getQuery("SELECT upload FROM stage_covers WHERE user_id = ?", [U.bo.userId]))[0].upload, url.split("/").pop());
  // not a picture
  await safety({ enabled: true }); ANSWER = CLEAN;
  const html = await upload(U.bo, Buffer.from("<html><script>alert(1)</script></html>".repeat(4)));
  assert.equal(html.status, 415);
  // the owner takes it down: the file is gone, the default is back
  const rm = await call("POST", "/api/stage-cover/upload/remove", U.bo, {});
  assert.equal(rm.d.ok, true); assert.equal(rm.d.upload, null); assert.equal(rm.d.kind, "auto", "back to Automatic (no choice)");
  assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await SC.coverOf("bocf")).k, "gtf");
});

test("a FLAGGED upload is held: not served to others, the stage falls back; review fp puts it up, fn takes it down; admins take one down (others can't)", async () => {
  await safety({ enabled: true });
  ANSWER = HATE;
  const r = await upload(U.cy, await png());
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.held, true);
  assert.equal(r.d.upload.state, "held");
  const url = r.d.upload.url;
  assert.equal((await fetch(base + url)).status, 404, "signed out: nothing");
  assert.equal((await fetch(base + url, { headers: { "x-test-user": U.ann.userId } })).status, 404, "another member: nothing");
  const own = await fetch(base + url, { headers: { "x-test-user": U.cy.userId } });
  assert.equal(own.status, 200, "its owner sees it"); assert.match(own.headers.get("cache-control"), /private, no-store/);
  assert.deepEqual(await SC.coverOf("cycf"), { url: "https://cdn.example.test/cy.png", k: "photo" }, "held: the default (no GTF avatar -> her photo)");
  const logId = (await getQuery("SELECT upload_log FROM stage_covers WHERE user_id = ?", [U.cy.userId]))[0].upload_log;
  assert.ok(logId > 0);
  assert.equal((await getQuery("SELECT flagged FROM image_safety_log WHERE id = ?", [logId]))[0].flagged, 1);
  await ISF.review(logId, "fp", "boss");
  assert.deepEqual(await SC.coverOf("cycf"), { url, k: "upload" }, "false positive: up");
  assert.equal((await fetch(base + url)).status, 200);
  await ISF.review(logId, "fn", "boss");
  assert.equal((await fetch(base + url)).status, 404, "false negative: down");
  assert.equal((await SC.coverOf("cycf")).k, "photo");
  const st = await call("GET", "/api/stage-cover", U.cy);
  assert.equal(st.d.removed, true); assert.equal(st.d.upload, null);
  assert.equal(st.d.hold, true, "review fix SC-SAFE-1: a review take-down puts the account on hold");
  // review fix SC-SAFE-1: the same picture can't come straight back (refused before it's classified again)
  ANSWER = CLEAN;
  const same = await upload(U.cy, await png());
  assert.equal(same.status, 422, JSON.stringify(same.d)); assert.equal(same.d.code, "blocked");
  assert.notEqual((await SC.coverOf("cycf")).k, "upload");
  ANSWER = HATE;
  // a held one marked "correct" (the flag was right) comes down too
  const r2 = await upload(U.cy, await png(250, 250, { r: 50, g: 50, b: 200 }));
  const log2 = (await getQuery("SELECT upload_log FROM stage_covers WHERE user_id = ?", [U.cy.userId]))[0].upload_log;
  await ISF.review(log2, "ok", "boss");
  assert.equal((await fetch(base + r2.d.upload.url, { headers: { "x-test-user": U.cy.userId } })).status, 404);
  // a clean picture while the account is on hold (two take-downs): held for an admin; the card puts it up (admins only)
  ANSWER = CLEAN;
  const r3 = await upload(U.cy, await png(260, 250, { r: 90, g: 50, b: 20 }));
  assert.equal(r3.d.held, true, "review fix SC-SAFE-1: on hold - held");
  assert.ok((await SC.adminList()).some((c) => c.userId === U.cy.userId && c.state === "held" && c.onHold && c.strikes === 2 && c.inUse));
  for (const who of [U.cy, U.staff, null]) {
    const x = await call("POST", "/api/admin/stage-cover/release", who, { user_id: U.cy.userId });
    assert.ok(x.status === 403 || x.status === 401, (who ? who.username : "anon") + ": " + x.status);
  }
  assert.equal((await call("POST", "/api/admin/stage-cover/release", U.admin, { user_id: U.cy.userId })).status, 200);
  assert.deepEqual(await SC.coverOf("cycf"), { url: r3.d.upload.url, k: "upload" }, "put up");
  assert.ok((await SC.adminList()).some((c) => c.userId === U.cy.userId && c.state === "ok" && c.inUse));
  // the admin card's take-down: admins only (not staff, not members)
  for (const who of [U.cy, U.staff, null]) {
    const x = await call("POST", "/api/admin/stage-cover/remove", who, { user_id: U.cy.userId });
    assert.ok(x.status === 403 || x.status === 401, (who ? who.username : "anon") + ": " + x.status);
  }
  const x = await call("POST", "/api/admin/stage-cover/remove", U.admin, { user_id: U.cy.userId });
  assert.equal(x.status, 200, JSON.stringify(x.d));
  assert.equal((await fetch(base + r3.d.upload.url)).status, 404);
  assert.equal((await SC.coverOf("cycf")).k, "photo");
  // the admin page lists the card (Admins only - its own access rule)
  const page = await call("GET", "/admin/imagesafety", U.admin);
  assert.equal(page.status, 200);
  assert.match(page.text, /id="stagecovers"/);
  assert.match(page.text, /Stage covers \(mic stage pictures\)/, "the surface toggle");
});

test("the upload routes: same-site JSON / fetch only, signed in, chunk order and size checked", async () => {
  await safety({ enabled: true }); ANSWER = CLEAN;
  assert.equal((await call("POST", "/api/stage-cover/uploads", null, { size: 100 })).status, 401);
  assert.equal((await call("POST", "/api/stage-cover/uploads", U.ann, { size: 100 }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(base + "/api/stage-cover", { method: "POST", headers: { "content-type": "text/plain", origin: base, "x-test-user": U.ann.userId }, body: "kind=card" })).status, 415);
  assert.equal((await call("POST", "/api/stage-cover/uploads", U.ann, { size: SC.MAX_BYTES + 1 })).status, 413);
  const o = await call("POST", "/api/stage-cover/uploads", U.ann, { size: 5000 });
  const r = await fetch(base + `/api/stage-cover/uploads/${o.d.id}?offset=100`, { method: "PUT", body: Buffer.alloc(100),
    headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", origin: base, "x-test-user": U.ann.userId } });
  assert.equal(r.status, 409);
  const other = await fetch(base + `/api/stage-cover/uploads/${o.d.id}?offset=0`, { method: "PUT", body: Buffer.alloc(100),
    headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", origin: base, "x-test-user": U.cy.userId } });
  assert.equal(other.status, 404, "someone else's upload");
});

// ── Settings -> 🎙 Stage cover ──
test("Settings: signed out -> sign in; the page shows every choice (with what's missing), the preview, the privacy lines; saving works through the API; the hub has a row", async () => {
  const out = await call("GET", "/settings/stage-cover", null);
  assert.equal(out.status, 302); assert.equal(out.headers.get("location"), "/login?next=%2Fsettings%2Fstage-cover");
  await safety({ enabled: false });
  const p = await call("GET", "/settings/stage-cover", U.ann);
  assert.equal(p.status, 200);
  assert.match(p.headers.get("cache-control"), /no-store/);
  for (const k of ["gtf", "photo", "sticker", "upload", "card"]) assert.match(p.text, new RegExp('name="kind" value="' + k + '"'), k);
  assert.match(p.text, /<a class="ds-back" href="\/settings">← Settings<\/a>/);
  assert.ok(p.text.includes(EN["scov.upload_off"].replace(/'/g, "&#39;")) || p.text.includes(EN["scov.upload_off"]), "uploads: off, with the note");
  assert.doesNotMatch(p.text, /id="scFile"/, "no file input while uploads are off");
  assert.match(p.text, /value="sticker" disabled/, "no pack: the sticker choice is off");
  assert.match(p.text, /id="scNowImg" src="\/media\/cover\/a\/1111\./, "the preview: her GTF avatar");
  assert.doesNotMatch(p.text, /scov\.|js\.scov/, "no untranslated keys");
  // Bo has no profile photo: that choice is off
  assert.match((await call("GET", "/settings/stage-cover", U.bo)).text, /value="photo" disabled/);
  // dee has no Camfrog login: the page says how pad stages find her
  assert.match((await call("GET", "/settings/stage-cover", U.dee)).text, /href="\/settings\/account#camfrogDiv"/);
  // uploads on: the file input
  await safety({ enabled: true });
  assert.match((await call("GET", "/settings/stage-cover", U.ann)).text, /id="scFile"/);
  // the API
  let s = await call("POST", "/api/stage-cover", U.ann, { kind: "card" });
  assert.equal(s.status, 200); assert.equal(s.d.kind, "card"); assert.equal(s.d.now, null);
  s = await call("POST", "/api/stage-cover", U.ann, { kind: "photo" });
  assert.deepEqual(s.d.now, { url: "https://cdn.example.test/ann.png", k: "photo" });
  assert.equal((await call("POST", "/api/stage-cover", U.bo, { kind: "photo" })).status, 400);
  assert.equal((await call("POST", "/api/stage-cover", U.ann, { kind: "card" }, { origin: "https://evil.example" })).status, 403);
  // the hub row: its one home, with the choice as its state
  const hub = await call("GET", "/settings", U.ann);
  assert.match(hub.text, /data-entry="stagecover">\s*<a class="sh-row" href="\/settings\/stage-cover">[^]*?data-state>Profile picture</);
  await runQuery("DELETE FROM stage_covers");
});

test("account deletion and merges know the table; the strings exist; uploads are a safety surface with a toggle", () => {
  const AD = require(path.join(repo, "accountdelete"));
  assert.ok(AD.DELETE_ROWS.some(([t, c, k]) => t === "stage_covers" && c === "user_id" && k === "uid"));
  const AM = require(path.join(repo, "accountMerge"));
  assert.ok(AM.classify("stage_covers", "user_id"));
  for (const k of ["sethub.e.stagecover", "sethub.d.stagecover", "sethub.st.cover", "scov.k.gtf", "scov.k.card", "scov.privacy_veil", "js.scov.saved"]) assert.ok(EN[k], k);
  assert.equal(ISF.DEFAULTS.surfaces.stage_cover, true);
  assert.ok(ISF.SURFACE_LABEL.stage_cover);
});

// ── the stage page ──
function fakeDom() {
  function mk(tag) {
    const e = { tagName: String(tag).toUpperCase(), children: [], attrs: {}, style: {}, hidden: false, parentNode: null, listeners: {}, className: "", _text: "", _srcSets: 0,
      appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); this.children.push(c); c.parentNode = this; return c; },
      insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "src") this._srcSets++; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; }, hasAttribute(k) { return k in this.attrs; },
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
      set textContent(v) { this._text = String(v); this.children = []; },
      querySelectorAll() { return []; }, querySelector() { return null; },
      play() { return Promise.resolve(); }, focus() {}, getBoundingClientRect() { return { width: 640 }; }, clientWidth: 640 };
    Object.defineProperty(e, "src", { get() { return this.attrs.src || ""; }, set(v) { this.setAttribute("src", v); } });
    e.classList = { has(c) { return (" " + e.className + " ").includes(" " + c + " "); }, add(c) { if (!this.has(c)) e.className = (e.className + " " + c).trim(); },
      remove(c) { e.className = (" " + e.className + " ").replace(" " + c + " ", " ").trim(); }, toggle(c, on) { const w = on === undefined ? !this.has(c) : !!on; if (w) this.add(c); else this.remove(c); return w; },
      contains(c) { return this.has(c); } };
    Object.defineProperty(e, "innerHTML", { set() { throw new Error("innerHTML used"); }, get() { return ""; } });
    return e;
  }
  return { mk };
}
function stageSandbox() {
  const dom = fakeDom();
  const ctx = { document: { createElement: dom.mk, hidden: false, addEventListener() {}, removeEventListener() {} }, console, setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval() {}, fetch: () => Promise.resolve({ json: () => Promise.resolve({ ok: false }) }),
    PATVRtc: { watch: () => new Promise(() => {}) }, RTCPeerConnection: function () {}, Date };
  ctx.window = ctx; ctx.window.addEventListener = () => {}; ctx.window.removeEventListener = () => {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "stage-mic.js"), "utf8"), ctx);
  const host = dom.mk("div");
  return { ctx, host };
}
const tileOf = (host, id) => host.children[0].children[0].children.find((c) => c.getAttribute && c.getAttribute("data-id") === id);
const cardOf = (t) => t.children.find((c) => (" " + c.className + " ").includes(" mf-card "));
const imgOf = (card) => card.children[0].children[0];
const camS = (id, extra) => Object.assign({ kind: "cam", id, name: id.toUpperCase(), pos: 0, newest: true, video: "starting", why: null, watch: "ok" }, extra || {});

test("stage-mic.js: a card shows the cover picture (pixel art classes, alt empty) with the reason kept as its label; the src is set once for the same URL; a new one swaps; reported / blocked / no picture = the letter; a failed load = the letter", () => {
  const { ctx, host } = stageSandbox();
  const prog = (src) => ({ v: 1, layout: "single", count: src.length, src, still_s: 20 });
  const gtf = "/media/cover/a/1111.0123456789abcdef0123.svg";
  const ctl = ctx.PATVStageMic.render(host, prog([camS("ann", { avatar: gtf, ck: "gtf" })]), { slug: "pad" });
  let t = tileOf(host, "ann"), card = cardOf(t), img = imgOf(card);
  assert.ok(card.classList.contains("cov") && card.classList.contains("cv-gtf"), card.className);
  assert.equal(img.getAttribute("src"), gtf); assert.equal(img.hidden, false); assert.equal(img.alt, "");
  assert.match(card.textContent, /cam starting…/, "the reason stays");
  assert.equal(card.children[1].getAttribute("title"), "cam starting…", "review fix UX-1: the whole reason is the label's title (it's clamped under a picture)");
  assert.equal(card.children[0].children[1].hidden, true, "the letter is hidden while the picture shows");
  const sets0 = img._srcSets;
  for (let i = 0; i < 5; i++) ctl.update(prog([camS("ann", { avatar: gtf, ck: "gtf", why: "off_cam", video: "card" })]));
  assert.equal(img._srcSets, sets0, "the same picture is never set again on a program update");
  assert.match(cardOf(tileOf(host, "ann")).textContent, /cam off/);
  ctl.update(prog([camS("ann", { avatar: "https://cdn.example.test/ann.png", ck: "photo", video: "card", why: "off_cam" })]));
  card = cardOf(tileOf(host, "ann")); img = imgOf(card);
  assert.equal(img.getAttribute("src"), "https://cdn.example.test/ann.png");
  assert.ok(card.classList.contains("cv-photo") && !card.classList.contains("cv-gtf"));
  // reported (hidden for this viewer) / blocked: the letter
  for (const watch of ["hidden", "blocked"]) {
    ctl.update(prog([camS("ann", { avatar: gtf, ck: "gtf", watch, video: "card", why: "off_cam" })]));
    card = cardOf(tileOf(host, "ann")); img = imgOf(card);
    assert.equal(img.hidden, true, watch); assert.equal(img.getAttribute("src"), null, watch); assert.ok(!card.classList.contains("cov"), watch);
  }
  // unsafe URLs are never set
  for (const bad of ["javascript:alert(1)", "//evil.example/x.png", "http://insecure.example/x.png", "/x\" onerror=\"y"]) {
    ctl.update(prog([camS("ann", { avatar: bad, ck: "upload", video: "card", why: "off_cam" })]));
    assert.equal(imgOf(cardOf(tileOf(host, "ann"))).getAttribute("src"), null, bad);
  }
  // a picture that fails to load: the letter, and it isn't retried for the same URL
  ctl.update(prog([camS("ann", { avatar: gtf, ck: "gtf", video: "card", why: "off_cam" })]));
  img = imgOf(cardOf(tileOf(host, "ann")));
  img.listeners.error.forEach((fn) => fn());
  assert.equal(img.hidden, true); assert.equal(img.getAttribute("src"), null);
  ctl.update(prog([camS("ann", { avatar: gtf, ck: "gtf", video: "card", why: "cam_unknown" })]));
  assert.equal(imgOf(cardOf(tileOf(host, "ann"))).getAttribute("src"), null, "the broken URL isn't set again");
  ctl.update(prog([camS("ann", { avatar: gtf.replace("1111", "2222"), ck: "gtf", video: "card", why: "off_cam" })]));
  assert.ok(imgOf(cardOf(tileOf(host, "ann"))).getAttribute("src").includes("2222"), "a different picture is tried");
  // a veiled speaker's cover tile: the hood, never a stage cover - even with a URL in the entry
  ctl.update(prog([{ kind: "cover", id: "anon-0011aabb", name: "Soggy Bullfrog", hood: 2, veil: "incognito", pos: 0, video: "cover", watch: "cover", avatar: gtf, ck: "gtf" }]));
  t = tileOf(host, "anon-0011aabb"); card = cardOf(t);
  assert.equal(imgOf(card).getAttribute("src"), null); assert.ok(!card.classList.contains("cov"));
  assert.ok(!JSON.stringify(t.attrs).includes("/media/cover"), "no data attribute names it");
  ctl.stop();
});

test("stage-room.js repaints the mic stage when only a tile's cover picture changes; the CSS: the picture fills a cell big enough for it, a small cell keeps the letter card's look (no picture, the whole reason)", () => {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  const sig = src.slice(src.indexOf("function sigOf(p)"), src.indexOf("function setMic(p)"));
  const fn = new Function(sig + "; return sigOf;")();
  const a = { v: 1, src: [{ id: "ann", avatar: "/media/cover/a/1.x.svg", ck: "gtf" }] }, b = JSON.parse(JSON.stringify(a));
  assert.equal(fn(a), fn(b));
  b.src[0].avatar = "/media/cover/u/" + "a".repeat(32) + ".webp"; b.src[0].ck = "upload";
  assert.notEqual(fn(a), fn(b), "a new picture repaints");
  const css = fs.readFileSync(path.join(repo, "public", "css", "webrtc.css"), "utf8");
  assert.match(css, /\.mf-card\.cov \.mf-av \{ display: block !important; width: 100% !important; height: 100% !important;/, "sized by its grid row");
  assert.match(css, /\.mf-card\.cov \{ display: grid; grid-template-rows: minmax\(0, 1fr\) auto;[^}]*container: mfcov \/ size;/, "the picture row is definite: it never overflows the cell; the card is a size container");
  // review fix UX-2: a cell too small for a useful picture (the cells where the letter is hidden too) hides it and shows the whole reason
  const cq = /@container mfcov \(max-height: (\d+)px\) or \(max-width: (\d+)px\) \{([^]*?)\r?\n\}/.exec(css);
  assert.ok(cq, "the small-cell rule");
  assert.ok(Number(cq[1]) >= 60 && Number(cq[2]) >= 40, "a picture under ~32 px is never drawn: " + cq[1] + "/" + cq[2]);
  assert.match(cq[3], /\.mf-card\.cov \.mf-av \{ display: none !important; \}/);
  assert.match(cq[3], /\.mf-card\.cov \.mf-why \{ display: block; -webkit-line-clamp: unset; line-clamp: none; overflow: visible;/);
  // review fix UX-1: the reason under a picture wraps (2 lines, the title has it all), and never pokes out of its cell
  const why = /\.player \.mf-tile \.mf-card\.cov \.mf-why \{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(why, /nowrap|ellipsis/);
  assert.match(why, /box-sizing: border-box; max-width: 100%;/);
  assert.match(why, /white-space: normal;[^]*-webkit-line-clamp: 2;/);
  assert.match(css, /\.mf-card\.cv-gtf \.mf-av img, [^{]*\.mf-card\.cv-sticker \.mf-av img \{ image-rendering: pixelated;/);
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /stage-mic\.js\?v=10/); assert.match(room, /webrtc\.css\?v=8/);   // (stage-mic.js v10: 1.99ahn's v8 + 1.99ahp's v9 + the cover)
});

// ── the capture ──
test("stagemiccap: a consenting name card draws its cover picture (stagecover decides what it may fetch); without one the letter circle", async () => {
  const M = require(path.join(repo, "stagemiccap")), T = M._test;
  const R = { id: "pad", slug: "pad", title: "Pad" }, user = { userId: "viewer" };
  const red = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 230, g: 10, b: 10 } } }).png().toBuffer();
  const asked = [];
  M.configure({ hidden: () => false, privateLogins: async () => new Set(), camRefusal: async () => null, exact: () => false, still: () => null,
                cover: async (u) => { asked.push(u); return u.startsWith("/media/cover/") ? { buf: red, k: "upload" } : null; } });
  try {
    const e = { kind: "cam", id: "ann", name: "Ann", video: "card", watch: "ok", pos: 0, avatar: "/media/cover/u/" + "b".repeat(32) + ".webp", ck: "upload" };
    const t = await T.tileFor(e, R, user);
    assert.equal(t.mode, "card"); assert.ok(t.cover && t.cover.buf.equals(red));
    const net = await T.tileFor({ ...e, id: "cy", avatar: "https://cdn.example.test/cy.png", ck: "photo" }, R, user);
    assert.equal(net.cover, null, "a photo stagecover won't give: the letter");
    // (1.99?? fix 3: a photo URL is handed to stagecover.captureImage too - it fetches allowed hosts only; anything else never is)
    for (const bad of ["//evil.test/x.png", "http://cdn.example.test/x.png", "/media/cover/u/../../etc/passwd", "javascript:alert(1)", "/other/x.png"]) {
      assert.equal((await T.tileFor({ ...e, id: "cy", avatar: bad, ck: "photo" }, R, user)).cover, null, bad);
    }
    assert.deepEqual(asked, [e.avatar, "https://cdn.example.test/cy.png"], "deps.cover is asked only for cover paths and https photos");
    const p = { layout: "single", src: [e] };
    const px = async (tile) => {
      const buf = await M.renderFrame(p, [tile], R);
      const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      const at = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
      return at(640, 330);
    };
    const withCover = await px(t);
    assert.ok(withCover[0] > 200 && withCover[1] < 40, "the cover drawn in the middle: " + withCover);
    const plain = await px({ ...t, cover: null });
    assert.ok(!(plain[0] > 200 && plain[1] < 40), "no cover: the letter card " + plain);
  } finally { M.configure(T.defaults); }
});

// ── review fixes (1.99??) ──
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const logOf = async (u) => (await getQuery("SELECT upload_log FROM stage_covers WHERE user_id = ?", [u.userId]))[0].upload_log;

test("review fix SC-SAFE-1: an admin's take-down sticks - the same picture is refused (any account) before it's classified again, the account's next pictures are held until an admin puts one up, one held at a time; the hold ends after HOLD_MS; the owner's own removal is no strike", async () => {
  const u = await mkUser("eve", { camfrog: "evecf" });
  await safety({ enabled: true });
  let calls = 0;
  ISF.setClassifier(async () => { calls++; return CLEAN; });
  const pic = await png(240, 200, { r: 200, g: 200, b: 10 });
  let r = await upload(u, pic);
  assert.equal(r.d.held, false);
  await call("POST", "/api/stage-cover/upload/remove", u, {});
  r = await upload(u, pic);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.held, false, "the owner's own removal: no strike, no block");
  assert.equal(r.d.hold, false);
  assert.equal((await call("POST", "/api/admin/stage-cover/remove", U.admin, { user_id: u.userId })).status, 200);
  const n0 = calls;
  const again = await upload(u, pic);
  assert.equal(again.status, 422, JSON.stringify(again.d)); assert.equal(again.d.code, "blocked");
  assert.equal((await upload(U.dee, pic)).d.code, "blocked", "the picture is blocked, whoever sends it");
  assert.equal(calls, n0, "refused before any classification");
  assert.ok((await getQuery("SELECT why FROM stage_cover_blocks")).every((b) => !/boss|eve|u_/.test(b.why)), "the block names nobody");
  // another picture: checked and taken, but HELD - not public, the stage shows the default
  const q = await upload(u, await png(250, 200, { r: 10, g: 10, b: 200 }));
  assert.equal(q.status, 200, JSON.stringify(q.d)); assert.equal(q.d.held, true); assert.equal(q.d.hold, true);
  assert.equal((await fetch(base + q.d.upload.url)).status, 404);
  assert.equal(await SC.coverOf("evecf"), null, "no GTF seed, no photo: the letter while it's held");
  assert.ok((await call("GET", "/settings/stage-cover", u)).text.includes(EN["scov.upload_hold"]), "the page says why");
  const busy = await call("POST", "/api/stage-cover/uploads", u, { size: 1000 });
  assert.equal(busy.status, 409); assert.equal(busy.d.code, "held", "one picture waiting for a check at a time");
  // review fix SC-SAFE-6 (part): the admins see a held picture (the card's preview); nobody else does
  assert.equal((await fetch(base + q.d.upload.url, { headers: { "x-test-user": U.admin.userId } })).status, 200);
  assert.equal((await fetch(base + q.d.upload.url, { headers: { "x-test-user": U.staff.userId } })).status, 404);
  assert.equal((await call("POST", "/api/admin/stage-cover/release", U.admin, { user_id: u.userId })).status, 200);
  assert.deepEqual(await SC.coverOf("evecf"), { url: q.d.upload.url, k: "upload" });
  // HOLD_MS later: no longer held
  SC._setClock(() => Date.now() + SC.HOLD_MS + 60e3);
  try {
    const z = await upload(u, await png(260, 200, { r: 90, g: 10, b: 90 }));
    assert.equal(z.status, 200, JSON.stringify(z.d)); assert.equal(z.d.held, false); assert.equal(z.d.hold, false);
  } finally { SC._setClock(null); }
  ISF.setClassifier(async () => (typeof ANSWER === "function" ? ANSWER() : ANSWER));
});

test("review fix SC-SAFE-3: uploads are capped per account (UPLOADS_PER_HOUR / UPLOADS_PER_DAY safety checks) - refused before any classification", async () => {
  const u = await mkUser("flo", { camfrog: "flocf" });
  await safety({ enabled: true });
  let calls = 0;
  ISF.setClassifier(async () => { calls++; return CLEAN; });
  for (let i = 0; i < SC.UPLOADS_PER_HOUR; i++) {
    const r = await upload(u, await png(200 + i, 200, { r: 30 * i, g: 60, b: 70 }));
    assert.equal(r.status, 200, "upload " + i + ": " + JSON.stringify(r.d));
  }
  const n0 = calls;
  const over = await call("POST", "/api/stage-cover/uploads", u, { size: 5000 });
  assert.equal(over.status, 429); assert.equal(over.d.code, "rate");
  await assert.rejects(SC.setUpload(u.userId, await png(300, 300)), /this hour/);
  assert.equal(calls, n0, "no classification over the cap");
  // the day's cap counts the earlier hours too
  const v = await mkUser("gil", { camfrog: "gilcf" });
  for (let i = 0; i < SC.UPLOADS_PER_DAY; i++) {
    await runQuery("INSERT INTO image_safety_log (at, surface, user_id, mode, action) VALUES (?, 'stage_cover', ?, 'enforce', 'allow')", [Date.now() - 3 * 3600e3, v.userId]);
  }
  const day = await call("POST", "/api/stage-cover/uploads", v, { size: 5000 });
  assert.equal(day.status, 429); assert.match(day.d.error, /today/);
  assert.equal((await call("POST", "/api/stage-cover/uploads", U.ann, { size: 5000 })).status, 200, "other accounts aren't touched");
  ISF.setClassifier(async () => (typeof ANSWER === "function" ? ANSWER() : ANSWER));
});

test("review fix SC-SAFE-4: a restricted account can't upload a cover - archived, casino_banned, a global feed ban, Pepe's global feed_restricted (a pad's own ban isn't one)", async () => {
  await safety({ enabled: true }); ANSWER = CLEAN;
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
                  PRIMARY KEY (user_id, room_id))`);
  await runQuery("CREATE TABLE IF NOT EXISTS feed_restricted (login TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', reason TEXT, until INTEGER, PRIMARY KEY (login, room_id))");
  const a = await mkUser("rex", { camfrog: "RexCF" });
  const id = a.userId;
  const cases = [
    ["casino_banned", "UPDATE users SET casino_banned = 1 WHERE userId = ?", [id], "UPDATE users SET casino_banned = 0 WHERE userId = ?", [id]],
    ["archived", "UPDATE users SET archived_at = 1 WHERE userId = ?", [id], "UPDATE users SET archived_at = NULL WHERE userId = ?", [id]],
    ["a global feed ban", "INSERT INTO feed_bans (user_id, room_id, until) VALUES (?, '', NULL)", [id], "DELETE FROM feed_bans WHERE user_id = ?", [id]],
    ["Pepe's restriction", "INSERT INTO feed_restricted (login, room_id, reason, until) VALUES ('rexcf', '', 'spam', ?)", [Date.now() + 3600e3], "DELETE FROM feed_restricted WHERE login = 'rexcf'", []],
  ];
  for (const [what, on, onArgs, off, offArgs] of cases) {
    await runQuery(on, onArgs);
    try {
      const o = await call("POST", "/api/stage-cover/uploads", a, { size: 5000 });
      assert.equal(o.status, 403, what + ": " + JSON.stringify(o.d)); assert.equal(o.d.code, "restricted", what);
      await assert.rejects(SC.setUpload(id, await png()), (e) => e.code === "restricted", what + " (the check before classifying)");
    } finally { await runQuery(off, offArgs); }
  }
  // an expired ban and a pad's own ban don't count
  await runQuery("INSERT INTO feed_bans (user_id, room_id, until) VALUES (?, '', ?), (?, 'somepad', NULL)", [id, Date.now() - 1000, id]);
  try { assert.equal((await call("POST", "/api/stage-cover/uploads", a, { size: 5000 })).status, 200); }
  finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [id]); }
});

test("review fix SC-SAFE-5: a held cover put up by a mistaken 'False positive' comes down again when the review is corrected to 'Correct'; 'Correct' on a clean pass leaves it up", async () => {
  const u = await mkUser("hal", { camfrog: "halcf" });
  await seed("halcf", 6161);
  await safety({ enabled: true }); ANSWER = HATE;
  const r = await upload(u, await png(230, 230, { r: 1, g: 100, b: 200 }));
  assert.equal(r.d.held, true);
  const logId = await logOf(u);
  await ISF.review(logId, "fp", "boss");
  assert.equal((await fetch(base + r.d.upload.url)).status, 200, "fp: up");
  await ISF.review(logId, "ok", "boss");
  assert.equal((await fetch(base + r.d.upload.url)).status, 404, "corrected to ok: down");
  assert.deepEqual(await SC.coverOf("halcf"), { url: SC.gtfUrl(6161, {}), k: "gtf" });
  // a clean pass marked "Correct": stays up
  const w = await mkUser("wes", { camfrog: "wescf" });
  ANSWER = CLEAN;
  const c = await upload(w, await png(231, 230, { r: 1, g: 100, b: 201 }));
  await ISF.review(await logOf(w), "ok", "boss");
  assert.equal((await fetch(base + c.d.upload.url)).status, 200);
});

test("review fix SC-SAFE-7: an 'ok' upload whose file is missing (a restore without the cover folder) is no upload - the default shows, not a broken picture", async () => {
  const u = await mkUser("gus", { camfrog: "guscf" });
  await seed("guscf", 5151);
  await safety({ enabled: true }); ANSWER = CLEAN;
  const r = await upload(u, await png(220, 220, { r: 5, g: 90, b: 5 }));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal((await SC.coverOf("guscf")).k, "upload");
  fs.unlinkSync(SC.filePath(r.d.upload.url.split("/").pop()));
  SC.invalidate();
  assert.deepEqual(await SC.coverOf("guscf"), { url: SC.gtfUrl(5151, {}), k: "gtf" });
});

test("review fix PRIV-3: a failed account read never makes a linked member 'Camfrog-only' (whose seed would override their choice): the letter, not cached; a failed incognito read fails closed too", async () => {
  await SC.save(U.bo.userId, { kind: "card" });                     // bo has a seed (2222) and chose the plain card
  try {
    assert.equal(await SC.coverOf("bocf"), null);
    SC.invalidate();
    FAIL_SQL = /FROM users WHERE LOWER\(camfrogUsername\)/;
    try {
      assert.equal(await SC.coverOf("bocf"), null, "a failed read: the letter, never her seed's GTF avatar");
      assert.equal(await SC.coverOf("anncf"), null, "(ann too)");
    } finally { FAIL_SQL = null; }
    assert.equal((await SC.coverOf("anncf")).k, "gtf", "the failure wasn't cached");
    SC.invalidate();
    FAIL_SQL = /FROM incognito_state/;
    try { assert.equal(await SC.coverOf("anncf"), null, "Pepe's incognito report unreadable: no cover"); } finally { FAIL_SQL = null; }
    assert.equal((await SC.coverOf("anncf")).k, "gtf");
  } finally { await runQuery("DELETE FROM stage_covers WHERE user_id = ?", [U.bo.userId]); SC.invalidate(); }
});

test("review fix COMPAT-1: the GTF cover URL carries avatar.js's render version - a redraw gives new URLs; the old ones 404", async () => {
  const before = SC.gtfUrl(1111, {});
  assert.equal((await fetch(base + before)).status, 200);
  SC._setRenderVersion("redrawn-layers");
  try {
    const after = SC.gtfUrl(1111, {});
    assert.notEqual(after, before);
    assert.equal(SC.parseGtf(before.split("/").pop()), null);
    assert.equal((await fetch(base + before)).status, 404);
    const r = await fetch(base + after);
    assert.equal(r.status, 200); assert.match(r.headers.get("cache-control"), /immutable/);
  } finally { SC._setRenderVersion(null); }
  assert.equal(SC.gtfUrl(1111, {}), before, "back to avatar.js's own version");
});

test("review fix UX-3: no saved choice = 'Automatic' - checked on the page (never GTF), the hub says so; Save untouched changes nothing; picking it is the way back to the default; each option carries its preview", async () => {
  const photo = "https://cdn.example.test/jo.png";
  const u = await mkUser("jo", { camfrog: "jocf", avatar: photo });
  await seed("jocf", 7171);
  await PLY.save(u.userId, { ...PLY.DEFAULT, hidden: ["gtf"] });
  try {
    assert.deepEqual(await SC.coverOf("jocf"), { url: photo, k: "photo" }, "her GTF section is hidden: the photo");
    const p = await call("GET", "/settings/stage-cover", u);
    assert.match(p.text, /name="kind" value="auto" checked/);
    assert.doesNotMatch(p.text, /name="kind" value="gtf" checked/);
    assert.match(p.text, new RegExp('data-kind="gtf" data-pv="' + escRe(SC.gtfUrl(7171, {})) + '" data-pk="gtf"'), "the GTF option's preview");
    assert.match(p.text, new RegExp('data-kind="auto" data-pv="' + escRe(photo) + '" data-pk="photo"'));
    const hub = await call("GET", "/settings", u);
    assert.match(hub.text, new RegExp('data-entry="stagecover">\\s*<a class="sh-row" href="/settings/stage-cover">[^]*?data-state>' + escRe(EN["scov.k.auto"]) + "<"));
    assert.equal(await SC.choiceOf(u.userId), "auto");
    let s = await call("POST", "/api/stage-cover", u, { kind: "auto" });           // Save on the untouched form
    assert.equal(s.status, 200); assert.equal(s.d.kind, "auto"); assert.equal(s.d.chosen, false);
    assert.deepEqual(s.d.now, { url: photo, k: "photo" }, "still her photo - her hidden GTF section is respected");
    s = await call("POST", "/api/stage-cover", u, { kind: "gtf" });
    assert.equal(s.d.now.k, "gtf", "picked: shown anyway");
    s = await call("POST", "/api/stage-cover", u, { kind: "auto" });
    assert.deepEqual(s.d.now, { url: photo, k: "photo" }, "Automatic: back to the default");
    assert.equal(s.d.chosen, false); assert.equal(await SC.choiceOf(u.userId), "auto");
    assert.deepEqual(s.d.preview, { auto: { url: photo, k: "photo" }, gtf: { url: SC.gtfUrl(7171, {}), k: "gtf" }, photo: { url: photo, k: "photo" },
                                    upload: { url: photo, k: "photo" }, card: null });
  } finally { await PLY.reset(u.userId); }
});

// a small DOM for public/js/stage-cover.js (no jsdom here): elements with attributes, children, classList and a querySelector for
// compound selectors (tag, .class, [attr="v"], :checked) joined by spaces
function miniDom() {
  const byId = {};
  function el(tag, attrs = {}, kids = []) {
    const e = { tagName: tag.toUpperCase(), attrs: {}, children: [], parentNode: null, listeners: {}, checked: false, disabled: false, hidden: false, _text: "",
      setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") byId[v] = this; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      hasAttribute(k) { return k in this.attrs; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); },
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
      set textContent(v) { this._text = String(v); this.children = []; },
      get className() { return this.attrs.class || ""; }, set className(v) { this.attrs.class = String(v); },
      get src() { return this.attrs.src || ""; }, set src(v) { this.attrs.src = String(v); },
      get value() { return this.attrs.value || ""; }, get name() { return this.attrs.name || ""; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) {
        const parts = sel.trim().split(/\s+/);
        const all = (n) => n.children.flatMap((c) => [c, ...all(c)]);
        let set = [this];
        for (const p of parts) { const next = []; for (const n of set) for (const d of all(n)) if (match(d, p) && !next.includes(d)) next.push(d); set = next; }
        return set;
      } };
    e.classList = { contains: (c) => (" " + e.className + " ").includes(" " + c + " "),
      toggle(c, on) {
        const has = this.contains(c), w = on === undefined ? !has : !!on;
        if (w && !has) e.className = (e.className + " " + c).trim();
        if (!w && has) e.className = (" " + e.className + " ").replace(" " + c + " ", " ").trim();
        return w;
      } };
    for (const [k, v] of Object.entries(attrs)) { if (k === "checked") e.checked = !!v; else e.setAttribute(k, v); }
    for (const k of kids) e.appendChild(k);
    return e;
  }
  function match(e, p) {
    const m = /^([a-z]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)(:checked)?$/.exec(p);
    if (!m) throw new Error("selector " + p);
    if (m[1] && e.tagName !== m[1].toUpperCase()) return false;
    for (const c of (m[2] || "").split(".").filter(Boolean)) if (!e.classList.contains(c)) return false;
    for (const a of (m[3] || "").match(/\[[^\]]+\]/g) || []) {
      const [, k, v] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(a);
      if (!(k in e.attrs) || (v !== undefined && e.attrs[k] !== v)) return false;
    }
    if (m[4] && !e.checked) return false;
    return true;
  }
  return { el, byId };
}

test("review fix UX-4: picking an option previews it at once on the page (marked not saved), from each option's preview; picking the saved one again shows 'Showing'", () => {
  const { el, byId } = miniDom();
  const photo = "https://cdn.example.test/jo.png", gtf = "/media/cover/a/7171.0123456789abcdef0123.svg", stk = "/public/stickers/pixelpepe/cool.svg";
  const radio = (v, on) => el("input", { type: "radio", name: "kind", value: v, checked: on });
  const opt = (kind, pv, pk, kids) => el("div", { class: "sc-opt", "data-kind": kind, "data-pv": pv, "data-pk": pk }, kids);
  const r = { auto: radio("auto", true), gtf: radio("gtf"), sticker: radio("sticker"), card: radio("card") };
  const sIn = el("input", { type: "radio", name: "sticker", value: "pixelpepe/cool" });
  const form = el("form", { id: "scForm" }, [
    opt("auto", photo, "photo", [el("label", { class: "sc-head" }, [r.auto])]),
    opt("gtf", gtf, "gtf", [el("label", { class: "sc-head" }, [r.gtf])]),
    el("div", { class: "sc-opt", "data-kind": "sticker" }, [el("label", { class: "sc-head" }, [r.sticker, el("span", { class: "sc-thumb" })]),
      el("label", { class: "sc-stk" }, [sIn, el("img", { src: stk })])]),
    opt("card", "", "", [el("label", { class: "sc-head" }, [r.card])]),
    el("button", { id: "scSave" }), el("p", { id: "scMsg" })]);
  const tile = el("div", { id: "scNowTile", "data-k": "photo" }, [el("span", { class: "sc-pic" }, [el("img", { id: "scNowImg", src: photo })])]);
  const txt = el("p", { id: "scNowTxt" });
  el("main", { id: "scov", "data-max-mb": "5", "data-letter": "J" }, [tile, txt, form]);
  const ctx = { document: { getElementById: (id) => byId[id] || null, createElement: (t) => el(t) }, console, fetch: () => new Promise(() => {}) };
  ctx.window = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "stage-cover.js"), "utf8"), ctx);
  const pick = (target) => { for (const x of Object.values(r)) x.checked = x === target; form.listeners.change.forEach((fn) => fn({ target })); };
  const shown = () => { const i = tile.querySelector("img"); return i ? i.getAttribute("src") : null; };
  pick(r.gtf);
  assert.equal(shown(), gtf); assert.equal(tile.getAttribute("data-k"), "gtf"); assert.ok(tile.classList.contains("draft"));
  assert.match(txt.textContent, /^Preview: GTF avatar/);
  pick(r.card);
  assert.equal(shown(), null); assert.equal(tile.querySelector("span").textContent, "J"); assert.match(txt.textContent, /^Preview: a plain card/);
  sIn.checked = true;
  form.listeners.change.forEach((fn) => fn({ target: sIn }));
  assert.equal(r.sticker.checked, true, "a sticker picked = the sticker cover picked");
  assert.equal(shown(), stk); assert.equal(tile.getAttribute("data-k"), "sticker");
  pick(r.auto);
  assert.equal(shown(), photo); assert.ok(!tile.classList.contains("draft")); assert.match(txt.textContent, /^Showing: Profile picture/);
});

test("review fix SC-SAFE-6: the safety sweep keeps the check a stage cover still points at (and its thumbnail) - a held picture stays reviewable after retention_days", async () => {
  const u = await mkUser("ivy", { camfrog: "ivycf" });
  await safety({ enabled: true }); ANSWER = HATE;
  const r = await upload(u, await png(240, 240, { r: 120, g: 0, b: 60 }));
  assert.equal(r.d.held, true);
  const logId = await logOf(u);
  await runQuery("INSERT INTO image_safety_log (at, surface, user_id, mode, action) VALUES (1, 'feed', 'someone', 'enforce', 'allow')");
  const gone = await ISF.sweep(Date.now() + 31 * 86400e3);
  assert.ok(gone >= 1, "other old checks go");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM image_safety_log WHERE id = ?", [logId]))[0].n, 1, "the held cover's check stays");
  assert.equal((await fetch(base + "/admin/imagesafety/thumb/" + logId, { headers: { "x-test-user": U.admin.userId } })).status, 200, "its thumbnail too");
  await ISF.review(logId, "fp", "boss");
  assert.equal((await fetch(base + r.d.upload.url)).status, 200, "still reviewable: put up");
  ANSWER = CLEAN;
});

test("review fix 2 SC-SAFE-1b: a review take-down reaches a picture the member already REPLACED or REMOVED - blocked (refused before it's classified again), the account held (one strike per check); a copy that's up again comes down; the check records name nobody and go with their log rows", async () => {
  await safety({ enabled: true });
  let calls = 0;
  const as = (a) => ISF.setClassifier(async () => { calls++; return a; });
  const strikes = async (u) => Number(((await getQuery("SELECT strikes FROM stage_covers WHERE user_id = ?", [u.userId]))[0] || {}).strikes) || 0;
  const state = async (u) => (await call("GET", "/api/stage-cover", u)).d;
  try {
    // REPLACED: X (clean, up), Y replaces it, then "False negative" on X's check
    const kai = await mkUser("kai", { camfrog: "kaicf" });
    as(CLEAN);
    const X = await png(270, 210, { r: 160, g: 40, b: 120 });
    const rx = await upload(kai, X);
    assert.equal(rx.status, 200, JSON.stringify(rx.d)); assert.equal(rx.d.held, false);
    const logX = await logOf(kai);
    const ry = await upload(kai, await png(271, 210, { r: 40, g: 160, b: 120 }));
    assert.equal(ry.d.held, false);
    assert.notEqual(await logOf(kai), logX, "X is no longer the current upload");
    assert.equal(await SC.onReview(logX, "fp", "boss"), null, "fp on an old check: nothing");
    await ISF.review(logX, "fn", "boss");
    assert.equal((await state(kai)).hold, true, "the account is on hold");
    assert.equal(await strikes(kai), 1);
    assert.equal((await fetch(base + ry.d.upload.url)).status, 200, "Y passed its own check: it stays up");
    const n0 = calls;
    const back = await upload(kai, X);
    assert.equal(back.status, 422, JSON.stringify(back.d)); assert.equal(back.d.code, "blocked");
    assert.equal((await upload(U.dee, X)).d.code, "blocked", "whoever sends it");
    assert.equal(calls, n0, "refused before any classification");
    await ISF.review(logX, "fn", "boss"); await ISF.review(logX, "ok", "boss");
    assert.equal(await strikes(kai), 1, "marking the same check again: no second strike");
    const next = await upload(kai, await png(272, 210, { r: 4, g: 4, b: 140 }));
    assert.equal(next.status, 200, JSON.stringify(next.d)); assert.equal(next.d.held, true, "the next picture is held for an admin");
    // REMOVED by its owner: a FLAGGED (held) picture, removed, then "Correct" on its check
    const lia = await mkUser("lia", { camfrog: "liacf" });
    as(HATE);
    const F = await png(273, 210, { r: 200, g: 120, b: 0 });
    const rf = await upload(lia, F);
    assert.equal(rf.d.held, true);
    const logF = await logOf(lia);
    assert.equal((await call("POST", "/api/stage-cover/upload/remove", lia, {})).d.upload, null);
    assert.equal((await state(lia)).hold, false, "the owner's own removal: no strike");
    await ISF.review(logF, "ok", "boss");
    assert.equal((await state(lia)).hold, true, "'Correct' on the flagged check: held");
    as(CLEAN);
    const again = await upload(lia, F);
    assert.equal(again.status, 422, JSON.stringify(again.d)); assert.equal(again.d.code, "blocked");
    assert.equal((await upload(lia, await png(274, 210, { r: 9, g: 120, b: 9 }))).d.held, true);
    // a clean pass marked "Correct" after it was replaced: nothing
    const mo = await mkUser("mo", { camfrog: "mocf" });
    const Z = await png(275, 210, { r: 230, g: 230, b: 230 });
    const z1 = await upload(mo, Z);
    assert.equal(z1.d.held, false);
    const logZ1 = await logOf(mo);
    await upload(mo, await png(276, 210, { r: 30, g: 30, b: 30 }));
    const logW = await logOf(mo);
    // RE-UPLOADED under a newer check before the review, and another account's copy: both come down (one strike, its owner's only)
    const z2 = await upload(mo, Z);
    assert.equal(z2.d.held, false);
    const logZ2 = await logOf(mo);
    const nia = await mkUser("nia", { camfrog: "niacf" });
    const zn = await upload(nia, Z);
    assert.equal(zn.status, 200, JSON.stringify(zn.d)); assert.equal(zn.d.held, false);
    await ISF.review(logW, "ok", "boss");
    assert.equal(await strikes(mo), 0, "'Correct' on a clean pass: no take-down");
    assert.equal((await fetch(base + z2.d.upload.url)).status, 200);
    await ISF.review(logZ1, "fn", "boss");
    assert.equal((await fetch(base + z2.d.upload.url)).status, 404, "the re-upload of the same picture comes down");
    assert.equal((await fetch(base + zn.d.upload.url)).status, 404, "another account's copy too");
    assert.equal(await strikes(mo), 1); assert.equal((await state(mo)).removed, true);
    assert.equal(await strikes(nia), 0); assert.equal((await state(nia)).hold, false, "a copy's account: no strike"); assert.equal((await state(nia)).removed, true);
    assert.notEqual((await SC.coverOf("mocf") || {}).k, "upload"); assert.notEqual((await SC.coverOf("niacf") || {}).k, "upload");
    await ISF.review(logZ2, "fn", "boss");
    assert.equal(await strikes(mo), 1, "the copy's own check, marked later: already taken down - no second strike");
    // the records: a log id, the picture's hash, when - nobody named; gone with their log rows (imagesafety's retention)
    const cols = (await getQuery("PRAGMA table_info(stage_cover_checks)")).map((c) => c.name);
    assert.deepEqual(cols, ["log_id", "hash", "at", "taken"]);
    assert.ok((await getQuery("SELECT log_id FROM stage_cover_checks WHERE log_id = ?", [logX])).length);
    await ISF.sweep(Date.now() + 31 * 86400e3);
    assert.ok((await SC.sweepChecks()) >= 1);
    assert.equal((await getQuery("SELECT log_id FROM stage_cover_checks WHERE log_id = ?", [logX])).length, 0, "X's check is gone: its record too");
    assert.equal((await getQuery("SELECT log_id FROM stage_cover_checks WHERE log_id = ?", [await logOf(kai)])).length, 1, "a held cover's check stays: its record too");
  } finally { ISF.setClassifier(async () => (typeof ANSWER === "function" ? ANSWER() : ANSWER)); }
});

test("review fix 2 UX-1b: a short reason in a small cell stays on one line - the cover card's column is the card's whole width (minmax(0, 1fr)), so the reason's max-width: 90% is 90% of the cell, not 90% of its own width", () => {
  const css = fs.readFileSync(path.join(repo, "public", "css", "webrtc.css"), "utf8");
  // (the letter card's justify-content: center, which the cover card keeps, sizes an implicit column by its content: then a reason
  // alone in a small cell - the picture hidden - wrapped at 90% of its own width, "cam off" on two lines over the name label)
  assert.match(/\.player \.mf-tile \.mf-card \{([^}]*)\}/.exec(css)[1], /justify-content: center/);
  const card = /\.player \.mf-tile \.mf-card\.cov \{([^}]*)\}/.exec(css)[1];
  assert.match(card, /grid-template-rows: minmax\(0, 1fr\) auto; grid-template-columns: minmax\(0, 1fr\);/, "a definite, full-width column");
  const cq = /@container mfcov \(max-height: \d+px\) or \(max-width: \d+px\) \{([^]*?)\r?\n\}/.exec(css)[1];
  assert.match(cq, /\.mf-card\.cov \.mf-why \{[^}]*max-width: 90%;/, "the small-cell reason: 90% of the cell, like the letter card's");
});

// ── fix 3 (1.99??): a capture draws the photo too (the allow-list, the guarded fetch, the proxy); held pictures in held/; the block race ──
const http = require("http");
const P = "/avatars/123456789012345678/";
const discordAt = (f) => "https://cdn.discordapp.com" + P + f;
/** A local stand-in for the photo hosts (no test ever reaches the internet): path -> handler(req, res). */
async function photoHost(routes) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    const h = routes[req.url];
    if (h) return h(req, res);
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { hits, port: srv.address().port, close: () => new Promise((r) => { if (srv.closeAllConnections) srv.closeAllConnections(); srv.close(() => r()); }) };
}
/** The photo fetch's network, stubbed: every host "resolves" to addrs() (a public address by default); requests go to the local host. */
function stubNet(host, { addrs = () => [{ address: "93.184.216.34", family: 4 }], seen = [] } = {}) {
  return {
    lookup: async (h) => { seen.push({ lookup: h }); return addrs(h); },
    request: (opts, cb) => { seen.push({ opts }); return http.request({ host: "127.0.0.1", port: host.port, path: opts.path, method: opts.method, headers: opts.headers, agent: false }, cb); },
  };
}
const allFiles = () => {
  const out = new Set();
  for (const root of [SC.dir(), path.join(SC.dir(), "held")]) {
    let subs = [];
    try { subs = fs.readdirSync(root).filter((d) => /^[a-f0-9]{2}$/.test(d)); } catch (e) { continue; }
    for (const d of subs) for (const f of fs.readdirSync(path.join(root, d))) out.add(path.relative(SC.dir(), path.join(root, d, f)));
  }
  return out;
};

test("fix 3: the photo allow-list = the hosts the site writes into users.avatar (its S3 bucket, Discord, Twitch): https on 443 only, no credentials, their avatar paths; private / loopback / link-local / CGNAT / mapped addresses are never public", () => {
  const env = { b: process.env.S3_BUCKET_NAME, r: process.env.AWS_REGION, x: process.env.COVER_PHOTO_HOSTS };
  const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try {
    put("S3_BUCKET_NAME", "pics.patv-test.example"); put("AWS_REGION", "us-east-2"); put("COVER_PHOTO_HOSTS", " img.patv-cdn.test , 10.0.0.1, bad host");
    const ok = [discordAt("a".repeat(32) + ".png"), "https://cdn.discordapp.com/embed/avatars/3.png", discordAt("a_" + "b".repeat(32) + ".gif?size=256"),
      "https://static-cdn.jtvnw.net/jtv_user_pictures/abc-profile_image-300x300.png", "https://static-cdn.jtvnw.net/user-default-pictures-uv/x-profile_image-300x300.png",
      "https://pics.patv-test.example/avatars/u1-1700000000000.jpeg", "https://pics.patv-test.example.s3.amazonaws.com/avatars/u1-1.jpeg",
      "https://pics.patv-test.example.s3.us-east-2.amazonaws.com/avatars/u1-1.jpeg", "https://s3.us-east-2.amazonaws.com/pics.patv-test.example/avatars/u1-1.jpeg",
      "https://s3.amazonaws.com/pics.patv-test.example/avatars/u1-1.jpeg", "https://img.patv-cdn.test/avatars/u1.jpeg", "https://CDN.DISCORDAPP.COM/avatars/1/x.png"];
    for (const u of ok) assert.ok(SC.photoSource(u), "allowed: " + u);
    const no = ["http://cdn.discordapp.com/avatars/1/x.png", "https://cdn.discordapp.com:8443/avatars/1/x.png", "https://u:p@cdn.discordapp.com/avatars/1/x.png",
      "https://cdn.discordapp.com/attachments/1/2/x.png", "https://cdn.discordapp.com/avatars/", "https://cdn.discordapp.com.evil.test/avatars/1/x.png",
      "https://evil.test/cdn.discordapp.com/avatars/1/x.png", "https://cdn.example.test/ann.png", "https://127.0.0.1/avatars/x.png", "https://[::1]/avatars/x.png",
      "https://10.0.0.1/avatars/x.png", "https://s3.amazonaws.com/other-bucket/avatars/x.jpeg", "https://pics.patv-test.example/other/x.jpeg",
      "https://other.s3.amazonaws.com/avatars/x.jpeg", "https://cdn.discordapp.com/avatars/1/../../attachments/x.png", "https://cdn.discordapp.com/avatars/1/x.png#f",
      "https://static-cdn.jtvnw.net/other/x.png", "/public/img/avatar.png", "", null, "javascript:alert(1)", "https://cdn.discordapp.com/avatars/1/" + "x".repeat(700) + ".png"];
    for (const u of no) assert.equal(SC.photoSource(u), null, "refused: " + u);
    assert.ok(SC.photoSources().some((s) => s.host === "img.patv-cdn.test") && !SC.photoSources().some((s) => s.host === "10.0.0.1"), "COVER_PHOTO_HOSTS: host names only");
    put("S3_BUCKET_NAME", undefined); put("COVER_PHOTO_HOSTS", undefined);
    assert.equal(SC.photoSource("https://pics.patv-test.example/avatars/u1.jpeg"), null, "no bucket configured: none of its hosts");
    assert.deepEqual(SC.photoSources().map((s) => s.host), ["cdn.discordapp.com", "static-cdn.jtvnw.net"]);
  } finally { put("S3_BUCKET_NAME", env.b); put("AWS_REGION", env.r); put("COVER_PHOTO_HOSTS", env.x); }
  for (const a of ["10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
                   "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:a00:1::1", "2001:db8::1", "ff02::1", "x", ""]) {
    assert.equal(SC.publicAddr(a), false, a);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111", "2001:4860:4860::8888"]) assert.equal(SC.publicAddr(a), true, a);
});

test("fix 3: the photo fetch - re-encoded webp (no metadata), cached by the URL's hash; refused (the letter, cached briefly): a non-public address (any of the host's), a redirect, a non-image type, markup bytes, more than 2 MB, a timeout; it connects to the vetted address with the host's name for TLS", async () => {
  const red = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 240, g: 20, b: 20 } } }).jpeg()
    .withMetadata({ exif: { IFD0: { Copyright: "photo-owner-secret" } } }).toBuffer();
  // (a REAL picture over the cap - noise, stored: only the size cap refuses it)
  const big = await sharp(require("crypto").randomBytes(1000 * 1000 * 3), { raw: { width: 1000, height: 1000, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  assert.ok(big.length > SC.PHOTO_MAX_BYTES && big.length < 4 * SC.PHOTO_MAX_BYTES, "fixture: " + big.length);
  const img = (type, body) => (q, s) => { s.setHeader("content-type", type); s.end(body); };
  const host = await photoHost({
    [P + "ok.png"]: img("image/jpeg", red),
    [P + "s3.jpeg"]: img("binary/octet-stream", red),
    // (a redirect that even carries a picture: only "no redirects" refuses it)
    [P + "moved.png"]: (q, s) => { s.statusCode = 302; s.setHeader("location", "http://127.0.0.1" + P + "ok.png"); s.setHeader("content-type", "image/jpeg"); s.end(red); },
    [P + "page.png"]: img("text/html", "<html>hi</html>"),
    [P + "typed.png"]: img("text/html", red),                        // (a real picture sent as a page: the type alone refuses it)
    [P + "vector.png"]: img("image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"/>'),
    [P + "lies.png"]: img("image/png", "<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"),
    [P + "big.png"]: img("image/png", big),
    // (chunked: no length up front - the running count refuses it)
    [P + "stream.png"]: (q, s) => { s.setHeader("content-type", "image/png"); s.write(big.subarray(0, 1024 * 1024)); s.end(big.subarray(1024 * 1024)); },
    [P + "slow.png"]: () => { /* never answers */ },
  });
  const seen = [];
  try {
    SC._setPhotoNet(stubNet(host, { seen }));
    const a = await SC.photoImage(discordAt("ok.png"));
    assert.equal(a && a.k, "photo");
    const meta = await sharp(a.buf).metadata();
    assert.equal(meta.format, "webp"); assert.ok(meta.width <= SC.COVER_PX);
    assert.ok(!a.buf.includes(Buffer.from("photo-owner-secret")), "re-encoded: no metadata");
    const req = seen.find((x) => x.opts).opts;
    assert.deepEqual([req.protocol, req.hostname, req.servername, req.port, req.path, req.method], ["https:", "cdn.discordapp.com", "cdn.discordapp.com", 443, P + "ok.png", "GET"]);
    assert.equal(req.headers.Host, "cdn.discordapp.com");
    // the connection's own lookup answers the address vetted above (never a second, rebinding lookup) - either form Node asks for
    await new Promise((ok) => req.lookup("cdn.discordapp.com", { all: true }, (e, list) => { assert.deepEqual(list, [{ address: "93.184.216.34", family: 4 }]); ok(); }));
    await new Promise((ok) => req.lookup("cdn.discordapp.com", {}, (e, addr, fam) => { assert.deepEqual([addr, fam], ["93.184.216.34", 4]); ok(); }));
    const n = host.hits.length;
    assert.ok((await SC.photoImage(discordAt("ok.png"))).buf.equals(a.buf)); assert.equal(host.hits.length, n, "cached: no second fetch");
    assert.equal((await SC.photoImage(discordAt("s3.jpeg"))).k, "photo", "the bucket's uploads carry no image type: sniffed instead");
    for (const f of ["moved.png", "page.png", "typed.png", "vector.png", "lies.png", "big.png", "stream.png"]) assert.ok((await SC.photoImage(discordAt(f))) === null, f);
    assert.equal(host.hits.filter((h) => h === P + "ok.png").length, 1, "the redirect was never followed");
    const h2 = host.hits.length;
    assert.ok((await SC.photoImage(discordAt("page.png"))) === null); assert.equal(host.hits.length, h2, "a failure is cached too (no refetch)");
    const t0 = Date.now();
    assert.ok((await SC.photoImage(discordAt("slow.png"))) === null);
    assert.ok(Date.now() - t0 < SC.PHOTO_TIMEOUT_MS + 1500, "timed out, never hangs: " + (Date.now() - t0) + " ms");
    // non-public addresses: ANY of the host's = refused, never asked
    for (const addrs of [[{ address: "10.0.0.5", family: 4 }], [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
                         [{ address: "::ffff:169.254.169.254", family: 6 }], [{ address: "fd00::1", family: 6 }], []]) {
      const s2 = [];
      SC._setPhotoNet(stubNet(host, { addrs: () => addrs, seen: s2 }));
      assert.ok((await SC.photoImage(discordAt("ok.png"))) === null, JSON.stringify(addrs));
      assert.ok(s2.some((x) => x.lookup) && !s2.some((x) => x.opts), "resolved, never requested: " + JSON.stringify(addrs));
    }
    // a host that isn't on the list is never even resolved
    const s3 = [];
    SC._setPhotoNet(stubNet(host, { seen: s3 }));
    assert.ok((await SC.photoImage("https://cdn.example.test/ann.png")) === null); assert.equal(s3.length, 0);
  } finally { SC._setPhotoNet(null); await host.close(); }
});

test("fix 3: the live proxy - /media/cover/p/<key>.webp names no user / Discord id, serves the cached picture with a short public cache (ETag); only keys a program handed out; a failed fetch is a 404", async () => {
  const red = await png(120, 120, { r: 200, g: 10, b: 10 });
  const host = await photoHost({ [P + "ok.png"]: (q, s) => { s.setHeader("content-type", "image/png"); s.end(red); } });
  try {
    SC._setPhotoNet(stubNet(host));
    const url = SC.photoProxyUrl(discordAt("ok.png"));
    assert.match(url, /^\/media\/cover\/p\/[a-f0-9]{32}\.webp$/);
    assert.ok(!url.includes("123456789012345678") && !url.includes("avatars"), url);
    assert.equal(SC.photoProxyUrl(discordAt("ok.png")), url, "stable per photo");
    assert.equal(SC.photoProxyUrl("https://cdn.example.test/ann.png"), null, "not on the list: no proxy");
    const f = await fetch(base + url);
    assert.equal(f.status, 200); assert.equal(f.headers.get("content-type"), "image/webp");
    assert.equal(f.headers.get("cache-control"), "public, max-age=" + SC.UPLOAD_MAX_AGE);
    assert.equal(f.headers.get("cdn-cache-control"), "max-age=" + SC.UPLOAD_CDN_MAX_AGE);
    assert.equal(f.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await sharp(Buffer.from(await f.arrayBuffer())).metadata()).format, "webp");
    const etag = f.headers.get("etag");
    assert.ok(etag);
    const re = await new Promise((ok, no) => http.get(base + url, { headers: { "if-none-match": etag } }, (res) => { res.resume(); ok(res.statusCode); }).on("error", no));
    assert.equal(re, 304);
    assert.equal((await fetch(base + "/media/cover/p/" + "0".repeat(32) + ".webp")).status, 404, "a key nobody handed out");
    assert.equal((await fetch(base + "/media/cover/p/" + url.slice(15, 47).toUpperCase() + ".webp")).status, 404);
    const g = await fetch(base + SC.photoProxyUrl(discordAt("gone.png")));
    assert.equal(g.status, 404, "the host has no such photo"); assert.equal(g.headers.get("cache-control"), "no-store");
  } finally { SC._setPhotoNet(null); await host.close(); }
});

test("fix 3: a snap / clip draws the profile photo the viewer's stage shows (its own URL or the proxy), round like the page; a host off the list, a failed fetch, a reported / blocked tile = the letter; a veiled tile never asks", async () => {
  const M = require(path.join(repo, "stagemiccap")), T = M._test;
  const R = { id: "pad", slug: "pad", title: "Pad" }, user = { userId: "viewer" };
  const red = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 230, g: 10, b: 10 } } }).png().toBuffer();
  const host = await photoHost({ [P + "ok.png"]: (q, s) => { s.setHeader("content-type", "image/png"); s.end(red); } });
  M.configure({ hidden: () => false, privateLogins: async () => new Set(), camRefusal: async () => null, exact: () => false, still: () => null });   // (cover: the real one)
  try {
    SC._setPhotoNet(stubNet(host));
    const e = { kind: "cam", id: "ann", name: "Ann", video: "card", watch: "ok", pos: 0, avatar: discordAt("ok.png"), ck: "photo" };
    const t = await T.tileFor(e, R, user);
    assert.equal(t.mode, "card"); assert.equal(t.cover && t.cover.k, "photo");
    const viaProxy = await T.tileFor({ ...e, avatar: SC.photoProxyUrl(discordAt("ok.png")) }, R, user);
    assert.ok(viaProxy.cover && viaProxy.cover.buf.equals(t.cover.buf), "the proxy and the URL: the same bytes");
    const buf = await M.renderFrame({ layout: "single", src: [e] }, [t], R);
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
    const isRed = (c) => c[0] > 200 && c[1] < 40 && c[2] < 40;
    assert.ok(isRed(at(640, 330)), "the photo in the middle: " + at(640, 330));
    assert.ok(isRed(at(640, 205)), "the circle's top is the photo: " + at(640, 205));
    // round, like the page (.cv-photo): the corners of its 260 px square (510..770 x 199..459) are the card, not the photo
    for (const [x, y] of [[514, 203], [766, 203], [514, 455], [766, 455]]) assert.ok(!isRed(at(x, y)), `cropped round: ${x},${y} ` + at(x, y));
    for (const [why, ent] of [["off the list", { ...e, avatar: "https://cdn.example.test/ann.png" }], ["a failed fetch", { ...e, avatar: discordAt("missing.png") }],
                              ["reported", { ...e, watch: "hidden" }], ["blocked", { ...e, watch: "blocked" }], ["unavailable", { ...e, watch: "unavailable" }]]) {
      assert.ok(!(await T.tileFor(ent, R, user)).cover, why);
    }
    const hits = host.hits.length;
    const veiled = await T.tileFor({ kind: "cover", id: "anon-ab12cd34", name: "Soggy Bullfrog", veil: "incognito", hood: 1, watch: "cover", avatar: discordAt("ok.png"), ck: "photo" }, R, user);
    assert.equal(veiled.mode, "cover"); assert.equal(veiled.cover, undefined, "a veiled tile: the hood only");
    assert.equal(host.hits.length, hits, "nothing fetched for it");
  } finally { M.configure(T.defaults); SC._setPhotoNet(null); await host.close(); }
});

test("fix 3: a HELD picture lives in COVER_DIR/held/ (never in the backed-up folder) - served from there to its owner; put up = moved out; taken down = deleted from held/; the migration and the sweep handle both folders", async () => {
  const u = await mkUser("hela", { camfrog: "helacf" });
  await safety({ enabled: true });
  ANSWER = HATE;
  const r = await upload(u, await png(230, 230, { r: 70, g: 20, b: 120 }));
  assert.equal(r.d && r.d.held, true, JSON.stringify(r.d));
  const name = r.d.upload.url.split("/").pop();
  const heldP = path.join(SC.dir(), "held", name.slice(0, 2), name), upP = path.join(SC.dir(), name.slice(0, 2), name);
  assert.ok(fs.existsSync(heldP), "held: in held/"); assert.ok(!fs.existsSync(upP), "never in the normal (backed-up) folder");
  assert.equal((await fetch(base + r.d.upload.url, { headers: { "x-test-user": u.userId } })).status, 200, "its owner sees it (from held/)");
  assert.equal((await fetch(base + r.d.upload.url)).status, 404);
  await ISF.review(await logOf(u), "fp", "boss");                  // put up
  assert.ok(fs.existsSync(upP) && !fs.existsSync(heldP), "put up: moved out of held/");
  assert.equal((await fetch(base + r.d.upload.url)).status, 200);
  assert.equal((await SC.coverOf("helacf")).k, "upload");
  // the next one is flagged: in held/; the replaced one is gone; taken down ("false negative") = deleted from held/
  const r2 = await upload(u, await png(231, 230, { r: 71, g: 20, b: 120 }));
  const n2 = r2.d.upload.url.split("/").pop(), held2 = path.join(SC.dir(), "held", n2.slice(0, 2), n2);
  assert.ok(fs.existsSync(held2) && !fs.existsSync(path.join(SC.dir(), n2.slice(0, 2), n2)));
  assert.ok(!fs.existsSync(upP), "the replaced picture is gone");
  await ISF.review(await logOf(u), "fn", "boss");
  assert.ok(!fs.existsSync(held2), "taken down: deleted from held/");
  // the one-time migration: a held picture stored in the normal folder (before held/ existed) moves into held/; an "ok" one whose move
  // out of held/ was cut short moves out (and is served meanwhile)
  const w1 = await mkUser("mig1"), w2 = await mkUser("mig2");
  const nA = "ab" + "1".repeat(30) + ".webp", nB = "cd" + "2".repeat(30) + ".webp";
  const webp = await sharp(await png(40, 40)).webp().toBuffer();
  fs.mkdirSync(path.join(SC.dir(), "ab"), { recursive: true }); fs.writeFileSync(path.join(SC.dir(), "ab", nA), webp);
  fs.mkdirSync(path.join(SC.dir(), "held", "cd"), { recursive: true }); fs.writeFileSync(path.join(SC.dir(), "held", "cd", nB), webp);
  await runQuery("INSERT INTO stage_covers (user_id, kind, upload, upload_state, updated) VALUES (?, 'upload', ?, 'held', 1), (?, 'upload', ?, 'ok', 1)", [w1.userId, nA, w2.userId, nB]);
  assert.equal((await fetch(base + "/media/cover/u/" + nB)).status, 200, "an 'ok' picture still in held/ is served all the same");
  assert.ok((await SC.placeFiles()) >= 2);
  assert.ok(fs.existsSync(path.join(SC.dir(), "held", "ab", nA)) && !fs.existsSync(path.join(SC.dir(), "ab", nA)), "held -> held/");
  assert.ok(fs.existsSync(path.join(SC.dir(), "cd", nB)) && !fs.existsSync(path.join(SC.dir(), "held", "cd", nB)), "ok -> the normal folder");
  assert.equal(await SC.placeFiles(), 0, "idempotent");
  assert.equal((await fetch(base + "/media/cover/u/" + nA, { headers: { "x-test-user": w1.userId } })).status, 200);
  // the sweep: files no row holds go from BOTH folders after an hour (a deleted account's held picture too); the ones in use stay
  await runQuery("DELETE FROM stage_covers WHERE user_id = ?", [w1.userId]);          // (account deletion: accountdelete.DELETE_ROWS)
  const orphanUp = path.join(SC.dir(), "ef", "ef" + "3".repeat(30) + ".webp");
  fs.mkdirSync(path.dirname(orphanUp), { recursive: true }); fs.writeFileSync(orphanUp, webp);
  const stale = path.join(SC.dir(), "held", "tmp-" + "0".repeat(16) + ".heic");
  fs.writeFileSync(stale, "x");
  assert.equal(await SC.sweepFiles(Date.now()), 0, "nothing under an hour old");
  assert.ok((await SC.sweepFiles(Date.now() + 2 * 3600e3)) >= 3);
  assert.ok(!fs.existsSync(path.join(SC.dir(), "held", "ab", nA)), "a deleted account's held picture: swept from held/");
  assert.ok(!fs.existsSync(orphanUp), "an orphan in the normal folder"); assert.ok(!fs.existsSync(stale), "a HEIC decode's leftover in held/");
  assert.ok(fs.existsSync(path.join(SC.dir(), "cd", nB)), "a picture in use stays");
  assert.ok(fs.readFileSync(path.join(repo, "stagecover.js"), "utf8").includes("tmpDir: heldDir()"), "a HEIC's raw bytes are decoded in held/ (not backed up)");
});

test("fix 3 (the block race): a picture blocked WHILE its upload is being classified is refused at the store - never stored after the block (checked again right before it, inside the row's transaction)", async () => {
  const a = await mkUser("ria"), b = await mkUser("rob", { camfrog: "robcf" });
  await safety({ enabled: true });
  ANSWER = CLEAN;
  const pic = await png(240, 241, { r: 12, g: 140, b: 160 });
  const ra = await upload(a, pic);
  assert.equal(ra.d && ra.d.held, false, JSON.stringify(ra.d));
  const before = allFiles();
  // b uploads the same picture; while it is being classified an admin takes a's copy down (the picture's hash is blocked)
  let took = false;
  ANSWER = async () => { if (!took) { took = true; assert.equal(await SC.removeUpload(a.userId, "admin boss"), true); } return CLEAN; };
  try {
    const rb = await upload(b, pic);
    assert.equal(took, true, "the block landed during the classification");
    assert.equal(rb.status, 422, JSON.stringify(rb.d)); assert.equal(rb.d.code, "blocked");
    const row = (await getQuery("SELECT upload FROM stage_covers WHERE user_id = ?", [b.userId]))[0];
    assert.ok(!row || !row.upload, "nothing stored for b");
    const after = allFiles();
    assert.deepEqual([...after].filter((f) => !before.has(f)), [], "no file left behind");
    assert.equal(after.size, before.size - 1, "a's copy is down");
    const c = await SC.coverOf("robcf");
    assert.ok(!c || c.k !== "upload");
  } finally { ANSWER = CLEAN; }
});

// ── review fixes 3 (1.99??): the IPv6 gaps, the block race inside the row's transaction, the hold race, legacy rows' hashes ──
/** Stall setUpload's own row transaction (the window after its check before the store and the file write - e.g. a transaction
 *  queued behind others) and run `during` in it. -> {restore(), fired()} */
function stallStore(during) {
  const realTx = DB.tx;
  let fired = false;
  DB.tx = function (fn) {
    if (!fired && /\bsetUpload\b/.test(String(new Error().stack))) {
      fired = true;
      return Promise.resolve().then(during).then(() => realTx(fn));
    }
    return realTx(fn);
  };
  return { restore: () => { DB.tx = realTx; }, fired: () => fired };
}

test("review fix 3 (SEC-1): an IPv6 photo address must be global unicast - IPv4-compatible (::/96), SIIT (::ffff:0:a.b.c.d), 3fff::/20, 5f00::/16 and anything outside 2000::/3 are refused", () => {
  for (const a of ["::7f00:1", "::127.0.0.1", "::a00:1", "::a9fe:a9fe", "::2", "::ffff:0:7f00:1", "::ffff:0:a9fe:a9fe", "3fff::1", "3fff:fff::1",
                   "5f00::1", "4000::1", "e000::1", "1::1"]) assert.equal(SC.publicAddr(a), false, a);
  for (const a of ["2606:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001::1", "2c0f:fb50:4002::1", "3ffe:1::1", "8.8.8.8"]) assert.equal(SC.publicAddr(a), true, a);
});

test("review fix 3 (SEC-2): a block that lands while an upload WAITS FOR ITS ROW'S TRANSACTION (after the check before the store and the file write) is refused inside that transaction - nothing stored, no file left in either folder", async () => {
  const a = await mkUser("tia"), b = await mkUser("tob", { camfrog: "tobcf" });
  await safety({ enabled: true });
  ANSWER = CLEAN;
  const pic = await png(242, 243, { r: 14, g: 150, b: 90 });
  const ra = await upload(a, pic);
  assert.equal(ra.d && ra.d.held, false, JSON.stringify(ra.d));
  const before = allFiles();
  // b uploads the same picture; it passes every check before the store, then an admin takes a's copy down (the hash is blocked)
  const st = stallStore(async () => { assert.equal(await SC.removeUpload(a.userId, "admin boss"), true); });
  let rb;
  try { rb = await upload(b, pic); } finally { st.restore(); }
  assert.equal(st.fired(), true, "the block landed while b's row waited for its transaction");
  assert.equal(rb.status, 422, JSON.stringify(rb.d)); assert.equal(rb.d.code, "blocked");
  const row = (await getQuery("SELECT upload FROM stage_covers WHERE user_id = ?", [b.userId]))[0];
  assert.ok(!row || !row.upload, "nothing stored for b");
  const after = allFiles();
  assert.deepEqual([...after].filter((f) => !before.has(f)), [], "no file left behind (held/ or the normal folder)");
  assert.equal(after.size, before.size - 1, "a's copy is down");
  const c = await SC.coverOf("tobcf");
  assert.ok(!c || c.k !== "upload");
});

test("review fix 3 (SEC-3, the hold race): a take-down (strike + hold) that lands while the account's NEXT picture waits for its row's transaction holds that picture - in held/ only, not public; with no race a picture that is up ends in the normal folder", async () => {
  const c = await mkUser("cato", { camfrog: "catocf" });
  await safety({ enabled: true });
  ANSWER = CLEAN;
  const r1 = await upload(c, await png(250, 251, { r: 200, g: 200, b: 10 }));
  assert.equal(r1.d && r1.d.held, false, JSON.stringify(r1.d));
  const n1 = r1.d.upload.url.split("/").pop();
  assert.ok(fs.existsSync(path.join(SC.dir(), n1.slice(0, 2), n1)), "up: in the normal (backed-up) folder");
  assert.ok(!fs.existsSync(path.join(SC.dir(), "held", n1.slice(0, 2), n1)), "and no longer in held/ (moved after its row committed)");
  const st = stallStore(async () => { assert.equal(await SC.removeUpload(c.userId, "admin boss"), true); });
  let r2;
  try { r2 = await upload(c, await png(252, 253, { r: 10, g: 200, b: 200 })); } finally { st.restore(); }
  assert.equal(st.fired(), true, "the take-down landed while the next picture waited for its transaction");
  assert.equal(r2.status, 200, JSON.stringify(r2.d));
  assert.equal(r2.d.held, true, "HELD: the account went on hold before the row was stored");
  const row = (await getQuery("SELECT upload, upload_state, hold_until, strikes FROM stage_covers WHERE user_id = ?", [c.userId]))[0];
  assert.equal(row.upload_state, "held"); assert.ok(Number(row.hold_until) > Date.now()); assert.equal(Number(row.strikes), 1);
  assert.ok(fs.existsSync(path.join(SC.dir(), "held", row.upload.slice(0, 2), row.upload)), "in held/");
  assert.ok(!fs.existsSync(path.join(SC.dir(), row.upload.slice(0, 2), row.upload)), "never in the backed-up folder");
  assert.equal((await fetch(base + "/media/cover/u/" + row.upload)).status, 404, "not public");
  SC.invalidate();
  const cv = await SC.coverOf("catocf");
  assert.ok(!cv || cv.k !== "upload");
});

test("review fix 3 (SEC-4): a row from before review fix 1 (no upload_hash) whose HELD picture sits in held/ - an admin's take-down still blocks the picture; placeFiles gives such rows their picture's hash", async () => {
  const sha = (b) => require("crypto").createHash("sha256").update(b).digest("hex");
  const legacy = async (name, state, inHeld, c) => {
    const u = await mkUser(name);
    const buf = await sharp(await png(44, 45, c)).webp().toBuffer();
    const file = require("crypto").randomBytes(16).toString("hex") + ".webp";
    const p = path.join(SC.dir(), inHeld ? "held" : "", file.slice(0, 2), file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    await runQuery("INSERT INTO stage_covers (user_id, kind, upload, upload_state, updated) VALUES (?, 'upload', ?, ?, 1)", [u.userId, file, state]);
    return { u, file, p, hash: sha(buf) };
  };
  const blocked = async (h) => (await getQuery("SELECT 1 AS x FROM stage_cover_blocks WHERE hash = ?", [h])).length > 0;
  // a held picture already in held/ (the migration ran), its row without a hash: taken down by an admin
  const h1 = await legacy("legheld", "held", true, { r: 3, g: 77, b: 5 });
  assert.equal(await SC.removeUpload(h1.u.userId, "admin boss"), true);
  assert.equal(await blocked(h1.hash), true, "the picture in held/ is blocked");
  assert.ok(!fs.existsSync(h1.p), "and deleted from held/");
  // placeFiles: a legacy "ok" row (normal folder) and a legacy held one in the normal folder (moved to held/) get their hashes
  const h2 = await legacy("legok", "ok", false, { r: 4, g: 78, b: 6 }), h3 = await legacy("legmove", "held", false, { r: 5, g: 79, b: 7 });
  await SC.placeFiles();
  const hashOf = async (u) => (await getQuery("SELECT upload_hash FROM stage_covers WHERE user_id = ?", [u.userId]))[0].upload_hash;
  assert.equal(await hashOf(h2.u), h2.hash);
  assert.equal(await hashOf(h3.u), h3.hash);
  assert.ok(fs.existsSync(path.join(SC.dir(), "held", h3.file.slice(0, 2), h3.file)), "the held one moved into held/");
});

