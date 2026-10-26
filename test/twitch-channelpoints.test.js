// 1.99afh: the Twitch bot's side of channel-point redemptions (twitchbot/channelpoints.js, server.js, twitch.js).
//   * the EventSub signature over the RAW body (constant time), the 10-minute replay window, message / redemption de-dupe
//   * handleRedemption: never sends an amount, sends ref "twitch-cp:<redemption id>" + the Twitch user id, chat lines only for
//     PAT rewards, a 5xx / network failure is logged as status + answer only
//   * errInfo never prints a request's config or headers (the 10-24 log carried the bot token)
//   * review: the lines name the redemption id + the viewer's login; reward.cost is forwarded (the site's min cost)
//   * review: the webhook (channelpoints.webhookApp, what server.js serves) with express + signed requests - the challenge,
//     raw-body signatures, 403s, 200 before handling, replays, repeated message ids, other channels / subscription types
//   * review: guardProcess - an unhandled rejection is logged as errInfo and the process keeps running (a real child process)
//   * source checks: no number parsed from a title, no display-name lookup, no console.error(error) on axios errors
//   (the paid path against the real site routes is in test/twitchcp.test.js; server.js + twitch.js booted against a site
//   that is down in test/twitch-bot-errors.test.js)
//   NODE_PATH=G:/PATV/node_modules node --test test/twitch-channelpoints.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const CP = require(path.join(repo, "twitchbot", "channelpoints"));

const SECRET = "eventsub-secret-for-tests";
const sign = (id, ts, raw) => "sha256=" + crypto.createHmac("sha256", SECRET).update(id + ts + raw).digest("hex");
const hdrs = (id, ts, raw, sig) => ({ "twitch-eventsub-message-id": id, "twitch-eventsub-message-timestamp": ts,
                                      "twitch-eventsub-message-signature": sig === undefined ? sign(id, ts, raw) : sig });

test("isPatReward: 'PAT' as a word, case-sensitive", () => {
  for (const t of ["Buy 5000 PAT", "Buy 25000 PAT", "Buy 500000 PAT", "PAT", "100 PAT!", "Get PAT"]) assert.equal(CP.isPatReward(t), true, t);
  for (const t of ["Pet dog", "Give dog a treat", "Go to the dog park", "Pat the dog", "PATV merch", "SPAT", "", null, undefined]) {
    assert.equal(CP.isPatReward(t), false, String(t));
  }
});

test("verifySignature: HMAC over id + timestamp + the raw bytes; anything else fails", () => {
  const raw = Buffer.from('{"subscription":{"type":"x"},"event":{"reward":{"title":"Café ☕ \\u00e9"}}}', "utf8");
  const id = "msg-1", ts = "2026-10-26T17:00:00.123456789Z";
  assert.equal(CP.verifySignature(SECRET, hdrs(id, ts, raw), raw), true);
  assert.equal(CP.verifySignature(SECRET, hdrs(id, ts, raw), raw.toString("utf8")), true, "a string body works too");
  assert.equal(CP.verifySignature(SECRET, hdrs(id, ts, raw), Buffer.from(JSON.stringify(JSON.parse(raw)))), false,
               "re-serialised JSON is not what Twitch signed (hence the raw body)");
  assert.equal(CP.verifySignature("other-secret", hdrs(id, ts, raw), raw), false);
  assert.equal(CP.verifySignature(SECRET, hdrs("msg-2", ts, raw, sign(id, ts, raw)), raw), false, "another message id");
  assert.equal(CP.verifySignature(SECRET, hdrs(id, ts, raw, "sha256=00"), raw), false, "short signature");
  assert.equal(CP.verifySignature(SECRET, hdrs(id, ts, raw, ""), raw), false);
  assert.equal(CP.verifySignature("", hdrs(id, ts, raw), raw), false, "no secret configured: nothing verifies");
  assert.equal(CP.verifySignature(SECRET, {}, raw), false);
  assert.equal(CP.verifySignature(SECRET, null, raw), false);
});

test("fresh: within 10 minutes either way (nanosecond timestamps parse)", () => {
  const now = Date.parse("2026-10-26T17:00:00Z");
  assert.equal(CP.fresh("2026-10-26T16:55:00.123456789Z", now), true);
  assert.equal(CP.fresh("2026-10-26T16:49:59Z", now), false);
  assert.equal(CP.fresh("2026-10-26T17:09:00Z", now), true);
  assert.equal(CP.fresh("2026-10-26T17:11:00Z", now), false);
  assert.equal(CP.fresh("nope", now), false);
  assert.equal(CP.fresh(undefined, now), false);
});

test("Recent: add() is false the second time; bounded", () => {
  const r = new CP.Recent(3);
  assert.equal(r.add("a"), true);
  assert.equal(r.add("a"), false);
  r.add("b"); r.add("c"); r.add("d");
  assert.equal(r.has("a"), false, "the oldest went");
  assert.equal(r.has("d"), true);
});

test("errInfo: the status and the answer only - never the config, headers or request", () => {
  const e = new Error("Request failed with status code 409");
  e.code = "ERR_BAD_REQUEST";
  e.config = { headers: { Authorization: "Bearer SECRET-APP-TOKEN", "X-Bot-Token": "SECRET-BOT", "X-PATV-Key": "twitch.SECRET" },
               data: JSON.stringify({ password: "SECRET-BOT" }) };
  e.request = { _header: "POST /api/bonus/chatwinner\r\nX-Bot-Token: SECRET-BOT" };
  e.response = { status: 409, data: { success: false, error: "unfunded" }, config: e.config, headers: { "set-cookie": "x" } };
  const s = CP.errInfo(e);
  assert.equal(s, 'HTTP 409 {"success":false,"error":"unfunded"}');
  assert.doesNotMatch(s, /SECRET/);
  const net = new Error("connect ECONNREFUSED 127.0.0.1:8080");
  net.code = "ECONNREFUSED";
  net.config = e.config;
  assert.equal(CP.errInfo(net), "ECONNREFUSED connect ECONNREFUSED 127.0.0.1:8080");
  assert.equal(CP.errInfo({ response: { status: 500, data: "x".repeat(1000) } }).length <= 309, true, "bounded");
  assert.equal(CP.errInfo(undefined), "undefined");
});

// ── handleRedemption with a fake http ──
function fakeDeps(o = {}) {
  const calls = [], said = [], logs = [];
  const http = {
    get: async (url) => {
      calls.push({ m: "get", url });
      if (o.lookup) return o.lookup(url);
      return { data: { user: { userId: "u-1", username: "ann" } } };
    },
    post: async (url, body) => {
      calls.push({ m: "post", url, body });
      if (o.credit) return o.credit(url, body);
      return { data: { message: "ok", amount: 5000 } };
    },
  };
  return { calls, said, logs, deps: { http, base: "https://site.example", token: "SECRET-BOT", say: (t) => said.push(t), recent: new CP.Recent(),
                                      log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) } };
}
const ev = (o = {}) => Object.assign({ id: "red-1", user_id: "1001", user_login: "ann", user_name: "Ann", broadcaster_user_id: "77",
                                       reward: { id: "rw-1", title: "Buy 5000 PAT", cost: 5000 } }, o);
const httpErr = (status, data) => Object.assign(new Error("Request failed with status code " + status),
  { response: { status, data }, config: { headers: { "X-Bot-Token": "SECRET-BOT" }, data: '{"password":"SECRET-BOT"}' } });

test("handleRedemption: looks up by Twitch user id, never sends an amount, sends the ref + reward + Twitch id", async () => {
  const f = fakeDeps();
  assert.deepEqual(await CP.handleRedemption(ev(), f.deps), { outcome: "ok", amount: 5000 });
  assert.equal(f.calls[0].url, "https://site.example/api/users/twitch/1001");
  const post = f.calls[1];
  assert.equal(post.url, "https://site.example/api/bonus/chatwinner");
  assert.deepEqual(post.body, { password: "SECRET-BOT", userId: "u-1", twitch_user_id: "1001", type: "twitch-channelpoints",
                                reward_id: "rw-1", reward_title: "Buy 5000 PAT", reward_cost: 5000, ref: "twitch-cp:red-1" });
  assert.equal("amount" in post.body, false, "the site decides the amount");
  // the cost is forwarded only as Twitch's whole number (the site refuses a costed reward without one)
  for (const [cost, sent] of [[0, 0], [1, 1], ["5000", null], [-1, null], [1.5, null], [undefined, null]]) {
    const c = fakeDeps();
    await CP.handleRedemption(ev({ id: "red-c" + String(cost), reward: { id: "rw-1", title: "Buy 5000 PAT", cost } }), c.deps);
    assert.equal(c.calls[1].body.reward_cost, sent, `cost ${JSON.stringify(cost)}`);
  }
  assert.deepEqual(f.said, ["@Ann exchanged channel points for PAT 5,000!"]);
  // the same redemption again (a re-delivery) never reaches the site
  assert.equal((await CP.handleRedemption(ev(), f.deps)).outcome, "duplicate");
  assert.equal(f.calls.length, 2);
  // a Twitch id with path characters is encoded
  const g = fakeDeps();
  await CP.handleRedemption(ev({ id: "red-x", user_id: "../../pepe" }), g.deps);
  assert.equal(g.calls[0].url, "https://site.example/api/users/twitch/..%2F..%2Fpepe");
});

test("handleRedemption: refusals - chat lines for PAT rewards only; the site's duplicate is quiet", async () => {
  const cases = [
    ["not_allowlisted", "Buy 500000 PAT", /^@Ann, "Buy 500000 PAT" doesn't pay PAT, so nothing was added\. The streamer can refund your channel points\.$/],
    ["not_allowlisted", "Pet dog", null],
    ["unfunded", "Buy 5000 PAT", /this week's PAT reward budget is used up/],
    ["over_cap", "Buy 25000 PAT", /paused right now/],
    ["no_route", "Buy 5000 PAT", /paused right now/],
    ["no_user", "Buy 5000 PAT", /no PATV account is linked/],
    ["under_cost", "Buy 25000 PAT", /^@Ann, "Buy 25000 PAT" costs fewer channel points than its PAT needs, so nothing was added\. The streamer can refund/],
    ["over_daily", "Buy 25000 PAT", /^@Ann, you've reached today's PAT limit for channel points, so nothing was added\./],
  ];
  for (const [error, title, line] of cases) {
    const f = fakeDeps({ credit: () => { throw httpErr(error === "no_user" ? 404 : 409, { success: false, error }); } });
    assert.deepEqual(await CP.handleRedemption(ev({ reward: { id: "r", title } }), f.deps), { outcome: error }, `${error} ${title}`);
    if (line) { assert.equal(f.said.length, 1); assert.match(f.said[0], line); } else assert.deepEqual(f.said, [], `${title}: silent`);
  }
  // an allow-listed reward without "PAT" in its title (pinned by id) still gets its refusal explained
  const pinned = fakeDeps({ credit: () => { throw httpErr(409, { success: false, error: "unfunded" }); } });
  await CP.handleRedemption(ev({ reward: { id: "r", title: "Treasure chest" } }), pinned.deps);
  assert.match(pinned.said[0], /budget is used up/);
  const dup = fakeDeps({ credit: () => ({ data: { duplicate: true, amount: 5000 } }) });
  assert.deepEqual(await CP.handleRedemption(ev(), dup.deps), { outcome: "duplicate", amount: 5000 });
  assert.deepEqual(dup.said, []);
});

test("handleRedemption: no account (404) / lookup failure / site failure; nothing secret is logged", async () => {
  const none = fakeDeps({ lookup: () => { throw httpErr(404, { message: "User not found" }); } });
  assert.deepEqual(await CP.handleRedemption(ev(), none.deps), { outcome: "no_user" });
  assert.match(none.said[0], /no PATV account/);
  assert.equal(none.calls.length, 1, "nothing credited");
  const dog = fakeDeps({ lookup: () => { throw httpErr(404, {}); } });
  await CP.handleRedemption(ev({ reward: { id: "d", title: "Pet dog" } }), dog.deps);
  assert.deepEqual(dog.said, []);
  const down = fakeDeps({ lookup: () => { throw httpErr(502, "<html>bad gateway</html>"); } });
  assert.deepEqual(await CP.handleRedemption(ev(), down.deps), { outcome: "error" });
  assert.match(down.said[0], /something went wrong/);
  const boom = fakeDeps({ credit: () => { throw httpErr(500, "Failed to process bonus winner"); } });
  assert.deepEqual(await CP.handleRedemption(ev(), boom.deps), { outcome: "error" });
  const net = fakeDeps({ credit: () => { throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET", config: { data: '{"password":"SECRET-BOT"}' } }); } });
  assert.deepEqual(await CP.handleRedemption(ev(), net.deps), { outcome: "error" });
  const text = [none, dog, down, boom, net].map((f) => f.logs.join("\n")).join("\n");
  assert.match(text, /HTTP 502/);
  assert.match(text, /ECONNRESET/);
  assert.doesNotMatch(text, /SECRET/, "never a token in the logs");
  // review: a redemption lost to a site error is never retried, so its lines name the redemption id + the viewer's login
  assert.match(down.logs.join("\n"), /redemption red-1 by ann: "Buy 5000 PAT" \(reward rw-1\): the account lookup failed \(not paid - credit or refund by hand\): HTTP 502/);
  assert.match(boom.logs.join("\n"), /redemption red-1 by ann: "Buy 5000 PAT" \(reward rw-1\): crediting failed \(not paid - credit or refund by hand\): HTTP 500/);
  assert.match(net.logs.join("\n"), /redemption red-1 by ann: .*crediting failed .*ECONNRESET/);
  assert.match(none.logs.join("\n"), /redemption red-1 by ann: "Buy 5000 PAT" \(reward rw-1\): no PATV account/);
  const refused = fakeDeps({ credit: () => { throw httpErr(409, { success: false, error: "under_cost" }); } });
  await CP.handleRedemption(ev({ id: "red-9", user_login: "bob_t" }), refused.deps);
  assert.match(refused.logs.join("\n"), /redemption red-9 by bob_t: "Buy 5000 PAT" \(reward rw-1\) refused: under_cost/);
  assert.deepEqual(await CP.handleRedemption({ reward: {} }, fakeDeps().deps), { outcome: "bad_event" });
  assert.deepEqual(await CP.handleRedemption(null, fakeDeps().deps), { outcome: "bad_event" });
  // a chat client that throws doesn't break it
  const loud = fakeDeps();
  loud.deps.say = () => { throw new Error("not connected"); };
  assert.equal((await CP.handleRedemption(ev(), loud.deps)).outcome, "ok");
});

// ── the EventSub webhook (channelpoints.webhookApp - the very app server.js serves) with express + signed requests ──
const express = require("express");
const bodyParser = require("body-parser");

async function hook(o = {}) {
  const got = [], logs = [];
  const app = CP.webhookApp({ express, bodyParser, secret: o.secret === undefined ? () => SECRET : o.secret,
                              broadcasterId: o.broadcasterId === undefined ? "77" : o.broadcasterId,
                              onRedemption: o.onRedemption || (async (e) => { got.push(e); }),
                              log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")) });
  const server = await new Promise((res) => { const s = app.listen(0, "127.0.0.1", () => res(s)); });
  const url = `http://127.0.0.1:${server.address().port}${CP.WEBHOOK_PATH}`;
  let n = 0;
  const post = async (raw, h = {}) => {
    const id = h.id || `msg-${++n}-${Date.now()}`, ts = h.ts || new Date().toISOString();
    const headers = { "content-type": h.contentType || "application/json", "twitch-eventsub-message-id": id,
                      "twitch-eventsub-message-timestamp": ts, "twitch-eventsub-message-type": h.type || "notification",
                      "twitch-eventsub-message-signature": h.sig === undefined ? sign(id, ts, raw) : h.sig };
    if (h.sig === null) delete headers["twitch-eventsub-message-signature"];
    const r = await fetch(url, { method: "POST", headers, body: raw });
    const out = { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
    await new Promise((res) => setImmediate(res));           // the handler's own microtasks
    return out;
  };
  return { got, logs, post, close: () => new Promise((res) => { server.closeAllConnections(); server.close(res); }) };
}
const notification = (o = {}) => JSON.stringify({
  subscription: { id: "sub-1", type: o.subType || CP.REDEMPTION_ADD, status: "enabled" },
  event: Object.assign({ id: "red-1", user_id: "1001", user_login: "ann", user_name: "Ann", broadcaster_user_id: "77",
                         reward: { id: "rw-1", title: "Buy 5000 PAT", cost: 5000 } }, o.event || {}),
});

test("webhook: the challenge is answered as text/plain with the raw challenge; nothing is redeemed", async () => {
  const h = await hook();
  try {
    const raw = JSON.stringify({ challenge: "pogchamp-kappa-360noscope-vohiyo", subscription: { type: CP.REDEMPTION_ADD } });
    const r = await h.post(raw, { type: "webhook_callback_verification" });
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/plain/);
    assert.equal(r.text, "pogchamp-kappa-360noscope-vohiyo");
    const unsigned = await h.post(raw, { type: "webhook_callback_verification", sig: "sha256=" + "0".repeat(64) });
    assert.equal(unsigned.status, 403, "a challenge must be signed too");
    assert.equal(h.got.length, 0);
  } finally { await h.close(); }
});

test("webhook: a bad / missing signature, another secret, an unset secret or a non-JSON body -> 403, nothing redeemed", async () => {
  const h = await hook();
  const raw = notification();
  try {
    assert.equal((await h.post(raw, { sig: "sha256=" + "f".repeat(64) })).status, 403);
    assert.equal((await h.post(raw, { sig: null })).status, 403);
    assert.equal((await h.post(raw, { sig: "sha256=" + crypto.createHmac("sha256", "other").update("x").digest("hex") })).status, 403);
    const r = await h.post(raw, { contentType: "text/plain" });
    assert.deepEqual([r.status, r.text], [403, "Forbidden"], "no raw JSON body captured: never verified against a re-serialised one");
    assert.equal(h.got.length, 0);
  } finally { await h.close(); }
  const unset = await hook({ secret: () => undefined });
  try {
    assert.equal((await unset.post(raw)).status, 403, "TWITCH_EVENTSUB_SECRET unset: nothing verifies");
    assert.equal(unset.got.length, 0);
  } finally { await unset.close(); }
});

test("webhook: the signature is checked over the RAW bytes (spacing, \\u escapes), not re-serialised JSON", async () => {
  const h = await hook();
  try {
    const raw = `{ "subscription" : { "type" : "${CP.REDEMPTION_ADD}" },\n  "event": {"id":"red-raw","user_id":"1001","user_login":"ann","user_name":"Ann",` +
                `"broadcaster_user_id":"77","reward":{"id":"rw-1","title":"Buy 5000 PAT \\u2615","cost":5000}} }`;
    assert.notEqual(JSON.stringify(JSON.parse(raw)), raw);
    const reser = JSON.stringify(JSON.parse(raw));
    const id = "msg-reser", ts = new Date().toISOString();
    assert.equal((await h.post(raw, { id, ts, sig: sign(id, ts, reser) })).status, 403, "a signature over the re-serialised body doesn't verify");
    assert.equal((await h.post(raw)).status, 200);
    assert.equal(h.got.length, 1);
    assert.equal(h.got[0].id, "red-raw");
    assert.equal(h.got[0].reward.title, "Buy 5000 PAT ☕");
  } finally { await h.close(); }
});

test("webhook: a notification is answered 200 before it is handled, then redeemed once with its id / login / reward / cost logged", async () => {
  let release;
  const gate = new Promise((res) => { release = res; });
  const handled = [];
  const h = await hook({ onRedemption: async (e) => { handled.push(e.id); await gate; handled.push("done"); } });
  try {
    const r = await h.post(notification());
    assert.equal(r.status, 200, "answered while the redemption is still being handled");
    assert.deepEqual(handled, ["red-1"]);
    release();
    await gate;
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(handled, ["red-1", "done"]);
    assert.match(h.logs.join("\n"), /Channel Point Redemption red-1 by Ann \(ann, 1001\): Buy 5000 PAT \(reward rw-1, cost 5000\)/);
  } finally { release(); await h.close(); }
});

test("webhook: a replay (> 10 min old), a repeated message id, another channel, another subscription type, a revocation - 200, not redeemed", async () => {
  const h = await hook();
  try {
    const old = await h.post(notification({ event: { id: "red-old" } }), { ts: new Date(Date.now() - 11 * 60 * 1000).toISOString() });
    assert.equal(old.status, 200, "acknowledged (no re-send) ...");
    assert.equal(h.got.length, 0, "... and dropped");
    assert.match(h.logs.join("\n"), /older than 10 minutes - ignored/);
    const future = await h.post(notification({ event: { id: "red-fut" } }), { ts: new Date(Date.now() + 11 * 60 * 1000).toISOString() });
    assert.equal(future.status, 200);
    assert.equal(h.got.length, 0);
    // the same message delivered twice -> handled once
    assert.equal((await h.post(notification({ event: { id: "red-twice" } }), { id: "msg-same" })).status, 200);
    assert.equal((await h.post(notification({ event: { id: "red-twice" } }), { id: "msg-same" })).status, 200);
    assert.deepEqual(h.got.map((e) => e.id), ["red-twice"]);
    assert.match(h.logs.join("\n"), /msg-same was delivered again - ignored/);
    // another broadcaster's redemption
    assert.equal((await h.post(notification({ event: { id: "red-other", broadcaster_user_id: "999" } }))).status, 200);
    assert.match(h.logs.join("\n"), /another channel \(999\) - ignored/);
    // another subscription type (e.g. a follow) and an event without a reward
    assert.equal((await h.post(notification({ subType: "channel.follow", event: { id: "red-follow" } }))).status, 200);
    assert.equal((await h.post(JSON.stringify({ subscription: { type: CP.REDEMPTION_ADD }, event: { id: "red-noreward" } }))).status, 200);
    // a revocation
    const rev = await h.post(JSON.stringify({ subscription: { type: CP.REDEMPTION_ADD, status: "authorization_revoked" } }), { type: "revocation" });
    assert.equal(rev.status, 200);
    assert.match(h.logs.join("\n"), /Subscription revoked: .* authorization_revoked/);
    assert.deepEqual(h.got.map((e) => e.id), ["red-twice"]);
  } finally { await h.close(); }
  // TWITCH_BROADCASTER_ID unset: every channel's redemption (as before)
  const any = await hook({ broadcasterId: "" });
  try {
    await any.post(notification({ event: { id: "red-any", broadcaster_user_id: "999" } }));
    assert.deepEqual(any.got.map((e) => e.id), ["red-any"]);
  } finally { await any.close(); }
});

test("webhook: a redemption that throws (an AxiosError with tokens in its config) is logged as status + answer only", async () => {
  const unhandled = [];
  const onUnhandled = (r) => unhandled.push(r);
  process.on("unhandledRejection", onUnhandled);
  const h = await hook({ onRedemption: async () => { throw httpErr(502, "<html>bad gateway</html>"); } });
  try {
    assert.equal((await h.post(notification())).status, 200);
    await new Promise((res) => setTimeout(res, 20));
    assert.match(h.logs.join("\n"), /Channel point redemption failed: HTTP 502 <html>bad gateway<\/html>/);
    assert.doesNotMatch(h.logs.join("\n"), /SECRET/);
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", onUnhandled); await h.close(); }
});

// ── guardProcess (server.js) ──
test("guardProcess: an unhandled rejection is logged as status + answer and the process keeps running; an uncaught exception exits 1 - never the error object", () => {
  const EventEmitter = require("events");
  const proc = new EventEmitter();
  const logs = [], exits = [];
  CP.guardProcess(proc, { warn: (...a) => logs.push(a.join(" ")), exit: (c) => exits.push(c) });
  CP.guardProcess(proc, { warn: (...a) => logs.push(a.join(" ")), exit: (c) => exits.push(c) });
  assert.equal(proc.listenerCount("unhandledRejection"), 1, "installed once");
  proc.emit("unhandledRejection", httpErr(500, "Internal Server Error"));
  assert.match(logs[0], /^\[server\] unhandled rejection \(kept running\): HTTP 500 Internal Server Error/);
  proc.emit("unhandledRejection", "Not connected to server.");
  assert.match(logs[1], /kept running\): Not connected to server\.$/);
  assert.deepEqual(exits, []);
  const net = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED", config: { headers: { "X-Bot-Token": "SECRET-BOT" } } });
  proc.emit("uncaughtException", net);
  assert.match(logs[2], /^\[server\] uncaught exception - exiting: ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:9 @ at /);
  assert.deepEqual(exits, [1]);
  assert.doesNotMatch(logs.join("\n"), /SECRET/);
});

test("guardProcess in a real Node process: an AxiosError-like rejection no longer exits it or prints its headers (control: without it, it does)", () => {
  const { spawnSync } = require("child_process");
  const script = (guard) => `
    const CP = require(${JSON.stringify(path.join(repo, "twitchbot", "channelpoints"))});
    ${guard ? "CP.guardProcess(process);" : ""}
    const e = new Error("connect ECONNREFUSED 127.0.0.1:9");
    e.code = "ECONNREFUSED";
    e.config = { headers: { "X-Bot-Token": "SECRET-BOT-TOKEN", "X-PATV-Key": "twitch.SECRET-KEY" }, data: '{"password":"SECRET-BOT-TOKEN"}' };
    Promise.reject(e);
    setTimeout(() => console.log("still running"), 50);`;
  const guarded = spawnSync(process.execPath, ["-e", script(true)], { encoding: "utf8", timeout: 20000 });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /still running/);
  assert.match(guarded.stderr, /unhandled rejection \(kept running\): ECONNREFUSED/);
  assert.doesNotMatch(guarded.stderr + guarded.stdout, /SECRET/);
  const bare = spawnSync(process.execPath, ["-e", script(false)], { encoding: "utf8", timeout: 20000 });
  assert.notEqual(bare.status, 0, "Node exits on the unhandled rejection ...");
  assert.match(bare.stderr, /SECRET-BOT-TOKEN/, "... and prints the error's config (what server-error.log got)");
});

test("source: server.js installs the guard before the chat bot starts and serves channelpoints.webhookApp; twitch.js never logs a raw axios error", () => {
  const srv = fs.readFileSync(path.join(repo, "server.js"), "utf8");
  assert.doesNotMatch(srv, /title\.split\(/, "no number from the title");
  const guard = srv.indexOf("CP.guardProcess(process);"), bot = srv.indexOf('require("./twitchbot/twitch")');
  assert.ok(guard > 0 && bot > guard, "the guard is installed before twitch.js connects the chat bot");
  assert.match(srv, /const app = CP\.webhookApp\(\{\s*express,\s*bodyParser,\s*secret: \(\) => process\.env\.TWITCH_EVENTSUB_SECRET,\s*broadcasterId: process\.env\.TWITCH_BROADCASTER_ID,\s*onRedemption: redeemChannelPoints,\s*\}\);/);
  assert.match(srv, /require\('\.\/listen'\)\.listen\(app, PORT, 'webhooks'/);
  assert.doesNotMatch(srv, /app\.(post|use)\(|bodyParser\.json\(/, "the route and its body parser live in channelpoints.webhookApp only");
  assert.doesNotMatch(srv, /console\.(error|log|warn)\([^;]*\b(error|err|e)\)\s*;/, "server.js: no raw error objects in logs");
  assert.doesNotMatch(srv, /error\.response\.data/, "no unguarded error.response");
  const tw = fs.readFileSync(path.join(repo, "twitchbot", "twitch.js"), "utf8");
  assert.doesNotMatch(tw, /exchangeChannelPoints/);
  assert.doesNotMatch(tw, /type: "twitch-channelpoints"/, "the redemption body is built in channelpoints.js only");
  for (const m of tw.matchAll(/console\.error\(([\s\S]*?)\);/g)) {
    assert.doesNotMatch(m[1], /,\s*(error|err|e|event)\s*$/, "twitch.js logs a raw error object: " + m[1].trim().slice(0, 80));
  }
  const cpSrc = fs.readFileSync(path.join(repo, "twitchbot", "channelpoints.js"), "utf8");
  assert.doesNotMatch(cpSrc, /displayname/, "never matched by display name");
  assert.doesNotMatch(cpSrc, /amount:/, "never sends an amount");
  assert.doesNotMatch(cpSrc, /require\("(axios|tmi\.js|express|body-parser)"\)/, "no npm dependencies (tests load it without the bot)");
});
