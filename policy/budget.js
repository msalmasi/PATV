// policy/budget.js — the weekly incentive budget as a site service (1.99aop).
//
// Pepe's week record (pepe_treasury._tr_week: who may still spend what of the incentive pool this week) becomes the site's once
// policy_ownership.budget = "site". Until then EVERYTHING here is dark: the routes refuse without recording, every hook in
// funding.js / pools.js / launchpad.js / gangs.js / policy/apply.js / policy/gather.js falls through to the old lines, and the
// only thing that runs is the read-only comparison in policy/budgetshadow.js.
//
//   incentive_weeks    eid PK, opened_at (s), share, release_per_day, armed_at, via, note. A week opens BY THE CLOCK at its first
//                      touch: no engine has to run for it. Budgets and pace are never frozen here: policy_cfg at use time.
//   incentive_spends   key PK (the caller's idempotency key), eid, grp (NULL: not counted against a group), flow, amount, vault,
//                      dest_kind, dest_ref, user_id, room, actor, status paid | refused, code, why, via, ts (ms), req_sha, result
//   incentive_settled  claim_id PK, seq (for the bot's mirror), eid, grp, amount, ts (ms), source - website claims settled here
//
// A week's spent per group = the paid rows + the settled claims of that week. A paid row and its pool move are one transaction.
//
// Bot routes (bot token, POST):
//   /api/policy/bot/spend          one keyed spend: budget check, the paying vault's debit, the destination, the row
//   /api/policy/bot/spend-status   what a key's answer was: paid | refused | unknown
//   /api/policy/bot/week           the week record, for Pepe's read-only mirror
// A recorded key always answers its recorded result first. "refused" is terminal for its key; every other refusal (not the owner,
// paused, cut-over freeze, pools not live) records nothing, so the same key may be sent again.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx, inTx } = require("../dbUtils");
const C = require("./core");
const E = require("./engines");
const S = require("./source");

const P = () => require("../pools");
const G = () => require("./gather");
const Shadow = () => require("./budgetshadow");

const INC = "incentives:";
const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,120}$/;
const TYPE_RE = /^[A-Za-z0-9_:.\-]{1,40}$/;
const USER_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const ROOM_RE = /^(?:user:)?[A-Za-z0-9_.\-]{1,80}$/;
const MAX_STATUS_KEYS = 100;
const SETTLED_PAGE = 500;
const OWNER_NOT_SITE = "the incentive budget is Pepe's";

// ── flows and groups (pepe_treasury GRANT_FLOWS, BOT_FLOWS, ACTIVITY_FLOWS, CLAIM_GROUPS, UNGROUPED_CLAIMS; checked by the vectors) ──
const GRANT_FLOWS = Object.freeze({ new_account: "welcome", levelup: "levelup", achievements: "achievements", connect_bonus: "misc",
                                    redeem_codes: "misc", platform_rewards: "misc", room_owner: "royalties" });
const BOT_FLOWS = Object.freeze({ raffle: "roomgames", mic_hourly: "roomgames", pictionary: "roomgames", beg: "roomgames",
                                  turf_income: "turf", turf_season: "season", store_heist: "roomgames" });
const ACTIVITY_FLOWS = Object.freeze({ activity_rewards: "activity" });
const CLAIM_GROUPS = Object.freeze({ launchpad_welcome: "launchpad" });
const UNGROUPED = new Set(["staff_grant"]);
// The one table of what POST /spend accepts. vault "route": the flow's PAT Routing row decides the paying vault (pepe_routes
// _fund_source); vault "incentives": the flow has no routing row, its legs always debit the incentive pool. A flow that isn't here
// is a bad request - never a payout without a weekly limit.
const SPEND_FLOWS = Object.freeze({
  beg:              { vault: "route", group: "roomgames", dests: ["user"] },
  pictionary:       { vault: "route", group: "roomgames", dests: ["user"] },
  raffle:           { vault: "route", group: "roomgames", dests: ["user"] },
  mic_hourly:       { vault: "route", group: "roomgames", dests: ["user"] },
  store_heist:      { vault: "route", group: "roomgames", dests: ["user"] },
  turf_income:      { vault: "route", group: "turf", dests: ["none"] },
  turf_season:      { vault: "route", group: "season", dests: ["none"] },
  activity_rewards: { vault: "incentives", group: "activity", dests: ["pad", "user"] },
  launchpad_grant:  { vault: "incentives", group: "launchpad", dests: ["launchpad"] },
  launchpad_match:  { vault: "incentives", group: "launchpad", dests: ["launchpad"] },
});
const VAULT_DESTS = ["jackpot", "reserve", "stakers", "heist", "fortknox", "incentives", "mm", "bank"];   // pepe_routes.VAULT_DESTS
const TREASURY_DESTS = ["mm", "bank"];
const INCENTIVE_PAYOUTS = new Set(["store_heist"]);                                                      // pepe_layers
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const groupOfSpend = (flow) => (hasOwn(SPEND_FLOWS, flow) ? SPEND_FLOWS[flow].group : null);
/** A website claim "incentives:<fl>": no group for staff grants, else its grant group, else misc (_tr_settle_claim_once). */
function groupOfClaim(fl) {
  if (UNGROUPED.has(fl)) return null;
  if (hasOwn(GRANT_FLOWS, fl)) return GRANT_FLOWS[fl];
  if (hasOwn(CLAIM_GROUPS, fl)) return CLAIM_GROUPS[fl];
  return "misc";
}
/** pepe_routes._fund_source for a flow whose spec says "route"; shares = its routing row ([[dest, pct], ...]). */
function resolveVault(flow, spec, shares, flags) {
  if (spec && spec.vault === "incentives") return "incentives";
  let d = Array.isArray(shares) && shares.length ? String(shares[0][0]) : "reserve";
  d = VAULT_DESTS.includes(d) && !TREASURY_DESTS.includes(d) ? d : "reserve";
  if (d === "reserve" && flags.layers && INCENTIVE_PAYOUTS.has(flow)) d = "incentives";
  if (hasOwn(GRANT_FLOWS, flow) && flags.tr_live) d = "incentives";
  return d;
}
const fedGuarded = (vault, flags) => vault === "reserve" && !!flags.layers;
/** pepe_monetary._mo_flash_need("house", amount). */
const houseGap = (amount, cash, floor) => Math.min(amount, Math.max(0, amount - Math.max(0, cash - floor)));
const flashHouseOn = (c, flags) => !!flags.layers && pyTruth(c.raw("flash_house"), true);
function pyTruth(v, dflt) { return v === undefined || v === null ? dflt : !!v; }

const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const clip = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));

class Bad extends Error {}
/** Not an answer about this key: nothing is recorded, the caller keeps it (offline: pools or settings can't be read). */
class NotReady extends Error { constructor(state, code, msg) { super(msg || state); this.state = state; this.code = code; } }
/** A terminal refusal raised inside the payment's savepoint. */
class Stop extends Error { constructor(code, msg, extra) { super(msg || code); this.code = code; this.extra = extra || {}; } }

// ── tables ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS incentive_weeks (eid TEXT PRIMARY KEY, opened_at REAL, share INTEGER, release_per_day INTEGER,
        armed_at REAL, via TEXT, note TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS incentive_spends (key TEXT PRIMARY KEY, eid TEXT NOT NULL, grp TEXT, flow TEXT NOT NULL, amount INTEGER NOT NULL,
        vault TEXT, dest_kind TEXT, dest_ref TEXT, user_id TEXT, room TEXT, actor TEXT, status TEXT NOT NULL, code TEXT, why TEXT, via TEXT, ts INTEGER NOT NULL,
        req_sha TEXT, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS incentive_spends_week ON incentive_spends (eid, grp, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS incentive_spends_user ON incentive_spends (user_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS incentive_settled (claim_id TEXT PRIMARY KEY, seq INTEGER, eid TEXT NOT NULL, grp TEXT, amount INTEGER NOT NULL,
        ts INTEGER NOT NULL, source TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS incentive_settled_week ON incentive_settled (eid, grp)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS incentive_settled_seq ON incentive_settled (seq)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── who owns the week ──
/** The budget feature's row, read as it stands (inside a transaction: that transaction's view). No row or no table = Pepe's. */
async function ownerRow() {
  try {
    const r = (await getQuery("SELECT owner, paused FROM policy_ownership WHERE feature = 'budget'"))[0];
    return r ? { owner: String(r.owner), paused: r.paused ? 1 : 0 } : { owner: "pepe", paused: 0 };
  } catch (e) { return { owner: "pepe", paused: 0 }; }
}
/** True only once the site owns the week. Every dormant hook starts with this; any read problem answers false (the old path). */
async function isSite() { return (await ownerRow()).owner === "site"; }

// ── the week ──
const WEEK_S = 7 * 86400;
async function configNow() {
  const { cfg, consts, flags } = await S.config();
  const c = E.C({ cfg, consts });
  return { cfg, consts, flags: flags || {}, c, hour: c.hour() };
}
async function mintsFor(c, nowS) {
  if (!c.raw("issuance_to_guarantee")) return [];                  // the only reader (engines.weekIssuance) answers 0 without them
  const g = G();
  return g.mints(await g.layersOf(await g.docs()), nowS);
}
async function spentOf(eid) {
  const out = {};
  for (const r of await getQuery("SELECT grp, COALESCE(SUM(amount),0) AS t FROM incentive_spends WHERE eid = ? AND status = 'paid' AND grp IS NOT NULL GROUP BY grp", [eid])) out[r.grp] = Number(r.t) || 0;
  for (const r of await getQuery("SELECT grp, COALESCE(SUM(amount),0) AS t FROM incentive_settled WHERE eid = ? AND grp IS NOT NULL GROUP BY grp", [eid])) out[r.grp] = (out[r.grp] || 0) + (Number(r.t) || 0);
  for (const g of Object.keys(out)) out[g] = Math.max(0, out[g]);
  return out;
}
/** Everything a budget decision reads at `nowS`: engines' `inp` (cfg, mints, the incentive balance, the week with the site's spent). */
async function weekCtx(nowS) {
  const k = await configNow();
  const eid = E.epochId(nowS, k.hour);
  const inp = { cfg: k.cfg, consts: k.consts, flags: k.flags, mints: await mintsFor(k.c, nowS), pools: { incentives: await P().balance("incentives") },
                week: { id: eid, budgets: {}, spent: await spentOf(eid), share: null, release_per_day: null } };
  return Object.assign(k, { eid, inp, nowS });
}
const leftOf = (ctx, g) => E.budgetLeft(ctx.inp, ctx.c, g, ctx.nowS);
async function openWeek(eid, nowS, via) {
  await runQuery("INSERT OR IGNORE INTO incentive_weeks (eid, opened_at, via) VALUES (?, ?, ?)", [eid, nowS, clip(via, 20)]);
}
/** The pure view of a week from engine inputs: what every reader and the vectors share. */
function weekOfInputs(inp, c, nowS) {
  const w = E.resolveWeek(inp, c, nowS);
  const remaining = {}, pace = {};
  for (const g of E.GROUPS) { remaining[g] = E.budgetLeft(inp, c, g, nowS); pace[g] = E.paceOf(c, g); }
  return { id: w.id, budgets: w.budgets, spent: Object.fromEntries(E.GROUPS.map((g) => [g, E.pyInt(w.spent[g] || 0)])), remaining, pace,
           uncapped: E.GROUPS.filter((g) => E.pyInt(w.budgets[g]) < 0).sort(), share: w.share === undefined ? null : w.share,
           release_per_day: w.release_per_day === undefined ? null : w.release_per_day };
}
/** What the funding sync's `incentives` block carries (pepe_treasury._tr_site_state), before funding.cleanIncentives. */
function blockOfInputs(inp, c, nowS) {
  const f = inp.flags || {};
  if (!f.tr_live && !f.layers) return null;
  const w = weekOfInputs(inp, c, nowS);
  return { balance: E.pyInt((inp.pools || {}).incentives), week: w.id, treasury: !!f.tr_live, remaining: w.remaining, budgets: w.budgets,
           groups: Object.assign({}, GRANT_FLOWS, CLAIM_GROUPS), uncapped: w.uncapped, spent: w.spent, share: w.share, release_per_day: w.release_per_day };
}
async function weekRow(eid) { return (await getQuery("SELECT * FROM incentive_weeks WHERE eid = ?", [eid]))[0] || null; }

/** The funding block once the site owns the week: the shape funding.cleanIncentives gives Pepe's. */
async function fundingBlock(nowS = C.nowS()) {
  await init();
  const ctx = await weekCtx(nowS);
  const row = await weekRow(ctx.eid);
  if (row) { ctx.inp.week.share = row.share; ctx.inp.week.release_per_day = row.release_per_day; }
  return require("../funding").cleanIncentives(blockOfInputs(ctx.inp, ctx.c, nowS));
}
/** The week as the engines read it (policy/gather.week) while the site owns it. */
async function weekForEngines(nowS = C.nowS()) {
  await init();
  const ctx = await weekCtx(nowS);
  const row = await weekRow(ctx.eid);
  const w = E.resolveWeek(ctx.inp, ctx.c, nowS);
  return { id: w.id, budgets: w.budgets, spent: w.spent, share: row ? row.share : null, release_per_day: row ? row.release_per_day : null };
}
/** In the epoch's transaction: this week's surplus share. */
async function setShareInTx(eid, share, releasePerDay) {
  await runQuery(`INSERT INTO incentive_weeks (eid, opened_at, share, release_per_day, via) VALUES (?, ?, ?, ?, 'epoch')
                  ON CONFLICT(eid) DO UPDATE SET share = excluded.share, release_per_day = excluded.release_per_day`,
                 [eid, C.nowS(), E.pyInt(share), E.pyInt(releasePerDay)]);
}
/** What group `group` may still spend at `at` (MILLISECONDS, as casino/mtt.js passes it; default now). */
async function remaining(group, { at } = {}) {
  await init();
  const nowS = at === undefined || at === null ? C.nowS() : Number(at) / 1000;
  return leftOf(await weekCtx(nowS), group);
}
/** The budget week `atMs` falls in -> {start, end} in MILLISECONDS. */
async function weekOf(atMs) {
  const hour = await S.hour();
  const start = E.weekStart(Number(atMs) / 1000, hour);
  return { start: start * 1000, end: (start + WEEK_S) * 1000 };
}

// ── answers ──
const HTTP = { paid: 200, refused: 409, conflict: 409, not_owner: 409, cutting: 423, paused: 503, offline: 503, invalid: 400 };
const notOwner = () => ({ ok: false, state: "not_owner", terminal: false, code: "E_NOT_OWNER", owner: "pepe", error: OWNER_NOT_SITE });
const cutting = () => ({ ok: false, state: "cutting", terminal: false, code: "E_CUTTING", error: "the budget is being handed over" });
const paused = () => ({ ok: false, state: "paused", terminal: false, code: "E_PAUSED", retry_after_s: 60, error: "the budget is paused" });
const offline = (error) => ({ ok: false, state: "offline", terminal: false, code: "E_OFFLINE", error: error || "the site can't take spends right now" });
const invalid = (error) => ({ ok: false, state: "invalid", terminal: false, code: "E_BAD_REQUEST", error });
const REFUSAL_TEXT = { E_OVER_BUDGET: "over the group's weekly budget", E_INSUFFICIENT: "the paying vault can't cover it", E_FED_GUARD: "the Federal Reserve pays no rewards",
                       E_HOUSE_SHORT: "the House can't cover it", E_NO_ACCOUNT: "no such account", E_SITE_BANNED: "that account is banned", E_VOIDED: "given up by the caller",
                       E_EXPIRED: "expired in the caller's queue" };
const REFUSAL_CODES = Object.keys(REFUSAL_TEXT);
const answerOf = (row) => { try { return JSON.parse(row.result); } catch (e) { return { ok: row.status === "paid", state: row.status, key: row.key }; } };
function gateAnswer(own) {
  if (own.owner === "pepe") return notOwner();
  if (own.owner === "cutting") return cutting();
  if (own.owner !== "site") return notOwner();
  if (own.paused) return paused();
  return null;
}
const rowOf = async (key) => (await getQuery("SELECT * FROM incentive_spends WHERE key = ?", [key]))[0] || null;

// ── the request ──
function destRef(d) {
  if (d.kind === "user") return d.userId;
  if (d.kind === "pad" || d.kind === "launchpad") return d.id;
  return d.tag || "";
}
const requestSha = (r) => sha([r.flow, r.amount, r.dest.kind, destRef(r.dest), r.keep].join("|"));
function parseDest(raw, spec) {
  const d = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  if (!d) throw new Bad("dest");
  const kind = String(d.kind || "");
  if (!spec.dests.includes(kind)) throw new Bad("dest.kind");
  if (kind === "user") {
    const userId = String(d.userId || "");
    const type = String(d.type || "");
    if (!USER_RE.test(userId)) throw new Bad("dest.userId");
    if (!TYPE_RE.test(type)) throw new Bad("dest.type");
    return { kind, userId, type, counterparty: clip(d.counterparty, 64) };
  }
  const tag = clip(d.tag, 40);
  if (kind === "none") return { kind, tag };
  const id = String(d.id || "");
  if (!ROOM_RE.test(id) || !P().isPool("room:" + id)) throw new Bad("dest.id");
  return { kind, id, tag };
}
function parseSpend(b) {
  const key = String(b.key === undefined || b.key === null ? "" : b.key);
  if (!KEY_RE.test(key)) throw new Bad("key");
  if (b.void === true) {
    const reason = String(b.reason || "");
    if (reason !== "ttl" && reason !== "gave_up") throw new Bad("reason");
    return { key, void: true, reason, flow: clip(b.flow, 64) || "void" };
  }
  const flow = String(b.flow || "");
  if (!hasOwn(SPEND_FLOWS, flow)) throw new Bad("flow");
  const spec = SPEND_FLOWS[flow];
  const amount = Number(b.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Bad("amount");
  const keep = b.keep === undefined || b.keep === null ? 0 : Number(b.keep);
  if (!Number.isSafeInteger(keep) || keep < 0) throw new Bad("keep");
  const r = { key, flow, spec, amount, keep, dest: parseDest(b.dest, spec), room: clip(b.room, 80), why: clip(b.why, 120), actor: clip(b.actor, 40),
              at: Number.isFinite(Number(b.at)) ? Number(b.at) : null, via: "pepe" };
  r.sha = requestSha(r);
  return r;
}

// ── paying (inside the caller's transaction) ──
async function creditUser(r, vault, ctx) {
  const ledger = require("../ledger");
  const d = r.dest;
  const target = await ledger.resolveUserId(d.userId);
  if (!target) throw new Stop("E_NO_ACCOUNT");
  await require("../botcredits").init();
  const transactionId = "sp-" + sha(r.key).slice(0, 40);
  const cp = d.counterparty && r.resolveCounterparty ? await r.resolveCounterparty(d.counterparty) : null;
  const posted = await require("../autoescrow").credit(target, r.amount, "bonus win",
    { requireCover: true, counterparty: cp, transactionId, source: `bonus ${d.type} from ${vault}`, kind: d.type });
  if (!posted.ok) throw new Stop(posted.code === ledger.E_SITE_BANNED ? "E_SITE_BANNED" : "E_NO_ACCOUNT");
  await runQuery("INSERT INTO bonus_winners (bonusId, type, userId, transactionId, amount) VALUES (?, ?, ?, ?, ?)",
                 [require("uuid").v4(), d.type, posted.userId, transactionId, r.amount]);
  await runQuery(`INSERT INTO bot_credit_log (ref, ts, endpoint, userId, type, amount, source, outcome) VALUES (?, ?, 'spend', ?, ?, ?, ?, 'ok')
                  ON CONFLICT(ref) DO UPDATE SET outcome = 'ok', ts = excluded.ts`, [r.key.slice(0, 80), ctx.nowMs, posted.userId, d.type, r.amount, vault]);
  return { kind: "user", userId: posted.userId, transactionId, escrowed: !!posted.escrowed, expires_at: posted.expires_at || null };
}
async function creditLegs(r) {
  const ledger = require("../ledger");
  const out = [];
  for (let i = 0; i < r.dest.legs.length; i++) {
    const l = r.dest.legs[i];
    const uid = await ledger.resolveUserId(l.userId);
    if (!uid) throw new Stop("E_NO_ACCOUNT");
    const p = await ledger.post(uid, l.amount, String(l.reason || r.flow).slice(0, 80),
                                { transactionId: `sp-${sha(r.key).slice(0, 36)}-${i}`, counterparty: l.cp || undefined, source: r.source || `budget:${r.flow}` });
    if (!p.ok) throw new Stop(p.code === ledger.E_SITE_BANNED ? "E_SITE_BANNED" : "E_NO_ACCOUNT");
    out.push({ userId: p.userId, amount: l.amount, transactionId: p.transactionId });
  }
  return { kind: "legs", legs: out };
}
/** Debit + destination for a pad / launchpad / debit-only spend: the pool legs of one keyed move. pad: the vault cap's excess goes to Fort Knox (_rv_credit). */
async function poolDest(r, vault, ctx) {
  const legs = [{ pool: vault, amount: -r.amount }];
  const out = { kind: r.dest.kind };
  if (r.dest.kind === "pad" || r.dest.kind === "launchpad") {
    const pool = "room:" + r.dest.id;
    const cap = ctx.c.int("room_vault_cap", 50000000);
    const roomIn = Math.min(r.amount, Math.max(0, cap - (await P().balance(pool))));
    const overflow = r.amount - roomIn;
    if (roomIn) legs.push({ pool, amount: roomIn });
    if (overflow) legs.push({ pool: "fortknox", amount: overflow });
    Object.assign(out, { id: r.dest.id, room_in: roomIn, overflow });
  }
  return { legs, out };
}
const REFUSE_POOL = (e) => e instanceof P().Refuse && e.code === "E_INSUFFICIENT";
async function debitPools(r, vault, legs, ctx) {
  const X = P()._inTx;
  const mk = "spend:" + r.key;
  const meta = { kind: "fund", flow: r.flow.slice(0, 64), why: r.flow.slice(0, 120), via: "budget" };
  let a;
  try { a = await X.applyLegs(mk, legs, meta); } catch (e) {
    if (REFUSE_POOL(e)) throw new Stop("E_INSUFFICIENT", e.message);
    throw e;
  }
  await X.recordMove(mk, Object.assign({}, meta, { legs, net: a.net, ts: a.ts, result: { ok: true, key: mk, balances: a.after } }));
  await X.bumpRev();
  return a;
}
/** Fed flash liquidity for a House payout (pepe_monetary._mo_house_cover), inside the payment's savepoint. -> {gap, loan} | null */
async function flashCover(r, gap) {
  const Fed = require("../fed/service");
  if (!(await Fed.meta("live"))) throw new NotReady("offline", "E_OFFLINE", "the Fed's books aren't live here");
  try {
    const m = await tx(() => Fed.loanInTx({ vault: "house", amount: gap, flash: true, auto: true, key: "flash-" + sha(r.key).slice(0, 40),
                                            reason: `${r.flow} payout`, actor: "budget", via: "site" }, null));
    return m && m.ok ? { gap, loan: m.rec.id } : null;
  } catch (e) {
    if (e instanceof Fed.Refuse) return null;
    throw e;
  }
}
/** The savepoint's body: every check after the vault is known, the debit and the destination. Throws Stop for a refusal. */
async function payBody(r, ctx, vault, group) {
  const X = { flash: null, gapOpen: 0 };
  const fund = require("../funding");
  let bal;
  if (r.dest.kind === "caller") bal = null;                       // the caller's own move debits (and refuses) in this transaction
  else if (vault === "jackpot") {
    bal = await fund.jackpotPot();
    const gap = houseGap(r.amount, Math.max(0, bal), E.pyInt(ctx.c.k("HOUSE_MIN_CASH")));
    if (gap > 0) {
      X.gapOpen = gap;
      if (flashHouseOn(ctx.c, ctx.flags)) {
        X.flash = await flashCover(r, gap);
        if (X.flash) { X.gapOpen = 0; bal = await fund.jackpotPot(); }
      }
    }
  } else bal = await P().balance(vault);
  if (bal !== null && Math.max(0, bal) < r.amount + r.keep) {
    if (vault === "jackpot" && X.gapOpen > 0) throw new Stop("E_HOUSE_SHORT", null, { balance: Math.max(0, bal) });
    throw new Stop("E_INSUFFICIENT", null, { balance: Math.max(0, bal) });
  }
  let left = null;
  if (group) {
    left = leftOf(ctx, group);
    if (!r.noCheck && r.amount > left) throw new Stop("E_OVER_BUDGET", null, { left, balance: bal === null ? undefined : bal });
  }
  const kind = r.dest.kind;
  let dest = { kind };
  if (kind === "caller") dest = { kind: "none" };
  else if (kind === "user" || kind === "legs") {
    if (vault === "jackpot") {
      await debitHouse(r, kind === "user" ? r.dest.userId : null);
    } else await debitPools(r, vault, [{ pool: vault, amount: -r.amount }], ctx);
    dest = kind === "user" ? await creditUser(r, vault, ctx) : await creditLegs(r);
  } else {
    const { legs, out } = await poolDest(r, vault, ctx);
    if (vault === "jackpot") {
      await debitHouse(r, null);
      if (legs.length > 1) await debitPools(r, vault, legs.slice(1), ctx);
    } else await debitPools(r, vault, legs, ctx);
    dest = out;
  }
  const after = kind === "caller" ? null : vault === "jackpot" ? await fund.jackpotPot() : await P().balance(vault);
  return { dest, balance: after, flash: X.flash, left };
}
async function debitHouse(r, userId) {
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                 [("spend:" + r.key).slice(0, 190), `fund:${r.flow}`.slice(0, 80), userId, -r.amount]);
}
async function insertRow(r, f) {
  await runQuery(`INSERT INTO incentive_spends (key, eid, grp, flow, amount, vault, dest_kind, dest_ref, user_id, room, actor, status, code, why, via, ts, req_sha, result)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [r.key, f.eid, f.grp, String(r.flow).slice(0, 64), f.amount, f.vault || null, f.destKind || null, f.destRef || null, f.userId || null,
                  r.room || null, r.actor || null, f.status, f.code || null, r.why || null, r.via || null, f.ts, r.sha || null, JSON.stringify(f.result)]);
}
/**
 * One spend, in the open transaction, after the key was found unrecorded and the owner checked. r: {key, flow, spec, amount, keep, dest, ...}.
 * -> the answer (paid or refused, both recorded). Throws NotReady (nothing recorded).
 */
async function spendIn(r) {
  const nowMs = Math.round(C.nowMs());
  const nowS = nowMs / 1000;
  try { await P()._inTx.requireLiveInTx(); } catch (e) { throw new NotReady("offline", "E_OFFLINE", "the pools aren't live here"); }
  let ctx;
  try { ctx = Object.assign(await weekCtx(nowS), { nowMs }); } catch (e) {
    if (require("./config").isCfgErr(e)) throw new NotReady("offline", "E_OFFLINE", "the economy settings can't be read");
    throw e;
  }
  await openWeek(ctx.eid, nowS, r.via);
  const refuse = async (code, error, extra, vault, group) => {
    const out = Object.assign({ ok: false, state: "refused", terminal: true, key: r.key, code, error: error || REFUSAL_TEXT[code] || code, flow: r.flow,
                                group: group || null, week: ctx.eid, vault: vault || null }, extra || {}, { ts: nowMs });
    await insertRow(r, { eid: ctx.eid, grp: null, amount: r.amount, vault, destKind: r.dest.kind, destRef: destRef(r.dest), userId: r.dest.userId || null,
                         status: "refused", code, ts: nowMs, result: out });
    return out;
  };
  let vault;
  if (r.forceVault) vault = r.forceVault;
  else {
    let shares = [];
    if (r.spec.vault === "route") {
      try { shares = await require("../econstore").routeShares(r.flow, []); } catch (e) {
        if (require("./config").isCfgErr(e)) throw new NotReady("offline", "E_OFFLINE", "the routing table can't be read");
        throw e;
      }
    }
    vault = resolveVault(r.flow, r.spec, shares, ctx.flags);
  }
  const specGroup = r.group !== undefined ? r.group : groupOfSpend(r.flow);
  const group = vault === "incentives" ? specGroup : null;
  if (fedGuarded(vault, ctx.flags)) return refuse("E_FED_GUARD", null, null, vault, group);
  let paid;
  try { paid = await tx(() => payBody(r, ctx, vault, group)); } catch (e) {
    if (e instanceof Stop) return refuse(e.code, e.message !== e.code ? e.message : null, e.extra, vault, group);
    throw e;
  }
  const spent = group ? E.pyInt(ctx.inp.week.spent[group] || 0) + r.amount : null;
  const left = group ? (E.pyInt(E.resolveWeek(ctx.inp, ctx.c, nowS).budgets[group]) < 0 ? Math.max(0, E.pyInt(paid.balance === null ? ctx.inp.pools.incentives - r.amount : paid.balance)) : Math.max(0, paid.left - r.amount)) : null;
  const out = { ok: true, state: "paid", key: r.key, dup: false, flow: r.flow, group, week: ctx.eid, amount: r.amount, vault, balance: paid.balance, left, spent, dest: paid.dest, ts: nowMs };
  if (paid.flash) out.flash = paid.flash;
  if (r.at !== null && r.at !== undefined) out.at = r.at;
  await insertRow(r, { eid: ctx.eid, grp: group, amount: r.amount, vault, destKind: paid.dest.kind, destRef: destRef(r.dest),
                       userId: paid.dest.userId || null, status: "paid", ts: nowMs, result: out });
  return out;
}
function recordedAnswer(row, r) {
  if (r && r.sha && row.req_sha && r.sha !== row.req_sha) {
    return { ok: false, state: "conflict", terminal: false, code: "E_KEY_CONFLICT", key: r.key, error: "this key was used for a different spend" };
  }
  return Object.assign(answerOf(row), { dup: true });
}
async function voidIn(r) {
  const nowMs = Math.round(C.nowMs());
  const hour = await S.hour();
  const eid = E.epochId(nowMs / 1000, hour);
  const code = r.reason === "ttl" ? "E_EXPIRED" : "E_VOIDED";
  const out = { ok: false, state: "refused", terminal: true, key: r.key, code, error: REFUSAL_TEXT[code], flow: r.flow, week: eid, ts: nowMs };
  await insertRow(r, { eid, grp: null, amount: 0, status: "refused", code, ts: nowMs, result: out });
  return out;
}

/** A queued reward Pepe gave up on after its 7 days: the owners hear about each one (nothing was paid). */
function expiredAlert(out) {
  Promise.resolve().then(() => require("../opsalerts").alert({ source: "policy", ref: `budget-expired:${out.key}`, title: `Queued incentive spend expired: ${out.key}`.slice(0, 120),
    body: `${out.flow}: it waited 7 days in Pepe's queue and was given up. No points moved.` })).catch((e) => console.error("[budget] expired alert:", e.message));
}

// ── the HTTP side ──
/** POST /api/policy/bot/spend -> {status, json}. */
async function spend(body, deps = {}) {
  await init();
  let r;
  try { r = parseSpend(body || {}); } catch (e) {
    if (e instanceof Bad) return { status: 400, json: invalid(`bad ${e.message}`) };
    throw e;
  }
  r.resolveCounterparty = deps.resolveCounterparty || null;
  let out;
  try {
    out = await tx(async () => {
      const row = await rowOf(r.key);
      if (row) return recordedAnswer(row, r);
      const own = await ownerRow();
      if (r.void) return own.owner === "pepe" ? notOwner() : voidIn(r);
      return gateAnswer(own) || spendIn(r);
    });
  } catch (e) {
    if (e instanceof NotReady) out = offline(e.message);
    else throw e;
  }
  if (out.code === "E_EXPIRED" && !out.dup) expiredAlert(out);
  return { status: HTTP[out.state] || 500, json: out };
}
/** POST /api/policy/bot/spend-status: committed rows, queued behind anything already waiting (like pools.settledMoveStatus). */
async function status(body) {
  await init();
  const b = body || {};
  const many = Array.isArray(b.keys);
  const keys = many ? b.keys.slice(0, MAX_STATUS_KEYS).map(String) : [String(b.key === undefined || b.key === null ? "" : b.key)];
  if (!keys.every((k) => KEY_RE.test(k)) || (many && b.keys.length > MAX_STATUS_KEYS)) return { status: 400, json: invalid("bad key") };
  const { rows, own } = await tx(async () => ({ own: await ownerRow(), rows: await Promise.all(keys.map(rowOf)) }));
  const item = (row) => (row ? { state: row.status, result: answerOf(row) } : { state: "unknown", result: null });
  const head = { ok: true, owner: own.owner, paused: !!own.paused };
  if (many) return { status: 200, json: Object.assign(head, { items: Object.fromEntries(keys.map((k, i) => [k, item(rows[i])])) }) };
  return { status: 200, json: Object.assign(head, { key: keys[0] }, item(rows[0])) };
}
/** POST /api/policy/bot/week: Pepe's mirror. Reads only; never opens a week. */
async function weekView(b = {}) {
  await init();
  const nowS = C.nowS();
  return tx(async () => {
    const own = await ownerRow();
    const hour = await S.hour();
    const head = { ok: true, owner: own.owner, paused: !!own.paused, now: nowS, hour };
    if (own.owner !== "site") return Object.assign(head, { week: null, weeks: [], settled: null, shadow: await Shadow().latest() });
    const ctx = await weekCtx(nowS);
    const row = await weekRow(ctx.eid);
    const w = weekOfInputs(ctx.inp, ctx.c, nowS);
    const start = E.weekStart(nowS, hour);
    const n = Math.max(0, Math.min(12, Number.isFinite(Number(b.weeks)) ? Math.trunc(Number(b.weeks)) : 12));
    const weeks = [];
    if (n) {
      for (const x of await getQuery("SELECT * FROM incentive_weeks WHERE eid < ? ORDER BY eid DESC LIMIT ?", [ctx.eid, n])) {
        const old = await spentOf(x.eid);
        weeks.push({ id: x.eid, budgets: w.budgets, spent: Object.fromEntries(E.GROUPS.map((g) => [g, old[g] || 0])), share: x.share, release_per_day: x.release_per_day });
      }
    }
    const after = Math.max(0, Math.trunc(Number(b.settled_after) || 0));
    const rows = await getQuery("SELECT claim_id, seq, ts, grp, amount FROM incentive_settled WHERE seq > ? ORDER BY seq LIMIT ?", [after, SETTLED_PAGE + 1]);
    const page = rows.slice(0, SETTLED_PAGE);
    return Object.assign(head, {
      week: Object.assign(w, { start, end: start + WEEK_S, opened_at: row ? row.opened_at : null, share: row ? row.share : null, release_per_day: row ? row.release_per_day : null }),
      balance: ctx.inp.pools.incentives, weeks,
      settled: { next: page.length ? page[page.length - 1].seq : after, more: rows.length > SETTLED_PAGE, ids: page.map((x) => [x.claim_id, Math.floor(x.ts / 1000), x.grp, x.amount]) } });
  });
}

// ── the in-process API (the caller's transaction) ──
const multiLeg = true;
/**
 * A spend against the incentive pool inside the caller's dbUtils.tx (casino guarantees, the gang tick, a launchpad welcome, the engines).
 * {key, flow, group?, legs:[{userId, amount, reason, cp}]} or {to, amount, reason, cp}, or {amount, debitOnly:true} (debit + count; the
 * caller credits), or {amount, legsFromCaller:true} (check + count; the caller's own move holds the debit); noCheck skips the budget test.
 * -> {ok:true, ...} | {ok:false, terminal:true, code} (recorded under the key). THROWS for anything non-terminal, nothing recorded.
 */
async function spendInTx(a) {
  if (!inTx()) throw new Error("spendInTx needs the caller's transaction");
  await init();
  const key = String(a.key || "");
  if (!KEY_RE.test(key)) throw new Bad("key");
  const own = await ownerRow();
  const gate = gateAnswer(own);
  const row = await rowOf(key);
  if (row) {
    const rec = Object.assign(answerOf(row), { dup: true });
    return rec.ok ? rec : { ok: false, terminal: true, code: rec.code, dup: true };
  }
  if (gate) throw new NotReady(gate.state, gate.code, gate.error);
  const flow = String(a.flow || "").replace(/^incentives:/, "");
  let dest, amount;
  if (Array.isArray(a.legs)) {
    const legs = a.legs.map((l) => ({ userId: String(l.userId), amount: Math.trunc(Number(l.amount)), reason: l.reason, cp: l.cp }));
    if (!legs.length || legs.some((l) => !(l.amount > 0))) throw new Bad("legs");
    amount = legs.reduce((t, l) => t + l.amount, 0);
    dest = { kind: "legs", legs };
  } else {
    amount = Math.trunc(Number(a.amount));
    if (!(amount > 0)) throw new Bad("amount");
    if (a.legsFromCaller) dest = { kind: "caller" };
    else if (a.debitOnly) dest = { kind: "none", tag: clip(a.tag, 40) };
    else dest = { kind: "legs", legs: [{ userId: String(a.to), amount, reason: a.reason, cp: a.cp }] };
  }
  const group = a.group !== undefined ? a.group : (hasOwn(SPEND_FLOWS, flow) ? SPEND_FLOWS[flow].group : groupOfClaim(flow));
  const r = { key, flow, spec: { vault: "incentives" }, amount, keep: Math.max(0, Math.trunc(Number(a.keep) || 0)), dest, group, forceVault: "incentives",
              room: clip(a.room, 80), why: clip(a.why, 120), actor: clip(a.actor, 40), via: clip(a.via, 20) || "site", source: clip(a.source, 60), noCheck: !!a.noCheck, at: null };
  r.sha = null;
  const out = await spendIn(r);
  return out.ok ? out : { ok: false, terminal: true, code: out.code };
}

// ── website claims while the site owns the week ──
/**
 * In the payout's transaction: claim `claimId` ("incentives:<fl>", amount > 0 paid out of the pool, < 0 returned to it) is debited under
 * its key claim:<id> and counted. check: refuse over the group's budget (throws Stop). A refusal recorded under the key throws too.
 */
async function settleClaimInTx({ claimId, flow, amount, check = false, source = "site" }) {
  const X = P()._inTx;
  const id = String(claimId);
  const key = "claim:" + id;
  const fl = String(flow || "").startsWith(INC) ? String(flow).slice(INC.length) : String(flow || "");
  const amt = Math.trunc(Number(amount) || 0);
  // re-read in this transaction: a payout never settles here unless the site owns the week right now (a clawback still lands while paused)
  const own = await ownerRow();
  if (own.owner !== "site" || (own.paused && amt > 0)) throw new NotReady(own.paused ? "paused" : "not_owner", own.paused ? "E_PAUSED" : "E_NOT_OWNER");
  const nowMs = Math.round(C.nowMs());
  const ctx = await weekCtx(nowMs / 1000);
  const grp = groupOfClaim(fl);
  if (check && grp && amt > 0 && amt > leftOf(ctx, grp)) throw new Stop("E_OVER_BUDGET");
  const rec = await X.recorded(key);
  if (rec && rec.ok === false) throw new Stop("E_KEY_REFUSED", "a refusal is recorded under the claim's key");
  if (!rec && amt !== 0) {
    const legs = [{ pool: "incentives", amount: -amt }];
    let a;
    try { a = await X.applyLegs(key, legs, { kind: "settle", flow: fl.slice(0, 64), why: (fl || "website grant").slice(0, 120), via: "site" }); } catch (e) {
      if (REFUSE_POOL(e)) throw new Stop("E_INSUFFICIENT", e.message);
      throw e;
    }
    await X.recordMove(key, { kind: "settle", flow: fl.slice(0, 64), why: (fl || "website grant").slice(0, 120), via: "site", legs, net: a.net, ts: a.ts, result: { ok: true, key, balances: a.after } });
    await X.bumpRev();
  }
  await openWeek(ctx.eid, nowMs / 1000, "claim");
  const seq = Number((await getQuery("SELECT COALESCE(MAX(seq),0) AS s FROM incentive_settled"))[0].s) + 1;
  await runQuery(`INSERT OR IGNORE INTO incentive_settled (claim_id, seq, eid, grp, amount, ts, source) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                 [id, seq, ctx.eid, grp, amt, nowMs, clip(source, 20)]);
  await runQuery("UPDATE reserve_claims SET settled = 1 WHERE claimId = ? AND settled = 0", [id]);
  return { ok: true, key, group: grp, week: ctx.eid };
}
/** A settled claim taken back after its credit failed (a caller that credits outside the take's transaction): the debit is reversed
 *  under claim:<id>:undo, the count and the claim row go. Keyed: running it twice changes nothing more. */
async function undoClaim(claimId) {
  const X = P()._inTx;
  const id = String(claimId);
  return tx(async () => {
    const row = (await getQuery("SELECT amount, flow FROM reserve_claims WHERE claimId = ?", [id]))[0];
    if (!row) return false;
    const key = `claim:${id}:undo`;
    const amt = Math.trunc(Number(row.amount) || 0);
    if (amt !== 0 && !(await X.seen(key)) && (await X.seen("claim:" + id))) {
      const legs = [{ pool: "incentives", amount: amt }];
      const fl = String(row.flow).slice(INC.length);
      const why = `undo ${fl} (credit failed)`.slice(0, 120);
      const a = await X.applyLegs(key, legs, { kind: "settle", flow: fl.slice(0, 64), why, via: "site" });
      await X.recordMove(key, { kind: "settle", flow: fl.slice(0, 64), why, via: "site", legs, net: a.net, ts: a.ts, result: { ok: true, key, balances: a.after } });
      await X.bumpRev();
    }
    await runQuery("DELETE FROM incentive_settled WHERE claim_id = ?", [id]);
    await runQuery("DELETE FROM reserve_claims WHERE claimId = ?", [id]);
    return true;
  });
}
/** A claim row + its settlement, one transaction (funding.takeFundsRef / takeIncentivesRef). -> {ok, claimId?, code?} */
async function takeClaim({ claimId, flow, userId, type, amount, check = true }) {
  try {
    await tx(async () => {
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, settled) VALUES (?, ?, ?, ?, ?, 0)", [claimId, flow, userId || null, type || flow, amount]);
      await settleClaimInTx({ claimId, flow, amount, check });
    });
    return { ok: true, claimId };
  } catch (e) {
    if (e instanceof Stop || e instanceof NotReady) return { ok: false, code: e.code };
    throw e;
  }
}
/** Fed flash liquidity for a House payout the site is about to make (funding.houseFlashCover) - settled at once, no claim left for Pepe. */
async function flashClaim({ claimId, flow, userId, type, gap, meta }) {
  const Fed = require("../fed/service");
  if (!(await Fed.live())) return { used: false, gap, reason: "fed" };
  try {
    return await tx(async () => {
      const m = await Fed.loanInTx({ vault: "house", amount: gap, flash: true, auto: true, key: "flash-" + sha(claimId).slice(0, 40), reason: `site ${flow} payout past the House floor`, actor: "site", via: "site" }, null);
      if (!m || !m.ok) throw new Stop("E_HOUSE_SHORT");
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, settled, meta) VALUES (?, ?, ?, ?, ?, 1, ?)",
                     [claimId, "flash:house:" + flow, userId || null, type || flow, gap, JSON.stringify(meta || {})]);
      return { used: true, gap, claimId, reason: "flash" };
    });
  } catch (e) {
    if (e instanceof Stop || e instanceof Fed.Refuse) return { used: false, gap, reason: "room" };
    throw e;
  }
}
/** Claims booked before the hand-over (still unsettled): settled once, each in its own transaction. Runs from pools.settleClaims. */
async function sweepLegacyClaims({ limit = 200 } = {}) {
  if (!(await isSite())) return { settled: 0 };
  await init();
  const rows = await getQuery(`SELECT claimId, flow, amount FROM reserve_claims WHERE settled = 0 AND COALESCE(queued,0) = 0
                               AND (flow LIKE 'incentives:%' OR flow LIKE 'flash:%') ORDER BY created, rowid LIMIT ?`, [limit]);
  let n = 0;
  for (const c of rows) {
    try {
      await tx(async () => {
        if (!(await isSite())) return;
        if (String(c.flow).startsWith(INC)) await settleClaimInTx({ claimId: c.claimId, flow: c.flow, amount: c.amount, source: "legacy" });
        else {
          const Fed = require("../fed/service");
          await Fed.loanInTx({ vault: "house", amount: Math.trunc(Number(c.amount)), flash: true, auto: true, key: "flash-" + sha(c.claimId).slice(0, 40),
                               reason: `site ${String(c.flow).slice("flash:house:".length) || "site"} payout past the House floor`, actor: "site", via: "site" }, null);
          await runQuery("UPDATE reserve_claims SET settled = 1 WHERE claimId = ? AND settled = 0", [c.claimId]);
        }
        n++;
      });
    } catch (e) {
      if (!(e instanceof Stop)) console.error(`[budget] legacy claim ${c.claimId}:`, e.message);
    }
  }
  return { settled: n };
}
/** While the site owns the week, the admin card's per-group display rows (incentive_groups) follow its numbers. */
async function refreshGroupsDisplay(nowS = C.nowS()) {
  const ctx = await weekCtx(nowS);
  const w = weekOfInputs(ctx.inp, ctx.c, nowS);
  const t = Date.now();
  for (const g of E.GROUPS) {
    const b = E.pyInt(w.budgets[g]), s = E.pyInt(w.spent[g]);
    await runQuery(`INSERT INTO incentive_groups (grp, week, budget, spent, remaining, updated) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(grp) DO UPDATE SET week = excluded.week, budget = excluded.budget, spent = excluded.spent, remaining = excluded.remaining, updated = excluded.updated`,
                   [g, w.id, b, s, b < 0 ? null : Math.max(0, b - s), t]);
  }
}

// ── the admin card ──
async function adminView() {
  await init();
  const own = await ownerRow();
  const out = Object.assign({ ok: true, owner: own.owner, paused: !!own.paused }, await Shadow().view());
  if (own.owner === "site") {
    out.recent = await getQuery("SELECT key, flow, grp, amount, vault, dest_kind, status, code, ts FROM incentive_spends ORDER BY ts DESC, rowid DESC LIMIT 30");
    out.settled_recent = await getQuery("SELECT claim_id, grp, amount, ts, source FROM incentive_settled ORDER BY seq DESC LIMIT 30");
  }
  return out;
}

function register(app, { isBotToken, addUser, resolveCounterparty = null }) {
  init().catch((e) => console.error("[budget] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const out = await fn(b);
      if (out && out.status && out.json) return res.status(out.status).json(out.json);
      res.json(out);
    } catch (e) {
      console.error("[budget] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/policy/bot/spend", bot((b) => spend(b, { resolveCounterparty })));
  app.post("/api/policy/bot/spend-status", bot((b) => status(b)));
  app.post("/api/policy/bot/week", bot((b) => weekView(b)));
  app.get("/api/admin/policy/budget", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const row = (await getQuery("SELECT class, username, userId FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!require("../siteperms").can(row, "econ.telemetry_policy")) return res.status(403).json({ ok: false, error: "Admins only." });
    try { res.json(await adminView()); } catch (e) { console.error("[budget] view:", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
}

const noteSync = (raw) => Shadow().noteSync(raw);
const shadowPass = (nowS, info, engs) => Shadow().pass(nowS, info, engs);

module.exports = { init, register, isSite, ownerRow, spend, status, weekView, spendInTx, remaining, weekOf, multiLeg, settleClaimInTx, undoClaim, takeClaim, flashClaim,
                   sweepLegacyClaims, setShareInTx, weekForEngines, fundingBlock, refreshGroupsDisplay, adminView, noteSync, shadowPass, weekCtx, leftOf, weekOfInputs, blockOfInputs,
                   groupOfSpend, groupOfClaim, resolveVault, fedGuarded, houseGap, flashHouseOn, GRANT_FLOWS, BOT_FLOWS, ACTIVITY_FLOWS, CLAIM_GROUPS, UNGROUPED, SPEND_FLOWS,
                   REFUSAL_CODES, KEY_RE, HTTP, Stop, NotReady, Bad, GROUPS: E.GROUPS };
