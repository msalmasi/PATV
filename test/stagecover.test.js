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
//   * the stage page (stage-mic.js): the picture on the card with the reason kept, set only when the URL changes, never on a cover /
//     a reported tile, the letter after a failed load; stage-room.js repaints on a new picture
//   * the capture (stagemiccap.js): a name card draws the cover picture; never the network
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
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
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

test("an upload while enforcing: re-encoded webp (no metadata, a random name), served public + immutable, picked as the cover; a refused one is never stored; a fail-open pass is refused", async () => {
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
  assert.match(f.headers.get("cache-control"), /public, max-age=31536000, immutable/);
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
  assert.equal(rm.d.ok, true); assert.equal(rm.d.upload, null); assert.equal(rm.d.kind, "gtf");
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
  // a held one marked "correct" (the flag was right) comes down too
  const r2 = await upload(U.cy, await png(250, 250, { r: 50, g: 50, b: 200 }));
  const log2 = (await getQuery("SELECT upload_log FROM stage_covers WHERE user_id = ?", [U.cy.userId]))[0].upload_log;
  await ISF.review(log2, "ok", "boss");
  assert.equal((await fetch(base + r2.d.upload.url, { headers: { "x-test-user": U.cy.userId } })).status, 404);
  // the admin card's take-down: admins only (not staff, not members)
  ANSWER = CLEAN;
  const r3 = await upload(U.cy, await png(260, 250, { r: 90, g: 50, b: 20 }));
  assert.equal(r3.d.held, false);
  assert.ok((await SC.adminList()).some((c) => c.userId === U.cy.userId && c.state === "ok" && c.inUse));
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

test("stage-room.js repaints the mic stage when only a tile's cover picture changes; the CSS keeps the picture on small cells", () => {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  const sig = src.slice(src.indexOf("function sigOf(p)"), src.indexOf("function setMic(p)"));
  const fn = new Function(sig + "; return sigOf;")();
  const a = { v: 1, src: [{ id: "ann", avatar: "/media/cover/a/1.x.svg", ck: "gtf" }] }, b = JSON.parse(JSON.stringify(a));
  assert.equal(fn(a), fn(b));
  b.src[0].avatar = "/media/cover/u/" + "a".repeat(32) + ".webp"; b.src[0].ck = "upload";
  assert.notEqual(fn(a), fn(b), "a new picture repaints");
  const css = fs.readFileSync(path.join(repo, "public", "css", "webrtc.css"), "utf8");
  assert.match(css, /\.mf-card\.cov \.mf-av \{ display: block !important; width: 100% !important; height: 100% !important;/, "shown on narrow grids too (the letter rules hide .mf-av), sized by its grid row");
  assert.match(css, /\.mf-card\.cov \{ display: grid; grid-template-rows: minmax\(0, 1fr\) auto;/, "the picture row is definite: it never overflows the cell");
  assert.match(css, /\.mf-card\.cv-gtf \.mf-av img, [^{]*\.mf-card\.cv-sticker \.mf-av img \{ image-rendering: pixelated;/);
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /stage-mic\.js\?v=10/); assert.match(room, /webrtc\.css\?v=8/);   // (stage-mic.js v10: 1.99ahn's v8 + 1.99ahp's v9 + the cover)
});

// ── the capture ──
test("stagemiccap: a consenting name card draws its cover picture (local data only, never the network); without one the letter circle", async () => {
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
    assert.equal(net.cover, null, "an outside photo: the letter (no fetch)");
    assert.deepEqual(asked, [e.avatar], "deps.cover is asked only for local cover paths");
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
