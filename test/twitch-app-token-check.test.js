// 1.99aow: tools/twitch-app-token-check.js - the read-only check of the webhook server's app token mint, on a fake Twitch
// (no network):
//   * one mint (never the TWITCH_ACCESS_TOKEN fallback), ONE Helix GET of the subscriptions, one revoke of the token it minted;
//     never a delete or a create;
//   * it prints only "mint: ...", "helix list: ..." and "revoke: ..." - no token, no secret, no fingerprint;
//   * exit 0 only when the mint worked and the list answered 200; nothing secret on the command line (an argument = usage, 2).
// Invented values only.
//   node --test test/twitch-app-token-check.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.resolve(__dirname, "..");
const TOOL = path.join(repo, "tools", "twitch-app-token-check.js");
const { run, statusCounts, SUBSCRIPTIONS_URL, REVOKE_URL } = require("../tools/twitch-app-token-check");

const CLIENT = "test-client-not-real", SECRET = "test-secret-not-real", STATIC = "test-static-token-not-real";
const MINTED = "test-app-token-not-real-1";
const ENV = { TWITCH_CLIENT_ID2: CLIENT, TWITCH_SECRET_KEY2: SECRET, TWITCH_ACCESS_TOKEN: STATIC };
const VALUES = /test-(?:client|secret|static-token|app-token)/;

const answer = (status, data) => Object.assign(new Error("Request failed with status code " + status), { response: { status, data } });

/** A fake Twitch: the token endpoint, Helix and the revoke endpoint; every call recorded. */
function twitch({ mint = () => ({ data: { access_token: MINTED, expires_in: 5011200, token_type: "bearer" } }),
                  list = () => ({ status: 200, data: { data: [{ status: "enabled" }], total: 1 } }),
                  revoke = () => ({ status: 200, data: "" }) } = {}) {
  const calls = [];
  const http = {
    async post(url, body, options) {
      calls.push({ verb: "POST", url, body, options });
      if (url === "https://id.twitch.tv/oauth2/token") return mint();
      if (url === REVOKE_URL) return revoke();
      throw new Error("unexpected POST");
    },
    async request(config) {
      calls.push({ verb: String(config.method).toUpperCase(), url: config.url, config });
      if (config.url === SUBSCRIPTIONS_URL && config.method === "get") return list();
      throw new Error("unexpected request");
    },
  };
  return { http, calls };
}

async function check(fake, env = ENV) {
  const lines = [];
  const code = await run({ http: fake.http, env, out: (l) => lines.push(l) });
  return { code, lines };
}

test("a working mint: one mint, one GET of the subscriptions, the minted token revoked; value-free lines; exit 0", async () => {
  const fake = twitch({ list: () => ({ status: 200, data: { total: 3, data: [{ status: "enabled" },
    { status: "webhook_callback_verification_pending" }, { status: "enabled" }] } }) });
  const { code, lines } = await check(fake);
  assert.equal(code, 0);
  assert.deepEqual(lines, ["mint: ok (lifetime 58 days)",
                           "helix list: HTTP 200, 3 subscription(s): enabled 2, webhook_callback_verification_pending 1",
                           "revoke: ok"]);
  assert.deepEqual(fake.calls.map((c) => `${c.verb} ${c.url}`), [
    "POST https://id.twitch.tv/oauth2/token",
    "GET https://api.twitch.tv/helix/eventsub/subscriptions",
    "POST https://id.twitch.tv/oauth2/revoke",
  ], "one mint, ONE read-only Helix call, one revoke - never a delete or a create");
  const [mint, list, revoke] = fake.calls;
  assert.equal(new URLSearchParams(mint.body).get("client_secret"), SECRET);
  assert.equal(list.config.headers.Authorization, `Bearer ${MINTED}`, "the minted token, never TWITCH_ACCESS_TOKEN");
  assert.equal(list.config.headers["Client-ID"], CLIENT);
  assert.equal(list.config.maxRedirects, 0);
  const form = new URLSearchParams(revoke.body);
  assert.deepEqual([...form.keys()].sort(), ["client_id", "token"]);
  assert.equal(form.get("client_id"), CLIENT);
  assert.equal(form.get("token"), MINTED, "it revokes exactly the token it minted");
  assert.equal(revoke.options.maxRedirects, 0);
  assert.doesNotMatch(lines.join("\n"), VALUES, "no token, no secret in the output");
});

test("no subscription, and a list longer than one page: said plainly", async () => {
  const none = await check(twitch({ list: () => ({ status: 200, data: { data: [], total: 0 } }) }));
  assert.equal(none.lines[1], "helix list: HTTP 200, 0 subscription(s)");
  assert.equal(none.code, 0);
  const paged = await check(twitch({ list: () => ({ status: 200, data: { data: [{ status: "enabled" }], total: 120 } }) }));
  assert.equal(paged.lines[1], "helix list: HTTP 200, 1 subscription(s): enabled 1 (120 in all)");
});

test("the list refused: Twitch's answer (status + body), the token still revoked, exit 1 - and the 401 is not retried", async () => {
  const fake = twitch({ list: () => { throw answer(401, { error: "Unauthorized", status: 401, message: "Invalid OAuth token" }); } });
  const { code, lines } = await check(fake);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["mint: ok (lifetime 58 days)",
                           'helix list: HTTP 401 {"error":"Unauthorized","status":401,"message":"Invalid OAuth token"}',
                           "revoke: ok"]);
  assert.equal(fake.calls.filter((c) => c.verb === "GET").length, 1, "one Helix call, not a retry");
  assert.equal(fake.calls.filter((c) => c.url === "https://id.twitch.tv/oauth2/token").length, 1, "one mint");
  // no answer at all: the error's code only (its message could say anything)
  const net = await check(twitch({ list: () => { throw Object.assign(new Error("connect ETIMEDOUT " + SECRET), { code: "ETIMEDOUT" }); } }));
  assert.equal(net.lines[1], "helix list: failed (ETIMEDOUT)");
  assert.equal(net.code, 1);
  assert.doesNotMatch(net.lines.join("\n"), VALUES);
});

test("a failed mint: 'mint: failed (<status>)', nothing else sent, exit 1 - TWITCH_ACCESS_TOKEN never stands in", async () => {
  const fake = twitch({ mint: () => { throw answer(403, { status: 403, message: "invalid client secret" }); } });
  const { code, lines } = await check(fake);
  assert.equal(code, 1);
  assert.deepEqual(lines, ["mint: failed (HTTP 403)"]);
  assert.deepEqual(fake.calls.map((c) => c.url), ["https://id.twitch.tv/oauth2/token"], "no Helix call with the static token, no revoke");
  const missing = twitch();
  const r = await check(missing, { TWITCH_ACCESS_TOKEN: STATIC });
  assert.deepEqual(r.lines, ["mint: failed (NO_APP_CREDENTIALS)"]);
  assert.equal(missing.calls.length, 0, "without the pair nothing is sent");
  const bad = await check(twitch({ mint: () => ({ data: { access_token: MINTED } }) }));
  assert.deepEqual(bad.lines, ["mint: failed (BAD_TOKEN_ANSWER)"]);
});

test("a failed revoke is said (status only); the check's result stands", async () => {
  const { code, lines } = await check(twitch({ revoke: () => { throw answer(400, { status: 400, message: "Invalid token " + MINTED }); } }));
  assert.equal(code, 0);
  assert.equal(lines[2], "revoke: failed (HTTP 400)");
  assert.doesNotMatch(lines.join("\n"), VALUES);
});

test("statusCounts: Twitch's statuses counted and cleaned", () => {
  assert.equal(statusCounts([{ status: "enabled" }, {}, { status: "a b\n<c>" }, null, { status: 5 }]), "abc 1, enabled 1, unknown 3");
});

test("the command line: no argument is read (one is refused with usage, exit 2); without the pair it says so and sends nothing", () => {
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^TWITCH_/.test(k)) delete env[k];   // a developer's own values never reach Twitch
  const usage = spawnSync(process.execPath, [TOOL, "--token", "x"], { encoding: "utf8", env, timeout: 30000 });
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /^usage: node --env-file=<env file> tools\/twitch-app-token-check\.js/);
  const none = spawnSync(process.execPath, [TOOL], { encoding: "utf8", env, timeout: 30000 });
  assert.equal(none.status, 1, none.stderr);
  assert.equal(none.stdout.replace(/\r\n/g, "\n"), "mint: failed (NO_APP_CREDENTIALS)\n");
  const src = fs.readFileSync(TOOL, "utf8");
  const code = src.replace(/^\s*\/\/.*$/gm, "");                              // comments out
  assert.doesNotMatch(code, /dotenv/, "no .env of its own: only what --env-file gives it");
  assert.doesNotMatch(code, /TWITCH_ACCESS_TOKEN/, "the static token is not read");
  assert.doesNotMatch(code, /method:\s*["'](?:delete|post|put|patch)["']|\.(?:delete|put|patch)\(/, "no Helix write");
  assert.doesNotMatch(code, /process\.argv\[/, "no argument is read");
});

// The root script that minted an app token by hand printed it (to a terminal, or a shell / pm2 log); the check tool does that
// job without showing the token. No script in the repo prints a minted token's field.
test("no script prints a minted token: getAccessToken.js is gone, and nothing logs an access_token", () => {
  assert.equal(fs.existsSync(path.join(repo, "getAccessToken.js")), false);
  const bad = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(path.join(repo, dir), { withFileTypes: true })) {
      if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "uploads") continue;
      const rel = dir ? dir + "/" + ent.name : ent.name;
      if (ent.isDirectory()) walk(rel);
      else if (/\.(?:js|mjs|cjs)$/.test(ent.name)) {
        const src = fs.readFileSync(path.join(repo, rel), "utf8");
        if (/console\.(?:log|error|warn|info|debug)\([^;]*\b(?:access_token|refresh_token)\b/.test(src)) bad.push(rel);
      }
    }
  };
  walk("");
  assert.deepEqual(bad, []);
});
