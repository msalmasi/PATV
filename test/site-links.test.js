// Offline tests for 1.99ta: pages that existed but had no way in now get links.
//   - the menus (More + ☰) list 🔊 Soundboards and 🗣️ Voice store under "Shop, sounds & support"
//   - the footer links the TAKE IT DOWN form (/takedown) next to the policies
//   - /cosmetics has a 🧸 Stickers tab: every listed pack with its previews, price, owned state and buy / claim / gift;
//     perk packs say which tier they come with (never a Buy button); My items points there for more packs
//   - Edit profile has a "Privacy & likeness" card (likeness opt-outs, your voice, clone your voice); the owner's
//     profile menu, /voices, /soundboards, the pad's 🔊 drawer and the create-a-pad page link the rest
//   NODE_PATH=G:/PATV/node_modules node --test test/site-links.test.js
//   LINKS_SHOTS=<dir> also writes the rendered stickers tab there (for screenshots)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-links-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STRIPE_ENABLED;
process.env.SECRET_KEY = "test-secret";

const express = require("express");
const ejs = require("ejs");
const { runQuery } = require(path.join(repo, "dbUtils"));
const PR = require(path.join(repo, "premium"));
const ST = require(path.join(repo, "stickers"));
const COS = require(path.join(repo, "cosmetics"));
const EN = require(path.join(repo, "locales", "en.json"));
const src = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

const U = {};
const users = new Map();
async function mkUser(name, { bal = 5000000, camfrog = null } = {}) {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', ?, ?)",
                 [id, name, name, bal, camfrog]);
  U[name] = { userId: id, username: name, class: "pleb" };
  users.set(id, U[name]);
  return U[name];
}
let base, server;
function req(method, url, { user, json } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Origin: base };
    if (user) h["x-test-user"] = user;
    let data = null;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const txt = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: txt }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, email TEXT, avatar TEXT, isEmailVerified INTEGER DEFAULT 0, xp INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await runQuery("CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, points INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, badgeId))");
  await PR.init();
  await ST.init();
  await mkUser("pb", { bal: 0 });
  await mkUser("fan", { camfrog: "fancf" });
  await mkUser("pal");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  COS.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  ST.register(app, { addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

// ── the menus + footer ──
const layout = path.join(repo, "views", "layout.ejs");
const renderLayout = (locals) => ejs.renderFile(layout, Object.assign({ title: "T", ogPath: "/cosmetics" }, locals));
const pop = (html, cls) => { const m = new RegExp('<details class="' + cls + '">[\\s\\S]*?</details>').exec(html); assert.ok(m, cls); return m[0]; };
const hrefs = (html) => [...html.matchAll(/<a href="([^"]*)" class="nav-link/g)].map((m) => m[1]);

test("More and ☰ list Soundboards and the voice store in the shop section, signed in or out", async () => {
  for (const locals of [{}, { user: "fan" }]) {
    const html = await renderLayout(locals);
    for (const [cls, pre] of [["nav-more", "nm"], ["nav-burger", "nb"]]) {
      const p = pop(html, cls);
      const sec = new RegExp('aria-labelledby="' + pre + '-shop"[^]*?</div></div>').exec(p);
      assert.ok(sec, cls + " has the shop section");
      const h = hrefs(sec[0]);
      for (const want of ["/shop", "/premium", "/cosmetics", "/soundboards", "/voices"]) assert.ok(h.includes(want), cls + " shop section has " + want);
      assert.ok(h.indexOf("/soundboards") > h.indexOf("/cosmetics"), "after Cosmetics");
    }
    assert.match(html, /id="nm-shop">Shop, sounds &amp; support</);
  }
  assert.equal(EN["nav.sec_shop"], "Shop, sounds &amp; support");
});

test("the footer links /takedown next to the policies", async () => {
  const html = await renderLayout({});
  const foot = /<nav aria-label="Site policies">[\s\S]*?<\/nav>/.exec(html);
  assert.ok(foot, "policies row");
  assert.match(foot[0], /<a href="\/terms#reporting">[^<]*<\/a>\s*(<%#[^%]*%>\s*)?<a href="\/takedown">Remove intimate images<\/a>/);
});

// ── /cosmetics → 🧸 Stickers ──
test("the Stickers tab, signed out: every listed pack with previews and prices, perk packs tagged, a sign-in prompt, no buttons", async () => {
  const r = await req("GET", "/cosmetics?tab=stickers");
  assert.equal(r.status, 200);
  assert.match(r.text, /<a href="\/cosmetics\?tab=stickers#tabs" class="ds-tab on" aria-current="page"><span class="ds-ic" aria-hidden="true">🧸<\/span> Stickers<\/a>/);
  const packs = ST.catalog();
  assert.ok(packs.length >= 6);
  for (const p of packs) {
    assert.match(r.text, new RegExp('data-stk-pack="' + p.id + '"'), p.id + " listed");
    for (const s of p.stickers) assert.ok(r.text.includes('src="' + s.url + '"'), p.id + "/" + s.id + " preview");
  }
  assert.match(r.text, /<a href="\/login\?next=%2Fcosmetics%3Ftab%3Dstickers">Sign in<\/a> to buy or gift a pack\./);
  assert.doesNotMatch(r.text, /data-stk="/, "no buy buttons signed out");
  assert.doesNotMatch(r.text, /data-stk-gift="/, "no gift forms signed out");
  const plus = packs.find((p) => p.perk === "prime_plus");
  if (plus) assert.match(r.text, new RegExp('data-stk-pack="' + plus.id + '"[^]*?<a class="ds-tag ac cxs-perk" href="/premium#plus">💎 Comes with Prime Time Plus</a>'));
  assert.match(r.text, /<script src="\/public\/js\/cos-stickers\.js\?v=1" defer><\/script>/);
  if (process.env.LINKS_SHOTS) fs.writeFileSync(path.join(process.env.LINKS_SHOTS, "cos-stickers-out.html"), r.text);
});

test("the Stickers tab, signed in: owned packs say so and drop Buy; others can be bought or gifted; perk packs never sold", async () => {
  const first = ST.catalog().find((p) => !p.perk);
  const b = await req("POST", "/api/stickers/buy", { user: U.fan.userId, json: { pack: first.id, ref: "links-test-buy-1" } });
  assert.equal(b.status, 200, b.text);
  const r = await req("GET", "/cosmetics?tab=stickers", { user: U.fan.userId });
  assert.equal(r.status, 200);
  const card = (id) => { const m = new RegExp('<div class="cxp-card cxs-pack[^"]*"[^>]*data-stk-pack="' + id + '">[^]*?(?=<div class="cxp-card cxs-pack|</div>\\s*</div>\\s*<p class="cxp-muted">)').exec(r.text); assert.ok(m, id + " card"); return m[0]; };
  const mine = card(first.id);
  assert.match(mine, /cxs-pack owned/);
  assert.match(mine, /✅ yours/);
  assert.doesNotMatch(mine, /data-stk="/, "no Buy for a pack you own");
  assert.match(mine, new RegExp('<form class="cxp-row" data-stk-gift="' + first.id + '"'), "still giftable");
  for (const p of ST.catalog()) {
    const c = card(p.id);
    if (p.perk) {
      assert.doesNotMatch(c, /data-stk=|data-stk-gift=/, p.id + ": perk packs are never sold");
      assert.match(c, p.perk === "prime_plus" ? /Comes with Prime Time Plus/ : /Comes with a Season Pass/);
    } else if (p.id !== first.id) {
      assert.match(c, new RegExp('<button type="button" class="ds-btn gold sm" data-stk="' + p.id + '" data-price="' + p.price + '">Buy</button>'));
      assert.ok(c.includes(Number(p.price).toLocaleString("en-US") + " PAT"), p.id + " price");
    }
  }
  if (process.env.LINKS_SHOTS) fs.writeFileSync(path.join(process.env.LINKS_SHOTS, "cos-stickers-in.html"), r.text);
  // a gift from the tab's API call lands on the recipient
  const g = await req("POST", "/api/stickers/buy", { user: U.fan.userId, json: { pack: first.id, ref: "links-test-gift-1", to: "pal" } });
  assert.equal(g.status, 200, g.text);
  assert.ok((await ST.ownedPacks(U.pal.userId)).has(first.id));
});

test("My items points at the Stickers tab; an unknown tab still falls back to the shop", async () => {
  const r = await req("GET", "/cosmetics?tab=mine", { user: U.fan.userId });
  assert.match(r.text, /<a href="\/cosmetics\?tab=stickers#tabs">More packs<\/a>/);
  const s = await req("GET", "/cosmetics?tab=nope");
  assert.match(s.text, /class="ds-tab on" aria-current="page"><span class="ds-ic" aria-hidden="true">🛍️<\/span> Shop/);
});

test("cos-stickers.js: the buy API, defaults that match en.json", () => {
  const js = src("public", "js", "cos-stickers.js");
  assert.match(js, /fetch\('\/api\/stickers\/buy'/);
  for (const [k, d] of [...js.matchAll(/_t\('([^']+)', '([^']*)'/g)].map((m) => [m[1], m[2]])) {
    assert.equal(EN[k], d, k + " default equals en.json");
  }
  for (const k of ["cos.stk.tab", "cos.stk.heading", "cos.stk.signin", "cos.stk.buy", "cos.stk.gift_summary", "cos.stk.gift_to", "cos.stk.foot"]) assert.ok(EN[k], k);
});

// ── voices, likeness, owner guide ──
test("the likeness opt-outs, your voice and clone your voice are linked from Settings -> Privacy & likeness (1.99vz: their one way in)", async () => {
  // 1.99vz: Edit profile's Privacy & likeness card moved to the /settings hub (one home per setting)
  assert.doesNotMatch(src("views", "editProfile.ejs"), /id="privacy"/);
  const HUB = require(path.join(repo, "settingshub"));
  const secs = await HUB.hub({ userId: U.fan.userId, username: "fan" }, {});
  const priv = secs.find((s) => s.id === "privacy").entries.map((e) => e.href);
  for (const h of ["/settings/likeness", "/voices/mine", "/voices/clone"]) assert.ok(priv.includes(h), h);
});

test("the owner's profile menu, /voices, /soundboards, the pad drawer and create-a-pad link the unlinked pages", () => {
  const prof = src("views", "profile.ejs");
  const menu = /<% if \(isMe\) \{ %>[\s\S]*?<\/form>/.exec(prof)[0];
  assert.ok(menu.includes('href="/settings"'), "profile menu: Settings (1.99vz: voice / clone / likeness live there)");
  const voices = src("views", "voices.ejs");
  assert.match(voices, /<% if \(locals\.cloneOn\) \{ %><a class="ds-btn" href="\/voices\/clone">/);
  assert.match(src("voicestore.js"), /mine: null, cloneOn: cloneOn\(\)/);
  const sb = src("views", "soundboards.ejs");
  assert.match(sb, /<a class="ds-btn ghost" href="\/voices">/);
  assert.match(sb, /<a class="ds-btn ghost" href="\/cosmetics">/);
  const drawer = src("public", "js", "pad-soundboard.js");
  assert.match(drawer, /av\.href = '\/voices'/);
  assert.equal(EN["js.sbd.voices"], "Voices");
  assert.match(src("views", "room.ejs"), /pad-soundboard\.js\?v=\d+/);
  assert.match(src("views", "padCreate.ejs"), /<a href="\/pads\/owner-guide">/);
});

test("the owner panel stays one click from the pad header for whoever can manage the pad", () => {
  const room = src("views", "room.ejs");
  // 1.99vm: every pad has an owner panel (its vault, payouts, stage) - not only Camfrog pads
  assert.match(room, /<% if \(manage_\) \{ %><a class="ds-btn sm gold po-link po-cta" href="\/p\/<%= encodeURIComponent\(room\.slug\) %>\/owner"/);
  // 1.99ti: a labelled button ("Manage your pad" for the owner) + an Owner tab in the pad's tab bar
  assert.match(room, /isOwner_ \? t\('pad\.manage_pad'\) : t\('pad\.owner_panel'\)/);
  assert.match(room, /<a class="ptab ptab-owner" href="\/p\/<%= encodeURIComponent\(room\.slug\) %>\/owner">/);
});
