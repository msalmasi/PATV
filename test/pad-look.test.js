// Offline tests for 1.99es: a pad's look (padlook.js) - owner-only APIs, the hex + contrast guard, upload re-encode /
// size limits / NSFW refusal (a stubbed safety check), avatar fallbacks, where the look renders (pad page, /p, Top
// Pads, feed chips); the Top Pads 🚀 badge by the name, the trimmed "Your show" cards; the story strip's hidden scrollbar.
//   node --test test/pad-look.test.js      (needs the repo's node_modules; uses a temp dir)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padlook-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
const express = require("express");
const ejs = require("ejs");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PL = require(path.join(repo, "padlook"));
const BM = require(path.join(repo, "boostmark"));

const PLANT = "plant_based_chatting";
let owner, other, admin, server, base;
const USERS = {};

async function mkUser(name, cls = "pleb") {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cls]);
  USERS[name] = { userId: id, username: name, class: cls };
  return USERS[name];
}
async function png(w, h, color = { r: 200, g: 60, b: 90 }) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}
async function jpegWithExif(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg().withMetadata({ exif: { IFD0: { Copyright: "secret-gps-owner", Software: "PhoneCam" } } }).toBuffer();
}

function req(method, url, { user, json, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Origin: base }, headers);
    if (user) h["x-test-user"] = user;
    let data = null;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; }
    else if (body) { data = body; }
    if (data) h["Content-Length"] = data.length;
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let j = null;
        try { j = JSON.parse(buf.toString("utf8")); } catch (e) { j = null; }
        resolve({ status: res.statusCode, json: j, buf, headers: res.headers });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
/** The browser's flow: open -> PUT chunks -> finish. */
async function upload(user, slug, kind, buf, extra = {}) {
  const o = await req("POST", `/api/rooms/${slug}/look/uploads`, { user, json: { kind, size: buf.length } });
  if (!o.json || !o.json.ok) return o;
  for (let off = 0; off < buf.length; off += o.json.chunk) {
    const part = buf.subarray(off, Math.min(buf.length, off + o.json.chunk));
    const c = await req("PUT", `/api/rooms/${slug}/look/uploads/${o.json.id}?offset=${off}`, { user, body: part,
      headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" } });
    if (!c.json || !c.json.ok) return c;
  }
  return req("POST", `/api/rooms/${slug}/look/uploads/${o.json.id}/finish`, { user, json: extra });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  owner = await mkUser("plantowner");
  other = await mkUser("stranger");
  admin = await mkUser("boss", "Admin");
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await PL.init();
  const app = express();
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  PL.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); PL.setSafetyCheck(null); });
const slug = () => rooms.getCached(PLANT).slug;
const rd = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");     // a Windows checkout has CRLF

// ── colours ──
test("hex validation: only #rgb / #rrggbb (with or without #) get through, normalised to lowercase #rrggbb", () => {
  assert.equal(PL.normHex("#4CAF50"), "#4caf50");
  assert.equal(PL.normHex("abc"), "#aabbcc");
  assert.equal(PL.normHex(" #FfF "), "#ffffff");
  for (const bad of ["", "#12345", "#1234567", "red", "#ggg000", "#fff;background:url(x)", "#fff}body{", "rgb(1,2,3)", "var(--x)", null, undefined, 123456, "#ff0000 !important", "#ff00001"]) {
    assert.equal(PL.normHex(bad), null, String(bad));
    assert.equal(PL.guardAccent(bad), null, String(bad));
  }
});

test("contrast guard: every preset reaches 4.5:1 on the dark theme; a too-dark custom colour is lightened until it does; ink reads on the accent", () => {
  assert.equal(PL.PALETTE.length, 12);
  for (const c of PL.PALETTE) {
    assert.ok(PL.contrast(c.hex, PL.BG) >= PL.MIN_CONTRAST, `${c.id} ${c.hex} ${PL.contrast(c.hex, PL.BG)}`);
    assert.ok(PL.contrast(c.hex, PL.inkFor(c.hex)) >= PL.MIN_CONTRAST, `ink on ${c.id}`);
    assert.deepEqual(PL.guardAccent(c.hex), { hex: c.hex, adjusted: false, ratio: Math.round(PL.contrast(c.hex, PL.BG) * 100) / 100, ink: PL.inkFor(c.hex) });
  }
  assert.ok(Math.abs(PL.contrast("#000000", "#ffffff") - 21) < 0.01);
  for (const dark of ["#000000", "#1a0f3d", "#330000", "#0d0d0d", "#203040"]) {
    const g = PL.guardAccent(dark);
    assert.equal(g.adjusted, true, dark);
    assert.match(g.hex, /^#[0-9a-f]{6}$/);
    assert.ok(PL.contrast(g.hex, PL.BG) >= PL.MIN_CONTRAST, `${dark} -> ${g.hex}`);
    assert.ok(PL.contrast(g.hex, g.ink) >= PL.MIN_CONTRAST, `ink on ${g.hex}`);
  }
  // css vars: only re-validated values; junk in the store never reaches CSS
  assert.equal(PL.cssVars({ accent: "#66bb6a" }), "--pad-accent:#66bb6a;--pad-accent-ink:#0b0b0b");
  assert.equal(PL.cssVars({ accent: "red;}body{display:none" }), "");
  assert.equal(PL.cssVars({ accent: null, banner: "/media/pad/x", bannerY: "999;x" }), "--pad-banner-y:50%");
  assert.equal(PL.cssVars({ banner: "/media/pad/x", bannerY: 130 }), "--pad-banner-y:100%");
});

// ── owner-only ──
test("owner-only: signed out 401, a stranger 403, the owner and a site admin may; cross-site Origin and non-JSON are refused", async () => {
  const s = slug();
  assert.equal((await req("POST", `/api/rooms/${s}/look`, { json: { accent: "teal" } })).status, 401);
  const st = await req("POST", `/api/rooms/${s}/look`, { user: "stranger", json: { accent: "teal" } });
  assert.equal(st.status, 403);
  assert.match(st.json.error, /owner/);
  assert.equal((await req("POST", `/api/rooms/${s}/look/uploads`, { user: "stranger", json: { kind: "avatar", size: 100 } })).status, 403);
  assert.equal((await req("POST", `/api/rooms/${s}/look/remove`, { user: "stranger", json: { kind: "avatar" } })).status, 403);
  assert.equal((await req("POST", `/api/rooms/${s}/look`, { user: "plantowner", json: { accent: "teal" }, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await req("POST", `/api/rooms/${s}/look`, { user: "plantowner", body: Buffer.from("accent=teal"), headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status, 415);
  assert.equal((await req("POST", `/api/rooms/no-such-pad/look`, { user: "plantowner", json: { accent: "teal" } })).status, 404);
  const ok = await req("POST", `/api/rooms/${s}/look`, { user: "plantowner", json: { accent: "teal" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.look.accent, "#26c6da");
  const adm = await req("POST", `/api/rooms/${s}/look`, { user: "boss", json: { accent: "#1a0f3d" } });
  assert.equal(adm.status, 200);
  assert.equal(adm.json.adjusted, true, "a too-dark custom colour is lightened");
  assert.ok(PL.contrast(adm.json.look.accent, PL.BG) >= 4.5);
  const bad = await req("POST", `/api/rooms/${s}/look`, { user: "plantowner", json: { accent: "#fff;}*{x" } });
  assert.equal(bad.status, 400);
  assert.equal((await req("POST", `/api/rooms/${s}/look`, { user: "plantowner", json: { accent: "" } })).json.look.accent, null);
  // a chunk without X-Requested-With (a plain cross-site form can't set it)
  const o = await req("POST", `/api/rooms/${s}/look/uploads`, { user: "plantowner", json: { kind: "avatar", size: 200 } });
  assert.equal((await req("PUT", `/api/rooms/${s}/look/uploads/${o.json.id}?offset=0`, { user: "plantowner", body: Buffer.alloc(200), headers: { "Content-Type": "application/octet-stream" } })).status, 415);
  // another user can't push chunks into the owner's upload
  assert.equal((await req("PUT", `/api/rooms/${s}/look/uploads/${o.json.id}?offset=0`, { user: "boss", body: await png(10, 10),
    headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" } })).status, 404);
  PL._uploads.clear();
});

// ── uploads ──
test("avatar upload: chunked, re-encoded to a 256 px square webp with NO metadata; served only while in use, with immutable cache headers", async () => {
  const src = await jpegWithExif(1200, 800);
  assert.ok((await sharp(src).metadata()).exif, "the source has EXIF");
  const r = await upload("plantowner", slug(), "avatar", src);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.look.avatar, /^\/media\/pad\/[a-f0-9]{32}_a\.webp$/);
  const f = await req("GET", r.json.look.avatar);
  assert.equal(f.status, 200);
  assert.equal(f.headers["content-type"], "image/webp");
  assert.match(f.headers["cache-control"], /immutable/);
  assert.equal(f.headers["x-content-type-options"], "nosniff");
  const m = await sharp(f.buf).metadata();
  assert.equal(m.format, "webp");
  assert.equal(m.width, 256); assert.equal(m.height, 256);
  assert.equal(m.exif, undefined, "EXIF stripped");
  assert.equal(m.icc, undefined, "ICC stripped");
  assert.ok(!f.buf.includes(Buffer.from("secret-gps-owner")));
  // replace: the old file is deleted and 404s
  const first = r.json.look.avatar.split("/").pop();
  const r2 = await upload("plantowner", slug(), "avatar", await png(300, 300));
  assert.equal(r2.status, 200);
  assert.notEqual(r2.json.look.avatar, r.json.look.avatar);
  assert.equal(fs.existsSync(PL.filePath(first)), false, "old file deleted on replace");
  assert.equal((await req("GET", "/media/pad/" + first)).status, 404);
  assert.equal((await req("GET", "/media/pad/../../etc/passwd")).status, 404);
  assert.equal((await req("GET", "/media/pad/" + "a".repeat(32) + "_a.webp")).status, 404, "an unused name 404s");
});

test("banner upload: 1600 px wide, cropped to between 4:1 and 2:1, focal point stored; remove deletes the file", async () => {
  const r = await upload("plantowner", slug(), "banner", await png(3200, 3200), { banner_y: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.look.bannerY, 20);
  const f = await req("GET", r.json.look.banner);
  const m = await sharp(f.buf).metadata();
  assert.equal(m.width, PL.BANNER_W);
  assert.equal(m.height, PL.BANNER_MAX_H, "a square picture is cropped to 2:1");
  const wide = await upload("plantowner", slug(), "banner", await png(2000, 300));
  const mw = await sharp((await req("GET", wide.json.look.banner)).buf).metadata();
  assert.equal(mw.width, 1600); assert.equal(mw.height, 240, "a very wide one keeps its own shape (never stretched)");
  const name = wide.json.look.banner.split("/").pop();
  const y = await req("POST", `/api/rooms/${slug()}/look`, { user: "plantowner", json: { banner_y: 75 } });
  assert.equal(y.json.look.bannerY, 75);
  const rm = await req("POST", `/api/rooms/${slug()}/look/remove`, { user: "plantowner", json: { kind: "banner" } });
  assert.equal(rm.json.look.banner, null);
  assert.equal(fs.existsSync(PL.filePath(name)), false);
});

test("upload limits: over 5 MB refused at open and when the chunks lie; non-pictures (SVG / HTML / PDF / text) refused on the first chunk", async () => {
  const big = await req("POST", `/api/rooms/${slug()}/look/uploads`, { user: "plantowner", json: { kind: "banner", size: PL.MAX_BYTES + 1 } });
  assert.equal(big.status, 413);
  assert.match(big.json.error, /5 MB/);
  assert.equal((await req("POST", `/api/rooms/${slug()}/look/uploads`, { user: "plantowner", json: { kind: "wallpaper", size: 100 } })).status, 400);
  // declared small, sends more
  const o = await req("POST", `/api/rooms/${slug()}/look/uploads`, { user: "plantowner", json: { kind: "avatar", size: 20 } });
  const lie = await req("PUT", `/api/rooms/${slug()}/look/uploads/${o.json.id}?offset=0`, { user: "plantowner", body: await png(20, 20),
    headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "fetch" } });
  assert.equal(lie.status, 413);
  for (const bad of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), Buffer.from("<html><body>hi</body></html>"),
                     Buffer.from("%PDF-1.4 lorem ipsum dolor"), Buffer.from("just some text, not a picture")]) {
    const r = await upload("plantowner", slug(), "avatar", bad);
    assert.equal(r.status, 415, bad.toString().slice(0, 10));
  }
  // direct API: size cap on the assembled buffer too
  await assert.rejects(PL.setImage(PLANT, "avatar", Buffer.alloc(PL.MAX_BYTES + 1, 1), { actor: "t" }), (e) => e.status === 413);
  // a picture whose contents don't decode
  const broken = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
  await assert.rejects(PL.setImage(PLANT, "avatar", broken, { actor: "t" }), (e) => e.status === 415);
  PL._uploads.clear();
});

test("NSFW refusal: a picture the safety check flags is refused and nothing is stored; the current avatar stays", async () => {
  const before = PL.look(PLANT).avatar;
  assert.ok(before, "an avatar from the earlier test");
  const filesBefore = fs.readdirSync(PL.dir(), { recursive: true }).length;
  const seen = [];
  PL.setSafetyCheck(async (x) => { seen.push(x.kind); return { ok: false, nsfw: true }; });
  const r = await upload("plantowner", slug(), "avatar", await png(400, 400));
  assert.equal(r.status, 422);
  assert.match(r.json.error, /adult content/);
  const rb = await upload("plantowner", slug(), "banner", await png(1600, 400));
  assert.equal(rb.status, 422);
  assert.deepEqual(seen, ["avatar", "banner"], "the check sees the RE-ENCODED picture, for both kinds");
  assert.equal(PL.look(PLANT).avatar, before);
  assert.equal(fs.readdirSync(PL.dir(), { recursive: true }).length, filesBefore, "no file written");
  // a check that throws fails closed
  PL.setSafetyCheck(async () => { throw new Error("down"); });
  assert.equal((await upload("plantowner", slug(), "avatar", await png(400, 400))).status, 422);
  PL.setSafetyCheck(async (x) => { assert.ok(Buffer.isBuffer(x.buf)); assert.equal((await sharp(x.buf).metadata()).format, "webp"); return { ok: true }; });
  assert.equal((await upload("plantowner", slug(), "avatar", await png(400, 400))).status, 200);
  PL.setSafetyCheck(null);
});

// ── fallbacks + where it shows ──
test("avatar fallbacks: no avatar -> the monogram (🐸 house, 🛋️ site pads, else the first letter); an avatar -> an <img>; feed chips too", async () => {
  assert.equal(PL.monogram({ title: "Houseplants" }), "H");
  assert.equal(PL.monogram({ title: "🌿 plants" }), "P");
  assert.equal(PL.monogram({ title: "x", house: true }), "🐸");
  assert.equal(PL.monogram({ title: "x", community: true }), "🛋️");
  assert.equal(PL.monogram({ title: "Camfrog Lounge", house: true, community: true }), "🛋️", "a house SITE pad: the sofa, like its feed chip");
  assert.equal(PL.avatarHtml("Nobody.Room", { pad: { title: "zed" } }), '<span class="pad-av" aria-hidden="true">Z</span>');
  assert.equal(PL.avatarHtml("Nobody.Room", { fallback: "" }), "");
  assert.match(PL.avatarHtml("PepeFrog.Room"), /🐸/, "a house pad from the registry");
  assert.match(PL.avatarHtml(PLANT, { cls: "x" }), /^<span class="pad-av x has-img" aria-hidden="true"><img src="\/media\/pad\/[a-f0-9]{32}_a\.webp" alt="" loading="lazy" decoding="async"><\/span>$/);
  const fx = require(path.join(repo, "feedweb")).fx;
  await PL.setStyle(PLANT, { accent: "pink" }, "t");
  const chip = fx.padChip({ id: PLANT, slug: "plant-based-chatting", title: "Houseplants" }, "sm");
  assert.match(chip, /^<span class="cbadge sm has-img acc" style="--h:\d+;--pad-accent:#f06292" aria-hidden="true"><img src="\/media\/pad\//);
  assert.equal(fx.padChip({ id: "Nobody.Room", slug: "nobody", title: "nobody" }), `<span class="cbadge" style="--h:${fx.hue("nobody")}" aria-hidden="true">N</span>`);
});

test("pad page: the accent as custom properties on <main>, the uploaded banner in the header with its focal point, the avatar by the name", async () => {
  await upload("plantowner", slug(), "banner", await png(1600, 600), { banner_y: 30 });
  const L = PL.look(PLANT);
  const html = await ejs.renderFile(path.join(repo, "views", "room.ejs"), {
    user: null, signedIn: false, linked: false, padLook: PL.look, padAv: PL.avatarHtml,
    room: { id: PLANT, name: "Houseplants", slug: "plant-based-chatting", count: 0, live: false, topic: "", bridged: false, siteOnly: false, platform: "camfrog",
            description: "", banner: "https://example.com/old.png", owner: "plantowner", ownerUser: "plantowner", house: false, camfrogName: PLANT },
    initial: null, padTabs: null, latest: [], dms: false, pepeHere: false, stage: { active: false }, roomStage: null, manage: false, schedule: null,
    analytics: false, feed: null, fx: require(path.join(repo, "feedweb")).fx, embeds: require(path.join(repo, "stageembed")), host: "publicaccess.tv",
  }).then((h) => h.replace(/\r\n/g, "\n"));
  assert.match(html, /<main class="rm pad-acc" style="--pad-accent:#f06292;--pad-accent-ink:#0b0b0b;--pad-banner-y:30%">/);
  assert.match(html, new RegExp(`<section class="hero has-bn"[^>]*>\\s*<div class="hero-bn" aria-hidden="true"><img src="${L.banner}"`));
  assert.doesNotMatch(html, /old\.png/, "the uploaded banner wins over the old link");
  assert.match(html, /<h1 id="rmTitle"><span class="pad-av rm-av has-img" aria-hidden="true"><img src="\/media\/pad\/[a-f0-9]{32}_a\.webp"/);
  assert.match(html, /\.rm\.pad-acc \.ptab\[aria-selected="true"\] \{[^}]*var\(--pad-accent\)/);
  assert.match(html, /object-position: 50% var\(--pad-banner-y, 50%\)/);
});

// ── 1.99es UI fixes ──
async function renderHome(locals = {}) {
  return (await ejs.renderFile(path.join(repo, "views", "home.ejs"), Object.assign({
    username: null, me: null, mine: null, S: {}, rooms: [], room: null, roomLive: null, stage: { active: false }, top: [], tops: [],
    story: { rooms: [], caps: [], room: null, signed: false }, hot: null, fx: {}, roomOnStage: false, stageAdmin: null,
    frontInfo: { id: "A", slug: "a", title: "Ay", pinned: false, owner: null, boost: 0 }, pepeHere: true, featuredPrice: 0,
    slots: [], staff: false, xpForNextLevel: () => 100, cosmeticName: () => "", boostMark: BM.boostMark, ul: (n) => String(n || ""),
  }, locals))).replace(/\r\n/g, "\n");
}

test("Top Pads: avatar, name, then 🚀 on the left; the 👥 / 🎙 counts in the right column with the same markup boosted or not", async () => {
  const tops = [{ id: PLANT, slug: "plant", name: "Houseplants", count: 12, micCount: 2, boost: 5400 }, { id: "Other.Room", slug: "o", name: "Other", count: 3, micCount: 0, boost: 0 }];
  const html = await renderHome({ tops, padAv: PL.avatarHtml });
  const box = html.slice(html.indexOf('id="tpH"'), html.indexOf("</ol>", html.indexOf('id="tpH"')));
  const li = box.split("<li>").slice(1);
  assert.match(li[0], /<span class="n"><span class="pad-av tp-av has-img"[^>]*><img[^>]*><\/span><span class="nt">Houseplants<\/span><span class="bm boost-mark"[^>]*>🚀 5\.4k<\/span><\/span><span class="v">/);
  assert.match(li[1], /<span class="n"><span class="pad-av tp-av" aria-hidden="true">O<\/span><span class="nt">Other<\/span><\/span><span class="v">/);
  const v = (s) => s.slice(s.indexOf('<span class="v">'), s.indexOf("</a>") + 4);   // 1.99hm: the 🎧 button after </a> is per pad
  assert.equal(v(li[0]).replace(/12|2/g, "N"), v(li[1]).replace(/3|0/g, "N"), "the right-hand columns are identical markup");
  assert.doesNotMatch(v(li[0]), /boost-mark/);
  assert.match(html, /\.hm \.tp \.rooms-mini \.v > span \{ display: inline-block; min-width: 3\.2em; text-align: right; \}/);
});

test("Your show: the homepage card is one line + Go live / Pads (no bullets); /p's card is the same line", async () => {
  const html = await renderHome();
  const card = html.slice(html.indexOf('id="stageShow"'), html.indexOf("</section>", html.indexOf('id="stageShow"')));
  assert.match(card, /Anyone can go live\./);
  assert.doesNotMatch(card, /<ul|<li|Ordinary slots|liveliest/);
  assert.match(card, /🎥 Go live<\/a><a class="btn" href="\/p">Pads<\/a>/);
  const src = await ejs.renderFile(path.join(repo, "views", "rooms.ejs"), {   // rendered: the text comes from the i18n catalog
    user: null, signedIn: false, staff: false, owned: [], pepe: { active: false }, boostMark: BM.boostMark, ul: (n) => String(n == null ? "" : n), rows: [] });
  const cta = src.slice(src.indexOf('<section class="cta"'), src.indexOf("</section>", src.indexOf('<section class="cta"')));
  assert.match(cta, /Anyone can go live\./);
  assert.doesNotMatch(cta, /<ol>|<li>|liveliest|boost/);
});

test("/p cards + Trending: the 🚀 badge right after the pad's name, never among the status pills / stat tags", () => {
  const src = rd(path.join(repo, "views", "rooms.ejs"));
  assert.match(src, /<span class="ch-name"><%- PAV_\(r\.id[^%]*%><span class="t[^"]*"><%= r\.title %><\/span>(<%- fx_ \? fx_\.badges : '' %>)?<%- BM\(r\.boost_pat, 'pill ch-mark'\) %><\/span>/);
  const badges = src.slice(src.indexOf('<span class="ch-badges">'), src.indexOf("</span>\n          </div>", src.indexOf('<span class="ch-badges">')));
  assert.doesNotMatch(badges, /BM\(/);
  assert.match(src, /<span class="tn"><a class="t" href="[^"]*"><%= r\.title %><\/a><%- BM\(r\.boost_pat, 'tg boost'\) %><\/span>/);
  const tags = src.slice(src.indexOf('<span class="tags">'), src.indexOf("</span></span>", src.indexOf('<span class="tags">')));
  assert.doesNotMatch(tags, /BM\(/);
});

test("story strip: no native scrollbar (scrollbar-width none + ::-webkit-scrollbar hidden), edge fades, arrows only on hover pointers, scroll-snap kept", () => {
  const css = rd(path.join(repo, "public", "css", "stories.css"));
  const row = css.match(/\.ss-row \{[^}]*\}/)[0];
  assert.match(row, /overflow-x: auto;/);
  assert.match(row, /scrollbar-width: none;/);
  assert.match(row, /scroll-snap-type: x proximity;/);
  assert.match(row, /mask-image: linear-gradient\(90deg, transparent 0, #000 var\(--fl\), #000 calc\(100% - var\(--fr\)\), transparent 100%\)/);
  assert.match(css, /\.ss-row::-webkit-scrollbar \{ display: none;/);
  assert.match(css, /\.ss-t \{[^}]*scroll-snap-align: start;/);
  assert.match(css, /\.ss-arr \{ display: none; \}\n@media \(hover: hover\) and \(pointer: fine\) \{/);
  assert.match(css, /\.ss-scroll\.ovf\.at-start \.ss-arr\.prev, \.ss-scroll\.ovf\.at-end \.ss-arr\.next \{ display: none; \}/);
  const part = rd(path.join(repo, "views", "partials", "story-strip.ejs"));
  assert.match(part, /<div class="ss-scroll">\s*<button type="button" class="ss-arr prev" tabindex="-1"/);
  assert.match(part, /stories\.css\?v=6/);
  assert.match(part, /stories\.js\?v=10/);
  const js = rd(path.join(repo, "public", "js", "stories.js"));
  assert.match(js, /function initStrips\(\)/);
  assert.doesNotMatch(js, /addEventListener\('wheel'/, "the vertical wheel is never hijacked");
});

test("pad cosmetics: the slots are listed here, the selling is padcosmetics.js (1.99ew) - no PAT anywhere in padlook", () => {
  assert.deepEqual(Object.keys(PL.COSMETIC_SLOTS), ["pad_frame", "pad_glow", "pad_badge", "pad_avatar"]);
  const src = fs.readFileSync(path.join(repo, "padlook.js"), "utf8");
  assert.doesNotMatch(src, /points_balance|transactions|charge\(|\/api\/actions/);
});
