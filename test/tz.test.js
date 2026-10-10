// Time zones (1.99jx, tz.js / tz-core.js / public/js/localtime.js): every time in the viewer's zone with its label.
// Saved choice (Edit profile -> Time zone, user_timezone table) > the browser's zone (patv_tz cookie) > UTC.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tz-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const cookieParser = require("cookie-parser");
const ejs = require("ejs");
const { getQuery } = require(path.join(repo, "dbUtils"));
const tz = require(path.join(repo, "tz"));
const makeTz = require(path.join(repo, "tz-core"));

const CLOSES = 1791654775;     // Sat Oct 10 2026 17:52:55 UTC

test("zone names: canonical IANA spelling, UTC aliases, garbage refused", () => {
  assert.equal(tz.valid("america/new_york"), "America/New_York");
  assert.equal(tz.valid("Europe/London"), "Europe/London");
  for (const u of ["UTC", "utc", "Etc/UTC", "GMT", "Zulu"]) assert.equal(tz.valid(u), "UTC", u);
  for (const bad of ["", "Not/AZone", "<script>", "America/New_York\"><b>", "x".repeat(80), null]) assert.equal(tz.valid(bad), null, String(bad));
  assert.ok(tz.zones().length > 300 && tz.zones()[0] === "UTC");
});

test("formatting: every style but 'date'/'day' carries the zone's label; seconds, ms, Date and ISO all work", () => {
  const ny = makeTz("America/New_York", "en");
  assert.equal(ny.fmt(CLOSES, "full"), "Sat, Oct 10, 1:52 PM EDT");
  assert.equal(ny.fmt(CLOSES * 1000, "datetime"), "Oct 10, 1:52 PM EDT");
  assert.equal(ny.fmt(new Date(CLOSES * 1000), "long"), "Oct 10, 2026, 1:52 PM EDT");
  assert.equal(ny.fmt("2026-10-10 17:52:55", "time"), "1:52 PM EDT", "a SQLite UTC timestamp");
  assert.equal(ny.fmt("2026-10-10T17:52:55.000Z", "day"), "Sat, Oct 10, 2026");
  assert.equal(makeTz("UTC", "en").fmt(CLOSES, "full"), "Sat, Oct 10, 5:52 PM UTC");
  assert.equal(makeTz("Asia/Kolkata", "en").fmt(CLOSES, "time"), "11:22 PM GMT+5:30");
  assert.match(makeTz("Europe/Berlin", "de").fmt(CLOSES, "datetime"), /^10\. Okt\., 19:52 MESZ$/);
  assert.equal(ny.fmt(null), "");
  assert.equal(ny.fmt("nonsense"), "");
  const tag = ny.time(CLOSES, "full", "x");
  assert.equal(tag, '<time datetime="2026-10-10T17:52:55.000Z" data-tz="full" title="2026-10-10 17:52:55 UTC" class="x">Sat, Oct 10, 1:52 PM EDT</time>');
});

test("tz-core works as a view's fallback body (new Function), like i18n-core", () => {
  const src = fs.readFileSync(path.join(repo, "tz-core.js"), "utf8");
  assert.doesNotMatch(src, /<%|%>/, "no EJS tags in a file views include");
  const mk = new Function(src)();
  assert.equal(mk("UTC", "en").fmt(CLOSES, "time"), "5:52 PM UTC");
});

let base, server;
test.before(async () => {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  app.use(cookieParser());
  const uid = (req) => req.get("x-test-user") || null;
  app.use(tz.middleware(uid));
  tz.register(app, { addUser: (req, res, next) => { const u = uid(req); req.user = u ? { userId: u, username: u } : null; next(); } });
  app.get("/probe", (req, res) => res.json({ tz: res.locals.tz, pref: res.locals.tzPref, html: res.locals.tzTime(CLOSES, "full") }));
  await tz.ensure();
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());
const get = async (p, { user, cookie } = {}) => (await fetch(base + p, { headers: Object.assign({}, user ? { "x-test-user": user } : {}, cookie ? { cookie } : {}) })).json();
const post = async (body, user) => fetch(base + "/api/settings/timezone", { method: "POST",
  headers: Object.assign({ "content-type": "application/json" }, user ? { "x-test-user": user } : {}), body: JSON.stringify(body) });

test("no zone -> UTC; the browser's cookie -> that zone; a bad cookie -> UTC", async () => {
  let r = await get("/probe");
  assert.equal(r.tz, "UTC");
  assert.match(r.html, />Sat, Oct 10, 5:52 PM UTC</);
  r = await get("/probe", { cookie: "patv_tz=America%2FNew_York" });
  assert.equal(r.tz, "America/New_York");
  assert.match(r.html, />Sat, Oct 10, 1:52 PM EDT</);
  r = await get("/probe", { cookie: "patv_tz=Mars%2FOlympus" });
  assert.equal(r.tz, "UTC");
});

test("Edit profile -> Time zone: saved per user, beats the browser cookie; 'auto' clears it; junk refused", async () => {
  assert.equal((await post({ tz: "Asia/Tokyo" })).status, 401, "signed out");
  assert.equal((await post({ tz: "Nowhere/Land" }, "u-tz")).status, 400);
  const ok = await post({ tz: "asia/tokyo" }, "u-tz");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { success: true, tz: "Asia/Tokyo" });
  const rows = await getQuery("SELECT tz FROM user_timezone WHERE userId = ?", ["u-tz"]);
  assert.equal(rows[0].tz, "Asia/Tokyo", "persisted");
  let r = await get("/probe", { user: "u-tz", cookie: "patv_tz=America%2FNew_York" });
  assert.equal(r.tz, "Asia/Tokyo");
  assert.equal(r.pref, "Asia/Tokyo");
  assert.match(r.html, />Sun, Oct 11, 2:52 AM GMT\+9</);
  await post({ tz: "auto" }, "u-tz");
  r = await get("/probe", { user: "u-tz", cookie: "patv_tz=America%2FNew_York" });
  assert.equal(r.tz, "America/New_York");
  assert.equal(r.pref, "auto");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM user_timezone WHERE userId = ?", ["u-tz"]))[0].n, 0);
});

test("the layout hands the saved zone to localtime.js, which loads before page scripts", async () => {
  const html = await ejs.renderFile(path.join(repo, "views", "layout.ejs"), { title: "T", ogPath: "/", tzSaved: "Europe/Paris" });
  assert.match(html, /window\.PATV_TZ_SAVED = "Europe\/Paris";/);
  assert.match(html, /<script src="\/public\/js\/localtime\.js\?v=\d+"><\/script>/);
  const plain = await ejs.renderFile(path.join(repo, "views", "layout.ejs"), { title: "T", ogPath: "/" });
  assert.match(plain, /window\.PATV_TZ_SAVED = null;/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "localtime.js"), "utf8");
  assert.match(js, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/);
  assert.match(js, /patv_tz=/);
  assert.match(js, /time\[data-tz\]/);
  assert.match(js, /timeZoneName: 'short'/);
});

test("the Edit profile page has the Time zone picker next to Language", () => {
  const src = fs.readFileSync(path.join(repo, "views", "editProfile.ejs"), "utf8");
  assert.ok(src.indexOf('id="language"') < src.indexOf('id="timezone"') && src.indexOf('id="timezone"') < src.indexOf('id="avatar"'));
  assert.match(src, /<select id="tzSelect" name="tz">/);
  assert.match(src, /fetch\('\/api\/settings\/timezone'/);
});
