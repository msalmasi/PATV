// 1.99kk: the homepage banner slot (banner.js) - paid PAT bookings (hold -> approve routes / reject refunds), house
// promos with the live Pepeball jackpot, aggregate stats, the picture pipeline, links, the views.
//   NODE_PATH=G:/PATV/node_modules node --test test/banner.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "banner-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const BN = require(path.join(repo, "banner"));
const F = require(path.join(repo, "funding"));

// 2026-10-10 12:00 New York (16:00 UTC) - a Saturday
let t = Date.UTC(2026, 9, 10, 16);
BN._setClock(() => t);
BN._setDir(path.join(tmp, "bn"));
let SAFE = { ok: true };
BN.setSafetyCheck(async () => SAFE);
const U = {};
const users = new Map();
async function mk(name, bal = 10000000, cls = "pleb") {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?)", ["u-" + name, name, name, cls, bal]);
  U[name] = { userId: "u-" + name, username: name, class: cls };
  users.set(U[name].userId, U[name]);
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
let base, server;
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, headers: r.headers };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await mk("ann"); await mk("bob"); await mk("poor", 10); await mk("staff", 0, "Staff"); await mk("boss", 0, "Admin");
  await BN.init();
  const app = express();
  app.use((req, res, next) => (req.is("application/json") ? express.json()(req, res, next) : next()));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  BN.register(app, { addUser, noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); F.sync({}); });

test("days are New York calendar days; links: https or a site path only", () => {
  assert.equal(BN.dayKey(t), "2026-10-10");
  assert.equal(BN.dayKey(Date.UTC(2026, 9, 11, 3, 59)), "2026-10-10", "11:59 pm in New York");
  assert.equal(BN.dayStart("2026-10-11"), Date.UTC(2026, 9, 11, 4), "EDT midnight");
  assert.equal(BN.dayStart("2026-11-02"), Date.UTC(2026, 10, 2, 5), "EST midnight");
  assert.equal(BN.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(BN.cleanLink("https://example.com/x?y=1"), "https://example.com/x?y=1");
  assert.equal(BN.cleanLink("/p/plants"), "/p/plants");
  assert.equal(BN.cleanLink(""), null);
  for (const bad of ["javascript:alert(1)", "//evil.com", "/\\evil.com", "data:text/html,x", "https://u:p@x.com", "ftp://x.com", "/a b"]) {
    assert.throws(() => BN.cleanLink(bad), /link|Links/, bad);
  }
});

test("ships enabled with paid booking OFF and the proposed price; booking is refused while it's off", async () => {
  const C = BN.config();
  assert.equal(C.enabled, true);
  assert.equal(C.paid_enabled, false);
  assert.equal(C.price_per_day, 1000000);
  assert.equal(C.max_days, 7);
  assert.equal(C.max_bookings, 2);
  await assert.rejects(BN.book(U.ann, { start: "2026-10-11", days: 1, kind: "text", headline: "Hi", ref: ref() }), /aren't open yet/);
  const r = await call("POST", "/api/banner/book", U.ann, { start: "2026-10-11", days: 1, kind: "text", headline: "Hi", ref: ref() });
  assert.equal(r.status, 423);
  const s = BN.settingsView();
  assert.equal(s.banner_chat_sponsor, false, "1.99qr: the chat-sponsor switch ships off");
  assert.equal(s.banner_chat_sponsor_mic, true, "1.99tc: once on, Pepe also speaks it (mic mode default on)");
  assert.deepEqual(Object.keys(s).sort(), ["banner_chat_sponsor", "banner_chat_sponsor_mic", "banner_enabled", "banner_lead_days", "banner_max_bookings", "banner_max_days", "banner_paid_enabled", "banner_price_per_day"]);
  // the routing row: 100% Fort Knox
  assert.deepEqual(require(path.join(repo, "premium")).DEFAULTS.routes.banner, [["fortknox", 100]]);
});

let B1;
test("booking holds the whole price once; days are exclusive; limits; not enough PAT", async () => {
  await BN.setConfig({ banner_paid_enabled: true }, "test");
  const before = await bal(U.ann);
  const r1 = ref();
  const a = await BN.book(U.ann, { start: "2026-10-11", days: 2, kind: "text", headline: "  Visit <my> pad  ", line: "plants", link: "/p/plants", ref: r1 });
  B1 = a.booking;
  assert.equal(B1.status, "pending");
  assert.equal(B1.headline, "Visit <my> pad");
  assert.equal(B1.end, "2026-10-12");
  assert.equal(await bal(U.ann), before - 2000000);
  const again = await BN.book(U.ann, { start: "2026-10-11", days: 2, kind: "text", headline: "x", ref: r1 });
  assert.equal(again.dup, true);
  assert.equal(await bal(U.ann), before - 2000000, "a replayed ref charges once");
  await assert.rejects(BN.book(U.bob, { start: "2026-10-12", days: 1, kind: "text", headline: "x", ref: ref() }), /2026-10-12 is already booked/);
  assert.equal(await bal(U.bob), 10000000, "nothing charged");
  await assert.rejects(BN.book(U.bob, { start: "2026-10-10", days: 1, kind: "text", headline: "x", ref: ref() }), /tomorrow at the earliest/);
  await assert.rejects(BN.book(U.bob, { start: "2026-10-20", days: 8, kind: "text", headline: "x", ref: ref() }), /1 to 7 days/);
  await assert.rejects(BN.book(U.bob, { start: "2027-01-01", days: 1, kind: "text", headline: "x", ref: ref() }), /60 days ahead/);
  await assert.rejects(BN.book(U.bob, { start: "2026-10-20", days: 1, kind: "text", headline: "", ref: ref() }), /headline/);
  await assert.rejects(BN.book(U.bob, { start: "2026-10-20", days: 1, kind: "text", headline: "x", link: "javascript:alert(1)", ref: ref() }), /Links/);
  await assert.rejects(BN.book(U.poor, { start: "2026-10-20", days: 1, kind: "text", headline: "x", ref: ref() }), /don't have enough/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM banner_days WHERE day = '2026-10-20'"))[0].n, 0, "the failed booking held no day");
  await BN.book(U.ann, { start: "2026-10-20", days: 1, kind: "text", headline: "second", ref: ref() });
  await assert.rejects(BN.book(U.ann, { start: "2026-10-25", days: 1, kind: "text", headline: "third", ref: ref() }), /2 banner bookings open/);
  const cal = await BN.calendar();
  assert.equal(cal[0].day, "2026-10-10");
  assert.equal(cal[0].bookable, false);
  assert.equal(cal.find((d) => d.day === "2026-10-11").taken, true);
  assert.equal(cal.find((d) => d.day === "2026-10-13").bookable, true);
});

test("cancel (pending) and reject both refund in full and free the days; approve routes the hold to Fort Knox", async () => {
  const before = await bal(U.ann);
  const mine = await BN.mine(U.ann.userId);
  const second = mine.find((b) => b.headline === "second");
  const r = await call("POST", `/api/banner/bookings/${second.id}/cancel`, U.ann, {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.booking.status, "cancelled");
  assert.equal(await bal(U.ann), before + 1000000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM banner_days WHERE booking_id = ?", [second.id]))[0].n, 0);
  assert.equal((await call("POST", `/api/banner/bookings/${second.id}/cancel`, U.ann, {})).status, 409, "only once");
  assert.equal((await call("POST", `/api/banner/bookings/${B1.id}/cancel`, U.bob, {})).status, 404, "not yours");
  // bob books, staff reject with a reason: full refund + a notice
  const bb = (await BN.book(U.bob, { start: "2026-10-14", days: 3, kind: "text", headline: "bob's", ref: ref() })).booking;
  assert.equal(await bal(U.bob), 7000000);
  assert.equal((await call("POST", "/api/banner/admin/decide", U.ann, { id: bb.id, approve: false, reason: "no" })).status, 403, "members can't decide");
  assert.equal((await call("POST", "/api/banner/admin/decide", U.staff, { id: bb.id, approve: false })).status, 400, "a reason is needed");
  const rej = await call("POST", "/api/banner/admin/decide", U.staff, { id: bb.id, approve: false, reason: "Off-topic link." });
  assert.equal(rej.status, 200, rej.text);
  assert.equal(rej.d.booking.status, "rejected");
  assert.equal(await bal(U.bob), 10000000, "refunded in full");
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.bob.userId, "banner-no:" + bb.id]);
  assert.equal(n.length, 1);
  assert.match(n[0].body, /Off-topic link\./);
  assert.equal((await call("POST", "/api/banner/admin/decide", U.staff, { id: bb.id, approve: true })).status, 409, "decided already");
  // approve ann's: routed through the "banner" row (Fort Knox, or the Reserve as its stand-in) - nothing else moves
  const claimsBefore = (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n;
  const ok = await call("POST", "/api/banner/admin/decide", U.staff, { id: B1.id, approve: true });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.d.booking.status, "approved");
  const cl = await getQuery("SELECT flow, amount FROM reserve_claims ORDER BY rowid DESC LIMIT 1");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n, claimsBefore + 1);
  assert.ok(cl[0].flow === "banner" || cl[0].flow === "fortknox:banner", cl[0].flow);
  assert.equal(cl[0].amount, -2000000);
  assert.equal((await call("POST", `/api/banner/bookings/${B1.id}/cancel`, U.ann, {})).status, 409, "approved can't be cancelled");
});

test("what shows: the paid banner on its days, house promos (live Pepeball jackpot) otherwise; stats are aggregate and deduplicated", async () => {
  const lotto = { jackpot: 20812345, next_at: Math.floor(Date.UTC(2026, 9, 12, 1) / 1000) };     // Sunday 9 pm New York
  assert.equal(BN.drawLabel(lotto.next_at, "en"), "Sunday 9 PM ET");
  assert.equal(BN.compact(lotto.jackpot), "20.8M");
  // today (the 10th): nobody booked -> house promos rotate, Pepeball first by order
  const seen = new Set();
  for (let i = 0; i < 20; i++) { const p = await BN.pick({ lotto }); assert.equal(p.paid, false); seen.add(p.promo); }
  assert.deepEqual([...seen].sort(), ["lotto", "plex", "prime_time", "season_pass", "wheel"]);
  let p;
  do { p = await BN.pick({ lotto }); } while (p.promo !== "lotto");
  assert.deepEqual(p.vars, { jackpot: "20.8M", draw: "Sunday 9 PM ET", jackpot_n: 20812345, next_at: lotto.next_at, sold: 0 });
  assert.equal(p.href, "/b/go/h/lotto");
  // no jackpot known -> the Pepeball promo sits out
  for (let i = 0; i < 12; i++) assert.notEqual((await BN.pick({ lotto: null })).promo, "lotto");
  // the 11th: ann's approved banner
  t = Date.UTC(2026, 9, 11, 14);
  p = await BN.pick({ lotto });
  assert.equal(p.paid, true);
  assert.equal(p.ad, "b:" + B1.id);
  assert.equal(p.headline, "Visit <my> pad");
  assert.equal(p.by, "ann");
  assert.equal(p.href, "/b/go/b/" + B1.id);
  // impressions + clicks: once per viewer per day
  for (let i = 0; i < 3; i++) assert.equal((await call("POST", "/api/banner/seen", U.bob, { ad: p.ad })).status, 200);
  await call("POST", "/api/banner/seen", null, { ad: p.ad });
  const go = await call("GET", "/b/go/b/" + B1.id, U.bob);
  assert.equal(go.status, 302);
  assert.equal(go.headers.get("location"), "/p/plants");
  await call("GET", "/b/go/b/" + B1.id, U.bob);
  const S = (await BN.statsFor(["b:" + B1.id])).get("b:" + B1.id);
  assert.equal(S.impressions, 2, "bob once + one signed-out visitor");
  assert.equal(S.clicks, 1);
  assert.deepEqual(S.days, [{ day: "2026-10-11", impressions: 2, clicks: 1 }]);
  assert.equal((await call("POST", "/api/banner/seen", U.bob, { ad: "x'); drop" })).status, 200, "junk ids are ignored");
  assert.equal((await call("GET", "/b/go/b/nothere", U.bob)).headers.get("location"), "/");
  // the buyer sees them on /sponsor
  const mine = await BN.mine(U.ann.userId);
  assert.equal(mine.find((b) => b.id === B1.id).stats.impressions, 2);
  // the slot switched off: nothing shows
  await BN.setConfig({ banner_enabled: false }, "test");
  assert.equal(await BN.pick({ lotto }), null);
  await BN.setConfig({ banner_enabled: true }, "test");
});

test("1.99kz: the Pepeball promo shows the lotto page's jackpot (lotto_state, uncapped)", async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS lotto_state (id INTEGER PRIMARY KEY, data TEXT, updated INTEGER)");
  await runQuery("INSERT OR REPLACE INTO lotto_state (id, data, updated) VALUES (1, ?, ?)",
                 [JSON.stringify({ draw: 2, next_at: 1791766800, sales_open: true, price: 1000, jackpot: 20982296, sold: 7572, prizes: [], players: {} }), Date.now()]);
  const home = require(path.join(repo, "home"));
  const S = await home.stats();
  assert.equal(S.lotto.jackpot, 20982296, "the full jackpot, not a 5M cap");
  assert.equal(S.lotto.sold, 7572);
  const t0 = t;
  t = Date.UTC(2026, 9, 10, 14);
  let p;
  do { p = await BN.pick({ lotto: S.lotto }); } while (p.promo !== "lotto");
  assert.equal(p.vars.jackpot_n, 20982296);
  assert.equal(p.vars.jackpot, "21M");
  assert.equal(p.vars.sold, 7572);
  const h = await ejs.renderFile(path.join(repo, "views", "partials", "banner.ejs"), { bn: p });
  assert.match(h, /20,982,296/);
  assert.match(h, /7,572<\/b> tickets sold/);
  t = t0;
});

test("1.99kz: the Support PATV house promo - seeded, shown only while a donation rail is on, with the live rate", async () => {
  const t0 = t;
  t = Date.UTC(2026, 9, 10, 14);                          // a day nobody booked
  const row = (await BN.promos({ all: true })).find((p) => p.id === "support");
  assert.ok(row && row.enabled && row.link === "/support" && row.weight === 2, "seeded on, weight like the others");
  for (let i = 0; i < 20; i++) assert.notEqual((await BN.pick({})).promo, "support", "Stripe + crypto off: sits out");
  const keep = { e: process.env.STRIPE_ENABLED, k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  Object.assign(process.env, { STRIPE_ENABLED: "1", STRIPE_SECRET_KEY: "sk_test_banner", STRIPE_WEBHOOK_SECRET: "whsec_banner" });
  try {
    const seen = new Set();
    let sp = null;
    for (let i = 0; i < 30; i++) { const p = await BN.pick({ lotto: { jackpot: 1000000, next_at: Math.floor(t / 1000) + 86400 } }); seen.add(p.promo); if (p.promo === "support") sp = p; }
    assert.ok(seen.has("support") && seen.has("lotto") && seen.has("wheel"), "in rotation with Pepeball and the rest: " + [...seen]);
    assert.equal(sp.href, "/b/go/h/support");
    assert.equal(sp.vars.rate, "500,000");
    assert.equal(sp.vars.bonus, "20");
    const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
    assert.match(en["banner.promo.support.h"], /\{rate\} PAT per \$1/);
    assert.match(en["banner.promo.support.l"], /\{bonus\}% to the community pot/);
  } finally {
    for (const [k, v] of [["STRIPE_ENABLED", keep.e], ["STRIPE_SECRET_KEY", keep.k], ["STRIPE_WEBHOOK_SECRET", keep.w]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    t = t0;
  }
});

test("take down (no refund) and expiry of unreviewed bookings (full refund)", async () => {
  t = Date.UTC(2026, 9, 11, 15);
  const before = await bal(U.ann);
  const d = await call("POST", "/api/banner/admin/takedown", U.staff, { id: B1.id, reason: "Terms breach" });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.d.booking.status, "removed");
  assert.equal(await bal(U.ann), before, "no refund");
  assert.equal((await BN.pick({})).paid, false, "house promos again");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM banner_days WHERE day = '2026-10-12'"))[0].n, 0, "its later days are free again");
  const x = (await BN.book(U.bob, { start: "2026-10-13", days: 1, kind: "text", headline: "late", ref: ref() })).booking;
  assert.equal(await bal(U.bob), 9000000);
  t = Date.UTC(2026, 9, 13, 4, 30);     // 12:30 am on the 13th in New York
  assert.equal(await BN.expire(), 1);
  assert.equal((await BN.mine(U.bob.userId)).find((b) => b.id === x.id).status, "expired");
  assert.equal(await bal(U.bob), 10000000);
});

test("pictures: re-encoded to 1200x200 webp, safety-checked, only the uploader can book them; private until approved", async () => {
  const sharp = require("sharp");
  const png = await sharp({ create: { width: 900, height: 300, channels: 3, background: { r: 30, g: 160, b: 60 } } }).png().toBuffer();
  const up = await BN.storeImage(U.ann.userId, png);
  assert.match(up.image, /^[a-f0-9]{32}_s\.webp$/);
  const meta = await sharp(fs.readFileSync(BN.filePath(up.image))).metadata();
  assert.equal(meta.format, "webp"); assert.equal(meta.width, 1200); assert.equal(meta.height, 200);
  SAFE = { ok: false, reason: "That picture looks like adult or graphic content - Homepage banners must be safe for work (Terms)." };
  await assert.rejects(BN.storeImage(U.ann.userId, png), /safe for work/);
  SAFE = { ok: true };
  await assert.rejects(BN.storeImage(U.ann.userId, Buffer.from("<html><script>x</script></html>")), /Pictures only/);
  await assert.rejects(BN.book(U.bob, { start: "2026-10-20", days: 1, kind: "image", image: up.image, alt: "x", ref: ref() }), /Upload the picture/, "someone else's upload");
  await assert.rejects(BN.book(U.ann, { start: "2026-10-20", days: 1, kind: "image", image: up.image, alt: "", ref: ref() }), /alt text/);
  // signed-out visitors can't see a picture that isn't approved; its uploader can
  assert.equal((await call("GET", "/media/banner/" + up.image, null)).status, 404);
  assert.equal((await call("GET", "/media/banner/" + up.image, U.ann)).status, 200);
  const b = (await BN.book(U.ann, { start: "2026-10-20", days: 1, kind: "image", image: up.image, alt: "Green frog", link: "https://example.com", ref: ref() })).booking;
  assert.equal((await call("GET", "/media/banner/" + up.image, U.staff)).status, 200, "staff review it");
  assert.equal((await call("GET", "/media/banner/" + up.image, null)).status, 404);
  await BN.decide(U.staff, b.id, true);
  const pub = await call("GET", "/media/banner/" + up.image, null);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get("content-type"), "image/webp");
  assert.equal(pub.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await call("GET", "/media/banner/..%2Fx", null)).status, 404);
});

test("the views: banner partial (Sponsored + escaped text / From PATV + translated promo), /sponsor (closed and open), admin", async () => {
  const render = (bn) => ejs.renderFile(path.join(repo, "views", "partials", "banner.ejs"), { bn });
  t = Date.UTC(2026, 9, 20, 14);
  let p = await BN.pick({});
  let h = await render(p);
  assert.match(h, /Sponsored/);
  assert.match(h, /alt="Green frog"/);
  assert.match(h, /rel="sponsored noopener noreferrer"/);
  assert.match(h, /by @ann/);
  assert.match(h, /<div class="bn-foot">\s*<span class="bn-eb"><span class="bn-lbl">Sponsored<\/span><span>by @ann/, "a picture: label + credit under it, nothing drawn on it");
  t = Date.UTC(2026, 9, 21, 14);
  do { p = await BN.pick({ lotto: { jackpot: 20812345, next_at: Math.floor(Date.UTC(2026, 9, 26, 1) / 1000) } }); } while (p.promo !== "lotto");
  h = await render(p);
  assert.match(h, /From PATV/);
  // 1.99kz: the lotto card - the exact jackpot (counts up from it), the countdown, the draw time, the button
  assert.match(h, /class="bn hp k-lotto"/);
  assert.match(h, /Pepeball jackpot/);
  assert.match(h, /data-bn-count="20812345">20,812,345</);
  assert.match(h, /Sunday 9 PM ET/);
  assert.match(h, /Buy tickets/);
  assert.match(h, /prefers-reduced-motion: reduce/);
  // the other house promos: icon + call to action
  do { p = await BN.pick({}); } while (p.promo !== "wheel");
  h = await render(p);
  assert.match(h, /class="bn hp k-wheel"/);
  assert.match(h, /🎡<\/span>/);
  assert.match(h, />Spin the Wheel</, "headline without its emoji (the icon shows it)");
  assert.match(h, /Spin now/);
  // 1.99sw layout: the label is an eyebrow inside the text column (never a corner tag over the CTA); the CTA and
  // "Your banner here" share the side column, the link under the CTA; one stretched link covers the card
  assert.match(h, /<span class="bn-eb">\s*<span class="bn-lbl">From PATV<\/span>/);
  assert.match(h, /<a class="bn-a bn-tx" href="[^"]+">\s*<span class="bn-eb">/);
  assert.match(h, /<span class="bn-side">\s*<span class="bn-cta" aria-hidden="true">Spin now →<\/span>\s*<a class="bn-own" href="\/sponsor">Your banner here<\/a>/);
  assert.doesNotMatch(h, /bn-corner|class="bn-foot"/, "no corner tag, no separate footer on a text card");
  assert.match(h, /\.bn-in \{[^}]*max-width: 960px;[^}]*margin-inline: auto;/, "the row is centred");
  assert.match(h, /\.bn-in \{[^}]*align-items: center;/, "and vertically centred");
  // an admin's own text keeps the plain card
  h = await render({ ...p, headline: "Custom words", line: null });
  assert.doesNotMatch(h, /class="bn hp/);
  assert.match(h, /Custom words/);
  assert.match(h, /Your banner here/, "paid booking is on in this test");
  h = await render({ ad: "b:aaaaaaaaaaaa", paid: true, kind: "text", headline: "<script>x</script>", line: null, href: null, by: "z", vars: {} });
  assert.ok(h.includes("&lt;script&gt;x&lt;/script&gt;"));
  assert.match(h, /<div class="bn-a bn-tx">\s*<span class="bn-eb">\s*<span class="bn-lbl">Sponsored<\/span>\s*<span>by @z<\/span>/, "no link: a plain block, label + credit as the eyebrow");
  assert.doesNotMatch(h, /class="bn-side"/, "nothing to put in the side column");
  assert.doesNotMatch(h, /<script>x/);
  let r = await call("GET", "/sponsor", U.bob);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /Book the banner/);
  await BN.setConfig({ banner_paid_enabled: false }, "test");
  r = await call("GET", "/sponsor", U.bob);
  assert.match(r.text, /Booking opens soon/);
  assert.doesNotMatch(r.text, /id="spForm"/);
  r = await call("GET", "/admin/banner", U.staff);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /Review queue/);
  assert.equal((await call("GET", "/admin/banner", U.ann)).status, 403);
  // settings + promos are admin-only
  assert.equal((await call("POST", "/api/banner/admin/config", U.staff, { banner_price_per_day: 5 })).status, 403);
  const c = await call("POST", "/api/banner/admin/config", U.boss, { banner_price_per_day: 2500000, banner_max_days: 3 });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.d.config.price_per_day, 2500000);
  const pr = await call("POST", "/api/banner/admin/promo", U.boss, { kind: "custom", headline: "Movie night {draw}", link: "/p/movies", weight: 2 });
  assert.equal(pr.status, 200, pr.text);
  assert.equal(pr.d.promo.kind, "custom");
  assert.equal((await call("POST", "/api/banner/admin/promo", U.boss, { id: "wheel", enabled: false })).status, 200);
  assert.equal((await call("POST", "/api/banner/admin/promo/delete", U.boss, { id: "lotto" })).status, 400, "built-ins only switch off");
  assert.equal((await call("POST", "/api/banner/admin/promo/delete", U.boss, { id: pr.d.promo.id })).status, 200);
  for (let i = 0; i < 12; i++) assert.notEqual((await BN.pick({})).promo, "wheel");
});
