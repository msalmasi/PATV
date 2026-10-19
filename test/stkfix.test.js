// stkfix (V0 of the stickers addendum, site): the sticker bugs found while mapping v1 (map-v1.md §12).
//   B1 inline() escapes every name it writes - an evil pack / sticker name renders inert (a fresh copy of the module reads an
//      evil stickers.json, so the test also runs - and fails - on the old code, which has no test hook)
//   B2 fallbackText(): "[sticker: Name]" wherever no picture can go (the callers are in stkfix-text / stkfix-relay tests);
//      the name as one plain line (emoji joiners kept), in the reader's language when given a t
//   B4 forPepe(): Pepe's DM text keeps only house packs listed right now (at most 12); other known tokens become text
//   B5 the picker: GET /api/stickers answers in the viewer's language (stk.* keys, plain text); the panel's words are js.stk.*;
//      in a fake page: loaded twice it listens once, an error answer says "couldn't load" (not "Sign in") and is asked again
//   B6 the comment and reply boxes have the 🧸 picker
//   B7 GET /stickers (linked from Pepe's Pad) is no longer a 404: it goes to the store (the 🧸 tab of /cosmetics)
//   B8 a retired pack refuses with E_TARGET_NOT_FOUND (410 was missing from the code map -> E_REFUSED)
//   NODE_PATH=G:/PATV/node_modules node --test test/stkfix.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stkfix-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const PR = require(path.join(repo, "premium"));
const STK = require(path.join(repo, "stickers"));
const i18n = require(path.join(repo, "i18n"));
const EN = require(path.join(repo, "locales", "en.json"));
const src = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

let t = Date.UTC(2026, 9, 10, 12);
PR._setClock(() => t);
STK._setClock(() => t);
/** a catalog from JSON (loadCatalog keeps only stickers with art, so the ids are real ones) */
function catalogOf(json) {
  const f = path.join(tmp, "cat-" + Math.random().toString(36).slice(2) + ".json");
  fs.writeFileSync(f, JSON.stringify(json));
  return STK.loadCatalog(f);
}
/**
 * A fresh copy of stickers.js whose stickers.json reads as `json` - for the bugs that must show on the OLD module too (B1, B8),
 * which has no test hook: fs.readFileSync answers the catalog file while the copy loads (its `let CAT = loadCatalog()`), then
 * everything is put back (the shared copy stays the one in require.cache).
 */
function stickersWith(json) {
  const file = require.resolve(path.join(repo, "stickers"));
  const catFile = path.join(repo, "stickers.json");
  const shared = require.cache[file], read = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { return path.resolve(String(p)) === catFile ? JSON.stringify(json) : read.call(fs, p, ...rest); };
  delete require.cache[file];
  try { return require(file); } finally {
    fs.readFileSync = read;
    if (shared) require.cache[file] = shared; else delete require.cache[file];
  }
}
const unent = (s) => s.replace(/&(amp|lt|gt|quot|#39|#96);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#96": "`" })[e]);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES ('u-ann', 'ann', 'ann', 'x', 5000000)");
  await STK.init();
  const app = express();
  app.use(express.json());
  app.use(i18n.middleware(() => null));                 // req.t from Accept-Language (no cookie, no saved preference)
  const addUser = (req, res, next) => { req.user = req.get("x-test-user") ? { userId: req.get("x-test-user"), username: "ann" } : null; next(); };
  STK.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); if (STK._setCatalog) STK._setCatalog(); });

test("B1: an evil pack / sticker name renders inert - every attribute inline() writes is escaped", () => {
  const evil = '"><script>alert(1)</script>';
  const evilPack = "x\" onerror='alert(2)' `";
  const EVIL = stickersWith({ packs: [{ id: "pixelpepe", name: evilPack, stickers: [{ id: "happy", name: evil }] }] });
  assert.equal(EVIL.CAT.byId.pixelpepe.byId.happy.name, evil, "the copy reads the evil catalog");
  for (const h of [EVIL.inline("hi [sticker:pixelpepe/happy] there"), EVIL.inline("[sticker:pixelpepe/happy]")]) {
    assert.doesNotMatch(h, /<script/i, "no script element");
    assert.equal((h.match(/</g) || []).length, 1, "one tag: the <img>");
    const img = h.slice(h.indexOf("<img"), h.indexOf(">", h.indexOf("<img")) + 1);
    // the tag is well formed: name="value" pairs only, and the values read back as the names
    assert.match(img, /^<img( [a-z-]+="[^"<>`]*")+>$/, img);
    assert.equal(unent(/ alt="([^"]*)"/.exec(img)[1]), evil);
    assert.equal(unent(/ title="([^"]*)"/.exec(img)[1]), evil + " · " + evilPack);
  }
  assert.notEqual(EVIL, STK, "the shared module is untouched");
  // the real catalog still renders (an apostrophe in a name is escaped too)
  assert.match(STK.inline("[sticker:spooky/pumpkin]"), /<img class="stk stk-l" src="\/public\/stickers\/spooky\/pumpkin\.svg" alt="Jack-o&#39;-lantern" title="Jack-o&#39;-lantern · Spooky Season"/);
});

test("B2: fallbackText - known tokens read '[sticker: Name]', unknown ones stay as typed, names are one plain line", () => {
  // the helper is new (the old code had none - the raw token went out; stkfix-text / stkfix-relay show that on the real paths)
  assert.equal(typeof STK.fallbackText, "function", "the one shared fallback helper");
  assert.equal(STK.fallbackText("hi [sticker:pixelpepe/happy] and [sticker:fake/thing]"), "hi [sticker: Happy Pepe] and [sticker:fake/thing]");
  assert.equal(STK.fallbackText("no stickers"), "no stickers");
  assert.equal(STK.fallbackText(null), "");
  const once = STK.fallbackText("[sticker:spooky/pumpkin][sticker:patvreacts/gg]");
  assert.equal(once, "[sticker: Jack-o'-lantern][sticker: GG]");
  assert.equal(STK.fallbackText(once), once, "the stand-in is never a token again");
  assert.equal(STK.tokens(once).length, 0);
  const zwj = "\u{1F469}\u200d\u{1F4BB}";                 // woman technologist: one emoji held together by a zero-width joiner
  STK._setCatalog(catalogOf({ packs: [{ id: "pixelpepe", name: "P", stickers: [{ id: "happy", name: "Bad]\n[sticker:pixelpepe/happy\u202e" },
                                                                            { id: "sad", name: "Coder " + zwj + "\u200b\u2066" }] }] }));
  try {
    assert.equal(STK.fallbackText("[sticker:pixelpepe/happy]"), "[sticker: Bad sticker:pixelpepe/happy]");
    // control / bidi / zero-width-space are gone; the joiner stays, so the emoji is still one emoji
    assert.equal(STK.fallbackText("[sticker:pixelpepe/sad]"), "[sticker: Coder " + zwj + "]");
  } finally { STK._setCatalog(); }
  // the reader's language (Telegram alerts, the DM list): the sticker's name from stk.s.*, plain text; English without a t
  const ES = require(path.join(repo, "locales", "es.json"));
  const es = i18n.tFor("es");
  const word = es.has("stk.fallback_word") ? es("stk.fallback_word") : "sticker";
  assert.equal(STK.fallbackText("a [sticker:pixelpepe/happy]", { t: es }), `a [${word}: ${ES["stk.s.pixelpepe.happy"]}]`);
  assert.notEqual(ES["stk.s.pixelpepe.happy"], "Happy Pepe");
  assert.equal(STK.fallbackText("[sticker:miclife/who]", { t: i18n.tFor("en") }), "[sticker: Who's talking?]", "decoded: the catalog's &#39; is an apostrophe");
  assert.equal(STK.fallbackText("[sticker:miclife/who]", { t: () => "x" }), "[sticker: Who's talking?]", "a t with no .has: English");
  // a translated word can never make the stand-in a token again (the space after the colon, no brackets in it)
  const evilT = Object.assign((k) => (k === "stk.fallback_word" ? "sticker:pixelpepe/happy]" : "x"), { has: (k) => k === "stk.fallback_word" });
  const ev = STK.fallbackText("[sticker:pixelpepe/happy]", { t: evilT });
  assert.equal(STK.tokens(ev).length, 0, ev);
});

test("B4: forPepe - house packs listed right now stay stickers (12 at most); out of season, retired and non-house become text", () => {
  // new too (stkfix-text's B4 test shows the old pepeReply storing any token as a sticker)
  assert.equal(typeof STK.forPepe, "function", "Pepe's own filter");
  const both = "a [sticker:pixelpepe/happy] b [sticker:spooky/pumpkin] c [sticker:fake/x]";
  assert.equal(STK.forPepe(both, Date.UTC(2026, 9, 10)), both, "October: Spooky Season is listed");
  assert.equal(STK.forPepe(both, Date.UTC(2026, 11, 1)), "a [sticker:pixelpepe/happy] b [sticker: Jack-o'-lantern] c [sticker:fake/x]", "December: it isn't");
  const many = STK.forPepe("[sticker:patvreacts/gg]".repeat(13), Date.UTC(2026, 11, 1));
  assert.equal(STK.tokens(many).length, STK.MAX_PER_TEXT);
  assert.ok(many.endsWith("[sticker: GG]"), "the 13th is text");
  // retired, and a pack that isn't the house's (pad / member packs, later)
  const cat = catalogOf({ packs: [{ id: "pixelpepe", name: "P", retired: true, stickers: [{ id: "happy", name: "Happy Pepe" }] },
                                  { id: "kawaiipond", name: "K", stickers: [{ id: "blush", name: "Blushing" }] }] });
  const notHouse = Object.freeze({ ...cat.byId.kawaiipond, house: false });
  STK._setCatalog({ packs: [cat.byId.pixelpepe, notHouse], byId: { pixelpepe: cat.byId.pixelpepe, kawaiipond: notHouse } });
  try {
    assert.equal(STK.forPepe("[sticker:pixelpepe/happy] [sticker:kawaiipond/blush]"), "[sticker: Happy Pepe] [sticker: Blushing]");
  } finally { STK._setCatalog(); }
});

test("B5: GET /api/stickers answers in the viewer's language (stk.* keys, plain text); English from en.json, decoded", async () => {
  const get = (lang) => fetch(base + "/api/stickers", { headers: lang ? { "accept-language": lang } : {} }).then((r) => r.json());
  const es = await get("es");
  const ES = require(path.join(repo, "locales", "es.json"));
  const pp = es.packs.find((p) => p.id === "pixelpepe");
  assert.equal(pp.name, ES["stk.pack.pixelpepe.name"]);
  assert.equal(pp.stickers.find((s) => s.id === "happy").name, ES["stk.s.pixelpepe.happy"]);
  assert.notEqual(ES["stk.s.pixelpepe.happy"], "Happy Pepe", "a real translation");
  assert.equal(pp.stickers[0].token, "[sticker:pixelpepe/happy]", "tokens are never translated");
  const en = await get("en");
  const mic = en.packs.find((p) => p.id === "miclife");
  assert.equal(EN["stk.s.miclife.who"], "Who&#39;s talking?", "the catalog's text is HTML-safe…");
  assert.equal(mic.stickers.find((s) => s.id === "who").name, "Who's talking?", "…the API's is plain (the picker escapes it)");
  assert.equal(STK.localize({ packs: [] }, null).packs.length, 0, "no t: as it is");
});

test("B5: the picker's own words are js.stk.* (defaults equal en.json); no English-only text left in it", () => {
  const js = src("public", "js", "stickers.js");
  const keys = ["label", "loading", "failed", "signin", "none", "none_free", "get_one", "more"];
  for (const k of keys) {
    const m = new RegExp("_t\\('js\\.stk\\." + k + "', '([^']*)'\\)").exec(js);
    assert.ok(m, "uses js.stk." + k);
    assert.equal(m[1], EN["js.stk." + k], "js.stk." + k + " default equals en.json");
  }
  for (const old of ["'<p>Loading stickers…</p>'", "'<p>Sign in to use stickers.</p>'", ">More packs…</a>", "'aria-label', 'Stickers'"]) {
    assert.ok(!js.includes(old), "no hard-coded " + old);
  }
  // the empty state is one sentence per case with the link as {!link} (not pieces glued together)
  for (const k of ["js.stk.none", "js.stk.none_free"]) assert.match(EN[k], /^No sticker packs yet\. 🧸 \{!link\}/, k);
});

/**
 * The picker (public/js/stickers.js) in a small fake page: a textarea, its 🧸 button, document / window, and `answers` for
 * GET /api/stickers in turn ({throw: true} = a network error). -> {click, html, fetches, clicks (document click listeners)}
 */
function pickerPage(answers) {
  const vm = require("vm");
  const listeners = {};
  let fetches = 0, last = null;
  function El(tag) {
    const e = { tagName: String(tag).toUpperCase(), attrs: {}, style: {}, children: [], innerHTML: "", className: "", removed: false,
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; }, remove() { this.removed = true; },
      getBoundingClientRect() { return { left: 10, right: 40, top: 500, bottom: 520 }; }, offsetWidth: 300, offsetHeight: 200,
      querySelector() { return null; }, addEventListener() {}, contains() { return false; }, focus() {},
      closest(sel) { return sel === "[data-sticker-picker]" && this.attrs["data-sticker-picker"] ? this : null; } };
    if (e.tagName === "DIV") last = e;
    return e;
  }
  const ta = El("textarea");
  const btn = El("button");
  btn.setAttribute("data-sticker-picker", "#ta");
  const document = { head: El("head"), body: El("body"), getElementById: () => null, createElement: El,
    querySelector: (s) => (s === "#ta" ? ta : null), addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); } };
  const window = { innerWidth: 1000, innerHeight: 800, addEventListener() {} };
  const fetch = () => {
    const a = answers[Math.min(fetches++, answers.length - 1)];
    return a && a.throw ? Promise.reject(new Error("offline")) : Promise.resolve({ status: a.status || 200, json: () => Promise.resolve(a) });
  };
  const ctx = vm.createContext({ window, document, fetch, Event: function () {} });
  const code = src("public", "js", "stickers.js");
  vm.runInContext(code, ctx);
  vm.runInContext(code, ctx);                         // the page loads the picker twice (post.ejs + a partial)
  const settle = () => new Promise((r) => setImmediate(r));
  return {
    clicks: () => (listeners.click || []).length,
    fetches: () => fetches,
    async click() { for (const fn of listeners.click || []) fn({ target: btn, preventDefault() {} }); for (let i = 0; i < 5; i++) await settle(); },
    html: () => (last && !last.removed ? last.innerHTML : null),
  };
}

test("B5 / B6: the picker - loaded twice it listens once; an error answer says it couldn't load (never 'Sign in') and isn't kept", async () => {
  const page = pickerPage([{ ok: false, code: "E_INTERNAL", error: "Something went wrong.", status: 500 },
                           { ok: true, signed: true, packs: [], allowance: { left: 1 } }]);
  assert.equal(page.clicks(), 1, "one click listener for two copies of the script (else a click opens and closes the panel)");
  await page.click();
  assert.equal(page.html(), "<p>" + EN["js.stk.failed"] + "</p>");
  assert.doesNotMatch(page.html(), /Sign in/);
  await page.click();                                   // the same button again: closes
  assert.equal(page.html(), null);
  await page.click();                                   // and opens: asks again (the error wasn't kept)
  assert.equal(page.fetches(), 2);
  assert.equal(page.html(), '<p>No sticker packs yet. 🧸 <a href="/premium#stickers">Get one</a> - your 🎟️ Season Pass has a free one waiting.</p>');
  await page.click(); await page.click();
  assert.equal(page.fetches(), 2, "a good answer is kept");
  const none = pickerPage([{ ok: true, signed: true, packs: [], allowance: { left: 0 } }]);
  await none.click();
  assert.equal(none.html(), '<p>No sticker packs yet. 🧸 <a href="/premium#stickers">Get one</a>.</p>');
  const out = pickerPage([{ ok: true, signed: false, packs: [] }]);
  await out.click();
  assert.equal(out.html(), "<p>" + EN["js.stk.signin"] + "</p>", "signed out: Sign in");
  const net = pickerPage([{ throw: true }]);
  await net.click();
  assert.equal(net.html(), "<p>" + EN["js.stk.failed"] + "</p>");
});

test("B6: the comment box and every reply box have the 🧸 picker, each pointing at its own textarea; post.ejs loads the picker", () => {
  const post = src("views", "post.ejs");
  assert.match(post, /<form class="cm-new composer"[^]*?data-sticker-picker="form\.cm-new textarea\[name=body\]"[^]*?<\/form>/);
  assert.match(post, /<% if \(signed\) \{ %><script src="\/public\/js\/stickers\.js\?v=2" defer><\/script><% \} %>/);
  const cm = src("views", "partials", "feed-comment.ejs");
  const reply = /<form class="cm-replyf[^]*?<\/form>/.exec(cm)[0];
  assert.match(reply, /<textarea name="body" id="cmr-<%= c\.id %>"/);
  assert.match(reply, /data-sticker-picker="#cmr-<%= c\.id %>"/);
  // ids are letters / digits (feedstore newId), so "#cmr-<id>" is a valid selector
  assert.match(src("feedstore.js"), /const newId = \(n = 12\) => crypto\.randomBytes\(16\)\.toString\("base64url"\)\.replace\(\/\[-_\]\/g, ""\)/);
  for (const v of [src("views", "messages.ejs"), src("views", "partials", "feed-composer.ejs")]) assert.ok(v.includes("/public/js/stickers.js?v=2"), "the cache key moved on");
});

test("B6: rendered - each comment's reply box has its own 🧸 button aimed at its own textarea (a reply has no reply box)", async () => {
  const ejs = require("ejs");
  const fx = new Proxy({}, { get: () => () => "" });       // avatar / name / icon / body helpers: not what this checks
  const mk = (id, replies = []) => ({ id, author: { username: "bob", display: "Bob" }, body: "hi", created: t, replies, ups: 0, downs: 0, score: 0 });
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "feed-comment.ejs"),
    { c: mk("abcDEF123", [mk("kid456")]), p: { id: "post1", author: { username: "ann" } }, fx, viewer: "ann", staff: false, modRooms: new Set() });
  const forms = html.match(/<form class="cm-replyf[^]*?<\/form>/g) || [];
  assert.equal(forms.length, 1, "one reply box (the reply itself has none)");
  assert.match(forms[0], /<textarea name="body" id="cmr-abcDEF123"/);
  assert.match(forms[0], /<button type="button" class="btn-g cm-stk" data-sticker-picker="#cmr-abcDEF123" aria-expanded="false"/);
  assert.doesNotMatch(html, /cmr-kid456/);
});

test("B7: /stickers - Pepe's Pad links it, and it goes to the sticker store (no 404)", async () => {
  assert.match(src("tools", "setup-pepes-pad.js"), /Stickers: \/stickers/);
  const r = await fetch(base + "/stickers", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "/cosmetics?tab=stickers");
  assert.match(src("cosmetics.js"), /app\.get\("\/cosmetics", addUser/, "the store page exists");
});

test("B8: a retired pack refuses with 410 and E_TARGET_NOT_FOUND (not the catch-all E_REFUSED)", async () => {
  assert.equal(new STK.Refuse(410, "x").code, "E_TARGET_NOT_FOUND");
  const OLD = stickersWith({ packs: [{ id: "pixelpepe", name: "Pixel Pepe", retired: true, stickers: [{ id: "happy", name: "Happy Pepe" }] }] });
  OLD._setClock(() => t);
  let err = null;
  await OLD.buy({ userId: "u-ann", username: "ann" }, { pack: "pixelpepe", ref: "retired-pack-1" }).catch((e) => { err = e; });
  assert.ok(err && err.refuse, "refused");
  assert.equal(err.status, 410);
  assert.equal(err.code, "E_TARGET_NOT_FOUND");
  const body = PR.errBody(err).body;
  assert.equal(body.code, "E_TARGET_NOT_FOUND");
  assert.match(body.error, /isn't sold any more/);
});
