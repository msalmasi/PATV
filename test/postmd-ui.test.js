// The Markdown presentation boundary: stored fmt drives rendering/edit help, while the
// current switch only controls help for new content. No browser or network needed.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const render = (file, locals) => ejs.renderFile(path.join(repo, "views", file + ".ejs"), locals);
const user = { username: "sample", display: "Sample" };
const post = (extra = {}) => Object.assign({
  id: "post12345", title: "Sample title", body: "**sample**", fmt: null,
  author: user, rooms: [], roomsAll: [], url: "/p/sample/posts/post12345",
  images: [], video: [], audio: [], comments: 0, score: 0, ups: 0, downs: 0,
  created: 1700000000000, mine: true,
}, extra);
const comment = (extra = {}) => Object.assign({
  id: "comment1", body: "**reply**", fmt: null, author: user, mine: true,
  created: 1700000000000, score: 0, ups: 0, downs: 0, replies: [],
}, extra);
function helpers(calls = []) {
  return {
    icon: () => "", num: String, ago: () => "now", uav: () => "", uname: () => "Sample",
    postBody: (record, opts) => {
      calls.push({ record, opts });
      return record.fmt === "md" ? "<strong>rendered</strong>" : "**literal**";
    },
  };
}
const common = { embeds: {}, host: "localhost", viewer: user, modRooms: new Set(), can: () => false };
const hasHelp = (html) => /href="\/help\/formatting#posts"/.test(html);

test("post bodies select by stored record, preserve legacy layout and pass the localized spoiler label", async () => {
  for (const fmt of [null, "md"]) {
    const calls = [], q = post({ fmt });
    const html = await render("partials/feed-post-content", { ...common, q, fx: helpers(calls), signed: true, detail_: true, url_: q.url });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].record, q);
    assert.equal(calls[0].opts.spoilerLabel, "Spoiler: show or hide");
    assert.equal(html.includes('class="fp-body post-md"'), fmt === "md");
    assert.equal(html.includes('class="fp-body"'), fmt !== "md");
    assert.ok(html.includes(fmt === "md" ? "<strong>rendered</strong>" : "**literal**"));
  }
});

test("redacted quote bodies never enter the Markdown renderer", async () => {
  const calls = [], q = post({ fmt: "md", quote: { lines: [] }, body: "PRIVATE SOURCE" });
  const html = await render("partials/feed-post-content", { ...common, q, fx: helpers(calls), signed: true, detail_: true, url_: q.url });
  assert.equal(calls.length, 0);
  assert.ok(!html.includes("PRIVATE SOURCE"));
  assert.match(html, /fq-gone/);
});

test("crossposts render the original record's format and preserve its edit format when the switch is off", async () => {
  const original = post({ id: "original1", fmt: "md", mine: false });
  const p = post({ fmt: null, xpost: { post: original } });
  const calls = [];
  const html = await render("partials/feed-post", { ...common, p, fx: helpers(calls), detail: false, markdownEnabled: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].record.fmt, "md");
  assert.match(html, /class="fp-body post-md clamp"/);
  assert.equal(hasHelp(html), false, "the legacy wrapper's edit form stays plain");
  const edit = await render("partials/feed-post", { ...common, p: post({ fmt: "md" }), fx: helpers(), markdownEnabled: false });
  assert.equal(hasHelp(edit), true, "Markdown edit help remains available after rollback");
});

test("new composer help follows the switch without changing the legacy form or showing a live preview", async () => {
  const cp = { rooms: [], user: "sample", caps: { image: 1, audio: 1, audioSecs: 60, video: 1, videoSecs: 60 }, prices: {}, maxImages: 4, chunk: 1024 };
  for (const markdown of [false, true]) {
    const html = await render("partials/feed-composer", { ...common, composer: { ...cp, markdown }, fx: helpers(), next: "/feed", expanded: true });
    assert.equal(hasHelp(html), markdown);
    assert.match(html, /<textarea name="body" maxlength="5000"/);
    assert.ok(!/post-md-preview|markdown-preview/.test(html));
  }
});

test("comments use stored fmt, edit help is sticky, and new reply help follows the switch", async () => {
  for (const fmt of [null, "md"]) {
    for (const markdownEnabled of [false, true]) {
      const c = comment({ fmt }), calls = [];
      const html = await render("partials/feed-comment", { ...common, c, p: post(), fx: helpers(calls), staff: false, reply: false, markdownEnabled });
      assert.equal(calls[0].record, c);
      assert.equal(html.includes('class="cm-body post-md"'), fmt === "md");
      const edit = /<form class="cm-editf[\s\S]*?<\/form>/.exec(html)[0];
      const reply = /<form class="cm-replyf[\s\S]*?<\/form>/.exec(html)[0];
      assert.equal(hasHelp(edit), fmt === "md");
      assert.equal(hasHelp(reply), markdownEnabled);
    }
  }
  const html = await render("partials/feed-comment", {
    ...common, c: comment({ replies: [comment({ id: "reply1", fmt: "md" })] }), p: post(), fx: helpers(), staff: false, reply: false, markdownEnabled: false,
  });
  assert.match(html, /id="c-reply1"[\s\S]*?class="cm-body post-md"/);
});

test("spoiler controls toggle both visibility and accessible state, including dynamically inserted controls", () => {
  const listeners = [], context = { window: {}, document: { addEventListener: (type, cb) => listeners.push({ type, cb }) } };
  const code = fs.readFileSync(path.join(repo, "public/js/post-md.js"), "utf8");
  vm.runInNewContext(code, context);
  vm.runInNewContext(code, context);
  assert.equal(listeners.length, 1, "a second feed asset include must not bind twice");
  assert.equal(listeners[0].type, "click");
  const run = listeners[0].cb;
  run({ target: { closest: () => null } });
  for (let i = 0; i < 2; i++) {
    const content = { hidden: true }, attrs = { "aria-expanded": "false" };
    const button = { nextElementSibling: content, getAttribute: (key) => attrs[key], setAttribute: (key, value) => { attrs[key] = value; } };
    const event = { target: { closest: (selector) => selector === ".postmd-spoiler > button" ? button : null } };
    run(event);
    assert.equal(content.hidden, false);
    assert.equal(attrs["aria-expanded"], "true");
    run(event);
    assert.equal(content.hidden, true);
    assert.equal(attrs["aria-expanded"], "false");
  }
});

test("formatting help documents post blocks separately without adding chat grammar", async () => {
  const cf = require("../chatformat");
  const html = await render("chatFormatting", { user: null, ogBase: "http://test", ...cf });
  const posts = /<section class="cf-sec" id="posts"[\s\S]*?<\/section>/.exec(html)[0];
  for (const id of ["headings", "lists", "quotes", "rule"]) assert.match(posts, new RegExp('id="post-fmt-' + id + '"'));
  assert.match(posts, /## Heading\n### Smaller heading\n#### Smallest heading/);
  assert.match(posts, /Existing entries keep their original format when edited/);
  assert.match(posts, /Chat keeps the formatting described in the chat reference above/);
  assert.ok(!/chatfmt\.[a-z_]/.test(posts));
  assert.equal(cf.FORMS.length, 18, "chat's reference remains its existing 18 forms");
  assert.ok(!cf.FORMS.some((f) => ["headings", "lists", "rule"].includes(f.id)));
});

test("admin and pad moderation excerpts strip Markdown only on stored Markdown entries", () => {
  const md = require("../postmd");
  const fx = { plainBody: (p) => p.fmt === "md" ? md.plain(p.body) : String(p.body || "") };
  for (const file of ["feedAdmin", "padSettings"]) {
    const source = fs.readFileSync(path.join(repo, "views", file + ".ejs"), "utf8");
    const excerpts = source.match(/<%=[^%]*fx\.plainBody\([^%]*%>/g);
    assert.ok(excerpts.length >= 2, file + " exposes both post and comment excerpts");
    for (const excerpt of excerpts) {
      for (const fmt of [null, "md"]) {
        const p = { title: "", body: "## **Readable excerpt**", fmt };
        const html = ejs.render(excerpt, { p, g: { comment: p }, fx });
        assert.equal(html, fmt === "md" ? "Readable excerpt" : "## **Readable excerpt**", file + " " + excerpt);
      }
    }
  }
});
