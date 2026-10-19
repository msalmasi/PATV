// 1.99add: the 404 page escapes its message. /p/<slug> and /p/<slug>/submit built "There's no pad at p/<raw path>"
// and views/notFound.ejs printed `message` raw (<%- %>), so /p/%3Csvg%20onload%3D...%3E was a reflected XSS.
// `message` is now text (always escaped); `messageHtml` is markup the caller escaped itself (index.js notFound()).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const ejs = require("ejs");

const repo = path.join(__dirname, "..");
const view = path.join(repo, "views", "notFound.ejs");
const render = (locals) => ejs.renderFile(view, Object.assign({ user: null, heading: null, message: null }, locals));

test("a message is escaped (the /p/<slug> payloads)", async () => {
  for (const raw of ["<svg onload=alert(1)>", "<b>x</b>", "\"><img src=x onerror=alert(1)>", "<script>alert(1)</script>"]) {
    const h = await render({ heading: "No such pad", message: "There's no pad at p/" + raw.toLowerCase() + "." });
    const lead = (h.match(/<p class="ds-lead">([\s\S]*?)<\/p>/) || [])[1] || "";
    assert.ok(lead.includes("&lt;"), "escaped: " + lead);
    assert.ok(!/<(svg|img|script|b)\b/i.test(lead), "no live markup from the message: " + lead);
  }
});

test("messageHtml keeps the caller's own markup (profile pages), and the default text still shows", async () => {
  const h = await render({ heading: "No such profile", messageHtml: "There's no PATV account called <code>a&lt;b</code>." });
  assert.match(h, /<p class="ds-lead">There's no PATV account called <code>a&lt;b<\/code>\.<\/p>/);
  const d = await render({});
  const lead = (d.match(/<p class="ds-lead">([\s\S]*?)<\/p>/) || [])[1] || "";
  assert.ok(lead.trim().length > 0, "the catalog default renders");
});

test("the heading is escaped too", async () => {
  const h = await render({ heading: "<i>h</i>", message: "m" });
  assert.ok(h.includes("&lt;i&gt;h&lt;/i&gt;"));
});

test("only index.js's notFound() passes messageHtml, and only with escHtml'd input", () => {
  const offenders = [];
  for (const f of fs.readdirSync(repo)) {
    if (!f.endsWith(".js")) continue;
    const s = fs.readFileSync(path.join(repo, f), "utf8");
    if (/messageHtml/.test(s) && f !== "index.js") offenders.push(f);
  }
  assert.deepStrictEqual(offenders, []);
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const calls = idx.match(/notFound\(req, res, "No such profile", null,\s*\n\s*"[^\n]*/g) || [];
  assert.strictEqual(calls.length, 2);
  for (const c of calls) assert.match(c, /escHtml\(/);
});
