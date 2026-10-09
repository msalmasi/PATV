// Offline tests for 1.99iz: members create pads (padcreate.js) + the empty-pad reclaim (off by default).
//   - who may: signed in, a linked account (any / camfrog / none), account age, level, the per-member cap, the fee + balance,
//     the master switch; site staff skip all of it; every reason is listed
//   - a created pad: site platform, patv:<random> id, the creator owns it, chosen slug, origin user, visibility, logged,
//     the fee charged once (balance, transactions, a Fort Knox / Reserve claim), one creation a minute
//   - the HTTP routes: /pads/new (form / "not yet"), /api/pads/check-slug, /api/pads/create (JSON + same-site)
//   - reclaim: off = nothing; on = an old empty member-made site pad is removed (address freed, owner told), pads with posts,
//     young pads and admin-made pads are kept
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-create.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-create-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PC = require(path.join(repo, "padcreate"));
const cfg = require(path.join(repo, "padcfg"));
require(path.join(repo, "terms"))._setRequired(false);

const DAY = 24 * 3600e3;
const users = new Map();
const U = {};
const old = "2026-01-01 00:00:00";
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, discordId, twitchId, level, created_at, points_balance)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, ?, ?)`,
                 [id, name, name, extra.class || "pleb", extra.camfrog || null, extra.discord || null, extra.twitch || null,
                  extra.level != null ? extra.level : 5, extra.created || old, extra.pat != null ? extra.pat : 100000]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
let base, server;
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.maker = await mkUser("maker", { camfrog: "makercf" });
  U.discorder = await mkUser("discorder", { discord: "123" });
  U.unlinked = await mkUser("unlinked");
  U.newbie = await mkUser("newbie", { camfrog: "newbiecf", created: new Date(Date.now() - 2 * DAY).toISOString().slice(0, 19).replace("T", " ") });
  U.low = await mkUser("lowlevel", { camfrog: "lowcf", level: 1 });
  U.poor = await mkUser("poor", { camfrog: "poorcf", pat: 10 });
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  await require(path.join(repo, "padaccess")).init();
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PC.register(app, { addUser, noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("defaults: on, any linked account, 7 days, level 2, 2 pads each, free; reclaim off after 90 days", async () => {
  const C = await cfg.get();
  assert.deepEqual([C.create_on, C.create_link, C.create_min_age_days, C.create_min_level, C.create_max_per_user, C.create_fee, C.reclaim_on, C.reclaim_days],
                   [true, "any", 7, 2, 2, 0, false, 90]);
});

test("who may: link, age, level, balance - each listed; Discord counts as linked; staff skip everything", async () => {
  assert.ok((await PC.eligibility(U.maker)).ok);
  assert.ok((await PC.eligibility(U.discorder)).ok, "a Discord link counts for 'any'");
  assert.match((await PC.eligibility(U.unlinked)).reasons.join(" "), /Link an account/);
  assert.match((await PC.eligibility(U.newbie)).reasons.join(" "), /7 days old \(5 more days\)/);
  assert.match((await PC.eligibility(U.low)).reasons.join(" "), /level 2 \(you're level 1\)/);
  assert.match((await PC.eligibility(null)).reasons.join(" "), /Sign in/);
  await cfg.set({ create_link: "camfrog", create_fee: 5000 }, "test");
  assert.match((await PC.eligibility(U.discorder)).reasons.join(" "), /Camfrog name/);
  const p = await PC.eligibility(U.poor);
  assert.equal(p.ok, false);
  assert.match(p.reasons.join(" "), /costs 5,000 PAT - you have 10/);
  const a = await PC.eligibility(U.admin);
  assert.deepEqual([a.ok, a.staff, a.fee], [true, true, 0]);
  await cfg.set({ create_link: "none", create_fee: 0 }, "test");
  assert.ok((await PC.eligibility(U.unlinked)).ok, "'none' = no link needed");
  await cfg.set({ create_on: false }, "test");
  assert.match((await PC.eligibility(U.maker)).reasons.join(" "), /switched off/);
  assert.ok((await PC.eligibility(U.admin)).ok, "staff can still create");
  await cfg.set({ create_on: true, create_link: "any" }, "test");
});

test("create: a site pad owned by its creator, the chosen address, visibility, logged; fee charged once to Fort Knox / the Reserve", async () => {
  await cfg.set({ create_fee: 2500 }, "test");
  PC._resetRecent();
  const before = await bal(U.maker);
  const R = await PC.create(U.maker, { title: "  Night   Owls ", slug: "Night Owls", description: "late chats", visibility: "public" });
  assert.match(R.id, /^patv:[0-9a-f]{12}$/);
  assert.deepEqual([R.slug, R.title, R.platform, R.slug_set, R.origin, R.created_by, R.owner_kind, R.owner.userId],
                   ["night-owls", "Night Owls", "site", true, "user", U.maker.userId, "user", U.maker.userId]);
  assert.equal(R.description, "late chats");
  assert.equal(require(path.join(repo, "padaccess")).levelOf(R.id), "public");
  assert.equal(await bal(U.maker), before - 2500);
  const tx = await getQuery("SELECT points, type FROM transactions WHERE userId = ?", [U.maker.userId]);
  assert.deepEqual(tx.map((t) => [t.points, t.type]), [[-2500, "🧱 new pad p/night-owls"]]);
  const cl = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ?", [U.maker.userId]);
  assert.deepEqual(cl.map((c) => [c.flow, c.amount]), [["pad_create", -2500]], "Fort Knox isn't live in the test: the Reserve's claim");
  const ev = await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = ?", [R.id]);
  assert.ok(ev.some((e) => e.what === "pad-created" && e.actor === "maker" && /fee 2500 PAT/.test(e.detail)));
  assert.ok((await rooms.list()).some((r) => r.id === R.id), "it's in the Pads guide's list");
  // one a minute
  await assert.rejects(PC.create(U.maker, { title: "Second", slug: "second-pad" }), /One new pad a minute/);
  await cfg.set({ create_fee: 0 }, "test");
});

test("create: bad input, taken address, the per-member cap (admin-given pads don't count); staff no cap", async () => {
  PC._resetRecent();
  await assert.rejects(PC.create(U.maker, { title: "ab" }), /at least 3 characters/);
  await assert.rejects(PC.create(U.maker, { title: "Owls Again", slug: "night-owls" }), /Address: Another pad/);
  await assert.rejects(PC.create(U.maker, { title: "Admin Pad", slug: "admin" }), /reserved/);
  await assert.rejects(PC.create(U.maker, { title: "Banner", slug: "banner-pad", banner: "javascript:alert(1)" }), /https:\/\/ image/);
  await rooms.addRoom("Given.Room", "Given", "test");
  await rooms.setOwner("Given.Room", "maker", "test");
  const two = await PC.create(U.maker, { title: "Second Pad" });
  assert.equal(two.slug, "second-pad", "the address defaults to the name");
  PC._resetRecent();
  await assert.rejects(PC.create(U.maker, { title: "Third Pad" }), /already own 2 pads you made/);
  assert.equal(await PC.madeCount(U.maker.userId), 2);
  for (let i = 0; i < 3; i++) { PC._resetRecent(); await PC.create(U.admin, { title: "Crew Pad " + i }); }
  assert.equal(await PC.madeCount(U.admin.userId), 3);
});

test("HTTP: /pads/new (form or what's missing), check-slug, create (JSON, same-site)", async () => {
  let r = await call("GET", "/pads/new", null);
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login\?next=/);
  r = await call("GET", "/pads/new", U.discorder);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /id="pcForm"/);
  assert.match(r.text, /It's free\./);
  r = await call("GET", "/pads/new", U.low);
  assert.match(r.text, /Not yet/);
  assert.doesNotMatch(r.text, /id="pcForm"/);
  r = await call("GET", "/api/pads/check-slug?slug=Night%20Owls", U.discorder);
  assert.match(r.d.problem, /Another pad/);
  r = await call("GET", "/api/pads/check-slug?slug=Fresh%20Pond", U.discorder);
  assert.deepEqual([r.d.slug, r.d.problem], ["fresh-pond", null]);
  r = await call("POST", "/api/pads/create", U.discorder, { title: "Fresh Pond" }, { "content-type": "text/plain", "x-test-user": U.discorder.userId });
  assert.equal(r.status, 415);
  r = await call("POST", "/api/pads/create", U.discorder, { title: "Fresh Pond" }, Object.assign(H(U.discorder), { "sec-fetch-site": "cross-site" }));
  assert.equal(r.status, 403);
  r = await call("POST", "/api/pads/create", U.low, { title: "Fresh Pond" });
  assert.equal(r.status, 403);
  r = await call("POST", "/api/pads/create", U.discorder, { title: "Fresh Pond", visibility: "members" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.slug, "fresh-pond");
  assert.equal(r.d.href, "/p/fresh-pond/settings?tab=general&created=1#look");
});

test("reclaim: off by default; on = old empty member-made site pads go (owner told), the rest stay", async () => {
  PC._resetRecent();
  const now = Date.now();
  const later = now + 100 * DAY;
  let out = await PC.reclaimSweep({ now: later });
  assert.equal(out.off, true);
  assert.ok((await rooms.get((await rooms.bySlug("fresh-pond")).id)), "nothing removed while it's off");
  // night-owls gets a post; fresh-pond stays empty; Given.Room is admin-made
  const owls = await rooms.bySlug("night-owls");
  await require(path.join(repo, "feedstore")).init();
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES ('p1', ?, ?)", [owls.id, now]);
  const cands = (await PC.reclaimCandidates({ now: later })).map((r) => r.slug).sort();
  assert.ok(cands.includes("fresh-pond") && cands.includes("second-pad"), cands.join(","));
  assert.ok(!cands.includes("night-owls"), "a pad with a post is kept");
  assert.ok(!cands.includes("given-room"), "admin-made pads are never reclaimed");
  assert.equal((await PC.reclaimCandidates({ now: now + DAY })).length, 0, "young pads are kept");
  await cfg.set({ reclaim_on: true }, "test");
  const fresh = await rooms.bySlug("fresh-pond");
  out = await PC.reclaimSweep({ now: later });
  assert.ok(out.reclaimed.some((x) => x.slug === "fresh-pond"));
  assert.equal(await rooms.get(fresh.id), null);
  assert.equal(await rooms.bySlug("fresh-pond"), null, "the address is free again");
  const inbox = await getQuery("SELECT title FROM inbox WHERE user_id = ?", [U.discorder.userId]);
  assert.ok(inbox.some((m) => /p\/fresh-pond was closed/.test(m.title)), "the owner is told");
  assert.ok(await rooms.get(owls.id), "night-owls (has a post) is still there");
  await cfg.set({ reclaim_on: false }, "test");
});
