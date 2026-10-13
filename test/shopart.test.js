// Offline tests for 1.99xr: the shop's "🎨 Generate image" button (shopart.js). The image model is replaced by a stub that
// answers an existing prize sprite drawn big and blurry on magenta (what the real model is asked for), so this checks the
// whole path without a key or the network:
//   * switches + caps: defaults (staff ON, members ON), no key = unavailable + hidden, members off, the shop's level, per-hour /
//     per-day / site caps (every try counts), one at a time
//   * guards: the text filter (adult words), the model's safety block, the image-safety check (surface "shop") - all refused,
//     logged, nothing kept
//   * the picture: rebuilt in the house format (48 x 36 viewBox, crispEdges, shelf spotlight, #0a0a0a outline, <= 14 sprite colours)
//   * previews are private to their maker (and staff); "Use this picture" makes it public and the shop accepts the path
//   * routes: CSRF header, /admin/shopart (staff see, Admins change, audited), the classic editor's new image field, the forms
//     carry the (hidden) widget
//   NODE_PATH=G:/PATV/node_modules node --test test/shopart.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shopart-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.GEMINI_API_KEY;
process.env.SECRET_KEY = "test-secret";

const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const SA = require(path.join(repo, "shopart"));
const ISF = require(path.join(repo, "imagesafety"));

let server, base;
let calls = 0, providerMode = "ok";
async function fakeModel({ prompt, refs, model }) {
  calls++;
  assert.ok(refs.length >= 3, "style references are sent");
  assert.match(prompt, /no brand names, logos or trademarks/);
  assert.match(prompt, /real or identifiable person/);
  if (providerMode === "blocked") throw new SA.GenError("The picture model refused that item (its safety filter).", "blocked");
  if (providerMode === "boom") throw new Error("HTTP 500: upstream");
  let svg = fs.readFileSync(path.join(repo, "public/img/shop/watch.svg"), "utf8");
  svg = svg.replace(/<g fill-opacity="[^"]*">[\s\S]*?<\/g>/g, "").replace('fill="url(#s)"', 'fill="#ff00ff"');
  const buf = await sharp(Buffer.from(svg), { density: 1200 }).resize(1024, 768, { kernel: "lanczos3" }).jpeg({ quality: 75 }).toBuffer();
  return { buf, model };
}
let safetyMode = "ok";
async function fakeSafety(input) {
  assert.equal(input.surface, "shop");
  assert.ok(Buffer.isBuffer(input.buf));
  return safetyMode === "refuse" ? { ok: false, reason: "That picture looks like adult or graphic content - Shop pictures must be safe for work (Terms).", logId: 7 }
    : { ok: true, nsfw: false, logId: 5 };
}

const call = async (method, url, as, body, { xrw = true, form = false } = {}) => {
  const headers = { "x-test-user": as || "" };
  if (xrw) headers["X-Requested-With"] = "fetch";
  let payload;
  if (body) {
    headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    payload = form ? new URLSearchParams(body).toString() : JSON.stringify(body);
  }
  const r = await fetch(base + url, { method, headers, body: payload, redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), location: r.headers.get("location") };
};
const gens = () => getQuery("SELECT * FROM shopart_gens ORDER BY id");

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, created_at TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await shop.ready;
  for (const [id, name, cls, lvl] of [["sa-admin", "boss", "Admin", 50], ["sa-staff", "staffer", "Staff", 1], ["sa-pleb", "pleb", "pleb", 10],
                                      ["sa-other", "other", "pleb", 10], ["sa-low", "newbie", "pleb", 1]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, level, class) VALUES (?, ?, 'x', 0, ?, ?)", [id, name, lvl, cls]);
  }
  SA._setDir(path.join(tmp, "art"));
  ISF._setDir(path.join(tmp, "isf"));
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { req.flash = () => []; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  shop.register(app, { isBotToken: () => false, addUser, requireUser: (req, res, next) => (req.user ? next() : res.status(401).end()) });
  SA.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

test("defaults: staff ON, members ON; no key = unavailable (the button stays hidden) and generate answers 503", async () => {
  const C = await SA.config();
  assert.equal(C.staff_on, true);
  assert.equal(C.users_on, true);
  assert.deepEqual([C.user_per_hour, C.user_per_day, C.staff_per_hour, C.staff_per_day, C.global_per_day], [3, 10, 30, 200, 500]);
  assert.equal(C.model, "gemini-3.1-flash-image");
  const st = await call("GET", "/api/shopart/status", "sa-pleb");
  assert.equal(st.status, 200);
  assert.equal(st.d.available, false);
  assert.equal(st.d.reason, "nokey");
  const g = await call("POST", "/api/shopart/generate", "sa-admin", { title: "Mystery box" });
  assert.equal(g.status, 503);
  assert.equal(calls, 0);
  // signed out
  assert.equal((await call("GET", "/api/shopart/status", null)).status, 401);
});

test("cleanConfig clamps the caps and only takes known models", () => {
  const c = SA.cleanConfig({ user_per_hour: -4, user_per_day: 99999, model: "dall-e", users_on: "0", staff_on: "on" });
  assert.equal(c.user_per_hour, 0);
  assert.equal(c.user_per_day, 1000);
  assert.equal(c.model, SA.DEFAULTS.model);
  assert.equal(c.users_on, false);
  assert.equal(c.staff_on, true);
});

test("generate -> a private preview in the house format; accept -> public; the shop takes the path", async () => {
  process.env.GEMINI_API_KEY = "test-not-a-key";
  SA.setProvider(fakeModel);
  const sec = require(path.join(repo, "shopart"));
  assert.equal(sec, SA);
  // CSRF: no X-Requested-With
  assert.equal((await call("POST", "/api/shopart/generate", "sa-pleb", { title: "Gold watch" }, { xrw: false })).status, 403);
  // stub the image-safety check for this test
  const realCheck = ISF.check;
  ISF.check = fakeSafety;
  try {
    const st = await call("GET", "/api/shopart/status", "sa-pleb");
    assert.equal(st.d.available, true);
    assert.deepEqual(st.d.left, { hour: 3, day: 10 });
    const g = await call("POST", "/api/shopart/generate", "sa-pleb", { title: "Gold watch", description: "A shiny wristwatch", category: "Collectibles", extra: "leather strap" });
    assert.equal(g.status, 200, g.text);
    assert.equal(g.d.shelf, "goods", "the spotlight follows the category");
    assert.deepEqual(g.d.left, { hour: 2, day: 9 });
    assert.match(g.d.url, /^\/media\/shopart\/[0-9a-f]{32}\.svg$/);
    const row = (await gens()).pop();
    assert.equal(row.status, "preview");
    assert.equal(row.safety_log, 5);
    assert.equal(row.user_id, "sa-pleb");
    // the picture: the house format
    const svg = fs.readFileSync(SA.filePath(path.basename(g.d.url)), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 48 36" shape-rendering="crispEdges">/);
    assert.match(svg, /<title>Gold watch<\/title>/);
    assert.match(svg, /stop-color="#16706a"/, "the goods shelf spotlight");
    assert.match(svg, /fill="#0a0a0a"/, "the outline");
    assert.doesNotMatch(svg, /<script|href=|on\w+=/i);
    const sprite = svg.split("\n").filter((l) => /^<rect x=/.test(l));
    const colours = new Set(sprite.map((l) => l.match(/fill="([^"]+)"/)[1]));
    assert.ok(colours.size <= 15, "<= 14 colours + the outline");
    assert.ok(sprite.length > 40, "a real sprite");
    // the watch's gold made it through
    assert.ok([...colours].some((c) => { const n = parseInt(c.slice(1), 16); return (n >> 16) > 200 && ((n >> 8) & 255) > 150 && (n & 255) < 120; }), "gold survives");
    // private preview
    assert.equal((await call("GET", g.d.url, null)).status, 404);
    assert.equal((await call("GET", g.d.url, "sa-other")).status, 404);
    const mine = await call("GET", g.d.url, "sa-pleb");
    assert.equal(mine.status, 200);
    assert.match(mine.type, /image\/svg\+xml/);
    assert.match(mine.cache, /no-store/);
    assert.equal((await call("GET", g.d.url, "sa-staff")).status, 200, "staff can see previews");
    // someone else can't accept it
    assert.equal((await call("POST", "/api/shopart/accept", "sa-other", { id: g.d.id })).status, 404);
    const a = await call("POST", "/api/shopart/accept", "sa-pleb", { id: g.d.id });
    assert.equal(a.status, 200);
    assert.equal(a.d.url, g.d.url);
    const pub = await call("GET", g.d.url, null);
    assert.equal(pub.status, 200);
    assert.match(pub.cache, /immutable/);
    // the shop accepts the path as an item picture, and a listing keeps it
    assert.equal(shop.validateListing({ title: "Gold watch", category: "Collectibles", price: 5, stock: 1, image_url: g.d.url }).image_url, g.d.url);
    assert.throws(() => shop.validateListing({ title: "Gold watch", category: "Collectibles", price: 5, stock: 1, image_url: "/media/shopart/../x.svg" }));
    const L = await shop.createListing({ userId: "sa-pleb", username: "pleb", class: "pleb" }, { title: "Gold watch", category: "Collectibles", price: 5, stock: 1, image_url: g.d.url });
    assert.equal((await getQuery("SELECT image_url FROM prizes WHERE prizeId = ?", [L.id]))[0].image_url, g.d.url);
  } finally { ISF.check = realCheck; }
});

test("guards: adult words, the model's block and the image-safety check refuse - logged, nothing kept, counted", async () => {
  const realCheck = ISF.check;
  ISF.check = fakeSafety;
  try {
    const before = calls;
    const t1 = await call("POST", "/api/shopart/generate", "sa-staff", { title: "Naked lady statue" });
    assert.equal(t1.status, 400);
    assert.match(t1.d.error, /family-friendly/);
    assert.equal(calls, before, "the model is never called");
    providerMode = "blocked";
    const t2 = await call("POST", "/api/shopart/generate", "sa-staff", { title: "Some item" });
    assert.equal(t2.status, 400);
    assert.match(t2.d.error, /safety filter/);
    providerMode = "boom";
    const t3 = await call("POST", "/api/shopart/generate", "sa-staff", { title: "Some item" });
    assert.equal(t3.status, 502);
    assert.doesNotMatch(t3.d.error, /upstream|HTTP/, "provider errors aren't shown");
    providerMode = "ok";
    safetyMode = "refuse";
    const t4 = await call("POST", "/api/shopart/generate", "sa-staff", { title: "Some item" });
    assert.equal(t4.status, 400);
    assert.match(t4.d.error, /Shop pictures must be safe for work/);
    safetyMode = "ok";
    const rows = (await gens()).filter((r) => r.user_id === "sa-staff");
    assert.deepEqual(rows.map((r) => r.status), ["refused", "refused", "failed", "refused"]);
    assert.ok(rows.every((r) => !r.file), "nothing kept");
    assert.equal(rows[3].safety_log, 7);
    const st = await call("GET", "/api/shopart/status", "sa-staff");
    assert.deepEqual(st.d.left, { hour: 26, day: 196 }, "every try counts");
  } finally { ISF.check = realCheck; safetyMode = "ok"; providerMode = "ok"; }
});

test("caps: per hour, per day, the site's day; members off; the shop's level; one at a time", async () => {
  const realCheck = ISF.check;
  ISF.check = fakeSafety;
  try {
    await SA.setConfig({ user_per_hour: 2, user_per_day: 3 });
    // sa-pleb already made one this hour
    assert.equal((await call("POST", "/api/shopart/generate", "sa-pleb", { title: "Ring" })).status, 200);
    const third = await call("POST", "/api/shopart/generate", "sa-pleb", { title: "Ring" });
    assert.equal(third.status, 429);
    assert.match(third.d.error, /this hour/);
    // the day cap, an hour later
    SA._setClock(() => Date.now() + 3700e3);
    assert.equal((await call("POST", "/api/shopart/generate", "sa-pleb", { title: "Ring" })).status, 200);
    const day = await call("POST", "/api/shopart/generate", "sa-pleb", { title: "Ring" });
    assert.equal(day.status, 429);
    assert.match(day.d.error, /today/);
    SA._setClock(null);
    // the site's day
    await SA.setConfig({ global_per_day: 1 });
    const g = await call("POST", "/api/shopart/generate", "sa-other", { title: "Ring" });
    assert.equal(g.status, 429);
    assert.match(g.d.error, /The site/);
    await SA.setConfig({ global_per_day: 500 });
    // the shop's level to sell (5 by default); staff are exempt
    const low = await call("GET", "/api/shopart/status", "sa-low");
    assert.equal(low.d.available, false);
    assert.equal(low.d.reason, "level");
    assert.equal((await call("GET", "/api/shopart/status", "sa-staff")).d.available, true);
    // members switched off: hidden for them, staff still fine
    await SA.setConfig({ users_on: false });
    const off = await call("GET", "/api/shopart/status", "sa-other");
    assert.equal(off.d.reason, "off");
    assert.equal((await call("POST", "/api/shopart/generate", "sa-other", { title: "Ring" })).status, 403);
    assert.equal((await call("GET", "/api/shopart/status", "sa-admin")).d.available, true);
    await SA.setConfig({ users_on: true });
    // one at a time
    const [a, b] = await Promise.all([call("POST", "/api/shopart/generate", "sa-admin", { title: "Ring" }), call("POST", "/api/shopart/generate", "sa-admin", { title: "Ring" })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  } finally { ISF.check = realCheck; SA._setClock(null); }
});

test("previews nobody used are deleted after a day; accepted ones stay", async () => {
  const rows = await gens();
  const prev = rows.filter((r) => r.status === "preview");
  const acc = rows.filter((r) => r.status === "accepted");
  assert.ok(prev.length && acc.length);
  const n = await SA.sweep(Date.now() + 26 * 3600e3);   // (one was made on a clock an hour ahead)
  assert.equal(n, prev.length);
  for (const r of prev) assert.equal(fs.existsSync(SA.filePath(r.file)), false);
  for (const r of acc) assert.equal(fs.existsSync(SA.filePath(r.file)), true);
  assert.equal((await call("GET", "/media/shopart/" + prev[0].file, "sa-admin")).status, 404);
});

test("/admin/shopart: staff can look, Admins save (audited), members are sent away", async () => {
  const pg = await call("GET", "/admin/shopart", "sa-staff");
  assert.equal(pg.status, 200);
  assert.match(pg.text, /Shop pictures/);
  assert.match(pg.text, /Only Admins can change these/);
  assert.match(pg.text, /Gold watch/, "the log");
  assert.equal((await call("GET", "/admin/shopart", "sa-pleb")).status, 302);
  assert.equal((await call("POST", "/admin/shopart", "sa-staff", { users_on: "1" }, { form: true })).status, 403);
  const s = await call("POST", "/admin/shopart", "sa-admin", { staff_on: "1", user_per_hour: "4", user_per_day: "12", staff_per_hour: "30", staff_per_day: "200", global_per_day: "500", model: "gemini-2.5-flash-image" }, { form: true });
  assert.equal(s.status, 303);
  const C = await SA.config();
  assert.equal(C.users_on, false, "unticked = off");
  assert.equal(C.user_per_hour, 4);
  assert.equal(C.model, "gemini-2.5-flash-image");
  const audit = await getQuery("SELECT * FROM admin_audit WHERE action = 'shopart_config' ORDER BY id DESC LIMIT 1");
  assert.equal(audit[0].admin_id, "sa-admin");
  await SA.setConfig({ users_on: true, model: SA.DEFAULTS.model });
});

test("the forms carry the (hidden) widget; the classic editor saves an image", async () => {
  for (const [url, as] of [["/shop/admin", "sa-staff"], ["/admin/manage-prizes", "sa-staff"], ["/shop/seller", "sa-pleb"]]) {
    const pg = await call("GET", url, as);
    assert.equal(pg.status, 200, url);
    assert.match(pg.text, /data-shopart hidden/, url);
    assert.match(pg.text, /\/public\/js\/shopart\.js/, url);
    assert.match(pg.text, /Generate image/, url);
  }
  const accepted = (await gens()).find((r) => r.status === "accepted");
  const r = await fetch(base + "/api/prizes/edit", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "sa-staff" },
    body: JSON.stringify({ action: "add", prizeName: "Generated thing", cost: 10, quantity: 1, image_url: "/media/shopart/" + accepted.file }) });
  assert.equal(r.status, 200);
  const p = (await getQuery("SELECT prizeId, image_url FROM prizes WHERE prize = 'Generated thing'"))[0];
  assert.equal(p.image_url, "/media/shopart/" + accepted.file);
  const ed = await call("GET", "/shop/admin/edit/" + p.prizeId, "sa-staff");
  assert.match(ed.text, /data-shopart hidden/);
  const api = await (await fetch(base + "/api/prizes")).json();
  assert.equal(api.find((x) => x.prizeId === p.prizeId).image_url, "/media/shopart/" + accepted.file);
  // a bad picture is refused; leaving the field out keeps the picture
  const bad = await fetch(base + "/api/prizes/edit", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "sa-staff" },
    body: JSON.stringify({ action: "add", prizeId: p.prizeId, prizeName: "Generated thing", cost: 10, quantity: 1, image_url: "javascript:alert(1)" }) });
  assert.equal(bad.status, 400);
  await fetch(base + "/api/prizes/edit", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "sa-staff" },
    body: JSON.stringify({ action: "add", prizeId: p.prizeId, prizeName: "Generated thing 2", cost: 10, quantity: 1 }) });
  assert.equal((await getQuery("SELECT image_url FROM prizes WHERE prizeId = ?", [p.prizeId]))[0].image_url, "/media/shopart/" + accepted.file);
});

test("imagesafety knows the shop surface (strict profile policy)", () => {
  assert.ok(ISF.SURFACES.includes("shop"));
  const d = ISF.decide("shop", ISF.cleanVerdict({ verdict: "nsfw", scores: { suggestive: 0.1, sexual: 0.9 } }));
  assert.equal(d.action, "refuse");
});
