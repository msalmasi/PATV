// oauthlink.js — what happens around a Twitch / Discord sign-in or link (1.99gb), used by index.js.
//
//   twitchHeaders(token)   the Helix headers: Client-ID from TWITCH_CLIENT_ID (was hard-coded)
//   TWITCH_SCOPE           user:read:email only (user:read:subscriptions was asked for and never used)
//   safeBadge(userId, id)  awardBadge that never throws (a badge problem must never block a sign-in / link)
//   linkRewards(...)       the "twitch-user" / "discord-user" badge + the one-time connect bonus, AFTER the id
//                          is saved, never throwing
//   captureEmail(...)      the provider's VERIFIED email onto an account that has none / a placeholder / an
//                          unverified one (never over a verified one, never one another account uses)
//   emailNotice(...)       tells the member (flash + inbox): "We added your Discord email for account recovery"
//
// The connect bonus and the legacy flag: users.twitchBonus / discordBonus = 1 used to mean "badge + bonus
// done", but ~128 accounts (mostly Pepe's CF... auto-accounts, merged / created before 1.99bg) carry the
// flag without ever having had that provider linked here - so a real link later paid nothing. The flag is
// no longer trusted on its own: the bonus is paid when the flag is 0 OR the account has no "<provider>
// connect" payout on record (bonus_winners); welcome.connectBonus still pays once per Twitch / Discord id
// ever. The badge is awarded on every link (awardBadge is idempotent: XP only the first time). The flag
// itself is left as it is (no bulk reset: for most of those rows it records a bonus that WAS paid).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const TWITCH_SCOPE = "user:read:email";
const LABEL = { twitch: "Twitch", discord: "Discord" };
const BADGE = { twitch: "twitch-user", discord: "discord-user" };
const FLAG = { twitch: "twitchBonus", discord: "discordBonus" };

function twitchHeaders(accessToken) {
  return { Authorization: `Bearer ${accessToken}`, "Client-ID": process.env.TWITCH_CLIENT_ID };
}

const uc = () => require("./user.controller");

/** awardBadge without the throw. -> the result, or null on an error (logged). */
async function safeBadge(userId, badgeId, award = (u, b) => uc().awardBadge(u, b)) {
  try { return await award(userId, badgeId); }
  catch (e) { console.error(`[auth] badge ${badgeId} for ${userId}: ${e.message}`); return null; }
}

/**
 * After `provider` id `providerId` was saved on `userId`: the badge, and the connect bonus when this account
 * hasn't had one for this provider. priorFlag = users.<provider>Bonus as it was BEFORE this link set it.
 * created: this sign-in made the account (its welcome bonus vests instead - no connect bonus).
 * Never throws. -> {badge, bonus}
 */
async function linkRewards({ userId, provider, providerId, priorFlag, created = false, award, connect } = {}) {
  const out = { badge: null, bonus: "none" };
  if (!userId || !BADGE[provider]) return out;
  out.badge = await safeBadge(userId, BADGE[provider], award);
  if (created) return out;
  try {
    const paid = (await getQuery("SELECT 1 FROM bonus_winners WHERE userId = ? AND type = ? LIMIT 1", [userId, `${provider} connect`]).catch(() => [])).length > 0;
    if (Number(priorFlag) === 0 || !paid) {
      const welcome = require("./welcome");
      out.bonus = await (connect || welcome.connectBonus)(userId, provider, providerId, uc().awardBonus);
    }
  } catch (e) { console.error(`[auth] ${provider} connect bonus for ${userId}: ${e.message}`); out.bonus = "error"; }
  return out;
}

const realEmail = (e) => {
  const s = String(e == null ? "" : e).trim();
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
};

/**
 * The provider's verified email onto `userId` when its own is missing, a placeholder (no "@" - the bots
 * made those) or unverified, and no OTHER account uses that address (any letter case). Sets
 * isEmailVerified = 1 (the provider verified it) and drops a pending verification token. Never overwrites a
 * verified email. Never throws; never logs the address. -> true when it was set.
 */
async function captureEmail({ userId, provider, email, verified }) {
  const e = realEmail(email);
  if (!userId || !e || !verified) return false;
  try {
    const me = (await getQuery("SELECT email, isEmailVerified FROM users WHERE userId = ?", [userId]))[0];
    if (!me) return false;
    if (Number(me.isEmailVerified) === 1 && realEmail(me.email)) return false;          // a verified email stays
    if (realEmail(me.email) && me.email.trim().toLowerCase() === e.toLowerCase() && Number(me.isEmailVerified) !== 1) {
      // the same address, now verified by the provider
    } else {
      const other = await getQuery("SELECT 1 FROM users WHERE LOWER(email) = LOWER(?) AND userId != ? LIMIT 1", [e, userId]);
      if (other.length) { console.log(`[auth] ${provider} email not added to ${userId}: another account uses it`); return false; }
    }
    // conditional on the row still having no verified email (a racing verification wins)
    const r = await runQuery(`UPDATE users SET email = ?, isEmailVerified = 1, emailVerificationToken = NULL, tokenExpires = NULL
                              WHERE userId = ? AND NOT (COALESCE(isEmailVerified, 0) = 1 AND email IS NOT NULL AND instr(email, '@') > 0)`, [e, userId]);
    if (!r || r.changes !== 1) return false;
    console.log(`[auth] ${provider} verified email added to ${userId} (account recovery)`);
    return true;
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) { console.log(`[auth] ${provider} email not added to ${userId}: another account uses it`); return false; }
    console.error(`[auth] ${provider} email capture for ${userId}: ${err.message}`);
    return false;
  }
}

const noticeText = (provider) => `We added your ${LABEL[provider] || provider} email for account recovery — change it in settings.`;

/** Tell the member their email was added: a flash (shown on the next page that shows them) and an inbox
 *  notice linking to the settings. Never throws. */
async function emailNotice(req, { userId, username, provider }) {
  try { if (req && typeof req.flash === "function") req.flash("success", noticeText(provider)); } catch (e) { /* no session */ }
  try {
    await require("./inbox").addSafe(userId, { kind: "system", title: "Email added for account recovery", body: noticeText(provider),
      link: username ? `/u/${encodeURIComponent(username)}/edit` : "/", ref: `email-capture:${provider}` });
  } catch (e) { console.error("[auth] email notice:", e.message); }
}

/** captureEmail + emailNotice. -> true when the email was added. */
async function captureAndNotify(req, { userId, username, provider, email, verified }) {
  const ok = await captureEmail({ userId, provider, email, verified });
  if (ok) await emailNotice(req, { userId, username, provider });
  return ok;
}

module.exports = { TWITCH_SCOPE, twitchHeaders, safeBadge, linkRewards, captureEmail, emailNotice, captureAndNotify, noticeText, FLAG, BADGE };
