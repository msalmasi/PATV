// stkimg 1.99?? (owner 2026-11-05: "new camfrog stickers get added ... but when do they get 'loaded'"): a Camfrog sticker's chat line can
// reach the page ~30 s before Pepe uploads a picture the site hasn't seen (pepe_sticker.py STICKER_SYNC_SOON; his 10-minute sync if that
// one was missed), so the line's first request 404s. chatlog-core.js (every chat renderer: the pad page and its chat window, the homepage
// Dock, scrollback / search) shows the line's words and asks again ~35 s, ~90 s and ~11 min after that miss under a fresh ?r=, one timer
// per image, none once the line has left the page, words for good after the last miss, and only for a line under 10 minutes old; a line
// that misses (or whose timer fires for) a picture the page already got takes that URL. pad-picker.js asks for src + "?v=" + v (the
// picture's version) and for a failed Camfrog tile once more (a fresh ?r=) the next time the sheet shows it. The server side (the v field
// beside the plain src, ?v / ?r ignored, no-store misses) is in test/cfstickers.test.js.
//   node --test test/stkimg-retry.test.js            (no database)
"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Document, Element, Event } = require("./fixtures/pad-dock/dom.cjs");
const corePath = path.join(__dirname, "..", "public", "js", "chatlog-core.js"), coreSource = fs.readFileSync(corePath, "utf8");
const CL = require(corePath);
if (!Element.prototype.replaceChild) Element.prototype.replaceChild = function (next, old) { this.insertBefore(next, old); this.removeChild(old); return old; };

const MIN = 60000, T0 = Date.UTC(2026, 10, 5, 6, 9, 41);
// a fresh copy of chatlog-core.js on a clock the test moves (new Date() with no argument = clock.now; with one, a real Date)
function coreOn(clock) {
  const Real = Date;
  function Fake(...a) { return a.length ? new Real(...a) : new Real(clock.now); }
  Fake.now = () => clock.now; Fake.UTC = Real.UTC; Fake.parse = Real.parse; Fake.prototype = Real.prototype;
  const box = { module: { exports: {} }, Date: Fake };
  vm.runInNewContext(coreSource, box, { filename: corePath });
  return box.module.exports;
}
function page() {
  const clock = { now: T0 }, core = coreOn(clock), doc = new Document(), timers = [], asked = [];
  doc.defaultView = { setTimeout(fn, ms) { timers.push({ fn, ms, at: clock.now + ms }); return timers.length; } };
  const ctx = { cfsticker: (set, id) => "/media/cfsticker/" + id + ".webp" };
  let c = 0;
  const line = (id, ts) => {
    const n = core.renderItem({ k: "msg", c: ++c, ts: ts === undefined ? clock.now : ts, u: { login: "aster_fable", display: "Aster Fable" }, text: "[cfsticker:1642/" + id + "]", md: "cfsticker" }, ctx, core.domH(doc));
    doc.body.appendChild(n); return { n, img: n.querySelector("img.cfstk") };
  };
  // the next timer, at its moment
  const run = () => { timers.sort((a, b) => a.at - b.at); const t = timers.shift(); assert.ok(t, "a retry is waiting"); clock.now = t.at; t.fn(); return t; };
  return { clock, doc, timers, line, run, wait: ms => { clock.now += ms; } };
}
const fail = img => img.dispatchEvent(new Event("error")), got = img => img.dispatchEvent(new Event("load"));

test("stkimg: a sticker line whose picture 404s shows its words, asks again ~35 s, ~90 s and ~11 min after the miss under fresh ?r= URLs, and draws when it comes", () => {
  const p = page(), { n, img } = p.line(9001);
  assert.equal(img.getAttribute("src"), "/media/cfsticker/9001.webp"); assert.equal(img.getAttribute("loading"), "lazy");
  fail(img);                                                         // the line beat Pepe's upload: 404
  assert.equal(n.querySelector("img"), null, "no broken picture"); assert.match(n.textContent, /\[sticker\]/, "the line's own words while it waits");
  assert.equal(p.timers.length, 1); assert.equal(p.timers[0].ms, 35000);
  assert.equal(p.run().at - T0, 35000);
  const first = img.src;
  assert.match(first, /^\/media\/cfsticker\/9001\.webp\?r=1\.[0-9a-z]+$/, "a URL this page never asked for");
  assert.equal(img.getAttribute("loading"), null, "asked for now - a detached lazy image would never load");
  assert.equal(p.timers.length, 0, "one timer per image at a time");
  fail(img);                                                         // still not uploaded
  assert.equal(p.timers.length, 1); assert.equal(p.timers[0].at - T0, 90000, "~90 s after the miss, not 90 s after the first retry");
  p.run();
  const second = img.src;
  assert.match(second, /^\/media\/cfsticker\/9001\.webp\?r=2\.[0-9a-z]+$/); assert.notEqual(second, first);
  fail(img);                                                         // Pepe's quick upload was missed: his 10-minute sync
  assert.equal(p.timers.length, 1); assert.equal(p.timers[0].at - T0, 11 * MIN);
  p.run();
  assert.match(img.src, /^\/media\/cfsticker\/9001\.webp\?r=3\.[0-9a-z]+$/); assert.notEqual(img.src, second);
  got(img);                                                          // the upload landed: 200
  assert.equal(n.querySelector("img.cfstk"), img, "the picture takes the words' place"); assert.doesNotMatch(n.textContent, /\[sticker\]/);
  assert.equal(p.timers.length, 0, "nothing more scheduled");
  // the next line of the same sticker that misses takes the URL this page already got, at once (no 35 s wait)
  const again = p.line(9001); fail(again.img);
  assert.equal(again.img.src, img.src); assert.equal(p.timers.length, 0);
  got(again.img); assert.equal(again.n.querySelector("img.cfstk"), again.img);
});

test("stkimg: bounded - three retries then words for good; a slow miss never asks at once; a line that left the page asks nothing; a picture that loads at once schedules nothing", () => {
  const p = page(), { n, img } = p.line(9002), urls = [img.getAttribute("src")];
  fail(img); p.run(); urls.push(img.src); fail(img); p.run(); urls.push(img.src); fail(img); p.run(); urls.push(img.src); fail(img);
  assert.equal(p.timers.length, 0, "no fourth retry, no loop"); assert.match(n.textContent, /\[sticker\]/); assert.equal(n.querySelector("img"), null);
  assert.equal(new Set(urls).size, 4, "four requests in all, each its own URL");
  // a retry whose answer comes after the next moment (a slow network): the next one waits at least a second, never a burst
  const slow = p.line(9007); fail(slow.img); p.run(); p.wait(70000); fail(slow.img);
  assert.equal(p.timers.length, 1); assert.equal(p.timers[0].ms, 1000); p.timers.length = 0;
  const gone = p.line(9003); fail(gone.img); const before = gone.img.src;
  gone.n.remove(); p.run();
  assert.equal(gone.img.src, before, "no request for a line no longer on the page"); assert.equal(p.timers.length, 0, "and nothing after it");
  const fine = p.line(9004); got(fine.img);
  assert.equal(p.timers.length, 0); assert.equal(fine.n.querySelector("img.cfstk"), fine.img);
  // outside a browser window (no defaultView - Node, the old renderer tests) it is the words, as before, and no timer exists
  const bare = new Document(), quiet = CL.renderItem({ k: "msg", ts: Date.now(), u: { display: "A" }, text: "[cfsticker:1/9005]", md: "cfsticker" }, { cfsticker: (s, id) => "/media/cfsticker/" + id + ".webp" }, CL.domH(bare));
  bare.body.appendChild(quiet); fail(quiet.querySelector("img")); assert.match(quiet.textContent, /\[sticker\]/); assert.equal(quiet.querySelector("img"), null);
});

test("stkimg: only a new line waits for its picture - a line over 10 minutes old (scrollback, search, the 📜 card) asks once, as before", () => {
  const p = page();
  const old = p.line(9010, T0 - 11 * MIN); fail(old.img);
  assert.match(old.n.textContent, /\[sticker\]/); assert.equal(p.timers.length, 0, "a picture that never came: no retries");
  const recent = p.line(9011, T0 - 9 * MIN); fail(recent.img);
  assert.equal(p.timers.length, 1, "9 minutes old: it may still come (Pepe's 10-minute sync)"); p.timers.length = 0;
  const ahead = p.line(9012, T0 + 5 * MIN); fail(ahead.img);
  assert.equal(p.timers.length, 1, "a clock behind the server's: new"); p.timers.length = 0;
  for (const ts of [null, 0, "x"]) { const odd = p.line(9013, ts); fail(odd.img); assert.equal(p.timers.length, 1, "no time on the line: new (" + ts + ")"); p.timers.length = 0; }
  // the age is the line's at its first miss: a lazy picture first asked for when scrolled to, 12 minutes on
  const lazy = p.line(9014); p.wait(12 * MIN); fail(lazy.img);
  assert.equal(p.timers.length, 0);
});

test("stkimg: a line whose timer fires after another line got the picture takes that URL, not a new ?r=", () => {
  const p = page();
  const C = p.line(9020); fail(C.img);                               // misses at 0 s: its retry at 35 s
  p.wait(20000); const D = p.line(9020); fail(D.img);                // misses at 20 s: its retry at 55 s
  assert.equal(p.timers.length, 2);
  p.run(); assert.match(C.img.src, /\?r=1\./); got(C.img);           // 35 s: Pepe's upload is there
  const t = p.run(); assert.equal(t.at - T0, 55000);
  assert.equal(D.img.src, C.img.src, "the URL the page already got"); got(D.img);
  assert.equal(D.n.querySelector("img.cfstk"), D.img); assert.equal(p.timers.length, 0);
  // one that misses even with that URL goes on with its own retries (never the same URL twice)
  const E = p.line(9020); fail(E.img); assert.equal(E.img.src, C.img.src); fail(E.img);
  assert.equal(p.timers.length, 1); p.run(); assert.notEqual(E.img.src, C.img.src); assert.match(E.img.src, /\?r=1\./);
});

test("stkimg: the HTML (downloads, server) render has no retry machinery, no inline handler and the unchanged picture URL", () => {
  const html = String(CL.renderItem({ k: "msg", c: 1, ts: 0, u: { display: "A" }, text: "[cfsticker:1642/9006]", md: "cfsticker" }, { cfsticker: (s, id) => "/media/cfsticker/" + id + ".webp" }, CL.htmlH));
  assert.match(html, /class="cfstk" src="\/media\/cfsticker\/9006\.webp" alt="sticker" width="100" height="100" loading="lazy" decoding="async"/);
  assert.doesNotMatch(html, /onerror|onload|\?r=/);
  // GIFs and the site's own 🧸 stickers keep the one-shot fallback (only Camfrog pictures can arrive late)
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "chatlog-core.js"), "utf8");
  assert.match(src, /\[stickerImage\(\{ 'class': 'cfstk'/); assert.match(src, /\[mediaImage\(\{ 'class': 'pstk'/); assert.match(src, /mediaImage\(\{ 'class': 'gif'/);
  // every page that loads the renderer asks for the new copy
  for (const f of ["views/room.ejs", "views/home.ejs", "views/partials/pad-chat-history.ejs"])
    assert.ok(fs.readFileSync(path.join(__dirname, "..", f), "utf8").includes('<script src="/public/js/chatlog-core.js?v=15"></script>'), f);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "views/room.ejs"), "utf8").includes('<script src="/public/js/pad-picker.js?v=4"></script>'));
  for (const f of ["public/js/home-dock.js", "views/room.ejs", "views/partials/pad-chat-history.ejs"])
    assert.match(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), /cfsticker: function \(set, id\) \{ return '\/media\/cfsticker\/' \+ id \+ '\.webp'; \}/, f + " builds the line's URL for chatlog-core");
});

// ── pad-picker.js: the Camfrog tab ──
const pickerSource = fs.readFileSync(path.join(__dirname, "..", "public", "js", "pad-picker.js"), "utf8");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function picker(lists) {
  const doc = new Document(), root = doc.createElement("main"); doc.body.appendChild(root);
  const input = doc.createElement("input"); root.appendChild(input);
  let n = 0; const win = { URL, fetch() { const rows = lists[Math.min(n++, lists.length - 1)]; return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) }); } };
  vm.runInNewContext(pickerSource, { window: win });
  let sheet;
  const p = win.PATVPadPicker.open({ root, signed: true, slug: "night-orchard", data: { room: { relay: true, cfstickerPicker: true } }, tab: "stickers",
    relay: { getInput: () => input, _send: () => true, insert: () => true }, sheet() { sheet = doc.createElement("section"); root.appendChild(sheet); return sheet; }, closeLayer() {} });
  const tab = () => p.tabs.find(x => x.id === "stickers").button;
  return { get img() { return sheet.querySelector(".rmp-grid img"); }, reopen: async () => { p.tabs.find(x => x.id === "emoji").button.click(); tab().click(); await flush(); }, get fetches() { return n; } };
}
// the server's row: the plain src beside the picture's version (cfstickers.js get())
const row = v => [{ id: 10091662, set: 1642, desc: "New frog", src: "/media/cfsticker/10091662.webp", v }];

test("stkimg: a Camfrog tile asks for ?v= its picture; a failed one asks once more under a fresh ?r= the next time the sheet shows it; a new picture's URL replaces it", async () => {
  const h = picker([row("0a1b2c3d"), row("0a1b2c3d"), row("0a1b2c3d"), row("9f8e7d6c")]); await flush();
  assert.equal(h.img.src, "/media/cfsticker/10091662.webp?v=0a1b2c3d");
  h.img.dispatchEvent(new Event("error")); assert.equal(h.img.hidden, true, "the caption stays");
  await h.reopen();
  const retry = h.img.src;
  assert.match(retry, /^\/media\/cfsticker\/10091662\.webp\?v=0a1b2c3d&r=[0-9a-z]+$/, "asked for again, never the failed URL");
  h.img.dispatchEvent(new Event("error"));
  await h.reopen();
  assert.equal(h.img.src, retry, "once: no new URL per reopen (it stays its caption)");
  await h.reopen();                                                  // Pepe's new picture: the list's v changed
  assert.equal(h.img.src, "/media/cfsticker/10091662.webp?v=9f8e7d6c", "a new picture is a new URL - no old failure sticks to it");
  assert.equal(h.fetches, 4, "the list is asked for on every showing (no-store)");
});

test("stkimg: a server without v (a rollback) - the tile is the plain URL, as before, and its one retry is ?r=", async () => {
  const h = picker([[{ id: 10091662, set: 1642, desc: "New frog", src: "/media/cfsticker/10091662.webp" }]]); await flush();
  assert.equal(h.img.src, "/media/cfsticker/10091662.webp");
  h.img.dispatchEvent(new Event("error")); await h.reopen();
  assert.match(h.img.src, /^\/media\/cfsticker\/10091662\.webp\?r=[0-9a-z]+$/);
});
