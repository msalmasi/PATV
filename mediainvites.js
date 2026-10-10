// mediainvites.js — 1.99ji: 🎟️ Plex access bought in the store, fulfilled by Wizarr.
//
// The store's "Plex Invite …" items (mediaconf invite_items: prizeId -> {days}; 0 = lifetime) used to be fulfilled by
// hand. With invites on (flag invites_enabled + WIZARR_URL / WIZARR_API_KEY), each purchase creates ONE one-time Wizarr
// invitation (server + libraries from the settings, the link valid wizarr_link_days, the access lasting the item's days)
// and hands the link to the buyer IN-SITE only: their order page (the order's note) and a DM from Pepe - never chat.
// If Wizarr can't be reached the order goes to the MANUAL QUEUE (/admin/media#invites): it's retried every 10 minutes
// (6 times), an admin can retry it or send a link / note by hand. With invites off nothing changes (manual, as before).
//
// 1.99jp: the invite's own expiry: by default Wizarr invites NEVER expire by themselves (setting wizarr_timed off) - PATV
// tracks how long the access lasts (plexmembers.js: stacked orders, subscriptions) and only removes a share after an admin
// confirms (or with plex_auto_revoke on). A buyer who is ALREADY an active Plex member gets no second invite: the order
// just adds time ("extended"). A subscription renewal (sale.renewal) never makes an invite.
//
//   media_invites   one row per order: pending | created | manual | sent (by hand) | extended
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}
const env = (k) => String(process.env[k] || "").trim();
let clock = () => Date.now();
const RETRY_MS = 10 * 60 * 1000;
const AUTO_TRIES = 6;

async function api(method, p, body = null) {
  const base = env("WIZARR_URL").replace(/\/+$/, ""), key = env("WIZARR_API_KEY");
  if (!base || !key) throw new Refuse(503, "Wizarr isn't configured.");
  let r;
  try {
    r = await fetch(base + "/api" + p, {
      method, headers: { "X-API-Key": key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000), redirect: "error",
    });
  } catch (e) {
    throw new Refuse(502, "Wizarr can't be reached.");
  }
  let json = null;
  try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, json };
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS media_invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL UNIQUE, user_id TEXT NOT NULL, username TEXT, prize_id TEXT,
        title TEXT, days INTEGER, status TEXT NOT NULL, code TEXT, url TEXT, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, next_try INTEGER, done_by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_invites_status ON media_invites (status, next_try)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const idList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
/** Create one one-time invitation. -> {code, url} (throws Refuse on any failure). */
async function createInvite(days) {
  const S = conf.get();
  const timed = days > 0 && !!S.wizarr_timed;
  const body = {
    expires_in_days: S.wizarr_link_days,
    duration: timed ? String(days) : "unlimited",
    unlimited: !timed,
    allow_downloads: false, allow_live_tv: false, allow_mobile_uploads: false,
  };
  const servers = idList(S.wizarr_server_ids), libs = idList(S.wizarr_library_ids);
  if (servers.length) body.server_ids = servers;
  if (libs.length) body.library_ids = libs;
  const r = await api("POST", "/invitations", body);
  if (r.status !== 201 && r.status !== 200) throw new Refuse(502, `Wizarr answered ${r.status}${r.json && (r.json.error || r.json.message) ? ": " + String(r.json.error || r.json.message).slice(0, 120) : ""}`);
  const inv = (r.json && (r.json.invitation || r.json)) || {};
  const code = String(inv.code || "").trim();
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) throw new Refuse(502, "Wizarr didn't return an invite code.");
  const pub = env("WIZARR_PUBLIC_URL") || env("WIZARR_URL");
  let url = String(inv.url || "").trim();
  if (!/^https:\/\/[^\s"'<>]+$/.test(url)) url = pub.replace(/\/+$/, "") + "/j/" + code;
  return { code, url };
}

const SITE = () => String(process.env.PUBLIC_BASE_URL || "https://publicaccess.tv").replace(/\/+$/, "");
const accessText = (days) => (days > 0 ? `${days} days of Plex access` : "lifetime Plex access");

// deliver a created invite: the order's note + timeline, a 🔔 notice and a DM from Pepe (never public chat)
async function deliver(row, inv, by) {
  const shop = require("./shop");
  const S = conf.get();
  const note = `Your one-time Plex invite (${accessText(row.days)}): ${inv.url}\n` +
               `Open it within ${S.wizarr_link_days} day${S.wizarr_link_days === 1 ? "" : "s"} and follow the steps to join the server. Keep it to yourself - it works once.`;
  await runQuery("UPDATE shop_orders SET seller_note = ?, updated = ? WHERE id = ?", [note, clock(), row.order_id]);
  await shop.event(row.order_id, "completed", by || "system", "Plex invite created" + (by && by !== "system" ? " by hand" : " (Wizarr)"));
  const inbox = require("./inbox");
  await inbox.addSafe(row.user_id, { kind: "media", title: "🎟️ Your Plex invite is ready", body: "Open your order to get the link.", link: `/shop/orders/${row.order_id}`, ref: `minv:${row.order_id}` });
  try {
    const M = require("./messages");
    await M.send({ userId: M.PEPE_ID }, { to: row.username, body: `🎟️ Your Plex invite (${accessText(row.days)}) is ready: ${inv.url} — it works once, so keep it to yourself. It's also on your order: ${SITE()}/shop/orders/${row.order_id}` });
  } catch (e) { /* DMs closed / Pepe's account missing: the order page + notice have it */ }
}

async function attempt(row, by) {
  try {
    const inv = await createInvite(row.days);
    const r = await runQuery("UPDATE media_invites SET status = 'created', code = ?, url = ?, error = NULL, attempts = attempts + 1, updated = ?, next_try = NULL, done_by = ? WHERE id = ? AND status IN ('pending','manual')",
                             [inv.code, inv.url, clock(), by || "system", row.id]);
    if (!r || !r.changes) return { ok: false, error: "changed meanwhile" };
    await deliver(row, inv, by);
    console.log(`[invites] order #${row.order_id}: Wizarr invite ${inv.code.slice(0, 3)}… for ${row.username} (${row.days || "lifetime"} d)`);
    return { ok: true };
  } catch (e) {
    const tries = (row.attempts || 0) + 1;
    await runQuery("UPDATE media_invites SET status = 'manual', attempts = ?, error = ?, updated = ?, next_try = ? WHERE id = ? AND status IN ('pending','manual')",
                   [tries, conf.errLine(e), clock(), tries < AUTO_TRIES ? clock() + RETRY_MS : null, row.id]);
    return { ok: false, error: conf.errLine(e), tries };
  }
}

// the shop hook (shop.onOfficialSale): an invite item was bought
async function onSale(sale) {
  const item = (conf.get().invite_items || {})[sale.prizeId];
  if (!item || !conf.on.invites()) return false;            // off = fulfilled by hand, as before
  if (sale.renewal) return false;                           // 1.99jp: a subscription renewal only adds time
  await init();
  const t = clock();
  // 1.99jp: already on the server (an active, linked Plex member): no second invite - the purchase extends the access
  let member = null;
  try { member = await require("./plexmembers").memberFor(sale.userId); } catch (e) { member = null; }
  if (member) {
    const ins0 = await runQuery(`INSERT OR IGNORE INTO media_invites (order_id, user_id, username, prize_id, title, days, status, created, updated, done_by)
                                 VALUES (?, ?, ?, ?, ?, ?, 'extended', ?, ?, 'system')`, [sale.orderId, sale.userId, sale.username, sale.prizeId, sale.title, item.days, t, t]);
    if (!ins0 || !ins0.changes) return false;
    const shop = require("./shop");
    await runQuery("UPDATE shop_orders SET seller_note = ?, updated = ? WHERE id = ?",
                   [`You're already on our Plex server (as ${member.username || "your Plex account"}), so no new invite is needed - this adds ${accessText(item.days)} to your access. See /settings/subscriptions.`, t, sale.orderId]);
    await shop.event(sale.orderId, "completed", "system", "Already a Plex member - access extended (no new invite)");
    try { await require("./plexmembers").refreshUser(sale.userId); } catch (e) { /* the next sync does it */ }
    await require("./inbox").addSafe(sale.userId, { kind: "media", title: "📼 Your Plex access was extended", body: `${accessText(item.days)} added.`,
      link: "/settings/subscriptions", ref: `minv-ext:${sale.orderId}` });
    return true;
  }
  const ins = await runQuery(`INSERT OR IGNORE INTO media_invites (order_id, user_id, username, prize_id, title, days, status, created, updated)
                              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [sale.orderId, sale.userId, sale.username, sale.prizeId, sale.title, item.days, t, t]);
  if (!ins || !ins.changes) return false;
  const row = (await getQuery("SELECT * FROM media_invites WHERE order_id = ?", [sale.orderId]))[0];
  const r = await attempt(row, "system");
  if (!r.ok) {
    const shop = require("./shop");
    await runQuery("UPDATE shop_orders SET seller_note = ? WHERE id = ? AND seller_note IS NULL",
                   ["Your Plex invite is being prepared - it'll appear here and in your messages shortly.", sale.orderId]);
    await shop.event(sale.orderId, "completed", "system", "Plex invite queued (Wizarr unreachable) - it'll be sent shortly");
    await require("./inbox").addSafe(sale.userId, { kind: "media", title: "🎟️ Your Plex invite is on its way",
      body: "We couldn't make it automatically just now; you'll get it here shortly.", link: `/shop/orders/${sale.orderId}`, ref: `minv-q:${sale.orderId}` });
    console.warn(`[invites] order #${sale.orderId} queued for manual fulfilment: ${r.error}`);
  }
  return r.ok;
}

async function retryDue() {
  await init();
  if (!conf.on.invites()) return 0;
  const rows = await getQuery("SELECT * FROM media_invites WHERE status = 'manual' AND next_try IS NOT NULL AND next_try <= ? ORDER BY id LIMIT 20", [clock()]);
  let n = 0;
  for (const row of rows) { if ((await attempt(row, "system")).ok) n++; else break; }   // Wizarr still down: try the rest later
  return n;
}

// admin: retry now, or record a link / note sent by hand
async function adminRetry(id, actor) {
  await init();
  if (!conf.keys().wizarr) throw new Refuse(503, "Wizarr isn't configured.");
  const row = (await getQuery("SELECT * FROM media_invites WHERE id = ? AND status IN ('manual','pending')", [Number(id) || 0]))[0];
  if (!row) throw new Refuse(404, "Not in the queue any more.");
  const r = await attempt(row, actor);
  if (!r.ok) throw new Refuse(502, `Still failing: ${r.error}`);
  return { ok: true };
}
async function adminSent(id, text, actor) {
  await init();
  const row = (await getQuery("SELECT * FROM media_invites WHERE id = ? AND status IN ('manual','pending')", [Number(id) || 0]))[0];
  if (!row) throw new Refuse(404, "Not in the queue any more.");
  const t = String(text || "").replace(/\r/g, "").trim().slice(0, 1000);
  if (t.length < 5) throw new Refuse(400, "Paste the invite link or a note for the buyer.");
  const r = await runQuery("UPDATE media_invites SET status = 'sent', done_by = ?, updated = ?, next_try = NULL WHERE id = ? AND status IN ('manual','pending')", [actor, clock(), row.id]);
  if (!r.changes) throw new Refuse(409, "Changed meanwhile - reload.");
  const m = /https:\/\/\S+/.exec(t);
  await deliver(row, { url: m ? m[0] : t, code: null }, actor);
  if (!m) await runQuery("UPDATE shop_orders SET seller_note = ? WHERE id = ?", [t, row.order_id]);
  return { ok: true };
}
async function adminState() {
  await init();
  return {
    queue: await getQuery("SELECT id, order_id, username, title, days, status, attempts, error, created, next_try FROM media_invites WHERE status IN ('manual','pending') ORDER BY id"),
    recent: await getQuery("SELECT id, order_id, username, title, days, status, attempts, done_by, created, updated FROM media_invites ORDER BY id DESC LIMIT 30"),
  };
}
/** Wizarr's servers + libraries, for the settings form (names and ids only). */
async function catalog() {
  const [s, l] = await Promise.all([api("GET", "/servers"), api("GET", "/libraries")]);
  const arr = (j, k) => (Array.isArray(j) ? j : (j && Array.isArray(j[k]) ? j[k] : []));
  return {
    ok: s.status === 200 || l.status === 200,
    servers: arr(s.json, "servers").map((x) => ({ id: x.id, name: x.name || x.server_name || String(x.id), type: x.server_type || x.type || null })),
    libraries: arr(l.json, "libraries").map((x) => ({ id: x.id, name: x.name || String(x.id), server: x.server_id || null })),
  };
}

let timer = null;
function register(app, { noTimers } = {}) {
  require("./shop").onOfficialSale(onSale);
  if (!noTimers && !timer) {
    timer = setInterval(() => retryDue().catch((e) => console.error("[invites] retry:", conf.errLine(e))), 60 * 1000);
    timer.unref();
  }
}

module.exports = { init, register, onSale, retryDue, adminRetry, adminSent, adminState, catalog, createInvite, Refuse,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
