// 1.99zl: the auth-form CSRF check (middleware/authGuard.js sameSite / originState / authFormOk / form token).
// The reset page was served with Referrer-Policy: no-referrer, so every browser posted it with "Origin: null"
// and sameSite() refused every password reset ("Cross-site request refused").
//   NODE_PATH=G:/PATV/node_modules node --test test/auth-form-csrf.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");

const repo = path.resolve(__dirname, "..");
const guard = require(path.join(repo, "middleware", "authGuard"));

const fake = (headers = {}, body = {}, signedCookies = {}) => ({
  get: (h) => headers[String(h).toLowerCase()], body, signedCookies,
});

test("sameSite: same host, www / apex, case; foreign and opaque origins refused (JSON APIs stay strict)", () => {
  const H = { host: "publicaccess.tv" };
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://publicaccess.tv" })), true);
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://www.publicaccess.tv" })), true, "www counts as the site");
  assert.equal(guard.sameSite(fake({ host: "www.publicaccess.tv", origin: "https://publicaccess.tv" })), true);
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://PublicAccess.TV" })), true);
  assert.equal(guard.sameSite(fake({ ...H, referer: "https://publicaccess.tv/forgot-password" })), true);
  assert.equal(guard.sameSite(fake({ host: "staging.publicaccess.tv", origin: "https://staging.publicaccess.tv" })), true);
  assert.equal(guard.sameSite(fake({ host: "staging.publicaccess.tv", origin: "https://publicaccess.tv" })), false, "prod is not staging");
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://staging.publicaccess.tv" })), false, "staging is not prod");
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://evil.example" })), false);
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://publicaccess.tv.evil.example" })), false);
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://evilpublicaccess.tv" })), false);
  assert.equal(guard.sameSite(fake({ ...H, origin: "https://www.evil.example" })), false);
  assert.equal(guard.sameSite(fake({ ...H, origin: "null" })), false, "opaque origin: strict for APIs");
  assert.equal(guard.sameSite(fake({ ...H })), true, "neither header (old behaviour)");
});

test("originState: null origin falls back to the Referer", () => {
  const H = { host: "publicaccess.tv" };
  assert.equal(guard.originState(fake({ ...H, origin: "null" })), "opaque");
  assert.equal(guard.originState(fake({ ...H })), "opaque");
  assert.equal(guard.originState(fake({ ...H, origin: "null", referer: "https://publicaccess.tv/login" })), "same");
  assert.equal(guard.originState(fake({ ...H, origin: "null", referer: "https://evil.example/x" })), "foreign");
  assert.equal(guard.originState(fake({ ...H, origin: "https://evil.example", referer: "https://publicaccess.tv/" })), "foreign",
               "a real Origin wins over the Referer");
});

test("authFormOk: forgot / reset (lowValue) accept Origin null; login / register need the form token", () => {
  const H = { host: "publicaccess.tv" };
  const tok = "0123456789abcdef0123456789abcdef";
  // the bug: Origin null used to be refused on forgot / reset
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null" }), { lowValue: true }), true);
  assert.equal(guard.authFormOk(fake({ ...H, origin: "https://www.publicaccess.tv" }), { lowValue: true }), true);
  assert.equal(guard.authFormOk(fake({ host: "staging.publicaccess.tv", origin: "null" }), { lowValue: true }), true);
  // foreign is always refused, token or not
  assert.equal(guard.authFormOk(fake({ ...H, origin: "https://evil.example" }, { _ft: tok }, { au_ft: tok }), { lowValue: true }), false);
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null", referer: "https://evil.example/" }), { lowValue: true }), false);
  // login / register: Origin null needs a matching token
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null" })), false);
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null" }, { _ft: tok }, { au_ft: tok })), true);
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null" }, { _ft: tok }, {})), false, "no cookie");
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null" }, { _ft: "f".repeat(32) }, { au_ft: tok })), false, "mismatch");
  assert.equal(guard.authFormOk(fake({ ...H, origin: "null" }, { _ft: tok }, { au_ft: false })), false, "bad signature");
  assert.equal(guard.authFormOk(fake({ ...H, origin: "https://publicaccess.tv" })), true);
  assert.equal(guard.authFormOk(fake({ ...H })), true, "neither header (old behaviour)");
});

test("form token round trip through express + cookie-parser (signed, httpOnly, Lax)", async () => {
  const app = express();
  app.use(cookieParser("test-secret"));
  app.use(express.urlencoded({ extended: true }));
  app.get("/forgot-password", guard.formTokenMw, (req, res) => res.send(String(res.locals.authFormToken)));
  app.post("/login", (req, res) => res.status(guard.authFormOk(req) ? 200 : 403).send(guard.authFormOk(req) ? "ok" : guard.FORM_REFUSED));
  const srv = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const g = await fetch(base + "/forgot-password");
    const tok = await g.text();
    assert.match(tok, /^[a-f0-9]{32}$/);
    const setCookie = g.headers.get("set-cookie");
    assert.match(setCookie, /au_ft=s%3A/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    const cookie = setCookie.split(";")[0];
    const post = (headers, body) => fetch(base + "/login", { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
    assert.equal((await post({ origin: "null", cookie }, { _ft: tok })).status, 200, "null origin + token");
    assert.equal((await post({ origin: "null" }, { _ft: tok })).status, 403, "token without the cookie (cross-site Lax)");
    const refused = await post({ origin: "null", cookie }, { _ft: "0".repeat(32) });
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /regular browser/);
    assert.equal((await post({ origin: "https://evil.example", cookie }, { _ft: tok })).status, 403, "foreign origin");
    // the cookie is reused, not rotated, while it lives (two tabs keep working)
    const g2 = await fetch(base + "/forgot-password", { headers: { cookie } });
    assert.equal(await g2.text(), tok);
  } finally {
    srv.close();
  }
});

test("wiring: reset page no longer no-referrer; auth forms carry the token; handlers use authFormOk", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.doesNotMatch(idx, /Referrer-Policy", "no-referrer"/);
  assert.match(idx, /app\.get\(\["\/login", "\/register", "\/forgot-password", "\/reset-password\/:token"\], guard\.formTokenMw\)/);
  assert.match(idx, /app\.post\("\/forgot-password", async \(req, res\) => \{\s+if \(!guard\.authFormOk\(req, \{ lowValue: true \}\)\)/);
  assert.match(idx, /app\.post\("\/reset-password\/:token", async \(req, res\) => \{\s+if \(!guard\.authFormOk\(req, \{ lowValue: true \}\)\)/);
  const uc = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  assert.equal((uc.match(/guard\.authFormOk\(req\)\) return res\.status\(403\)/g) || []).length, 2, "login + register");
  for (const v of ["login", "register", "forgotPassword", "resetPassword"]) {
    const ejs = fs.readFileSync(path.join(repo, "views", v + ".ejs"), "utf8");
    assert.match(ejs, /name="_ft" value="<%= authFormToken %>"/, v);
  }
});
