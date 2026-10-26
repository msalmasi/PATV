// 1.99afh review: pm2 'server' (server.js: the EventSub webhook + twitchbot/twitch.js's tmi chat bot and raffles) booted for
// real - tmi.js / eventsource faked, Twitch's API answering 401, the SITE refusing connections or answering 500 - and
//   * a chatter typing !spin, a raffle ending and a channel-point redemption while the site is down neither reject unhandled
//     (Node 22 would exit pm2 'server' - inside the prod updater's stability check that rolls the deploy back) nor log the
//     bot token / X-PATV-Key / the app token: every failure is logged as status + answer (errInfo);
//   * the next raffle still starts after a failed draw; the chatter / redeemer is told in chat;
//   * the webhook server.js serves answers Twitch's challenge (text/plain) and refuses a bad signature.
//   NODE_PATH=G:/PATV/node_modules node --test test/twitch-bot-errors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const util = require("util");
const Module = require("module");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "twitch-bot-errors-")));   // dotenv finds no .env; the DB is a scratch one
const TOKEN = "SECRET-BOT-TOKEN-7f3a", KEY = "twitch.SECRET-PATV-KEY-91c2", APP = "SECRET-APP-TOKEN-55aa", ES = "eventsub-test-secret";
delete process.env.STAGING;
Object.assign(process.env, { TWITCH_BOT_TOKEN: TOKEN, PATV_KEY: KEY, TWITCH_ACCESS_TOKEN: APP, TWITCH_CLIENT_ID2: "client-id",
                             TWITCH_EVENTSUB_SECRET: ES, TWITCH_BROADCASTER_ID: "77", TWITCH_OAUTH_TOKEN: "oauth:SECRET-CHAT",
                             PORT: "0", BIND_HOST: "127.0.0.1", SECRET_KEY: "test-secret" });

// ── fakes: the chat client (tmi.js) and the /events streams (eventsource) aren't installed for the site's tests ──
const said = [];
class FakeTmiClient {
  constructor(opts) { this.opts = opts; this.handlers = {}; FakeTmiClient.last = this; }
  connect() { return Promise.resolve(); }
  on(ev, fn) { this.handlers[ev] = fn; return this; }
  say(channel, text) { said.push(text); return Promise.resolve([channel, text]); }
}
class FakeEventSource { constructor(url) { this.url = url; } close() { this.closed = true; } }
const fakes = { "tmi.js": { Client: FakeTmiClient }, eventsource: FakeEventSource };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (Object.prototype.hasOwnProperty.call(fakes, request)) return "fake:" + request;
  return origResolve.call(this, request, parent, ...rest);
};
for (const [k, v] of Object.entries(fakes)) {
  const m = new Module("fake:" + k);
  m.exports = v;
  m.loaded = true;
  require.cache["fake:" + k] = m;
}

// ── Twitch's API answers 401 (server.js's startup lists / creates the EventSub subscription with the app token) ──
const axios = require("axios");
const httpAdapter = axios.getAdapter(["http"]);
axios.defaults.adapter = (config) => {
  if (/^https:\/\/api\.twitch\.tv\//.test(String(config.url))) {
    const response = { status: 401, statusText: "Unauthorized", headers: {}, config, data: { error: "Unauthorized", status: 401, message: "Invalid OAuth token" } };
    return Promise.reject(new axios.AxiosError("Request failed with status code 401", "ERR_BAD_REQUEST", config, null, response));
  }
  return httpAdapter(config);
};

// ── everything logged, as the logs would hold it (objects inspected deeply: a raw AxiosError shows its headers) ──
const logs = [];
const origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
for (const k of Object.keys(origConsole)) {
  console[k] = (...a) => { logs.push(a.map((x) => (typeof x === "string" ? x : util.inspect(x, { depth: 6 }))).join(" ")); };
}
const unhandled = [];
process.on("unhandledRejection", (r) => unhandled.push(r));
const leaks = () => logs.filter((l) => /SECRET/.test(l));

// a timer created while `fn` runs synchronously doesn't keep the test process alive (the 15-60 minute raffle, !spin's cooldown)
const realSetTimeout = global.setTimeout;
function unrefTimers(fn) {
  global.setTimeout = (cb, ms, ...a) => { const t = realSetTimeout(cb, ms, ...a); if (t && t.unref) t.unref(); return t; };
  try { return fn(); } finally { global.setTimeout = realSetTimeout; }
}
const sleep = (ms) => new Promise((res) => realSetTimeout(res, ms));
async function until(cond, what, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for " + what + "\n" + logs.slice(-15).join("\n"));
    await sleep(10);
  }
}

// the site: a port nothing listens on (ECONNREFUSED), or one that answers 500 to everything
let refusedBase, failing, failingBase;
const servers = [];
let base = "", tw = null;

test.before(async () => {
  const probe = http.createServer();
  await new Promise((res) => probe.listen(0, "127.0.0.1", res));
  refusedBase = `http://127.0.0.1:${probe.address().port}`;
  await new Promise((res) => probe.close(res));
  failing = http.createServer((req, res) => { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Internal Server Error"); });
  await new Promise((res) => failing.listen(0, "127.0.0.1", res));
  failingBase = `http://127.0.0.1:${failing.address().port}`;
  process.env.BACKEND_BASE_URL = refusedBase;

  const L = require(path.join(repo, "listen"));
  const origListen = L.listen;
  L.listen = (...a) => { const s = origListen(...a); servers.push(...s); return s; };
  unrefTimers(() => require(path.join(repo, "server.js")));
  tw = require(path.join(repo, "twitchbot", "twitch.js"))._test;
  await until(() => logs.some((l) => /Webhook listener is running/.test(l)), "the webhook to listen");
  await until(() => logs.some((l) => /Error creating subscription/.test(l)), "the EventSub setup to finish");
  base = `http://127.0.0.1:${servers[0].address().port}`;
});

test.after(async () => {
  if (tw) tw.stopRaffle();
  for (const s of servers) { s.closeAllConnections(); s.close(); }
  if (failing) { failing.closeAllConnections(); failing.close(); }
  Object.assign(console, origConsole);
  Module._resolveFilename = origResolve;
});

test("startup: Twitch's 401s are logged as status + answer - never the app token", () => {
  const text = logs.join("\n");
  assert.match(text, /Error listing subscriptions: HTTP 401 \{"error":"Unauthorized","status":401,"message":"Invalid OAuth token"\}/);
  assert.match(text, /Error creating subscription: HTTP 401/);
  assert.deepEqual(leaks(), []);
  assert.deepEqual(unhandled, []);
});

for (const [label, site] of [["refuses connections", () => refusedBase], ["answers 500", () => failingBase]]) {
  test(`!spin while the site ${label}: the chatter is told, nothing rejects unhandled, no token in the logs`, async () => {
    process.env.BACKEND_BASE_URL = site();
    const n0 = logs.length, s0 = said.length;
    const id = label === "answers 500" ? "9002" : "9001";
    const tags = { "user-id": id, "display-name": "Spinner" + id, username: "spinner" + id, badges: {} };
    // through the chat client's own 'message' handler (it calls handleSpinCommand without a catch)
    const p = unrefTimers(() => FakeTmiClient.last.handlers.message("#publicaccess_ttv", tags, "!spin", false));
    await p;
    await until(() => said.slice(s0).some((t) => /can't find your PATV account right now/.test(t)), "the !spin error line");
    const mine = logs.slice(n0).join("\n");
    assert.match(mine, /!spin: looking up Spinner\d+ failed: (ECONNREFUSED|HTTP 500 Internal Server Error)/);
    // the direct call resolves (never rejects) too
    await tw.handleSpinCommand("#publicaccess_ttv", id + "1", "Direct" + id, null);
    await sleep(20);
    assert.deepEqual(leaks(), []);
    assert.deepEqual(unhandled, []);
    assert.equal(logs.some((l) => /\[server\] unhandled rejection/.test(l)), false, "nothing reached the process guard either");
  });

  test(`a raffle ending while the site ${label}: logged, the next raffle starts, nothing rejects unhandled, no token in the logs`, async () => {
    process.env.BACKEND_BASE_URL = site();
    const n0 = logs.length;
    tw.participants.add("4242");
    await tw.endRaffle("#publicaccess_ttv", 15);
    tw.stopRaffle();
    const mine = logs.slice(n0).join("\n");
    assert.match(mine, /Raffle draw failed: (ECONNREFUSED|HTTP 500 Internal Server Error)/);
    assert.match(mine, /Raffle started!/, "the next raffle is scheduled whatever happened to this one");
    assert.deepEqual(leaks(), []);
    assert.deepEqual(unhandled, []);
  });

  test(`a channel-point redemption through server.js while the site ${label}: 200 to Twitch, the viewer is told, the redemption id + login logged`, async () => {
    process.env.BACKEND_BASE_URL = site();
    const n0 = logs.length, s0 = said.length;
    const rid = "red-" + (label === "answers 500" ? "500" : "refused");
    const raw = JSON.stringify({ subscription: { type: "channel.channel_points_custom_reward_redemption.add", status: "enabled" },
                                 event: { id: rid, user_id: "1001", user_login: "ann_tv", user_name: "Ann", broadcaster_user_id: "77",
                                          reward: { id: "rw-25k", title: "Buy 25000 PAT", cost: 25000 } } });
    const mid = "msg-" + rid, ts = new Date().toISOString();
    const sig = "sha256=" + crypto.createHmac("sha256", ES).update(mid + ts + raw).digest("hex");
    const r = await fetch(base + "/webhooks/callback", { method: "POST", body: raw, headers: {
      "content-type": "application/json", "twitch-eventsub-message-id": mid, "twitch-eventsub-message-timestamp": ts,
      "twitch-eventsub-message-type": "notification", "twitch-eventsub-message-signature": sig } });
    assert.equal(r.status, 200);
    await until(() => said.slice(s0).some((t) => /^@Ann, something went wrong adding your PAT/.test(t)), "the redemption's chat line");
    const mine = logs.slice(n0).join("\n");
    assert.match(mine, new RegExp(`Channel Point Redemption ${rid} by Ann \\(ann_tv, 1001\\): Buy 25000 PAT \\(reward rw-25k, cost 25000\\)`));
    assert.match(mine, new RegExp(`redemption ${rid} by ann_tv: "Buy 25000 PAT" \\(reward rw-25k\\): the account lookup failed \\(not paid - credit or refund by hand\\): (ECONNREFUSED|HTTP 500)`));
    assert.deepEqual(leaks(), []);
    assert.deepEqual(unhandled, []);
  });
}

test("the webhook server.js serves: Twitch's challenge as text/plain; a bad signature 403", async () => {
  const raw = JSON.stringify({ challenge: "abc123-challenge", subscription: { type: "channel.channel_points_custom_reward_redemption.add" } });
  const mid = "msg-challenge", ts = new Date().toISOString();
  const head = (sig) => ({ "content-type": "application/json", "twitch-eventsub-message-id": mid, "twitch-eventsub-message-timestamp": ts,
                           "twitch-eventsub-message-type": "webhook_callback_verification", "twitch-eventsub-message-signature": sig });
  const ok = await fetch(base + "/webhooks/callback", { method: "POST", body: raw,
    headers: head("sha256=" + crypto.createHmac("sha256", ES).update(mid + ts + raw).digest("hex")) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /^text\/plain/);
  assert.equal(await ok.text(), "abc123-challenge");
  const bad = await fetch(base + "/webhooks/callback", { method: "POST", body: raw, headers: head("sha256=" + "0".repeat(64)) });
  assert.equal(bad.status, 403);
  assert.deepEqual(unhandled, []);
});
