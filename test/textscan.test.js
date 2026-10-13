// Offline tests for 1.99xh: POST /api/pepe/textscan (textscan.js) - the site's content filter over a line Pepe will speak.
//   * bot token only; categories only (never the matched words or list entries); empty / long text handled
//   * a slur from the encoded list -> hate; a phone number -> doxxing (full); a clean line -> nothing
//   NODE_PATH=G:/PATV/node_modules node --test test/textscan.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "textscan-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const TS = require(path.join(repo, "textscan"));
const FF = require(path.join(repo, "feedfilter"));

// a word from the encoded list itself (this public repo never spells one out)
const LISTS = FF.decodeFile(JSON.parse(fs.readFileSync(FF.LIST_FILE, "utf8")));
const WORD = LISTS.hate_words.map((w) => w.replace(/^\*|\*$/g, "")).find((w) => /^[a-z]{4,}$/.test(w));

function route() {
  let handler = null;
  const app = { post: (p, fn) => { if (p === "/api/pepe/textscan") handler = fn; } };
  TS.register(app, { isBotToken: (t) => t === "bot-token" });
  return async (body, headers = {}) => {
    let status = 200, out = null;
    const res = { status(c) { status = c; return res; }, json(o) { out = o; return res; } };
    await handler({ body, get: (h) => headers[h.toLowerCase()] }, res);
    return { status, body: out };
  };
}

test("bot token only", async () => {
  const call = route();
  assert.equal((await call({ text: "hi" })).status, 403);
  assert.equal((await call({ password: "nope", text: "hi" })).status, 403);
  const r = await call({ text: "hi" }, { "x-bot-token": "bot-token" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, hits: [] });
});

test("categories only - a listed word is hate, a phone number is doxxing, a clean line is nothing", async () => {
  const call = route();
  assert.ok(WORD, "the list has a plain word to test with");
  const hate = await call({ password: "bot-token", text: `what a ${WORD} thing to say` });
  assert.ok(hate.body.hits.some((h) => h.cat === "hate"), JSON.stringify(hate.body));
  assert.ok(!JSON.stringify(hate.body).includes(WORD), "the matched word never goes back");
  const dox = await call({ password: "bot-token", text: "call her on 212-555-0199 tonight" });
  assert.ok(dox.body.hits.some((h) => h.cat === "doxxing" && h.strength === "full"), JSON.stringify(dox.body));
  const clean = await call({ password: "bot-token", text: "happy birthday to the best room on the site" });
  assert.deepEqual(clean.body.hits, []);
  assert.deepEqual(TS.scanText(""), []);
  assert.deepEqual(TS.scanText(null), []);
  assert.ok(Array.isArray(TS.scanText("x".repeat(50000))), "long text is cut, not refused");
});

test("the route is registered in index.js", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /require\("\.\/textscan"\)\.register\(app, \{ isBotToken \}\)/);
});
