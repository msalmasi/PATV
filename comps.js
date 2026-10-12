// comps.js — 1.99ma: admin COMPS - free access an admin gives a member: 📼 Plex access (a trial or lifetime), 📺 Prime Time
// (a pad) / 🎟️ Season Pass (a member) for N days, N periods or with no end date, and any PATV-fulfilled store item
// (roles, the spin boost, Plex items - shop.compPrize), 🎨 cosmetics and 🧸 sticker packs. Page: /admin/comps (also
// /admin/premium); shortcuts from /admin/media (Plex members), a member's profile (⋯ menu) and a pad's page.
//
// MONEY: a comp costs nobody PAT and creates no money movement - no ledger debit, no routing claim, no store-owner credit,
// no House rake, no stock used (economy v3: comps are not issuance). Every comp, extension and revoke is an admin_audit
// row (action comp_plex / comp_premium / comp_item / comp_cosmetic / comp_sticker / comp_extend / comp_revoke) with the
// admin's reason. The member gets a localized "🎁 You've been gifted …" inbox notice (Telegram per their alert settings).
//
// 📼 PLEX (plex_comps): exactly like bought access, without the purchase -
//   * not on our server yet  -> a one-time Wizarr invite on a zero-price comp order (shop.compOrder + mediainvites.forComp):
//     the order note + 🔔 + Pepe's DM carry the link; Wizarr down / not set up -> the manual invite queue (/admin/media).
//   * already on our server  -> no invite: plexmembers re-classifies the row as access "comp-trial" / "comp-lifetime".
//   A TRIAL is N days (default comps_settings.plex_trial_days = 7) from now, or from the end of the access they already
//   have (extends it). When it ends it's like monthly access running out: the sync lists the share for removal on
//   /admin/media and an admin clicks Remove (plex_auto_revoke stays OFF). Revoke = the comp ends now (same path).
//   Comped members get every member perk the same way paid ones do (free plays, 📼 flair + perk cosmetics, achievements),
//   because those all read plexmembers' active rows.
//
// 📺/🎟️ PREMIUM: premium.setComp with comp_until (premium.js 1.99ma). A timed comp starts now, or after the time already
// paid / comped; lifetime = no end date. Free, not routed, never auto-renewed, revocable; the hourly premium job ends it.
//   plex_comps   id, user_id, kind (trial|lifetime), days, starts, until, created, by_id, by_name, reason, order_id,
//                delivery (invite|extended), revoked_at, revoked_by, revoke_reason
//   comps_settings  key/value (plex_trial_days)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 24 * 3600 * 1000;
const DEFAULTS = { plex_trial_days: 7 };
let clock = () => Date.now();
let S = { ...DEFAULTS };

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}
const iso = (t) => (t ? new Date(Number(t)).toISOString().slice(0, 10) : "");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS plex_comps (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, days INTEGER, starts INTEGER NOT NULL, until INTEGER,
        created INTEGER NOT NULL, by_id TEXT, by_name TEXT, reason TEXT, order_id INTEGER, delivery TEXT,
        revoked_at INTEGER, revoked_by TEXT, revoke_reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS plex_comps_user ON plex_comps (user_id)");
      await runQuery("CREATE TABLE IF NOT EXISTS comps_settings (key TEXT PRIMARY KEY, value TEXT)");
      for (const r of await getQuery("SELECT key, value FROM comps_settings")) {
        if (r.key in DEFAULTS) { try { S[r.key] = JSON.parse(r.value); } catch (e) { /* default */ } }
      }
      S.plex_trial_days = clampDays(S.plex_trial_days, DEFAULTS.plex_trial_days);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
function clampDays(v, d) { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : d; }
async function setSettings(patch, admin) {
  await init();
  const next = { ...S };
  if (patch && patch.plex_trial_days != null) next.plex_trial_days = clampDays(patch.plex_trial_days, S.plex_trial_days);
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO comps_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(next[k])]);
  }
  if (next.plex_trial_days !== S.plex_trial_days) await audit(admin, "comps_settings", null, { plex_trial_days: { from: S.plex_trial_days, to: next.plex_trial_days } }, "settings");
  S = next;
  return { ...S };
}

// ── helpers ──
async function audit(admin, action, target, detail, reason) {
  await require("./adminaudit").record(admin, action, target, detail, reason);
}
function needReason(r) {
  const s = String(r || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  if (s.length < 3) throw new Refuse(400, "Give a reason (it goes in the admin log).");
  return s;
}
async function member(name) {
  try { return await require("./gifts").recipient(name); } catch (e) { throw new Refuse(e.status || 404, e.message); }
}
const T = (userId) => require("./gifts").tFor(userId);
async function notice(userId, { kind = "system", ref, title, body, link }) {
  try { await require("./inbox").addSafe(userId, { kind, ref, title, body, link }); } catch (e) { /* never blocks */ }
}

// ── 📼 Plex ──
async function plexRow(id) { return (await getQuery("SELECT * FROM plex_comps WHERE id = ?", [Number(id) || 0]))[0] || null; }
async function onServer(userId) {
  try { return (await getQuery("SELECT plex_id FROM plex_members WHERE user_id = ? AND on_server = 1 LIMIT 1", [userId])).length > 0; } catch (e) { return false; }
}
async function plexRefresh(userId) {
  try { await require("./plexmembers").refreshUser(userId); } catch (e) { /* the next sync does it */ }
}
/** Comp Plex access. opts = {user, kind: trial|lifetime, days, reason}. admin = {userId, username}. */
async function compPlex(admin, opts = {}) {
  await init();
  const reason = needReason(opts.reason);
  const kind = opts.kind === "lifetime" ? "lifetime" : "trial";
  const u = await member(opts.user);
  const PM = require("./plexmembers");
  await PM.init();
  const t = clock();
  const pa = await PM.patvAccess(u.userId, t);
  if (pa.active && pa.expires == null) throw new Refuse(409, `${u.username} already has lifetime Plex access (${pa.type}).`);
  const days = kind === "trial" ? clampDays(opts.days, S.plex_trial_days) : null;
  const starts = kind === "trial" && pa.active && pa.expires ? Math.max(t, Number(pa.expires)) : t;
  const until = kind === "trial" ? starts + days * DAY : null;
  const there = await onServer(u.userId);
  const ins = await runQuery(`INSERT INTO plex_comps (user_id, kind, days, starts, until, created, by_id, by_name, reason, delivery)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                             [u.userId, kind, days, starts, until, t, admin.userId, admin.username, reason, there ? "extended" : "invite"]);
  const id = ins.id;
  const what = kind === "lifetime" ? "lifetime Plex access" : `${days} days of Plex access`;
  let orderId = null, invite = null;
  if (!there) {
    const o = await require("./shop").compOrder({ admin, to: u, title: `📼 Plex access: ${kind === "lifetime" ? "lifetime" : `${days}-day trial`} (comp)`, reason,
                                                  note: `🎁 Comped by ${admin.username} — ${what}, no charge` });
    orderId = o.order_id;
    await runQuery("UPDATE plex_comps SET order_id = ? WHERE id = ?", [orderId, id]);
    invite = await require("./mediainvites").forComp({ orderId, userId: u.userId, username: u.username, title: `Plex access (${what})`, days: days || 0 });
  }
  await plexRefresh(u.userId);
  await audit(admin, "comp_plex", u, { id, kind, days, starts, until, delivery: there ? "extended" : "invite", order_id: orderId,
                                       invite: invite ? (invite.ok ? "created" : "queued") : null }, reason);
  const tr = T(u.userId);
  const item = kind === "lifetime" ? tr("comps.item.plex_lifetime") : tr("comps.item.plex_trial", { days });
  await notice(u.userId, { kind: "media", ref: `comp-plex:${id}`, title: tr("comps.notice.gift_title", { item }),
    body: (kind === "lifetime" ? tr("comps.notice.plex_lifetime_body") : tr("comps.notice.plex_trial_body", { date: iso(until) })) + " " +
          (there ? tr("comps.notice.plex_on_server") : tr("comps.notice.plex_invite")),
    link: orderId ? `/shop/orders/${orderId}` : "/subscriptions" });
  return { ok: true, id, user: u.username, kind, days, starts, until, delivery: there ? "extended" : "invite", order_id: orderId, invite };
}
/** Add days to a live trial (from its end, or from now if it already ended). */
async function extendPlex(admin, id, days, reason) {
  await init();
  reason = needReason(reason);
  const c = await plexRow(id);
  if (!c) throw new Refuse(404, "No such Plex comp.");
  if (c.revoked_at) throw new Refuse(409, "That comp was revoked - make a new one.");
  if (c.kind === "lifetime") throw new Refuse(409, "A lifetime comp has no end to extend.");
  const d = clampDays(days, S.plex_trial_days);
  const from = Math.max(clock(), Number(c.until) || 0);
  const until = from + d * DAY;
  await runQuery("UPDATE plex_comps SET until = ?, days = COALESCE(days, 0) + ? WHERE id = ?", [until, d, c.id]);
  await plexRefresh(c.user_id);
  const u = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [c.user_id]))[0] || { userId: c.user_id };
  await audit(admin, "comp_extend", u, { what: "plex", id: c.id, days: d, from: c.until, to: until }, reason);
  const tr = T(c.user_id);
  await notice(c.user_id, { kind: "media", ref: `comp-plex-ext:${c.id}:${until}`, title: tr("comps.notice.gift_title", { item: tr("comps.item.plex_trial", { days: d }) }),
    body: tr("comps.notice.plex_trial_body", { date: iso(until) }), link: "/subscriptions" });
  return { ok: true, id: c.id, until };
}
/** End a Plex comp now: plexmembers then lists the share for removal (admin-confirmed) unless they have other access. */
async function revokePlex(admin, id, reason) {
  await init();
  reason = needReason(reason);
  const c = await plexRow(id);
  if (!c) throw new Refuse(404, "No such Plex comp.");
  if (c.revoked_at) return { ok: true, already: true };
  await runQuery("UPDATE plex_comps SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?", [clock(), admin.username, reason, c.id]);
  // an invite that never went out: take it off the manual queue
  if (c.order_id) await runQuery("UPDATE media_invites SET status = 'cancelled', updated = ?, next_try = NULL WHERE order_id = ? AND status IN ('pending','manual')", [clock(), c.order_id]).catch(() => {});
  await plexRefresh(c.user_id);
  const u = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [c.user_id]))[0] || { userId: c.user_id };
  await audit(admin, "comp_revoke", u, { what: "plex", id: c.id, kind: c.kind, until: c.until }, reason);
  return { ok: true, id: c.id };
}

// ── 📺 Prime Time / 🎟️ Season Pass ──
async function premiumTarget(tier, opts) {
  const P = require("./premium");
  await P.init();
  const TT = P.TIERS[String(tier || "")];
  if (!TT) throw new Refuse(400, "Pick Prime Time or Season Pass.");
  if (TT.kind === "pad") {
    const R = await P.padOrRefuse(opts.pad || opts.target);   // 1.99od: slug / p/slug / link / room id / title, "did you mean" on a miss
    return { P, TT, target: R.id, label: `p/${R.slug || R.id}`, who: R.owner && R.owner.userId ? { userId: R.owner.userId, username: R.owner.username } : null, R };
  }
  let u = null;
  if (opts.target && !opts.user) u = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(opts.target)]))[0] || null;
  if (!u) u = await member(opts.user);
  return { P, TT, target: u.userId, label: `u/${u.username}`, who: u };
}
/** opts = {tier, user | pad, mode: days|periods|lifetime, n, reason} */
async function compPremium(admin, opts = {}) {
  await init();
  const reason = needReason(opts.reason);
  const { P, TT, target, label, who } = await premiumTarget(opts.tier, opts);
  const mode = ["days", "periods", "lifetime"].includes(opts.mode) ? opts.mode : "days";
  const t = clock();
  const sub = await P.subRow(TT.id, target);
  let until = null, days = null;
  if (mode !== "lifetime") {
    const n = Math.floor(Number(opts.n));
    if (!(n >= 1 && n <= (mode === "days" ? 3650 : 120))) throw new Refuse(400, mode === "days" ? "Between 1 and 3650 days." : "Between 1 and 120 periods.");
    days = mode === "days" ? n : n * P.config().period_days;
    const paid = sub ? Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0) : 0;
    const from = Math.max(t, paid, P.compUntil(sub));
    until = from + days * DAY;
  }
  try {
    const r = await P.setComp(TT.id, target, true, admin.username, reason, until ? { until } : { replace: true });
    if (!r.changed) throw new Refuse(409, `${label} already has ${TT.name} comped with no end date.`);
  } catch (e) { if (e && e.refuse) throw new Refuse(e.status || 400, e.message); throw e; }
  await audit(admin, "comp_premium", who, { tier: TT.id, target, label, mode, days, until }, reason);
  if (who) {
    const tr = T(who.userId);
    const item = `${TT.emoji} ${TT.name}${TT.kind === "pad" ? ` (${label})` : ""}`;
    await notice(who.userId, { kind: TT.kind === "pad" ? "room" : "cosmetics", ref: `comp-prem:${TT.id}:${target}:${t}`, title: tr("comps.notice.gift_title", { item }),
      body: until ? tr("comps.notice.premium_until_body", { tier: TT.name, date: iso(until) }) : tr("comps.notice.premium_noend_body", { tier: TT.name }), link: "/premium" });
  }
  return { ok: true, tier: TT.id, target, label, until, days };
}
async function extendPremium(admin, opts = {}) {
  await init();
  const reason = needReason(opts.reason);
  const { P, TT, target, label, who } = await premiumTarget(opts.tier, opts);
  const sub = await P.subRow(TT.id, target);
  if (!sub || !sub.comped) throw new Refuse(404, `${label} has no ${TT.name} comp.`);
  if (!P.compUntil(sub)) throw new Refuse(409, "That comp has no end date - nothing to extend.");
  const d = clampDays(opts.days, 0);
  if (!d) throw new Refuse(400, "How many days?");
  const until = Math.max(clock(), P.compUntil(sub)) + d * DAY;
  await P.setComp(TT.id, target, true, sub.comp_by || admin.username, sub.comp_note || reason, { until });
  await audit(admin, "comp_extend", who, { what: TT.id, target, label, days: d, from: sub.comp_until, to: until }, reason);
  if (who) {
    const tr = T(who.userId);
    await notice(who.userId, { kind: TT.kind === "pad" ? "room" : "cosmetics", ref: `comp-prem-ext:${TT.id}:${target}:${until}`,
      title: tr("comps.notice.gift_title", { item: `${TT.emoji} ${TT.name}` }), body: tr("comps.notice.premium_until_body", { tier: TT.name, date: iso(until) }), link: "/premium" });
  }
  return { ok: true, until };
}
async function revokePremium(admin, opts = {}) {
  await init();
  const reason = needReason(opts.reason);
  const { P, TT, target, label, who } = await premiumTarget(opts.tier, opts);
  const sub = await P.subRow(TT.id, target);
  if (!sub || !sub.comped) throw new Refuse(404, `${label} has no ${TT.name} comp.`);
  if (sub.comp_by === P.AUTO) throw new Refuse(409, "That's the automatic comp for a site admin - switch comp_admins off on the premium config instead.");
  await P.setComp(TT.id, target, false, admin.username);
  await audit(admin, "comp_revoke", who, { what: TT.id, target, label, until: sub.comp_until || null }, reason);
  return { ok: true };
}

// ── 🛍️ store items, 🎨 cosmetics, 🧸 sticker packs ──
/** opts = {user, kind: prize|cosmetic|sticker, id, reason} */
async function compItem(admin, opts = {}) {
  await init();
  const reason = needReason(opts.reason);
  const kind = String(opts.kind || "prize");
  if (kind === "prize") {
    try { return { ok: true, kind, ...(await require("./shop").compPrize({ admin, to: opts.user, prizeId: opts.id, reason })) }; }
    catch (e) { if (e && e.refuse) throw new Refuse(e.status || 400, e.message); throw e; }
  }
  const u = await member(opts.user);
  const tr = T(u.userId);
  if (kind === "cosmetic") {
    const C = require("./cosmetics");
    const it = C.byId(String(opts.id || ""));
    if (!it) throw new Refuse(404, "No such cosmetic.");
    if (C.isPerk(it)) throw new Refuse(400, "Perk cosmetics come with their membership - comp the membership instead.");
    const has = await getQuery("SELECT 1 FROM user_cosmetics WHERE user_id = ? AND item_id = ? LIMIT 1", [u.userId, it.id]);
    if (has.length) throw new Refuse(409, `${u.username} already has ${it.name}.`);
    const r = await C.grant(u.userId, it.id, "comp", `comp:${admin.username}:${u.userId}:${it.id}:${clock()}`);
    if (!r.ok) throw new Refuse(400, r.error || "Couldn't grant it.");
    try { C.invalidateNames(); } catch (e) { /* decoration */ }
    await audit(admin, "comp_cosmetic", u, { item: it.id, name: it.name, inv_id: r.inv_id }, reason);
    await notice(u.userId, { kind: "cosmetics", ref: `comp-cos:${r.inv_id}`, title: tr("comps.notice.gift_title", { item: it.name }), body: tr("comps.notice.gift_team_body", { item: it.name }), link: "/cosmetics?tab=mine#tabs" });
    return { ok: true, kind, item: it.name, inv_id: r.inv_id };
  }
  if (kind === "sticker") {
    const ST = require("./stickers");
    let r;
    try { r = await ST.grantComp(u.userId, opts.id, admin.username); } catch (e) { if (e && e.refuse) throw new Refuse(e.status || 400, e.message); throw e; }
    if (r.already) throw new Refuse(409, `${u.username} already has ${r.pack.name}.`);
    await audit(admin, "comp_sticker", u, { pack: r.pack.id, name: r.pack.name }, reason);
    await notice(u.userId, { kind: "cosmetics", ref: `comp-stk:${u.userId}:${r.pack.id}`, title: tr("comps.notice.gift_title", { item: r.pack.name }), body: tr("comps.notice.gift_team_body", { item: r.pack.name }), link: "/premium#stickers" });
    return { ok: true, kind, item: r.pack.name };
  }
  throw new Refuse(400, "Pick a store item, a cosmetic or a sticker pack.");
}

// ── the admin list ──
async function adminState(t = clock()) {
  await init();
  const plex = await getQuery(`SELECT c.*, u.username FROM plex_comps c LEFT JOIN users u ON u.userId = c.user_id ORDER BY c.id DESC LIMIT 300`);
  const P = require("./premium");
  await P.init();
  const prem = await getQuery("SELECT s.*, u.username AS user_name FROM premium_subs s LEFT JOIN users u ON u.userId = s.target WHERE s.comped = 1 ORDER BY s.tier, s.updated DESC");
  const rooms = require("./rooms");
  const premium = [];
  for (const s of prem) {
    let label = s.user_name ? `u/${s.user_name}` : s.target;
    if (P.TIERS[s.tier] && P.TIERS[s.tier].kind === "pad") {
      const R = await rooms.get(s.target).catch(() => null);
      label = R ? `p/${R.slug || R.id}` : s.target;
    }
    premium.push({ tier: s.tier, target: s.target, label, by: s.comp_by, note: s.comp_note, until: Number(s.comp_until) || null, auto: s.comp_by === P.AUTO,
                   ended: !!(Number(s.comp_until) && Number(s.comp_until) <= t) });
  }
  const recent = await getQuery(`SELECT id, at, admin_name, action, target_name, detail, reason FROM admin_audit WHERE action LIKE 'comp%' ORDER BY id DESC LIMIT 60`).catch(() => []);
  let items = [];
  try { items = await require("./shop").officialPolicies(); } catch (e) { items = []; }
  let cosmetics = [], stickers = [];
  try { cosmetics = require("./cosmetics").catalog().filter((i) => !i.perk).map((i) => ({ id: i.id, name: i.name, kind: i.kind })); } catch (e) { cosmetics = []; }
  try { stickers = require("./stickers").catalog().filter((p) => !p.perk).map((p) => ({ id: p.id, name: p.name })); } catch (e) { stickers = []; }   // 1.99qp: no perk packs (they come with their tier)
  // 1.99mt: the gift log - every member gift with its REAL giver (anonymous ones marked) for abuse handling
  let gifts = [];
  try { gifts = await require("./gifts").adminLog(150); } catch (e) { gifts = []; }
  return {
    settings: { ...S },
    plex: plex.map((c) => ({ ...c, active: !c.revoked_at && (c.kind === "lifetime" || Number(c.until) > t) })),
    premium, recent: recent.map((r) => { let d = null; try { d = r.detail ? JSON.parse(r.detail) : null; } catch (e) { d = null; } return { ...r, detail: d }; }),
    items, cosmetics, stickers, gifts,
  };
}

// ── routes ──
async function isAdminNow(req) {
  if (!req.user || !req.user.userId) return null;
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
  return u && u.class === "Admin" ? { userId: u.userId, username: u.username } : null;
}
function register(app, { addUser }) {
  init().catch((e) => console.error("[comps] init:", e.message));
  const guard = require("./middleware/authGuard");
  const api = (fn) => [addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const me = await isAdminNow(req);
      if (!me) return res.status(403).json({ ok: false, error: "Admins only." });
      if (req.method === "POST" && (!guard.sameSite(req) || !req.is("application/json"))) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
      res.json({ ok: true, ...(await fn(req.body || {}, me, req)) });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, ...(Array.isArray(e.suggestions) ? { pad_query: e.pad_query || "", suggestions: e.suggestions } : {}) });
      console.error("[comps]", req.path, e);
      res.status(500).json({ ok: false, error: "Something went wrong - nothing changed." });
    }
  }];
  app.get(["/admin/comps", "/admin/premium"], addUser, async (req, res) => {
    const me = await isAdminNow(req).catch(() => null);
    if (!me) { if (typeof req.flash === "function") req.flash("error", "Admins only."); return res.redirect("/login"); }
    if (req.path === "/admin/premium") return res.redirect(302, "/admin/comps" + (req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : ""));
    try {
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      res.render("admin/comps", { user: me.username, title: "Admin · Comps", section: "comps", isAdmin: true, errors: [], success: [],
        C: await adminState(), pre: { user: String(req.query.user || "").slice(0, 64), pad: String(req.query.pad || "").slice(0, 80), kind: String(req.query.kind || "").slice(0, 20) } });
    } catch (e) { console.error("[comps] page:", e); res.status(500).send("Couldn't load the comps."); }
  });
  app.get("/api/admin/comps", ...api(async () => adminState()));
  app.post("/api/admin/comps/plex", ...api(async (b, me) => ({ result: await compPlex(me, b), state: await adminState() })));
  app.post("/api/admin/comps/plex/extend", ...api(async (b, me) => ({ result: await extendPlex(me, b.id, b.days, b.reason), state: await adminState() })));
  app.post("/api/admin/comps/plex/revoke", ...api(async (b, me) => ({ result: await revokePlex(me, b.id, b.reason), state: await adminState() })));
  app.post("/api/admin/comps/premium", ...api(async (b, me) => ({ result: await compPremium(me, b), state: await adminState() })));
  app.post("/api/admin/comps/premium/extend", ...api(async (b, me) => ({ result: await extendPremium(me, b), state: await adminState() })));
  app.post("/api/admin/comps/premium/revoke", ...api(async (b, me) => ({ result: await revokePremium(me, b), state: await adminState() })));
  app.post("/api/admin/comps/item", ...api(async (b, me) => ({ result: await compItem(me, b), state: await adminState() })));
  app.post("/api/admin/comps/settings", ...api(async (b, me) => ({ settings: await setSettings(b, me), state: await adminState() })));
}

module.exports = { init, register, compPlex, extendPlex, revokePlex, compPremium, extendPremium, revokePremium, compItem, adminState, setSettings,
                   settings: () => ({ ...S }), Refuse, DEFAULTS, _setClock: (fn) => { clock = fn || (() => Date.now()); } };
