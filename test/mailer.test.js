// 1.99aim: account emails go through mailer.js - Resend first, then SendGrid. On 2026-11-03 prod's SendGrid key answered
// 401 Unauthorized and every sign-up / changed-address verification email was lost (user.controller.js called SendGrid
// directly) while Resend was configured and working.
//   node --test test/mailer.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const mailer = require(path.join(repo, "mailer"));

const MSG = { to: "someone@example.org", subject: "Verify Your Email Address", text: "t", html: "<p>h</p>" };
const keys = { RESEND_API_KEY: process.env.RESEND_API_KEY, SENDGRID_API_KEY: process.env.SENDGRID_API_KEY };
function env(r, s) {
  if (r) process.env.RESEND_API_KEY = "re_test"; else delete process.env.RESEND_API_KEY;
  if (s) process.env.SENDGRID_API_KEY = "SG.test"; else delete process.env.SENDGRID_API_KEY;
}
function fakes({ resend, sendgrid }) {
  const calls = [];
  const r = { emails: { send: async (m) => { calls.push(["resend", m]); return resend(m); } } };
  const s = { send: async (m) => { calls.push(["sendgrid", m]); return sendgrid(m); } };
  mailer._setClients(r, s);
  return calls;
}
const unauthorized = () => { const e = new Error("Unauthorized"); e.code = 401; throw e; };

test.after(() => {
  mailer._setClients(null, null);
  for (const [k, v] of Object.entries(keys)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("Resend first: it accepts, SendGrid is never called", async () => {
  env(true, true);
  const calls = fakes({ resend: async () => ({ data: { id: "x" } }), sendgrid: unauthorized });
  assert.equal(await mailer.send(MSG), "resend");
  assert.deepEqual(calls.map((c) => c[0]), ["resend"]);
  assert.equal(calls[0][1].from, "no-reply@publicaccess.tv");
  assert.equal(calls[0][1].to, MSG.to);
});

test("Resend refuses (error answer or a throw): SendGrid is tried next", async () => {
  env(true, true);
  let calls = fakes({ resend: async () => ({ error: { message: "domain not verified" } }), sendgrid: async () => [{ statusCode: 202 }] });
  assert.equal(await mailer.send(MSG), "sendgrid");
  assert.deepEqual(calls.map((c) => c[0]), ["resend", "sendgrid"]);
  calls = fakes({ resend: async () => { throw new Error("network"); }, sendgrid: async () => [{ statusCode: 202 }] });
  assert.equal(await mailer.send(MSG), "sendgrid");
});

test("the 11-03 case: Resend configured, SendGrid's key dead (401) - the email still goes out through Resend", async () => {
  env(true, true);
  fakes({ resend: async () => ({ data: { id: "y" } }), sendgrid: unauthorized });
  assert.equal(await mailer.send(MSG), "resend");
});

test("both fail: one error naming both providers and SendGrid's status, never a key or the email's text", async () => {
  env(true, true);
  fakes({ resend: async () => ({ error: { message: "refused" } }), sendgrid: unauthorized });
  await assert.rejects(mailer.send(MSG), (e) => {
    assert.match(e.message, /resend: refused/);
    assert.match(e.message, /sendgrid: 401 Unauthorized/);
    assert.equal(/re_test|SG\.test|someone@example\.org/.test(e.message), false);
    return true;
  });
});

test("only SendGrid configured: SendGrid; nothing configured: 'no mailer configured'", async () => {
  env(false, true);
  const calls = fakes({ resend: async () => ({}), sendgrid: async () => [{ statusCode: 202 }] });
  assert.equal(await mailer.send(MSG), "sendgrid");
  assert.deepEqual(calls.map((c) => c[0]), ["sendgrid"]);
  env(false, false);
  await assert.rejects(mailer.send(MSG), /no mailer configured/);
});

test("the verification email goes through mailer.js, never SendGrid directly", () => {
  const src = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  assert.match(src, /require\('\.\/mailer'\)/, "user.controller.js uses mailer.js");
  assert.equal(/sgMail/.test(src), false, "no direct SendGrid client left in user.controller.js");
  const fn = src.slice(src.indexOf("async function sendVerificationEmail"), src.indexOf("async function sendVerificationEmail") + 1600);
  assert.match(fn, /await mailer\.send\(msg\)/);
});
