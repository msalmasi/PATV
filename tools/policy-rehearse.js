#!/usr/bin/env node
// tools/policy-rehearse.js - the H2a rehearsal kit (economy policy plan section 4, H2a gate 6; docs/policy-engines-cutover-runbook.md
// section 15). On a STAGING copy of prod it forces the engine legs prod never had, runs the site's REAL scheduler for them at a
// tagged test clock (policy/scheduler.js pass - the same code a live engine runs), and prints the site's plan next to staging
// Pepe's shadow report for the same tagged period, the rows written and a PASS / FAIL / WAIT line per leg.
//
// THE LEGS (--leg)
//   floor      the Fed below its floor with room under the month's floor-mint cap: the monetary day mints min(need, daily, room)
//   floorcap   the Fed below its floor while the month's floor-mint cap binds (the room left is under the day's want): the day
//              mints the room left - 0 too - and records the cap notice (policy_effects cap_hit:floor-<month>). Prod's November
//              2026: its floor mints used ~29.2M of the 30M cap by 11-17
//   guarantee  a Monday with the incentive budget under the guarantee target: the tagged epoch, the daily release, then the
//              monetary day tops the budget up from the Fed (mo-<day>-guarantee)
//   ceiling    the Fed above its ceiling: the excess released (fed_ceiling_action: to the burn reserve or to incentives)
//   burn       250,000 PAT into the burn reserve: the accrual burns it (live: the site; shadow: staging Pepe's own burn tick)
//   overflow   Fort Knox above its cap (the cap the daily plan computes - pct of the week's target or fixed): the overflow,
//              Fed loans first (tr-<day>-fkover / -fkover-loan)
// A state that is already there (prod's copy: the Fed under its floor, the November cap used) is not forced again: the setup
// moves nothing and its receipt records the state as it was. The one exception is `guarantee`: it ALWAYS moves incentives to 0
// (into the Fed), even when they are already under the target. The monetary day's guarantee base is the tagged epoch's
// incentives_after (policy/engines planMonetary gBase), and that epoch adds its own waterfall share to incentives first - from
// a balance just under the target the share alone can lift them over it, and the top-up the leg is about never happens. The
// Fed rises by the incentives moved (prod's copy: ~20.6M) until the guarantee draws on it.
//
// COMMANDS (every one takes --db=<path to the staging copy's myapp.db>)
//   status   --at=<ISO Z> [--leg=]            read only: engines, owner, pools, the settings the legs read, what each leg's setup
//                                              would move and plan, the setups still open (WARN; FAIL from 02:30 to 04:30 UTC:
//                                              the real 04:00 run would act on a forced state), and the copy's Telegram reach
//                                              (prod members' links / unsent alerts: WARN). Nothing written
//   setup    --leg= --tag= --at=<ISO Z> [--margin=N] [--allow-notices]   force the state: ONE keyed pool move between system
//                                              pools + its receipt. guarantee / overflow (a tagged epoch pays stakers: staking
//                                              notices) are refused while the copy holds Telegram links or unsent alerts, unless
//                                              --allow-notices (staging Pepe confirmed to have no Telegram token)
//   tick     --leg= --tag= --at=<ISO Z>       one scheduler pass in THIS process at --at, period ids "<id>-<tag>", only the leg's
//                                              engines (guarantee: treasury + monetary; overflow: treasury; burn: burn; the rest:
//                                              monetary). Modes decide what it does: shadow / dry record the site's plan, live runs
//                                              the legs. It changes no mode, pause or ownership.
//   inspect  --tag= [--leg= --at=]            read only: the runs, the site's plan vs Pepe's report (diffs, ok, blocking), the
//                                              effects, the mints, the pool moves of the tag, and the verdict lines
//   undo     --leg= --tag= --at= [--after-run] reverse the setup's own legs exactly (ONE keyed move); see UNDO
//   snapshot                                 read only: the PAT-row counts and row marks + supply (save it before a cutover)
//   cutcheck --before=<snapshot.json>        read only: after Pepe's cutover - the engines live, every period of his journals
//                                              handed, no PAT row from the hand-over (no cutover / import row, no leg of a
//                                              period he handed, no engine leg that no site run since the snapshot explains),
//                                              the supply reconciled with the burns / mints since the snapshot. Live activity
//                                              in between (the site's own burn accrual once the engines are live, charges,
//                                              Pepe's last burns) is listed as INFO, never a FAIL
//   Output: summary lines, then the evidence as JSON (--json: the JSON only).
//
// SAFETY
//   * refuses unless PATV_ENV=staging AND STAGING=1, and the database is not prod's: never under /home/PATV (prod's checkout,
//     its database and its backups folder) or /home/PATV-backups, never a path with a PATV / PATV-backups / prod / production /
//     live folder, never a hard link of /home/PATV/myapp.db - all on the RESOLVED path, before anything opens SQLite (dbUtils
//     would create ./myapp.db). The staging site's own database (/home/PATV-staging/myapp.db, a fresh prod copy after
//     deploy/refresh-staging-db.sh) or any other copy is fine.
//   * setup / undo move PAT only between the SYSTEM pools (reserve, incentives, fortknox, heist, bank, mm; the burn reserve as a
//     destination): ONE keyed pool move each (pool_moves "rehearse:<tag>:<leg>" / ":undo", flow policy_rehearsal, via staging,
//     net 0) written with its receipt (policy_meta "rehearse:<tag>:<leg>") in ONE dbUtils.tx - never a wallet, the House, an
//     escrow pool, a room vault, the stakers pool or vaultfloat. A setup that would not reach the leg is rolled back whole
//     (configuration or a journal prevents it: never change a setting to force it). Bank / Market-maker cash is used last (only
//     the ceiling needs that much) and the output says so: their share prices read it until the undo.
//   * the scheduler runs in this process at --at (policy/core's and fed/service's clocks, restored afterwards): NO test clock is
//     written to the database, so the staging site's own scheduler never jumps.
//   * no write between 03:30 and 04:30 UTC (the real 04:00 runs).
//   * the tool's own process never queues a Telegram alert: a tick's runs file their inbox notices (staking payouts, the digest,
//     ops alerts) but telegram.onNotice / onDm / queue are no-ops while it runs. Other processes on the copy (the staging site,
//     staging Pepe's shadow runs) still queue them: scrub the copy (runbook section 15.2) or confirm staging Pepe has no token.
// UNDO reverses exactly the setup's own legs. Without --after-run it needs the system pools as the setup left them (then every
// balance is back to the PAT); with --after-run (an engine leg - or anything else - moved them since) it still reverses only the
// setup's legs and prints what is left (the engine's legs, and the moves that explain it). It never reverses a mint, a burn or an
// engine leg, and it refuses when the burn reserve moved since the setup (giving it back would pay out of the burn reserve).
"use strict";
const fs = require("fs");
const path = require("path");

const PROD_DB = "/home/PATV/myapp.db";
const PROD_TREES = ["/home/PATV", "/home/PATV-backups"];
const BAD_PART = /^(?:(?:prod(?:uction)?|live)(?:[-_.].*)?|patv|patv-backups)$/i;
// a letter first and 3-8 long: "-<tag>-" / "-<tag>:" must never match a date ("-11-") or another key's word in a LIKE
const TAG_RE = /^[a-z][a-z0-9]{2,7}$/;
const AT_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
// the pools a setup may take from / give to (never the burn reserve as a source: nothing pays out of it but a burn)
const SOURCES = ["reserve", "incentives", "fortknox", "heist", "bank", "mm"];
const TRACKED = [...SOURCES, "burn"];
const VAULT_CASH = new Set(["bank", "mm"]);
const BURN_AMOUNT = 250000;
const MARGIN_DEFAULT = 10000;
const LEGS = {
  floor: { engines: ["monetary"], kind: "monetary", day: "weekday" },
  floorcap: { engines: ["monetary"], kind: "monetary", day: "weekday" },
  guarantee: { engines: ["treasury", "monetary"], kind: "monetary", day: "monday" },
  ceiling: { engines: ["monetary"], kind: "monetary", day: "weekday" },
  burn: { engines: ["burn"], kind: "burn", day: "any" },
  overflow: { engines: ["treasury"], kind: "daily", day: "weekday" },
};
const WINDOW = [3 * 3600 + 30 * 60, 4 * 3600 + 30 * 60];       // 03:30-04:30 UTC: no writes
const NEAR_RUN = [2 * 3600 + 30 * 60, 4 * 3600 + 30 * 60];     // 02:30-04:30 UTC: an open setup is a FAIL in status (the 04:00 run)
// the legs whose tick runs a tagged epoch (a staking payout notice per paid stash)
const NOTICE_LEGS = new Set(Object.keys(LEGS).filter((l) => LEGS[l].engines.includes("treasury")));

let realNow = () => Date.now();
function refuse(message) { throw Object.assign(new Error(message), { refused: true }); }
const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "");
const under = (p, root) => { const a = norm(p).toLowerCase(), r = norm(root).toLowerCase(); return a === r || a.startsWith(r + "/"); };
const iso = (s) => new Date(Math.round(Number(s) * 1000)).toISOString().replace(".000Z", "Z");
const int = (v) => Math.trunc(Number(v) || 0);
const fmt = (n) => (n === null || n === undefined ? "-" : typeof n === "number" ? Math.trunc(n).toLocaleString("en-US") : String(n));

/** The database the tool may open -> its resolved path. Every check runs before SQLite loads. */
function guard(db, env = process.env, { prodDb = PROD_DB, prodTrees = PROD_TREES } = {}) {
  if (env.PATV_ENV !== "staging") refuse("PATV_ENV=staging is required - this tool runs only against a staging copy");
  if (String(env.STAGING || "") !== "1") refuse("STAGING=1 is required (the staging site's environment)");
  if (!db) refuse("--db=<the staging copy's myapp.db> is required");
  let st;
  try { st = fs.statSync(db); } catch (e) { refuse(`existing database required: ${db} is not there`); }
  if (!st.isFile()) refuse(`existing database file required: ${db} is not a file`);
  const real = fs.realpathSync(db);
  if (path.basename(real) !== "myapp.db") refuse("the site opens ./myapp.db - point --db at a copy named myapp.db");
  for (const t of [prodDb, ...prodTrees]) if (under(real, t)) refuse(`that is prod's (${t}) - never`);
  const parts = norm(real).split("/");
  const bad = parts.find((p) => BAD_PART.test(p));
  if (bad) refuse(`a prod-shaped path (a "${bad}" folder) - use the staging copy (/home/PATV-staging/myapp.db) or a copy outside prod's folders`);
  try {
    const a = fs.statSync(prodDb);
    if (a.ino && a.dev === st.dev && a.ino === st.ino) refuse("that file IS prod's database (the same inode) - never");
  } catch (e) { if (e.refused) throw e; }
  return real;
}
function inWindow(ms = realNow()) {
  const d = new Date(ms);
  const s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return s >= WINDOW[0] && s < WINDOW[1];
}
function noWindow() { if (inWindow()) refuse("not between 03:30 and 04:30 UTC (the real 04:00 runs) - nothing written"); }
/** 02:30-04:30 UTC: the real 04:00 run is less than an hour and a half away (or running). */
function nearRun(ms = realNow()) {
  const d = new Date(ms);
  const s = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
  return s >= NEAR_RUN[0] && s < NEAR_RUN[1];
}

// ── notices: the copy's Telegram reach ──
/** Read only: prod members' Telegram links and the alerts not yet sent on this copy (refresh-staging-db.sh keeps both). */
async function noticeRisk() {
  const { getQuery } = require("../dbUtils");
  const has = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
  const links = (await has("telegram_links")) ? Number((await getQuery("SELECT COUNT(*) AS n FROM telegram_links"))[0].n) || 0 : 0;
  const unsent = (await has("telegram_outbox")) ? Number((await getQuery("SELECT COUNT(*) AS n FROM telegram_outbox WHERE sent_at IS NULL"))[0].n) || 0 : 0;
  return { links, unsent };
}
const riskText = (r) => `${fmt(r.links)} Telegram link(s), ${fmt(r.unsent)} unsent Telegram alert(s)`;
/** Run fn with the site's Telegram queue switched off in THIS process (telegram.onNotice / onDm / queue no-ops, restored after):
 *  the engines' inbox notices are still filed - the rehearsal reads them - but none becomes an alert staging Pepe could deliver,
 *  and no fire-and-forget alert write is left running when the CLI closes the database. */
async function noTelegram(fn) {
  const TG = require("../telegram");
  const keep = { onNotice: TG.onNotice, onDm: TG.onDm, queue: TG.queue };
  TG.onNotice = () => {};
  TG.onDm = () => {};
  TG.queue = async () => false;
  try { return await fn(); } finally { Object.assign(TG, keep); }
}

function valid(o, { leg = true, at = true } = {}) {
  if (!TAG_RE.test(o.tag || "")) refuse("--tag: 3-8 lowercase letters / digits, a letter first");
  if (leg && !Object.hasOwn(LEGS, o.leg || "")) refuse("--leg: " + Object.keys(LEGS).join(" | "));
  if (at && !(Number.isFinite(o.at) && o.at > 0)) refuse("--at=<YYYY-MM-DDTHH:MM:SSZ> (an explicit UTC time) is required");
  if (o.margin !== undefined && !(Number.isSafeInteger(o.margin) && o.margin >= 1 && o.margin <= 10000000)) refuse("--margin: 1..10,000,000 PAT");
}
const keyOf = (o) => `rehearse:${o.tag}:${o.leg}`;

// ── the clock ──
/** Run fn with policy/core's and fed/service's clocks at `atS` (moving on in real time). Nothing is written to the database (the
 *  staging site's own scheduler keeps the real clock); both clocks are restored afterwards, whatever happens. */
async function withClock(atS, fn) {
  const C = require("../policy/core"), F = require("../fed/service");
  const off = Math.round(atS * 1000 - Date.now());
  C._setClock(() => Date.now() + off);
  F._setClock(() => Date.now() + off);
  try { return await fn(); } finally { C._setClock(null); F._setClock(null); }
}

// ── the plan a leg reads ──
async function info(o) {
  const SCH = require("../policy/scheduler");
  return SCH.clockInfo(o.at, o.tag);
}
function checkDay(o, ci) {
  const spec = LEGS[o.leg];
  const monday = Math.trunc(ci.db) === Math.trunc(ci.eb);
  if (spec.day === "monday" && !monday) refuse(`${o.leg}: --at must be a Monday (the epoch's day) - ${iso(o.at)} isn't`);
  if (spec.day === "weekday" && monday) refuse(`${o.leg}: pick a day that isn't a Monday - a Monday adds the epoch and the guarantee to the day`);
  if (spec.kind !== "burn" && o.at - ci.db < 3600) {
    refuse(`${o.leg}: --at must be at least an hour past the ${String(ci.hour).padStart(2, "0")}:00 UTC boundary (${iso(ci.db + 3600)} or later) - before that the monetary day waits for the daily release and the epoch for the Monday cut-off`);
  }
}
async function legInputs(o, ci) {
  const G = require("../policy/gather");
  if (o.leg === "burn") {
    const b = await require("../policy/source").burn();
    const P = require("../pools");
    return { kind: "burn", mode: String((b.cfg || {}).mode || ""), inflight: Math.max(0, int(b.inflight)), pools: { burn: await P.balance("burn") } };
  }
  if (o.leg === "overflow") return G.daily(o.at, ci.did);
  return G.monetary(o.at, ci.did, o.leg === "guarantee");
}
function planOf(o, inp) {
  const E = require("../policy/engines");
  if (o.leg === "burn") return { amount: Math.max(0, int(inp.pools.burn) - int(inp.inflight)), mode: inp.mode, inflight: inp.inflight, burn: int(inp.pools.burn) };
  return o.leg === "overflow" ? E.planDaily(inp) : E.planMonetary(inp);
}
const REACHED = {
  floor: (p) => p.floor_mint > 0,
  floorcap: (p) => p.floor_room !== null && p.floor_room !== undefined && p.floor_need > 0 && p.floor_mint < Math.min(p.floor_need, p.floor_daily),
  guarantee: (p) => !!p.guarantee && p.guarantee_want > 0,
  ceiling: (p) => p.excess > 0,
  burn: (p) => p.amount > 0 && p.mode === "accrual",
  overflow: (p) => p.overflow > 0,
};
function reached(leg, plan) { return !!plan && REACHED[leg](plan); }
/** The fields of a plan a reader compares (both sides, side by side). */
function fieldsOf(kind, p) {
  if (!p || typeof p !== "object") return null;
  if (kind === "monetary" || (p.floor_need !== undefined && p.excess !== undefined)) {
    return { fed: p.fed, incentives: p.incentives, floor: p.floor, ceiling: p.ceiling, floor_need: p.floor_need, floor_daily: p.floor_daily,
             floor_room: p.floor_room, floor_mint: p.floor_mint, issuance: (p.issuance || {}).amount, guarantee: p.guarantee,
             guarantee_target: p.guarantee_target, guarantee_base: p.guarantee_base, guarantee_want: p.guarantee_want, guarantee_paid: p.guarantee_paid,
             excess: p.excess, ceiling_action: p.ceiling_action, fed_after: p.fed_after, legs: (p.legs || []).map((l) => `${l.key || l.tid} ${l.amount || l.amt}`) };
  }
  if (kind === "daily" || p.overflow !== undefined) {
    return { fortknox: p.fortknox, casino: p.casino, incentives: p.incentives, overflow: p.overflow, overflow_loan_repaid: p.overflow_loan_repaid,
             casino_overflow: p.casino_overflow, floor_paid: p.floor_paid, floor_short: p.floor_short, release: p.release,
             legs: (p.legs || []).map((l) => `${l.tid} ${l.amt}`) };
  }
  if (kind === "epoch" || p.totals !== undefined) return { boundary: p.boundary, totals: p.totals, release_per_day: p.release_per_day, legs: (p.legs || []).length };
  if (kind === "burn" || p.burned !== undefined) return { day: p.day, mode: p.mode, burned: p.burned, burns: p.burns };
  return null;
}

/** The balances a leg needs: {pool: target} ({} = already there). Never a setting: an unreachable leg refuses. `extra.fkCapNow`:
 *  Fort Knox's cap on the REAL clock - staging Pepe's daily release (his inject "daily") plans at the real time, the site's tick at
 *  --at, and a scaled cap can differ between the two weeks: Fort Knox is put over both. */
function wanted(o, inp, plan0, extra = {}) {
  const E = require("../policy/engines");
  const m = o.margin || MARGIN_DEFAULT;
  if (reached(o.leg, plan0) && o.leg !== "guarantee" && o.leg !== "burn") return {};
  const c = inp.cfg ? E.C(inp) : null;
  const iss = plan0 && plan0.issuance ? int(plan0.issuance.amount) : 0;
  switch (o.leg) {
    case "floor": {
      if (plan0.floor_daily <= 0) refuse("floor: fed_floor_mint_daily is 0 - the floor never mints (a setting: not forced)");
      if (plan0.floor_room === 0) refuse(`floor: the month's floor-mint cap has no room at ${iso(o.at)} (floor_room 0) - that is the floorcap leg; for a floor mint pick a clock in a month with room`);
      return { reserve: Math.max(0, int(plan0.floor) - iss - m) };
    }
    case "floorcap": {
      const room = plan0.floor_room;
      if (room === null || room === undefined) refuse("floorcap: the floor mint has no monthly cap (mintcap_floor -1) - nothing can bind");
      if (plan0.floor_daily <= 0) refuse("floorcap: fed_floor_mint_daily is 0 - the floor never mints");
      if (room >= plan0.floor_daily) {
        refuse(`floorcap: the month's floor room (${fmt(room)}) is at least the daily mint (${fmt(plan0.floor_daily)}) - the monthly cap can't bind at ${iso(o.at)}; use a clock in a month whose floor mints used the cap (prod's November copy), never change the cap`);
      }
      return { reserve: Math.max(0, int(plan0.floor) - iss - room - m) };
    }
    case "ceiling": return { reserve: int(plan0.ceiling) + m };
    case "guarantee": {
      if (!c.raw("incentive_guarantee")) refuse("guarantee: incentive_guarantee is off (a setting: not forced)");
      if (!(inp.flags || {}).tr_live) refuse("guarantee: the treasury is off (tr_live) - no Monday guarantee");
      if (!(plan0.guarantee_target > 0)) refuse("guarantee: the week's guarantee target is 0 - nothing to top up");
      return int(inp.pools.incentives) > 0 ? { incentives: 0 } : {};
    }
    case "burn": {
      if (inp.mode !== "accrual") refuse(`burn: the burn engine isn't in accrual mode (${inp.mode || "?"}) - a setting: not forced`);
      return { burn: int(inp.pools.burn) + BURN_AMOUNT };
    }
    case "overflow": {
      const cap = Math.max(E.heistCap(inp, c, "fortknox", Number(inp.now)), int(extra.fkCapNow));
      return { fortknox: cap + m };
    }
  }
  return {};
}
/** The legs that take `before` to `want` between system pools only: [[pool, amount], ...] (debits first), net 0. */
function transfers(before, want) {
  const b = {};
  for (const p of TRACKED) b[p] = int(before[p]);
  const out = [];
  for (const [dst, target] of Object.entries(want)) {
    if (!TRACKED.includes(dst)) refuse(`${dst} isn't a system pool`);
    if (!Number.isSafeInteger(target) || target < 0) refuse(`unsafe target for ${dst}: ${target}`);
    const change = target - b[dst];
    if (change < 0) {
      if (dst === "burn") refuse("nothing is taken out of the burn reserve");
      const sink = dst === "reserve" ? "incentives" : "reserve";
      out.push([dst, change], [sink, -change]);
      b[dst] = target; b[sink] += -change;
    } else if (change > 0) {
      let left = change;
      for (const src of SOURCES) {
        if (src === dst || Object.hasOwn(want, src)) continue;
        const n = Math.min(left, b[src]);
        if (n > 0) { out.push([src, -n], [dst, n]); b[src] -= n; b[dst] += n; left -= n; }
        if (!left) break;
      }
      if (left) refuse(`not enough PAT in the system pools for ${dst} = ${fmt(target)} (${fmt(left)} short; never a wallet, the House or an escrow pool) - this copy can't reach the leg`);
    }
  }
  const merged = new Map();
  for (const [p, n] of out) merged.set(p, (merged.get(p) || 0) + n);
  return [...merged].filter(([, n]) => n).sort((a, z) => a[1] - z[1]);
}
/** The inputs as they would read after `legs` (the plan a setup would reach, nothing written). */
function shifted(inp, legs) {
  const x = JSON.parse(JSON.stringify(inp));
  for (const [p, n] of legs) if (x.pools && p in x.pools) x.pools[p] = int(x.pools[p]) + n;
  return x;
}
async function tracked() {
  const P = require("../pools");
  const out = {};
  for (const p of TRACKED) out[p] = await P.balance(p);
  return out;
}

async function previewLeg(o) {
  const ci = await info(o);
  checkDay(o, ci);
  const inp = await legInputs(o, ci);
  const plan0 = planOf(o, inp);
  const extra = {};
  if (o.leg === "overflow") {
    const E = require("../policy/engines");
    const nowS = realNow() / 1000;
    const real = await require("../policy/gather").daily(nowS, ci.did);
    extra.fkCapNow = E.heistCap(real, E.C(real), "fortknox", nowS);
  }
  const want = wanted(o, inp, plan0, extra);
  const legs = transfers(await tracked(), want);
  const plan1 = planOf(o, shifted(inp, legs));
  return { ci, inp, plan0, want, legs, plan1, reached: reached(o.leg, plan1), extra };
}

// ── setup ──
async function setup(o) {
  valid(o);
  noWindow();
  const D = require("../dbUtils"), C = require("../policy/core"), P = require("../pools");
  await C.init(); await P.init();
  if (NOTICE_LEGS.has(o.leg) && !o.allowNotices) {
    const nr = await noticeRisk();
    if (nr.links || nr.unsent) {
      refuse(`${o.leg}: this copy holds ${riskText(nr)} (prod's, kept by the refresh) - its tagged epoch pays stakers and a staking ` +
             "notice becomes a Telegram alert staging Pepe would deliver if he had a bot token. Scrub the copy first (runbook section " +
             "15.2: DELETE FROM telegram_links; DELETE FROM telegram_outbox WHERE sent_at IS NULL) or, once staging Pepe is confirmed " +
             "to have no Telegram token, --allow-notices - nothing moved");
    }
  }
  const key = keyOf(o);
  return D.tx(async () => {
    const old = await C.meta(key);
    if (old) {
      if (old.at !== o.at) refuse(`tag ${o.tag} is already bound to ${o.leg} at ${iso(old.at)} - use a fresh tag`);
      return Object.assign({}, old, { dup: true });
    }
    const others = await D.getQuery("SELECT key FROM policy_meta WHERE key LIKE ? AND key <> ?", [`rehearse:${o.tag}:%`, key]);
    if (others.length) refuse(`tag ${o.tag} is already used by ${others.map((r) => r.key).join(", ")} - one leg per tag (they share the period ids)`);
    const used = await D.getQuery("SELECT key FROM policy_runs WHERE period LIKE ? UNION SELECT key FROM policy_sims WHERE period LIKE ? LIMIT 5", [`%-${o.tag}`, `%-${o.tag}`]);
    if (used.length) refuse(`tag ${o.tag} already has periods (${used.map((r) => r.key).join(", ")}) - use a fresh tag`);
    if (!(await P.live())) refuse("the pools aren't live on this site - not a post-cutover copy");
    const pv = await previewLeg(o);
    if (!pv.reached) refuse(`${o.leg}: the configuration / journal keeps the leg from being reached at ${iso(o.at)} - nothing moved; never change a setting to force it (plan: ${JSON.stringify(fieldsOf(LEGS[o.leg].kind, pv.plan1))})`);
    const before = await tracked();
    let result = { ok: true, moved: false };
    if (pv.legs.length) {
      result = await P.move({ key, legs: pv.legs, flow: "policy_rehearsal", why: `forced ${o.leg} (rehearsal ${o.tag})`.slice(0, 120), via: "staging" });
      if (!result || !result.ok) refuse(`the setup move was refused (${(result && (result.error || result.code)) || "?"}) - nothing moved`);
      result = { ok: true, moved: true, dup: !!result.dup };
    }
    const after = await tracked();
    for (const p of TRACKED) {
      const want = before[p] + pv.legs.filter(([q]) => q === p).reduce((t, [, n]) => t + n, 0);
      if (after[p] !== want) refuse(`setup balance mismatch on ${p} - rolled back`);
    }
    // the plan from the database as it is now (in this transaction): the leg must be reached
    const inp = await legInputs(o, pv.ci);
    const plan = planOf(o, inp);
    if (!reached(o.leg, plan)) refuse(`${o.leg}: not reached after the setup - rolled back; nothing moved (plan: ${JSON.stringify(fieldsOf(LEGS[o.leg].kind, plan))})`);
    const record = { v: 1, key, leg: o.leg, tag: o.tag, at: o.at, at_iso: iso(o.at), margin: o.margin || MARGIN_DEFAULT, ts: Date.now(),
                     periods: periodsOf(o, pv.ci), before, after, legs: pv.legs, result, vault_cash: pv.legs.filter(([p, n]) => VAULT_CASH.has(p) && n < 0).map(([p, n]) => [p, n]),
                     preview: fieldsOf(LEGS[o.leg].kind, plan), undone: false };
    await C.setMeta(key, record);
    return record;
  });
}
function periodsOf(o, ci) {
  if (o.leg === "guarantee") return { treasury: [ci.eid, ci.did], monetary: [ci.did] };
  if (o.leg === "overflow") return { treasury: [ci.did] };
  if (o.leg === "burn") return { burn: [`A*${ci.sfx}`] };
  return { monetary: [ci.did] };
}

// ── undo ──
async function undo(o) {
  valid(o);
  noWindow();
  const D = require("../dbUtils"), C = require("../policy/core"), P = require("../pools");
  await C.init(); await P.init();
  const key = keyOf(o);
  return D.tx(async () => {
    const r = await C.meta(key);
    if (!r || r.at !== o.at) refuse(`no setup ${key} at ${iso(o.at)}`);
    if (r.undone) return { ok: true, dup: true, undo: r.undo || null };
    const now = await tracked();
    const moved = TRACKED.filter((p) => now[p] !== int(r.after[p]));
    const rev = r.legs.map(([p, n]) => [p, -n]).sort((a, z) => a[1] - z[1]);
    if (moved.length && !o.afterRun) {
      refuse(`the system pools moved since the setup (${moved.map((p) => `${p} ${fmt(r.after[p])} -> ${fmt(now[p])}`).join(", ")}) - an engine leg or other activity ran. ` +
             "Restore the copy, or --after-run to reverse ONLY the setup's own legs (the engine's legs stay)");
    }
    const burnBack = rev.some(([p, n]) => p === "burn" && n < 0);
    if (burnBack && now.burn !== int(r.after.burn)) refuse("the burn reserve moved since the setup (a burn ran?) - giving the setup back would pay out of the burn reserve: never; restore the copy");
    for (const [p, n] of rev) if (n < 0 && now[p] < -n) refuse(`${p} holds ${fmt(now[p])} - can't give back ${fmt(-n)}: restore the copy`);
    let result = { ok: true, moved: false };
    if (rev.length) {
      result = await P.move({ key: key + ":undo", legs: rev, kind: burnBack ? "rollback" : "move", flow: "policy_rehearsal",
                              why: `undo forced ${o.leg} (rehearsal ${o.tag})`.slice(0, 120), via: "staging" });
      if (!result || !result.ok) refuse(`the undo move was refused (${(result && (result.error || result.code)) || "?"}) - nothing moved`);
      result = { ok: true, moved: true };
    }
    const b = await tracked();
    for (const p of TRACKED) {
      const want = now[p] + rev.filter(([q]) => q === p).reduce((t, [, n]) => t + n, 0);
      if (b[p] !== want) refuse(`undo balance mismatch on ${p} - rolled back`);
    }
    const exact = !moved.length;
    if (exact) for (const p of TRACKED) if (b[p] !== int(r.before[p])) refuse(`undo balance mismatch on ${p} - rolled back`);
    const left = {};
    for (const p of TRACKED) if (b[p] !== int(r.before[p])) left[p] = b[p] - int(r.before[p]);
    const explain = exact ? [] : await movesSince(r.ts, [key, key + ":undo"]);
    const u = { at: Date.now(), exact, after_run: !!o.afterRun, legs: rev, left, explain };
    await C.setMeta(key, Object.assign({}, r, { undone: true, undo: u }));
    return { ok: true, exact, restored: b, left, explain, result };
  });
}
/** The pool moves on the tracked pools since `sinceMs` (but `skip`): {key, kind, flow, pool, amount}. */
async function movesSince(sinceMs, skip = []) {
  const { getQuery } = require("../dbUtils");
  const rows = await getQuery(`SELECT m.key, m.kind, m.flow, l.pool, l.amount, l.ts FROM pool_move_legs l JOIN pool_moves m ON m.key = l.move_key
                               WHERE l.ts >= ? AND l.pool IN (${TRACKED.map(() => "?").join(",")}) ORDER BY l.ts, l.move_key, l.i LIMIT 400`,
                              [Math.trunc(Number(sinceMs) || 0), ...TRACKED]);
  return rows.filter((x) => !skip.includes(x.key));
}

// ── tick ──
async function marks() {
  const { getQuery } = require("../dbUtils");
  const out = {};
  for (const t of ["pool_moves", "policy_runs", "policy_sims", "policy_effects", "fed_records", "policy_mints", "stash_moves", "jackpot_rakes", "pat_burns"]) {
    const has = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length;
    out[t] = has ? Number((await getQuery(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`))[0].m) : null;
  }
  return out;
}
async function rowsAfter(m) {
  const { getQuery } = require("../dbUtils");
  const cols = { pool_moves: "key, kind, net, legs", policy_runs: "key, state, via, error", policy_sims: "key, ok, boundary_ts", policy_effects: "key, kind",
                 fed_records: "kind, key, state, amount, source, month", policy_mints: "key", stash_moves: "*", jackpot_rakes: "jackpotId, amount", pat_burns: "key, id, amount" };
  const out = {};
  for (const [t, at] of Object.entries(m)) {
    if (at === null) continue;
    const rows = await getQuery(`SELECT ${cols[t]} FROM ${t} WHERE rowid > ? ORDER BY rowid LIMIT 200`, [at]);
    if (rows.length) out[t] = rows;
  }
  // (and rows changed in place - a run's state, a sim's boundary - show in inspect)
  return out;
}
async function supplyNow() {
  const A = require("../policy/apply");
  const { getQuery } = require("../dbUtils");
  const w = Number((await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS w FROM users"))[0].w) || 0;
  return (await A.base()) + w;
}
async function tick(o) {
  valid(o);
  noWindow();
  const C = require("../policy/core"), SCH = require("../policy/scheduler");
  await C.init();
  const r = await C.meta(keyOf(o));
  if (!r || r.at !== o.at) refuse(`no setup ${keyOf(o)} at ${iso(o.at)} - run setup first (same --leg/--tag/--at)`);
  if (r.undone) refuse(`${keyOf(o)} was undone - a fresh tag for a new exercise`);
  const engs = await C.engines();
  const only = LEGS[o.leg].engines;
  const m0 = await marks();
  const s0 = await supplyNow();
  const ran = await noTelegram(() => withClock(o.at, () => SCH.pass(o.at, { tag: o.tag, only })));
  const s1 = await supplyNow();
  const rows = await rowsAfter(m0);
  const ev = await inspect(Object.assign({}, o));
  const modes = Object.fromEntries(only.map((e) => [e, engs[e].mode + (engs[e].paused ? " (PAUSED)" : "")]));
  const expect = expectedSupply(o, ev, ran);
  const hints = [];
  if (!ran.length) {
    for (const e of only) {
      if (engs[e].mode === "off") hints.push(`${e} is off here`);
      else if (engs[e].paused) hints.push(`${e} is paused - nothing runs (a tagged tick records nothing)`);
      else if (Number(engs[e].armed_at || 0) > o.at) hints.push(`${e} was armed at ${iso(engs[e].armed_at)}, after --at: its periods never run`);
    }
    if (!hints.length) hints.push("nothing due (already ran / recorded for this tag?) - see inspect");
  }
  const supply = { before: s0, after: s1, delta: s1 - s0, expected: expect,
                   note: expect === null ? "not checked (no live run in this pass)" : s1 - s0 === expect ? "reconciled" : `differs by ${fmt(s1 - s0 - expect)} - other activity on this database during the pass?` };
  const summary = [`tick ${o.leg} tag ${o.tag} at ${iso(o.at)}: engines ${Object.entries(modes).map(([e, x]) => `${e}=${x}`).join(" ")}`,
                   `ran: ${ran.length ? ran.join("; ") : "nothing" + (hints.length ? " (" + hints.join("; ") + ")" : "")}`,
                   `supply ${fmt(s0)} -> ${fmt(s1)} (${s1 - s0 >= 0 ? "+" : ""}${fmt(s1 - s0)}; expected ${expect === null ? "-" : fmt(expect)}: ${supply.note})`,
                   ...ev.summary];
  return { summary, leg: o.leg, tag: o.tag, at: iso(o.at), modes, ran, supply, rows_written: rows, evidence: ev.evidence, verdict: ev.verdict,
           note: "A wait, an empty `ran`, a failed run, a missing Pepe report or ok != 1 is NOT a pass. No mode, pause or ownership was changed; no test clock was written." };
}
/** The supply change a live run of this pass should make: the monetary day's mints; a burn's amount; 0 for the treasury. */
function expectedSupply(o, ev, ran) {
  if (!ran.some((x) => /^(monetary|treasury|burn) /.test(x))) return null;
  let d = 0;
  for (const r of ev.evidence.runs) {
    if (r.via !== "site" || r.state !== "done") continue;
    if (!ran.some((x) => x.startsWith(`${r.engine} ${r.period}`))) continue;
    const res = r.result || {};
    if (r.engine === "monetary") {
      const done = res.done_legs || [];
      if (done.includes(`floor-${r.period}`)) d += int(res.floor_mint);
      if (done.includes(`iss-${r.period}`)) d += int(res.issuance);
    }
    if (r.engine === "burn") d -= int(res.amount);
  }
  return d;
}

// ── inspect ──
const J = (s, d = null) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
async function evidenceOf(tag, sinceMs) {
  const { getQuery } = require("../dbUtils");
  const has = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
  const sfx = `%-${tag}`;
  const runs = (await getQuery("SELECT key, engine, period, state, via, error, plan, result, created, done FROM policy_runs WHERE period LIKE ? ORDER BY created, key", [sfx]))
    .map((r) => Object.assign(r, { plan: J(r.plan), result: J(r.result) }));
  const sims = (await getQuery(`SELECT key, mode, engine, period, ok, boundary_ts, site_plan, site_boundary_plan, pepe_plan, engine_diff, input_diff, total_diff, blocking,
                                       whitelisted, truncated, pepe_cfg FROM policy_sims WHERE period LIKE ? ORDER BY key`, [sfx]))
    .map((r) => Object.assign(r, { site_plan: J(r.site_plan), site_boundary_plan: J(r.site_boundary_plan), pepe_plan: J(r.pepe_plan), engine_diff: J(r.engine_diff, []),
                                   input_diff: J(r.input_diff, []), total_diff: J(r.total_diff, []), blocking: J(r.blocking, {}), whitelisted: J(r.whitelisted, {}), pepe_cfg: J(r.pepe_cfg) }));
  const effects = (await getQuery("SELECT key, kind, engine, period, data, created, acked_at FROM policy_effects WHERE period LIKE ? OR key LIKE 'cap_hit:%' ORDER BY created, rowid", [sfx]))
    .map((r) => Object.assign(r, { data: J(r.data, {}) }));
  const fed = (await has("fed_records")) ? (await getQuery("SELECT kind, key, state, amount, source, month, ts FROM fed_records WHERE key LIKE ? OR key LIKE ? ORDER BY ts", [sfx, `%-${tag}-%`])) : [];
  const mints = (await has("policy_mints")) ? await getQuery("SELECT key, rec FROM policy_mints WHERE key LIKE ?", [sfx]) : [];
  const burnKeys = effects.filter((e) => e.kind === "burn").map((e) => `burn:${e.data.key}`);
  const moves = await getQuery(`SELECT key, kind, flow, net, legs, ts FROM pool_moves WHERE key LIKE ? OR key LIKE ? OR key LIKE ?
                                ${burnKeys.length ? `OR key IN (${burnKeys.map(() => "?").join(",")})` : ""} ORDER BY ts, key`,
                                [`rehearse:${tag}:%`, `%-${tag}:%`, `%-${tag}-%`, ...burnKeys]);
  const burnsSince = sinceMs ? await getQuery(`SELECT m.key, m.ts, -l.amount AS amount FROM pool_moves m JOIN pool_move_legs l ON l.move_key = m.key
                                              WHERE m.kind = 'burn' AND l.pool = 'burn' AND l.amount < 0 AND m.ts >= ? ORDER BY m.ts`, [Math.trunc(sinceMs)]) : [];
  const receipts = (await getQuery("SELECT key, value FROM policy_meta WHERE key LIKE ? ORDER BY key", [`rehearse:${tag}:%`])).map((r) => J(r.value, {}));
  return { receipts, runs, sims, effects, fed_records: fed, policy_mints: mints.map((r) => Object.assign(r, { rec: J(r.rec) })), moves: moves.map((x) => Object.assign(x, { legs: J(x.legs, []) })), burns_since_setup: burnsSince };
}
async function inspect(o) {
  if (!TAG_RE.test(o.tag || "")) refuse("--tag: 3-8 lowercase letters / digits, a letter first");
  const { getQuery } = require("../dbUtils");
  const rec = o.leg ? (J(((await getQuery("SELECT value FROM policy_meta WHERE key = ?", [`rehearse:${o.tag}:${o.leg}`]))[0] || {}).value)) : null;
  const recs = (await getQuery("SELECT value FROM policy_meta WHERE key LIKE ?", [`rehearse:${o.tag}:%`])).map((r) => J(r.value, {}));
  // the burns since the setup matter to the burn leg only (any slot may burn its PAT: the site's tagged one or its own real one)
  const since = Math.min(...recs.filter((r) => r.leg === "burn").map((r) => Number(r.ts) || Infinity));
  const ev = await evidenceOf(o.tag, Number.isFinite(since) ? since : null);
  const legs = o.leg ? [o.leg] : [...new Set(recs.map((r) => r.leg).filter(Boolean))];
  const verdict = [];
  for (const leg of legs) verdict.push(...verdictOf(leg, ev, recs.find((r) => r.leg === leg) || rec));
  const summary = [];
  const kindOf = (engine, period) => require("../policy/scheduler").kindOf(engine, String(period).replace(new RegExp(`-${o.tag}$`), "")) || engine;
  for (const s of ev.sims) {
    if (s.engine === "derived") continue;                       // a tagged pass's derived dual-read row (PO-4): not a leg's evidence
    const kind = kindOf(s.engine, s.period);
    const site = fieldsOf(kind, s.site_boundary_plan || s.site_plan), pepe = fieldsOf(kind, s.pepe_plan);
    summary.push(`${s.key}: ok=${s.ok === null ? "-" : s.ok} ${s.boundary_ts == null ? "NO boundary snapshot" : "vs the boundary snapshot"}${s.pepe_plan ? "" : " - no Pepe report yet"}`);
    for (const k of Object.keys(site || pepe || {})) {
      const a = (site || {})[k], b = (pepe || {})[k];
      if (k === "legs") continue;
      summary.push(`    ${k.padEnd(18)} site ${JSON.stringify(a)}${s.pepe_plan ? `  pepe ${JSON.stringify(b)}${JSON.stringify(a) === JSON.stringify(b) ? "" : "  <- differs"}` : ""}`);
    }
    const bl = s.blocking || {};
    const bad = [...(bl.plan || []), ...(bl.inputs || []).map((x) => "inputs " + x), ...(bl.decision || []).map((x) => "decision " + x), ...(s.engine_diff || []).map((x) => "engine " + x)];
    if (bad.length) summary.push(`    blocking: ${bad.slice(0, 8).join(" | ")}`);
  }
  for (const r of ev.runs) {
    summary.push(`run ${r.key}: ${r.state}${r.via ? " via " + r.via : ""}${r.error ? " - " + r.error : ""}${r.result && r.result.conserved !== undefined ? ` conserved=${r.result.conserved}` : ""}`);
    const f = r.engine === "burn" ? { amount: (r.result || {}).amount, id: (r.result || {}).id } : fieldsOf(kindOf(r.engine, r.period), r.plan);
    for (const [k, v] of Object.entries(f || {})) summary.push(`    ${k.padEnd(18)} site ${JSON.stringify(v)}`);
  }
  for (const x of ev.moves) summary.push(`move ${x.key} (${x.kind}${x.flow ? ", " + x.flow : ""}) net ${fmt(x.net)}: ${x.legs.map(([p, n]) => `${p} ${n > 0 ? "+" : ""}${fmt(n)}`).join(", ")}`);
  for (const b of ev.burns_since_setup) if (!ev.moves.some((x) => x.key === b.key)) summary.push(`burn since the setup ${b.key}: ${fmt(b.amount)} PAT (${iso(b.ts / 1000)})`);
  for (const f of ev.fed_records) summary.push(`fed_records ${f.kind} ${f.key}: ${f.state} ${fmt(f.amount)} (${f.source}, ${f.month})`);
  const months = new Set(recs.filter((r) => /^floor/.test(r.leg || "")).map((r) => iso(r.at).slice(0, 7)));
  for (const e of ev.effects.filter((x) => x.kind === "cap_hit" && [...months].some((m) => x.key.endsWith(`-${m}`)))) summary.push(`effect ${e.key}: wanted ${fmt(e.data.wanted)}, room ${fmt(e.data.room)}${e.acked_at ? " (acked)" : ""}`);
  summary.push(...verdict);
  return { summary, evidence: ev, verdict };
}

/** PASS / FAIL / WAIT lines of one leg from its evidence (shadow: Pepe's report vs the site's boundary snapshot; live: the site's run). */
function verdictOf(leg, ev, rec) {
  const out = [];
  if (!rec) return [`WAIT ${leg}: no setup receipt for this tag`];
  const periods = rec.periods || {};
  const monetaryP = (periods.monetary || [])[0];
  const treasuryD = (periods.treasury || []).find((p) => /^D/.test(p));
  const engine = leg === "overflow" ? "treasury" : leg === "burn" ? "burn" : "monetary";
  const period = leg === "overflow" ? treasuryD : monetaryP;
  // shadow: Pepe ran it, the site compared
  const sim = period ? ev.sims.find((s) => s.engine === engine && s.period === period && s.mode === "shadow") : null;
  if (sim) {
    if (!sim.pepe_plan) out.push(`WAIT shadow ${leg}: the site has ${sim.boundary_ts == null ? "its plan" : "its boundary snapshot"} for ${period} - no Pepe report yet (run staging Pepe's engine at this tag)`);
    else if (Number(sim.ok) !== 1) {
      const bl = sim.blocking || {};
      out.push(`FAIL shadow ${leg}: ${engine} ${period} NOT clean${sim.boundary_ts == null ? " (no boundary snapshot)" : ""}: ${[...(bl.plan || []), ...(bl.inputs || []).map((x) => "inputs " + x), ...(bl.decision || []).map((x) => "decision " + x), ...(sim.engine_diff || []).map((x) => "engine " + x)].slice(0, 6).join(" | ") || "?"}`);
    } else if (!reached(leg, sim.pepe_plan)) out.push(`FAIL shadow ${leg}: ${engine} ${period} clean but Pepe's plan didn't reach the leg (${JSON.stringify(fieldsOf(engine === "treasury" ? "daily" : engine, sim.pepe_plan))})`);
    else out.push(`PASS shadow ${leg}: ${engine} ${period} ok=1 vs the boundary snapshot - Pepe's plan = the site's (${shadowLine(leg, sim.pepe_plan)})`);
    if (leg === "guarantee") {
      for (const p of periods.treasury || []) {
        const s2 = ev.sims.find((s) => s.engine === "treasury" && s.period === p && s.mode === "shadow");
        out.push(!s2 ? `WAIT shadow guarantee: no treasury ${p} comparison yet (Pepe's epoch, then his daily, at this tag)`
                 : Number(s2.ok) === 1 ? `PASS shadow guarantee: treasury ${p} ok=1` : `FAIL shadow guarantee: treasury ${p} ${s2.pepe_plan ? "NOT clean" : "no Pepe report"}`);
      }
    }
  }
  if (leg === "burn") {
    const sinceBurned = (ev.burns_since_setup || []).reduce((t, b) => t + int(b.amount), 0);
    const site = ev.runs.filter((r) => r.engine === "burn" && r.state === "done");
    const need = int((rec.legs.find(([p]) => p === "burn") || [null, 0])[1]);
    if (sinceBurned >= need && need > 0) out.push(`PASS burn: ${fmt(sinceBurned)} PAT burned since the setup (${(ev.burns_since_setup || []).map((b) => b.key).join(", ")})${site.length ? ` - the site's tagged slot ${site.map((r) => r.period).join(", ")}` : " - by the accrual on its real slot"}; the closed day's shadow:burn:D<day> row compares after 04:01 UTC the next day`);
    else out.push(`WAIT burn: ${fmt(sinceBurned)} of ${fmt(need)} PAT burned since the setup (live: tick; shadow: staging Pepe's accrual every ${5} min)`);
    return out;
  }
  // live: the site ran it
  const run = period ? ev.runs.find((r) => r.engine === engine && r.period === period) : null;
  if (!run) { if (!sim) out.push(`WAIT ${leg}: neither a site run nor a shadow comparison of ${engine} ${period} yet`); return out; }
  if (run.state === "failed") return out.concat(`FAIL live ${leg}: ${run.key} failed: ${run.error || "?"}`);
  if (run.state === "missed") return out.concat(`FAIL live ${leg}: ${run.key} missed: ${run.error || "?"}`);
  if (run.state !== "done") return out.concat(`WAIT live ${leg}: ${run.key} is ${run.state}`);
  const plan = run.plan || {}, res = run.result || {};
  const moveOnce = (tid) => ev.moves.filter((x) => x.key === `${tid}:out` || x.key === `${tid}:in`).length === 2;
  if (!reached(leg, plan)) return out.concat(`FAIL live ${leg}: ${run.key} ran but its plan didn't reach the leg (${JSON.stringify(fieldsOf(LEGS[leg].kind, plan))})`);
  const done = res.done_legs || [];
  if (leg === "floor") {
    const key = `floor-${period}`;
    const f = ev.fed_records.find((x) => x.kind === "mint" && x.key === key) || ev.policy_mints.find((x) => x.key === key);
    const amt = f ? int(f.amount !== undefined ? f.amount : (f.rec || {}).amount) : 0;
    out.push(done.includes(key) && amt === int(plan.floor_mint) ? `PASS live floor: minted ${fmt(amt)} once (${key}; need ${fmt(plan.floor_need)}, daily ${fmt(plan.floor_daily)}, room ${fmt(plan.floor_room)}) - supply: see tick`
             : `FAIL live floor: ${key} ${done.includes(key) ? `recorded ${fmt(amt)} vs the plan's ${fmt(plan.floor_mint)}` : `not done (${(res.notes || []).join("; ") || "skipped"})`}`);
  } else if (leg === "floorcap") {
    const key = `floor-${period}`;
    const month = new Date(Number(plan.ts || 0) * 1000).toISOString().slice(0, 7);
    const cap = ev.effects.find((e) => e.key === `cap_hit:floor-${month}`);
    const f = ev.fed_records.find((x) => x.kind === "mint" && x.key === key) || ev.policy_mints.find((x) => x.key === key);
    const minted = f ? int(f.amount !== undefined ? f.amount : (f.rec || {}).amount) : 0;
    const ok = cap && minted === int(plan.floor_mint) && (plan.floor_mint > 0 ? done.includes(key) : !done.includes(key));
    out.push(ok ? `PASS live floorcap: the monthly cap bound - need ${fmt(plan.floor_need)}, daily ${fmt(plan.floor_daily)}, room ${fmt(plan.floor_room)} -> minted ${fmt(minted)}; cap notice ${cap.key}`
                : `FAIL live floorcap: minted ${fmt(minted)} (plan ${fmt(plan.floor_mint)}), cap notice ${cap ? cap.key : "MISSING"}`);
  } else if (leg === "guarantee") {
    const tid = `mo-${period}-guarantee`;
    const ep = ev.runs.find((r) => r.engine === "treasury" && /^W/.test(r.period)), dl = ev.runs.find((r) => r.engine === "treasury" && r.period === treasuryD);
    const ok = done.includes(tid) && moveOnce(tid) && int(res.guarantee_paid) > 0 && ep && ep.state === "done" && dl && dl.state === "done";
    out.push(ok ? `PASS live guarantee: the epoch ${ep.period} and the release ${dl.period} first, then the top-up ${fmt(res.guarantee_paid)} once (${tid}; target ${fmt(plan.guarantee_target)}, base ${fmt(plan.guarantee_base)}); conserved=${ep.result && ep.result.conserved}`
                : `FAIL live guarantee: epoch ${ep ? ep.state : "not run"}, release ${dl ? dl.state : "not run"}, ${tid} ${done.includes(tid) ? "done" : "not done"} (paid ${fmt(res.guarantee_paid)})`);
  } else if (leg === "ceiling") {
    const tid = `mo-${period}-ceiling`;
    out.push(done.includes(tid) && moveOnce(tid) ? `PASS live ceiling: released ${fmt(res.excess)} once to ${plan.ceiling_action === "burn" ? "the burn reserve" : "incentives"} (${tid}; fed_ceiling_action ${plan.ceiling_action})`
             : `FAIL live ceiling: ${tid} ${done.includes(tid) ? "moved twice / once-sided" : "not done"}`);
  } else if (leg === "overflow") {
    const tids = (plan.legs || []).filter((l) => /-fkover(-loan)?$/.test(l.tid)).map((l) => l.tid);
    const ok = tids.length && tids.every((t) => done.includes(t) && moveOnce(t)) && res.conserved === true;
    out.push(ok ? `PASS live overflow: ${fmt(plan.overflow)} over the cap moved once (${tids.join(", ")}; loans repaid ${fmt(plan.overflow_loan_repaid)}); conserved=true`
                : `FAIL live overflow: ${tids.join(", ") || "no overflow leg"} ${res.conserved === true ? "" : "conserved=" + res.conserved}`);
  }
  return out;
}
function shadowLine(leg, p) {
  if (leg === "floor" || leg === "floorcap") return `floor_need ${fmt(p.floor_need)}, daily ${fmt(p.floor_daily)}, room ${fmt(p.floor_room)}, floor_mint ${fmt(p.floor_mint)}`;
  if (leg === "guarantee") return `target ${fmt(p.guarantee_target)}, base ${fmt(p.guarantee_base)}, paid ${fmt(p.guarantee_paid)}`;
  if (leg === "ceiling") return `fed ${fmt(p.fed)}, excess ${fmt(p.excess)} -> ${p.ceiling_action}`;
  if (leg === "overflow") return `fortknox ${fmt(p.fortknox)}, overflow ${fmt(p.overflow)} (loans ${fmt(p.overflow_loan_repaid)})`;
  return "";
}

/** Read only: the setups whose forced state is still in the system pools - a receipt not undone that moved something (a burn
 *  setup counts only until its PAT was burned: a burn is final, its undo is refused once it ran). `ran`: the system pools moved
 *  since the setup (an engine leg or other activity), so its undo needs --after-run. */
async function openSetups() {
  const { getQuery } = require("../dbUtils");
  const now = await tracked();
  const out = [];
  for (const row of await getQuery("SELECT key, value FROM policy_meta WHERE key LIKE 'rehearse:%' ORDER BY key")) {
    const r = J(row.value, null);
    if (!r || r.undone || !Array.isArray(r.legs) || !r.legs.length || !LEGS[r.leg]) continue;
    if (r.leg === "burn") {
      const need = int((r.legs.find(([p]) => p === "burn") || [null, 0])[1]);
      const burned = Number((await getQuery(`SELECT COALESCE(SUM(-l.amount), 0) AS b FROM pool_moves m JOIN pool_move_legs l ON l.move_key = m.key
                                             WHERE m.kind = 'burn' AND l.pool = 'burn' AND l.amount < 0 AND m.ts >= ?`, [Math.trunc(Number(r.ts) || 0)]))[0].b) || 0;
      if (need > 0 && burned >= need) continue;
    }
    const ran = TRACKED.some((p) => int(now[p]) !== int((r.after || {})[p]));
    out.push({ key: r.key || row.key, leg: r.leg, tag: r.tag, at: r.at, at_iso: r.at_iso || iso(r.at), ts: r.ts, legs: r.legs, ran });
  }
  return out;
}

// ── status (read only) ──
async function status(o) {
  if (o.leg !== undefined && !Object.hasOwn(LEGS, o.leg)) refuse("--leg: " + Object.keys(LEGS).join(" | "));
  const C = require("../policy/core"), S = require("../policy/source"), E = require("../policy/engines"), P = require("../pools");
  const { getQuery } = require("../dbUtils");
  const engs = await C.engines();
  const own = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'policy_ownership'")).length
    ? (await getQuery("SELECT feature, owner, paused FROM policy_ownership")) : [];
  const clock = await C.meta("test_clock");
  const src = await S.read();
  const pools = await tracked();
  const summary = [];
  for (const e of C.ENGINES) summary.push(`engine ${e.padEnd(9)} ${engs[e].mode}${engs[e].paused ? " PAUSED" : ""} armed ${engs[e].armed_at ? iso(engs[e].armed_at) : "-"}`);
  summary.push(`owners ${own.map((r) => `${r.feature}=${r.owner}${r.paused ? " (paused)" : ""}`).join(" ") || "(no policy_ownership)"} · pools live ${await P.live()}`);
  if (clock && Number(clock.offset_ms)) summary.push(`WARN the database carries a test clock (${iso((Date.now() + Number(clock.offset_ms)) / 1000)}): the staging site's own scheduler runs at it - clear it (POST /api/policy/admin/test-clock {at:null}) unless you set it on purpose`);
  summary.push(`push ${src.at ? Math.round(Date.now() / 1000 - Number(src.at)) + " s old" : "never"} · bot_version ${src.bot_version || "-"} · cfg from ${src.from}`);
  summary.push(`pools ${TRACKED.map((p) => `${p} ${fmt(pools[p])}`).join(" · ")}`);
  const nr = await noticeRisk();
  if (nr.links || nr.unsent) {
    summary.push(`WARN this copy holds ${riskText(nr)}: a tagged epoch's staking notices (and ops alerts) become alerts staging Pepe ` +
                 "would deliver if he had a Telegram token - scrub the copy (runbook section 15.2) or confirm he has none (setup refuses guarantee / overflow until then unless --allow-notices)");
  }
  const open = await openSetups();
  for (const r of open) {
    summary.push(`open setup ${r.key} at ${r.at_iso} (set up ${new Date(Number(r.ts) || 0).toISOString()}): moved ${r.legs.map(([p, n]) => `${p} ${n > 0 ? "+" : ""}${fmt(n)}`).join(", ")}` +
                 ` - undo --leg=${r.leg} --tag=${r.tag} --at=${r.at_iso}${r.ran ? " --after-run (an engine leg ran since)" : ""}`);
  }
  if (open.length) {
    const soon = nearRun();
    summary.push(`${soon ? "FAIL" : "WARN"} ${open.length} open setup(s): the real 04:00 UTC run acts on a forced state - undo every one before 03:30 UTC` +
                 `${soon ? " (the run is less than an hour and a half away)" : ""}`);
  }
  const out = { summary, engines: engs, owners: own, test_clock: clock, pools, notices: nr, open_setups: open, legs: {} };
  if (Number.isFinite(o.at)) {
    const c = E.C({ cfg: (await S.config()).cfg, consts: src.consts });
    summary.push(`settings fed_floor ${fmt(c.raw("fed_floor"))} · fed_ceiling ${fmt(c.raw("fed_ceiling"))} · fed_floor_mint_daily ${fmt(c.raw("fed_floor_mint_daily"))} · mintcap_floor ${fmt(c.raw("mintcap_floor"))} · fed_ceiling_action ${c.raw("fed_ceiling_action")} · incentive_guarantee ${c.raw("incentive_guarantee")} · guarantee_scaled ${!!c.raw("guarantee_scaled")} · heist_cap_mode ${c.raw("heist_cap_mode")}`);
    for (const leg of o.leg ? [o.leg] : Object.keys(LEGS)) {
      const x = Object.assign({}, o, { leg, tag: o.tag || "status" });
      try {
        const pv = await previewLeg(x);
        out.legs[leg] = { reached: pv.reached, legs: pv.legs, plan: fieldsOf(LEGS[leg].kind, pv.plan1), already: !pv.legs.length };
        summary.push(`leg ${leg.padEnd(9)} ${pv.reached ? "reachable" : "NOT reachable"}: ${pv.legs.length ? "setup moves " + pv.legs.map(([p, n]) => `${p} ${n > 0 ? "+" : ""}${fmt(n)}`).join(", ") + (pv.legs.some(([p, n]) => VAULT_CASH.has(p) && n < 0) ? " (uses Bank / Market-maker cash)" : "") : "already there - the setup moves nothing"}${pv.reached ? " -> " + (shadowLine(leg, pv.plan1) || `burn reserve ${fmt(pv.plan1.burn)}`) : ""}`);
      } catch (e) {
        if (!e.refused) throw e;
        out.legs[leg] = { reached: false, refused: e.message };
        summary.push(`leg ${leg.padEnd(9)} refused at ${iso(o.at)}: ${e.message}`);
      }
    }
  }
  return out;
}

// ── snapshot / cutcheck (read only): the H2a verify ("the import wrote zero PAT rows", every handed period, supply) ──
const SNAP_TABLES = ["pool_moves", "pool_move_legs", "stash_moves", "jackpot_rakes", "fed_records", "policy_mints", "pat_burns", "transactions"];
async function snapshot() {
  const { getQuery } = require("../dbUtils");
  const at = Date.now();                                    // before the reads: a row written while they run counts as "since"
  const rows = {}, maxes = {};
  for (const t of SNAP_TABLES) {
    if (!(await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length) { rows[t] = null; maxes[t] = null; continue; }
    const r = (await getQuery(`SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS m FROM ${t}`))[0];
    rows[t] = Number(r.n); maxes[t] = Number(r.m);
  }
  const supply = await supplyNow();
  const C = require("../policy/core");
  const engs = await C.engines();
  return { summary: [`snapshot: ${Object.entries(rows).map(([t, n]) => `${t} ${n === null ? "-" : n}`).join(" · ")} · supply ${fmt(supply)}`],
           at, rows, maxes, pool_moves_max: maxes.pool_moves, supply, engines: Object.fromEntries(Object.entries(engs).map(([e, r]) => [e, r.mode])) };
}
/** The period an engine row's key belongs to, among `periods` (longest first: a tagged "D...-lceil" before the plain day), or null.
 *  Keys: tr-<did>-..., wf-<eid>-..., mo-<did>-..., act-<did>-..., fedmint-floor-<did> / fedmint-iss-<did>, floor- / iss-<did>
 *  (fed_records), pol-<leg key> (the House's jackpot_rakes). */
function periodOfKey(key, periods) {
  const k = String(key || "").replace(/^pol-/, "").replace(/^fedmint-/, "").replace(/^(?:tr|wf|mo|act|floor|iss)-/, "");
  for (const p of periods) if (k === p || k.startsWith(p + "-") || k.startsWith(p + ":")) return p;
  return null;
}
async function cutcheck(o) {
  if (!o.before) refuse("--before=<the snapshot JSON saved before the cutover>");
  const before = J(fs.readFileSync(path.resolve(o.cwd || process.cwd(), o.before), "utf8"));
  if (!before || !before.rows) refuse("--before isn't a snapshot (node tools/policy-rehearse.js snapshot --json > file)");
  if (!before.maxes || !Number.isFinite(Number(before.at))) refuse("--before is a snapshot without row marks (an older kit's) - take a new one before the cutover");
  const now = await snapshot();
  const S = require("../policy/source"), C = require("../policy/core");
  const { getQuery } = require("../dbUtils");
  const src = await S.read();
  const lines = [];
  const add = (ok, s) => lines.push(`${ok ? "PASS" : "FAIL"} ${s}`);
  const info = (s) => lines.push(`INFO ${s}`);
  const engs = await C.engines();
  add(C.ENGINES.every((e) => engs[e].mode === "live"), `engines live on the site: ${C.ENGINES.map((e) => `${e}=${engs[e].mode}`).join(" ")}`);
  // what Pepe's handshake hands over (pepe_policyclient._p4_handover): every done epoch of his journal, his last 30 done release
  // days and monetary days
  const last30 = (l) => [...new Set((l || []).map(String))].sort().slice(-30);
  const want = [...(src.journal || []).filter((r) => r && r.eid && r.state === "done").map((r) => ["treasury", r.eid]),
                ...last30(src.days_done).map((d) => ["treasury", d]), ...last30(src.mo_days_done).map((d) => ["monetary", d])];
  const missing = [];
  for (const [e, p] of want) { const r = await C.run(e, String(p)); if (!r || !["handed", "done"].includes(r.state)) missing.push(`${e}:${p}`); }
  add(!missing.length, `every period in Pepe's pushed journals is handed / done here (${want.length})${missing.length ? ": missing " + missing.slice(0, 12).join(", ") : ""}`);

  // The rows since the snapshot, by cause. The cutover itself writes none (policy_runs / policy_engines / policy_meta /
  // policy_audit only); what does land meanwhile is live activity: the site's own burn accrual (live from the cutover on: one
  // burn per accrual slot of whatever is in the burn reserve), its runs of periods that fell due, Pepe's last burns before his
  // switches went off, charges, payouts. Only a hand-over row or a row of a period Pepe handed is a FAIL.
  const since = Math.trunc(Number(before.at));
  const mark = (t) => int((before.maxes || {})[t]);
  const handed = new Set(want.map(([, p]) => String(p)));
  const siteRuns = await getQuery("SELECT engine, period FROM policy_runs WHERE via = 'site' AND state = 'done' AND COALESCE(done, created) >= ? ORDER BY created", [since]);
  const sitePeriods = new Set(siteRuns.map((r) => r.period));
  const rerun = siteRuns.filter((r) => want.some(([e, p]) => e === r.engine && String(p) === r.period));
  add(!rerun.length, `no period Pepe handed was run by the site since the snapshot${rerun.length ? ": " + rerun.map((r) => `${r.engine}:${r.period}`).join(", ") : ""}`);
  const periods = [...new Set([...handed, ...sitePeriods])].sort((a, z) => z.length - a.length);
  const bad = [], live = new Map(), other = [];
  let siteBurned = 0, otherBurned = 0, minted = 0;
  const newMoves = now.maxes.pool_moves === null ? [] : await getQuery("SELECT key, kind, flow, via, net FROM pool_moves WHERE rowid > ? ORDER BY rowid LIMIT 5000", [mark("pool_moves")]);
  const siteBurnRuns = siteRuns.filter((r) => r.engine === "burn").length;
  for (const m of newMoves) {
    if (m.kind === "burn") { if (m.via === "policy") siteBurned -= int(m.net); else otherBurned -= int(m.net); }
    if (/^fedmint-/.test(m.key)) minted += int(m.net);
    if (m.kind === "cutover" || /hand-?over|cutover|import/i.test(String(m.flow || ""))) { bad.push(`${m.key} (kind ${m.kind}, flow ${m.flow}): a hand-over row`); continue; }
    if (m.via !== "policy") { other.push(m); continue; }
    if (m.kind === "burn") {
      if (!siteBurnRuns) bad.push(`${m.key}: a site burn with no site burn run since the snapshot`);
      else live.set("burn accrual", (live.get("burn accrual") || 0) + 1);
      continue;
    }
    const p = periodOfKey(m.key, periods);
    if (p && handed.has(p) && !sitePeriods.has(p)) bad.push(`${m.key}: a leg of ${p}, a period Pepe handed`);
    else if (p && sitePeriods.has(p)) live.set(p, (live.get(p) || 0) + 1);
    else bad.push(`${m.key}: an engine leg that no site run since the snapshot explains`);
  }
  // the other PAT tables: a row keyed to a period Pepe handed (a waterfall stash leg, a House leg, a floor / issuance mint) is a FAIL
  const keyed = [["stash_moves", "key", ""], ["jackpot_rakes", "jackpotId", ""], ["fed_records", "key", " AND kind = 'mint'"]];
  for (const [t, col, where] of keyed) {
    if (now.maxes[t] === null || now.maxes[t] === undefined) continue;
    const rows = await getQuery(`SELECT ${col} AS k FROM ${t} WHERE rowid > ?${where} ORDER BY rowid LIMIT 5000`, [mark(t)]);
    for (const r of rows) {
      const p = periodOfKey(r.k, periods);
      if (p && handed.has(p) && !sitePeriods.has(p)) bad.push(`${t} ${r.k}: a row of ${p}, a period Pepe handed`);
    }
  }
  const grew = {};
  for (const t of SNAP_TABLES) {
    const a = before.rows[t], b = now.rows[t];
    if (a !== null && a !== undefined && b !== null && b !== undefined && b !== a) grew[t] = b - a;
  }
  const nRows = Object.values(grew).reduce((x, n) => x + n, 0);
  add(!bad.length, `the cutover wrote no PAT row: ${fmt(nRows)} row(s) since the snapshot, none a hand-over row or a row of a period Pepe handed` +
                   `${bad.length ? " - " + bad.slice(0, 8).join(" | ") : ""}`);
  if (live.has("burn accrual")) info(`since the snapshot: the site's live burn accrual burned ${fmt(siteBurned)} PAT (${live.get("burn accrual")} burn move(s): the burn reserve the cutover found, or what reached it since)`);
  const runs = [...live.keys()].filter((k) => k !== "burn accrual");
  if (runs.length) info(`since the snapshot: the site ran ${runs.join(", ")} (${runs.map((k) => live.get(k)).reduce((x, n) => x + n, 0)} engine move(s))`);
  if (other.length || Object.keys(grew).length) {
    const by = {};
    for (const m of other) { const c = /^charge:/.test(m.key) ? "charges" : m.kind === "burn" ? "Pepe's burns" : `${m.via || "?"} ${m.kind}`; by[c] = (by[c] || 0) + 1; }
    info(`since the snapshot, other live activity: ${Object.entries(by).map(([c, n]) => `${c} ${n}`).join(", ") || "no pool move"}` +
         `${otherBurned ? ` (Pepe's burns ${fmt(otherBurned)} PAT)` : ""}; rows ${Object.entries(grew).map(([t, n]) => `${t} ${n > 0 ? "+" : ""}${n}`).join(", ") || "none"}`);
  }
  const burned = siteBurned + otherBurned;
  const expect = int(before.supply) - burned + minted;
  add(now.supply === expect, `supply reconciled: ${fmt(before.supply)} -> ${fmt(now.supply)}` +
      `${burned ? `; burned ${fmt(burned)}` : ""}${minted ? `; minted ${fmt(minted)}` : ""}${burned || minted ? " since the snapshot" : " (no burn or mint since the snapshot)"}` +
      `${now.supply === expect ? "" : ` - expected ${fmt(expect)}, ${fmt(now.supply - expect)} unexplained (run it again if a burn landed while it read)`}`);
  return { summary: lines, before, now, missing, rerun, problems: bad, new_moves: newMoves.slice(0, 50) };
}

// ── the CLI ──
function usage() {
  return "usage: PATV_ENV=staging STAGING=1 node tools/policy-rehearse.js <status|setup|tick|inspect|undo|snapshot|cutcheck> --db=<staging copy>/myapp.db " +
         "[--leg=" + Object.keys(LEGS).join("|") + "] [--tag=<3-8 a-z0-9, a letter first>] [--at=YYYY-MM-DDTHH:MM:SSZ] [--margin=N] [--after-run] [--allow-notices] [--before=file] [--json]";
}
function parseArgs(argv) {
  const o = {};
  const command = argv[0];
  for (const a of argv.slice(1)) {
    if (a === "--after-run") { o.afterRun = true; continue; }
    if (a === "--json") { o.json = true; continue; }
    if (a === "--allow-notices") { o.allowNotices = true; continue; }
    const m = /^--(db|leg|tag|at|margin|before)=(.+)$/.exec(a);
    if (!m) refuse(`unknown option ${a} - ${usage()}`);
    o[m[1]] = m[2];
  }
  if (o.at !== undefined) {
    if (!AT_RE.test(o.at)) refuse("--at must be an explicit UTC time: YYYY-MM-DDTHH:MM:SSZ");
    o.at = Date.parse(o.at) / 1000;
  }
  if (o.margin !== undefined) o.margin = Number(o.margin);
  return { command, o };
}
const COMMANDS = { status, setup, tick, inspect, undo, snapshot, cutcheck };
async function main(argv) {
  const { command, o } = parseArgs(argv);
  if (!Object.hasOwn(COMMANDS, command || "")) refuse(usage());
  const cwd = process.cwd();
  const db = guard(o.db);                               // every check before SQLite loads
  if (["setup", "undo", "tick"].includes(command)) valid(o);
  process.chdir(path.dirname(db));
  o.cwd = cwd;
  // stdout is this tool's alone (a snapshot is saved with `> file`): what the site's modules log goes to stderr
  const out = (s) => process.stdout.write(s + "\n");
  const util = require("util");
  console.log = console.info = (...a) => process.stderr.write(util.format(...a) + "\n");
  // no module that opens SQLite loads before guard() and chdir()
  const D = require("../dbUtils");
  try {
    const tables = new Set((await D.getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
    for (const t of ["users", "pools", "pool_moves", "policy_engines", "policy_runs", "policy_sims", "policy_meta"]) {
      if (!tables.has(t)) refuse(`not an initialized site database: no ${t} table`);
    }
    const r = await COMMANDS[command](o);
    const lg = (legs) => legs.map(([p, n]) => `${p} ${n > 0 ? "+" : ""}${fmt(n)}`).join(", ");
    const lines = r.summary || (command === "setup"
      ? [`setup ${r.leg} tag ${r.tag} at ${r.at_iso}${r.dup ? " (done before: the stored receipt)" : ""}: ${r.legs.length ? `moved ${lg(r.legs)} (pool move ${r.key})` : "nothing to move - the state is already there"}` +
         `${r.vault_cash && r.vault_cash.length ? " - uses Bank / Market-maker cash until the undo" : ""}`, `plan at the setup: ${JSON.stringify(r.preview)}`]
      : command === "undo" ? [r.dup ? "undo: done before" : r.exact ? `undo: every system pool back to the PAT (${r.result && r.result.moved ? "one keyed move" : "nothing to move"})`
        : `undo: the setup's own legs given back; left (the engine's legs / other moves): ${JSON.stringify(r.left)}`] : []);
    if (o.json || command === "snapshot") out(JSON.stringify(r, null, 2));
    else {
      for (const l of lines) out(l);
      out("--- evidence (JSON) ---");
      out(JSON.stringify(Object.assign({}, r, { summary: undefined }), null, 2));
    }
    // (status's only FAIL line: setups still open while the real 04:00 UTC run is near)
    if ((r.verdict || r.summary || []).some((l) => /^FAIL /.test(l))) process.exitCode = 3;
  } finally {
    await new Promise((resolve) => D.db.close(() => resolve()));
  }
}
if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error((e.refused ? "REFUSED: " : "ERROR: ") + e.message);
    process.exitCode = e.refused ? 2 : 1;
  });
}
module.exports = { guard, valid, transfers, wanted, reached, previewLeg, setup, undo, tick, inspect, status, snapshot, cutcheck, verdictOf, withClock,
                   inWindow, nearRun, noticeRisk, noTelegram, openSetups, main, parseArgs, LEGS, SOURCES, TRACKED, BURN_AMOUNT, MARGIN_DEFAULT,
                   _setRealNow: (fn) => { realNow = fn || (() => Date.now()); } };
