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
//
// 🕶 ANONYMOUS GIFTS (1.99mt, the user's "gift anonymously"): every path takes `anon` (a "Send anonymously" box). The
// recipient then sees "🎁 Someone sent you ..." - in the notice, the order, its events, the history - never the giver; the
// giver still sees their own order / ledger line. Admins see the real giver: the order page (admin view) and the GIFT LOG
// below (/admin/comps#gifts). The rules above apply unchanged (a block refuses with the same words as always).
//
// GIFT LOG (gift_log, 1.99mt): one row per gift on any path (kind shop | season_pass | prime_time | sticker | cosmetic),
// giver + recipient + item + anon - the admins' audit, and what the 🎁 gifting achievements count. A one-time quiet
// backfill (logBackfill) copies the gifts made before it from shop_orders / premium_ledger / user_sticker_packs /
// cosmetic_transfers.
"use strict";
const { getQuery, runQuery } = require("./dbUtils");

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

/** Anonymous-gift flag from a form or JSON body ("Send anonymously"). */
function anonFlag(v) { return v === true || v === 1 || ["1", "on", "true", "yes", "anon"].includes(String(v == null ? "" : v).trim().toLowerCase()); }

// ── 1.99mt: the gift log ──
let logReady = null;
function initLog() {
  if (!logReady) {
    logReady = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS gift_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, giver_id TEXT, recipient_id TEXT, target TEXT, item TEXT,
        ref TEXT NOT NULL, anon INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS gift_log_ref ON gift_log (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS gift_log_giver ON gift_log (giver_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS gift_log_recipient ON gift_log (recipient_id, created)");
    })().catch((e) => { logReady = null; throw e; });
  }
  return logReady;
}

/**
 * Log one gift (idempotent by ref) and run the gifting achievement checks. kind = shop | season_pass | prime_time |
 * sticker | cosmetic; target = a pad id for Prime Time (recipientId = its owner, if any). An anonymous gift's GIVER check is
 * delayed a while, so an achievement announced in the room doesn't point at who just sent the "Someone" gift.
 */
async function record({ kind, giverId, recipientId = null, target = null, item = "", ref, anon = false, at = null }) {
  try {
    await initLog();
    if (!giverId || !ref) return false;
    const r = await runQuery(`INSERT OR IGNORE INTO gift_log (kind, giver_id, recipient_id, target, item, ref, anon, created)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                             [String(kind).slice(0, 20), giverId, recipientId || null, target || null, String(item || "").slice(0, 120),
                              String(ref).slice(0, 200), anon ? 1 : 0, at || clock()]);
    if (!r || !r.changes) return false;
    achCheck(recipientId, 0);
    achCheck(giverId, anon ? ANON_ACH_DELAY_MIN + Math.floor(Math.random() * ANON_ACH_DELAY_SPREAD) : 0);
    return true;
  } catch (e) {
    console.error("[gifts] log:", e.message);
    return false;
  }
}
const ANON_ACH_DELAY_MIN = 20 * 60 * 1000, ANON_ACH_DELAY_SPREAD = 70 * 60 * 1000;
let achDelay = null;              // tests: (userId, ms) -> void instead of a timer
function achCheck(userId, delay) {
  if (!userId) return;
  if (achDelay) return void achDelay(userId, delay);
  const run = () => { try { require("./achievements").checkWeb(userId); } catch (e) { /* never blocks a gift */ } };
  if (!delay) return void Promise.resolve().then(run);
  const t = setTimeout(run, delay);
  if (t && t.unref) t.unref();
}

/** Gifting metrics for the achievements: gifts sent, distinct people gifted, gifts received. */
async function achMetrics(userId) {
  await initLog();
  await logBackfill().catch(() => {});
  const one = async (sql, a) => Number(((await safe(sql, a))[0] || {}).n) || 0;
  return {
    gifts_sent: await one("SELECT COUNT(*) AS n FROM gift_log WHERE giver_id = ?", [userId]),
    gift_people: await one("SELECT COUNT(DISTINCT recipient_id) AS n FROM gift_log WHERE giver_id = ? AND recipient_id IS NOT NULL AND recipient_id != giver_id", [userId]),
    gifts_received: await one("SELECT COUNT(*) AS n FROM gift_log WHERE recipient_id = ? AND giver_id != recipient_id", [userId]),
  };
}

// Once: copy the gifts made before the log existed (all named - anonymous gifts didn't exist yet).
let backfilling = null;
function logBackfill() {
  if (!backfilling) {
    backfilling = (async () => {
      await initLog();
      await runQuery("CREATE TABLE IF NOT EXISTS gift_meta (k TEXT PRIMARY KEY, v TEXT)");
      if ((await safe("SELECT v FROM gift_meta WHERE k = 'log_backfill'")).length) return { already: true, n: 0 };
      let n = 0;
      const ins = async (kind, giver, to, target, item, ref, at) => {
        const r = await runQuery(`INSERT OR IGNORE INTO gift_log (kind, giver_id, recipient_id, target, item, ref, anon, created) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
                                 [kind, giver, to || null, target || null, String(item || "").slice(0, 120), ref, Number(at) || 0]);
        n += (r && r.changes) || 0;
      };
      for (const o of await safe("SELECT id, buyer_id, gift_from, title, created FROM shop_orders WHERE gift_from IS NOT NULL")) {
        await ins("shop", o.gift_from, o.buyer_id, null, o.title, `shop:${o.id}`, o.created);
      }
      for (const l of await safe("SELECT ref, tier, target, payer_id, created FROM premium_ledger WHERE kind = 'gift' AND payer_id IS NOT NULL")) {
        let to = l.target, target = null;
        if (l.tier === "prime_time") { target = l.target; to = await padOwner(l.target); }
        await ins(l.tier, l.payer_id, to, target, l.tier === "prime_time" ? "📺 Prime Time" : "🎟️ Season Pass", `prem:${l.ref}`, l.created);
      }
      for (const s of await safe("SELECT ref, user_id, payer_id, pack_id, created FROM user_sticker_packs WHERE source = 'gift' AND payer_id IS NOT NULL")) {
        await ins("sticker", s.payer_id, s.user_id, null, s.pack_id, `stk:${s.ref}`, s.created);
      }
      for (const c of await safe(`SELECT t.idem, t.from_id, t.to_id, t.created, c.item_id FROM cosmetic_transfers t LEFT JOIN user_cosmetics c ON c.id = t.inv_id
                                  WHERE t.listing_id IS NULL AND t.idem LIKE 'gift:%'`)) {
        await ins("cosmetic", c.from_id, c.to_id, null, c.item_id, `cos:${c.idem}`, c.created);
      }
      await runQuery("INSERT OR REPLACE INTO gift_meta (k, v) VALUES ('log_backfill', ?)", [JSON.stringify({ at: new Date().toISOString(), n })]);
      if (n) console.log(`[gifts] log backfill: ${n} earlier gift(s)`);
      return { n };
    })().catch((e) => { backfilling = null; throw e; });
  }
  return backfilling;
}
/** A pad's owner (user id) or null. */
async function padOwner(padId) {
  try { const R = await require("./rooms").get(padId); return (R && R.owner && R.owner.userId) || null; } catch (e) { return null; }
}

/** The admins' view of the log (real givers; anonymous ones marked). */
async function adminLog(limit = 100) {
  await initLog();
  return safe(`SELECT g.id, g.kind, g.item, g.anon, g.created, g.target, gv.username AS giver, rc.username AS recipient
               FROM gift_log g LEFT JOIN users gv ON gv.userId = g.giver_id LEFT JOIN users rc ON rc.userId = g.recipient_id
               ORDER BY g.created DESC, g.id DESC LIMIT ?`, [Math.max(1, Math.min(500, Number(limit) || 100))]);
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
                   anonFlag, record, achMetrics, logBackfill, adminLog, initLog, _setAchDelay: (fn) => { achDelay = fn || null; },
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
