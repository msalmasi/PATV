// 1.99anw review: errorhandler.js - the last Express handler. A body the parsers refuse ('{', 1001 form fields, a JSON body over
// 100 KB, a bad gzip, an unknown Content-Encoding) used to get Express's own page: with NODE_ENV unset (nothing in the repo sets it
// for pm2) that page is the error's stack with the server's absolute paths. Now it is only the status's name: JSON for /api/, plain
// text elsewhere. index.js installs it after its 404 handler, and so does the Twitch webhook app (server.js).
//   NODE_PATH=<repo>/node_modules TZ=UTC node --test test/errorhandler.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const express = require("express");
const bodyParser = require("body-parser");

delete process.env.NODE_ENV;   // what pm2 starts the site with (no NODE_ENV anywhere in deploy/)
const repo = path.resolve(__dirname, "..");
const { errorHandler } = require(path.join(repo, "errorhandler"));
const rd = (p) => fs.readFileSync(path.join(repo, p), "utf8").replace(/\r\n/g, "\n");

/** index.js's order, shortened: the global parsers, a few routes, the 404 handler, then (or not) the error handler. */
async function serve(t, withHandler, logs = []) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.post("/api/thing", (req, res) => res.json({ ok: true }));
  app.post("/login", (req, res) => res.send("ok"));
  app.get("/api/boom", () => { throw new Error("secret detail at C:\\srv\\patv\\thing.js"); });
  app.get("/boom-next", (req, res, next) => next(Object.assign(new Error("teapot detail"), { status: 418 })));
  app.get("/odd-status", (req, res, next) => next(Object.assign(new Error("odd"), { status: 302 })));
  app.get("/half", (req, res, next) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.write("partial"); next(new Error("after the head")); });
  app.use((req, res) => (req.path.startsWith("/api/") ? res.status(404).json({ error: "not found" }) : res.status(404).send("Not found")));
  if (withHandler) app.use(errorHandler({ log: { error: (s) => logs.push(s) } }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => new Promise((r) => server.close(() => r())));
  return "http://127.0.0.1:" + server.address().port;
}
const post = async (base, p, body, headers) => {
  const r = await fetch(base + p, { method: "POST", body, headers });
  return { status: r.status, type: r.headers.get("content-type") || "", cache: r.headers.get("cache-control"), text: await r.text() };
};
const JSONH = { "Content-Type": "application/json" };
const FORMH = { "Content-Type": "application/x-www-form-urlencoded" };
const bodies = () => [
  ["json '{'", "{", JSONH, 400],
  ["json over 100 KB", JSON.stringify({ a: "x".repeat(110 * 1024) }), JSONH, 413],
  ["1001 form fields", Array.from({ length: 1001 }, (_, i) => "f" + i + "=1").join("&"), FORMH, 413],
  ["bad gzip", Buffer.from("this is not gzip"), { ...JSONH, "Content-Encoding": "gzip" }, 400],
  ["unknown encoding", "{}", { ...JSONH, "Content-Encoding": "zstd-nope" }, 415],
  ["gzip of '{'", zlib.gzipSync("{"), { ...JSONH, "Content-Encoding": "gzip" }, 400],
];
const LEAK = /SyntaxError|at [\w.<>]+ \(|node_modules|body-parser|[A-Z]:\\|\/home\/|\/srv\/|<pre>|Unexpected end of JSON|stack/i;

test("without it (Express's own page, NODE_ENV unset): the stack and the server's paths reach anyone - why this exists", async (t) => {
  const base = await serve(t, false);
  const r = await post(base, "/api/thing", "{", JSONH);
  assert.equal(r.status, 400);
  assert.match(r.text, LEAK, "the leak this handler closes");
});

test("a body the parsers refuse: its status, the status's name only - JSON on /api/, plain text elsewhere; anyone, signed in or not", async (t) => {
  const base = await serve(t, true);
  for (const [name, data, headers, want] of bodies()) {
    const api = await post(base, "/api/thing", data, headers);
    assert.equal(api.status, want, name);
    assert.match(api.type, /^application\/json/, name);
    assert.deepEqual(JSON.parse(api.text), { ok: false, error: require("http").STATUS_CODES[want] }, name);
    assert.doesNotMatch(api.text, LEAK, name);
    assert.equal(api.cache, "no-store", name);
    const page = await post(base, "/login", data, headers);
    assert.equal(page.status, want, name + " (a page)");
    assert.match(page.type, /^text\/plain/, name);
    assert.equal(page.text, require("http").STATUS_CODES[want], name);
  }
  // the routes still work with good bodies
  assert.equal((await post(base, "/api/thing", "{}", JSONH)).status, 200);
  assert.equal((await post(base, "/login", "a=1", FORMH)).text, "ok");
});

test("a route's own error: 500 with no detail (logged as method, path, message), a 4xx kept, an odd status is a 500, a half-sent answer is left to Express", async (t) => {
  const logs = [];
  const base = await serve(t, true, logs);
  const r = await fetch(base + "/api/boom?token=abc");
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { ok: false, error: "Internal Server Error" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^\[http\] GET \/api\/boom: 500 secret detail/);
  assert.doesNotMatch(logs[0], /token=abc/, "no query string in the log");
  const tea = await fetch(base + "/boom-next");
  assert.equal(tea.status, 418);
  assert.equal(await tea.text(), "I'm a Teapot");
  assert.equal(logs.length, 1, "a 4xx is not logged");
  assert.equal((await fetch(base + "/odd-status")).status, 500, "a status outside 400-599 is a 500");
  const half = await fetch(base + "/half").then(async (x) => ({ status: x.status, text: await x.text().catch(() => "cut") })).catch(() => ({ status: "cut" }));
  assert.ok(half.status === 200 || half.status === "cut", JSON.stringify(half));
  assert.equal((await fetch(base + "/api/nope")).status, 404, "the 404 handler still answers first");
});

test("index.js installs it last, after the 404 handler; the Twitch webhook app (server.js) installs it after its route", async (t) => {
  const src = rd("index.js");
  const last = src.lastIndexOf("app.use(");
  assert.equal(src.slice(last, src.indexOf("\n", last)), 'app.use(require("./errorhandler").errorHandler());');
  assert.ok(src.lastIndexOf("app.use(addUser, (req, res) => {") < last, "after the 404 handler");
  assert.doesNotMatch(src.slice(last), /app\.(get|post|put|delete|patch|all)\(/, "no route after it");
  const CP = require(path.join(repo, "twitchbot", "channelpoints"));
  const app = CP.webhookApp({ express, bodyParser, secret: () => "s".repeat(32), broadcasterId: "1", onRedemption: async () => {} });
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  t.after(() => new Promise((r) => server.close(() => r())));
  const r = await post("http://127.0.0.1:" + server.address().port, CP.WEBHOOK_PATH, "{", JSONH);
  assert.equal(r.status, 400);
  assert.equal(r.text, "Bad Request");
  assert.doesNotMatch(r.text, LEAK);
});
