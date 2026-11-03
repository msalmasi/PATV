// Feed Markdown goldens are reusable data for v2. All lookups below are local fixtures, never accounts.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Already pinned in package-lock via aws-sdk/xml2js; no production Markdown/parser dependency.
const sax = require("sax");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "postmd-test-")));
const md = require(path.join(repo, "postmd"));
const pads = require(path.join(repo, "pads"));
pads._setNames(new Map([["alice", "Alice"], ["bob", "Bob"], ["with_under", "with_under"]]));
const oldPadRefs = pads.padRefs;
pads.padRefs = (s) => oldPadRefs(s, (slug) => slug === "lounge" ? { slug } : null);
const options = { origin: "https://example.test" };
const fixtures = path.join(__dirname, "fixtures", "postmd");

// Parse the complete generated tree, not just a search for <script>. The renderer emits the XML
// subset of HTML, except the three void tags and boolean hidden attribute normalized here. Strict
// SAX rejects malformed nesting/attributes; these fixed tag names have no HTML raw-text ambiguity.
const TAGS = new Set("p h2 h3 h4 strong em u del code pre blockquote ul ol li hr br a span button img div".split(" "));
const INLINE = new Set("strong em u del code br a span button img".split(" "));
function assertSafeHtml(html) {
  const xml = '<div>' + html.replace(/<span hidden>/g, '<span hidden="">').replace(/<(br|hr)>/g, "<$1/>")
    .replace(/<img ([^<>]*)>/g, "<img $1/>") + '</div>';
  const parser = sax.parser(true, { lowercase: false });
  const stack = [];
  parser.onopentag = (node) => {
    const tag = node.name, attrs = node.attributes, keys = Object.keys(attrs).sort();
    assert.ok(TAGS.has(tag), "unexpected tag: " + tag);
    if (stack.some((s) => ["p", "h2", "h3", "h4", "button", "a"].includes(s))) {
      assert.ok(INLINE.has(tag), "block element within phrasing content: " + tag);
    }
    if (tag === "a") {
      assert.deepEqual(keys, (attrs.class ? ["class", "href", "rel", "target"] : ["href", "rel", "target"]));
      assert.match(attrs.href, /^https?:\/\//i);
      assert.doesNotMatch(attrs.href, /[\s\u0000-\u001f\u007f]/u);
      assert.ok(["http:", "https:"].includes(new URL(attrs.href).protocol));
      assert.equal(attrs.rel, "nofollow noopener noreferrer ugc");
      assert.equal(attrs.target, "_blank");
      if (attrs.class) assert.ok(["pad-ref", "user-ref", "user-ref mention", "tag-ref"].includes(attrs.class));
      assert.ok(!stack.includes("a"), "nested anchor");
    } else if (tag === "img") {
      assert.deepEqual(keys, ["alt", "class", "decoding", "height", "loading", "src", "style", "title", "width"]);
      assert.ok(["stk", "stk stk-l"].includes(attrs.class));
      assert.match(attrs.src, /^\/public\/stickers\/[a-z0-9-]+\/[a-z0-9-]+\.svg$/);
      assert.ok(["48", "96"].includes(attrs.width)); assert.equal(attrs.height, attrs.width);
      assert.equal(attrs.style, "image-rendering:pixelated;vertical-align:middle;max-width:100%;height:auto");
      assert.equal(attrs.loading, "lazy"); assert.equal(attrs.decoding, "async");
    } else if (tag === "span") {
      assert.ok(keys.length === 1);
      if (attrs.class) assert.equal(attrs.class, "postmd-spoiler");
      else { assert.deepEqual(keys, ["hidden"]); assert.equal(attrs.hidden, ""); }
    } else if (tag === "button") {
      assert.deepEqual(keys, ["aria-expanded", "type"]);
      assert.equal(attrs.type, "button"); assert.equal(attrs["aria-expanded"], "false");
      assert.equal(stack[stack.length - 1], "span");
      assert.ok(!stack.includes("button"), "nested button");
    } else if (tag === "div" && attrs.class) {
      assert.deepEqual(keys, ["class"]); assert.ok(["postmd-code", "postmd-language"].includes(attrs.class));
    } else assert.deepEqual(keys, []);
    if (tag === "ul" || tag === "ol") assert.ok(stack.filter((s) => s === "ul" || s === "ol").length < 2, "more than one nested list");
    stack.push(tag);
  };
  parser.onclosetag = (name) => { assert.equal(stack.pop(), name); };
  parser.onerror = (err) => { throw err; };
  parser.write(xml).close();
  assert.equal(stack.length, 0);
}

for (const name of fs.readdirSync(fixtures).filter((n) => n.endsWith(".md")).sort()) {
  test("golden: " + name, () => {
    const input = fs.readFileSync(path.join(fixtures, name), "utf8");
    const expected = fs.readFileSync(path.join(fixtures, name.replace(/\.md$/, ".html")), "utf8").trimEnd();
    const expectedPlain = fs.readFileSync(path.join(fixtures, name.replace(/\.md$/, ".txt")), "utf8").trimEnd();
    const result = md.render(input, options);
    assert.equal(result, expected);
    assert.equal(md.plain(input).trimEnd(), expectedPlain);
    assertSafeHtml(result);
  });
}

test("spoiler label is localized, escaped, and never attribute source", () => {
  const rendered = md.render("hi ||secret **bold**||", { ...options, spoilerLabel: '<img src=x onerror="bad">' });
  assert.ok(rendered.includes('&lt;img src=x onerror=&quot;bad&quot;&gt;</button>'));
  assert.ok(rendered.includes('<span hidden>secret <strong>bold</strong></span>'));
  assertSafeHtml(rendered);
});

test("closed code is preserved for readers, optionally omitted from readable text", () => {
  const input = "@Alice `@Bob [sticker:pixelpepe/happy]` [sticker:pixelpepe/sad]\n\n```js\n@Bob [sticker:pixelpepe/happy]\n```\n\n**@Alice**";
  assert.equal(md.plain(input), "@Alice @Bob [sticker:pixelpepe/happy] [sticker:pixelpepe/sad]\n\n@Bob [sticker:pixelpepe/happy]\n\n@Alice");
  assert.equal(md.plain(input, { omitCode: true }), "@Alice   [sticker:pixelpepe/sad]\n\n \n\n@Alice");
  assert.equal(md.plain("@Al`code`ice", { omitCode: true }), "@Al ice");
  assert.equal(md.plain("```\n@Bob", { omitCode: true }), "```\n@Bob");
});

test("absolute internal refs use validated origin; authored relative links stay literal", () => {
  const result = md.render("@Alice p/lounge #hello [no](/u/Alice)", { origin: 'javascript:alert(1)' });
  assert.match(result, /href="https:\/\/(?:staging\.)?publicaccess\.tv\/u\/Alice"/);
  assert.ok(result.includes("[no](/u/Alice)"));
  assertSafeHtml(result);
  assert.ok(md.render("@Alice", { origin: "https://example.test:8443/path" }).includes('href="https://example.test:8443/u/Alice"'));
});

test("pipeline checks match rendered leaves, never concatenate names or sticker tokens", () => {
  assert.equal(md.sourceText("@Al**i**ce"), "@Al\ni\nce");
  assert.equal(md.sourceText("**@Alice** @Bob `@no` [bad @no](javascript:bad)"), "@Alice\n @Bob \n ");
  const text = "## @Alice\n\n- [sticker:pixelpepe/happy]\n- `@Bob`\n\n> [@Alice](https://example.test/@Bob)\n\n```\n@Bob\n```\n\n||@Alice||";
  assert.deepEqual(require(path.join(repo, "feedmentions")).names(md.sourceText(text)), ["alice"]);
  assert.ok(md.sourceText(text).includes("[sticker:pixelpepe/happy]"));
  assert.ok(!md.sourceText("[sticker:pixel**pepe**/happy]").includes("[sticker:pixelpepe/happy]"));
  assert.equal(md.sourceText("```\n@Alice"), "");
  assert.equal(md.sourceText("||unclosed @Alice"), "");
  assert.equal(md.sourceText("https://example.test/@Alice"), "");
});

test("URLs are atoms: formatting never reparses an href or visible URL", () => {
  const url = "https://example.test/a__b/**x**?q=||x||&v=%22onerror%3D";
  const result = md.render(url, options);
  assert.ok(result.includes('href="https://example.test/a__b/**x**?q=||x||&amp;v=%22onerror%3D"'));
  assert.doesNotMatch(result, /<(?:strong|em|u|button)\b/);
  assertSafeHtml(result);
  const long = "https://example.test/" + "a".repeat(120);
  assert.ok(md.render("[read](" + long + ")", options).includes(">" + long + "</a>"), "explicit address stays fully visible");
  assert.equal(md.render("**https://example.test**", options), '<p><strong><a href="https://example.test" rel="nofollow noopener noreferrer ugc" target="_blank">https://example.test</a></strong></p>');
});

test("no magic placeholders and no entity decoding of source", () => {
  const result = md.render("\u00000\u0000 `safe` &lt;script&gt; &#60;img&#62;", options);
  assert.ok(result.includes("\u00000\u0000 <code>safe</code> &amp;lt;script&amp;gt; &amp;#60;img&amp;#62;"));
  assertSafeHtml(result);
});

test("line endings normalize; null and empty input are empty", () => {
  assert.equal(md.render("## A\r\n\r\nB\rC", options), md.render("## A\n\nB\nC", options));
  for (const empty of [null, undefined, "", "\n\n"]) {
    assert.equal(md.render(empty, options), ""); assert.equal(md.plain(empty), "");
  }
});

test("deterministic XSS fuzz: 900 source strings always produce the fixed safe tree", () => {
  const bits = ['<', '>', '"', "'", '&', '`', '[', ']', '(', ')', '|', '*', '_', '~', '#', '\n', '\u0000',
    '<script>alert(1)</script>', 'onerror=', 'javascript:', 'data:', '<svg/onload=alert(1)>',
    '[x](javascript:alert(1))', '[x](data:text/html,test)', '[x](https://example.test/?x="onclick=bad)',
    '[x](//evil.test)', '<a href="javascript:bad">', '&lt;img&gt;', '&#x3c;svg&#x3e;',
    'https://example.test/a__b?q=**ok**&c=x', '@Alice', 'p/lounge', '#hello', '[sticker:pixelpepe/happy]',
    '## ', '---\n', '```js\n', '\n```\n', '||', '**', '__', '~~', '\\', '\r\n'];
  let seed = 0x51f6a17;
  const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (let n = 0; n < 900; n++) {
    let input = '';
    for (let j = 0, len = 8 + rand() % 75; j < len; j++) input += bits[rand() % bits.length];
    const result = md.render(input, options);
    try { assertSafeHtml(result); }
    catch (err) { err.message += '\ncase ' + n + ': ' + JSON.stringify(input) + '\nHTML: ' + result; throw err; }
    assert.equal(md.render(input, options), result, "deterministic output");
    assert.equal(typeof md.plain(input), "string");
  }
});

test("pathological bracket/marker/quote runs remain bounded and preserve their text", { timeout: 5000 }, () => {
  for (const input of ["[".repeat(20000), "*a_".repeat(6000), "> ".repeat(3000) + "end", "\u0000".repeat(20000), "`".repeat(20000)]) {
    const html = md.render(input, options);
    assertSafeHtml(html);
    assert.ok(html.length <= input.length * 15 + 1000);
    assert.ok(md.plain(input).length > 0);
  }
});

// 1.99aij (owner 2026-11-03): plain text never holds a spoiler's words - one "[spoiler]" whatever it wraps, in every block
test("plain text reads a closed spoiler as [spoiler]; unclosed / escaped / code ones stay as typed; moderation can ask for the words", () => {
  const ctx = JSON.parse(fs.readFileSync(path.join(fixtures, "context.json"), "utf8"));
  assert.equal(md.SPOILER, "[spoiler]");
  assert.equal(ctx.spoilerPlain, md.SPOILER, "the goldens' contract");
  const input = "## ||The end|| explained\n\n- ||**Bold** @Alice [sticker:pixelpepe/happy] https://example.test/x||\n\n> ||quoted||\n\n[||label||](https://example.test/r)";
  assert.equal(md.plain(input), "[spoiler] explained\n\n[spoiler]\n\n[spoiler]\n\n[spoiler] (https://example.test/r)");
  assert.equal(md.plain(input, { spoilers: "show" }),
    "The end explained\n\nBold @Alice [sticker:pixelpepe/happy] https://example.test/x\n\nquoted\n\nlabel (https://example.test/r)");
  assert.equal(md.plain("a ||b|| c ||d||"), "a [spoiler] c [spoiler]");
  assert.equal(md.plain("||" + "word ".repeat(500).trim() + "||"), "[spoiler]", "one word, however long");
  assert.equal(md.plain("||unclosed secret"), "||unclosed secret");
  assert.equal(md.plain(String.raw`\||escaped|| marks`), "||escaped|| marks");
  assert.equal(md.plain("`||in code||`"), "||in code||");
  assert.equal(md.plain("```\n||in a fence||\n```"), "||in a fence||");
  // the rendered page still hides the words behind the button (unchanged)
  assert.match(md.render("||secret||", options), /<span hidden>secret<\/span>/);
});
