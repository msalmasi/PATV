// 1.99afh: the Twitch bot's side of channel-point redemptions (twitchbot/channelpoints.js, server.js, twitch.js).
//   * the EventSub signature over the RAW body (constant time), the 10-minute replay window, message / redemption de-dupe
//   * handleRedemption: never sends an amount, sends ref "twitch-cp:<redemption id>" + the Twitch user id, chat lines only for
//     PAT rewards, a 5xx / network failure is logged as status + answer only
//   * errInfo never prints a request's config or headers (the 10-24 log carried the bot token)
//   * source checks: no number parsed from a title, no display-name lookup, no console.error(error) on axios errors
//   (the paid path against the real site routes is in test/twitchcp.test.js)
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
                                reward_id: "rw-1", reward_title: "Buy 5000 PAT", ref: "twitch-cp:red-1" });
  assert.equal("amount" in post.body, false, "the site decides the amount");
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
  assert.deepEqual(await CP.handleRedemption({ reward: {} }, fakeDeps().deps), { outcome: "bad_event" });
  assert.deepEqual(await CP.handleRedemption(null, fakeDeps().deps), { outcome: "bad_event" });
  // a chat client that throws doesn't break it
  const loud = fakeDeps();
  loud.deps.say = () => { throw new Error("not connected"); };
  assert.equal((await CP.handleRedemption(ev(), loud.deps)).outcome, "ok");
});

test("source: server.js verifies the raw body, de-dupes, never parses a title; twitch.js never logs a raw axios error", () => {
  const srv = fs.readFileSync(path.join(repo, "server.js"), "utf8");
  assert.doesNotMatch(srv, /title\.split\(/, "no number from the title");
  assert.match(srv, /bodyParser\.json\(\{ verify: \(req, res, buf\) => \{ req\.rawBody = buf; \} \}\)/);
  assert.match(srv, /CP\.verifySignature\(process\.env\.TWITCH_EVENTSUB_SECRET, headers, raw\)/);
  assert.match(srv, /CP\.fresh\(/);
  assert.match(srv, /recentMessages\.add\(/);
  assert.match(srv, /redeemChannelPoints\(redemption\)/);
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
  assert.doesNotMatch(cpSrc, /require\("(axios|tmi\.js)"\)/, "no npm dependencies (tests load it without the bot)");
});
