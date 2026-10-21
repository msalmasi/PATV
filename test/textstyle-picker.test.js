// S1 V3 (release L5): the chat text-style picker - textstyle.js choices / fromForm / pickerState / the save route
// (POST /api/u/<me>/update/textstyle), the Edit profile card (views/editProfile.ejs #textstyle) and the /settings hub row.
//   - palette only: the picker offers exactly rt-schema's palette (chat-text-styles.json) and six fonts, and the route
//     stores nothing else - a typed hex, a key outside the palette, an unknown font are refused and change nothing
//   - one home: the control lives on Edit profile only; the /settings hub links to it and shows what is saved
//   - the looks switch: while it is off the card, the /settings row and the route are not there (nothing a member sees
//     changes before S1's switches turn on, ADR 0007 D19)
//   NODE_PATH=G:/PATV/node_modules node --test test/textstyle-picker.test.js
//   TEXTSTYLE_SHOTS=<dir> also writes the rendered Edit profile page there (for screenshots)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "textstyle-picker-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";

const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const TS = require(path.join(repo, "textstyle"));
const HUB = require(path.join(repo, "settingshub"));
const HO = require(path.join(repo, "huboutbox"));
const EN = require(path.join(repo, "locales", "en.json"));
const REG = JSON.parse(fs.readFileSync(path.join(repo, "chat-text-styles.json"), "utf8"));
const KEYS = Object.keys(REG.palette);
const FONT_KEYS = Object.keys(REG.fonts);

const users = new Map();
const flashes = new Map();       // userId -> {success: [], error: []}
let base, server;
async function mkUser(name) {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', 'pleb')", [id, name, name]);
  const u = { userId: id, username: name, class: "pleb" };
  users.set(id, u);
  return u;
}
const U = {};
const stored = async (u) => (await getQuery("SELECT text_style FROM users WHERE userId = ?", [u.userId]))[0].text_style;
const setRaw = (u, v) => runQuery("UPDATE users SET text_style = ? WHERE userId = ?", [v, u.userId]);
/** The `looks` switch (hubseam_settings, as /admin/keys#seam stores it), re-read the way huboutbox does. */
async function setLooks(on) {
  await runQuery("CREATE TABLE IF NOT EXISTS hubseam_settings (key TEXT PRIMARY KEY, value TEXT, updated INTEGER, actor TEXT)");
  await runQuery("INSERT INTO hubseam_settings (key, value) VALUES ('looks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [on ? "true" : "false"]);
  await HO.reloadSettings();
}

/** POST the picker's form: as the page script does (json) or as a plain form post. Every answer is private, no-store. */
async function post(u, fields, { json = true, name = null, origin = "same" } = {}) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (u) headers["x-test-user"] = u.userId;
  if (json) Object.assign(headers, { accept: "application/json", "x-requested-with": "fetch" });
  if (origin === "same") headers.origin = base;
  else if (origin) headers.origin = origin;
  const r = await fetch(base + "/api/u/" + encodeURIComponent(name || (u ? u.username : "nobody")) + "/update/textstyle",
                        { method: "POST", headers, body: new URLSearchParams(fields).toString(), redirect: "manual" });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = null; }
  assert.equal(r.headers.get("cache-control"), "private, no-store", "a " + r.status + " answer is private, no-store");
  return { status: r.status, loc: r.headers.get("location"), body, text };
}
const takeFlash = (u) => { const f = flashes.get(u.userId) || {}; flashes.delete(u.userId); return f; };

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  twitchId TEXT, discordId TEXT, email TEXT, avatar TEXT, password_set INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
  await TS.init();
  await setLooks(true);              // the picker is there only while the looks switch is on (its own test turns it off)
  U.fan = await mkUser("fan");
  U.other = await mkUser("other");
  U.plain = await mkUser("plain");
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    const h = req.get("x-test-user");
    req.user = h ? users.get(h) || null : null;
    req.flash = (k, v) => {
      const id = req.user ? req.user.userId : "-";
      const f = flashes.get(id) || {};
      if (v === undefined) return f[k] || [];
      (f[k] = f[k] || []).push(v);
      flashes.set(id, f);
      return f[k].length;
    };
    next();
  });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = (req, res, next) => next();
  TS.register(app, { addUser });
  HUB.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

// ── palette only ──
test("the picker's choices are rt-schema's palette and fonts, in registry order, each with an English label", () => {
  const c = TS.choices();
  assert.equal(c.colors.length, 16, "the free 16-colour palette");
  assert.deepEqual(c.colors.map((x) => x.key), KEYS);
  for (const x of c.colors) {
    assert.equal(x.dark, REG.palette[x.key].dark.toLowerCase(), x.key + " dark");
    assert.equal(x.light, REG.palette[x.key].light.toLowerCase(), x.key + " light");
    assert.equal(x.label_key, REG.palette[x.key].label_key);
    assert.equal(typeof EN[x.label_key], "string", "en.json has " + x.label_key);
  }
  assert.equal(c.fonts.length, 6, "the six fonts");
  assert.deepEqual(c.fonts.map((x) => x.key), FONT_KEYS);
  for (const f of c.fonts) {
    assert.equal(f.stack, REG.fonts[f.key].stack, f.key + " stack");
    assert.equal(f.scale, REG.fonts[f.key].size_scale || 1, f.key + " scale");
    assert.equal(typeof EN[f.label_key], "string", "en.json has " + f.label_key);
  }
  assert.equal(typeof EN["textstyle.color.none"], "string");
  // the preview's themes are the chat's: its first background of each theme and its link colour
  assert.deepEqual(c.theme, { dark: { bg: REG.backgrounds.dark[0], link: REG.reserved_accents.link.dark },
                              light: { bg: REG.backgrounds.light[0], link: REG.reserved_accents.link.light } });
  // the faces the preview needs: one Google Fonts stylesheet with the registry's webfonts
  const href = TS.webfontHref();
  assert.match(href, /^https:\/\/fonts\.googleapis\.com\/css2\?/);
  for (const k of FONT_KEYS) if (REG.fonts[k].webfont) assert.ok(href.includes("family=" + REG.fonts[k].webfont.replace(/ /g, "+")), k);
  assert.match(href, /&display=swap$/);
});

test("fromForm: a palette key and a font - nothing else; the stored colour is the key's dark-theme value", () => {
  assert.deepEqual(TS.fromForm({ color: "blue", font: "mono" }), { color: "#60a5fa", font: "mono" });
  assert.deepEqual(TS.fromForm({ color: "none", font: "pixel" }), { color: null, font: "pixel" });
  assert.deepEqual(TS.fromForm({ color: "teal", font: "" }), { color: "#2dd4bf", font: "sans" });
  // the default (no colour, sans) is no style at all
  for (const b of [{ color: "none", font: "sans" }, { color: "", font: "" }, {}, null]) assert.equal(TS.fromForm(b), null, JSON.stringify(b));
  // palette only: a typed hex (even a palette value), another key, a key's case, an inherited name, a non-string - refused
  const refused = [{ color: "#60a5fa" }, { color: "#1d4ed8", font: "sans" }, { color: "#123456" }, { color: "gold" }, { color: "Blue" },
                   { color: "__proto__" }, { color: "constructor" }, { color: "toString" }, { color: ["blue"] }, { color: { k: "blue" } },
                   { color: "blue", font: "wingdings" }, { font: "__proto__" }, { font: "hasOwnProperty" }, { font: ["mono"] }, { font: "Mono" }];
  for (const b of refused) {
    assert.throws(() => TS.fromForm(b), (e) => e.code === "bad_text_style" && e.status === 400 && e.refuse === true, JSON.stringify(b));
  }
  // every palette key and font round-trips: stored, cleaned, shown checked, and the look carries the palette value
  for (const k of KEYS) {
    for (const f of FONT_KEYS) {
      const s = TS.fromForm({ color: k, font: f });
      assert.deepEqual(TS.clean(JSON.stringify(s)), s, k + "/" + f);
      assert.deepEqual(TS.pickerState(JSON.stringify(s)), { color: k, font: f });
      assert.deepEqual(TS.lookText(JSON.stringify(s)), { color: REG.palette[k].dark, font: f, scope: "all" });
    }
  }
  // a style stored with the palette's light value (the shared golden's #1d4ed8) shows as that palette colour
  assert.deepEqual(TS.pickerState('{"color":"#1d4ed8","font":"mono"}'), { color: "blue", font: "mono" });
  assert.deepEqual(TS.pickerState(null), { color: null, font: "sans" });
  assert.deepEqual(TS.pickerState('{"color":"#123456","font":"mono"}'), { color: null, font: "sans" }, "an invalid stored value is no style");
});

test("choices(): a font stack that could leave the view's style attribute is left out, and so is a webfont name that isn't plain", () => {
  // the view prints a stack into style="font-family: ..." (HTML-escaped, so a quote can't end the attribute): a ; or : could
  // add a property, < > { } \ / or a line break could do worse - only letters, digits, spaces and , " ' ( ) . - pass
  const evil = {
    semi: "Georgia; background: url(https://evil.example/x)", colon: "expression:alert(1)", angle: 'x"></span><script>alert(1)</script>',
    brace: "a } body { display: none", slash: "a/**/b", backslash: "a\\3c b", newline: "Georgia\nserif", amp: "a &amp; b", star: "*", hash: "#x",
  };
  for (const [k, stack] of Object.entries(evil)) assert.equal(TS.SAFE_STACK.test(stack), false, k);
  for (const k of FONT_KEYS) assert.equal(TS.SAFE_STACK.test(REG.fonts[k].stack), true, "the registry's " + k + " stack prints as is");
  const reg = JSON.parse(JSON.stringify(REG));
  for (const [k, stack] of Object.entries(evil)) reg.fonts["evil_" + k] = { label_key: "x", stack };
  reg.fonts.fine = { label_key: "x", stack: '"Fine Face", Georgia, serif', webfont: "Fine&family=Evil" };
  reg.fonts.blank = { label_key: "x" };
  reg.palette.word = { dark: "red", light: "#ffffff", label_key: "x" };
  reg.palette.half = { dark: "#123456", label_key: "x" };
  const c = TS.choices(reg);
  assert.deepEqual(c.fonts.map((f) => f.key), FONT_KEYS.concat(["fine"]), "only the registry's fonts and the plain one");
  assert.deepEqual(c.colors.map((x) => x.key), KEYS, "a colour without two hex values is left out");
  // the Google Fonts address names only plain family names (no & or = from a registry value)
  assert.equal(TS.webfontHref(reg), TS.webfontHref());
  assert.doesNotMatch(TS.webfontHref(reg), /Evil/);
  // the registry passed in is the one read (not the module's own copy)
  const two = { palette: { only: { dark: "#a1b2c3", light: "#123abc", label_key: "x" } }, fonts: { serif: REG.fonts.serif } };
  assert.deepEqual(TS.choices(two).colors.map((x) => x.key), ["only"]);
  assert.deepEqual(TS.choices(two).fonts.map((x) => x.key), ["serif"]);
  assert.equal(TS.webfontHref(two), null);
});

// ── the save route ──
test("the save route: signed in, your own name, same site - JSON for the page script", async () => {
  let r = await post(null, { color: "blue", font: "mono" }, { name: "fan" });
  assert.equal(r.status, 401);
  assert.deepEqual(r.body, { ok: false, error: "signin" });
  r = await post(null, { color: "blue", font: "mono" }, { name: "fan", json: false });
  assert.equal(r.status, 302);
  assert.equal(r.loc, "/login");

  r = await post(U.other, { color: "blue", font: "mono" }, { name: "fan" });
  assert.equal(r.status, 403, "someone else's name");
  r = await post(U.fan, { color: "blue", font: "mono" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403, "cross-site");
  assert.deepEqual(r.body, { ok: false, error: "cross_site" });
  r = await post(U.fan, { color: "blue", font: "mono" }, { origin: "https://evil.example", json: false });
  assert.equal(r.status, 403);
  assert.equal(await stored(U.fan), null, "nothing written by a refused request");
  assert.equal(await stored(U.other), null);

  r = await post(U.fan, { color: "blue", font: "mono" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, style: { color: "blue", font: "mono" } });
  assert.equal(await stored(U.fan), '{"color":"#60a5fa","font":"mono"}');
  assert.deepEqual(await TS.get(U.fan.userId), { color: "#60a5fa", font: "mono" });

  // palette only: refused, nothing changes
  for (const f of [{ color: "#ff0000", font: "mono" }, { color: "gold", font: "mono" }, { color: "blue", font: "wingdings" }, { color: "__proto__", font: "sans" }]) {
    r = await post(U.fan, f);
    assert.equal(r.status, 400, JSON.stringify(f));
    assert.deepEqual(r.body, { ok: false, error: "bad_text_style" });
    assert.equal(await stored(U.fan), '{"color":"#60a5fa","font":"mono"}', "unchanged after " + JSON.stringify(f));
  }

  // a font only, then back to the default (cleared: NULL)
  r = await post(U.fan, { color: "none", font: "pixel" });
  assert.deepEqual(r.body, { ok: true, style: { color: null, font: "pixel" } });
  assert.equal(await stored(U.fan), '{"color":null,"font":"pixel"}');
  r = await post(U.fan, { color: "none", font: "sans" });
  assert.deepEqual(r.body, { ok: true, style: { color: null, font: "sans" } });
  assert.equal(await stored(U.fan), null);
});

test("the save route without JS: the form posts, comes back to Edit profile #textstyle with a message", async () => {
  takeFlash(U.fan);
  let r = await post(U.fan, { color: "rose", font: "serif" }, { json: false });
  assert.equal(r.status, 302);
  assert.equal(r.loc, "/u/fan/edit#textstyle");
  assert.deepEqual(takeFlash(U.fan), { success: ["Chat text style saved."] });
  assert.equal(await stored(U.fan), '{"color":"#fb7185","font":"serif"}');

  r = await post(U.fan, { color: "#000000", font: "serif" }, { json: false });
  assert.equal(r.status, 302);
  assert.equal(r.loc, "/u/fan/edit#textstyle");
  assert.deepEqual(takeFlash(U.fan), { error: ["That colour or font isn't in the palette - nothing changed."] });
  assert.equal(await stored(U.fan), '{"color":"#fb7185","font":"serif"}');

  r = await post(U.fan, { color: "none", font: "sans" }, { json: false });
  assert.deepEqual(takeFlash(U.fan), { success: ["Chat text style reset to the default."] });
  assert.equal(await stored(U.fan), null);

  // someone else's name: back to your own page, nothing written
  r = await post(U.other, { color: "rose", font: "serif" }, { json: false, name: "fan" });
  assert.equal(r.status, 302);
  assert.equal(r.loc, "/u/other/edit#textstyle");
  assert.equal(await stored(U.fan), null);
  assert.equal(await stored(U.other), null);
});

test("the save route is limited per member (each saved change is a looks row while the switch is on)", async () => {
  const u = await mkUser("busy");
  for (let i = 0; i < TS.SAVES_PER_WINDOW; i++) {
    const r = await post(u, { color: i % 2 ? "lime" : "sky", font: "serif" });
    assert.equal(r.status, 200, "save " + (i + 1));
  }
  let r = await post(u, { color: "red", font: "serif" });
  assert.equal(r.status, 429);
  assert.deepEqual(r.body, { ok: false, error: "slow" });
  assert.equal(await stored(u), '{"color":"#a3e635","font":"serif"}', "the last allowed save stands");
  takeFlash(u);
  r = await post(u, { color: "red", font: "serif" }, { json: false });
  assert.equal(r.status, 302);
  assert.deepEqual(takeFlash(u), { error: ["Too many changes - try again in a few minutes."] });
  // someone else is not slowed down by it
  r = await post(U.other, { color: "red", font: "serif" });
  assert.equal(r.status, 200);
  r = await post(U.other, { color: "none", font: "sans" });
  assert.equal(await stored(U.other), null);
});

test("the limit counts every post of the member's, refused ones too: probing the palette is slowed like saving", async () => {
  const u = await mkUser("prober");
  for (let i = 0; i < TS.SAVES_PER_WINDOW; i++) {
    const r = await post(u, { color: "#ff00" + String(i).padStart(2, "0"), font: "mono" });
    assert.equal(r.status, 400, "refused " + (i + 1));
  }
  const r = await post(u, { color: "blue", font: "mono" });
  assert.equal(r.status, 429, "the next post, a good one, waits");
  assert.deepEqual(r.body, { ok: false, error: "slow" });
  assert.equal(await stored(u), null);
});

test("a failed save says so, writes nothing and logs no account, name or posted value", async () => {
  const u = await mkUser("broken");
  await runQuery(`CREATE TRIGGER ts_test_fail BEFORE UPDATE OF text_style ON users WHEN NEW.userId = '${u.userId}'
                  BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`);
  const logged = [];
  const orig = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  let r, f;
  try {
    r = await post(u, { color: "violet", font: "comic" });
    takeFlash(u);
    f = await post(u, { color: "violet", font: "comic" }, { json: false });
  } finally {
    Object.assign(console, orig);
    await runQuery("DROP TRIGGER IF EXISTS ts_test_fail");
  }
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { ok: false, error: "error" });
  assert.equal(f.status, 302);
  assert.equal(f.loc, "/u/broken/edit#textstyle");
  assert.deepEqual(takeFlash(u), { error: ["Couldn't save your chat text style - nothing changed."] });
  assert.equal(await stored(u), null);
  assert.equal(logged.filter((l) => l.startsWith("[textstyle] save:")).length, 2, "each failure is logged once");
  for (const l of logged) {
    for (const s of [u.userId, u.username, "violet", "comic", REG.palette.violet.dark, "color", "font"]) assert.ok(!l.includes(s), JSON.stringify(s) + " in the log: " + l);
  }
});

// ── the Edit profile card ──
const renderEdit = (style, extra = {}) => ejs.renderFile(path.join(repo, "views", "editProfile.ejs"), Object.assign({
  username: "fan", displayname: "Fan <b>", camfrogUsername: null, avatar: "", level: 3, classh: "pleb", profileCosmetics: null, layout: null,
  sections: [], subSections: {}, privPanels: [], errors: [], success: [],
  textStyle: TS.pickerState(style), textStyles: TS.choices(), textStyleFonts: TS.webfontHref(),
}, extra));
const radios = (html, name) => [...html.matchAll(new RegExp('<input type="radio" name="' + name + '" value="([^"]+)"([^>]*)>', "g"))].map((m) => ({ v: m[1], checked: / checked/.test(m[2]) }));

test("the Edit profile card: Default + the 16 palette colours, the six fonts, the saved choice checked, both chat themes previewed", async () => {
  const html = await renderEdit('{"color":"#60a5fa","font":"mono"}');
  if (process.env.TEXTSTYLE_SHOTS) fs.writeFileSync(path.join(process.env.TEXTSTYLE_SHOTS, "edit-profile-textstyle.html"), html);
  assert.match(html, /<section class="card" id="textstyle">/);
  assert.match(html, /<form id="textStyleForm" class="ts" action="\/api\/u\/fan\/update\/textstyle" method="post">/);
  assert.match(html, /<nav class="jump"[^]*?<a href="#textstyle">Chat text style<\/a>/, "the jump links name it");
  const colors = radios(html, "color"), fonts = radios(html, "font");
  assert.deepEqual(colors.map((x) => x.v), ["none"].concat(KEYS));
  assert.deepEqual(colors.filter((x) => x.checked).map((x) => x.v), ["blue"]);
  assert.deepEqual(fonts.map((x) => x.v), FONT_KEYS);
  assert.deepEqual(fonts.filter((x) => x.checked).map((x) => x.v), ["mono"]);
  for (const k of KEYS) assert.ok(html.includes(">" + EN[REG.palette[k].label_key] + "</span>"), k + " label");
  // palette only: every colour on the card is a palette value (swatches, the preview), and there's no free colour field
  const hexes = new Set([...html.slice(html.indexOf('id="textstyle"'), html.indexOf("</section>", html.indexOf('id="textstyle"'))).matchAll(/--ts-(?:d|l|msg-d|msg-l): (#[0-9a-f]{6})/g)].map((m) => m[1]));
  const pal = new Set(KEYS.flatMap((k) => [REG.palette[k].dark, REG.palette[k].light]));
  assert.ok(hexes.size >= 32, "the swatches carry the pairs");
  for (const h of hexes) assert.ok(pal.has(h), h + " is a palette value");
  assert.doesNotMatch(html, /type="color"|name="color" type="text"|<input type="text"[^>]*name="(?:color|font)"/);
  // the preview: the saved pair and face, the name escaped, a mention in the chat's link colour
  assert.match(html, /id="tsPreview" role="group" aria-label="Preview" style="--ts-msg-d: #60a5fa; --ts-msg-l: #1d4ed8; --ts-font: ui-monospace, SFMono-Regular, Menlo, Consolas, &#34;Liberation Mono&#34;, monospace; --ts-scale: 1; --ts-bg-d: #0f0f11; --ts-at-d: #81c784; --ts-bg-l: #ffffff; --ts-at-l: #276b2b"/);
  assert.match(html, /class="ts-pv-row ts-dark"[^]*?Dark theme[^]*?<b class="ts-who">Fan &lt;b&gt;<\/b>[^]*?class="ts-pv-row ts-light"[^]*?Light theme/);
  assert.match(html, /<span class="ts-at">@Pepe<\/span>/);
  // the faces load for the preview
  assert.ok(html.includes('<link rel="stylesheet" href="' + TS.webfontHref().replace(/&/g, "&amp;") + '">'));
  // the script saves with JSON and only through the form's own action
  assert.match(html, /fetch\(form\.action, \{ method: 'POST'[^]*?Accept: 'application\/json'/);
});

test("the Edit profile card with nothing saved: Default and Sans checked, the preview in the chat's own colours", async () => {
  const html = await renderEdit(null);
  assert.deepEqual(radios(html, "color").filter((x) => x.checked).map((x) => x.v), ["none"]);
  assert.deepEqual(radios(html, "font").filter((x) => x.checked).map((x) => x.v), ["sans"]);
  assert.doesNotMatch(html, /--ts-msg-d:/);
  assert.match(html, /style="--ts-font: var\(--ds-font, Ubuntu, system-ui, sans-serif\); --ts-scale: 1; /);
  // a pixel face carries its size scale
  const px = await renderEdit('{"color":null,"font":"pixel"}');
  assert.match(px, /style="--ts-font: &#34;Press Start 2P&#34;, ui-monospace, monospace; --ts-scale: 0.75; /);
  // rendered without the picker's data (an older caller), the page still renders, without the card
  const bare = await ejs.renderFile(path.join(repo, "views", "editProfile.ejs"), { username: "fan", displayname: "Fan", camfrogUsername: null, avatar: "", level: 3,
    classh: "pleb", profileCosmetics: null, layout: null, sections: [], subSections: {}, privPanels: [], errors: [], success: [] });
  assert.match(bare, /id="displaynameForm"/);
  assert.doesNotMatch(bare, /id="textStyleForm"|href="#textstyle"/);
});

// ── one home ──
test("one home: the control is on Edit profile only; the /settings hub links to it and shows what is saved", async () => {
  const view = (v) => fs.readFileSync(path.join(repo, "views", v + ".ejs"), "utf8");
  for (const v of ["settingsAccount", "settingsHub", "profile"]) {
    assert.doesNotMatch(view(v), /textStyleForm|update\/textstyle|name="font"/, v + " has no text-style control");
  }
  // the only page that posts to the route is Edit profile, and the route is the only place the site writes the column
  const views = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (/\.(ejs|js)$/.test(f.name)) views.push(p); } };
  walk(path.join(repo, "views")); walk(path.join(repo, "public", "js"));
  assert.deepEqual(views.filter((p) => fs.readFileSync(p, "utf8").includes("update/textstyle")).map((p) => path.relative(repo, p).replace(/\\/g, "/")), ["views/editProfile.ejs"]);
  // every server file that names the column, and what it does with it: textstyle.js sets it (its one UPDATE, through set()),
  // account deletion's tombstone clears it (a dynamic UPDATE of a column map, so a "SET text_style" scan can't see it), the
  // looks builder and its triggers only read it. A new file naming the column fails here until it is placed in this list.
  const src = [];
  const walkSrc = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "test", "public", "views", "locales", "docs", "uploads", ".git", "data"].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walkSrc(p); else if (/\.(c|m)?js$/.test(f.name)) src.push(p);
    }
  };
  walkSrc(repo);
  const naming = src.filter((p) => /\btext_style\b/.test(fs.readFileSync(p, "utf8"))).map((p) => path.relative(repo, p).replace(/\\/g, "/")).sort();
  assert.deepEqual(naming, ["accountdelete.js", "hublooks.js", "textstyle.js", "userlook.js"]);
  const lines = (f) => fs.readFileSync(path.join(repo, f), "utf8").split("\n").filter((l) => /\btext_style\b/.test(l));
  const WRITE = /\b(?:UPDATE|INSERT|REPLACE|DELETE|SET|ALTER)\b|\btext_style\b\s*(?::|=(?!=))/;
  assert.deepEqual(lines("textstyle.js").filter((l) => WRITE.test(l)).map((l) => l.trim().replace(/^.*?(UPDATE users SET text_style = \?|ALTER TABLE users ADD COLUMN text_style TEXT).*$/, "$1")),
                   ["ALTER TABLE users ADD COLUMN text_style TEXT", "UPDATE users SET text_style = ?"], "textstyle.js: the column and its one write");
  assert.deepEqual(lines("accountdelete.js").map((l) => l.trim().replace(/\s*\/\/.*$/, "")), ["text_style: null };"], "account deletion only clears it");
  for (const f of ["hublooks.js", "userlook.js"]) assert.deepEqual(lines(f).filter((l) => WRITE.test(l)), [], f + " only reads it");

  const hub = async (u) => {
    const r = await fetch(base + "/settings", { headers: { "x-test-user": u.userId }, redirect: "manual" });
    assert.equal(r.status, 200);
    return r.text();
  };
  const row = (html) => (html.match(/<li data-entry="textstyle">[^]*?<\/li>/) || [""])[0];
  await setRaw(U.fan, '{"color":"#60a5fa","font":"mono"}');
  let h = row(await hub(U.fan));
  assert.match(h, /<a class="sh-row" href="\/u\/fan\/edit#textstyle">/, "the row goes to the card");
  assert.match(h, /<b>Chat text style<\/b>/);
  assert.match(h, /data-state>Blue · Mono</);
  await setRaw(U.fan, '{"color":"#1d4ed8","font":"mono"}');
  assert.match(row(await hub(U.fan)), /data-state>Blue · Mono</, "either theme's palette value names the colour");
  await setRaw(U.fan, '{"color":null,"font":"pixel"}');
  assert.match(row(await hub(U.fan)), /data-state>Pixel</);
  await setRaw(U.fan, '{"color":"#123456","font":"mono"}');
  assert.match(row(await hub(U.fan)), /data-state>Default</, "an invalid stored value is no style");
  h = row(await hub(U.plain));
  assert.match(h, /href="\/u\/plain\/edit#textstyle"/);
  assert.match(h, /data-state>Default</);
  // the hub row sits with the other "how others see you" rows, after Cosmetics
  const ids = (await HUB.hub(U.plain, {})).find((s) => s.id === "profile").entries.map((e) => e.id);
  assert.deepEqual(ids, ["profile", "feed", "cosmetics", "textstyle", "stickers"]);
});

// ── the looks switch ──
test("the looks switch: while it is off there is no card, no /settings row and no route - a saved style stays", async () => {
  const u = await mkUser("gated");
  await setRaw(u, '{"color":"#60a5fa","font":"mono"}');
  const hubRow = async () => {
    const r = await fetch(base + "/settings", { headers: { "x-test-user": u.userId }, redirect: "manual" });
    assert.equal(r.status, 200);
    return /data-entry="textstyle"/.test(await r.text());
  };
  const profileIds = async () => (await HUB.hub(u, {})).find((s) => s.id === "profile").entries.map((e) => e.id);
  await setLooks(false);
  try {
    assert.equal(TS.pickerOn(), false);
    // the route isn't there: 404 and nothing written - for the page script, a form post, a signed-out post
    let r = await post(u, { color: "rose", font: "serif" });
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, { ok: false, error: "not_found" });
    r = await post(u, { color: "rose", font: "serif" }, { json: false });
    assert.equal(r.status, 404);
    r = await post(null, { color: "rose", font: "serif" }, { name: "gated" });
    assert.equal(r.status, 404, "signed out: nothing says the route exists");
    assert.equal(await stored(u), '{"color":"#60a5fa","font":"mono"}', "nothing written; the saved style stays");
    // Edit profile: no card, no jump link, no webfonts
    const ed = await TS.editData(u.userId);
    assert.deepEqual(ed, { textStyle: null, textStyles: null, textStyleFonts: null });
    const html = await renderEdit(null, ed);
    assert.match(html, /id="displaynameForm"/);
    assert.doesNotMatch(html, /id="textstyle"|id="textStyleForm"|href="#textstyle"/);
    assert.ok(!html.includes('href="' + TS.webfontHref().replace(/&/g, "&amp;") + '"'), "the picker's webfonts don't load");
    // /settings: no row
    assert.equal(await hubRow(), false);
    assert.deepEqual(await profileIds(), ["profile", "feed", "cosmetics", "stickers"]);
  } finally {
    await setLooks(true);
  }
  // on: the card (with what is saved), the row and the route are back
  assert.equal(TS.pickerOn(), true);
  const ed = await TS.editData(u.userId);
  assert.deepEqual(ed, { textStyle: { color: "blue", font: "mono" }, textStyles: TS.choices(), textStyleFonts: TS.webfontHref() });
  const html = await renderEdit(null, ed);
  assert.match(html, /<section class="card" id="textstyle">/);
  assert.deepEqual(radios(html, "color").filter((x) => x.checked).map((x) => x.v), ["blue"]);
  assert.equal(await hubRow(), true);
  assert.deepEqual(await profileIds(), ["profile", "feed", "cosmetics", "textstyle", "stickers"]);
  const r = await post(u, { color: "rose", font: "serif" });
  assert.equal(r.status, 200);
  assert.equal(await stored(u), '{"color":"#fb7185","font":"serif"}');
});
