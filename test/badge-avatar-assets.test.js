// 1.99aek (S1 widget polish, the owner's "fix the smaller things"): the pictures a signed-in member's pages ask v1 for exist.
//   - every badge icon the hub's looks can carry (userlook.buildLooks: the 💚 Supporter tiers, Pepe's bot badge, a showcased
//     achievement) is a PNG v1 serves at the widget's address for it (`/public/img/<icon>.png`, chatwidget.js's assets base):
//     badges/supporter-{bronze,silver,gold}.png + badges/bot.png (tools/gen-badge-art.py) and /public/img/ach/<id>.png
//     (badgeicons.js: the achievement art under public/img/badges/ach/) - none of them existed, each line asked for a 404
//   - the default avatar is never the relative "avatar.png" (the users table's old column default): userlook.avatarSrc, the
//     nav's /api/u/<name>/profile, the nav script in layout.ejs, and a fresh database's column default
//   NODE_PATH=G:/PATV/node_modules node --test test/badge-avatar-assets.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "badge-avatar-test-"));
process.chdir(dir);
delete process.env.STAGING;
delete process.env.CHAT_GENESIS_NS;
process.env.SECRET_KEY = "test-secret";

const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));
const built = (async () => {                     // the real schema (a staging dump + every CREATE in the source)
  const db = new (require("sqlite3").Database)(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const express = require("express");
const ejs = require("ejs");
let runQuery, getQuery, UL, BI, base, server;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** {w, h, colorType} of a PNG file's IHDR, or null when it isn't one. */
function pngInfo(file) {
  const b = fs.readFileSync(file);
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIG) || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25], bytes: b.length };
}
const FRESH = "11111111-2222-4333-8444-5555555555a1";       // a fresh account: no avatar column -> the old default "avatar.png"
const DONOR = "11111111-2222-4333-8444-5555555555a2";       // a $100 donor (Supporter gold) showcasing an achievement
const PHOTO = "11111111-2222-4333-8444-5555555555a3";
const SHADY = "11111111-2222-4333-8444-5555555555a4";

test.before(async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  UL = require(path.join(repo, "userlook"));
  BI = require(path.join(repo, "badgeicons"));
  await require(path.join(repo, "huboutbox")).init();
  const add = (id, name, avatar) => (avatar === undefined
    ? runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', 'pleb')", [id, name, name])
    : runQuery("INSERT INTO users (userId, username, displayname, password, class, avatar) VALUES (?, ?, ?, 'x', 'pleb', ?)", [id, name, name, avatar]));
  await add(FRESH, "freshie");
  await add(DONOR, "donor", "/public/img/avatar.png");
  await add(PHOTO, "photo", "https://cdn.example/p/photo.webp");
  await add(SHADY, "shady", "//evil.example/x.png");
  await runQuery(`INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES ('don-a2', 'mint:donation', ?, 'mint', 1000000, '{"usd_cents":10000}')`, [DONOR]);
  await runQuery("INSERT INTO user_badges (userId, badgeId) VALUES (?, 'cf_donor_100')", [DONOR]);
  await runQuery("INSERT INTO user_badge_showcase (user_id, badges) VALUES (?, ?)", [DONOR, JSON.stringify(["cf_donor_100"])]);
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class) VALUES (?, 'Pepe', 'Pepe', 'x', 'Bot')", [UL.PEPE_ID]);

  const app = express();
  BI.register(app);                                                          // index.js's order: before the general /public
  app.use("/public", express.static(path.join(repo, "public")));
  require(path.join(repo, "userapi")).register(app, { addUser: (req, res, next) => next(), isBotToken: () => false });
  app.use((req, res) => res.status(404).send("not found"));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

// ── badges ──
test("every badge icon the looks can carry is a PNG v1 has (the supporter tiers, the bot badge, all 327 achievements)", () => {
  const keys = BI.iconKeys();
  assert.ok(keys.includes("badges/bot") && keys.includes("badges/supporter-gold") && keys.includes("badges/supporter-silver") &&
            keys.includes("badges/supporter-bronze"), "the four keys userlook builds");
  assert.ok(keys.filter((k) => k.startsWith("ach/")).length >= 300, "every achievement");
  const missing = keys.filter((k) => !BI.iconFile(k));
  assert.deepEqual(missing, [], "no icon without its file");
  for (const k of keys) assert.ok(pngInfo(BI.iconFile(k)), k + " is a PNG");
  // the four drawn by tools/gen-badge-art.py: 32 x 32 sprites at 4x, RGBA, small
  for (const n of ["supporter-bronze", "supporter-silver", "supporter-gold", "bot"]) {
    const i = pngInfo(path.join(repo, "public", "img", "badges", n + ".png"));
    assert.deepEqual([i.w, i.h, i.colorType], [128, 128, 6], n);
    assert.ok(i.bytes < 4096, n + " stays small: " + i.bytes);
  }
});

test("iconFile takes only the keys the widget would draw (chat-core badgeLooks' rule) and only files that exist", () => {
  for (const bad of ["", null, "../index", "badges/../../index", "ach/../../../index", "ach/", "/badges/bot", "Badges/bot", "badges//bot",
                     "badges/./bot", "badges/nope", "ach/nope", "badges/bot.png"]) {
    assert.equal(BI.iconFile(bad), null, String(bad));
  }
  assert.equal(BI.iconFile("ach/cf_donor"), path.join(repo, "public", "img", "badges", "ach", "cf_donor.png"));
  assert.equal(BI.iconFile("badges/supporter-gold"), path.join(repo, "public", "img", "badges", "supporter-gold.png"));
});

test("the looks userlook builds: a gold supporter's badges and Pepe's bot badge all resolve to files", async () => {
  const L = await UL.buildLooks([DONOR, UL.PEPE_ID]);
  const donor = L.get(DONOR), pepe = L.get(UL.PEPE_ID);
  assert.deepEqual(donor.badges.map((b) => b.icon), ["badges/supporter-gold", "ach/cf_donor_100"]);
  assert.deepEqual(pepe.badges.map((b) => b.icon), ["badges/bot"]);
  for (const b of [...donor.badges, ...pepe.badges]) assert.ok(BI.iconFile(b.icon), b.icon);
});

test("served where the widget asks: /public/img/<icon>.png (the achievement art at /public/img/ach/ too), nothing else", async () => {
  for (const icon of ["badges/supporter-bronze", "badges/supporter-silver", "badges/supporter-gold", "badges/bot", "ach/cf_donor", "ach/cf_donor_100"]) {
    const r = await fetch(base + "/public/img/" + icon + ".png");
    assert.equal(r.status, 200, icon);
    assert.equal(r.headers.get("content-type"), "image/png", icon);
    assert.ok(Buffer.from(await r.arrayBuffer()).equals(fs.readFileSync(BI.iconFile(icon))), icon + ": the same bytes");
  }
  for (const p of ["/public/img/ach/nope.png", "/public/img/ach/", "/public/img/ach", "/public/img/ach/%2e%2e/%2e%2e/%2e%2e/%2e%2e/index.js",
                   "/public/img/ach/..%2f..%2f..%2f..%2fbadgeicons.js"]) {
    const r = await fetch(base + p, { redirect: "manual" });
    assert.ok(r.status === 404 || r.status === 403, p + " -> " + r.status);
    assert.doesNotMatch(await r.text(), /require\(/, p + ": never source");
  }
});

// ── the default avatar ──
test("userlook.avatarSrc: the photo when it's safe, else the default as a site path - never relative, another host or nothing", () => {
  assert.equal(UL.DEFAULT_AVATAR, "/public/img/avatar.png");
  for (const v of ["avatar.png", "", null, undefined, "/public/img/avatar.png", "/img/avatar.png", "//evil.example/x.png", "javascript:alert(1)",
                   "http://cdn.example/x.png", "data:image/png;base64,AAAA", "../avatar.png", "/a/../b.png", "uploads/x.png", "/x y.png"]) {
    assert.equal(UL.avatarSrc(v), "/public/img/avatar.png", String(v));
  }
  assert.equal(UL.avatarSrc("https://cdn.example/p/photo.webp"), "https://cdn.example/p/photo.webp");
  assert.equal(UL.avatarSrc("/uploads/avatars/1001.webp"), "/uploads/avatars/1001.webp");
  assert.equal(UL.avatarOf("//evil.example/x.png"), null, "avatarOf never a protocol-relative URL (it would load from another site)");
});

test("GET /api/u/<name>/profile (the nav's picture): a fresh account's is /public/img/avatar.png, a photo stays, a bad value is the default", async () => {
  const row = (await getQuery("SELECT avatar FROM users WHERE userId = ?", [FRESH]))[0];
  assert.equal(row.avatar, "avatar.png", "precondition: a live database's old column default");
  const get = async (n) => { const r = await fetch(base + "/api/u/" + n + "/profile"); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
  assert.deepEqual((await get("freshie")).body, { username: "freshie", class: "pleb", displayname: "freshie", avatar: "/public/img/avatar.png" });
  assert.equal((await get("photo")).body.avatar, "https://cdn.example/p/photo.webp");
  assert.equal((await get("shady")).body.avatar, "/public/img/avatar.png");
  assert.equal((await get("nobody-here")).status, 404);
});

test("layout.ejs: the nav sets only a picture the page can load as given (https or a site path) - the old answer keeps the placeholder", async () => {
  const html = await ejs.renderFile(path.join(repo, "views", "layout.ejs"), { user: "freshie", title: "x" });
  assert.match(html, /<img id="userAvatar" src="\/public\/img\/coin.png"/);
  const m = /<script>\s*(document\.addEventListener\('DOMContentLoaded'[\s\S]*?fetch\('\/api\/u\/freshie\/profile'\)[\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "the nav script");
  const run = async (avatar) => {
    const img = { src: "/public/img/coin.png" };
    let ready = null;
    const ctx = {
      document: { addEventListener: (ev, f) => { if (ev === "DOMContentLoaded") ready = f; }, getElementById: (id) => (id === "userAvatar" ? img : null) },
      fetch: () => Promise.resolve({ json: () => Promise.resolve({ avatar }) }),
      console: { error: () => {} },
    };
    vm.runInNewContext(m[1], ctx);
    ready();
    await new Promise((r) => setTimeout(r, 5));
    return img.src;
  };
  assert.equal(await run("/public/img/avatar.png"), "/public/img/avatar.png");
  assert.equal(await run("https://cdn.example/p/photo.webp"), "https://cdn.example/p/photo.webp");
  for (const bad of ["avatar.png", "//evil.example/x.png", "/\\evil.example/x.png", "javascript:alert(1)", "", null, "x\" onerror=\"1"]) {
    assert.equal(await run(bad), "/public/img/coin.png", String(bad));
  }
});

test("a fresh database (dbUtils.createTables): a new account's avatar defaults to /public/img/avatar.png, not the relative avatar.png", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "badge-avatar-fresh-"));
  const script = `
    const { createTables, runQuery, getQuery } = require(${JSON.stringify(path.join(repo, "dbUtils"))});
    createTables();
    (async () => {
      for (let i = 0; i < 200; i++) {
        const t = await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'");
        if (t.length) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await runQuery("INSERT INTO users (userId, username, password) VALUES ('u1', 'newbie', 'x')");
      process.stdout.write(JSON.stringify((await getQuery("SELECT avatar FROM users WHERE userId = 'u1'"))[0]));
      process.exit(0);
    })().catch((e) => { process.stderr.write(String(e && e.message)); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", script], { cwd: d, env: process.env, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim().split("\n").pop()), { avatar: "/public/img/avatar.png" });
  const src = fs.readFileSync(path.join(repo, "dbUtils.js"), "utf8");
  assert.doesNotMatch(src, /DEFAULT\s+["']avatar\.png["']/, "no relative default left in the schema");
});
