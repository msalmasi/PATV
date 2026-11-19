"use strict";
// 1.99aot gifs: the privacy policy's GIFs (KLIPY) text as the owner approved it on 2026-11-19 (GIFs free mode - KLIPY's free plan),
// adjusted only to the owner's "no filter" decision of the same day (KLIPY's rules: Search and Trending results shown as KLIPY gives
// them): members no longer get the list of removed GIFs with the page, so the draft's sentence saying they do is gone.
//   section 7 "Who we share it with" - the GIFs (KLIPY) bullet; section 3 - "GIFs in the chat"; section 9 - two rows; section 14 - the
//   dated note; "Last updated" (terms.js PRIVACY_UPDATED) 24 November 2026, the planned prod day.
// What the text says about the code is pinned where the code is tested: the line's stored details (gf = src, w, h, title, r) and the
// block row's columns (id, at, room, kind, slug, mk) in gifs-free.test.js, the page data without any list (k, r, n) in gifs-free.test.js
// and gifs-free-line.test.js, the notice record and its deletion with the account in gifs-free.test.js / accountdelete.
//   NODE_PATH=G:/PATV/node_modules node --test test/gifs-privacy.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path");
const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "gifs-privacy-test-"))); process.env.SECRET_KEY = process.env.SECRET_KEY || "fixture-secret";
const ejs = require("ejs"), terms = require(path.join(repo, "terms"));
const render = (extra) => ejs.renderFile(path.join(repo, "views", "privacy.ejs"), Object.assign({ user: null, title: "Privacy Policy", VERSION: terms.VERSION,
  UPDATED: terms.PRIVACY_UPDATED, enforced: false, chatlog: null, hubErasure: null, micrec: null, memory: null, privwire: null, evidence: null, policyDates: {} }, extra || {}));
const plainOf = (page, re) => { const m = page.match(re); assert.ok(m, String(re)); return m[0].replace(/<br>/g, " ").replace(/<[^>]+>/g, "").trim(); };

const SECTION7 = "GIFs (KLIPY): When GIFs are turned on in a pad's chat, GIF search is provided by KLIPY. When you open the GIF picker, search or browse GIFs, your browser sends what you type in the GIF search and your IP address directly to KLIPY, along with the information every browser sends, such as your browser type. When you send a GIF, your browser also tells KLIPY which GIF was shared and the words you searched for. We don't send KLIPY your name, your account, or any other identifier for you. Before your first GIF search we show you a one-time notice about this. KLIPY's own privacy policy covers what it receives: https://klipy.com/support/privacy-policy. Everyone who sees a GIF loads it from KLIPY. GIFs in a pad's chat are never copied to our servers. Your browser loads each GIF straight from KLIPY's servers, so KLIPY receives your IP address and browser information when you view a chat that has a GIF in it. This applies even if you never use the GIF picker, the same as any picture loaded from another site.";
const SECTION3 = "GIFs in the chat: A GIF sent in a pad's chat is kept with that chat line like any other message, under the same rules for hiding, deleting and keeping it. We keep the GIF's link, size, title and the content rating it was chosen under, but never the picture itself. In the Camfrog room, Pepe posts the GIF's title and a link to its page on KLIPY. Moderators can remove a GIF everywhere on PATV. Our list of removed GIFs contains KLIPY's names for each GIF (its id, its short name and the code of its picture folder), when it was removed, on which pad, and whether a pad owner, a moderator or PATV staff removed it. It has no personal data: no account, no chat line and no reason. The reason a moderator gives stays with the hidden chat line, under that line's rules.";
const CHANGE = "24 November 2026: added GIFs (KLIPY) to sections 3, 7 and 9. GIF search runs from your browser to KLIPY, GIFs load from KLIPY, and this says what we keep with a GIF chat line.";

test("the GIFs (KLIPY) text in sections 7, 3, 9 and 14, as approved - and 'Last updated' 24 November 2026", async () => {
  const page = await render();
  assert.equal(terms.PRIVACY_UPDATED, "24 November 2026"); assert.match(page, /<div class="updated">Last updated 24 November 2026<\/div>/);
  assert.equal(plainOf(page, /<li id="gifs-klipy">[^\n]*<\/li>/), SECTION7);
  assert.match(page, /<a href="https:\/\/klipy\.com\/support\/privacy-policy" rel="noopener noreferrer">https:\/\/klipy\.com\/support\/privacy-policy<\/a>/);
  assert.ok(page.indexOf('id="gifs-klipy"') > page.indexOf("<b>Embedded players:</b>") && page.indexOf('id="gifs-klipy"') < page.indexOf('<section id="cookies">'),
            "section 7, after Embedded players");
  assert.equal(plainOf(page, /<p id="gifs-chat">[^\n]*<\/p>/), SECTION3);
  assert.ok(page.indexOf('id="gifs-chat"') > page.indexOf('<section id="rooms">') && page.indexOf('id="gifs-chat"') < page.indexOf('<h3 id="livecams">'), "section 3");
  assert.equal(plainOf(page, /<tr id="gifs-notice-row">[^\n]*<\/tr>/), "The GIF notice: a record that you saw the GIF search notice, and whenUntil you delete your account");
  assert.equal(plainOf(page, /<tr id="gifs-blocks-row">[^\n]*<\/tr>/), "Removed GIFs: the list of GIFs moderators removed everywhere. It holds no personal dataUntil a PATV admin lifts a removal");
  assert.ok(page.indexOf('id="gifs-notice-row"') > page.indexOf('<section id="retention">') && page.indexOf('id="gifs-blocks-row"') < page.indexOf('<section id="choices">'), "section 9");
  assert.equal(plainOf(page, /<li id="gifs-change">[^\n]*<\/li>/), CHANGE);
  assert.ok(page.indexOf('id="gifs-change"') > page.indexOf('<section id="changes">') && page.indexOf('id="gifs-change"') < page.indexOf("<b>28 October 2026:</b>"),
            "section 14, newest hand-dated note first");
  assert.match(page, /href="#gifs-klipy"/); assert.equal(page.split('id="gifs-klipy"').length, 2, "one anchor");
});

test("the owner's no-filter decision: the policy never says the picker gets the list of removed GIFs or leaves GIFs out", async () => {
  const page = await render();
  assert.doesNotMatch(page, /newest entries|leave those GIFs out|picker can leave|with the page, so/);
  // the code agrees: no list rides with the page data (gifs.pageData = {k, r, n}) - pinned in gifs-free.test.js; here, by its source
  const src = fs.readFileSync(path.join(repo, "gifs.js"), "utf8");
  assert.match(src, /return \{ k: publicKey\(\), r: ratingFor\(roomId\), n: noticeSeen\(userId\) \};/);
  assert.doesNotMatch(src, /pageBlocks|BLOCK_PAGE_MAX/);
});

test("always shown - with or without the other switches' text - and the same words in every variant", async () => {
  for (const extra of [{}, { privwire: { on: true, g: Date.UTC(2026, 9, 28, 12), g_day: "28 October 2026" } }, { memory: { on_at: Date.UTC(2026, 9, 28), on_day: "28 October 2026" } }]) {
    const page = await render(extra);
    assert.equal(plainOf(page, /<li id="gifs-klipy">[^\n]*<\/li>/), SECTION7, JSON.stringify(extra));
    assert.equal(plainOf(page, /<p id="gifs-chat">[^\n]*<\/p>/), SECTION3);
    assert.equal(plainOf(page, /<li id="gifs-change">[^\n]*<\/li>/), CHANGE);
  }
  // the golden comparisons with older commits take exactly these lines out (test/fixtures/padppl-privacy.js gifsOut)
  const page = await render(), out = require("./fixtures/padppl-privacy").gifsOut(page);
  for (const id of ["gifs-klipy", "gifs-chat", "gifs-notice-row", "gifs-blocks-row", "gifs-change"]) assert.ok(page.includes('id="' + id + '"') && !out.includes('id="' + id + '"'), id);
  assert.equal(page.split("\n").length - out.split("\n").length, 5, "five whole lines, nothing else");
});
