// gifts.js — 1.99ma: the rules every 🎁 gift path shares (and the comps' recipient lookup + "You've been gifted" notice).
//
// GIFT PATHS (each one charges the GIVER the normal price and routes it exactly as if the recipient had bought it):
//   official store items   1.99lz: "🎁 Send it as a gift" on /shop/item/<id> (shop.purchasePrize giftTo -> giftRecipient ->
//                          buyOfficial gift). The order is the RECIPIENT's (buyer_id; gift_from = the giver, who sees it on
//                          their orders but never what was delivered on it), so roles + Seerr/Discord and Plex invites run
//                          for them. Which items: shopcatalog.js `gift` (not the spin boost - priced per owner - nor retired
//                          request credits; hand-delivered items are delivered by staff to the recipient).
//   🎟️ Season Pass         /premium "Gift one period" (premium.buy {user}) - one period, never a renewal on the giver
//   🧸 sticker packs       /premium (stickers.buy {to})
//   🎨 cosmetics           /cosmetics (an owned item: transfer; a new one: Pepe runs !cosmetic gift as the giver)
// A one-time thing the recipient already has (a role, a sticker pack, lifetime Plex) is refused BEFORE any charge.
//
// RULES (guard, all paths): not yourself; not someone who blocked you (or you blocked - DM blocks, messages.js dm_blocks;
// the message never says who blocked whom); at most GIFT_HOUR gifts an hour / GIFT_DAY a day per giver and PAIR_DAY a day
// to one recipient (counted over shop gifts, Season Pass gifts and sticker gifts). The recipient can't refund a gift; a
// fulfilment that fails follows the normal order rules (the Plex invite queue, staff delivery).
"use strict";
const { getQuery } = require("./dbUtils");

const GIFT_HOUR = 10;
const GIFT_DAY = 30;
const PAIR_DAY = 5;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
let clock = () => Date.now();

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || (status === 429 ? "E_RATE_LIMITED" : status === 404 ? "E_TARGET_NOT_FOUND" : status === 409 ? "E_ALREADY" : status === 403 ? "E_NO_PERMISSION" : "E_BAD_ARGS"); }
}
const safe = async (sql, args) => { try { return await getQuery(sql, args); } catch (e) { return []; } };

function tFor(userId) {
  try { const I = require("./i18n"); return I.tFor(I.getPref(userId) || "en"); } catch (e) {
    let en = {};
    try { en = require("./locales/en.json"); } catch (e2) { en = {}; }
    return (k, v) => String(en[k] || k).replace(/\{!?(\w+)\}/g, (m, x) => (v && v[x] != null ? String(v[x]) : m));
  }
}

/** A username (with or without @ / u/) -> {userId, username} or throws 404. */
async function recipient(name) {
  const s = String(name || "").trim().replace(/^@/, "").replace(/^u\//i, "").slice(0, 64);
  if (!s) throw new Refuse(400, "Who is it for? Pick a member.");
  const u = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", [s]))[0];
  if (!u) throw new Refuse(404, `There's no member called ${s}.`);
  return u;
}

/** Gifts this giver sent since `since` (all gift paths), and to one recipient. */
async function sentSince(giverId, since, toId) {
  const one = async (sql, args) => Number(((await safe(sql, args))[0] || {}).n) || 0;
  const pair = toId ? " AND buyer_id = ?" : "";
  let n = await one(`SELECT COUNT(*) AS n FROM shop_orders WHERE gift_from = ? AND created >= ?${pair}`, toId ? [giverId, since, toId] : [giverId, since]);
  n += await one(`SELECT COUNT(*) AS n FROM premium_ledger WHERE kind = 'gift' AND payer_id = ? AND created >= ?${toId ? " AND target = ?" : ""}`, toId ? [giverId, since, toId] : [giverId, since]);
  n += await one(`SELECT COUNT(*) AS n FROM user_sticker_packs WHERE source = 'gift' AND payer_id = ? AND created >= ?${toId ? " AND user_id = ?" : ""}`, toId ? [giverId, since, toId] : [giverId, since]);
  return n;
}

/** Throws a Refuse when this gift isn't allowed (yourself, a block, the rate limits). Call it BEFORE charging. */
async function guard(giver, to) {
  if (!giver || !giver.userId) throw new Refuse(401, "Sign in first.", "E_NO_PERMISSION");
  if (!to || !to.userId) throw new Refuse(404, "There's no such member.");
  if (to.userId === giver.userId) throw new Refuse(400, "That's you - buy it for yourself instead.");
  const b = await safe("SELECT 1 FROM dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
                       [to.userId, giver.userId, giver.userId, to.userId]);
  if (b.length) throw new Refuse(403, `You can't send gifts to ${to.username || "that member"}.`);
  const t = clock();
  if (await sentSince(giver.userId, t - HOUR) >= GIFT_HOUR) throw new Refuse(429, `That's ${GIFT_HOUR} gifts this hour - give it a little while.`);
  if (await sentSince(giver.userId, t - DAY) >= GIFT_DAY) throw new Refuse(429, `That's ${GIFT_DAY} gifts today - more tomorrow.`);
  if (await sentSince(giver.userId, t - DAY, to.userId) >= PAIR_DAY) throw new Refuse(429, `That's ${PAIR_DAY} gifts to ${to.username} today - more tomorrow.`);
  return true;
}

/**
 * A gift/comp of an official item the recipient can't take (a one-time thing they already have) -> the reason, else null.
 * Roles are checked again inside the purchase; this answers before anything is charged.
 */
async function precheck(prize, pol, to) {
  if (!prize || !pol) return null;
  if (pol.kind === "role") {
    const role = require("./shop").ROLE_PRIZES[prize.prizeId];
    const has = await safe("SELECT 1 FROM user_roles WHERE userId = ? AND LOWER(role) = LOWER(?) LIMIT 1", [to.userId, role]);
    if (has.length) return `${to.username} already has the ${String(prize.prize).replace(/ role$/i, "")} role.`;
  }
  if (pol.kind === "plex") {
    const item = (require("./mediaconf").get().invite_items || {})[prize.prizeId] || {};
    if (!(Number(item.days) > 0)) {
      let pa = null;
      try { pa = await require("./plexmembers").patvAccess(to.userId); } catch (e) { pa = null; }
      if (pa && pa.active && (pa.type === "lifetime" || pa.type === "comp-lifetime")) return `${to.username} already has lifetime Plex access.`;
    }
  }
  return null;
}

/** The recipient's 🎁 notice (localized in THEIR language). from = giver's username, or null (anonymous / a comp). */
async function notifyGift(toUserId, { item, from, note, link, ref, comp = false, extra = "" }) {
  try {
    const t = tFor(toUserId);
    const body = comp ? t("comps.notice.gift_team_body", { item })
      : from ? t("gifts.notice.body_from", { item, from }) : t("gifts.notice.body_anon", { item });
    let msg = note ? `${body} ${t("gifts.notice.note", { note: String(note).slice(0, 200) })}` : body;
    if (extra) msg += " " + extra;
    await require("./inbox").addSafe(toUserId, { kind: comp ? "system" : "shop", ref, title: t("comps.notice.gift_title", { item }), body: msg, link });
  } catch (e) { /* a notice never blocks */ }
}

module.exports = { guard, recipient, precheck, notifyGift, sentSince, tFor, Refuse, GIFT_HOUR, GIFT_DAY, PAIR_DAY,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
