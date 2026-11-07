// 1.99xm: flair next to a name never hides the pad's name ("this sidebar gets kinda broken when you have multiple flairs on a
// pad, I can't even see the name of the pad").
//   * the chip's name is its own span (.ufl-n) - server (padflair.html / postHtml) and both page-JS builders - so a long
//     flair ellipsizes with the full name in the title instead of being cut mid-letter
//   * the post header / comment head: the flair shrinks first, then the author; the pad (p/<slug>) keeps a minimum width and
//     ellipsizes with its full title on hover; the line never pushes the card wider than the screen
//   NODE_PATH=G:/PATV/node_modules node --test test/flair-layout.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flair-layout-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const ejs = require("ejs");
const PF = require(path.join(repo, "padflair"));
const web = require(path.join(repo, "feedweb"));
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

const LONG = { id: 7, name: "Resident Frog Wrangler Extraordinaire", color: "#ffb74d", ink: "#111111", emoji: "🐸" };
const POSTF = { id: 9, name: "Hot takes from the mic", color: "#ff7043", ink: "#111111", emoji: "🔥" };
const pad = { id: "pepes_pad", slug: "pepes-pad-the-official-frog-pond-hangout", title: "Pepe's Pad - The Official Frog Pond Hangout", removed: false };
const other = { id: "drama", slug: "drama-central", title: "Drama Central", removed: false };
const post = (o = {}) => Object.assign({
  id: "p1", title: "Tonight's mic lineup", body: "hi", created: Date.now() - 3600e3, edited: null, score: 1, comments: 0, ups: 1, downs: 0, myVote: 0,
  nsfw: false, pinned: false, roomHidden: false, pending: false, locked: false, global: false, onProfile: false, inAll: true, deleted: false, hidden: false,
  author: { userId: "u_s", username: "sard0nicgrin", display: "Stevie the Long-Named Night Owl", nameCss: "", avatar: null }, followingAuthor: false,
  mine: false, voted: false, rooms: [pad], roomsAll: [pad], homePad: pad.id, images: [], audio: [], video: [], link: null, xpost: null, crossposts: [],
  xcount: 0, ai: [], capture: null, quote: null, voice: null, tags: [], flair: LONG, postFlair: POSTF, tips: null, boosts: null, url: "/p/x/posts/p1/x" }, o);
const render = (p, ctxRoom, detail) => ejs.renderFile(path.join(repo, "views", "partials", "feed-post.ejs"),
  { p, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test", viewer: { userId: "u_v", username: "v", class: "pleb" }, modRooms: new Set(), detail, ctxRoom });

test("chips: the name is its own span (server + both page-JS builders), escaped, full name in the title", () => {
  const h = PF.html(LONG);
  assert.match(h, /^<span class="ufl" [^>]*title="Pad flair: Resident Frog Wrangler Extraordinaire"><span class="ufl-e" aria-hidden="true" data-e="🐸">🐸<\/span><span class="ufl-n">Resident Frog Wrangler Extraordinaire<\/span><\/span>$/);
  assert.match(PF.html({ ...LONG, name: "<b>", emoji: "" }), /<span class="ufl-n">&lt;b&gt;<\/span>/);
  assert.match(PF.postHtml(POSTF, "/p/x?flair=9#feed"), /^<a class="pfl-post" [^>]*title="Post flair: Hot takes from the mic"><span class="ufl-e" aria-hidden="true" data-e="🔥">🔥<\/span><span class="ufl-n">Hot takes from the mic<\/span><\/a>$/);
  for (const f of [["public", "js", "pad-flair.js"]]) {
    const src = rd(...f);
    assert.match(src, /appendChild\(el\('span', 'ufl-n', f\.name\)\)/, f.join("/") + " builds the name span");
    assert.doesNotMatch(src, /el\('span', 'ufl', f\.name\)/, f.join("/") + " no bare text run");
  }
  // CL5: the pad chat's chips come from the shared renderer (public/js/chatlog-core.js flairNode; room.ejs has no copy)
  const core = rd("public", "js", "chatlog-core.js");
  assert.match(core, /kids\.push\(h\('span', \{ 'class': 'ufl-n' \}, \[f\.name\]\)\);/, "chatlog-core.js builds the name span");
  assert.doesNotMatch(core, /h\('span', \{ 'class': 'ufl'[^}]*\}, \[f\.name\]\)/, "chatlog-core.js: no bare text run");
  assert.ok(!rd("views", "room.ejs").includes("'ufl-n'"), "room.ejs builds no chip of its own");
});

test("post header: the pad's name renders next to a long flair (post page, crosspost on a pad page)", async () => {
  const h = await render(post(), null, true);
  const meta = h.slice(h.indexOf('<div class="fp-meta">'), h.indexOf("</div>", h.indexOf('<div class="fp-meta">')));
  assert.match(meta, /class="ufl"/);
  assert.match(meta, /<span class="fp-where"><a class="fp-room" href="\/p\/pepes-pad-the-official-frog-pond-hangout" title="Pepe&#39;s Pad - The Official Frog Pond Hangout">p\/pepes-pad-the-official-frog-pond-hangout<\/a><\/span>/);
  assert.ok(meta.indexOf('class="ufl"') < meta.indexOf('class="fp-where"'), "flair, then the pad");
  const x = await render(post({ rooms: [pad, other], roomsAll: [pad, other] }), pad.id, false);
  assert.match(x, /class="fp-where"><a class="fp-room" href="\/p\/drama-central"/, "a crosspost names the other pad");
});

test("flair.css: flair gives way first, the pad keeps a minimum and ellipsizes, the line is clipped, cache bumped", () => {
  const css = rd("public", "css", "flair.css");
  assert.match(css, /\.ufl-n \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.ufl-e \{[^}]*flex: none;/);
  assert.match(css, /\.fp-meta, \.cm > \.cm-head \{ overflow: hidden;/);
  const shrink = (sel) => { const m = css.match(new RegExp(sel + " \\{ flex: 0 (\\d+) auto; min-width: ([\\d.]+)(em|ch);")); assert.ok(m, sel); return { k: Number(m[1]), min: m[2] + m[3] }; };
  const fl = shrink("\\.fp-meta > \\.ufl, \\.cm-head > \\.ufl"), au = shrink("\\.fp-meta > \\.fp-author, \\.cm-head > \\.fp-author"), wh = shrink("\\.fp \\.fp-meta > \\.fp-where");
  assert.ok(fl.k > au.k && au.k > wh.k, "flair shrinks before the author, the author before the pad");
  assert.ok(parseFloat(wh.min) >= 8, "the pad keeps a few letters");
  assert.match(css, /\.fp \.fp-meta > \.fp-where \{[^}]*text-overflow: ellipsis;/);
  for (const v of [["views", "room.ejs"], ["views", "padSettings.ejs"], ["views", "partials", "feed-js.ejs"]]) assert.match(rd(...v), /flair\.css\?v=5/, v.join("/"));
  assert.match(rd("views", "partials", "room-feed.ejs"), /pad-flair\.js\?v=4/);
  assert.match(rd("views", "padSettings.ejs"), /pad-flair\.js\?v=4/);
});

// flairfix (owner 11-05: "plex flair icon alignment in bridge"): Segoe UI Emoji draws the 📼 at the bottom of its square, ~1.5 px under
// the other emoji in an 18px pill (2.7 px low at 150%). The chip's emoji is its data-e in every builder, and that glyph alone takes a
// local() Segoe face with a higher line - Windows only (a local() font exists only where it is installed), the rest untouched.
test("flair.css: the Plex 📼 alone takes the Windows-only lifted face; every chip builder tags its emoji; nothing else moves", () => {
  const raw = rd("public", "css", "flair.css"), css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const face = css.match(/@font-face \{ font-family: "PATV Emoji Lift"; ([^}]*)\}/);
  assert.ok(face, "the lifted face");
  assert.match(face[1], /^src: local\("Segoe UI Emoji"\), local\("SegoeUIEmoji"\);/, "Segoe UI Emoji itself, local only");
  assert.doesNotMatch(face[1], /url\(/, "never a download");
  assert.match(face[1], /font-weight: 100 900;/, "no synthetic bold on the 600 chip");
  const a = Number(face[1].match(/ascent-override: (\d+)%/)[1]), d = Number(face[1].match(/descent-override: (\d+)%/)[1]);
  assert.ok(a + d >= 95 && a + d <= 110, "about Segoe's 1.02em emoji square");
  assert.ok(a - d < 93 - 19, "its baseline sits higher in the 12px box than Ubuntu's metrics (93 / 19 %) put it today");
  // the selector is the Plex flair's emoji, and the face falls back to today's stack (so no Segoe = today's pixels)
  const sel = css.match(/\.ufl-e\[data-e\^="\\([0-9A-F]+)"\] \{ ([^}]*)\}/);
  assert.ok(sel, "the 📼 rule");
  assert.equal(String.fromCodePoint(parseInt(sel[1], 16)), PF.plexFlair().emoji);
  assert.equal(sel[2].trim(), 'font-family: "PATV Emoji Lift", var(--ds-font);', "a font only: no transform / top / size - pills keep their sizes");
  assert.match(css, /\.ufl-e \{ font-size: 12px; line-height: 1; flex: none; \}/, "the emoji box itself is unchanged");
  assert.equal((css.match(/PATV Emoji Lift/g) || []).length, 2, "the face is used by that one rule");
  // the chat download inlines .ufl / .ufl-n only (as before): the lift rule and the face never reach it
  for (const m of css.matchAll(/(^|\})\s*(\.ufl(?:-e|-n)?)\s*\{([^}]*)\}/g)) assert.doesNotMatch(m[3], /PATV Emoji Lift/);
  // every builder tags the emoji: server chips (pad + post flair), the chat renderer, the "Your flair here" card, the casino menu
  assert.match(PF.html(PF.plexFlair()), /<span class="ufl-e" aria-hidden="true" data-e="📼">📼<\/span>/);
  assert.match(PF.postHtml({ ...POSTF, emoji: "📼" }), /<span class="ufl-e" aria-hidden="true" data-e="📼">📼<\/span>/);
  const CL = require(path.join(repo, "public", "js", "chatlog-core.js"));
  const node = String(CL.flairNode({ login: "a", patv: { flair: PF.plexFlair() } }, { t: (k, s, v) => s.replace("{name}", v.name) }, CL.htmlH));
  assert.match(node, /<span class="ufl-e" data-e="📼">📼<\/span>/, "chatlog-core.js");
  const file = String(CL.flairNode({ login: "a", patv: { flair: PF.plexFlair() } }, { data: false, t: (k, s, v) => s.replace("{name}", v.name) }, CL.htmlH));
  assert.match(file, /<span class="ufl-e">📼<\/span>/, "a chat download keeps its no-data-* rule");
  assert.match(rd("public", "js", "pad-flair.js"), /var e = el\('span', 'ufl-e', f\.emoji\); e\.setAttribute\('data-e', f\.emoji\);/);
  assert.match(rd("public", "js", "casino-ui.js"), /e\.className = "ufl-e"; e\.textContent = f\.emoji; e\.dataset\.e = f\.emoji;/);
  // cache: flair.css v5 everywhere it loads, the changed scripts bumped
  for (const v of [["home.ejs"], ["room.ejs"], ["padSettings.ejs"], ["casino-bj.ejs"], ["casino-hm.ejs"], ["partials", "feed-js.ejs"]]) {
    const src = rd("views", ...v);
    assert.ok(src.includes("/public/css/flair.css?v=5"), v.join("/"));
    assert.ok(!/flair\.css\?v=[0-4]\b/.test(src), v.join("/") + ": no old flair.css");
  }
  for (const v of [["home.ejs"], ["room.ejs"], ["partials", "pad-chat-history.ejs"]]) assert.ok(rd("views", ...v).includes("/public/js/chatlog-core.js?v=16"), v.join("/"));
  for (const v of ["casino-bj.ejs", "casino-hm.ejs"]) assert.ok(rd("views", v).includes("/public/js/casino-ui.js?v=9"), v);   // (train3 table notice: v9)
});
