// Offline tests for the member guide to formatting messages in PATV Chat (chatformat.js, views/chatFormatting.ejs,
// 1.99aem):
//   * /help/formatting is public and renders every form of chatformat.FORMS as a row (#fmt-<id>), with what to type,
//     how PATV shows it and what a bridged chat shows; no raw i18n keys
//   * the previews are drawn from fixed tags: a sample's words are escaped, a typed mark never becomes HTML
//   * the forms the chat platform supports are all here (the composer's markdown-lite, ADR 0004 "Formatting as built"),
//     and none it doesn't (no time form: the chat has no <t:...> syntax since the W-format review)
//   * the bridged column says what a bridge WILL show (no PATV Chat pad is bridged yet), no link previews are promised,
//     and the spoiler's preview is a disclosure a screen reader and a tap can open (details/summary)
//   * every string the page uses is in en.json; /help links to the guide (its intro and its footer)
//   NODE_PATH=G:/PATV/node_modules node --test test/chatformat.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const express = require("express");
const CF = require(path.join(repo, "chatformat"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

let base, server;
test.before(async () => {
  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => { req.user = req.get("x-test-user") ? { username: req.get("x-test-user") } : null; next(); };
  CF.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
const page = (p, u) => fetch(base + p, { headers: u ? { "x-test-user": u } : {} }).then(async (r) => ({ status: r.status, text: await r.text(), cc: r.headers.get("cache-control") }));

test("the guide is public, renders every form as a row with its example, preview and bridge text, no raw keys", async () => {
  const r = await page("/help/formatting");
  assert.equal(r.status, 200, r.text.slice(0, 400));
  assert.match(r.cc, /private/, "the layout carries the viewer's name: never a shared cache");
  for (const f of CF.FORMS) {
    assert.ok(r.text.includes(`id="fmt-${f.id}"`), "row " + f.id);
    assert.ok(en["chatfmt.f." + f.id], "name " + f.id);
    assert.ok(en["chatfmt.bridge." + f.bridge], "bridge text " + f.id);
    if (f.w == null) assert.ok(en["chatfmt.w." + f.id], "sample word " + f.id);
  }
  for (const id of ['id="forms"', 'id="bar"', 'id="bridges"', 'id="not"', 'href="/help"']) assert.ok(r.text.includes(id), id);
  assert.ok(!r.text.includes('id="times"') && !r.text.includes('id="fmt-time"'), "no time form");
  const body = r.text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  assert.ok(!/\b(chatfmt|help)\.[a-z_]+(\.[a-z0-9_]+)*\b/i.test(body.replace(/<[^>]+>/g, " ")), "no raw keys");
  // the bridged column is about later (no PATV Chat pad is bridged yet) and names Camfrog as one network among others
  assert.match(body, /Bridged chats will show/);
  assert.match(body, /Camfrog first, more networks/);
  assert.ok(!/Camfrog today/.test(body), "no pad is bridged today");
  // no preview is promised (PATV Chat shows none yet), and there is no Link button
  assert.ok(!/with a preview of the page/.test(body));
  assert.match(body, /There is no Link button/);
  assert.ok(!/Quote and Link/.test(body));
  // the keyboard line names Aa (its placeholder filled)
  assert.ok(!body.includes("{!aa}"), "every placeholder filled");
});

test("the previews are fixed tags around escaped words; a typed mark is shown, never run", async () => {
  const r = await page("/help/formatting");
  const row = (id) => {
    const m = new RegExp(`<tr id="fmt-${id}">([\\s\\S]*?)</tr>`).exec(r.text);
    assert.ok(m, "row " + id);
    return m[1];
  };
  assert.match(row("bold"), /<code class="cf-mark">\*\*bold\*\*<\/code>/);
  assert.match(row("bold"), /<strong>bold<\/strong>/);
  assert.match(row("italic"), /\*italic\*<\/code><span class="cf-or">or<\/span><code class="cf-mark">_italic_<\/code>/);
  assert.match(row("underline"), /<u>underlined<\/u>/);
  // a disclosure: the hint is the summary (what a screen reader hears first), the words its content
  assert.match(row("spoiler"), /<details class="cf-spoiler"><summary>Spoiler: tap or click to show<\/summary><span>the ending<\/span><\/details>/);
  assert.match(row("spoiler"), /\[spoiler\]/);
  assert.match(row("quote"), /<code class="cf-mark">&gt; best stream all week<\/code>/);
  assert.match(row("quote"), /<blockquote class="cf-quote">best stream all week<\/blockquote>/);
  assert.match(row("codeblock"), /```js\nconsole\.log\(&#34;gg&#34;\);\n```/);
  assert.match(row("nopreview"), /&lt;https:\/\/publicaccess\.tv&gt;/);
  assert.match(row("escape"), /\\\*not italic\\\*/);
  assert.match(row("escape"), /2\\\*3\\\*4/, "the sums example");
  assert.match(row("italic"), /2\*3\*4 shows the 3 in italics/);
  // nothing a member could type turns into markup on the page
  assert.ok(!/<t:/.test(r.text) && !/<https:/.test(r.text), "the angle-bracket forms are escaped");
});

test("the guide lists every form the chat's markdown-lite supports, and no other", () => {
  const ids = CF.FORMS.map((f) => f.id);
  for (const id of ["bold", "italic", "bolditalic", "underline", "strike", "spoiler", "code", "codeblock", "quote", "quoteall", "link", "nopreview", "mention", "everyone", "emoji", "escape"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(!ids.includes("time") && CF.TIME_STYLES === undefined, "no time form");
  assert.ok(!Object.keys(en).some((k) => k.startsWith("chatfmt.time")), "no time strings left");
  assert.deepEqual(CF.typed(CF.FORMS.find((f) => f.id === "quote"), (k) => en[k]), ["> best stream all week"]);
});

test("every key the view asks for is in en.json, and /help links to the guide", () => {
  const src = fs.readFileSync(path.join(repo, "views", "chatFormatting.ejs"), "utf8");
  // whole keys (a key built from a prefix, t('chatfmt.f.' + id), is checked per form above)
  for (const m of src.matchAll(/\bt\('((?:chatfmt|help)\.[a-z0-9_.]*[a-z0-9_])'\s*[,)]/gi)) assert.ok(m[1] in en, m[1] + " in en.json");
  const help = fs.readFileSync(path.join(repo, "views", "help.ejs"), "utf8");
  assert.ok(help.includes('href="/help/formatting"'), "/help links to the guide");
  assert.ok(en["help.formatting_note"].includes("{!link}"), "the note's link is a raw placeholder");
  ejs.compile(src, { filename: path.join(repo, "views", "chatFormatting.ejs") });
});
