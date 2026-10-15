// crawlers.js (1.99aax): /robots.txt blocks every crawler except the link-preview bots; every response says noindex;
// PATV_CRAWLERS=allow turns it off.
//   node --test test/crawlers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require(path.join(__dirname, "..", "node_modules", "express"));
const C = require(path.join(__dirname, "..", "crawlers"));

function serve(env) {
  const old = process.env.PATV_CRAWLERS;
  if (env == null) delete process.env.PATV_CRAWLERS; else process.env.PATV_CRAWLERS = env;
  const app = express();
  C.register(app);
  app.get("/", (req, res) => res.send("home"));
  app.get("/robots.txt", (req, res) => res.status(404).send("not found page"));
  if (old == null) delete process.env.PATV_CRAWLERS; else process.env.PATV_CRAWLERS = old;
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}
const get = (s, p) => fetch(`http://127.0.0.1:${s.address().port}${p}`).then(async (r) => ({ status: r.status, h: r.headers, text: await r.text() }));

test("robots.txt: everyone disallowed, link previews allowed; noindex on every response", async () => {
  const s = await serve(null);
  try {
    const r = await get(s, "/robots.txt");
    assert.equal(r.status, 200);
    assert.match(r.h.get("content-type"), /text\/plain/);
    assert.match(r.text, /User-agent: \*\nDisallow: \/\n/);
    for (const b of ["Discordbot", "TelegramBot", "Twitterbot", "facebookexternalhit"]) assert.match(r.text, new RegExp(`User-agent: ${b}\\nAllow: /`));
    assert.doesNotMatch(r.text, /Googlebot|GPTBot/, "no search or AI crawler is allowed by name");
    const h = await get(s, "/");
    assert.equal(h.text, "home");
    assert.equal(h.h.get("x-robots-tag"), "noindex, nofollow, noarchive");
  } finally { s.close(); }
});

test("PATV_CRAWLERS=allow: the old behaviour", async () => {
  const s = await serve("allow");
  try {
    assert.equal((await get(s, "/robots.txt")).status, 404);
    assert.equal((await get(s, "/")).h.get("x-robots-tag"), null);
  } finally { s.close(); }
});
