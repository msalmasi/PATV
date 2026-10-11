// legacybj.js - 1.99mv: the guard on the LEGACY Discord blackjack routes (POST /api/blackjack/wager, /api/blackjack/result),
// used only by the old discord-blackjack bot (blackjack/blackjack.js). Pepe and the site casino (casino/*) never call them.
//
// Why: both routes compared the request's `password` with process.env.BOT_TOKEN, which isn't set on prod or staging -
// so a request with NO password matched (undefined === undefined) and anyone could call them. /result paid any `payout`
// to any userId for any blackjackId (no check that the hand existed, was open or was theirs), out of the House with Fed
// flash cover, and granted XP (level-up rewards) on top.
//
// Now:
//   * OFF by default: both routes answer 410 Gone unless LEGACY_DISCORD_BLACKJACK=1 is in .env (the kill flag).
//   * When on, the caller must send a real token: the site's bot token (TWITCH_BOT_TOKEN) or a NON-EMPTY BOT_TOKEN.
//     An unset token never matches.
//   * A result must settle an OPEN hand of that same user, once, with a payout inside what the bot's game can produce
//     (-3x .. +7x the wager: split + double + insurance outcomes in blackjack/blackjack.js).
"use strict";

const MIN_MULT = -3;
const MAX_MULT = 7;

function enabled(env = process.env) {
  return String(env.LEGACY_DISCORD_BLACKJACK || "").trim() === "1";
}

/** A real, non-empty token that matches the site bot token or a set BOT_TOKEN. */
function authorized(password, isBotToken, env = process.env) {
  if (typeof password !== "string" || password.length === 0) return false;
  if (typeof isBotToken === "function" && isBotToken(password)) return true;
  const t = env.BOT_TOKEN;
  return typeof t === "string" && t.length > 0 && password === t;
}

/**
 * Gate a legacy route. -> null when the request may go on, else {status, body} to answer with.
 */
function gate(body, isBotToken, env = process.env) {
  if (!enabled(env)) {
    return { status: 410, body: { success: false, message: "Discord blackjack has been retired - play blackjack on publicaccess.tv/casino." } };
  }
  if (!authorized((body || {}).password, isBotToken, env)) return { status: 403, body: "Access denied" };
  return null;
}

/**
 * Check a result against its hand row (SELECT userId, wager, payoutTransactionId FROM blackjack WHERE blackjackId = ?).
 * -> null when it may be settled, else a short reason.
 */
function checkResult(row, userId, payout) {
  if (!row) return "no_hand";
  if (row.payoutTransactionId) return "settled";
  if (String(row.userId) !== String(userId)) return "wrong_user";
  const p = Number(payout), w = Number(row.wager);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w <= 0) return "bad_payout";
  if (p < MIN_MULT * w || p > MAX_MULT * w) return "bad_payout";
  return null;
}

/**
 * The stakes of the hands still in play, for the House cover check on a new wager. A hand is open until its payout
 * transaction exists: `payout` defaults to 0, so "payout IS NULL" never matched and open hands were never counted
 * (2026-10-11 fix).
 */
const OPEN_STAKES_SQL = "SELECT COALESCE(SUM(wager),0) AS t FROM blackjack WHERE payoutTransactionId IS NULL";
async function openStakes(getQuery) {
  const r = await getQuery(OPEN_STAKES_SQL);
  return Number((r[0] && r[0].t) || 0);
}

module.exports = { enabled, authorized, gate, checkResult, openStakes, OPEN_STAKES_SQL, MIN_MULT, MAX_MULT };
