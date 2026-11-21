// 1.99aow: twitchbot/apptoken.js - the webhook server's (server.js) Twitch app access token, minted by the client-credentials
// grant and renewed in memory - against a fake Twitch (token endpoint + Helix) and a fake clock / timers. No network.
//   * the mint form (client_id, client_secret, grant_type), no redirect followed, nothing written to the environment;
//   * one shared mint for concurrent callers; renewal at 80 % of the lifetime, by the timer or the next call;
//   * a 401 mints once and retries once (concurrent 401s share the mint), a second 401 goes back to the caller, and so does the
//     first one when that mint fails;
//   * TWITCH_ACCESS_TOKEN only when the FIRST mint fails, never after a successful one; a still-valid token kept through a
//     failed renewal, an expired one refused; retried once a minute, not on every call;
//   * timers unref'd and capped at 2^31-1 ms (re-armed until the time comes); stop();
//   * the log lines: no token, no secret, no fingerprint - an HTTP status or an error code at most; a failure that lasts is
//     logged once an hour, not every minute;
//   * server.js sends every Helix call through it and asks for the token before it deletes any subscription.
// Invented values only.
//   node --test test/twitch-app-token.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const { createAppTokenManager, why, span, TOKEN_URL } = require("../twitchbot/apptoken");

const CLIENT = "test-client-not-real", SECRET = "test-secret-not-real", STATIC = "test-static-token-not-real";
const MINTED = /^test-app-token-not-real-\d+$/;
const VALUES = /test-(?:secret|app-token|static-token|client)/;   // nothing of these may reach a log line

/** A manager on a fake Twitch, clock and timers. */
function fixture({ env, expiresIn = 100 } = {}) {
  let clock = 0, mints = 0, failMint = null, unauthorized = 0;
  const calls = [], logs = [], timers = [];
  const e = env || { TWITCH_CLIENT_ID2: CLIENT, TWITCH_SECRET_KEY2: SECRET, TWITCH_ACCESS_TOKEN: STATIC };
  const http = {
    async post(url, body, options) {
      mints++;
      calls.push({ kind: "mint", url, body, options });
      if (failMint) throw failMint();
      return { status: 200, data: { access_token: "test-app-token-not-real-" + mints, expires_in: expiresIn, token_type: "bearer" } };
    },
    async request(config) {
      calls.push({ kind: "helix", config });
      if (unauthorized > 0) {
        unauthorized--;
        const err = new Error("Request failed with status code 401");
        err.response = { status: 401, data: { error: "Unauthorized", status: 401, message: "Invalid OAuth token" } };
        throw err;
      }
      return { status: 200, data: { data: [] } };
    },
  };
  const manager = createAppTokenManager({
    http, env: e, now: () => clock,
    later(fn, delay) {
      const t = { delay, cancelled: false, fired: false, unrefd: false, unref() { this.unrefd = true; } };
      t.fn = () => { t.fired = true; return fn(); };   // a timer that fired is no longer live
      timers.push(t);
      return t;
    },
    cancel(t) { if (t) t.cancelled = true; },
    log: (line) => logs.push(line),
  });
  return {
    manager, env: e, calls, logs, timers,
    get mints() { return mints; },
    live: () => timers.filter((t) => !t.cancelled && !t.fired),
    mintCalls: () => calls.filter((c) => c.kind === "mint"),
    helix: () => calls.filter((c) => c.kind === "helix"),
    time(v) { clock = v; },
    fail(f) { failMint = f; },
    reject(n) { unauthorized = n; },
  };
}
const httpError = (status, data) => () => Object.assign(new Error("Request failed with status code " + status), { response: { status, data } });
const netError = (code) => () => Object.assign(new Error("connect " + code + " 127.0.0.1:443 " + SECRET), { code });

test("the mint: the client-credentials form, no redirect, the token in memory only; concurrent callers share one mint", async () => {
  const f = fixture();
  const before = JSON.stringify(f.env);
  const tokens = await Promise.all([f.manager.getToken(), f.manager.getToken(), f.manager.getToken()]);
  assert.equal(f.mints, 1, "one mint for three callers");
  assert.ok(tokens.every((t) => t === tokens[0]) && MINTED.test(tokens[0]));
  const [m] = f.mintCalls();
  assert.equal(m.url, "https://id.twitch.tv/oauth2/token");
  assert.equal(TOKEN_URL, m.url);
  const form = new URLSearchParams(m.body);
  assert.deepEqual([...form.keys()].sort(), ["client_id", "client_secret", "grant_type"]);
  assert.equal(form.get("client_id"), CLIENT);
  assert.equal(form.get("client_secret"), SECRET);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(m.options.maxRedirects, 0, "the form (with the secret) is never re-sent to a redirect");
  assert.equal(m.options.timeout, 15000);
  assert.equal(m.options.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(JSON.stringify(f.env), before, "nothing is written to the environment");
  const info = f.manager.info();
  assert.deepEqual(info, { minted: true, fallback: false, lifetimeMs: 100000, expiresAt: 100000, renewAt: 80000 });
  assert.ok(!JSON.stringify(info).includes("test-app-token"), "info() never carries the token");
  assert.deepEqual(f.logs, ["[twitch-app] app token ready (renews in about 1 minute)"]);
});

test("renewal at 80 % of the lifetime: by the next call after that time, and by the timer without any call", async () => {
  const f = fixture();
  const first = await f.manager.getToken();
  assert.equal(f.live().at(-1).delay, 80000, "the renewal timer is set for 80 % of 100 s");
  assert.ok(f.live().at(-1).unrefd, "the timer never keeps the process alive");
  f.time(79999);
  assert.equal(await f.manager.getToken(), first);
  assert.equal(f.mints, 1, "not before 80 %");
  f.time(80000);
  const second = await f.manager.getToken();
  assert.equal(f.mints, 2);
  assert.notEqual(second, first);
  // the timer alone (no Helix traffic at all): fired at 80 % of the new lifetime
  f.time(160000);
  f.live().at(-1).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.mints, 3, "the timer renewed it");
  assert.equal(f.live().length, 1, "one live timer at a time");
});

test("a 60-day token: the timer is capped at 2^31-1 ms and re-armed until the renewal time (48 days), then renews", async () => {
  const DAY = 86400000;
  const f = fixture({ expiresIn: 60 * 86400 });
  await f.manager.getToken();
  assert.deepEqual(f.logs, ["[twitch-app] app token ready (renews in about 48 days)"]);
  assert.equal(f.live().at(-1).delay, 2147483647, "Node's largest delay (a longer one would fire at once)");
  f.time(2147483647);
  f.live().at(-1).fn();                               // the capped delay ran out: 24.9 days, not time yet
  assert.equal(f.mints, 1, "no mint before 48 days");
  assert.equal(f.live().at(-1).delay, 48 * DAY - 2147483647, "re-armed for the rest");
  f.time(48 * DAY);
  f.live().at(-1).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.mints, 2, "renewed at 48 days");
});

test("a 401: one mint, one retry with the new token; concurrent 401s share the mint; a second 401 goes back to the caller", async () => {
  const f = fixture();
  const old = await f.manager.getToken();
  f.reject(2);
  const answers = await Promise.all([
    f.manager.request({ method: "get", url: "https://api.twitch.tv/helix/eventsub/subscriptions" }),
    f.manager.request({ method: "get", url: "https://api.twitch.tv/helix/eventsub/subscriptions" }),
  ]);
  assert.ok(answers.every((a) => a.status === 200));
  assert.equal(f.mints, 2, "both 401s for the same old token shared one mint");
  const h = f.helix();
  assert.equal(h.length, 4, "two requests, one retry each");
  assert.equal(h[0].config.headers.Authorization, `Bearer ${old}`);
  assert.match(h[3].config.headers.Authorization, /^Bearer test-app-token-not-real-2$/);
  // twice 401 in a row: the second goes back to the caller (no loop)
  f.reject(2);
  await assert.rejects(f.manager.request({ method: "get", url: "https://api.twitch.tv/helix/x" }), (e) => e.response.status === 401);
  assert.equal(f.mints, 3, "one mint for that request");
  assert.equal(f.helix().length, 6, "one retry, not more");
  // a 401 whose mint fails: the caller gets the 401 it had (not the mint's failure), the mint failure is logged
  f.fail(httpError(503, { message: "unavailable" }));
  f.reject(1);
  await assert.rejects(f.manager.request({ method: "get", url: "https://api.twitch.tv/helix/x" }), (e) => e.response.status === 401);
  assert.equal(f.helix().length, 7, "no retry without a new token");
  assert.match(f.logs.at(-1), /^\[twitch-app\] renewal failed \(HTTP 503\); retrying in a minute$/);
});

test("any other Helix failure (a 403, a 500, no answer at all) goes back to the caller as it is: no mint, no retry", async () => {
  for (const make of [httpError(403, { message: "subscription missing proper authorization" }), httpError(500, {}), netError("ECONNRESET")]) {
    let mints = 0, sent = 0;
    const m = createAppTokenManager({
      http: { post: async () => ({ data: { access_token: "test-app-token-not-real-" + ++mints, expires_in: 100 } }),
              request: async () => { sent++; throw make(); } },
      env: { TWITCH_CLIENT_ID2: CLIENT, TWITCH_SECRET_KEY2: SECRET }, later: () => null, cancel() {}, now: () => 0, log() {},
    });
    const want = make();
    await assert.rejects(m.request({ method: "get", url: "https://api.twitch.tv/helix/x" }),
                         (e) => (e.response ? e.response.status : e.code) === (want.response ? want.response.status : want.code));
    assert.equal(mints, 1, "only the first mint");
    assert.equal(sent, 1, "no retry");
  }
});

test("request(): the Helix headers (Client-ID + Bearer), the caller's own headers kept, 15 s timeout, no redirect followed", async () => {
  const f = fixture();
  await f.manager.request({ method: "post", url: "https://api.twitch.tv/helix/eventsub/subscriptions", data: { type: "t" },
                            headers: { "Content-Type": "application/json" }, maxRedirects: 5 });
  const [{ config }] = f.helix();
  assert.equal(config.method, "post");
  assert.deepEqual(config.data, { type: "t" });
  assert.equal(config.headers["Content-Type"], "application/json");
  assert.equal(config.headers["Client-ID"], CLIENT);
  assert.match(config.headers.Authorization, /^Bearer test-app-token-not-real-1$/);
  assert.equal(config.maxRedirects, 0, "the bearer token is never forwarded to a redirect");
  assert.equal(config.timeout, 15000);
});

test("TWITCH_ACCESS_TOKEN only when the first mint fails, until a mint works; never again after a successful mint", async () => {
  const f = fixture();
  f.fail(httpError(403, { status: 403, message: "invalid client secret" }));
  assert.equal(await f.manager.getToken(), STATIC, "the start-up fallback");
  assert.deepEqual(f.manager.info(), { minted: false, fallback: true, lifetimeMs: 0, expiresAt: Infinity, renewAt: 60000 });
  assert.deepEqual(f.logs, ["[twitch-app] startup mint failed (HTTP 403); using TWITCH_ACCESS_TOKEN until a mint works"]);
  assert.equal(f.live().at(-1).delay, 60000, "a mint is tried again in a minute");
  f.time(60000);
  assert.equal(await f.manager.getToken(), STATIC, "still failing: the fallback stays (it has no known expiry)");
  f.fail(null);
  f.time(120000);
  const minted = await f.manager.getToken();
  assert.match(minted, MINTED, "a mint worked: the minted token from now on");
  assert.equal(f.manager.info().fallback, false);
  // after a successful mint the static token never comes back - a failed renewal keeps the minted one while it is valid
  f.fail(netError("ECONNREFUSED"));
  f.time(120000 + 80000);
  assert.equal(await f.manager.getToken(), minted, "still valid: kept through the failed renewal");
  f.time(120000 + 100000);
  await assert.rejects(f.manager.getToken(), (e) => /renewal failed/.test(e.message) && e.reason === "ECONNREFUSED");
  assert.ok(!f.logs.join("\n").match(VALUES), "no value in any log line: " + f.logs.join(" | "));
  assert.ok(f.logs.some((l) => l === "[twitch-app] renewal failed (ECONNREFUSED); retrying in a minute"));
});

test("a failed first mint without TWITCH_ACCESS_TOKEN rejects (server.js then deletes nothing); missing credentials send nothing", async () => {
  const f = fixture({ env: { TWITCH_CLIENT_ID2: CLIENT, TWITCH_SECRET_KEY2: SECRET } });
  f.fail(httpError(400, { status: 400, message: "invalid client" }));
  await assert.rejects(f.manager.getToken(), (e) => e.code === "APP_TOKEN_MINT_FAILED" && e.reason === "HTTP 400");
  assert.deepEqual(f.logs, ["[twitch-app] startup mint failed (HTTP 400) and there is no TWITCH_ACCESS_TOKEN; retrying in a minute"]);
  const none = fixture({ env: { TWITCH_ACCESS_TOKEN: "" } });
  await assert.rejects(none.manager.getToken(), (e) => e.reason === "NO_APP_CREDENTIALS");
  assert.equal(none.calls.length, 0, "without the pair nothing is sent");
  const half = fixture({ env: { TWITCH_CLIENT_ID2: CLIENT, TWITCH_ACCESS_TOKEN: STATIC } });
  assert.equal(await half.manager.getToken(), STATIC, "the pair half set: the fallback, nothing sent");
  assert.equal(half.calls.length, 0);
  assert.deepEqual(half.logs, ["[twitch-app] startup mint failed (NO_APP_CREDENTIALS); using TWITCH_ACCESS_TOKEN until a mint works"]);
});

test("a token answer without a token or a lifetime is a failed mint", async () => {
  for (const data of [{}, { access_token: "" , expires_in: 100 }, { access_token: "test-app-token-not-real-x" },
                      { access_token: "test-app-token-not-real-x", expires_in: 0 }, { access_token: 5, expires_in: 100 },
                      { access_token: "test-app-token-not-real-x", expires_in: "soon" }]) {
    const logs = [];
    const m = createAppTokenManager({ http: { post: async () => ({ data }) }, env: { TWITCH_CLIENT_ID2: CLIENT, TWITCH_SECRET_KEY2: SECRET },
                                      later: () => null, cancel() {}, now: () => 0, log: (l) => logs.push(l) });
    await assert.rejects(m.getToken(), (e) => e.reason === "BAD_TOKEN_ANSWER", JSON.stringify(data));
    assert.ok(!logs.join(" ").includes("test-app-token"), "the answer is never logged");
  }
});

test("a failed renewal is retried once a minute (not on every call) and logged once an hour while it lasts", async () => {
  const f = fixture();
  const first = await f.manager.getToken();
  f.fail(httpError(500, { message: "boom" }));
  f.time(80000);
  assert.equal(await f.manager.getToken(), first);
  assert.equal(f.mints, 2);
  for (let i = 0; i < 5; i++) await f.manager.getToken();
  assert.equal(f.mints, 2, "the next calls within the minute use the good token without minting");
  assert.equal(f.live().at(-1).delay, 60000);
  // a long outage with a static fallback (no expiry): 120 failed retries, two log lines
  const g = fixture();
  g.fail(netError("ETIMEDOUT"));
  await g.manager.getToken();                         // start-up: fallback
  for (let i = 1; i <= 120; i++) { g.time(i * 60000); await g.manager.getToken(); }
  const failed = g.logs.filter((l) => /renewal failed/.test(l));
  assert.deepEqual(failed, [
    "[twitch-app] renewal failed (ETIMEDOUT); retrying in a minute",
    "[twitch-app] renewal failed (ETIMEDOUT, 60 times in a row); retrying in a minute",
    "[twitch-app] renewal failed (ETIMEDOUT, 120 times in a row); retrying in a minute",
  ]);
  g.fail(null);
  g.time(121 * 60000);
  assert.match(await g.manager.getToken(), MINTED);
  assert.equal(g.logs.at(-1), "[twitch-app] app token ready (renews in about 1 minute)");
  assert.ok(!g.logs.join("\n").match(VALUES), "a network error's message (it can say anything) is never logged");
});

test("a retry timer that fires a moment early (Node's timer clock vs Date.now) is re-armed, and the next tick retries", async () => {
  const f = fixture();
  const first = await f.manager.getToken();
  f.fail(httpError(500, { message: "boom" }));
  f.time(80000);
  f.live().at(-1).fn();                               // the renewal timer: the mint fails, a retry a minute later
  await new Promise((r) => setImmediate(r));
  assert.equal(f.mints, 2);
  assert.equal(f.live().length, 1);
  assert.equal(f.live().at(-1).delay, 60000);
  f.fail(null);
  f.time(80000 + 60000 - 1);                          // the retry timer fires 1 ms before the retry time
  f.live().at(-1).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.mints, 2, "not yet: the retry minute isn't over");
  assert.equal(f.live().length, 1, "a timer is still armed (it used to be none: no renewal until some call came)");
  f.time(80000 + 60000 - 1 + f.live().at(-1).delay);
  f.live().at(-1).fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.mints, 3, "the re-armed timer retried the renewal");
  assert.notEqual(await f.manager.getToken(), first, "and the new token is the one used");
  assert.equal(f.live().length, 1, "one live timer: the new token's renewal");
});

test("stop(): the timer is cancelled and none is set again", async () => {
  const f = fixture();
  await f.manager.getToken();
  assert.equal(f.live().length, 1);
  f.manager.stop();
  assert.equal(f.live().length, 0);
  f.time(80000);
  await f.manager.getToken();
  assert.equal(f.live().length, 0, "a mint after stop() sets no timer");
});

test("why() / span(): a status or a code, never a message, body or request; durations", () => {
  assert.equal(why(httpError(401, { message: "Invalid OAuth token", token: "test-app-token-not-real" })()), "HTTP 401");
  assert.equal(why({ response: { status: "x" } }), "HTTP ?");
  assert.equal(why(netError("ECONNREFUSED")()), "ECONNREFUSED");
  assert.equal(why(Object.assign(new Error(SECRET), { code: "bad code " + SECRET })), "error");
  assert.equal(why(new Error(SECRET)), "error");
  assert.equal(why(null), "error");
  assert.equal(why("text " + SECRET), "error");
  assert.equal(span(48 * 86400000), "48 days");
  assert.equal(span(5 * 3600000), "5 hours");
  assert.equal(span(80000), "1 minute");
  assert.equal(span(2880000), "48 minutes");
  assert.equal(span(10), "1 minute");
});

test("source: apptoken.js loads nothing and writes nothing; server.js sends every Helix call through it", () => {
  const src = fs.readFileSync(path.join(repo, "twitchbot", "apptoken.js"), "utf8");
  assert.doesNotMatch(src, /require\(/, "no module: no file, no network but the http it is given");
  assert.doesNotMatch(src, /process\.env\.\w+\s*=|writeFile|appendFile|console\.\w+\(/, "nothing written, nothing printed directly");
  const srv = fs.readFileSync(path.join(repo, "server.js"), "utf8");
  assert.match(srv, /const appTokens = require\("\.\/twitchbot\/apptoken"\)\.createAppTokenManager\(\{ http: axios, env: process\.env \}\);/);
  assert.doesNotMatch(srv, /process\.env\.TWITCH_ACCESS_TOKEN/, "the static token is read by apptoken.js only (the start-up fallback)");
  assert.doesNotMatch(srv, /axios\.(get|post|put|patch|delete|request)\(/, "no Helix call around the manager");
  assert.equal((srv.match(/appTokens\.request\(\{/g) || []).length, 3, "the list, the delete, the create");
  const cb = srv.slice(srv.indexOf("require('./listen').listen("));
  const tok = cb.indexOf("await appTokens.getToken();"), del = cb.indexOf("await deleteAllSubscriptions();");
  assert.ok(tok > 0 && del > tok, "the token first: without one, no subscription is deleted");
});
