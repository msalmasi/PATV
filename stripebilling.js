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
//   STRIPE_PRICE_PRIME_PLUS     price_... a recurring monthly Price for Prime Time Plus (1.99th; $100/month)
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
//
// 1.99th 💎 Prime Time Plus by card (the pad tier capped at ptplus_max_rooms pads):
//   * checkout reserves a spot first (premium_plus_holds, inside the cap's transaction): sold out -> refused BEFORE Stripe.
//     The hold lasts as long as the Checkout Session can be paid (expires_at = now + 31 min, Stripe's minimum is 30), is
//     kept after checkout.session.completed until invoice.paid counts the pad, and checkout.session.expired drops it.
//     A pad's earlier unpaid checkout is expired at Stripe before a new one opens (never two Plus subscriptions per pad).
//   * invoice.paid for a NEW Plus pad while every spot is taken anyway (a race the holds missed) is HONOURED - a paying
//     customer is never refused - logged "[stripe] PLUS OVER CAP" and every admin gets an inbox alert.
//   * a card Prime Time upgrades in place (POST /api/premium/stripe/upgrade): the same subscription switches to the Plus
//     price, proration_behavior always_invoice (the difference for the rest of the period is charged now) with
//     payment_behavior pending_if_incomplete (nothing changes unless that payment succeeds); the mapping moves from the
//     pad's Prime Time row to its Plus row right away, or on customer.subscription.updated when the payment was pending.
// 1.99tk: never charge for time already paid. A card checkout on a row with PAT time (or a timed comp) left starts with
//   subscription_data.trial_end = where that time ends (at least 48 h ahead - Stripe's minimum), so the first charge lands
//   then; Plus also counts the pad's PAT Prime Time at the upgrade rate (convert_pt: that Prime Time ends once paid).
//   The other way round, PAT buys / chip-ins are refused while a card subscription is linked (premium.buy) - cancel the
//   card first (its paid time stays) and PAT adds on after it. A comp on a card-paid row defers / pauses the card (compCard).
//   Webhook events to send: checkout.session.completed, checkout.session.expired, invoice.paid, invoice.payment_failed,
//   customer.subscription.updated, customer.subscription.deleted.
// Entitlements are the same rows PAT pays for (premium.js): a pad / account is on while paid_through OR
// stripe_through is ahead. POST /api/premium/stripe/portal opens Stripe's billing portal (cancel / change card).
//
// 1.99jw "Support PATV" donations (Economy v3 - the ONLY way the site creates PAT): POST /api/premium/stripe/donate
// {usd} (whole dollars, 1..1000) -> a Checkout Session in mode "payment" (price_data, product "Support PATV", metadata
// {kind:"donation", userId}). Its checkout.session.completed (payment_status "paid") credits the donor in ONE transaction
// with the stripe_events row: pat = floor(amount_total cents * rate / 100), bonus = floor(pat * bonus_pct / 100) (rate /
// bonus_pct = Pepe's monetary.donation, defaults 500,000 / 20), a "donation" transactions row "don-<event id>", and a
// "mint:donation" reserve_claims row (claimId "don-<event id>", meta {bonus, usd_cents, rate, bonus_pct, event}) - Pepe
// journals the mint (policy "donation") and mints `bonus` into the incentive budget. Donated PAT is purchased PAT: there
// is no cash-out, and there must stay none. A replayed event changes nothing (stripe_events + the fixed ids).
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
const PRICE_ENV = Object.freeze({ prime_time: "STRIPE_PRICE_PRIME_TIME", season_pass: "STRIPE_PRICE_SEASON_PASS",
                                  prime_plus: "STRIPE_PRICE_PRIME_PLUS" });                       // 1.99th
const priceId = (tier) => (PRICE_ENV[tier] ? env(PRICE_ENV[tier]) : "");
/** What pages may know. Off: just {enabled:false} - nothing about money is shown. */
function publicState() {
  if (!enabled()) return { enabled: false };
  return { enabled: true, test: testMode(), tiers: { prime_time: !!priceId("prime_time"), season_pass: !!priceId("season_pass"), prime_plus: !!priceId("prime_plus") } };
}
// 1.99th: a card checkout for 💎 Prime Time Plus holds one of the ptplus_max_rooms spots (premium_plus_holds) for as long as
// its Checkout Session can be paid: the session gets expires_at = now + SESSION_S (Stripe's minimum is 30 minutes), the hold
// lives HOLD_MS (a little longer, for clock skew). Paid: kept until the first invoice counts the pad as Plus, then dropped.
const SESSION_S = 31 * 60;
const HOLD_MS = 33 * 60 * 1000;
const PAID_HOLD_MS = 24 * 3600 * 1000;      // checkout.session.completed -> the spot stays held until invoice.paid lands

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./premium").init();
      await runQuery(`CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, created INTEGER NOT NULL,
        received INTEGER NOT NULL, outcome TEXT)`);
      await require("./funding").init();          // 1.99jw: reserve_claims (+ meta) for the donation mint claims
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
async function api(path, params, method = "POST") {
  const get = method === "GET";
  const r = await fetchImpl(API + path, { method, headers: { Authorization: "Bearer " + env("STRIPE_SECRET_KEY"),
    "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" }, body: get ? undefined : form(params || {}) });
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
  if (!T) throw new P.Refuse(400, "Pick Prime Time, Prime Time Plus or Season Pass.");
  const price = priceId(T.id);
  if (!price) throw new P.Refuse(423, `${T.name} can't be paid by card yet.`);
  let target = user.userId, back = "/premium";
  if (T.kind === "pad") {
    const R = await P.padOrRefuse(pad, user);
    if (!(await require("./rooms").canManage(user, R.id))) throw new P.Refuse(403, "Card subscriptions for a pad are for its owner.");
    target = R.id; back = "/premium?pad=" + encodeURIComponent(R.slug || R.id) + (T.id === "prime_plus" ? "#plus" : "");
  }
  const sub = await P.subRow(T.id, target);
  const t = clock();
  if (sub && sub.comped && !P.compUntil(sub)) throw new P.Refuse(409, `That already has ${T.name} for free.`);
  if (sub && sub.stripe_sub) throw new P.Refuse(409, `There's already a card subscription for that - manage it from /premium.`);
  // 1.99tk: time already paid in PAT (or comped) is never charged again: the subscription starts with a trial that ends
  // where that time ends, so the first card charge lands then. Plus also counts the pad's PAT Prime Time, converted at
  // the upgrade rate (that Prime Time ends when the checkout is paid - convert_pt).
  const own = P.coveredUntil(sub, t);
  const covered = T.id === "prime_plus" ? await P.plusCardCover(target, t) : own;
  const start = P.cardStart(covered, t);
  // 1.99th: Plus includes Prime Time - never two card subscriptions for one pad
  if (T.id === "prime_time" && P.isPrimePlus(target)) throw new P.Refuse(409, "This pad has 💎 Prime Time Plus, which includes Prime Time.");
  let hold = null;
  if (T.id === "prime_plus") {
    const pt = await P.subRow("prime_time", target);
    if (pt && pt.stripe_sub) throw new P.Refuse(409, "This pad already pays for Prime Time by card - upgrade that subscription to Plus instead.");
    hold = await reservePlus(target, user.userId);                // refuses "sold out" BEFORE anyone is sent to Stripe
  }
  const meta = { tier: T.id, target, user_id: user.userId };
  if (hold) meta.hold = hold.id;
  if (T.id === "prime_plus" && start && !own) meta.convert_pt = "1";
  const q = back.includes("?") ? "&" : "?";
  const ret = (r) => { const i = back.indexOf("#"); return i < 0 ? site() + back + q + "stripe=" + r : site() + back.slice(0, i) + q + "stripe=" + r + back.slice(i); };
  let s;
  try {
    if (hold) await expireOld(hold.old);                         // the same pad's earlier, unpaid checkout: closed first
    s = await api("/checkout/sessions", {
      mode: "subscription", client_reference_id: user.userId,
      line_items: { 0: { price, quantity: 1 } },
      metadata: meta, subscription_data: { metadata: meta, trial_end: start ? Math.floor(start.first / 1000) : undefined },
      expires_at: hold ? Math.floor(clock() / 1000) + SESSION_S : undefined,
      success_url: ret("success"),
      cancel_url: ret("cancel"),
    });
  } catch (e) {
    if (hold) await releaseHold(hold.id);
    throw e;
  }
  if (hold) { await runQuery("UPDATE premium_plus_holds SET session = ? WHERE id = ?", [s.id || null, hold.id]); await P.loadCache(); }
  return { url: s.url, id: s.id, covered_until: start ? start.covered : null, first_charge: start ? start.first : null };
}

/** 1.99tk: a comp on a pad / account that also has a running card subscription - comped time counts as paid:
 *  - a timed comp past the card's paid date: trial_end = the comp's end (no proration), so the next charge lands then;
 *  - a comp with no end: collection paused (pause_collection void) while it lasts;
 *  - the comp revoked: collection resumed, next charge at the card's paid date (at least 48 h ahead, Stripe's minimum).
 *  sub = the row BEFORE the change. -> {ok, action} */
async function compCard(sub, on, until) {
  const P = require("./premium");
  if (!enabled() || !sub || !sub.stripe_sub) return { ok: true, action: "none" };
  const t = clock();
  const sid = encodeURIComponent(sub.stripe_sub);
  const paid = Number(sub.stripe_through) || 0;
  if (on && until) {
    if (!(until > paid)) return { ok: true, action: "none" };       // the card already covers past the comp
    await api("/subscriptions/" + sid, { trial_end: Math.floor(Math.max(until, t + P.CARD_MIN_DEFER_MS) / 1000), proration_behavior: "none" });
    return { ok: true, action: "deferred" };
  }
  if (on) { await api("/subscriptions/" + sid, { pause_collection: { behavior: "void" } }); return { ok: true, action: "paused" }; }
  const next = Math.max(paid, t + P.CARD_MIN_DEFER_MS);
  await api("/subscriptions/" + sid, { pause_collection: "", trial_end: Math.floor(next / 1000), proration_behavior: "none" });
  // the comp's cover is gone: the card's time runs to its next charge (nothing charged twice, at most 2 days free)
  await runQuery("UPDATE premium_subs SET stripe_through = MAX(stripe_through, ?), updated = ? WHERE id = ?", [next, t, sub.id]);
  await P.loadCache();
  return { ok: true, action: "resumed" };
}

// ── 1.99th: the Plus spot holds ──
/** Inside one transaction: the cap check (sold out -> Refuse 409) + a hold on a spot for `target`. The same pad's earlier
 *  holds are replaced (-> old: their Checkout Session ids, to expire at Stripe). -> {id, old} */
async function reservePlus(target, userId, ms = HOLD_MS) {
  const P = require("./premium");
  const t = clock();
  const out = await tx(async () => {
    await runQuery("DELETE FROM premium_plus_holds WHERE expires <= ?", [t]);
    await P.plusCapCheck(target, t);
    const old = (await getQuery("SELECT session FROM premium_plus_holds WHERE target = ? AND session LIKE 'cs_%'", [target])).map((r) => r.session);
    await runQuery("DELETE FROM premium_plus_holds WHERE target = ?", [target]);
    const id = "hold_" + crypto.randomBytes(9).toString("hex");
    await runQuery("INSERT INTO premium_plus_holds (id, target, user_id, created, expires) VALUES (?, ?, ?, ?, ?)", [id, target, userId || null, t, t + ms]);
    return { id, old };
  });
  await P.loadCache();
  return out;
}
async function releaseHold(id) {
  try { await runQuery("DELETE FROM premium_plus_holds WHERE id = ?", [id]); await require("./premium").loadCache(); } catch (e) { console.error("[stripe] hold:", e.message); }
}
/** Close the earlier Checkout Sessions of a pad (so one pad can't end up with two paid Plus subscriptions). One that
 *  can't be closed any more was probably just paid: refuse rather than open a second. */
async function expireOld(ids) {
  const P = require("./premium");
  for (const id of ids || []) {
    try { await api("/checkout/sessions/" + encodeURIComponent(id) + "/expire", {}); } catch (e) {
      let st = null;
      try { st = (await api("/checkout/sessions/" + encodeURIComponent(id), null, "GET")).status; } catch (x) { st = null; }
      if (st === "expired") continue;                            // already closed: fine
      throw new P.Refuse(409, "A card checkout for this pad is still going through - give it a few minutes, then reload /premium.");
    }
  }
}

/** 1.99th: upgrade the pad's card Prime Time subscription to 💎 Plus - the same Stripe subscription switches to the Plus
 *  price with proration (the difference for the rest of this period is invoiced now; payment_behavior
 *  pending_if_incomplete: nothing changes unless that payment goes through). Takes a Plus spot (sold out -> refused). */
async function upgrade(user, { pad } = {}) {
  const P = require("./premium");
  await init();
  if (!user || !user.userId) throw new P.Refuse(401, "Sign in first.");
  const price = priceId("prime_plus");
  if (!price) throw new P.Refuse(423, "Prime Time Plus can't be paid by card yet.");
  const R = await P.padOrRefuse(pad, user);
  if (!(await require("./rooms").canManage(user, R.id))) throw new P.Refuse(403, "Card subscriptions for a pad are for its owner.");
  const pt = await P.subRow("prime_time", R.id);
  if (!pt || !pt.stripe_sub || pt.stripe_user !== user.userId) throw new P.Refuse(404, "No card Prime Time subscription of yours on this pad.");
  const pp = await P.subRow("prime_plus", R.id);
  if (pp && pp.comped) throw new P.Refuse(409, "This pad already has Prime Time Plus for free.");
  if (pp && pp.stripe_sub) throw new P.Refuse(409, "This pad already has a card Prime Time Plus subscription.");
  const hold = await reservePlus(R.id, user.userId, PAID_HOLD_MS);
  await runQuery("UPDATE premium_plus_holds SET session = ? WHERE id = ?", ["upd:" + pt.stripe_sub, hold.id]);
  let s;
  try {
    const cur = await api("/subscriptions/" + encodeURIComponent(pt.stripe_sub), null, "GET");
    const item = cur.items && Array.isArray(cur.items.data) && cur.items.data[0];
    if (!item || !item.id) throw new P.Refuse(502, "Stripe didn't return the subscription's item - try again.");
    s = await api("/subscriptions/" + encodeURIComponent(pt.stripe_sub), {
      items: { 0: { id: item.id, price } }, proration_behavior: "always_invoice", payment_behavior: "pending_if_incomplete",
    });
  } catch (e) { await releaseHold(hold.id); throw e; }
  if (s && s.pending_update) return { pending: true };          // waits on the proration payment: customer.subscription.updated finishes it
  const r = await applyUpgrade(pt.stripe_sub, clock(), { userId: user.userId });
  await tagPlus(pt.stripe_sub, R.id, user.userId);
  return { pending: false, upgraded: !!r.moved };
}
/** Point the subscription's metadata at Plus (renewal invoices then name the right tier). Best effort. */
async function tagPlus(sid, target, userId) {
  try { await api("/subscriptions/" + encodeURIComponent(sid), { metadata: { tier: "prime_plus", target, user_id: userId || "" } }); } catch (e) { console.error("[stripe] upgrade metadata:", e.message); }
}
/** Move a card subscription's mapping from the pad's Prime Time row to its Plus row (idempotent; inside or outside a
 *  transaction - `inTx` skips the wrapper). The Plus row is paid through the same date; Prime Time ends now (no lapse
 *  notice). -> {moved, overCap, target} */
async function applyUpgrade(sid, t, { inTx = false } = {}) {
  const P = require("./premium");
  const run = async () => {
    const pt = (await getQuery("SELECT * FROM premium_subs WHERE stripe_sub = ? AND tier = 'prime_time'", [sid]))[0];
    if (!pt) return { moved: false };
    const pp = await P.ensureSub("prime_plus", pt.target, t);
    const overCap = !(t < P.endsAt(pp, t)) && (await P.plusUsed(pt.target, t)).size >= P.config().ptplus_max_rooms;
    const through = Math.max(Number(pp.stripe_through) || 0, Number(pt.stripe_through) || 0);
    await runQuery("UPDATE premium_subs SET stripe_sub = ?, stripe_customer = ?, stripe_user = ?, stripe_through = ?, status = 'active', notified = NULL, updated = ? WHERE id = ?",
                   [sid, pt.stripe_customer, pt.stripe_user, through, t, pp.id]);
    const ptEnd = Math.min(Number(pt.stripe_through) || 0, t);
    await runQuery("UPDATE premium_subs SET stripe_sub = NULL, stripe_through = ?, notified = ?, updated = ? WHERE id = ?",
                   [ptEnd, "lapsed:" + Math.max(Number(pt.paid_through) || 0, ptEnd), t, pt.id]);
    const left = Math.max(0, ((Number(pt.stripe_through) || 0) - t) / P.DAY);
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, period_from, period_to, via, created)
                    VALUES (?, ?, 'prime_time', ?, 'upgrade-out', ?, 0, ?, ?, ?, 'stripe', ?)`, [`stripe-up:${sid}:${t}:out`, pt.id, pt.target, pt.stripe_user, -left, t, pt.stripe_through, t]);
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, period_from, period_to, via, created)
                    VALUES (?, ?, 'prime_plus', ?, 'upgrade-in', ?, 0, ?, ?, ?, 'stripe', ?)`, [`stripe-up:${sid}:${t}:in`, pp.id, pt.target, pt.stripe_user, left, t, through, t]);
    await runQuery("DELETE FROM premium_plus_holds WHERE target = ?", [pt.target]);
    return { moved: true, overCap, target: pt.target };
  };
  const r = inTx ? await run() : await tx(run);
  if (!inTx) {
    await P.loadCache();
    if (r.moved) { await P.afterChange("prime_plus", r.target); if (r.overCap) await overCapAlert(r.target, "upgrade " + sid); }
  }
  return r;
}
/** A paid Plus subscription landed while every spot was taken (a race the holds didn't cover): it's honoured - the
 *  admins are told so they can sort the rooms out. */
async function overCapAlert(target, what) {
  const P = require("./premium");
  const max = P.config().ptplus_max_rooms;
  console.error(`[stripe] PLUS OVER CAP: ${what} made pad ${target} Prime Time Plus while all ${max} spots were taken - honoured (paid by card)`);
  try {
    let label = target;
    try { const R = await require("./rooms").get(target); if (R) label = "p/" + (R.slug || R.id); } catch (e) { /* the id will do */ }
    for (const a of await getQuery("SELECT userId FROM users WHERE class = 'Admin'")) {
      await require("./inbox").addSafe(a.userId, { kind: "admin", ref: `plus-overcap:${target}:${what}`.slice(0, 120), link: "/premium?pad=" + encodeURIComponent(target) + "#plus",
        title: `💎 Prime Time Plus is over its ${max}-pad cap`,
        body: `${label} paid for Plus by card (${what}) after every spot was taken. It's honoured - Pepe can only be in ${max} Camfrog rooms, so free a spot (or raise ptplus_max_rooms if he can take one more).` });
    }
  } catch (e) { console.error("[stripe] over-cap alert:", e.message); }
}
const DONATE_MAX_USD = 1000;
/** 1.99jw: a one-off "Support PATV" Checkout Session (mode payment). -> {url, id} */
async function donate(user, { usd, back } = {}) {
  const P = require("./premium");
  await init();
  if (!user || !user.userId) throw new P.Refuse(401, "Sign in first.");
  const n = Number(usd);
  if (!Number.isInteger(n) || n < 1 || n > DONATE_MAX_USD) throw new P.Refuse(400, `Pick a whole number of dollars from 1 to ${DONATE_MAX_USD}.`);
  const page = back === "/shop" ? "/shop" : back === "/support" ? "/support" : "/wallet";   // 1.99mn: /support shows its own thank-you
  const s = await api("/checkout/sessions", {
    mode: "payment", client_reference_id: user.userId,
    line_items: { 0: { quantity: 1, price_data: { currency: "usd", unit_amount: n * 100, product_data: { name: "Support PATV" } } } },
    metadata: { kind: "donation", userId: user.userId },
    success_url: site() + page + "?donate=success",
    cancel_url: site() + page + "?donate=cancel",
  });
  return { url: s.url, id: s.id };
}

/** 1.99jw: what the Support PATV card (views/partials/donate-card.ejs) needs; enabled:false hides it. */
function donateLocals(back, result) {
  const st = publicState();
  // 1.99ks: crypto = the stablecoin donations (cryptopay.js) are on - the card links to /support, independent of Stripe
  let crypto = false;
  try { crypto = require("./cryptopay").enabled(); } catch (e) { crypto = false; }
  if (!st.enabled) return { stripe: st, crypto, back };
  const terms = require("./funding").donationTerms();
  return { stripe: st, crypto, back, result: result === "success" || result === "cancel" ? result : null, rate: terms.rate, bonus_pct: terms.bonus_pct, max: DONATE_MAX_USD };
}

/** Stripe's billing portal for the customer behind one of the viewer's card subscriptions. -> {url} */
async function portal(user, { tier, pad } = {}) {
  const P = require("./premium");
  await init();
  if (!user || !user.userId) throw new P.Refuse(401, "Sign in first.");
  const T = P.TIERS[String(tier || "")];
  if (!T) throw new P.Refuse(400, "Pick Prime Time or Season Pass.");
  let target = user.userId;
  if (T.kind === "pad") { target = (await P.padOrRefuse(pad, user)).id; }
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
/** 1.99th: the Price ids on a subscription object */
function subPrices(sub) {
  const items = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
  return items.map((i) => (i && i.price ? (typeof i.price === "string" ? i.price : i.price.id) : null)).filter(Boolean);
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
  let donation = null;
  let overCap = null, upgraded = null;         // 1.99th
  const out = await tx(async () => {
    const ins = await runQuery("INSERT OR IGNORE INTO stripe_events (id, type, created, received) VALUES (?, ?, ?, ?)",
                               [ev.id, ev.type, Number(ev.created) || 0, t]);
    if (!ins.changes) return { dup: true, outcome: "dup" };
    let outcome = "ignored";
    const dm = obj.metadata || {};
    if (ev.type === "checkout.session.completed" && dm.kind === "donation") {
      // 1.99jw: a "Support PATV" donation - the PAT credit + its mint claim, with this event's row, or nothing
      if (obj.payment_status !== "paid") outcome = "donation-unpaid";
      else {
        const ledger = require("./ledger");
        const target = await ledger.resolveUserId(dm.userId || obj.client_reference_id);
        const cents = Math.floor(Number(obj.amount_total) || 0);
        if (!target) { outcome = "donation-no-user"; console.error(`[stripe] donation ${ev.id}: account ${dm.userId} not found - not credited`); }
        else if (cents <= 0) outcome = "donation-zero";
        else {
          const terms = require("./funding").donationTerms();
          const pat = Math.floor((cents * terms.rate) / 100);
          const bonus = Math.floor((pat * terms.bonus_pct) / 100);
          const id = "don-" + ev.id;
          await ledger.postOrThrow(target, pat, "donation", { transactionId: id, source: "stripe donation" });
          await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES (?, 'mint:donation', ?, 'donation', ?, ?)",
                         [id, target, pat, JSON.stringify({ bonus, usd_cents: cents, rate: terms.rate, bonus_pct: terms.bonus_pct, event: ev.id })]);
          donation = { userId: target, pat, cents, ref: "donation-" + ev.id };
          console.log(`[stripe] donation ${ev.id}: $${(cents / 100).toFixed(2)} -> ${pat} PAT for ${target} (+${bonus} to the incentive budget)`);
          outcome = "donation-credited";
        }
      }
    } else if (ev.type === "checkout.session.completed" && obj.mode === "subscription") {
      const m = obj.metadata || {};
      if (P.TIERS[m.tier] && m.target) {
        const sub = await P.ensureSub(m.tier, String(m.target), t);
        await runQuery("UPDATE premium_subs SET stripe_sub = ?, stripe_customer = ?, stripe_user = ?, updated = ? WHERE id = ?",
                       [obj.subscription || null, obj.customer || null, m.user_id || obj.client_reference_id || null, t, sub.id]);
        await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, via, created)
                        VALUES (?, ?, ?, ?, 'stripe_checkout', ?, 0, 0, 'stripe', ?)`, ["stripe:" + obj.id, sub.id, m.tier, String(m.target), m.user_id || null, t]);
        // 1.99th: paid - the Plus spot stays held until the first invoice makes the pad count as Plus
        if (m.hold) await runQuery("UPDATE premium_plus_holds SET expires = MAX(expires, ?), session = ? WHERE id = ?", [t + PAID_HOLD_MS, obj.id || null, String(m.hold)]);
        // 1.99tk: the pad's PAT Prime Time became the Plus trial (cardStart) - it ends now, like a PAT upgrade (no lapse notice)
        if (m.convert_pt === "1" && m.tier === "prime_plus") {
          const up = await P.upgradeCredit(String(m.target), t);
          if (up) {
            await runQuery("UPDATE premium_subs SET paid_through = ?, renewer_id = NULL, notified = ?, updated = ? WHERE id = ?", [t, "lapsed:" + t, t, up.sub.id]);
            await runQuery("UPDATE premium_subs SET stripe_through = MAX(stripe_through, ?), status = 'active', updated = ? WHERE id = ?", [t + up.plusMs, t, sub.id]);   // no gap before the trial invoice
            await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, period_from, period_to, via, created)
                            VALUES (?, ?, 'prime_time', ?, 'upgrade-out', ?, 0, ?, ?, ?, 'stripe', ?)`,
                           ["stripe-conv:" + obj.id + ":out", up.sub.id, String(m.target), m.user_id || null, -(up.leftMs / P.DAY), t, up.sub.paid_through, t]);
            await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, period_from, period_to, via, created)
                            VALUES (?, ?, 'prime_plus', ?, 'upgrade-in', ?, 0, ?, ?, ?, 'stripe', ?)`,
                           ["stripe-conv:" + obj.id + ":in", sub.id, String(m.target), m.user_id || null, up.plusMs / P.DAY, t, t + up.plusMs, t]);
          }
        }
        outcome = "linked";
      } else outcome = "no-metadata";
    } else if (ev.type === "checkout.session.expired") {
      // 1.99th: an unpaid Plus checkout timed out (or was closed): its spot is free again
      const r = await runQuery("DELETE FROM premium_plus_holds WHERE id = ? OR session = ?", [String(dm.hold || ""), String(obj.id || "")]);
      outcome = r.changes ? "hold-released" : "ignored";
    } else if (ev.type === "customer.subscription.updated" && ["active", "trialing", "past_due"].includes(obj.status) && !obj.pending_update &&
               priceId("prime_plus") && subPrices(obj).includes(priceId("prime_plus")) &&
               (await getQuery("SELECT 1 FROM premium_subs WHERE stripe_sub = ? AND tier = 'prime_time'", [obj.id]))[0]) {
      // 1.99th: a card Prime Time switched to the Plus price (our upgrade, once its proration payment went through)
      const r = await applyUpgrade(obj.id, t, { inTx: true });
      if (r.moved) { upgraded = r; outcome = r.overCap ? "upgraded-over-cap" : "upgraded"; }
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
        // 1.99th: a NEW Plus pad while every spot is taken (a race): the customer paid, so it's honoured - and the admins hear
        if (sub.tier === "prime_plus" && !(t < P.endsAt(sub, t)) && (await P.plusUsed(sub.target, t)).size >= P.config().ptplus_max_rooms) {
          overCap = { target: sub.target, what: "invoice " + obj.id };
        }
        if (sub.tier === "prime_plus") await runQuery("DELETE FROM premium_plus_holds WHERE target = ?", [sub.target]);
        const through = Math.max(Number(sub.stripe_through) || 0, end);
        const had = await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, amount, days, period_from, period_to, routing, via, created)
                                    VALUES (?, ?, ?, ?, 'stripe', ?, 0, ?, ?, ?, ?, 'stripe', ?)`,
          ["stripe:" + obj.id, sub.id, sub.tier, sub.target, sub.stripe_user || m.user_id || null, Math.max(0, (end - Math.max(t, Number(sub.stripe_through) || 0)) / P.DAY),
           Number(sub.stripe_through) || null, through, JSON.stringify({ currency: obj.currency || null, amount_paid: obj.amount_paid || 0 }), t]);
        await runQuery("UPDATE premium_subs SET stripe_through = ?, status = 'active', notified = NULL, updated = ? WHERE id = ?", [through, t, sub.id]);
        outcome = had.changes ? (overCap ? "extended-over-cap" : "extended") : "already";
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
    if (upgraded) {
      await P.afterChange("prime_plus", upgraded.target);
      if (upgraded.overCap) overCap = { target: upgraded.target, what: "upgrade " + obj.id };
      await tagPlus(obj.id, upgraded.target, (obj.metadata && obj.metadata.user_id) || "");
    }
    if (overCap) await overCapAlert(overCap.target, overCap.what);
  }
  if (donation && !out.dup) {
    try { require("./supporter").onDonation(donation.userId).catch(() => {}); } catch (e) { /* never blocks */ }   // 1.99mv: 💚 Supporter perks + achievements
    try {
      const i18n = require("./i18n");
      await i18n.ensure();
      const t = i18n.tFor(i18n.getPref(donation.userId) || "en");
      await require("./inbox").addSafe(donation.userId, { kind: "system", ref: donation.ref, link: "/wallet",
        title: t("donate.notice_title"),
        body: t("donate.notice_body", { usd: (donation.cents / 100).toFixed(2), pat: t.num ? t.num(donation.pat) : donation.pat.toLocaleString("en-US") }) });
    } catch (e) { /* notice only */ }
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
  app.post("/api/premium/stripe/upgrade", off, addUser, json((u, b) => upgrade(u, { pad: b.pad })));                 // 1.99th
  app.post("/api/premium/stripe/donate", off, addUser, json((u, b) => donate(u, { usd: b.usd, back: b.back })));   // 1.99jw
}

module.exports = {
  init, register, enabled, testMode, publicState, priceId, verify, sign, handleEvent, checkout, portal, donate, donateLocals, form, DONATE_MAX_USD,
  upgrade, applyUpgrade, reservePlus, compCard, SESSION_S, HOLD_MS,
  _setFetch: (fn) => { fetchImpl = fn || ((...a) => fetch(...a)); },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
