// twitchbot/apptoken.js - 1.99aow: the webhook server's (server.js, pm2 'server') Twitch app access token, minted and renewed
// in memory with the client-credentials grant. server.js used to send TWITCH_ACCESS_TOKEN from .env: a token minted by hand,
// which expires after about 60 days, and then the EventSub subscription setup at start fails until someone mints another.
//
//   createAppTokenManager({http, env, now, later, cancel, log}) -> {getToken, request, info, stop}
//     http    axios (anything with post(url, body, options) and request(config))
//     env     process.env: TWITCH_CLIENT_ID2 + TWITCH_SECRET_KEY2 (the app the EventSub subscription belongs to), read at each
//             mint; TWITCH_ACCESS_TOKEN only as the start-up fallback (below)
//     now / later / cancel / log    Date.now / setTimeout / clearTimeout / console.log (the tests pass fakes)
//
// What it does
//   * mint: POST https://id.twitch.tv/oauth2/token with the form client_id + client_secret + grant_type=client_credentials,
//     15 s timeout, no redirect followed (the form is never sent anywhere else). The token lives in this closure only: never
//     written to a file or to the environment, never logged, not even a fingerprint. Concurrent callers share one mint.
//   * renewal: at 80 % of the answer's expires_in (a 60-day token renews after 48), by a timer - unref'd, so it never keeps the
//     process alive; its delay is capped at 2^31-1 ms (Node's largest; a longer one would fire at once) and re-armed until the
//     time comes - or by the next getToken() after that time. A failed renewal is retried every minute; the token it still has
//     is used while it is valid, an expired one is refused (getToken rejects).
//   * request(config): a Helix call with Client-ID + "Authorization: Bearer <token>" (15 s timeout, no redirect followed). A 401
//     mints once and retries once; a second 401 goes back to the caller (so does the first one when that mint fails).
//   * the fallback: only when the FIRST mint fails (the pair unset, Twitch unreachable) and TWITCH_ACCESS_TOKEN is set, that
//     token is used until a mint works. After a successful mint it is never used again.
//   * the log lines name no value, only an HTTP status or an error code:
//       [twitch-app] app token ready (renews in about N days)
//       [twitch-app] renewal failed (<why>); retrying in a minute           the first failure, then once an hour while it lasts
//       [twitch-app] startup mint failed (<why>); using TWITCH_ACCESS_TOKEN until a mint works
//       [twitch-app] startup mint failed (<why>) and there is no TWITCH_ACCESS_TOKEN; retrying in a minute
// tools/twitch-app-token-check.js mints once through this, lists the subscriptions read-only and revokes what it minted.
"use strict";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const MAX_TIMER_MS = 2147483647;   // setTimeout's largest delay
const RETRY_MS = 60 * 1000;        // a failed mint is retried a minute later
const RENEW_AT = 0.8;              // of the token's lifetime
const TIMEOUT_MS = 15000;
const LOG_EVERY = 60;              // renewals failing in a row: the first is logged, then every 60th (once an hour)

/** What a log line may say about a failure: the HTTP status, or an error code - never a message, a body or the request. */
function why(e) {
  if (e && typeof e === "object" && e.response && typeof e.response === "object") {
    const s = e.response.status;
    return "HTTP " + (Number.isInteger(s) ? s : "?");
  }
  const code = e && typeof e === "object" && typeof e.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : "";
  return code || "error";
}

/** A duration for a log line: "48 days", "5 hours", "1 minute". */
function span(ms) {
  const DAY = 86400000, HOUR = 3600000, MINUTE = 60000;
  if (ms >= 2 * DAY) return Math.round(ms / DAY) + " days";
  if (ms >= 2 * HOUR) return Math.round(ms / HOUR) + " hours";
  const m = Math.max(1, Math.round(ms / MINUTE));
  return m + (m === 1 ? " minute" : " minutes");
}

function failure(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function createAppTokenManager({ http, env = process.env, now = Date.now, later = setTimeout, cancel = clearTimeout,
                                 log = console.log } = {}) {
  let token = "", expires = 0, renewAt = 0, lifetime = 0, minted = false, fallback = false;
  let tried = false;                 // a mint was attempted: the fallback is for the first attempt only
  let pending = null, timer = null, stopped = false, failures = 0, retryAt = 0;

  function schedule(delay) {
    if (timer) { cancel(timer); timer = null; }
    if (stopped) return;
    timer = later(tick, Math.min(MAX_TIMER_MS, Math.max(1000, delay)));
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function tick() {
    timer = null;
    // not time yet - a capped delay ran out early, or the timer fired a little before the time it was set for (Node's timer
    // clock and Date.now() can differ by a millisecond or so): re-armed against the later of the renewal time and a failed
    // renewal's retry time, so getToken()'s "still inside the retry minute" answer never leaves no timer armed
    const due = Math.max(renewAt, retryAt);
    if (token && now() < due) { schedule(due - now()); return; }
    getToken().catch(() => {});                                            // logged and re-armed by mint() / getToken()
  }

  async function mintOnce() {
    const first = !tried;
    tried = true;
    try {
      const id = env.TWITCH_CLIENT_ID2, secret = env.TWITCH_SECRET_KEY2;
      if (!id || !secret) throw failure("NO_APP_CREDENTIALS", "TWITCH_CLIENT_ID2 / TWITCH_SECRET_KEY2 not set");
      const form = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: "client_credentials" }).toString();
      const res = await http.post(TOKEN_URL, form, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: TIMEOUT_MS, maxRedirects: 0,
      });
      const data = (res && res.data) || {};
      const ms = Number(data.expires_in) * 1000;
      if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(ms) || ms <= 0) {
        throw failure("BAD_TOKEN_ANSWER", "Twitch's token answer had no token or no lifetime");
      }
      const t = now();
      token = data.access_token;
      lifetime = ms;
      expires = t + ms;
      renewAt = t + ms * RENEW_AT;
      minted = true;
      fallback = false;
      failures = 0;
      retryAt = 0;
      log(`[twitch-app] app token ready (renews in about ${span(renewAt - t)})`);
      schedule(renewAt - t);
      return token;
    } catch (e) {
      const reason = why(e);
      if (first && env.TWITCH_ACCESS_TOKEN) {
        token = env.TWITCH_ACCESS_TOKEN;
        fallback = true;
        expires = Infinity;
        renewAt = now() + RETRY_MS;
        log(`[twitch-app] startup mint failed (${reason}); using TWITCH_ACCESS_TOKEN until a mint works`);
        schedule(RETRY_MS);
        return token;
      }
      failures += 1;
      if (failures === 1 || failures % LOG_EVERY === 0) {
        log(first
          ? `[twitch-app] startup mint failed (${reason}) and there is no TWITCH_ACCESS_TOKEN; retrying in a minute`
          : `[twitch-app] renewal failed (${reason}${failures > 1 ? `, ${failures} times in a row` : ""}); retrying in a minute`);
      }
      const err = failure("APP_TOKEN_MINT_FAILED", `Twitch app token renewal failed (${reason})`);
      err.reason = reason;
      throw err;
    }
  }

  /** One mint at a time: a caller arriving while one runs gets its answer. */
  function mint() {
    if (!pending) {
      pending = mintOnce();
      pending.then(() => { pending = null; }, () => { pending = null; });
    }
    return pending;
  }

  /** The token to use now: minted (or renewed) when there is none or its renewal time has come. */
  async function getToken() {
    const t = now();
    // good, or still good with its renewal failed under a minute ago (retried once a minute, not on every call)
    if (token && (t < renewAt || (t < retryAt && t < expires))) return token;
    try {
      return await mint();
    } catch (e) {
      retryAt = now() + RETRY_MS;
      schedule(RETRY_MS);
      if (token && now() < expires) return token;   // a failed renewal: the token it has is still good
      throw e;
    }
  }

  /** A Helix request with the app token; one mint + one retry after a 401. */
  async function request(config) {
    const used = await getToken();
    const send = (value) => http.request(Object.assign({}, config, {
      timeout: TIMEOUT_MS,
      maxRedirects: 0,
      headers: Object.assign({}, config && config.headers, { "Client-ID": env.TWITCH_CLIENT_ID2, Authorization: `Bearer ${value}` }),
    }));
    try {
      return await send(used);
    } catch (e) {
      if (!e || !e.response || e.response.status !== 401) throw e;
      let fresh;
      try { fresh = token === used ? await mint() : token; }   // concurrent 401s for one old token share one mint
      catch (_) { throw e; }                                   // that mint failed (logged): the caller gets its 401
      return send(fresh);                                      // one retry; a second 401 goes back to the caller
    }
  }

  /** What may be shown about the token: where it came from and when it expires / renews - never the token. */
  function info() {
    return { minted, fallback, lifetimeMs: lifetime, expiresAt: expires, renewAt };
  }

  function stop() {
    stopped = true;
    if (timer) { cancel(timer); timer = null; }
  }

  return { getToken, request, info, stop };
}

module.exports = { createAppTokenManager, why, span, TOKEN_URL };
