#!/usr/bin/env node
// tools/twitch-app-token-check.js - 1.99aow: checks, read-only, that the webhook server's app token mint (twitchbot/apptoken.js)
// works with the environment it is given and that the minted token reads the app's EventSub subscriptions - without running a
// webhook server. (Starting server.js replaces the live subscription: it deletes every one at start and creates one for the
// production callback. So it never runs anywhere but production, and this tool is how the mint is checked elsewhere.)
//
//   node --env-file=<env file> tools/twitch-app-token-check.js        (no arguments; nothing secret on the command line)
//
// It reads TWITCH_CLIENT_ID2 / TWITCH_SECRET_KEY2 from the environment only (no .env file of its own, and never
// TWITCH_ACCESS_TOKEN: the start-up fallback can't stand in for a mint here), then
//   1. mints one app token through apptoken.js;
//   2. makes ONE read-only Helix call, GET /helix/eventsub/subscriptions - it never deletes or creates a subscription;
//   3. revokes the token it minted (POST https://id.twitch.tv/oauth2/revoke, client_id + token), so it leaves nothing behind;
// and prints only these lines:
//   mint: ok (lifetime 58 days)                              mint: failed (HTTP 403)
//   helix list: HTTP 200, 1 subscription(s): enabled 1       helix list: HTTP 401 {"error":"Unauthorized",...}  (Twitch's answer)
//                                                            helix list: failed (ETIMEDOUT)                    (no answer)
//   revoke: ok                                               revoke: failed (HTTP 400)
// - never a token, the secret or a fingerprint of either. Exit 0 when the mint worked and the list answered 200, else 1 (2: usage).
"use strict";

const { createAppTokenManager, why, span } = require("../twitchbot/apptoken");
const { errInfo } = require("../processguard");

const SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
const REVOKE_URL = "https://id.twitch.tv/oauth2/revoke";
const TIMEOUT_MS = 15000;

/** "enabled 1, webhook_callback_verification_pending 2" from the subscriptions' statuses (Twitch's words, cleaned). */
function statusCounts(list) {
  const counts = new Map();
  for (const sub of list) {
    const s = sub && typeof sub.status === "string" ? sub.status.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60) || "unknown" : "unknown";
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([s, n]) => `${s} ${n}`).join(", ");
}

/** The check, on the http client it is given (axios; a fake in test/twitch-app-token-check.test.js). -> exit code. */
async function run({ http, env = process.env, out = console.log } = {}) {
  const pair = { TWITCH_CLIENT_ID2: env.TWITCH_CLIENT_ID2, TWITCH_SECRET_KEY2: env.TWITCH_SECRET_KEY2 };
  const tokens = createAppTokenManager({ http, env: pair, log() {} });
  let token = "";
  try {
    token = await tokens.getToken();
  } catch (e) {
    tokens.stop();
    out(`mint: failed (${e.reason || why(e)})`);
    return 1;
  }
  tokens.stop();
  out(`mint: ok (lifetime ${span(tokens.info().lifetimeMs)})`);

  let ok = false;
  try {
    const res = await http.request({ method: "get", url: SUBSCRIPTIONS_URL, timeout: TIMEOUT_MS, maxRedirects: 0,
                                     headers: { "Client-ID": pair.TWITCH_CLIENT_ID2, Authorization: `Bearer ${token}` } });
    const body = (res && res.data) || {};
    const list = Array.isArray(body.data) ? body.data : [];
    const more = Number.isInteger(body.total) && body.total > list.length ? ` (${body.total} in all)` : "";
    out(`helix list: HTTP ${res.status}, ${list.length} subscription(s)${list.length ? ": " + statusCounts(list) : ""}${more}`);
    ok = res.status === 200;
  } catch (e) {
    // Twitch's answer (status + body, never the request) when there is one; otherwise only the error's code
    out(`helix list: ${e && e.response ? errInfo(e) : `failed (${why(e)})`}`);
  }

  try {
    await http.post(REVOKE_URL, new URLSearchParams({ client_id: pair.TWITCH_CLIENT_ID2, token }).toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: TIMEOUT_MS, maxRedirects: 0,
    });
    out("revoke: ok");
  } catch (e) {
    out(`revoke: failed (${why(e)})`);
  }
  token = "";
  return ok ? 0 : 1;
}

module.exports = { run, statusCounts, SUBSCRIPTIONS_URL, REVOKE_URL };

if (require.main === module) {
  if (process.argv.length > 2) {
    console.error("usage: node --env-file=<env file> tools/twitch-app-token-check.js   (no arguments: TWITCH_CLIENT_ID2 and " +
                  "TWITCH_SECRET_KEY2 come from the environment)");
    process.exit(2);
  }
  run({ http: require("axios") }).then(
    (code) => { process.exitCode = code; },
    (e) => { console.log(`check failed (${why(e)})`); process.exitCode = 1; },
  );
}
