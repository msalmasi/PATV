// storealerts.js — 1.99tp: per-item PURCHASE ALERTS for official store items (the user's "tricon hears whenever someone
// buys the Pokemon cards").
//
// An admin picks, on an official item's edit page (/shop/admin/edit/<prizeId>), the PATV accounts that are alerted
// whenever that item is bought. Per recipient:
//   tg       also a Telegram alert (through the alerts outbox, inbox kind "store_purchase" - they can mute that kind)
//   pm       also a Camfrog PM through Pepe (the shop's own safe path: a "notify" action, pepe_notice.py holds it until
//            they're in a room with him; honours their inbox "store_purchase" PM switch)
//   details  the recipient FULFILS this item: the alert carries the buyer's delivery details (their Camfrog login and anything
//            the buyer typed on the order) and links to the ORDER page, which they may then open (role "fulfiller" in
//            shop.js). Default OFF: without it a recipient only learns the item + who bought it and the link goes to the
//            public item page. Admins can always open orders, but get the details in the alert only with the box ticked.
// The 🔔 inbox notice is always sent (it's the record + the link).
//
// WHEN: shop.onOfficialSale (after an official sale COMMITS - a refused / failed purchase never gets there), and only while
// the order is still "completed" when the alert goes out (a refunded order is skipped). Comps and subscription renewals of
// the item alert too (marked as such): staff still deliver them.
// ONCE: store_alert_sent (order_id, user_id) is claimed before anything is sent, so a retried hook / restart never alerts
// twice; the inbox ref (store_purchase:<order>) and the Telegram ref are idempotent on top.
// GIFTS: the order's buyer is who it's FOR. A gift names the giver; an 🕶 anonymous gift says "someone (anonymous gift)"
// unless the recipient is an admin (the gift_log rule: admins see the real giver).
//
// Tables (userId-keyed, so renames follow; accountMerge.js RULES carry them on a merge):
//   store_alerts      prize_id, user_id, tg, pm, details, added_by (admin userId), created, updated  PK (prize_id, user_id)
//   store_alert_sent  order_id, user_id, prize_id, at                                                 PK (order_id, user_id)
// Every add / change / removal is in admin_audit (actions store_alert_add / store_alert_update / store_alert_remove).
//
// SELLER listings: the table is keyed by prizeId and would work for a listing too, but only official items are offered
// (sellers already get their own order notices, and a listing's buyer details belong to its seller).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const KIND = "store_purchase";
const MAX_PER_ITEM = 25;
const SITE = () => String(process.env.PUBLIC_BASE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS store_alerts (prize_id TEXT NOT NULL, user_id TEXT NOT NULL,
        tg INTEGER NOT NULL DEFAULT 1, pm INTEGER NOT NULL DEFAULT 0, details INTEGER NOT NULL DEFAULT 0,
        added_by TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (prize_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS store_alerts_user ON store_alerts (user_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS store_alert_sent (order_id INTEGER NOT NULL, user_id TEXT NOT NULL, prize_id TEXT,
        at INTEGER NOT NULL, PRIMARY KEY (order_id, user_id))`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, message) { super(message); this.status = status; this.refuse = true; } }
const flag = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
// 1.99ack: was isAdmin (it meant Admin OR Staff): a recipient who runs the shop (shop.admin, siteperms.js) gets the full order
const shopStaff = (u) => SP.can(u, "shop.admin");
const oneLine = (s, n) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const when = (ms) => new Date(Number(ms) || Date.now()).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function tFor(userId) {
  try { return require("./gifts").tFor(userId); } catch (e) { return (k) => k; }
}

async function officialItem(prizeId) {
  const p = (await getQuery("SELECT prizeId, prize, seller_id, status FROM prizes WHERE prizeId = ?", [String(prizeId || "")]))[0];
  if (!p || p.seller_id) throw new Refuse(404, "That isn't an official store item.");
  return p;
}

/** users.archived_at exists? (stale-account archive; absent on an old DB / in tests) */
async function liveSql(alias = "") {
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  return cols.has("archived_at") ? `${alias}archived_at IS NULL` : "1 = 1";
}

/**
 * A PATV username (or, if no account has that name, a linked Camfrog login) -> {userId, username, class} or a 404 Refuse.
 * 1.99ue: exact and case-insensitive, NO shape / length rule on the username (legacy names run past 40 characters), live
 * accounts only. Several accounts on one Camfrog login: a real one beats a random "CF..." auto account, then the oldest.
 */
async function resolveUser(name) {
  const s = String(name || "").trim().replace(/^@/, "").replace(/^u\//i, "").slice(0, 64);
  if (!s) throw new Refuse(400, "Pick a member.");
  const live = await liveSql();
  const by = async (col) => (await getQuery(`SELECT userId, username, class FROM users WHERE ${live} AND username IS NOT NULL
    AND LOWER(${col}) = LOWER(?) ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END, rowid LIMIT 1`, [s]))[0];
  const u = (await by("username")) || (await by("camfrogUsername"));
  if (!u) throw new Refuse(404, `There's no member called ${s}.`);
  return u;
}

const PEOPLE_MAX = 10;
const likeEsc = (x) => x.replace(/[!%_]/g, (c) => "!" + c);   // LIKE ... ESCAPE '!'
/**
 * 1.99ue: the "Alert on purchase" picker's people search (staff only - the route checks). Matches the PATV username, the
 * display name AND the linked Camfrog login; prefix matches first, then contains. No shape / length filter on usernames
 * (unlike @mention suggestions), live accounts only, at most 10. -> [{username, display, camfrog}]
 */
async function searchPeople(q) {
  const s = String(q == null ? "" : q).trim().replace(/^@/, "").replace(/^u\//i, "").slice(0, 64).toLowerCase();
  if (!s) return [];
  const live = await liveSql();
  const pre = likeEsc(s) + "%", any = "%" + likeEsc(s) + "%";
  const rows = await getQuery(`SELECT username, displayname, camfrogUsername FROM users WHERE ${live} AND username IS NOT NULL
    AND (LOWER(username) LIKE ? ESCAPE '!' OR LOWER(COALESCE(displayname, '')) LIKE ? ESCAPE '!' OR LOWER(COALESCE(camfrogUsername, '')) LIKE ? ESCAPE '!')
    ORDER BY CASE WHEN LOWER(username) = ? OR LOWER(COALESCE(camfrogUsername, '')) = ? THEN 0
                  WHEN LOWER(username) LIKE ? ESCAPE '!' OR LOWER(COALESCE(camfrogUsername, '')) LIKE ? ESCAPE '!' THEN 1
                  WHEN LOWER(COALESCE(displayname, '')) LIKE ? ESCAPE '!' THEN 2 ELSE 3 END,
             LENGTH(username), username LIMIT ?`,
    [any, any, any, s, s, pre, pre, pre, PEOPLE_MAX]);
  return rows.map((r) => ({ username: r.username,
                            display: r.displayname && r.displayname !== r.username ? oneLine(r.displayname, 60) : null,
                            camfrog: r.camfrogUsername ? oneLine(r.camfrogUsername, 64) : null }));
}

/** One item's recipients: [{user_id, username, camfrog, admin, tg, pm, details, added_by_name, updated}]. */
async function forItem(prizeId) {
  await init();
  const rows = await getQuery(`SELECT a.*, u.username, u.class, u.camfrogUsername AS camfrog, b.username AS added_by_name
    FROM store_alerts a LEFT JOIN users u ON u.userId = a.user_id LEFT JOIN users b ON b.userId = a.added_by
    WHERE a.prize_id = ? ORDER BY a.created`, [String(prizeId || "")]);
  return rows.map((r) => ({ user_id: r.user_id, username: r.username || null, camfrog: r.camfrog || null, admin: shopStaff(r),
                            tg: !!r.tg, pm: !!r.pm, details: !!r.details, added_by_name: r.added_by_name || null, updated: r.updated }));
}

/** Every official item that has recipients: [{prizeId, prize, status, recipients: [...]}] (the shop admin overview). */
async function overview() {
  await init();
  const rows = await getQuery(`SELECT a.prize_id, a.tg, a.pm, a.details, u.username, p.prize, p.status
    FROM store_alerts a LEFT JOIN users u ON u.userId = a.user_id LEFT JOIN prizes p ON p.prizeId = a.prize_id
    ORDER BY p.prize, a.created`);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.prize_id)) by.set(r.prize_id, { prizeId: r.prize_id, prize: r.prize || r.prize_id, status: r.status || "removed", recipients: [] });
    by.get(r.prize_id).recipients.push({ username: r.username || "?", tg: !!r.tg, pm: !!r.pm, details: !!r.details });
  }
  return [...by.values()];
}

/** Can this user open orders of this item as its fulfiller? (shop.js /shop/orders/:id) */
async function isFulfiller(prizeId, userId) {
  if (!prizeId || !userId) return false;
  await init();
  return !!(await getQuery("SELECT 1 FROM store_alerts WHERE prize_id = ? AND user_id = ? AND details = 1", [String(prizeId), userId]))[0];
}

/**
 * admin {userId, username} sets one recipient on an official item. op: add | update | remove.
 * add: {who (username / Camfrog login), tg, pm, details}; update: {userId, tg, pm, details}; remove: {userId}. Audited.
 */
async function setRecipient(admin, prizeId, op, b = {}) {
  await init();
  if (!admin || !admin.userId) throw new Refuse(403, "Admins only.");
  const p = await officialItem(prizeId);
  const opts = { tg: flag(b.tg) ? 1 : 0, pm: flag(b.pm) ? 1 : 0, details: flag(b.details) ? 1 : 0 };
  const audit = (action, target, extra) => require("./adminaudit").record(admin, action, target,
    { prize_id: p.prizeId, item: p.prize, ...extra }, null).catch((e) => console.error("[storealerts] audit:", e.message));
  const t = Date.now();
  if (op === "add") {
    const u = await resolveUser(b.who);
    const n = (await getQuery("SELECT COUNT(*) AS n FROM store_alerts WHERE prize_id = ?", [p.prizeId]))[0].n;
    const had = (await getQuery("SELECT 1 FROM store_alerts WHERE prize_id = ? AND user_id = ?", [p.prizeId, u.userId]))[0];
    if (!had && n >= MAX_PER_ITEM) throw new Refuse(400, `Up to ${MAX_PER_ITEM} people per item.`);
    await runQuery(`INSERT INTO store_alerts (prize_id, user_id, tg, pm, details, added_by, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(prize_id, user_id) DO UPDATE SET tg = excluded.tg, pm = excluded.pm, details = excluded.details, updated = excluded.updated`,
      [p.prizeId, u.userId, opts.tg, opts.pm, opts.details, admin.userId, t, t]);
    await audit(had ? "store_alert_update" : "store_alert_add", u, opts);
    return { message: had ? `Updated ${u.username}'s alert.` : `${u.username} will be alerted when someone buys ${p.prize}.`, user: u };
  }
  const target = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(b.userId || "")]))[0] || { userId: String(b.userId || ""), username: null };
  if (op === "update") {
    const r = await runQuery("UPDATE store_alerts SET tg = ?, pm = ?, details = ?, updated = ? WHERE prize_id = ? AND user_id = ?",
      [opts.tg, opts.pm, opts.details, t, p.prizeId, target.userId]);
    if (!r.changes) throw new Refuse(404, "That person isn't on this item's alert list.");
    await audit("store_alert_update", target, opts);
    return { message: `Updated ${target.username || "the"} alert.` };
  }
  if (op === "remove") {
    const r = await runQuery("DELETE FROM store_alerts WHERE prize_id = ? AND user_id = ?", [p.prizeId, target.userId]);
    if (!r.changes) throw new Refuse(404, "That person isn't on this item's alert list.");
    await audit("store_alert_remove", target, {});
    return { message: `${target.username || "They"} won't be alerted for ${p.prize} any more.` };
  }
  throw new Refuse(400, "Unknown action.");
}

/**
 * The alert for one recipient: {title, body, pm, link, admin, details}. Pure (exported for tests).
 * o = the order (+ buyer_name, buyer_camfrog, giver_name), r = the recipient row (+ class).
 */
function compose(o, r, t) {
  const admin = shopStaff(r);
  const details = !!r.details;
  const canOpen = admin || details;
  const site = SITE();
  const buyer = o.buyer_name || "?";
  const anon = !!Number(o.gift_anon) && !!o.gift_from;
  const lines = [];
  if (o.comp_by) lines.push(t("storealert.line.comp", { name: buyer }));
  else if (o.gift_from && anon && !admin) lines.push(t("storealert.line.gift_anon", { name: buyer }));
  else if (o.gift_from) lines.push(t("storealert.line.gift", { giver: o.giver_name || "?", name: buyer }) + (anon ? " " + t("storealert.line.anon_admin") : ""));
  else if (o.source === "subscription") lines.push(t("storealert.line.renewal", { name: buyer }));
  else lines.push(t("storealert.line.buyer", { name: buyer }));
  lines.push(t("storealert.line.profile", { url: `${site}/u/${encodeURIComponent(buyer)}` }));
  lines.push(t("storealert.line.qty", { n: 1 }));
  lines.push(t("storealert.line.when", { when: when(o.created) }));
  if (canOpen) lines.push(t("storealert.line.order", { id: o.id, url: `${site}/shop/orders/${o.id}` }));
  if (details) {
    lines.push("");
    lines.push(t("storealert.line.details_h"));
    lines.push(o.buyer_camfrog ? t("storealert.line.camfrog", { login: o.buyer_camfrog }) : t("storealert.line.no_camfrog"));
    if (o.buyer_input) lines.push(t("storealert.line.input", { text: oneLine(o.buyer_input, 300) }));
    lines.push(t("storealert.line.message", { url: `${site}/messages/new?to=${encodeURIComponent(buyer)}` }));
  }
  const who = o.gift_from && anon && !admin ? t("storealert.someone") : buyer;
  return {
    title: t("storealert.title", { item: o.title }),
    body: lines.join("\n"),
    pm: t("storealert.pm", { item: o.title, name: who }),
    link: canOpen ? `/shop/orders/${o.id}` : (o.prize_id ? `/shop/item/${o.prize_id}` : "/shop"),
    admin, details,
  };
}

async function orderFor(orderId) {
  return (await getQuery(`SELECT o.*, b.username AS buyer_name, b.camfrogUsername AS buyer_camfrog, g.username AS giver_name
    FROM shop_orders o LEFT JOIN users b ON b.userId = o.buyer_id LEFT JOIN users g ON g.userId = o.gift_from WHERE o.id = ?`,
    [parseInt(orderId, 10) || 0]))[0] || null;
}

/** Send the alerts for one order (the sale hook; also safe to call again - each recipient is alerted once). -> how many sent. */
async function alertOrder(orderId) {
  await init();
  const o = await orderFor(orderId);
  if (!o || !o.official || !o.prize_id || o.status !== "completed") return 0;     // never a refunded / failed / marketplace order
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const recips = await getQuery(`SELECT a.*, u.username, u.class, u.camfrogUsername AS camfrog, ${cols.has("archived_at") ? "u.archived_at" : "NULL AS archived_at"}
    FROM store_alerts a JOIN users u ON u.userId = a.user_id WHERE a.prize_id = ? ORDER BY a.created`, [o.prize_id]);
  let sent = 0;
  for (const r of recips) {
    if (r.archived_at) continue;
    const claim = await runQuery("INSERT OR IGNORE INTO store_alert_sent (order_id, user_id, prize_id, at) VALUES (?, ?, ?, ?)",
                                 [o.id, r.user_id, o.prize_id, Date.now()]);
    if (!claim.changes) continue;                                                   // already alerted for this order
    try {
      const m = compose(o, r, tFor(r.user_id));
      const ref = `${KIND}:${o.id}`;
      await require("./inbox").add(r.user_id, { kind: KIND, title: m.title, body: m.body, link: m.link, ref, telegram: false });
      if (r.tg) {
        const url = SITE() + m.link;                                              // once (the order line may carry it already)
        await require("./telegram").queue(r.user_id, { kind: KIND, ref: "n:" + ref,
          text: [m.title, m.body, ...(m.body.includes(url) ? [] : [url])].join("\n") });
      }
      if (r.pm && r.camfrog && await require("./inbox").pmAllowed(r.user_id, KIND)) {
        // the shop's own path: Pepe PMs it where they are, or holds it until they show up (kind "shop" on the bot side)
        await require("./actions").queue(r.user_id, { kind: "notify", args: [r.camfrog, `${m.pm} ${SITE()}${m.link}`.slice(0, 300), "shop"],
                                                       tag: "store-alert", label: m.title, idem: `store-alert-${o.id}` });
      }
      sent++;
    } catch (e) {
      console.error("[storealerts] alert:", e.message);
    }
  }
  return sent;
}

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  require("./shop").onOfficialSale((sale) => (sale && sale.orderId ? alertOrder(sale.orderId) : 0));
}

module.exports = { init, hook, forItem, overview, isFulfiller, setRecipient, alertOrder, compose, resolveUser, searchPeople, Refuse, KIND, MAX_PER_ITEM, PEOPLE_MAX };
