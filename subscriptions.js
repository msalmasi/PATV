// subscriptions.js — 1.99jp: SUBSCRIPTIONS for official store items (generic), plus one place to see and cancel every
// auto-renewing thing an account pays for (/settings/subscriptions): these shop subscriptions AND the 📺 Prime Time /
// 🎟️ Season Pass renewals (premium.js, which already renews by itself - shown and switched from here, prices and routing
// unchanged).
//
// WHICH ITEMS: config `items` {prizeId: {days}} - an official store item listed there can be bought once (as always) OR
// as a subscription that renews every `days`. First: Plex Invite 1 Month Access (30 days) = the "Plex monthly
// subscription", the same price as one month.
//
// LIFECYCLE
//   start    the first period is an ordinary purchase of the item (shop.purchasePrize: its stock, its sale hooks - e.g.
//            the Wizarr invite - and its routing: the store owner, like every sale of that item); the subscription row
//            starts with paid_through = now + days.
//   renew    the hourly job charges the item's CURRENT price on the paid-through date (shop.chargeRenewal: one transaction
//            with this module's ledger row - ref sub:<id>:<paid_through>, so it never charges a period twice); a
//            completed order goes on the buyer's orders page; no stock used; sale hooks see `renewal: true`.
//   grace    the balance doesn't cover it: an inbox notice, status grace for grace_days (the access goes on), retried
//            every hour (and "Pay now" on the page).
//   lapse    grace over and still unpaid: status lapsed + a notice. For Plex that ends the access (plexmembers.js decides
//            what happens to the Plex share - only after an admin confirms, unless its auto-revoke is on).
//   cancel   any time: no more charges; the paid time runs to its end (status active + cancel_at_end, then ended).
//            "Resume" undoes it before the end. Cancelling during the grace ends it straight away.
//
//   shop_sub_config   key -> JSON (items, grace_days, enabled)
//   shop_subs         one row per subscription
//   shop_sub_ledger   one row per paid period (UNIQUE ref)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 24 * 3600 * 1000;
let clock = () => Date.now();
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

const PLEX_MONTH = "1c120384-c080-4186-b246-f1227e82ab01";     // Plex Invite 1 Month Access (mediaconf invite_items)
const DEFAULTS = Object.freeze({ enabled: true, grace_days: 3, items: { [PLEX_MONTH]: { days: 30 } } });
let CONFIG = JSON.parse(JSON.stringify(DEFAULTS));
function clean(c) {
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const items = {};
  let raw = c.items;
  if (typeof raw === "string") { try { raw = raw.trim() ? JSON.parse(raw) : {}; } catch (e) { throw new Refuse(400, "The item list isn't valid JSON."); } }
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : DEFAULTS.items)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(k) || !v || typeof v !== "object") continue;
    items[k] = { days: int(v.days, 1, 366, 30) };
  }
  return {
    enabled: c.enabled === undefined ? DEFAULTS.enabled : c.enabled === true || c.enabled === "1" || c.enabled === "on" || c.enabled === "true",
    grace_days: int(c.grace_days, 0, 14, DEFAULTS.grace_days),
    items,
  };
}
const config = () => JSON.parse(JSON.stringify(CONFIG));

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS shop_sub_config (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS shop_subs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, prize_id TEXT NOT NULL, title TEXT, price INTEGER NOT NULL, days INTEGER NOT NULL,
        status TEXT NOT NULL, cancel_at_end INTEGER NOT NULL DEFAULT 0, paid_through INTEGER NOT NULL, grace_until INTEGER,
        renewals INTEGER NOT NULL DEFAULT 0, last_order_id INTEGER, notified TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, ended_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS shop_subs_user ON shop_subs (user_id, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS shop_subs_due ON shop_subs (status, paid_through)");
      await runQuery(`CREATE TABLE IF NOT EXISTS shop_sub_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, sub_id INTEGER NOT NULL, order_id INTEGER, kind TEXT NOT NULL, amount INTEGER NOT NULL,
        period_from INTEGER, period_to INTEGER, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS shop_sub_ledger_ref ON shop_sub_ledger (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS shop_sub_ledger_order ON shop_sub_ledger (order_id)");
      const c = {};
      for (const r of await getQuery("SELECT key, value FROM shop_sub_config")) { try { c[r.key] = JSON.parse(r.value); } catch (e) { /* default */ } }
      CONFIG = clean(c);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function setConfig(patch, actor) {
  await init();
  const next = clean({ ...CONFIG, ...(patch || {}) });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO shop_sub_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
  console.log(`[subs] config changed by ${actor || "?"}`);
  return config();
}

const LIVE = "('active','grace')";
const subscribable = (prizeId) => !!(CONFIG.items || {})[String(prizeId || "")];
async function item(prizeId) {
  return (await getQuery("SELECT prizeId, prize, cost, quantity, status, seller_id FROM prizes WHERE prizeId = ?", [String(prizeId || "")]))[0] || null;
}
async function subRow(id) { return (await getQuery("SELECT * FROM shop_subs WHERE id = ?", [Number(id) || 0]))[0] || null; }
async function liveFor(userId, prizeId) {
  return (await getQuery(`SELECT * FROM shop_subs WHERE user_id = ? AND prize_id = ? AND status IN ${LIVE} ORDER BY id DESC LIMIT 1`, [userId, prizeId]))[0] || null;
}
async function notify(userId, ref, title, body) {
  try { await require("./inbox").addSafe(userId, { kind: "shop", ref, title, body, link: "/settings/subscriptions" }); } catch (e) { /* never blocks */ }
}
// Plex access depends on these: re-check the member's rows after every change
const touchPlex = (userId, prizeId) => {
  try {
    if (!(require("./mediaconf").get().invite_items || {})[prizeId]) return;
    require("./plexmembers").refreshUser(userId).catch(() => {});
  } catch (e) { /* not wired */ }
};

/** Subscribe: buy the first period like any purchase, then the row. -> {sub, purchase} */
async function start(user, prizeId, expectedCost) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!CONFIG.enabled) throw new Refuse(423, "Subscriptions are paused right now - buy a single period instead.");
  const days = (CONFIG.items[String(prizeId || "")] || {}).days;
  if (!days) throw new Refuse(400, "That item isn't sold as a subscription.");
  const it = await item(prizeId);
  if (!it || it.seller_id || it.status !== "active") throw new Refuse(404, "That item isn't in the shop any more.");
  const had = await liveFor(user.userId, it.prizeId);
  if (had) throw new Refuse(409, `You already subscribe to ${it.prize} - it renews on ${new Date(Number(had.paid_through)).toISOString().slice(0, 10)}.`);
  const shop = require("./shop");
  const r = await shop.purchasePrize({ userId: user.userId, username: user.username, prizeId: it.prizeId, source: "website", expectedCost });
  if (!r.success) return { ok: false, status: r.status, message: r.message, cost: r.cost };
  const t = clock();
  const ins = await runQuery(`INSERT INTO shop_subs (user_id, prize_id, title, price, days, status, paid_through, last_order_id, created, updated)
                              VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`, [user.userId, it.prizeId, it.prize, r.cost, days, t + days * DAY, r.order_id, t, t]);
  await runQuery("INSERT OR IGNORE INTO shop_sub_ledger (ref, sub_id, order_id, kind, amount, period_from, period_to, created) VALUES (?, ?, ?, 'start', ?, ?, ?, ?)",
                 [`sub:${ins.id}:start`, ins.id, r.order_id, r.cost, t, t + days * DAY, t]);
  try { await shop.event(r.order_id, "completed", "system", `🔁 Subscription started - renews every ${days} days until you cancel`); } catch (e) { /* log only */ }
  touchPlex(user.userId, it.prizeId);
  console.log(`[subs] ${user.username} subscribed to ${it.prize} (#${ins.id}, ${r.cost} PAT / ${days} d)`);
  return { ok: true, status: 200, sub_id: ins.id, order_id: r.order_id, cost: r.cost, balance: r.balance, paid_through: t + days * DAY,
           message: `Subscribed: ${it.prize} for ${fmt(r.cost)} PAT every ${days} days. Cancel any time.` };
}

/** Charge one due period of one subscription. -> "renewed" | "grace" | "lapsed" | "ended" | "dup" | "skip" */
async function renewOne(s, t = clock()) {
  if (!s || !["active", "grace"].includes(s.status)) return "skip";
  if (Number(s.paid_through) > t) return "skip";
  const u = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [s.user_id]))[0];
  // cancelled: the paid time is over -> ended (no charge)
  if (s.cancel_at_end || !u) {
    const c = await runQuery("UPDATE shop_subs SET status = 'ended', ended_at = ?, updated = ? WHERE id = ? AND status IN ('active','grace')", [t, t, s.id]);
    if (c.changes) { touchPlex(s.user_id, s.prize_id); if (u) await notify(s.user_id, `sub-ended:${s.id}`, `🔁 ${s.title} ended`, "Your cancelled subscription reached the end of its paid time. Subscribe again any time."); }
    return "ended";
  }
  const it = await item(s.prize_id);
  const price = it && it.status !== "removed" ? Number(it.cost) : 0;
  const graceEnd = Number(s.paid_through) + CONFIG.grace_days * DAY;
  const lapse = async (why) => {
    const c = await runQuery("UPDATE shop_subs SET status = 'lapsed', ended_at = ?, updated = ? WHERE id = ? AND status IN ('active','grace')", [t, t, s.id]);
    if (c.changes) {
      touchPlex(s.user_id, s.prize_id);
      await notify(s.user_id, `sub-lapsed:${s.id}:${s.paid_through}`, `🔁 ${s.title} ended - the renewal wasn't paid`, why);
      console.log(`[subs] #${s.id} ${s.title} lapsed (${u.username})`);
    }
    return "lapsed";
  };
  if (!(price > 0) || !subscribable(s.prize_id)) return lapse(`${s.title} isn't sold as a subscription any more, so it stopped renewing. Nothing more was charged.`);
  const ref = `sub:${s.id}:${s.paid_through}`;
  const next = Number(s.paid_through) + Number(s.days) * DAY;
  let order = null;
  try {
    order = await require("./shop").chargeRenewal({ userId: s.user_id, username: u.username, prizeId: s.prize_id, title: `${s.title} (renewal)`, price,
      note: `🔁 Subscription renewal: ${new Date(Number(s.paid_through)).toISOString().slice(0, 10)} → ${new Date(next).toISOString().slice(0, 10)}`,
      inTx: async (o) => {
        if ((await getQuery("SELECT 1 AS x FROM shop_sub_ledger WHERE ref = ?", [ref]))[0]) return "dup";
        const c = await runQuery(`UPDATE shop_subs SET status = 'active', paid_through = ?, grace_until = NULL, price = ?, renewals = renewals + 1, last_order_id = ?, notified = NULL, updated = ?
                                  WHERE id = ? AND paid_through = ? AND status IN ('active','grace') AND cancel_at_end = 0`, [next, price, o.order_id, t, s.id, s.paid_through]);
        if (!c.changes) return "dup";
        await runQuery("INSERT INTO shop_sub_ledger (ref, sub_id, order_id, kind, amount, period_from, period_to, created) VALUES (?, ?, ?, 'renew', ?, ?, ?, ?)",
                       [ref, s.id, o.order_id, price, s.paid_through, next, t]);
        return null;
      } });
  } catch (e) {
    if (!(e && e.refuse && e.status === 402)) { console.error(`[subs] renew #${s.id}:`, e.message); return "skip"; }
    // can't pay: grace, then lapse
    if (t >= graceEnd) return lapse(`It costs ${fmt(price)} PAT and your balance didn't cover it within the ${CONFIG.grace_days}-day grace. Subscribe again any time.`);
    const key = "grace:" + s.paid_through;
    if (s.notified !== key) {
      await runQuery("UPDATE shop_subs SET status = 'grace', grace_until = ?, notified = ?, updated = ? WHERE id = ?", [graceEnd, key, t, s.id]);
      await notify(s.user_id, `sub-grace:${s.id}:${s.paid_through}`, `🔁 ${s.title}: the renewal couldn't be paid`,
        `It costs ${fmt(price)} PAT. You keep it until ${new Date(graceEnd).toISOString().slice(0, 10)} - top up and it renews by itself (or press Pay now).`);
      touchPlex(s.user_id, s.prize_id);
    }
    return "grace";
  }
  if (!order) return "dup";
  touchPlex(s.user_id, s.prize_id);
  console.log(`[subs] #${s.id} ${s.title} renewed for ${u.username}: ${price} PAT (order ${order.order_id})`);
  return "renewed";
}

/** Every due subscription, once (hourly). */
let running = null;
function renewDue(t = clock()) {
  if (running) return running;
  running = (async () => {
    await init();
    const out = { renewed: 0, grace: 0, lapsed: 0, ended: 0 };
    for (const s of await getQuery(`SELECT * FROM shop_subs WHERE status IN ${LIVE} AND paid_through <= ? ORDER BY paid_through LIMIT 500`, [t])) {
      const r = await renewOne(s, t).catch((e) => { console.error(`[subs] #${s.id}:`, e.message); return "skip"; });
      if (out[r] != null) out[r]++;
    }
    if (out.renewed || out.grace || out.lapsed || out.ended) console.log("[subs] run:", JSON.stringify(out));
    return out;
  })().finally(() => { running = null; });
  return running;
}

async function mustOwn(user, id) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const s = await subRow(id);
  if (!s || s.user_id !== user.userId) throw new Refuse(404, "No such subscription.");
  return s;
}
async function cancel(user, id) {
  const s = await mustOwn(user, id);
  const t = clock();
  if (s.status === "grace") {                                   // unpaid: it simply ends now
    await runQuery("UPDATE shop_subs SET status = 'ended', cancel_at_end = 1, ended_at = ?, updated = ? WHERE id = ? AND status = 'grace'", [t, t, s.id]);
    touchPlex(s.user_id, s.prize_id);
    return { ok: true, ends: t };
  }
  if (s.status !== "active") throw new Refuse(409, "It isn't running.");
  await runQuery("UPDATE shop_subs SET cancel_at_end = 1, updated = ? WHERE id = ?", [t, s.id]);
  touchPlex(s.user_id, s.prize_id);
  return { ok: true, ends: Number(s.paid_through) };
}
async function resume(user, id) {
  const s = await mustOwn(user, id);
  if (s.status !== "active" || !s.cancel_at_end || Number(s.paid_through) <= clock()) throw new Refuse(409, "It can't be resumed - subscribe again instead.");
  await runQuery("UPDATE shop_subs SET cancel_at_end = 0, updated = ? WHERE id = ?", [clock(), s.id]);
  touchPlex(s.user_id, s.prize_id);
  return { ok: true };
}
async function payNow(user, id) {
  const s = await mustOwn(user, id);
  if (s.status !== "grace") throw new Refuse(409, "Nothing to pay right now.");
  const r = await renewOne(s);
  if (r !== "renewed") throw new Refuse(402, "Your balance still doesn't cover it.");
  return { ok: true };
}

/** The Plex subscription that gives this account access (plexmembers.js): {created, until, live} | null */
async function plexSub(userId, t = clock()) {
  await init();
  const items = Object.keys(require("./mediaconf").get().invite_items || {});
  if (!userId || !items.length) return null;
  const rows = await getQuery(`SELECT * FROM shop_subs WHERE user_id = ? AND prize_id IN (${items.map(() => "?").join(",")}) ORDER BY id DESC`, [userId, ...items]);
  let best = null;
  for (const s of rows) {
    const until = s.status === "grace" ? Number(s.grace_until) || Number(s.paid_through) : Number(s.paid_through);
    const live = ["active", "grace"].includes(s.status) && until > t;
    const v = { id: s.id, created: Number(s.created), until, live, status: s.status };
    if (!best || (v.live && !best.live) || (v.live === best.live && v.until > best.until)) best = v;
  }
  return best;
}

/** Everything for /settings/subscriptions. */
async function pageData(user) {
  await init();
  const t = clock();
  const subs = (await getQuery("SELECT * FROM shop_subs WHERE user_id = ? ORDER BY CASE WHEN status IN ('active','grace') THEN 0 ELSE 1 END, id DESC LIMIT 30", [user.userId]))
    .map((s) => ({ id: s.id, title: s.title, prize_id: s.prize_id, price: s.price, days: s.days, status: s.status, cancel_at_end: !!s.cancel_at_end,
                   paid_through: Number(s.paid_through), grace_until: s.grace_until ? Number(s.grace_until) : null, renewals: s.renewals, created: Number(s.created),
                   ended_at: s.ended_at ? Number(s.ended_at) : null }));
  // 📺 / 🎟️ premium renewals this account pays (premium.js keeps renewing them; prices + routing unchanged)
  const prem = [];
  try {
    const P = require("./premium");
    await P.init();
    const rooms = require("./rooms");
    const rows = await getQuery("SELECT * FROM premium_subs WHERE renewer_id = ? OR (tier = 'season_pass' AND target = ?)", [user.userId, user.userId]);
    for (const r of rows) {
      const st = P.statusOf(r, t);
      if (st === "none") continue;
      let label = r.tier === "season_pass" ? "🎟️ Season Pass" : "📺 Prime Time", pad = null;
      if (r.tier === "prime_time") { const R = await rooms.get(r.target).catch(() => null); pad = R ? (R.slug || R.id) : r.target; label += " · p/" + pad; }
      prem.push({ tier: r.tier, pad, label, status: st, comped: !!r.comped, renewing: r.renewer_id === user.userId, paid_through: Math.max(Number(r.paid_through) || 0, Number(r.stripe_through) || 0),
                  price: P.priceOf(r.tier), days: P.config().period_days });
    }
  } catch (e) { /* premium not wired */ }
  // what can be subscribed to (the shop's subscribable items)
  const offers = [];
  for (const [pid, v] of Object.entries(CONFIG.items)) {
    const it = await item(pid);
    if (it && !it.seller_id && it.status === "active") offers.push({ prize_id: pid, title: it.prize, price: it.cost, days: v.days, in_stock: it.quantity > 0 });
  }
  return { subs, premium: prem, offers, grace_days: CONFIG.grace_days, enabled: CONFIG.enabled };
}

// ── routes ──
let timer = null;
function register(app, { addUser, noTimers } = {}) {
  init().catch((e) => console.error("[subs] init:", e.message));
  if (!noTimers && !timer) {
    const run = () => renewDue().catch((e) => console.error("[subs] renew:", e.message));
    setTimeout(run, 90 * 1000).unref();
    timer = setInterval(run, 60 * 60 * 1000);
    timer.unref();
  }
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, success: false, error: e.message, message: e.message });
    console.error("[subs]", e);
    res.status(500).json({ ok: false, success: false, error: "Something went wrong - nothing was charged.", message: "Something went wrong - nothing was charged." });
  };
  const write = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  app.get("/settings/subscriptions", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/subscriptions"));
    try {
      const data = await pageData(req.user);
      let plex = null;
      try { plex = await require("./plexmembers").mine(req.user.userId); } catch (e) { plex = null; }
      const MC = require("./mediaconf");
      const invites = [];
      for (const [pid, v] of Object.entries(MC.get().invite_items || {})) {
        const it = await item(pid);
        if (it && it.status === "active") invites.push({ prize_id: pid, title: it.prize, price: it.cost, days: v.days, sub: subscribable(pid) });
      }
      invites.sort((a, b) => (a.days || 1e9) - (b.days || 1e9));
      const bal = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0];
      res.render("subscriptions", { user: req.user.username, title: (req.t ? req.t("subs.title") : "Subscriptions"), data, plex, invites,
        selflink: !!MC.get().plex_selflink, balance: bal ? bal.points_balance : 0, pin: req.query.plex ? String(req.query.plex).slice(0, 20) : null,
        libraryOpen: !!MC.get().library_plex && MC.on.library(), price: MC.get().library_price });
    } catch (e) { console.error("[subs] page:", e); res.status(500).send("Couldn't load your subscriptions."); }
  });
  app.post("/api/subscriptions/start", addUser, write, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await start(req.user, b.product, b.price);
      const { status, ...body } = r;
      res.status(status || 200).json({ success: !!r.ok, ...body });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/subscriptions/:id/cancel", addUser, write, async (req, res) => { try { res.json(await cancel(req.user, req.params.id)); } catch (e) { fail(res, e); } });
  app.post("/api/subscriptions/:id/resume", addUser, write, async (req, res) => { try { res.json(await resume(req.user, req.params.id)); } catch (e) { fail(res, e); } });
  app.post("/api/subscriptions/:id/pay", addUser, write, async (req, res) => { try { res.json(await payNow(req.user, req.params.id)); } catch (e) { fail(res, e); } });
  // 📺 / 🎟️: switch auto-renew from the same page (premium.js decides who may)
  app.post("/api/subscriptions/premium", addUser, write, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await require("./premium").setRenew(req.user, { tier: b.tier, pad: b.pad, on: b.on === true });
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });
  // staff: the config (shop admin → Subscriptions)
  app.post("/shop/admin/subscriptions", addUser, async (req, res) => {
    const isStaff = req.user && (req.user.class === "Admin" || req.user.class === "Staff");
    if (!isStaff) return res.redirect("/login");
    if (!guard.sameSite(req)) return res.status(403).send("cross-site request refused");
    try {
      const b = req.body || {};
      await setConfig({ enabled: b.enabled === "1" || b.enabled === "on", grace_days: b.grace_days, items: b.items }, req.user.username);
      res.redirect("/shop/admin?msg=" + encodeURIComponent("Subscription settings saved.") + "#subscriptions");
    } catch (e) { res.redirect("/shop/admin?msg=" + encodeURIComponent(e.refuse ? e.message : "Couldn't save that.") + "#subscriptions"); }
  });
}

module.exports = { init, register, start, renewOne, renewDue, cancel, resume, payNow, plexSub, pageData, config, setConfig, subscribable, clean, Refuse, DEFAULTS, PLEX_MONTH,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); } };
