// stripebilling.js — real-money payments for Prime Time / Season Pass through Stripe Checkout + Billing (1.99ix).
// WIRED UP BUT SWITCHED OFF AND HIDDEN: while STRIPE_ENABLED isn't "1"/"true"/"on" (or a key is missing) every route
// here answers 404 and no page shows a money option (publicState() = {enabled: false}).
//
// Env (never in the repo - .env.example lists them with placeholders):
//   STRIPE_ENABLED              "1" turns it on (default off)
//   STRIPE_SECRET_KEY           sk_test_... (test mode) or sk_live_...
//   STRIPE_WEBHOOK_SECRET       whsec_... (the endpoint's signing secret)
//   STRIPE_PRICE_PRIME_TIME     price_... a recurring monthly Price for Prime Time
//   STRIPE_PRICE_SEASON_PASS    price_... a recurring monthly Price for Season Pass
//
// Flow: POST /api/premium/stripe/checkout {tier, pad?} -> a Checkout Session (mode "subscription", the tier + target +
// user in the session's and the subscription's metadata) -> {url}; the browser goes to Stripe. Stripe then calls
// POST /api/premium/stripe/webhook (raw body; the Stripe-Signature header is verified: HMAC-SHA256 of "<t>.<body>"
// with the webhook secret, 5-minute tolerance, constant-time compare). Each event id is recorded in stripe_events in
// the SAME transaction as its effect, so a retried / duplicated event changes nothing:
//   checkout.session.completed      links the Stripe subscription + customer to the premium_subs row
//   invoice.paid / payment_succeeded  stripe_through = the invoice line's period end (never moves backwards) +
//                                   a premium_ledger row "stripe:<invoice id>" (no PAT moves - real money)
//   invoice.payment_failed          an inbox notice (Stripe retries; the grace period covers it)
//   customer.subscription.deleted   unlinks it (the paid period still runs to its end, then the usual lapse)
// Entitlements are the same rows PAT pays for (premium.js): a pad / account is on while paid_through OR
// stripe_through is ahead. POST /api/premium/stripe/portal opens Stripe's billing portal (cancel / change card).
//
// TEST MODE (later): put sk_test_ / whsec_ from the Stripe dashboard's test mode in the env, create two test Prices,
// set STRIPE_ENABLED=1 on STAGING only, point a test-mode webhook endpoint at
// https://staging.publicaccess.tv/api/premium/stripe/webhook (or `stripe listen --forward-to localhost:3100/...`),
// and pay with Stripe's test card 4242 4242 4242 4242 (any future date, any CVC). The page labels test mode.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const API = "https://api.stripe.com/v1";
const TOLERANCE_S = 300;
let fetchImpl = (...a) => fetch(...a);
let clock = () => Date.now();
const env = (k) => String(process.env[k] || "").trim();
const isOn = (v) => ["1", "true", "on", "yes"].includes(String(v || "").toLowerCase());

function enabled() { return isOn(env("STRIPE_ENABLED")) && !!env("STRIPE_SECRET_KEY") && !!env("STRIPE_WEBHOOK_SECRET"); }
const testMode = () => env("STRIPE_SECRET_KEY").startsWith("sk_test_");
const PRICE_ENV = Object.freeze({ prime_time: "STRIPE_PRICE_PRIME_TIME", season_pass: "STRIPE_PRICE_SEASON_PASS" });
const priceId = (tier) => (PRICE_ENV[tier] ? env(PRICE_ENV[tier]) : "");
/** What pages may know. Off: just {enabled:false} - nothing about money is shown. */
function publicState() {
  if (!enabled()) return { enabled: false };
  return { enabled: true, test: testMode(), tiers: { prime_time: !!priceId("prime_time"), season_pass: !!priceId("season_pass") } };
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./premium").init();
      await runQuery(`CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, created INTEGER NOT NULL,
        received INTEGER NOT NULL, outcome TEXT)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── signatures ──
/** The v1 signature Stripe sends for this payload at time t (seconds). */
function sign(payload, secret, t) {
  return crypto.createHmac("sha256", secret).update(`${t}.${payload}`, "utf8").digest("hex");
}
/** Verify a Stripe-Signature header for the raw body; -> the parsed event, or throws {status 400}. */
function verify(raw, header, secret, nowMs = clock()) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!secret) throw bad("no webhook secret");
  const body = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw == null ? "" : raw);
  let t = null;
  const sigs = [];
  for (const part of String(header || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") sigs.push(v);
  }
  if (!Number.isFinite(t) || !sigs.length) throw bad("bad signature header");
  if (Math.abs(nowMs / 1000 - t) > TOLERANCE_S) throw bad("signature too old");
  const want = Buffer.from(sign(body, secret, t), "hex");
  const ok = sigs.some((s) => { const got = Buffer.from(s, "hex"); return got.length === want.length && crypto.timingSafeEqual(got, want); });
  if (!ok) throw bad("signature mismatch");
  try { return JSON.parse(body); } catch (e) { throw bad("bad json"); }
}

// ── Stripe API (form-encoded) ──
function form(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out.join("&");
}
async function api(path, params) {
  const r = await fetchImpl(API + path, { method: "POST", headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"),
    "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" }, body: form(params) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((j.error && j.error.message) || "Stripe error"), { status: 502 });
  return j;
}
const site = () => process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");

/** A Checkout Session for `tier` (the viewer's own Season Pass, or Prime Time for a pad they run). -> {url, id} */
async function checkout(user, { tier, pad } = {}) {
  const P = require("./premium");
  await init();
  if (!user || !user.userId) throw new P.Refuse(401, "Sign in first.");
  const T = P.TIERS[String(tier || "")];
  if (!T) throw new P.Refuse(400, "Pick Prime Time or Season Pass.");
  const price = priceId(T.id);
  if (!price) throw new P.Refuse(423, `${T.name} can't be paid by card yet.`);
  let target = user.userId, back = "/premium";
  if (T.kind === "pad") {
    const R = await P.padTarget(pad);
    if (!R) throw new P.Refuse(404, "No such pad.");
    if (!(await require("./rooms").canManage(user, R.id))) throw new P.Refuse(403, "Card subscriptions for a pad are for its owner.");
    target = R.id; back = "/premium?pad=" + encodeURIComponent(R.slug || R.id);
  }
  const sub = await P.subRow(T.id, target);
  if (sub && sub.comped) throw new P.Refuse(409, `That already has ${T.name} for free.`);
  if (sub && sub.stripe_sub) throw new P.Refuse(409, `There's already a card subscription for that - manage it from /premium.`);
  const meta = { tier: T.id, target, user_id: user.userId };
  const s = await api("/checkout/sessions", {
    mode: "subscription", client_reference_id: user.userId,
    line_items: { 0: { price, quantity: 1 } },
    metadata: meta, subscription_data: { metadata: meta },
    success_url: site() + back + (back.includes("?") ? "&" : "?") + "stripe=success",
    cancel_url: site() + back + (back.includes("?") ? "&" : "?") + "stripe=cancel",
  });
  return { url: s.url, id: s.id };
}
/** Stripe's billing portal for the customer behind one of the viewer's card subscriptions. -> {url} */
async function portal(user, { tier, pad } = {}) {
  const P = require("./premium");
  await init();
  if (!user || !user.userId) throw new P.Refuse(401, "Sign in first.");
  const T = P.TIERS[String(tier || "")];
  if (!T) throw new P.Refuse(400, "Pick Prime Time or Season Pass.");
  let target = user.userId;
  if (T.kind === "pad") { const R = await P.padTarget(pad); if (!R) throw new P.Refuse(404, "No such pad."); target = R.id; }
  const sub = await P.subRow(T.id, target);
  if (!sub || !sub.stripe_customer || sub.stripe_user !== user.userId) throw new P.Refuse(404, "No card subscription of yours there.");
  const s = await api("/billing_portal/sessions", { customer: sub.stripe_customer, return_url: site() + "/premium" });
  return { url: s.url };
}

// ── events ──
const tx = (fn) => require("./boosts").tx(fn);
function invoiceSub(inv) {
  return inv.subscription || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.subscription) || null;
}
function invoiceMeta(inv) {
  const a = (inv.subscription_details && inv.subscription_details.metadata) || (inv.parent && inv.parent.subscription_details && inv.parent.subscription_details.metadata);
  if (a && a.tier) return a;
  const line = inv.lines && Array.isArray(inv.lines.data) ? inv.lines.data.find((l) => l && l.metadata && l.metadata.tier) : null;
  return line ? line.metadata : {};
}
function invoicePeriodEnd(inv) {
  const lines = inv.lines && Array.isArray(inv.lines.data) ? inv.lines.data : [];
  let end = 0;
  for (const l of lines) if (l && l.period && Number(l.period.end) > end) end = Number(l.period.end);
  return end ? end * 1000 : 0;
}
/** Apply one verified event, exactly once. -> {dup, outcome} */
async function handleEvent(ev) {
  const P = require("./premium");
  await init();
  if (!ev || typeof ev.id !== "string" || typeof ev.type !== "string") throw Object.assign(new Error("bad event"), { status: 400 });
  const t = clock();
  const obj = (ev.data && ev.data.object) || {};
  let notice = null;
  const out = await tx(async () => {
    const ins = await runQuery("INSERT OR IGNORE INTO stripe_events (id, type, created, received) VALUES (?, ?, ?, ?)",
                               [ev.id, ev.type, Number(ev.created) || 0, t]);
    if (!ins.changes) return { dup: true, outcome: "dup" };
    let outcome = "ignored";
    if (ev.type === "checkout.session.completed" && obj.mode === "subscription") {
      const m = obj.metadata || {};
      if (P.TIERS[m.tier] && m.target) {
        const sub = await P.ensureSub(m.tier, String(m.target), t);
        await runQuery("UPDATE premium_subs SET stripe_sub = ?, stripe_customer = ?, stripe_user = ?, updated = ? WHERE id = ?",
                       [obj.subscription || null, obj.customer || null, m.user_id || obj.client_reference_id || null, t, sub.id]);
        await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, via, created)
                        VALUES (?, ?, ?, ?, 'stripe_checkout', ?, 0, 0, 'stripe', ?)`, ["stripe:" + obj.id, sub.id, m.tier, String(m.target), m.user_id || null, t]);
        outcome = "linked";
      } else outcome = "no-metadata";
    } else if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") {
      const sid = invoiceSub(obj);
      const m = invoiceMeta(obj);
      let sub = sid ? (await getQuery("SELECT * FROM premium_subs WHERE stripe_sub = ?", [sid]))[0] : null;
      if (!sub && P.TIERS[m.tier] && m.target) {
        sub = await P.ensureSub(m.tier, String(m.target), t);
        await runQuery("UPDATE premium_subs SET stripe_sub = ?, stripe_customer = COALESCE(stripe_customer, ?), stripe_user = COALESCE(stripe_user, ?) WHERE id = ?",
                       [sid, obj.customer || null, m.user_id || null, sub.id]);
      }
      const end = invoicePeriodEnd(obj);
      if (sub && end) {
        const through = Math.max(Number(sub.stripe_through) || 0, end);
        const had = await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, period_from, period_to, routing, via, created)
                                    VALUES (?, ?, ?, ?, 'stripe', ?, 0, ?, ?, ?, ?, 'stripe', ?)`,
          ["stripe:" + obj.id, sub.id, sub.tier, sub.target, sub.stripe_user || m.user_id || null, Math.max(0, (end - Math.max(t, Number(sub.stripe_through) || 0)) / P.DAY),
           Number(sub.stripe_through) || null, through, JSON.stringify({ currency: obj.currency || null, amount_paid: obj.amount_paid || 0 }), t]);
        await runQuery("UPDATE premium_subs SET stripe_through = ?, status = 'active', notified = NULL, updated = ? WHERE id = ?", [through, t, sub.id]);
        outcome = had.changes ? "extended" : "already";
      } else outcome = sub ? "no-period" : "unknown-subscription";
    } else if (ev.type === "invoice.payment_failed") {
      const sid = invoiceSub(obj);
      const sub = sid ? (await getQuery("SELECT * FROM premium_subs WHERE stripe_sub = ?", [sid]))[0] : null;
      if (sub && sub.stripe_user) notice = { userId: sub.stripe_user, tier: sub.tier, ref: "stripe-fail-" + obj.id };
      outcome = "failed-noted";
    } else if (ev.type === "customer.subscription.deleted" ||
               (ev.type === "customer.subscription.updated" && ["canceled", "unpaid", "incomplete_expired"].includes(obj.status))) {
      const r = await runQuery("UPDATE premium_subs SET stripe_sub = NULL, updated = ? WHERE stripe_sub = ?", [t, obj.id]);
      outcome = r.changes ? "unlinked" : "unknown-subscription";
    }
    await runQuery("UPDATE stripe_events SET outcome = ? WHERE id = ?", [outcome, ev.id]);
    return { dup: false, outcome };
  });
  if (!out.dup) {
    await P.loadCache();
    const m = (obj && obj.metadata) || invoiceMeta(obj || {});
    if (m && m.tier) await P.afterChange(m.tier, String(m.target || ""));
  }
  if (notice) {
    const T = P.TIERS[notice.tier];
    try {
      await require("./inbox").addSafe(notice.userId, { kind: "cosmetics", ref: notice.ref, title: `${T ? T.emoji + " " + T.name : "Subscription"}: the card payment failed`,
        body: "Stripe will try again over the next few days. Update the card from /premium (Manage card subscription).", link: "/premium" });
    } catch (e) { /* notice only */ }
  }
  return out;
}

// ── routes ──
function register(app, { addUser }) {
  const express = require("express");
  const off = (req, res, next) => (enabled() ? next() : next("route"));     // off: fall through to the 404 page
  app.post("/api/premium/stripe/webhook", off, express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
    let ev;
    try { ev = verify(req.body, req.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET")); } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    try { const r = await handleEvent(ev); res.json({ received: true, outcome: r.outcome }); } catch (e) {
      console.error("[stripe] webhook:", e.message);
      res.status(e.status || 500).json({ ok: false });                    // Stripe retries a 5xx
    }
  });
  const guard = require("./middleware/authGuard");
  const json = (fn) => async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await fn(req.user, req.body || {})) }); } catch (e) {
      const x = require("./premium").errBody(e);
      res.status(x.status).json(x.body);
    }
  };
  app.post("/api/premium/stripe/checkout", off, addUser, json((u, b) => checkout(u, { tier: b.tier, pad: b.pad })));
  app.post("/api/premium/stripe/portal", off, addUser, json((u, b) => portal(u, { tier: b.tier, pad: b.pad })));
}

module.exports = {
  init, register, enabled, testMode, publicState, priceId, verify, sign, handleEvent, checkout, portal, form,
  _setFetch: (fn) => { fetchImpl = fn || ((...a) => fetch(...a)); },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
