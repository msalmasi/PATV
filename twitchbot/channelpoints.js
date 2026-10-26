// channelpoints.js — 1.99afh: Twitch channel-point redemptions -> PAT (server.js -> twitch.js redeemChannelPoints -> here).
//
// Why (owner, 2026-10-26): server.js used to take the PAT amount from the reward's TITLE (`title.split(" ")[1]`), find the
// account by Twitch DISPLAY NAME, send no ref (a repeated EventSub delivery paid twice) and log the whole AxiosError - its
// config carried the bot token into server-error.log. Now:
//   * the SITE decides what a redemption pays (twitchcp.js allowlist + cap, botcredits.js): this sends the reward's id and
//     title, never an amount, with ref "twitch-cp:" + the redemption id (the site pays a ref once);
//   * the account is the one linked to the redeemer's Twitch USER ID (GET /api/users/twitch/:id, bot-only), never a name;
//   * chat: a paid redemption is announced; a refused one is explained, but only for a reward that is about PAT (its title
//     says PAT, or the site's allowlist knows it) - the streamer's other rewards ("Pet dog", ...) get no PAT and no line;
//   * logs carry the status and the site's / Twitch's answer only (errInfo) - never a request's config or headers.
// Twitch can only refund (CANCEL) or FULFILL a redemption through Helix with the BROADCASTER's user token
// (channel:manage:redemptions) and only for rewards created by the same app; server.js has neither, so redemptions stay in
// the streamer's reward queue and the chat line says the streamer can refund them.
//
// No npm dependencies: the callers hand in their axios (patvAuth installed) and the chat client.
"use strict";
const crypto = require("crypto");

const TYPE = "twitch-channelpoints";
const REF_PREFIX = "twitch-cp:";
const MAX_AGE_MS = 10 * 60 * 1000;          // Twitch: drop a notification older than 10 minutes (replay)

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
    case "error": return `${who}, something went wrong adding your PAT. The streamer will check it.`;
    case "duplicate": return null;
    default: return `${who}, PAT channel-point rewards are paused right now, ${later}`;   // over_cap, no_route, ...
  }
}

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
      warn(`[channelpoints] account lookup for reward "${clean(title, 45)}" failed: ${errInfo(e)}`);
      if (aboutPat) say("error");
      return { outcome: "error" };
    }
  }
  if (!user || !user.userId) {
    log(`[channelpoints] "${clean(title, 45)}" (reward ${rewardId || "-"}): no PATV account for this Twitch user`);
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
      ref: REF_PREFIX + ev.id,
    });
    data = r && r.data && typeof r.data === "object" ? r.data : {};
  } catch (e) {
    const st = e && e.response ? e.response.status : 0;
    const body = e && e.response && e.response.data && typeof e.response.data === "object" ? e.response.data : null;
    if (st >= 400 && st < 500 && body && typeof body.error === "string") {
      const outcome = body.error;
      log(`[channelpoints] "${clean(title, 45)}" (reward ${rewardId || "-"}) refused: ${outcome}`);
      // a reward the site doesn't list is only explained when it's about PAT; every other refusal means it IS a PAT reward
      if (outcome !== "not_allowlisted" || aboutPat) say(outcome);
      return { outcome };
    }
    warn(`[channelpoints] crediting "${clean(title, 45)}" (reward ${rewardId || "-"}) failed: ${errInfo(e)}`);
    if (aboutPat) say("error");
    return { outcome: "error" };
  }
  const amount = Number(data.amount) || 0;
  if (data.duplicate) { log(`[channelpoints] redemption ${ev.id} was already paid (duplicate)`); return { outcome: "duplicate", amount }; }
  log(`[channelpoints] "${clean(title, 45)}" (reward ${rewardId || "-"}) paid PAT ${amount}`);
  say("ok", { amount });
  return { outcome: "ok", amount };
}

module.exports = { TYPE, REF_PREFIX, MAX_AGE_MS, isPatReward, errInfo, Recent, verifySignature, fresh, chatLine, handleRedemption };
