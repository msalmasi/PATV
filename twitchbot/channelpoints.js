// channelpoints.js — 1.99afh: Twitch channel-point redemptions -> PAT (server.js -> twitch.js redeemChannelPoints -> here).
//
// Why (owner, 2026-10-26): server.js used to take the PAT amount from the reward's TITLE (`title.split(" ")[1]`), find the
// account by Twitch DISPLAY NAME, send no ref (a repeated EventSub delivery paid twice) and log the whole AxiosError - its
// config carried the bot token into server-error.log. Now:
//   * the SITE decides what a redemption pays (twitchcp.js allowlist + cap + minimum cost + daily limit, botcredits.js): this
//     sends the reward's id, title and channel-point cost, never an amount, with ref "twitch-cp:" + the redemption id (the
//     site pays a ref once);
//   * the account is the one linked to the redeemer's Twitch USER ID (GET /api/users/twitch/:id, bot-only), never a name;
//   * chat: a paid redemption is announced; a refused one is explained, but only for a reward that is about PAT (its title
//     says PAT, or the site's allowlist knows it) - the streamer's other rewards ("Pet dog", ...) get no PAT and no line;
//   * logs carry the status and the site's / Twitch's answer only (errInfo) - never a request's config or headers - and name
//     the redemption id + the viewer's Twitch login, so a redemption lost to a site error can be credited / refunded by hand.
// Twitch can only refund (CANCEL) or FULFILL a redemption through Helix with the BROADCASTER's user token
// (channel:manage:redemptions) and only for rewards created by the same app; server.js has neither, so redemptions stay in
// the streamer's reward queue and the chat line says the streamer can refund them.
//
// 1.99afh review:
//   * webhookApp / webhookRoute: the EventSub endpoint itself (POST /webhooks/callback) lives here so tests drive the very
//     app server.js serves - raw body kept for the signature, 403 on a bad one, the challenge as text/plain, 200 before the
//     replay / de-dupe / subscription-type / broadcaster checks.
//   * guardProcess: server.js (pm2 'server': the webhook + the tmi chat bot + raffles) logs an unhandled rejection as
//     errInfo and keeps running. Node 22 otherwise exits and prints the whole AxiosError (config.headers: X-Bot-Token,
//     X-PATV-Key) - and a crash inside the prod updater's stability check rolls the deploy back.
//
// No npm dependencies: the callers hand in their axios (patvAuth installed), express / body-parser and the chat client.
"use strict";
const crypto = require("crypto");

const TYPE = "twitch-channelpoints";
const REF_PREFIX = "twitch-cp:";
const MAX_AGE_MS = 10 * 60 * 1000;          // Twitch: drop a notification older than 10 minutes (replay)
const REDEMPTION_ADD = "channel.channel_points_custom_reward_redemption.add";
const WEBHOOK_PATH = "/webhooks/callback";

/** A reward that is about PAT: its title has "PAT" as a word (case-sensitive - "Pat the dog" isn't one). */
const isPatReward = (title) => /(^|[^A-Za-z0-9_])PAT([^A-Za-z0-9_]|$)/.test(String(title || ""));

/** What may be logged about a failed request: the status and the answer's body - never config / headers / the request. */
function errInfo(e) {
  if (!e || typeof e !== "object") return String(e);
  const r = e.response;
  if (r && typeof r === "object") {
    let data = r.data;
    try { data = typeof data === "string" ? data : JSON.stringify(data); } catch (x) { data = "[unreadable]"; }
    return `HTTP ${r.status}${data ? " " + String(data).slice(0, 300) : ""}`;
  }
  return [e.code, e.message].filter(Boolean).join(" ").slice(0, 300) || "error";
}

/** Where an error happened: its stack's "at ..." frames only (never the first line's message, never the object). */
function frames(e, n = 6) {
  const s = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
  return s.split("\n").filter((l) => /^\s+at /.test(l)).slice(0, n).map((l) => l.trim()).join(" | ");
}

/**
 * The process-wide last resort for server.js. An unhandled rejection (a !spin / raffle / chat line while the site or Twitch is
 * down, tmi's say() while it reconnects) is logged as errInfo + frames and the process keeps running; an uncaught exception
 * is logged the same way and the process exits 1 as Node would (pm2 restarts it) - without printing the error object.
 * opts: {warn, exit} (tests). Installed once per process.
 */
function guardProcess(proc, opts = {}) {
  if (!proc || proc.__patvGuarded) return proc;
  proc.__patvGuarded = true;
  const warn = opts.warn || console.error;
  const exit = opts.exit || ((code) => proc.exit(code));
  proc.on("unhandledRejection", (reason) => {
    try { warn(`[server] unhandled rejection (kept running): ${errInfo(reason)}${frames(reason) ? " @ " + frames(reason) : ""}`); } catch (x) { /* never throw from here */ }
  });
  proc.on("uncaughtException", (err) => {
    try { warn(`[server] uncaught exception - exiting: ${errInfo(err)}${frames(err) ? " @ " + frames(err) : ""}`); } catch (x) { /* never throw from here */ }
    exit(1);
  });
  return proc;
}

/** A small "seen recently" set (EventSub message ids, redemption ids). add() -> false when it was already there. */
class Recent {
  constructor(max = 2000) { this.max = max; this.map = new Map(); }
  add(key) {
    const k = String(key);
    if (this.map.has(k)) return false;
    this.map.set(k, Date.now());
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return true;
  }
  has(key) { return this.map.has(String(key)); }
}

/**
 * Is this POST really from Twitch? HMAC-SHA256 over message id + timestamp + the RAW body, compared in constant time.
 * headers: the request's (lower-case names, as Node gives them).
 */
function verifySignature(secret, headers, rawBody) {
  if (!secret || !headers) return false;
  const id = headers["twitch-eventsub-message-id"], ts = headers["twitch-eventsub-message-timestamp"];
  const sig = headers["twitch-eventsub-message-signature"];
  if (typeof id !== "string" || typeof ts !== "string" || typeof sig !== "string") return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? "" : rawBody), "utf8");
  const want = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(Buffer.concat([Buffer.from(id + ts, "utf8"), body])).digest("hex"), "utf8");
  const got = Buffer.from(sig, "utf8");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Is the notification's timestamp within 10 minutes of now (either way)? */
function fresh(timestamp, now = Date.now()) {
  const t = Date.parse(String(timestamp || ""));
  return Number.isFinite(t) && Math.abs(now - t) <= MAX_AGE_MS;
}

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const pat = (n) => (Number(n) || 0).toLocaleString("en-US");

/** The chat line for an outcome, or null for none. */
function chatLine(outcome, { name, title, amount }) {
  const who = "@" + clean(name, 40);
  const later = "so nothing was added. The streamer can refund your channel points.";
  switch (outcome) {
    case "ok": return `${who} exchanged channel points for PAT ${pat(amount)}!`;
    case "not_allowlisted": return `${who}, "${clean(title, 45)}" doesn't pay PAT, ${later}`;
    case "no_user": return `${who}, no PATV account is linked to your Twitch yet, ${later}`;
    case "unfunded": return `${who}, this week's PAT reward budget is used up, ${later}`;
    case "under_cost": return `${who}, "${clean(title, 45)}" costs fewer channel points than its PAT needs, ${later}`;
    case "over_daily": return `${who}, you've reached today's PAT limit for channel points, ${later}`;
    case "error": return `${who}, something went wrong adding your PAT. The streamer will check it.`;
    case "duplicate": return null;
    default: return `${who}, PAT channel-point rewards are paused right now, ${later}`;   // over_cap, no_route, ...
  }
}

/** A reward's channel-point cost as Twitch sent it: a whole number >= 0, else null (the site then refuses a costed row). */
const costOf = (v) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

/**
 * Handle one channel.channel_points_custom_reward_redemption.add event.
 * deps: {http (axios with patvAuth), base (BACKEND_BASE_URL), token (TWITCH_BOT_TOKEN), say(text), log, warn, recent (Recent)}
 * -> {outcome, amount?}. Never throws.
 */
async function handleRedemption(event, deps) {
  const ev = event && typeof event === "object" ? event : {};
  const reward = ev.reward && typeof ev.reward === "object" ? ev.reward : {};
  const title = typeof reward.title === "string" ? reward.title : "";
  const rewardId = typeof reward.id === "string" ? reward.id : null;
  const name = ev.user_name || ev.user_login || "";
  const log = deps.log || console.log, warn = deps.warn || console.error;
  // every line names the redemption and the viewer's Twitch login: a redemption lost to a site error is never retried
  // (server.js answered Twitch already), so this is what the streamer refunds / credits by hand
  const what = `redemption ${clean(ev.id, 64) || "-"} by ${clean(ev.user_login || ev.user_name, 40) || "-"}: "${clean(title, 45)}" (reward ${clean(rewardId, 64) || "-"})`;
  const say = (outcome, extra) => {
    const line = chatLine(outcome, Object.assign({ name, title }, extra || {}));
    if (!line || !deps.say) return;
    try { const p = deps.say(line); if (p && typeof p.catch === "function") p.catch((e) => warn("[channelpoints] chat:", errInfo(e))); }
    catch (e) { warn("[channelpoints] chat:", errInfo(e)); }
  };
  if (!ev.id || !ev.user_id) { warn("[channelpoints] a redemption without an id or a user id - ignored"); return { outcome: "bad_event" }; }
  if (deps.recent && !deps.recent.add("redemption:" + ev.id)) return { outcome: "duplicate" };
  const aboutPat = isPatReward(title);

  // 1) the PATV account linked to this Twitch user id (the lookup also brings an archived account back, as for !spin)
  let user = null;
  try {
    const r = await deps.http.get(`${deps.base}/api/users/twitch/${encodeURIComponent(String(ev.user_id))}`);
    user = r && r.data && r.data.user ? r.data.user : null;
  } catch (e) {
    if (!(e && e.response && e.response.status === 404)) {
      warn(`[channelpoints] ${what}: the account lookup failed (not paid - credit or refund by hand): ${errInfo(e)}`);
      if (aboutPat) say("error");
      return { outcome: "error" };
    }
  }
  if (!user || !user.userId) {
    log(`[channelpoints] ${what}: no PATV account for this Twitch user`);
    if (aboutPat) say("no_user");
    return { outcome: "no_user" };
  }

  // 2) the site decides what it pays (twitchcp.js) - this never sends an amount
  let data = null;
  try {
    const r = await deps.http.post(`${deps.base}/api/bonus/chatwinner`, {
      password: deps.token,
      userId: user.userId,
      twitch_user_id: String(ev.user_id),
      type: TYPE,
      reward_id: rewardId,
      reward_title: title,
      reward_cost: costOf(reward.cost),
      ref: REF_PREFIX + ev.id,
    });
    data = r && r.data && typeof r.data === "object" ? r.data : {};
  } catch (e) {
    const st = e && e.response ? e.response.status : 0;
    const body = e && e.response && e.response.data && typeof e.response.data === "object" ? e.response.data : null;
    if (st >= 400 && st < 500 && body && typeof body.error === "string") {
      const outcome = body.error;
      log(`[channelpoints] ${what} refused: ${outcome}`);
      // a reward the site doesn't list is only explained when it's about PAT; every other refusal means it IS a PAT reward
      if (outcome !== "not_allowlisted" || aboutPat) say(outcome);
      return { outcome };
    }
    warn(`[channelpoints] ${what}: crediting failed (not paid - credit or refund by hand): ${errInfo(e)}`);
    if (aboutPat) say("error");
    return { outcome: "error" };
  }
  const amount = Number(data.amount) || 0;
  if (data.duplicate) { log(`[channelpoints] ${what} was already paid (duplicate)`); return { outcome: "duplicate", amount }; }
  log(`[channelpoints] ${what} paid PAT ${amount}`);
  say("ok", { amount });
  return { outcome: "ok", amount };
}

// ── the EventSub webhook (server.js) ──

/** body-parser's verify hook: keep the exact bytes Twitch signed (a re-serialised JSON.stringify(req.body) can differ). */
function rawBodyVerify(req, res, buf) { req.rawBody = buf; }

/**
 * POST /webhooks/callback. deps: {secret (string | () => string), broadcasterId?, onRedemption(event) -> Promise,
 * recent? (Recent of message ids), log?, warn?, now? () => ms}.
 *   bad / missing signature over the raw body -> 403; webhook_callback_verification -> the challenge as text/plain;
 *   revocation / anything else -> 200; a notification -> 200 at once (Twitch re-sends what isn't answered within a few
 *   seconds), then dropped when older than 10 minutes, already seen (message id), not a redemption subscription or not
 *   TWITCH_BROADCASTER_ID's channel; else onRedemption(event), whose failure is logged as errInfo.
 */
function webhookRoute(deps) {
  const log = deps.log || console.log, warn = deps.warn || console.error;
  const recent = deps.recent || new Recent(2000);
  const secret = () => (typeof deps.secret === "function" ? deps.secret() : deps.secret);
  return function eventsubCallback(req, res) {
    const headers = req.headers || {};
    if (!Buffer.isBuffer(req.rawBody) || !verifySignature(secret(), headers, req.rawBody)) {
      warn("Could not verify message signature");
      return res.status(403).send("Forbidden");
    }
    const n = req.body && typeof req.body === "object" ? req.body : {};
    const type = headers["twitch-eventsub-message-type"];
    if (type === "webhook_callback_verification") {
      // the raw challenge string only
      return res.status(200).type("text/plain").send(String(n.challenge || ""));
    }
    if (type === "revocation") {
      log(`Subscription revoked: ${clean(n.subscription && n.subscription.type, 80)} ${clean(n.subscription && n.subscription.status, 40)}`);
      return res.status(200).end();
    }
    if (type !== "notification") return res.status(200).end();
    res.status(200).end();
    const mid = headers["twitch-eventsub-message-id"];
    if (!fresh(headers["twitch-eventsub-message-timestamp"], deps.now ? deps.now() : Date.now())) {
      warn(`EventSub message ${clean(mid, 64)} is older than 10 minutes - ignored`);
      return;
    }
    if (!recent.add(mid)) { log(`EventSub message ${clean(mid, 64)} was delivered again - ignored`); return; }
    if (!n.subscription || n.subscription.type !== REDEMPTION_ADD) return;
    const ev = n.event;
    if (!ev || typeof ev !== "object" || !ev.reward || typeof ev.reward !== "object") return;
    if (deps.broadcasterId && String(ev.broadcaster_user_id) !== String(deps.broadcasterId)) {
      log(`Channel Point Redemption for another channel (${clean(ev.broadcaster_user_id, 20)}) - ignored`);
      return;
    }
    // the reward id + cost are logged so an admin can pin the reward (and its minimum cost) on /admin/economy#twitchcp
    log(`Channel Point Redemption ${clean(ev.id, 64)} by ${clean(ev.user_name, 40)} (${clean(ev.user_login, 40)}, ${clean(ev.user_id, 20)}): ` +
        `${clean(ev.reward.title, 45)} (reward ${clean(ev.reward.id, 64)}, cost ${costOf(ev.reward.cost) === null ? "-" : ev.reward.cost})`);
    Promise.resolve().then(() => deps.onRedemption(ev)).catch((e) => warn("Channel point redemption failed:", errInfo(e)));
  };
}

/** The webhook's express app (server.js listens on it): JSON with the raw body kept, POST /webhooks/callback. */
function webhookApp(deps) {
  const app = deps.express();
  app.use(deps.bodyParser.json({ verify: rawBodyVerify }));
  app.post(WEBHOOK_PATH, webhookRoute(deps));
  return app;
}

module.exports = { TYPE, REF_PREFIX, MAX_AGE_MS, REDEMPTION_ADD, WEBHOOK_PATH, isPatReward, errInfo, frames, guardProcess, Recent,
                   verifySignature, fresh, chatLine, costOf, handleRedemption, rawBodyVerify, webhookRoute, webhookApp };
