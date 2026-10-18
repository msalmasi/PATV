// Offline tests for 1.99acw 📺 pictures and links on Pepe's OBS - what onair.js does with them (the pipeline itself is
// test/onairmedia.test.js):
//   * two lanes: a full picture replaces a slot (main lane); a corner item coexists with a stream; ✂ main / corner / all
//   * every media pick ends at `until`; media_enabled off clears both lanes; live pages need live_pages and only one at a time
//   * what Pepe gets: the target / overlay shapes (signed show URL, the live page itself + check_host, the corner %), features
//   * compatibility: an older Pepe (no caps) is refused and keeps what's on; OBS not set up -> "run !onair setup media";
//     Pepe losing the media caps mid-show ends the pick; Pepe's own refusal of a host ends it
//   * who: Staff can do everything (direct + live: the locked capabilities); an Assistant with onair.operate lowered can show
//     proxied pictures but gets 403 on direct and live; chat needs c.staff for direct / live
//   * jobs (only the starter's), audit rows (onair_log + its url column, admin_audit with the full URL), the queue (migration of
//     an old table, lanes, booked media, a direct host re-checked at play), the show page (CSP exact, the direct origin only in
//     img-src, stale token = empty page, no-referrer), a direct picture that fails to load ends, sanitizeState
//   node --test test/onair-lanes.test.js      (temp DB + dirs; a fixture server on 127.0.0.3)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onair-lanes-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.ONAIR_MEDIA_DIR = path.join(tmp, "onairfiles");
process.env.IMAGESAFETY_DIR = path.join(tmp, "isf");
const express = require("express");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const lp = require(path.join(repo, "linkpreview"));
const ISF = require(path.join(repo, "imagesafety"));
const SP = require(path.join(repo, "siteperms"));
const M = require(path.join(repo, "onairmedia"));
const OQ = require(path.join(repo, "onairqueue"));
const OA = require(path.join(repo, "onair"));
require(path.join(repo, "terms"))._setRequired(false);

let T = 1_800_000_000_000;
S._setClock(() => T);
OA._setClock(() => T);
OQ._setClock(() => T);
rooms.notify = async () => true;

// a fixture "internet" on 127.0.0.3 (addressed by IP: the on-air path resolves with the real DNS)
let fx, port;
const FIX = new Map();
const U = (p) => `http://127.0.0.3:${port}${p}`;
let CALLS = 0;
let ANSWER = { verdict: "allow", scores: { nudity_explicit: 0.01, sexual: 0.01, suggestive: 0.05, minor_risk: 0, gore: 0, hate_symbols: 0 } };

let n = 0, cids = 0;
async function mkUser(cf) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 0, ?)",
    [id, "streamer" + n, "Streamer " + n, cf || null]);
  return { userId: id, username: "streamer" + n };
}
const pub = (name, cid) => S.rtmpCallback({ call: "publish", app: "stage", name, addr: "1.2.3.4", clientid: String(cid) });
async function live() {
  const u = await mkUser();
  const b = await S.book(u, { minutes: 30 });
  assert.equal((await pub(b.key, ++cids)).status, 302);
  return { id: b.slot.id, user: u };
}
const CAPS = ["media", "overlay", "live", "direct"];
/** Pepe checks in (fresh): caps + OBS readiness. */
const pepe = (state = {}, caps = CAPS) => OA.forBot({ caps, state: { obs: "ok", media_ok: true, live_ok: true, ...state } });
const chat = (c) => OA.botCommand({ by: "boss", admin: true, staff: true, ...c });
const cleanAll = () => OA.clear("test", "test", { lane: "all" });
/** A stored, checked picture (through the real pipeline with the stub classifier). */
async function asset(colour = "#3a3") {
  const buf = await sharp({ create: { width: 40, height: 30, channels: 3, background: colour } }).png().toBuffer();
  return M.ingestBuffer(buf, "png", { src_kind: "url", src_url: "https://img.example/" + colour.slice(1) + ".png", src_host: "img.example" });
}
async function picture(lane = "main", extra = {}) {
  const a = await asset(extra.colour || "#3a3");
  return M.mediaOf({ mode: "image", lane, corner: lane === "corner" ? "br" : null, secs: extra.secs || 30, caption: extra.caption || "Look at this frog",
                     url: "https://img.example/x.png" }, { asset: a });
}

const users = new Map();
let app, base, srv;
const H = (cls) => ({ "Content-Type": "application/json", "X-Requested-With": "fetch", ...(cls ? { "x-test-class": cls } : {}) });
const post = (cls, body) => fetch(base + "/api/stage/admin/onair", { method: "POST", headers: H(cls), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  // an onair_queue from before 1.99acw (no kind / spec columns) with a waiting YouTube link in it
  await runQuery(`CREATE TABLE onair_queue (id TEXT PRIMARY KEY, at INTEGER, url TEXT NOT NULL, label TEXT, by TEXT,
                  created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', done_at INTEGER, why TEXT)`);
  await runQuery("INSERT INTO onair_queue (id, at, url, label, by, created, status) VALUES ('old001', NULL, 'https://youtu.be/dQw4w9WgXcQ', '🔗 YouTube video', 'pepe:boss', ?, 'waiting')", [T - 1000]);
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, enabled: true }, "test");
  await rooms.setStage(rooms.HOUSE_ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await require(path.join(repo, "padaccess")).init();
  await require(path.join(repo, "adminaudit")).init();
  await SP.init();
  await ISF.init();
  ISF.setClassifier(async () => { CALLS++; return typeof ANSWER === "function" ? ANSWER() : ANSWER; });
  await ISF.setConfig({ ...ISF.DEFAULTS, timeout_secs: 2 }, "test");
  await M.init();
  await OA.init();
  await OA.saveConfig({ enabled: true, live_pages: true }, "test");
  // fixtures
  FIX.set("/a.png", ["image/png", await sharp({ create: { width: 30, height: 20, channels: 3, background: "#a33" } }).png().toBuffer()]);
  FIX.set("/b.png", ["image/png", await sharp({ create: { width: 30, height: 20, channels: 3, background: "#33a" } }).png().toBuffer()]);
  FIX.set("/page", ["text/html", Buffer.from("<html><head><title>A page</title></head><body>hi</body></html>")]);
  fx = http.createServer((req, res) => {
    const f = FIX.get(new URL(req.url, "http://x").pathname);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": f[0] });
    res.end(f[1]);
  });
  await new Promise((r) => fx.listen(0, "127.0.0.3", r));
  port = fx.address().port;
  lp._testAllow("127.0.0.3", port);
  // the web routes
  app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => {
    const c = req.headers["x-test-class"];
    req.user = c ? { userId: "u-" + c, username: "n-" + c, class: c } : null;
    next();
  };
  OA.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  base = "http://127.0.0.1:" + srv.address().port;
});
test.after(() => { if (srv) srv.close(); if (fx) fx.close(); ISF._reset(); });
test.afterEach(async () => {
  await cleanAll();
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await OA.saveConfig({ enabled: true, media_enabled: true, live_pages: true, cam_optin: true }, "test");
  M._reset();
  await M.init();
  ANSWER = { verdict: "allow", scores: { nudity_explicit: 0.01, sexual: 0.01, suggestive: 0.05, minor_risk: 0, gore: 0, hate_symbols: 0 } };
});

test("defaults: pictures & links on, live pages OFF on prod, the corner hidden under the IRL feed, durations and caps", () => {
  const D = OA.DEFAULTS;
  assert.deepEqual([D.media_enabled, D.live_pages, D.overlay_over_irl], [true, false, false]);
  assert.deepEqual([D.media_secs, D.media_max_s, D.live_secs, D.live_max_s, D.direct_max_s, D.corner_pct, D.max_image_mb], [30, 600, 60, 600, 120, 30, 8]);
  assert.deepEqual([D.corner_source, D.live_source, D.top_scene], ["PATV OnAir Corner", "PATV OnAir Live", "PATV OnAir Top"]);
  assert.deepEqual(OA.clean({ direct_max_s: 301, media_secs: 4, live_deny: "bad host!" }).errors,
    { direct_max_s: "10–300", media_secs: "5–600", live_deny: "host names, comma-separated (at most 20)" });
  assert.equal(OA.clean({ live_deny: " Evil.Example , b.example " }).cfg.live_deny, "evil.example, b.example");
  assert.equal(OA.clean({ top_scenes: "Main,  Pepe ,," }).cfg.top_scenes, "Main, Pepe");
});

test("the queue table from before 1.99acw gains kind + spec; its waiting YouTube link still plays", async () => {
  await OQ.init();
  const cols = (await getQuery("PRAGMA table_info(onair_queue)")).map((c) => c.name);
  assert.ok(cols.includes("kind") && cols.includes("spec"), "kind + spec added");
  const old = (await OQ.list()).find((r) => r.id === "old001");
  assert.deepEqual([old.kind, old.lane, old.mode], ["embed", "main", null]);
  await pepe();
  await OA.check();
  assert.equal(OA.view().target.kind, "embed", "the old next-up link played");
  assert.equal((await OQ.recent(1))[0].id, "old001");
});

test("an older Pepe (no caps) is refused - what's on stays; OBS not set up -> 'run !onair setup media'; switches off -> refused", async () => {
  const a = await live();
  await OA.setSlot(a.id, "web:boss");
  await pepe({}, []);                                            // a Pepe from before 1.99acv
  const m = await picture();
  await assert.rejects(OA.setMedia(m, "web:boss"), (e) => e.code === "media_old_bot" && /1\.99acv/.test(e.message));
  let r = await OA.forBot({ state: { obs: "ok" } });
  assert.equal(r.target.kind, "slot", "the stream is untouched");
  assert.equal(r.overlay, null);
  assert.deepEqual(r.features, ["media"], "the site says it can (a newer Pepe answers locally without it)");
  r = await OA.botCommand({ by: "boss", admin: true, staff: true, action: "media", mode: "image", words: [U("/a.png"), "rights"] });
  assert.equal(r.ok, false);
  assert.match(r.msg, /1\.99acv/);
  await pepe({ media_ok: false });
  await assert.rejects(OA.setMedia(m, "web:boss"), (e) => e.code === "media_setup" && /!onair setup media/.test(e.message));
  await pepe({ live_ok: false });
  await assert.rejects(OA.setMedia(M.mediaOf({ mode: "live", lane: "main", secs: 60, url: U("/page") }, { live: { url: U("/page"), host: "127.0.0.3", sound: false } }), "web:boss"),
    (e) => e.code === "live_setup");
  await pepe();
  await OA.saveConfig({ media_enabled: false }, "test");
  await assert.rejects(OA.setMedia(m, "web:boss"), (e) => e.code === "media_off");
  await OA.saveConfig({ media_enabled: true, live_pages: false }, "test");
  await assert.rejects(OA.setMedia(M.mediaOf({ mode: "live", lane: "main", secs: 60 }, { live: { url: U("/page"), host: "127.0.0.3" } }), "web:boss"), (e) => e.code === "live_off");
  T += OA.BOT_FRESH_MS + 1000;                                   // Pepe gone quiet
  await assert.rejects(OA.setMedia(m, "web:boss"), (e) => e.code === "pepe_away");
  assert.equal(OA.view().target.kind, "slot");
});

test("lanes: a full picture replaces the stream; a corner item sits over it; ✂ corner / main / all; Pepe gets both shapes", async () => {
  const a = await live();
  await OA.setSlot(a.id, "web:boss");
  await pepe();
  const corner = await picture("corner", { colour: "#00a", caption: null });
  await OA.setMedia(corner, "web:boss");
  let r = await pepe();
  assert.equal(r.target.kind, "slot", "the stream stays on");
  const ov = r.overlay;
  assert.deepEqual([ov.kind, ov.mode, ov.lane, ov.layout, ov.corner, ov.pct, ov.direct, ov.check_host], ["media", "image", "corner", "corner", "br", 30, false, null]);
  assert.match(ov.url, /^https:\/\/publicaccess\.tv\/onair\/show\?t=/);
  const tok = decodeURIComponent(ov.url.split("t=")[1]);
  assert.equal(OA.mediaForToken(tok).lane, "corner");
  assert.equal(OA.mediaForToken(tok.slice(0, -2) + "xx"), null, "a forged token");
  assert.equal(OA.embedForToken(tok), null, "a show token never opens the embed player");
  assert.equal(ov.until, T + 30 * 1000);
  // ✂ corner only
  assert.match((await chat({ action: "off", query: "corner" })).msg, /corner is clear/);
  assert.equal(OA.view().overlay, null);
  assert.equal(OA.view().target.kind, "slot");
  // a full picture replaces the stream
  await OA.setMedia(await picture("main", { colour: "#0a0" }), "web:boss");
  r = await pepe();
  assert.deepEqual([r.target.kind, r.target.lane, r.target.layout, r.target.label], ["media", "main", "full", "🖼 Look at this frog"]);
  const replaced = (await getQuery("SELECT what, kind FROM onair_log WHERE what = 'replaced' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(replaced.kind, "slot");
  // ✂ all (the web's Cut / !onair off) takes both lanes
  await OA.setMedia(corner, "web:boss");
  assert.ok(OA.view().overlay && OA.view().target);
  assert.match((await chat({ action: "off" })).msg, /Off Pepe's main stream/);
  assert.deepEqual([OA.view().target, OA.view().overlay], [null, null]);
  // status: both lanes and the time left
  await OA.setMedia(corner, "web:boss");
  assert.match((await chat({ action: "status" })).msg, /↗ Corner: .* 30 s left/);
});

test("ends by itself: at its time; pictures switched off (both lanes); Pepe losing the caps / media_ok for a while; Pepe refusing its host", async () => {
  await pepe();
  await OA.setMedia(await picture("main", { secs: 20 }), "web:boss");
  T += 19 * 1000;
  await pepe();
  assert.ok(OA.view().target);
  T += 2 * 1000;
  await pepe();
  assert.equal(OA.view().target, null);
  assert.equal((await getQuery("SELECT detail FROM onair_log WHERE what = 'end' ORDER BY id DESC LIMIT 1"))[0].detail, "media_done");
  // media_enabled off: both lanes at once
  await OA.setMedia(await picture("main"), "web:boss");
  await OA.setMedia(await picture("corner", { colour: "#123" }), "web:boss");
  await OA.saveConfig({ media_enabled: false }, "test");
  assert.deepEqual([OA.view().target, OA.view().overlay], [null, null]);
  assert.deepEqual((await getQuery("SELECT detail FROM onair_log WHERE what = 'end' ORDER BY id DESC LIMIT 2")).map((x) => x.detail), ["media_off", "media_off"]);
  await OA.saveConfig({ media_enabled: true }, "test");
  // Pepe restarted into a version without media (or OBS lost the sources): off after BOT_FRESH_MS
  await pepe();
  await OA.setMedia(await picture("main", { secs: 300 }), "web:boss");
  await pepe({}, []);
  assert.ok(OA.view().target, "not at once");
  T += OA.BOT_FRESH_MS + 1000;
  await pepe({}, []);
  assert.equal(OA.view().target, null);
  assert.equal((await getQuery("SELECT detail FROM onair_log WHERE what = 'end' ORDER BY id DESC LIMIT 1"))[0].detail, "pepe_cant");
  // Pepe's own network check refused the host (a direct picture / live page): off, with his reason
  await pepe();
  await OA.setMedia(M.mediaOf({ mode: "live", lane: "main", secs: 60, url: U("/page") }, { live: { url: U("/page"), host: "127.0.0.3", sound: false } }), "web:boss");
  const id = OA.view().target.id;
  await pepe({ media_err: "that address is on Pepe's own network", media_err_id: id });
  assert.equal(OA.view().target, null);
  assert.equal((await getQuery("SELECT detail FROM onair_log WHERE what = 'end' ORDER BY id DESC LIMIT 1"))[0].detail, "pepe_refused: that address is on Pepe's own network");
});

test("live pages: the page itself + check_host for Pepe, muted unless sound; one at a time; live_pages off ends it", async () => {
  await pepe();
  const lv = M.mediaOf({ mode: "live", lane: "main", secs: 60, url: U("/page"), sound: true }, { live: { url: U("/page"), host: "127.0.0.3", sound: true } });
  await OA.setMedia(lv, "web:boss");
  const r = await pepe();
  assert.deepEqual([r.target.mode, r.target.url, r.target.check_host, r.target.sound, r.target.label], ["live", U("/page"), "127.0.0.3", true, "🌐 127.0.0.3 (live)"]);
  await assert.rejects(OA.setMedia({ ...lv, lane: "corner" }, "web:boss"), (e) => e.code === "live_busy" && /cut it first/.test(e.message));
  await OA.setMedia(await picture("corner"), "web:boss");       // a picture in the corner is fine
  const set = (await getQuery("SELECT detail, url FROM onair_log WHERE what = 'set' AND kind = 'media' ORDER BY id DESC LIMIT 2"))[1];
  assert.match(set.detail, /"live":true/);
  assert.match(set.detail, /"sound":true/);
  assert.equal(set.url, U("/page"));
  await OA.saveConfig({ live_pages: false }, "test");
  assert.equal(OA.view().target, null, "live pages switched off: the page goes");
  assert.ok(OA.view().overlay, "the corner picture stays");
});

test("chat: !onair image/link through the site's grammar; direct / live need c.staff; job polling only for the starter; audit + url column", async () => {
  await pepe();
  let r = await chat({ action: "media", mode: "image", words: [U("/a.png"), "Frog", "time", "for", "45s", "corner", "rights"] });
  assert.equal(r.ok, true, r.msg);
  if (!r.final) {
    await M.waitJob(r.job);
    r = await chat({ action: "job", id: r.job });
  }
  assert.equal(r.final, true);
  assert.match(r.msg, /^In the corner for 45 s: 🖼 Frog time/);
  assert.equal(OA.view().overlay.media.caption, "Frog time");
  assert.equal((await OA.botCommand({ by: "someoneelse", admin: true, action: "job", id: r.job })).state, "unknown", "only the starter sees a job");
  // direct / live without Pepe's staff role: refused (the site trusts c.staff from Pepe's real-role check)
  r = await chat({ staff: false, action: "media", mode: "image", words: [U("/b.png"), "direct", "rights"] });
  assert.deepEqual([r.ok, r.msg], [false, "Direct pictures and live pages are for Pepe's staff and up."]);
  r = await chat({ staff: false, action: "media", mode: "link", words: [U("/page"), "live", "rights"] });
  assert.equal(r.ok, false);
  r = await chat({ action: "media", mode: "image", words: [U("/b.png"), "rights"], admin: false });
  assert.deepEqual([r.ok, r.msg], [false, "Admins only."]);
  // a direct picture from staff: no scan, the warning, the url column + admin-visible detail
  const calls = CALLS;
  r = await chat({ action: "media", mode: "image", words: [U("/b.png"), "direct", "for", "10m", "rights"] });
  if (!r.final) { await M.waitJob(r.job); r = await chat({ action: "job", id: r.job }); }
  assert.equal(r.ok, true, r.msg);
  assert.match(r.msg, /^⚠ Shown directly - NOT safety-scanned, and the site sees Pepe's address\. Up for 2 min \(the most allowed\): 🖼↗ 127\.0\.0\.3 \(direct, unscanned\)/);
  assert.equal(CALLS, calls, "never classified");
  const tgt = (await pepe()).target;
  assert.deepEqual([tgt.direct, tgt.check_host, tgt.secs], [true, "127.0.0.3", 120]);
  const set = (await getQuery("SELECT by, detail, url FROM onair_log WHERE what = 'set' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(set.by, "pepe:boss");
  assert.match(set.detail, /"direct":true,"unscanned":true/);
  assert.match(set.detail, /"rights_confirmed":true/);
  assert.equal(set.url, U("/b.png"));
  // missing rights / a bad word: the usage
  r = await chat({ action: "media", mode: "image", words: [U("/b.png")] });
  assert.match(r.msg, /"rights"/);
});

test("web: Staff - pictures, direct and live; an Assistant with onair.operate lowered - proxied pictures only (403 on direct / live)", async () => {
  await pepe();
  let r = await post("Staff", { action: "media", mode: "image", url: U("/a.png"), caption: "hi", secs: 30, layout: "full", rights: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  if (!r.d.job.final) { await M.waitJob(r.d.job.id); }
  let j = await fetch(base + "/api/stage/admin/onair/job/" + r.d.job.id, { headers: H("Staff") }).then((x) => x.json());
  assert.equal(j.job.state, "done", JSON.stringify(j));
  assert.equal((await fetch(base + "/api/stage/admin/onair/job/" + r.d.job.id, { headers: H("Assistant") })).status, 403, "an Assistant (not an operator)");
  assert.equal((await fetch(base + "/api/stage/admin/onair/job/" + r.d.job.id, { headers: H("Admin") })).status, 200, "on-air config holders see any job");
  const audit = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'onair' ORDER BY id DESC LIMIT 1"))[0];
  assert.match(audit.detail, /"action":"set"/);
  assert.match(audit.detail, new RegExp('"url":"' + U("/a.png").replace(/[.?]/g, "\\$&") + '"'));
  r = await post("Staff", { action: "media", mode: "image", url: U("/b.png"), direct: true, secs: 30, layout: "corner", corner: "tl", rights: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  r = await post("Staff", { action: "media", mode: "live", url: U("/page"), sound: false, rights: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.media.can.direct, true);
  assert.equal(r.d.media.can.live, true);
  assert.equal((await post("Staff", { action: "media", mode: "image", url: U("/a.png") })).status, 400, "the rights tick");
  assert.equal((await post("pleb", { action: "media", mode: "image", url: U("/a.png"), rights: true })).status, 403, "a member");
  await cleanAll();
  // onair.operate lowered to Assistants: proxied pictures yes, direct / live never (locked "exposure")
  const owner = { level: 100, role: "owner", username: "boss", userId: "u-boss" };
  await SP.setMin(owner, "onair.operate", "assistant");
  try {
    await pepe();
    r = await post("Assistant", { action: "media", mode: "image", url: U("/a.png"), rights: true });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    assert.deepEqual([r.d.media.can.direct, r.d.media.can.live], [false, false]);
    r = await post("Assistant", { action: "media", mode: "image", url: U("/b.png"), direct: true, rights: true });
    assert.equal(r.status, 403);
    assert.match(r.d.error, /Staff and up/);
    r = await post("Assistant", { action: "media", mode: "live", url: U("/page"), rights: true });
    assert.equal(r.status, 403);
    await assert.rejects(SP.setMin(owner, "onair.direct_media", "assistant"), (e) => e.code === "locked");
  } finally { await SP.setMin(owner, "onair.operate", "default"); }
  // ✂ from the web: lane corner only / all
  await pepe();
  await OA.setMedia(await picture("corner"), "web:boss");
  await OA.setMedia(await picture("main", { colour: "#456" }), "web:boss");
  r = await post("Staff", { action: "off", lane: "corner" });
  assert.deepEqual([!!r.d.target, r.d.overlay], [true, null]);
  await OA.setMedia(await picture("corner"), "web:boss");
  r = await post("Staff", { action: "off" });
  assert.deepEqual([r.d.target, r.d.overlay], [null, null]);
});

test("the show page: a valid token renders with the exact strict CSP (a direct origin only in img-src); a stale token = an empty page", async () => {
  await pepe();
  await OA.setMedia(await picture("main", { caption: "<i>frog</i>" }), "web:boss");
  let url = (await pepe()).target.url.replace("https://publicaccess.tv", base);
  let r = await fetch(url);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-security-policy"),
    "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(html, /<img class="oas-main" src="\/onair\/m\/[a-f0-9]{32}\.webp"/);
  assert.match(html, /&lt;i&gt;frog&lt;\/i&gt;/);
  assert.match(html, /data-until="\d+"/);
  // a direct picture: its origin, and only in img-src
  await OA.setMedia(M.mediaOf({ mode: "image", lane: "corner", corner: "tl", secs: 60, url: U("/b.png"), direct: true },
    { direct: { url: U("/b.png"), origin: `http://127.0.0.3:${port}`, host: "127.0.0.3" } }), "web:boss");
  const ov = (await pepe()).overlay;
  r = await fetch(ov.url.replace("https://publicaccess.tv", base));
  const csp = r.headers.get("content-security-policy");
  assert.equal(csp, `default-src 'none'; img-src 'self' http://127.0.0.3:${port}; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  assert.equal(csp.split(`127.0.0.3:${port}`).length, 2, "the origin appears once (img-src)");
  const dh = await r.text();
  assert.match(dh, new RegExp(`<img class="oas-main" src="${U("/b.png").replace(/[.?]/g, "\\$&")}" alt="" referrerpolicy="no-referrer">`));
  assert.match(dh, /oas-corner oas-k-image oas-c-tl/);
  // a stale token (the pick ended): an empty, transparent page
  await cleanAll();
  r = await fetch(url);
  const empty = await r.text();
  assert.equal(r.status, 200);
  assert.doesNotMatch(empty, /oaShow|<img|<script/);
  assert.equal(r.headers.get("content-security-policy").includes("127.0.0.3"), false);
  assert.equal((await fetch(base + "/onair/show?t=garbage")).status, 200);
});

test("the show page reports in: a direct picture that doesn't load is taken off; a proxied one never stall-ends; a stale token blanks", async () => {
  await pepe();
  await OA.setMedia(M.mediaOf({ mode: "image", lane: "main", secs: 60, url: U("/b.png"), direct: true },
    { direct: { url: U("/b.png"), origin: `http://127.0.0.3:${port}`, host: "127.0.0.3" } }), "web:boss");
  const tok = decodeURIComponent((await pepe()).target.url.split("t=")[1]);
  const state = (body) => fetch(base + "/api/onair/show/state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
  assert.deepEqual(await state({ t: tok, state: "loaded", w: 30, h: 20 }), { ok: true, on: true, until: T + 60000 });
  await state({ t: tok, state: "error" });
  await OA.check();
  assert.equal(OA.view().target, null);
  assert.equal((await getQuery("SELECT detail FROM onair_log WHERE what = 'end' ORDER BY id DESC LIMIT 1"))[0].detail, "media_failed");
  assert.deepEqual(await state({ t: tok, state: "showing" }), { ok: true, on: false });
  await OA.setMedia(await picture("main"), "web:boss");
  const tok2 = decodeURIComponent((await pepe()).target.url.split("t=")[1]);
  await state({ t: tok2, state: "error" });
  await OA.check();
  assert.ok(OA.view().target, "a proxied picture is ours - it doesn't end on a page error");
});

test("the queue: media rows per lane; booked media replaces its lane; a direct host re-checked at play; media waits for a capable Pepe", async () => {
  // a corner next-up item plays while a stream is on the main lane
  const a = await live();
  await OA.setSlot(a.id, "web:boss");
  let r = await chat({ action: "media", mode: "image", queue: true, words: [U("/a.png"), "corner", "rights"] });
  if (!r.final) { await M.waitJob(r.job); r = await chat({ action: "job", id: r.job }); }
  assert.match(r.msg, /⏰ Queued \[\w+\]/);
  const row = (await OQ.list()).find((x) => x.kind === "media");
  assert.deepEqual([row.lane, row.mode], ["corner", "image"]);
  await pepe();
  await OA.check();
  assert.equal(OA.view().target.kind, "slot", "the stream keeps the main lane");
  assert.equal(OA.view().overlay.queued, row.id, "the corner item went on");
  assert.match((await getQuery("SELECT by FROM onair_log WHERE what = 'set' ORDER BY id DESC LIMIT 1"))[0].by, /^queue:pepe:boss/);
  await cleanAll();
  // a booked full picture replaces the stream at its time
  await OA.setSlot(a.id, "web:boss");
  r = await chat({ action: "media", mode: "image", when: "in 30m", words: [U("/b.png"), "rights"] });
  if (!r.final) { await M.waitJob(r.job); r = await chat({ action: "job", id: r.job }); }
  assert.match(r.msg, /ET/);
  T += 29 * 60 * 1000;
  await runQuery("UPDATE stage_slots SET beat = ? WHERE id = ?", [T, a.id]);
  await pepe();
  await OA.check();
  assert.equal(OA.view().target.kind, "slot", "not yet");
  T += 2 * 60 * 1000;
  await runQuery("UPDATE stage_slots SET beat = ? WHERE id = ?", [T, a.id]);
  await pepe();
  await OA.check();
  assert.equal(OA.view().target.kind, "media", "due: replaced the stream");
  await cleanAll();
  // a direct picture is re-checked when it plays: its host gone private by then -> failed, never shown
  const dq = await OQ.add({ kind: "media", label: "🖼↗ x (direct, unscanned)", by: "pepe:boss", owner: { via: "chat", login: "boss" },
                 spec: M.mediaOf({ mode: "image", lane: "main", secs: 30, url: "http://10.0.0.9/x.png", direct: true },
                                 { direct: { url: "http://10.0.0.9/x.png", origin: "http://10.0.0.9", host: "10.0.0.9" } }) });
  await pepe();
  await OA.check();
  assert.equal(OA.view().target, null);
  const failed = (await OQ.recent(20)).find((x) => x.id === dq.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.why, /private/);
  // media rows wait while Pepe can't show pictures; a booked one is missed after LATE_MS
  r = await chat({ action: "media", mode: "image", when: "in 5m", words: [U("/a.png"), "rights"] });
  if (!r.final) { await M.waitJob(r.job); }
  T += 6 * 60 * 1000;
  await pepe({}, []);
  await OA.check();
  assert.equal(OA.view().target, null, "an older Pepe: it waits");
  T += OQ.LATE_MS;
  await pepe({}, []);
  await OA.check();
  assert.deepEqual([(await OQ.recent(1))[0].status, (await OQ.recent(1))[0].why], ["missed", "Pepe couldn't show pictures"]);
});

test("audit + state: onair_log.url keeps 2048 characters; sanitizeState keeps the new keys and drops junk; caps cleaned", async () => {
  await pepe();
  const long = "https://example.com/" + "a".repeat(2028);
  assert.equal(long.length, 2048);
  await OA.setMedia(M.mediaOf({ mode: "live", lane: "main", secs: 60, url: long }, { live: { url: long, host: "example.com", sound: false } }), "web:boss");
  const row = (await getQuery("SELECT url, detail FROM onair_log WHERE what = 'set' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(row.url.length, 2048);
  assert.ok(row.detail.length <= 500);
  const s = OA.sanitizeState({ media_ok: 1, live_ok: "yes", top_ok: true, ov_applied: "m:1".padEnd(200, "x"), ov_shown: 1, media_err: "bad\u0000host", media_err_id: "m:abc",
                               evil: "<script>", obs: "ok" });
  assert.deepEqual([s.media_ok, s.live_ok, s.top_ok, s.ov_shown, s.ov_applied.length, s.media_err, s.media_err_id], [true, true, true, true, 80, "bad host", "m:abc"]);
  assert.equal("evil" in s, false);
  await OA.forBot({ caps: ["media", "x".repeat(30), "Bad Caps", 7, "live"], state: { media_ok: true } });
  assert.deepEqual(OA.view().pepe.caps, ["media", "live"]);
});

test("imagesafety's pull stays on while on-air pictures are on (Pepe's vision is needed), off when they're off and nothing else is", async () => {
  const app2 = express();
  app2.use(express.json());
  ISF.register(app2, { addUser: (q, s, n) => n(), isBotToken: (t) => t === "bot", noTimers: true });
  const s2 = await new Promise((ok) => { const s = app2.listen(0, "127.0.0.1", () => ok(s)); });
  const pull = () => fetch("http://127.0.0.1:" + s2.address().port + "/api/pepe/imagesafety/pull", { method: "POST", headers: { "Content-Type": "application/json" },
                                                                                                   body: JSON.stringify({ password: "bot", wait: 0 }) }).then((x) => x.json());
  try {
    await ISF.setConfig({ ...ISF.DEFAULTS, enabled: false, shadow: false, locked_enforce: false }, "test");
    assert.equal(OA.mediaActive(), true);
    assert.equal((await pull()).enabled, true, "on-air media alone keeps it on");
    await OA.saveConfig({ media_enabled: false }, "test");
    assert.equal(OA.mediaActive(), false);
    const p = await pull();
    assert.deepEqual([p.enabled, p.idle], [false, 60]);
  } finally { s2.close(); await ISF.setConfig({ ...ISF.DEFAULTS, timeout_secs: 2 }, "test"); }
});

// ───────────────────────── 1.99acw review fixes ─────────────────────────
const LIVE = (lane = "main", extra = {}) => M.mediaOf({ mode: "live", lane, corner: lane === "corner" ? "br" : null, secs: extra.secs || 30, url: U("/page") },
  { live: { url: U("/page"), host: "127.0.0.3", sound: false } });
const DIRECT = (lane = "main") => M.mediaOf({ mode: "image", lane, corner: lane === "corner" ? "tl" : null, secs: 60, url: U("/b.png"), direct: true },
  { direct: { url: U("/b.png"), origin: `http://127.0.0.3:${port}`, host: "127.0.0.3" } });
async function staffRow(cls = "Staff") {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES ('u-Staff', 'n-Staff', 'Staff One', 'x', ?, 0, 'staffcf')
                  ON CONFLICT(userId) DO UPDATE SET class = excluded.class`, [cls]);
}
const jobDone = async (r, by = "boss") => {
  if (r.final) return r;
  await M.waitJob(r.job);
  return OA.botCommand({ by, admin: true, action: "job", id: r.job });
};
const webDone = async (r) => {
  if (!r.d || !r.d.job || r.d.job.final) return r.d && r.d.job;
  await M.waitJob(r.d.job.id);
  return (await fetch(base + "/api/stage/admin/onair/job/" + r.d.job.id, { headers: H("Staff") }).then((x) => x.json())).job;
};
const freshPng = async (name, colour) => { FIX.set(name, ["image/png", await sharp({ create: { width: 33, height: 21, channels: 3, background: colour } }).png().toBuffer()]); return U(name); };

test("SEC-3 / SEC-4: live pages need Pepe's 'live' cap and direct pictures his 'direct' cap (his VM-local steps) - no site switch alone turns them on", async () => {
  await runQuery("DELETE FROM onair_attempts");
  assert.equal(OA.DEFAULTS.live_pages, false, "off by default everywhere");
  await OA.forBot({ caps: ["media", "overlay"], state: { obs: "ok", media_ok: true, live_ok: true, live_why: "no VM firewall attestation (onair_live_firewall)",
                                                          direct_why: "no VM firewall attestation (onair_live_firewall)" } });
  await assert.rejects(OA.setMedia(LIVE(), "web:boss"), (e) => e.code === "live_fw" && /isn't firewalled for live pages yet \(no VM firewall attestation/.test(e.message));
  await assert.rejects(OA.setMedia(DIRECT(), "web:boss"), (e) => e.code === "direct_fw" && /firewalled for direct pictures/.test(e.message));
  await OA.setMedia(await picture("main", { colour: "#0f1" }), "web:boss");            // a checked picture is fine
  let r = await post("Staff", { action: "media", mode: "image", url: U("/b.png"), direct: true, rights: true });
  assert.equal(r.status, 409);
  assert.equal(r.d.code, "direct_fw");
  assert.equal(r.d.media === undefined, true);
  const v = await OA.adminView({ userId: "u-Staff", username: "n-Staff", class: "Staff" });
  assert.deepEqual([v.media.direct_ready, v.media.live_ready], [false, false]);
  assert.match(v.media.live_why, /firewalled/);
  await cleanAll();
  // a direct picture on air when Pepe stops sending "direct": off after BOT_FRESH_MS
  await pepe();
  await OA.setMedia(DIRECT(), "web:boss");
  await OA.forBot({ caps: ["media", "overlay", "live"], state: { obs: "ok", media_ok: true, live_ok: true } });
  assert.ok(OA.view().target);
  T += OA.BOT_FRESH_MS + 1000;
  await OA.forBot({ caps: ["media", "overlay", "live"], state: { obs: "ok", media_ok: true, live_ok: true } });
  assert.equal(OA.view().target, null);
  // queued: a direct row waits for the cap (never fails for it)
  await pepe({}, ["media", "overlay", "live"]);
  const dq = await OQ.add({ kind: "media", label: "🖼↗ waits", by: "web:n-Staff", owner: { via: "web", userId: "u-Staff" }, spec: DIRECT() });
  await OA.check();
  assert.equal((await OQ.list()).find((x) => x.id === dq.id).status, "waiting");
  await OQ.cancel(dq.id, "test");
});

test("CORRECT-2: a next-up live page waits while the OTHER lane shows one, then plays (it used to be marked failed)", async () => {
  await staffRow();
  await pepe();
  await OA.setMedia(LIVE("main", { secs: 20 }), "web:boss");
  const row = await OQ.add({ kind: "media", label: "🌐 corner live", by: "web:n-Staff", owner: { via: "web", userId: "u-Staff" }, spec: LIVE("corner") });
  await pepe();
  await OA.check();
  assert.equal(OA.view().overlay, null, "waits while the main lane shows a live page");
  assert.equal((await OQ.list()).find((x) => x.id === row.id).status, "waiting");
  T += 21 * 1000;
  await pepe();
  await OA.check();
  assert.equal(OA.view().target, null, "the main live page ended");
  if (!OA.view().overlay) { await pepe(); await OA.check(); }
  assert.equal(OA.view().overlay && OA.view().overlay.queued, row.id, "then it plays");
  // a booked live page whose time comes while the other lane is live: waits, missed after LATE_MS with the reason
  await cleanAll();
  await pepe();
  await OA.setMedia(LIVE("corner", { secs: 600 }), "web:boss");
  const bk = await OQ.add({ kind: "media", label: "🌐 booked", by: "web:n-Staff", owner: { via: "web", userId: "u-Staff" }, spec: LIVE("main"), at: T + 60 * 1000 });
  T += 61 * 1000;
  await pepe();
  await OA.check();
  assert.equal((await OQ.list()).find((x) => x.id === bk.id).status, "waiting");
  T += OQ.LATE_MS;
  await OA.forBot({ caps: CAPS, state: { obs: "ok", media_ok: true, live_ok: true } });
  await OA.check();
  const missed = (await OQ.recent(20)).find((x) => x.id === bk.id);
  assert.ok(["missed"].includes(missed.status), missed.status);
});

test("CORRECT-3: a queued live page is checked against the CURRENT live_deny when it plays", async () => {
  await staffRow();
  await pepe();
  const row = await OQ.add({ kind: "media", label: "🌐 later denied", by: "web:n-Staff", owner: { via: "web", userId: "u-Staff" }, spec: LIVE("main") });
  await OA.saveConfig({ live_deny: "127.0.0.3" }, "test");
  try {
    await OA.check();
    const r = (await OQ.recent(20)).find((x) => x.id === row.id);
    assert.equal(r.status, "failed");
    assert.match(r.why, /can't be opened live/);
    assert.equal(OA.view().target, null);
  } finally { await OA.saveConfig({ live_deny: "" }, "test"); }
});

test("SEC-7: a queued direct picture / live page plays only while its queuer still may (web: their current class; chat: within an hour)", async () => {
  await runQuery("DELETE FROM onair_attempts");
  await staffRow("Staff");
  await pepe();
  let r = await post("Staff", { action: "media", mode: "image", url: U("/b.png"), direct: true, rights: true, at: T + 60 * 1000 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const j = await webDone(r);
  assert.equal(j.state, "done", JSON.stringify(j));
  const row = (await OQ.list()).find((x) => x.kind === "media" && x.direct);
  assert.deepEqual(row.owner, { via: "web", userId: "u-Staff" });
  await staffRow("pleb");                                         // demoted (or the account locked down) meanwhile
  T += 61 * 1000;
  await pepe();
  await OA.check();
  const done = (await OQ.recent(20)).find((x) => x.id === row.id);
  assert.equal(done.status, "failed");
  assert.match(done.why, /can't show direct pictures any more/);
  assert.equal(OA.view().target, null);
  await staffRow("Staff");
  // chat: not more than an hour ahead; a next-up one older than an hour isn't played
  r = await chat({ action: "media", mode: "image", when: "in 2h", words: [U("/b.png"), "direct", "rights"] });
  assert.equal(r.ok, false);
  assert.match(r.msg, /at most an hour ahead/);
  const old = await OQ.add({ kind: "media", label: "🖼↗ old chat", by: "pepe:boss", owner: { via: "chat", login: "boss" }, spec: DIRECT() }, T - 2 * 3600 * 1000);
  await OA.check();
  const o2 = (await OQ.recent(20)).find((x) => x.id === old.id);
  assert.equal(o2.status, "failed");
  assert.match(o2.why, /more than an hour ago/);
  const refusedRow = (await getQuery("SELECT what, detail FROM onair_log WHERE what = 'refused' ORDER BY id DESC LIMIT 1"))[0];
  assert.match(refusedRow.detail, /"code":"owner"/);
});

test("SAFETY-4: ⛔ Cut + block (web, chat), the recent list's Block, and an image-safety 'fn' mark all take the picture down for good", async () => {
  await runQuery("DELETE FROM onair_attempts");
  await pepe();
  await OA.setMedia(await picture("main", { colour: "#a1a" }), "web:boss");
  const f1 = OA.view().target.media.asset.file;
  let r = await post("Staff", { action: "off", lane: "main", block: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.target, null);
  assert.equal(await M.assetFile(f1), null, "never served again");
  assert.equal((await getQuery("SELECT status FROM onair_media WHERE file = ?", [f1]))[0].status, "blocked");
  assert.ok((await getQuery("SELECT 1 FROM onair_log WHERE what = 'blocked'")).length);
  assert.match((await getQuery("SELECT detail FROM admin_audit WHERE action = 'onair' ORDER BY id DESC LIMIT 2")).map((x) => x.detail).join(" "), /"action":"block"/);
  await assert.rejects(asset("#a1a"), (e) => e.code === "blocked", "the same picture again: refused (its hash), no vision call");
  // chat: !onair off corner block
  await OA.setMedia(await picture("corner", { colour: "#b2b" }), "web:boss");
  const f2 = OA.view().overlay.media.asset.file;
  r = await chat({ action: "off", query: "corner block" });
  assert.match(r.msg, /Cut and blocked: 1 stored picture/);
  assert.equal(OA.view().overlay, null);
  assert.equal(await M.assetFile(f2), null);
  assert.match((await chat({ action: "off", query: "sideways" })).msg, /usage/);
  // the recent list (staff) -> Block: off air wherever it shows, queued copies cancelled
  await OA.setMedia(await picture("main", { colour: "#c3c" }), "web:boss");
  const a3 = OA.view().target.media.asset;
  const view = await fetch(base + "/api/stage/admin/onair", { headers: H("Staff") }).then((x) => x.json());
  assert.ok(view.media.recent.some((x) => x.id === a3.id && x.file === a3.file), "listed with its file");
  assert.equal(view.media.can.block, true);
  const q3 = await OQ.add({ kind: "media", label: "🖼 again", by: "web:n-Staff", owner: { via: "web", userId: "u-Staff" }, spec: await picture("corner", { colour: "#c3c" }), at: T + 3600e3 });
  r = await post("Staff", { action: "media_block", asset: a3.id });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.target, null, "off air");
  assert.equal((await OQ.recent(20)).find((x) => x.id === q3.id).status, "cancelled");
  // an image-safety "fn" mark on an on-air check blocks that picture (and takes it off)
  await OA.setMedia(await picture("main", { colour: "#d4d" }), "web:boss");
  const a4 = OA.view().target.media.asset;
  const logId = (await getQuery("SELECT safety_log FROM onair_media WHERE id = ?", [a4.id]))[0].safety_log;
  assert.ok(logId);
  await ISF.review(logId, "fn", "boss");
  assert.equal(OA.view().target, null);
  assert.equal(await M.assetFile(a4.file), null);
  assert.equal((await getQuery("SELECT status FROM onair_media WHERE id = ?", [a4.id]))[0].status, "blocked");
});

test("SAFETY-5: refused jobs are audited (onair_log 'refused' + the safety check; admin_audit from the web); a linked chat login is its account", async () => {
  await runQuery("DELETE FROM onair_attempts");
  await runQuery("DELETE FROM onair_person_blocks");
  await staffRow("Staff");
  await pepe();
  ANSWER = { verdict: "nsfw", scores: { nudity_explicit: 0.9, sexual: 0.5, suggestive: 0.5, minor_risk: 0, gore: 0, hate_symbols: 0 } };
  const u1 = await freshPng("/nsfw-1.png", "#e1e");
  let r = await jobDone(await OA.botCommand({ by: "staffcf", admin: true, staff: true, action: "media", mode: "image", words: [u1, "rights"] }), "staffcf");
  assert.equal(r.ok, false);
  const lr = (await getQuery("SELECT by, detail, url FROM onair_log WHERE what = 'refused' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(lr.by, "pepe:staffcf");
  assert.match(lr.detail, /"code":"unsafe"/);
  assert.match(lr.detail, /"safety_log":\d+/);
  assert.equal(lr.url, u1);
  const sl = (await getQuery("SELECT ref, src, user_id FROM image_safety_log WHERE surface = 'onair' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([sl.ref, sl.src, sl.user_id], ["onair:pepe:staffcf", u1, "u-Staff"], "who + where from + the linked account");
  assert.equal((await getQuery("SELECT who FROM onair_attempts ORDER BY id DESC LIMIT 1"))[0].who, "u:u-Staff");
  // from the web: + admin_audit
  const u2 = await freshPng("/nsfw-2.png", "#e2e");
  r = await post("Staff", { action: "media", mode: "image", url: u2, rights: true });
  const j2 = r.status === 422 ? r.d.job : await webDone(r);
  assert.equal(j2.state, "refused");
  assert.match((await getQuery("SELECT detail FROM admin_audit WHERE action = 'onair' ORDER BY id DESC LIMIT 1"))[0].detail, /"action":"refused".*"code":"unsafe"/);
  // the third unsafe one (chat or web - one person) blocks them for 24 h
  const u3 = await freshPng("/nsfw-3.png", "#e3e");
  r = await jobDone(await OA.botCommand({ by: "staffcf", admin: true, staff: true, action: "media", mode: "image", words: [u3, "rights"] }), "staffcf");
  assert.match(r.msg, /can't put pictures or links on Pepe's stream right now/);
  ANSWER = { verdict: "allow", scores: { nudity_explicit: 0.01, sexual: 0.01, suggestive: 0.05, minor_risk: 0, gore: 0, hate_symbols: 0 } };
  r = await post("Staff", { action: "media", mode: "image", url: await freshPng("/ok-1.png", "#1e1"), rights: true });
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "person_blocked");
  const adm = await fetch(base + "/api/stage/admin/onair", { headers: H("Admin") }).then((x) => x.json());
  assert.ok(adm.media.blocked_people.some((p) => p.who === "u:u-Staff"));
  assert.equal((await post("Staff", { action: "media_unblock_person", who: "u:u-Staff" })).status, 403, "lifting is for the settings holders");
  assert.equal((await post("Admin", { action: "media_unblock_person", who: "u:u-Staff" })).status, 200);
  // one rate bucket per person: chat (linked login) + web together
  await runQuery("DELETE FROM onair_attempts");
  await OA.saveConfig({ media_per_10min: 2 }, "test");
  try {
    await webDone(await post("Staff", { action: "media", mode: "image", url: await freshPng("/ok-2.png", "#2e2"), rights: true }));
    await jobDone(await OA.botCommand({ by: "staffcf", admin: true, staff: true, action: "media", mode: "image", words: [await freshPng("/ok-3.png", "#3e3"), "rights"] }), "staffcf");
    r = await post("Staff", { action: "media", mode: "image", url: await freshPng("/ok-4.png", "#4e4"), rights: true });
    assert.equal(r.status, 429);
    assert.match(r.d.error, /at most 2 every 10 minutes/);
  } finally { await OA.saveConfig({ media_per_10min: 8 }, "test"); await runQuery("DELETE FROM onair_attempts"); }
});

test("CORRECT-7: the go-live answer carries the full media view (the Image / Link tabs keep 'Load directly' and 'Live page')", async () => {
  await staffRow("Staff");
  await pepe();
  const r = await post("Staff", { action: "golive", minutes: 30, title: "test" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(r.d.golive);
  assert.deepEqual([r.d.media.can.direct, r.d.media.can.live], [true, true]);
});
