// policy/scheduler.js — Phase 4 of the backend migration: ONE site scheduler for the economy's policy engines (the treasury's
// Monday waterfall + daily release, the monetary day, the burn accrual). docs/policy-engines-cutover-runbook.md.
//
// THE CLOCK. Every 15 s the process that holds the lease (policy_lease "scheduler", 90 s, renewed each pass: a restart or a
// second process never runs a pass alongside it) looks at each engine's period NOW - exactly the rules of Pepe's ticks:
//   treasury   (econ_layers + econ_treasury on) the week "W<Monday>" when its 04:00 UTC boundary is after the engine was
//              armed and it hasn't run; then the day "D<date>" likewise (the epoch first, as _tr_tick). PO-1: the epoch WAITS
//              (up to TR_CUTOFF_WAIT, 1 h past the boundary - Pepe's _tr_cutoff_pending) for the capital cut-off that closes
//              the week's PAT-days bucket (the share book's newest cut-off at or after the boundary), in live, dry and shadow
//              alike; the Monday daily waits with it (it runs after the epoch, as _tr_tick). PO-1 review: past the hour it
//              keeps waiting while the SITE'S OWN cut-off is overdue (a site outage across the boundary stops both: the epoch
//              never settles the week on an open bucket) - cutoffWait; an alert after OVERDUE_ALERT_S
//   monetary   (econ_layers on) the day "D<date>"; on the Monday the epoch settles it waits for the epoch (12 h at most, then
//              runs without the guarantee) and for the daily release (1 h at most), as _mo_tick
//   burn       (accrual mode) one burn per accrual_every_min slot "A<slot>"; PO-1: in dry / shadow / live a DAY SUMMARY
//              "<mode>:burn:D<date>" of each closed policy day (04:00 to 04:00 UTC) is recorded once, even at zero - only
//              once the day has closed by the pool history's clock, and the days a pause / an outage skipped are backfilled
// Only the CURRENT period runs (catch-up cap, D-18: a pass after an outage runs today's / this week's once, its result
// flagged "late" - by when a scheduler FIRST SAW the period due, policy_meta "seen:<key>"; every older period that never ran,
// or whose run failed until its period ended, is recorded "missed" and never runs on its own - Pepe's armed_at rule).
// Every value a pass reads from Pepe's policy push (flags, the epoch hour, burn_cfg, his journals) comes through
// policy/source.js (PO-1).
//
// MODES (policy_engines): off · dry (plan and record what WOULD move: policy_sims "dry:<engine>:<period>") · shadow (the same,
// and Pepe's own run is compared: POST /api/policy/bot/report {engine, period, inputs, plan} -> the ENGINE diff = this site's
// plan on Pepe's inputs vs his plan (must be empty: the port), the INPUTS diff = this site's inputs vs his, the TOTAL diff =
// this site's plan on its own inputs vs his) · live (this site runs it - policy/apply.js - and Pepe doesn't: only through the
// cutover handshake, never from the admin page).
// PO-1, THE BOUNDARY (T9): whichever side snapshots second sees the other's legs - so before Pepe moves any leg of an epoch,
// daily or monetary period he asks the site for its snapshot of that moment (POST /api/policy/bot/boundary): the site's inputs
// and plan, taken in ONE dbUtils.tx (the write gate holds every other write: no leg lands half-way through), stored once in
// policy_sims (site_boundary_inputs / site_boundary_plan / boundary_ts) and never overwritten - a report compares against it.
// A comparison is CLEAN (policy_sims.ok = 1, D-15) only when the engine diff is empty AND there is a boundary snapshot AND
// nothing differs - in the plan (boundary plan vs Pepe's), in the INPUTS, or in the site's own DECISIONS taken at the boundary
// (the monetary guarantee flag, boundary_meta) - but the documented WHITELIST below (post-move fields and data no enabled rule
// reads, each under its condition and with a test). Diffs are capped at DIFF_CAP entries (a truncated comparison is never clean).
// PO-1, THE PAUSE (T3): an owner (/admin/economy, password step-up) or the VPS shell (tools/policy-backend.js pause|resume)
// pauses an engine: the scheduler runs nothing for it (a live engine's due periods are recorded missed "paused", nothing is
// handed back, the mode is unchanged); a cutover of a paused engine is refused. Resume: only the CURRENT period may still run
// (flagged late, D-18) - an older one stays missed. PO-1 review: enforced at write time - every live run re-reads the switch
// inside its own transaction (policy/apply.gate), and a "missed paused" record is written in a transaction that re-reads it.
//
// Bot routes (bot token, POST):
//   /api/policy/bot/state    -> {engines, effects (his books' updates not acked yet), lease, cfg_age}
//   /api/policy/bot/config   {cfg}   Pepe's constants, effective econ_cfg, flags, his journals (every 5 min and at start)
//   /api/policy/bot/boundary {engine, period, now, guarantee}   PO-1: the site's snapshot of the period's boundary, taken before
//                            Pepe moves a leg (dry / shadow; idempotent: the first snapshot stays) -> {ok, key, boundary_ts}
//   /api/policy/bot/report   {engine, period, inputs, plan}   shadow: his run, compared (-> clean, the diffs, basis)
//   /api/policy/bot/ack      {keys}  effects he applied
//   /api/policy/admin/cutover  {key, engines, handover, actor}   shadow -> live for those engines (idempotent by key)
//   /api/policy/admin/rollback {key, engines, actor, to}         live -> shadow (default) or off; answers the periods this
//                                                                site ran and every effect Pepe hasn't applied (idempotent)
//   /api/policy/admin/test-clock {at}   STAGING only: the scheduler's clock jumps to `at` (s) - nothing else moves
//   /api/policy/admin/tick {at, tag, engines}  STAGING only: one pass at `at` with period ids "<id>-<tag>" (the rehearsal)
// Admin (signed in, class Admin): GET /api/admin/policy · POST /api/admin/policy/mode {engine, mode, note} (off / dry / shadow)
// · POST /api/admin/policy/pause {engine|"all", pause, note, nonce, password} (PO-1: a Pepe owner + the password step-up).
"use strict";
const C = require("./core");
const E = require("./engines");
const G = require("./gather");
const A = require("./apply");
const S = require("./source");

const PASS_MS = 15000;
const RETRY_FAILED_S = 300;
const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,120}$/;
const TAG_RE = /^[a-z0-9]{1,8}$/;
const PERIOD_RE = /^[A-Za-z0-9-]{2,40}$/;
const DIFF_CAP = 400;
// D-18: a current period that runs more than this past its boundary while the scheduler didn't see the boundary (the site was
// down, or this process only just took the lease) - or that a resume let run - is flagged late on its record
const LATE_GRACE_S = 900;
// PO-1 review: the site's OWN capital cut-off overdue (a site outage across Monday 04:00) this long, as seen by this process,
// -> the admins are told (the epoch keeps waiting for it: it never settles the week on an open PAT-days bucket)
const OVERDUE_ALERT_S = 900;
// PO-1 review: a burn day is summarized / compared only once it has closed by the POOL HISTORY's clock (pools.js stamps its
// legs with the real time - a staging test clock never moves it) and this long after; closed days a pause or an outage
// skipped are summarized up to BURN_BACKFILL_DAYS back
const BURN_SETTLE_S = 60;
const BURN_BACKFILL_DAYS = 7;
// PO-1 review (D-18): how far back a pass records the periods an outage skipped (or a failed run left behind) as missed
const MISSED_DAYS = 14;
const MISSED_WEEKS = 4;
const log = (m) => console.log(`[policy] ${m}`);
/** The pool history's clock (pools.js: Date.now()), never the policy test clock. */
const realNowS = () => Date.now() / 1000;

/**
 * PO-1 / D-15: the differences that may stand between the site's boundary snapshot and Pepe's report without the period
 * reading unclean - each POST-MOVE (it shows a move Pepe made just before this period's legs, which the site sees only once his
 * pushed docs catch up) or on data no enabled rule reads, each under a condition (`when`) and with a test proving it.
 * Anything else that differs - in the plan, in the inputs or in a decision - keeps the period unclean (D-15).
 *   on        "plan" (the total diff), "inputs" (the inputs diff) or "decision" (the site's own decision at the boundary)
 *   match     the difference's path (before ":") - a string (that path exactly) or a RegExp
 *   mode / monday   only in that mode / only on the epoch's day (the Monday)
 *   when(ctx) the condition that makes it post-move / unread; ctx = {engine, kind, mode, monday, eid, site, pepe (inputs),
 *             sitePlan, pepePlan, meta (the boundary's decisions)}
 */
const weekOf = (inp) => ((inp && inp.week) || {}).id || null;
/** The site's week record is LAST week's (Pepe's epoch just opened this one; his econ_treasury push hasn't landed): resolveWeek
 *  discards a record whose id isn't the current epoch's, so nothing reads the site's stale one - and Pepe's is this week's. */
const staleWeek = (ctx) => weekOf(ctx.site) !== ctx.eid && weekOf(ctx.pepe) === ctx.eid;
/** No enabled rule reads the participation rows: no activity reward is paid (amount 0 on both sides) and issuance isn't scaled
 *  by activity (engines.issuancePlan reads the rows only then) - on both sides' config. */
function participationUnread(ctx) {
  const scaled = (inp) => {
    const c = Object.assign({}, E.DEFAULTS, (inp && inp.cfg) || {});
    return (c.issuance_mode === "pct" || c.issuance_mode === "fixed") && !!c.issuance_activity_scaling;
  };
  const paid = (p) => Math.trunc(Number(((p || {}).activity || {}).amount) || 0) > 0;
  return !scaled(ctx.site) && !scaled(ctx.pepe) && !paid(ctx.sitePlan) && !paid(ctx.pepePlan);
}
const WHITELIST = [
  { on: "plan", engine: "treasury", kind: "daily", field: "release", match: "release", mode: "shadow", monday: true,
    when: (ctx) => staleWeek(ctx) && /^release: site null \//.test(ctx.d),
    why: "the Monday daily's release is the week's release_per_day, which Pepe's epoch set a moment earlier: the site sees it only when his econ_treasury doc push lands (excused only while the site still holds last week's record, i.e. 'site null')",
    test: "test/policy-boundary.test.js: whitelist: the Monday daily's release is post-move - excused only on the epoch's day, in shadow; anything else blocks" },
  { on: "inputs", engine: "treasury", kind: "daily", field: "week.*", match: /^week(\.|$)/, mode: "shadow", monday: true, when: staleWeek,
    why: "the same post-move week record: the site still holds last week's (resolveWeek discards it - nothing reads it), Pepe's epoch opened this one a moment earlier",
    test: "test/policy-boundary.test.js: whitelist: the Monday daily's release is post-move - excused only on the epoch's day, in shadow; anything else blocks" },
  { on: "inputs", engine: "monetary", kind: "monetary", field: "week.*", match: /^week(\.|$)/, mode: "shadow", monday: true, when: staleWeek,
    why: "the Monday monetary day reads the week Pepe's epoch just opened; the site still holds last week's record, which resolveWeek discards (nothing reads it)",
    test: "test/policy-boundary.test.js: the Monday monetary day: the guarantee decision and the week record are post-move; a mismatched decision blocks" },
  { on: "inputs", engine: "monetary", kind: "monetary", field: "rows / days / skip", match: /^(rows|days|skip)(\[|\.|$)/, when: participationUnread,
    why: "participation (the E-0 sync) lags Pepe's own counters; tolerated only while no enabled rule reads it - no activity reward paid and issuance not activity-scaled (D-15)",
    test: "test/policy-boundary.test.js: participation input diffs are tolerated only while no enabled rule reads them; any other input diff blocks" },
  { on: "decision", engine: "monetary", kind: "monetary", field: "guarantee", match: "guarantee", mode: "shadow", monday: true,
    when: (ctx) => /^guarantee: site waits for the epoch \/ pepe true$/.test(ctx.d),
    why: "the Monday guarantee needs this week's epoch done: Pepe ran it a moment earlier, the site sees it only when his journal push lands (the site's own gate - the guarantee on, the treasury live, the epoch's day - is checked)",
    test: "test/policy-boundary.test.js: the Monday monetary day: the guarantee decision and the week record are post-move; a mismatched decision blocks" },
];

// ── what is due ──
async function clockInfo(nowS, tag) {
  const src = await S.read();
  const hour = S.hourOf(src.consts);
  const sfx = tag ? `-${tag}` : "";
  return { push: src, src, flags: src.flags || {}, hour, eid: E.epochId(nowS, hour) + sfx, eb: E.weekStart(nowS, hour), did: E.dayId(nowS, hour) + sfx,
           db: E.dayStart(nowS, hour), sfx };
}
const isDone = (r) => !!r && (r.state === "done" || r.state === "handed");

async function sim(mode, engine, period, inputs, plan) {
  const { runQuery } = require("../dbUtils");
  const key = `${mode}:${engine}:${period}`;
  const t = Date.now();
  await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO NOTHING`, [key, mode, engine, period, JSON.stringify(inputs), JSON.stringify(plan), t, t]);
  return key;
}
async function simExists(mode, engine, period) {
  const { getQuery } = require("../dbUtils");
  return !!(await getQuery("SELECT 1 FROM policy_sims WHERE key = ?", [`${mode}:${engine}:${period}`]))[0];
}
/** A period this pass may run: not done; failed ones only after RETRY_FAILED_S. */
async function runnable(engine, period) {
  const r = await C.run(engine, period);
  if (isDone(r)) return false;
  if (r && r.state === "failed" && Date.now() - Number(r.created || 0) < RETRY_FAILED_S * 1000) return false;
  if (r && r.state === "missed") return false;
  return true;
}
async function failed(engine, period, e) {
  const msg = String((e && e.message) || e).slice(0, 400);
  try {
    await C.putRun(engine, period, { state: "failed", via: "site", error: msg });
    await require("../dbUtils").runQuery("UPDATE policy_runs SET created = ? WHERE key = ?", [Date.now(), C.runKey(engine, period)]);
  } catch (x) { /* best effort */ }
  console.error(`[policy] ${engine} ${period} failed (rolled back, retried later): ${msg}`);
  // Pepe tells the admins (his inbox notice), once per period
  try {
    await C.effect(`alert:${engine}:${period}`, { engine, period, kind: "alert",
                                                  data: { title: `Policy engine ${engine}: ${period} failed`, text: `The site's ${engine} run for ${period} was rolled back (nothing moved) and is retried every ${RETRY_FAILED_S / 60} minutes: ${msg}`, ref: `policy:${engine}:${period}` } });
  } catch (x) { /* best effort */ }
}

/** The catch-up cap (D-18): only the current period runs; an earlier one that never ran (the site was down through it) - or
 *  whose run failed and was still being retried when its period ended - is recorded missed and never runs on its own (the
 *  owner's "Run now" on /admin, PO-7). PO-1 review: every period an outage skipped is recorded (up to MISSED_DAYS /
 *  MISSED_WEEKS back, never before the engine was armed), not only the one just before; a missed Monday monetary day says
 *  that the week's guarantee top-up rode on it; the admins are told once per sweep. */
const SITE_DOWN = "never ran: the site was down through this period - not run late (catch-up cap, D-18)";
const swept = new Set();       // "<engine>:<kind>:<current period>" this process swept already (once per new current period)
async function markMissed(engine, period, boundary, armed, info, cfg) {
  if (!armed || boundary < armed) return null;
  const r = await C.run(engine, period);
  if (r && (isDone(r) || r.state === "missed" || r.state === "moving")) return null;   // it ran / is recorded / is Pepe's
  const failedErr = r && r.state === "failed" ? String(r.error || "?").slice(0, 200) : null;
  let why = failedErr ? `failed (${failedErr}) and its period ended - not retried late (catch-up cap, D-18)` : SITE_DOWN;
  const result = { missed: failedErr ? "failed" : "site_down" };
  // the Monday monetary day carries the week's guarantee top-up (pepe_monetary: only on the epoch's day) - missed with it
  if (engine === "monetary" && Math.trunc(E.weekStart(boundary, info.hour)) === Math.trunc(boundary) && cfg.incentive_guarantee && info.flags.tr_live) {
    result.guarantee_unpaid = true;
    why += " - the week's Monday guarantee top-up rides on this day and was NOT paid";
  }
  await C.putRun(engine, period, { state: "missed", boundary, via: "site", error: why.slice(0, 500), result });
  log(`${engine} ${period}: MISSED (${result.missed}${result.guarantee_unpaid ? ", the Monday guarantee unpaid" : ""}) - not run late`);
  return { period, missed: result.missed, guarantee_unpaid: !!result.guarantee_unpaid };
}
/** The sweep behind the current period of `kind` ("epoch" | "daily") - once per new current period per process. */
async function sweepMissed(engine, kind, info, armed) {
  const cur = kind === "epoch" ? info.eid : info.did;
  const sk = `${engine}:${kind}:${cur}`;
  if (swept.has(sk)) return [];
  const step = kind === "epoch" ? 7 * 86400 : 86400;
  const b0 = kind === "epoch" ? info.eb : info.db;
  const list = [];
  for (let i = 1; i <= (kind === "epoch" ? MISSED_WEEKS : MISSED_DAYS); i++) {
    const b = b0 - i * step;
    if (!armed || b < armed) break;
    list.unshift([kind === "epoch" ? E.epochId(b, info.hour) : E.dayId(b, info.hour), b]);
  }
  const cfg = Object.assign({}, E.DEFAULTS, (await G.config()).cfg || {});
  const out = [];
  for (const [period, boundary] of list) {
    const m = await markMissed(engine, period, boundary, armed, info, cfg);
    if (m) out.push(m);
  }
  swept.add(sk);
  if (out.length) {
    const unpaid = out.filter((m) => m.guarantee_unpaid).map((m) => m.period);
    try {
      await C.effect(`alert:missed:${engine}:${cur}`, { engine, period: cur, kind: "alert",
                                                         data: { title: `Policy engine ${engine}: ${out.length} period(s) missed`, ref: `policy:missed:${engine}:${cur}`,
                                                                 text: `Never run late (D-18): ${out.map((m) => `${m.period} (${m.missed})`).join(", ")}.` +
                                                                       (unpaid.length ? ` The Monday guarantee top-up of ${unpaid.join(", ")} was NOT paid.` : "") +
                                                                       " An older period runs only on an owner's Run now." } });
    } catch (e) { console.error("[policy] missed alert:", e.message); }
  }
  return out;
}

// ── D-18: late ──
// PO-1 review: "late" is decided by when a scheduler FIRST SAW the period due (policy_meta "seen:<key>", written once by the
// first live pass in its period, any process) - not by this process's last pass, which a cut-off / guarantee wait, a failed run
// or a lease takeover moved: a run is late when the scheduler first saw its period more than LATE_GRACE_S past the boundary
// (the site was down - or not scheduling - at the boundary), or when a resume let it run (policy_meta "late:<key>").
const lateKey = (engine, period) => `late:${C.runKey(engine, period)}`;
const seenKey = (engine, period) => `seen:${C.runKey(engine, period)}`;
const seenDone = new Set();    // the seen marks this process wrote (no write per pass)
async function markSeen(engine, periods, nowS) {
  const want = periods.map((p) => seenKey(engine, p));
  if (want.every((k) => seenDone.has(k))) return;
  const { runQuery } = require("../dbUtils");
  for (const k of want) {
    if (seenDone.has(k)) continue;
    await runQuery("INSERT INTO policy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING", [k, JSON.stringify({ at: nowS })]);
    seenDone.add(k);
  }
  // only the current periods may still run (D-18): the engine's older marks are done with
  await runQuery(`DELETE FROM policy_meta WHERE key LIKE ? AND key NOT IN (${want.map(() => "?").join(",")})`, [`seen:${engine}:%`, ...want]);
}
/** A live run of `period` (boundary `boundary`) starting now -> null | {why: "paused" | "site_down", boundary, late_s, ...} */
async function lateOf(engine, period, boundary, nowS) {
  const m = await C.meta(lateKey(engine, period));
  if (m) return Object.assign({ boundary, late_s: Math.max(0, Math.round(nowS - boundary)) }, m);
  const s = await C.meta(seenKey(engine, period));
  const first = s && Number.isFinite(Number(s.at)) ? Number(s.at) : nowS;
  if (first - boundary > LATE_GRACE_S) return { why: "site_down", boundary, late_s: Math.round(nowS - boundary), seen_at: Math.round(first) };
  return null;
}
async function lateDone(engine, period, late) {
  if (!late) return;
  try {
    const { runQuery } = require("../dbUtils");
    await runQuery("DELETE FROM policy_meta WHERE key = ?", [lateKey(engine, period)]);
    log(`${engine} ${period}: ran LATE (${late.why}, ${Math.round(late.late_s / 60)} min past its boundary - D-18)`);
    await C.effect(`alert:late:${engine}:${period}`, { engine, period, kind: "alert",
                                                       data: { title: `Policy engine ${engine}: ${period} ran late`, ref: `policy:late:${engine}:${period}`,
                                                               text: `The site's ${engine} run for ${period} ran ${Math.round(late.late_s / 60)} minutes past its boundary (${late.why === "paused" ? "the engine was paused" : "the site's scheduler wasn't running at the boundary"}). Only the current period runs late; an older one stays missed (D-18).` } });
  } catch (e) { console.error("[policy] late:", e.message); }
}

// ── the Monday cut-off (PO-1) ──
const waitLogged = new Set();
const overdueSeen = new Map();     // eb -> the first nowS this process saw the site's own cut-off overdue past the hour
/**
 * Why the epoch of boundary `eb` must still wait for the capital cut-off that closes the week's PAT-days bucket -> null (go) |
 * "hour" (Pepe's _tr_cutoff_pending: the bucket is open and it is less than TR_CUTOFF_WAIT past the boundary) | "overdue".
 * PO-1 review: past the hour Pepe goes on regardless - his wait never had to cover a SITE outage. On the site the capital tick
 * (capital/service, same process) and this scheduler stop together: after an outage across Monday 04:00 the hour is long up
 * when the site comes back, and the epoch would settle the week before the overdue cut-off adds its last day (the I8
 * late-monday case: half the stakers' pay in the review's probe). So while the bucket is open AND the site's own cut-off is
 * OVERDUE - the share book lives here (capital live), vaults on, and the capital clock is at or past next_epoch: the capital
 * tick runs it at its next 15 s pass - the epoch keeps waiting, however long (an alert after OVERDUE_ALERT_S). A cut-off that
 * isn't the site's to run now (capital not live, vaults off, not due yet - e.g. a staging test clock) keeps Pepe's hour.
 */
async function cutoffWait(eb, nowS) {
  let book;
  try { book = await require("../capital/vaults").load(); } catch (e) { return null; }
  if (!E.bucketOpen(book, eb)) return null;
  if (nowS - eb < E.TR_CUTOFF_WAIT) return "hour";
  return (await capitalCutoffOverdue(book)) ? "overdue" : null;
}
async function capitalCutoffOverdue(book) {
  const CC = require("../capital/core");
  try {
    if (!(await CC.live())) return false;
    if (!Number((await CC.cfg()).vaults_enabled)) return false;
    return CC.nowS() >= Number(book.next_epoch || 0);                // capital/service.tick's own test: it runs at its next pass
  } catch (e) { return false; }
}
/** Pepe's _tr_cutoff_pending, plus the site's overdue cut-off (cutoffWait) - true while the epoch must wait. */
async function cutoffPending(eb, nowS) { return !!(await cutoffWait(eb, nowS)); }
/** The overdue wait: logged once; past OVERDUE_ALERT_S (as this process saw it) the admins are told once - the capital tick
 *  isn't closing the week (a cut-off that keeps failing: capital/watch I8 says why), and the week's epoch is held. */
async function overdueNote(eng, period, eb, nowS) {
  if (!overdueSeen.has(eb)) overdueSeen.set(eb, nowS);
  const since = overdueSeen.get(eb);
  const k = `overdue:${eng.mode}:${period}`;
  if (!waitLogged.has(k)) {
    waitLogged.add(k);
    log(`treasury ${period}: the site's capital cut-off is OVERDUE (the site was down across the boundary?) - the epoch waits for it past the hour, never on an open PAT-days bucket`);
  }
  if (eng.mode !== "live" || nowS - since < OVERDUE_ALERT_S || waitLogged.has(`${k}:alert`)) return;
  waitLogged.add(`${k}:alert`);
  console.error(`[policy] treasury ${period}: the capital cut-off has been overdue ${Math.round((nowS - since) / 60)} min - the weekly epoch is held`);
  const title = `Policy engine treasury: ${period} held - the capital cut-off is overdue`;
  const text = `The week's epoch waits for the capital cut-off that closes its PAT-days bucket; it has been overdue ${Math.round((nowS - since) / 60)} minutes (capital_meta vaults next_epoch passed, no cut-off). Nothing has moved. Check the capital tick ([capital] epoch errors, the staking watch's I8); the epoch runs at the first pass after the cut-off.`;
  try { await C.effect(`alert:cutoff:${period}`, { engine: "treasury", period, kind: "alert", data: { title, text, ref: `policy:cutoff:${period}` } }); }
  catch (e) { console.error("[policy] overdue alert:", e.message); }
  try { await require("../opsalerts").alert({ source: "policy", ref: `cutoff:${period}`, title, body: text }); }
  catch (e) { console.error("[policy] overdue ops alert:", e.message); }
}

// ── the pause (PO-1) ──
/** A paused engine: nothing runs. A live one's due periods are recorded missed "paused" (nothing handed back, mode unchanged).
 *  PO-1 review: the record is written in ONE transaction that re-reads the flag (and the run) - a resume that committed after
 *  this pass read the engines (it waited for the write gate) is never overwritten by a stale "missed paused". */
async function pausedPass(engine, nowS, info, eng) {
  if (eng.mode !== "live" || info.sfx) return;
  const armed = Number(eng.armed_at || 0);
  const due = engine === "treasury" ? (info.flags.layers && info.flags.tr_live ? [[info.eid, info.eb], [info.did, info.db]] : [])
    : engine === "monetary" ? (info.flags.layers ? [[info.did, info.db]] : []) : [];          // burn slots carry no state: the reserve waits
  const settledRow = (r) => r && (isDone(r) || r.state === "missed" || r.state === "moving");
  const { tx } = require("../dbUtils");
  for (const [period, boundary] of due) {
    if (!armed || boundary < armed) continue;
    if (settledRow(await C.run(engine, period))) continue;          // a read first: no transaction every 15 s while paused
    const wrote = await tx(async () => {
      const cur = (await C.engines())[engine];
      if (!cur.paused || cur.mode !== "live") return false;        // resumed / rolled back since this pass read it
      if (settledRow(await C.run(engine, period))) return false;
      await C.missedPaused(engine, period, boundary, cur);         // a "failed" current period too: the resume releases it
      return true;
    });
    if (wrote) log(`${engine} ${period}: MISSED (paused)`);
  }
}
/** PO-1 review: a CURRENT period recorded missed "paused" while its engine no longer is paused (the resume released nothing
 *  for it - e.g. it committed between the paused pass's read and its record on an older site) may still run, flagged late,
 *  exactly as a resume lets it (D-18). In ONE transaction that re-reads the flag and the record. -> true when released */
async function healPaused(engine, period) {
  const isPausedMiss = (r) => !!r && r.state === "missed" && (r.result || {}).missed === "paused";
  if (!isPausedMiss(await C.run(engine, period))) return false;
  const { tx, runQuery } = require("../dbUtils");
  const ok = await tx(async () => {
    const cur = (await C.engines())[engine];
    if (cur.paused || cur.mode !== "live") return false;
    const r = await C.run(engine, period);
    if (!isPausedMiss(r)) return false;
    await runQuery("DELETE FROM policy_runs WHERE key = ?", [C.runKey(engine, period)]);
    if (!(await C.meta(lateKey(engine, period)))) {
      await C.setMeta(lateKey(engine, period), { why: "paused", paused_at: (r.result || {}).paused_at || null, paused_by: (r.result || {}).paused_by || null, healed: true });
    }
    return true;
  });
  if (ok) log(`${engine} ${period}: was missed while paused and the engine runs again - it may still run (late, D-18)`);
  return ok;
}

async function treasuryPass(nowS, info, eng, out) {
  if (!info.flags.layers || !info.flags.tr_live) return;
  const armed = Number(eng.armed_at || 0);
  if (!armed) return;
  if (eng.mode === "live" && !info.sfx) {
    // D-18 (PO-1 review): the periods behind the current ones that never ran are recorded missed; the current ones' first sight
    await sweepMissed("treasury", "epoch", info, armed);
    await sweepMissed("treasury", "daily", info, armed);
    await markSeen("treasury", [[info.eid, info.eb], [info.did, info.db]].filter(([, b]) => b >= armed).map(([p]) => p), nowS);
  }
  for (const [period, boundary, kind] of [[info.eid, info.eb, "epoch"], [info.did, info.db, "daily"]]) {
    if (boundary < armed) continue;
    const live = eng.mode === "live";
    if (live && !info.sfx) await healPaused("treasury", period);
    if (live ? !(await runnable("treasury", period)) : await simExists(eng.mode, "treasury", period)) continue;
    // PO-1: the epoch waits for the Monday cut-off (live, dry and shadow) - and the Monday daily with it (it runs after the epoch);
    // past the hour only while the site's own capital cut-off is overdue (cutoffWait)
    if (kind === "epoch") {
      const w = await cutoffWait(info.eb, nowS);
      if (w) {
        if (w === "overdue") await overdueNote(eng, period, info.eb, nowS);
        else if (!waitLogged.has(`${eng.mode}:${period}`)) {
          waitLogged.add(`${eng.mode}:${period}`);
          log(`treasury ${period}: waiting for the Monday cut-off that closes the week's PAT-days (at most ${E.TR_CUTOFF_WAIT / 60} min past the boundary, longer only while the site's own cut-off is overdue)`);
        }
        return;
      }
    }
    if (live) {
      const late = info.sfx ? null : await lateOf("treasury", period, boundary, nowS);     // a staging rehearsal tick is never "late"
      try {
        const r = kind === "epoch" ? await A.runTreasuryEpoch(period, nowS, { late }) : await A.runTreasuryDaily(period, nowS, { late });
        if (r.skipped) return;                                       // paused / no longer live since this pass read it (apply.gate)
        if (!r.already) { out.push(`treasury ${period}`); log(`treasury ${period}: ran (${kind})`); await lateDone("treasury", period, late); }
      } catch (e) { await failed("treasury", period, e); }
    } else if (eng.mode === "dry" || eng.mode === "shadow") {
      const inputs = kind === "epoch" ? await G.epoch(nowS, period) : await G.daily(nowS, period);
      const plan = kind === "epoch" ? E.planEpoch(inputs) : E.planDaily(inputs);
      await sim(eng.mode, "treasury", period, inputs, plan);
      out.push(`${eng.mode} treasury ${period}`);
    }
  }
}

/**
 * The monetary day's guarantee decision (pepe_monetary._mo_tick) -> {guarantee, wait, gate, epoch}: `gate` = the Monday
 * guarantee applies (it is on, the treasury is live, this is the epoch's day); `guarantee` = it is paid (the gate and this
 * week's epoch done - or false after GUARANTEE_WAIT without it); `wait` = what the day still waits for: "the epoch" (the gate
 * is on and the epoch isn't done yet, < 12 h) or "the daily release" (< 1 h); `epoch` = the epoch's state as this site sees it.
 * PO-1 review: the boundary handshake records this decision too (boundary_meta), so it is shadow-compared with Pepe's flag.
 */
async function monetaryGuarantee(nowS, info, src) {
  const c = Object.assign({}, E.DEFAULTS, (await G.config()).cfg || {});
  let guarantee = false, wait = null, epoch = null;
  const trLive = !!info.flags.tr_live;
  const gate = !!(c.incentive_guarantee && trLive && Math.trunc(info.eb) === Math.trunc(info.db));
  if (gate) {
    const j = (await G.journal(src)).find((r) => r.eid === info.eid) || {};
    epoch = j.state || null;
    if (j.state === "done") guarantee = true;
    else if (nowS - info.db < E.GUARANTEE_WAIT) wait = "the epoch";
    else log(`${info.did}: epoch ${info.eid} still not settled - running without the guarantee`);
  }
  if (!wait && trLive && !(await G.dailyDone(src, info.did)) && nowS - info.db < 3600) wait = "the daily release";
  return { guarantee, wait, gate, epoch };
}
async function monetaryPass(nowS, info, eng, out) {
  if (!info.flags.layers) return;
  const armed = Number(eng.armed_at || 0);
  if (!armed || info.db < armed) return;
  if (eng.mode === "live") {
    if (!info.sfx) {
      await sweepMissed("monetary", "daily", info, armed);
      await markSeen("monetary", [info.did], nowS);
      await healPaused("monetary", info.did);
    }
    if (!(await runnable("monetary", info.did))) return;
    const g = await monetaryGuarantee(nowS, info, info.src);
    if (g.wait) return;
    const late = info.sfx ? null : await lateOf("monetary", info.did, info.db, nowS);
    try {
      const r = await A.runMonetary(info.did, nowS, g.guarantee, { late });
      if (r.skipped) return;                                         // paused / no longer live since this pass read it (apply.gate)
      if (!r.already) {
        out.push(`monetary ${info.did}`);
        log(`monetary ${info.did}: ran${g.guarantee ? " (with the guarantee)" : ""}`);
        await lateDone("monetary", info.did, late);
      }
    } catch (e) { await failed("monetary", info.did, e); }
  } else if (eng.mode === "dry" || eng.mode === "shadow") {
    if (await simExists(eng.mode, "monetary", info.did)) return;
    const g = await monetaryGuarantee(nowS, info, info.src);
    if (g.wait) return;
    const inputs = await G.monetary(nowS, info.did, g.guarantee);
    const plan = E.planMonetary(inputs);
    const a = plan.activity || {};
    plan._activity_payouts = a.amount > 0 ? E.planActivity(inputs, a.local_day, a.amount) : [];
    await sim(eng.mode, "monetary", info.did, inputs, plan);
    out.push(`${eng.mode} monetary ${info.did}`);
  }
}

/** The policy day a burn period names: D<date>[-tag] = [<date> <hour>:00 UTC, the next day's) -> {from, to} | null */
function burnWindow(period, hour) {
  const m = /^D(\d{4}-\d{2}-\d{2})/.exec(String(period || ""));
  if (!m) return null;
  const from = Date.parse(m[1] + "T00:00:00Z") / 1000 + hour * 3600;
  return Number.isFinite(from) ? { from, to: from + 86400 } : null;
}
/** PO-1 review: has the burn day [from, to) CLOSED by the pool history's clock (+ BURN_SETTLE_S)? Its snapshot is final only then -
 *  an earlier one (an early report, a staging test clock ahead of the real one) would freeze a partial day for good. */
const burnClosed = (to) => Number(to) + BURN_SETTLE_S <= realNowS();
/** PO-1: the burn engine's day summary - a closed policy day, recorded once per mode (even at zero), in ONE transaction; it is
 *  also that day's boundary snapshot (the closed day reads the same whenever it is read). PO-1 review: only a CLOSED day; a row
 *  that exists without a snapshot (a report that came first and could take none) gets it. */
async function burnSummary(mode, period, from, to, nowS) {
  if (!burnClosed(to)) return null;
  const { runQuery, getQuery, tx } = require("../dbUtils");
  const key = `${mode}:burn:${period}`;
  const snapped = async () => {
    const r = (await getQuery("SELECT boundary_ts FROM policy_sims WHERE key = ?", [key]))[0];
    return !!r && r.boundary_ts !== null && r.boundary_ts !== undefined;
  };
  if (await snapped()) return null;                                 // every pass looks: a read, not a transaction, once it's there
  return tx(async () => {
    if (await snapped()) return null;
    const inputs = await G.burnDay(nowS, period, from, to);
    const plan = E.planBurn(inputs);
    const t = Date.now();
    await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, site_boundary_inputs, site_boundary_plan, boundary_ts, created, updated)
                    VALUES (?, ?, 'burn', ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET site_boundary_inputs = excluded.site_boundary_inputs, site_boundary_plan = excluded.site_boundary_plan,
                      boundary_ts = excluded.boundary_ts, updated = excluded.updated WHERE policy_sims.boundary_ts IS NULL`,
                   [key, mode, period, JSON.stringify(inputs), JSON.stringify(plan), JSON.stringify(inputs), JSON.stringify(plan), C.nowS(), t, t]);
    return key;
  });
}
/** The closed burn days a pass summarizes: the day that just closed - and (PO-1 review) the ones a pause or an outage skipped,
 *  up to BURN_BACKFILL_DAYS back, never a day that ended before the engine was armed. A staging rehearsal tick: its own day. */
function burnDaysDue(info, eng) {
  if (info.sfx) return [[E.dayId(info.db - 86400, info.hour) + info.sfx, info.db - 86400, info.db]];
  const armed = Number(eng.armed_at || 0);
  const out = [];
  for (let i = BURN_BACKFILL_DAYS; i >= 1; i--) {
    const from = info.db - i * 86400, to = from + 86400;
    if (armed && to <= armed) continue;
    out.push([E.dayId(from, info.hour), from, to]);
  }
  return out;
}
async function burnPass(nowS, info, eng, out) {
  if (!(await require("../pools").live())) return;
  const bc = await S.burn();
  // PO-1: the day summaries of the closed policy days ([04:00, 04:00) UTC) - dry, shadow and live, even at zero
  const days = burnDaysDue(info, eng);
  const { getQuery } = require("../dbUtils");
  const have = new Set(days.length ? (await getQuery(`SELECT period FROM policy_sims WHERE mode = ? AND engine = 'burn' AND boundary_ts IS NOT NULL
                                                      AND period IN (${days.map(() => "?").join(",")})`, [eng.mode, ...days.map((d) => d[0])])).map((r) => r.period) : []);
  for (const [period, from, to] of days) {
    if (have.has(period)) continue;
    const sk = await burnSummary(eng.mode, period, from, to, nowS);
    if (sk) out.push(`${eng.mode} burn ${period}`);
  }
  if ((bc.cfg || {}).mode !== "accrual" || eng.mode !== "live") return;
  // live: the accrual - one burn per accrual_every_min slot (a slot with nothing to burn isn't recorded)
  const every = Math.max(1, Math.trunc(Number(bc.cfg.accrual_every_min) || 5)) * 60;
  const period = `A${Math.floor(nowS / every)}${info.sfx}`;
  if (!(await runnable("burn", period))) return;
  try {
    const r = await A.runBurn(period, nowS, { inflight: bc.inflight || 0 });
    if (r.skipped) return;
    if (r.amount) { out.push(`burn ${period} ${r.amount}`); log(`burned ${r.amount} PAT (${r.id})`); }
  } catch (e) { await failed("burn", period, e); }
}

/** Phase 4: a live run moved PAT - today's supply history row at once (the total, burns, the site's mints), not at Pepe's next push. */
async function recordSupply() {
  try {
    const SH = require("../supplyhistory");
    await SH.record(await require("../supply").patSupply(), null);
  } catch (e) { console.error("[policy] supply history:", e.message); }
}

/** One pass at nowS (the test clock's, or real time). -> what ran / was planned. */
async function pass(nowS, { tag = null, only = null } = {}) {
  await C.init();
  const info = await clockInfo(nowS, tag);
  const engs = await C.engines();
  const out = [];
  const passes = { treasury: treasuryPass, monetary: monetaryPass, burn: burnPass };
  for (const e of C.ENGINES) {
    if ((only && !only.includes(e)) || engs[e].mode === "off") continue;
    if (engs[e].paused) { await pausedPass(e, nowS, info, engs[e]); continue; }
    await passes[e](nowS, info, engs[e], out);
  }
  if (out.some((x) => !/^(dry|shadow|live) burn D/.test(x) && !/^(dry|shadow) /.test(x))) await recordSupply();
  return out;
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try {
    await C.loadTestClock();
    if (!(await C.acquireLease())) return;
    await pass(C.nowS());
  } catch (e) {
    console.error("[policy] pass:", e.message);
  } finally { running = false; }
}

// ── shadow: the boundary snapshot and Pepe's report ──
/** {list, n, truncated}: the differences between a (the site) and b (Pepe), at most `cap` listed (n counts them all). */
function diffCapped(a, b, cap = DIFF_CAP) {
  const acc = { list: [], n: 0, cap };
  walk(a, b, "", acc);
  return { list: acc.list, n: acc.n, truncated: acc.n > acc.list.length };
}
function add(acc, s) { acc.n++; if (acc.list.length < acc.cap) acc.list.push(s); }
function walk(a, b, where, acc) {
  if (typeof a === "number" && typeof b === "number") { if (a !== b) add(acc, `${where}: site ${a} / pepe ${b}`); return; }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b && !(a === undefined && b === null) && !(a === null && b === undefined)) add(acc, `${where}: site ${JSON.stringify(a)} / pepe ${JSON.stringify(b)}`.slice(0, 300));
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { add(acc, `${where}: shape`); return; }
    if (a.length !== b.length) add(acc, `${where}: ${a.length} items / pepe ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${where}[${i}]`, acc);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], where ? `${where}.${k}` : k, acc);
}
/** The differences (at most DIFF_CAP) - the list only. */
const diff = (a, b) => diffCapped(a, b).list;

/** The inputs kind an engine's period takes: treasury W... = the epoch, D... = the daily; monetary = the day; burn = the day. */
function kindOf(engine, period) {
  if (engine === "treasury") return /^W/.test(period) ? "epoch" : /^D/.test(period) ? "daily" : null;
  if (engine === "monetary") return /^D/.test(period) ? "monetary" : null;
  if (engine === "burn") return /^D/.test(period) ? "burn" : null;
  return null;
}
const KINDS = { treasury: ["epoch", "daily"], monetary: ["monetary"], burn: ["burn"] };
function planOf(engine, inputs) {
  if (inputs.kind === "epoch") return E.planEpoch(inputs);
  if (inputs.kind === "daily") return E.planDaily(inputs);
  if (inputs.kind === "monetary") {
    const p = E.planMonetary(inputs);
    const a = p.activity || {};
    p._activity_payouts = a.amount > 0 ? E.planActivity(inputs, a.local_day, a.amount) : [];
    return p;
  }
  if (inputs.kind === "burn") return E.planBurn(inputs);
  throw new Error("unknown inputs kind");
}
/** The site's own inputs for a period at nowS. */
async function gatherFor(kind, nowS, period, guarantee) {
  if (kind === "epoch") return G.epoch(nowS, period);
  if (kind === "daily") return G.daily(nowS, period);
  if (kind === "monetary") return G.monetary(nowS, period, !!guarantee);
  if (kind === "burn") {
    // the period names the policy day: D<date> = [<date> 04:00 UTC, the next day's 04:00) - compared only once it has closed
    const w = burnWindow(period, await S.hour());
    const start = w ? w.from : E.dayStart(nowS, await S.hour()) - 86400;
    return G.burnDay(nowS, period, start, start + 86400);
  }
  throw new Error("unknown kind");
}
const INPUT_SKIP = new Set(["now", "kind"]);
function inputDiff(site, pepe) {
  const a = {}, b = {};
  for (const k of Object.keys(pepe || {})) if (!INPUT_SKIP.has(k)) { a[k] = (site || {})[k]; b[k] = pepe[k]; }
  return diffCapped(a, b);
}
/** D-15: split one part's differences (`on`: "plan" = the total diff, "inputs", "decision") into the entries the WHITELIST
 *  excuses (this engine / kind / mode / day, and the entry's condition on ctx) and the rest - the ones that block "clean". */
function applyWhitelist(list, ctx, on = "plan") {
  const excused = [], blocking = [];
  for (const d of list || []) {
    const path = String(d).split(":")[0];
    const w = WHITELIST.find((x) => (x.on || "plan") === on && x.engine === ctx.engine && x.kind === ctx.kind
                                    && (x.match instanceof RegExp ? x.match.test(path) : x.match === path)
                                    && (!x.mode || x.mode === ctx.mode) && (!x.monday || ctx.monday)
                                    && (!x.when || x.when(Object.assign({ d: String(d) }, ctx))));
    (w ? excused : blocking).push(d);
  }
  return { excused, blocking };
}
/** PO-1 review: the site's own DECISIONS at the boundary vs Pepe's - today the monetary day's guarantee flag (it drives a leg:
 *  the Monday top-up). boundary_meta.guarantee = {site: true | false | null (waits for the epoch) | "undecided", ...}. */
function decisionDiff(meta, inputs) {
  if (!inputs || inputs.kind !== "monetary") return [];
  const g = (meta || {}).guarantee;
  const pepe = !!inputs.guarantee;
  if (!g) return [`guarantee: site no decision recorded / pepe ${pepe}`];
  if (typeof g.site === "boolean") return g.site === pepe ? [] : [`guarantee: site ${g.site} / pepe ${pepe}`];
  if (g.site === null && g.wait === "the epoch") return [`guarantee: site waits for the epoch / pepe ${pepe}`];
  return [`guarantee: site undecided (${g.why || "?"}) / pepe ${pepe}`];
}

/** PO-1 (T9): the site's snapshot of a period's boundary - inputs + plan in ONE transaction (no leg can land half-way), stored
 *  once (a second call answers dup and keeps the first), before Pepe moves any leg. Only while the site compares (dry / shadow). */
async function boundary(b) {
  await C.init();
  const engine = String(b.engine || "");
  const period = String(b.period || "");
  if (!C.ENGINES.includes(engine) || !PERIOD_RE.test(period)) return { ok: false, error: "bad boundary" };
  const kind = kindOf(engine, period);
  if (!kind) return { ok: false, error: `no ${engine} period ${period}` };
  const nowS = Number.isFinite(Number(b.now)) && Number(b.now) > 0 ? Number(b.now) : C.nowS();
  const eng = (await C.engines())[engine];
  if (eng.mode === "off") return { ok: true, skipped: "off" };                 // the site isn't comparing this engine
  if (eng.mode === "live") return { ok: true, skipped: "live" };               // the site runs it: its own run is the boundary
  if (kind === "burn") {
    // PO-1 review: a burn day's snapshot is final - taken only once the day has closed (by the pool history's clock)
    const w = burnWindow(period, await S.hour());
    if (!w || !burnClosed(w.to)) return { ok: false, error: `the burn day ${period} hasn't closed yet - nothing taken` };
  }
  const { runQuery, getQuery, tx } = require("../dbUtils");
  const key = `shadow:${engine}:${period}`;
  const out = await tx(async () => {
    const have = (await getQuery("SELECT boundary_ts FROM policy_sims WHERE key = ?", [key]))[0];
    if (have && have.boundary_ts !== null && have.boundary_ts !== undefined) return { ok: true, dup: true, key, boundary_ts: have.boundary_ts };
    const inputs = await gatherFor(kind, nowS, period, b.guarantee);
    const plan = planOf(engine, inputs);
    // PO-1 review: the site's OWN decisions at this moment, kept with the snapshot - the plan above uses Pepe's guarantee flag
    // (so the plans compare on the same flag), and the report compares the flag with the site's decision (decisionDiff)
    const meta = {};
    if (kind === "monetary") {
      const info = await clockInfo(nowS);
      const base = (/^D\d{4}-\d{2}-\d{2}/.exec(period) || [""])[0];          // a staging rehearsal's tag ("-r1") aside
      if (info.did !== base) meta.guarantee = { site: "undecided", why: `Pepe's now is in ${info.did}, not ${period}`, pepe: !!b.guarantee };
      else {
        const g = await monetaryGuarantee(nowS, info, info.src);
        meta.guarantee = { site: g.wait === "the epoch" ? null : g.guarantee, wait: g.wait, gate: g.gate, epoch: g.epoch, pepe: !!b.guarantee };
      }
    }
    const t = Date.now(), at = C.nowS();
    await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, site_boundary_inputs, site_boundary_plan, boundary_ts, boundary_meta,
                      created, updated) VALUES (?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET site_boundary_inputs = excluded.site_boundary_inputs, site_boundary_plan = excluded.site_boundary_plan,
                      boundary_ts = excluded.boundary_ts, boundary_meta = excluded.boundary_meta, updated = excluded.updated WHERE policy_sims.boundary_ts IS NULL`,
                   [key, engine, period, JSON.stringify(inputs), JSON.stringify(plan), JSON.stringify(inputs), JSON.stringify(plan), at, JSON.stringify(meta), t, t]);
    return { ok: true, key, boundary_ts: at, now: nowS };
  });
  if (!out.dup) log(`boundary ${engine} ${period}: snapshot taken (Pepe's now ${Math.round(nowS)})`);
  return out;
}

async function report(b) {
  await C.init();
  const engine = String(b.engine || "");
  const period = String(b.period || "");
  if (!C.ENGINES.includes(engine) || !PERIOD_RE.test(period)) return { ok: false, error: "bad report" };
  const inputs = b.inputs && typeof b.inputs === "object" ? b.inputs : null;
  const plan = b.plan && typeof b.plan === "object" ? b.plan : null;
  if (!inputs || !plan) return { ok: false, error: "no inputs / plan" };
  if (!KINDS[engine].includes(inputs.kind)) return { ok: false, error: `a ${engine} report takes ${KINDS[engine].join(" / ")} inputs` };
  const replay = planOf(engine, inputs);
  const engineDiff = diffCapped(replay, plan);
  const { getQuery, runQuery } = require("../dbUtils");
  const key = `shadow:${engine}:${period}`;
  const hour = S.hourOf(inputs.consts || (await S.read()).consts);
  if (inputs.kind === "burn") {
    // PO-1 review: a burn day is compared only once it has closed (by the pool history's clock) - an earlier report is refused and
    // nothing is recorded (its snapshot would freeze a partial day). A closed day reads the same whenever it is read: take its
    // snapshot now if the scheduler hasn't yet (a report that arrives first must not read as "no boundary")
    const w = burnWindow(period, hour);
    if (!w || !burnClosed(w.to)) return { ok: false, error: `the burn day ${period} hasn't closed yet - report it after it closed (nothing recorded)` };
    await boundary({ engine, period, now: inputs.now }).catch(() => null);
  }
  const row = (await getQuery("SELECT site_boundary_inputs, site_boundary_plan, boundary_ts, boundary_meta FROM policy_sims WHERE key = ?", [key]))[0];
  const hasBoundary = !!row && row.boundary_ts !== null && row.boundary_ts !== undefined;
  const meta = hasBoundary ? C.parse(row.boundary_meta, {}) : null;
  // the basis: the site's snapshot at the boundary (before Pepe's legs); without one (a Pepe before PO-0c, or his handshake
  // timed out) the site's view now - which may already show his legs, so such a period is never clean
  let siteInputs = null, sitePlan = null, inDiff = { list: [], n: 0, truncated: false }, totDiff = { list: [], n: 0, truncated: false };
  try {
    if (hasBoundary) {
      siteInputs = C.parse(row.site_boundary_inputs, null);
      sitePlan = C.parse(row.site_boundary_plan, null);
    } else {
      siteInputs = await gatherFor(inputs.kind, Number(inputs.now), period, inputs.guarantee);
      sitePlan = planOf(engine, siteInputs);
    }
    inDiff = inputDiff(siteInputs, inputs);
    totDiff = diffCapped(sitePlan, plan);
  } catch (e) { inDiff = { list: [`site gather failed: ${e.message}`], n: 1, truncated: false }; }
  const eng = (await C.engines())[engine];
  const nowP = Number(inputs.now);
  const ctx = { engine, kind: inputs.kind, mode: eng.mode, monday: Number.isFinite(nowP) && E.dayStart(nowP, hour) === E.weekStart(nowP, hour),
                eid: Number.isFinite(nowP) ? E.epochId(nowP, hour) : null, site: siteInputs, pepe: inputs, sitePlan, pepePlan: plan, meta };
  // D-15 (PO-1 review): the plan, the INPUTS and the site's own DECISIONS each count - a difference outside the tested
  // whitelist in any of them keeps the period unclean (input diffs only on data no enabled rule reads, or post-move)
  const pw = applyWhitelist(totDiff.list, ctx, "plan");
  const iw = applyWhitelist(inDiff.list, ctx, "inputs");
  const dec = hasBoundary ? decisionDiff(meta, inputs) : [];
  const dw = applyWhitelist(dec, ctx, "decision");
  const truncated = engineDiff.truncated || inDiff.truncated || totDiff.truncated;
  const clean = !engineDiff.list.length && hasBoundary && !pw.blocking.length && !iw.blocking.length && !dw.blocking.length
                && !totDiff.truncated && !inDiff.truncated;
  const whitelisted = { plan: pw.excused, inputs: iw.excused, decision: dw.excused };
  const blocking = { plan: pw.blocking, inputs: iw.blocking, decision: dw.blocking };
  const t = Date.now();
  await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, pepe_inputs, pepe_plan, replay_plan, engine_diff, input_diff,
                  total_diff, ok, truncated, whitelisted, blocking, created, updated) VALUES (?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET site_inputs = excluded.site_inputs, site_plan = excluded.site_plan, pepe_inputs = excluded.pepe_inputs,
                    pepe_plan = excluded.pepe_plan, replay_plan = excluded.replay_plan, engine_diff = excluded.engine_diff, input_diff = excluded.input_diff,
                    total_diff = excluded.total_diff, ok = excluded.ok, truncated = excluded.truncated, whitelisted = excluded.whitelisted,
                    blocking = excluded.blocking, updated = excluded.updated`,
                 [key, engine, period, JSON.stringify(siteInputs), JSON.stringify(sitePlan), JSON.stringify(inputs), JSON.stringify(plan), JSON.stringify(replay),
                  JSON.stringify(engineDiff.list), JSON.stringify(inDiff.list), JSON.stringify(totDiff.list), clean ? 1 : 0, truncated ? 1 : 0,
                  JSON.stringify(whitelisted), JSON.stringify(blocking), t, t]);
  const nW = pw.excused.length + iw.excused.length + dw.excused.length;
  const msg = `shadow ${engine} ${period}: engine diff ${engineDiff.n}, inputs diff ${inDiff.n}, total diff ${totDiff.n}${dec.length ? `, decisions ${dec.length}` : ""}` +
              `${nW ? ` (${nW} whitelisted)` : ""}, ${hasBoundary ? "vs the boundary snapshot" : "NO boundary snapshot"} - ${clean ? "clean" : "not clean"}`;
  const bad = [...engineDiff.list, ...pw.blocking, ...iw.blocking.map((x) => `inputs ${x}`), ...dw.blocking.map((x) => `decision ${x}`)];
  if (bad.length) console.warn(`[policy] ${msg}: ${[...new Set(bad)].slice(0, 6).join(" | ")}`); else log(msg);
  return { ok: true, clean, basis: hasBoundary ? "boundary" : "report", engine_diff: engineDiff.list, input_diff: inDiff.list, total_diff: totDiff.list,
           decision_diff: dec, blocking: pw.blocking, whitelisted: pw.excused, input_blocking: iw.blocking, input_whitelisted: iw.excused,
           decision_blocking: dw.blocking, decision_whitelisted: dw.excused,
           truncated: { engine: engineDiff.truncated, input: inDiff.truncated, total: totDiff.truncated } };
}

// ── the cutover handshake (Pepe calls it after he stopped running the engines locally) ──
async function cutover(b) {
  await C.init();
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) return { ok: false, code: "bad_key", error: "bad key" };
  const prev = await C.meta(`cutover:${key}`);
  if (prev) return Object.assign({ dup: true }, prev);
  const engines = (Array.isArray(b.engines) ? b.engines : []).map(String).filter((e) => C.ENGINES.includes(e));
  if (!engines.length) return { ok: false, code: "no_engines", error: "name the engines" };
  const P = require("../pools");
  if (!(await P.live())) return { ok: false, code: "pools_local", error: "the pools still live in Pepe (Phase 1 first)" };
  if (engines.includes("treasury") && !(await require("../capital/core").live())) {
    return { ok: false, code: "capital_local", error: "the share book still lives in Pepe (Phase 3 first): the waterfall redeems the protocol's shares there" };
  }
  const engs = await C.engines();
  for (const e of engines) {
    if (engs[e].mode === "live") return { ok: false, code: "already_live", error: `${e} is already live here` };
    if (engs[e].mode !== "shadow" && !b.from_any) return { ok: false, code: "not_shadow", error: `${e} is ${engs[e].mode} here - run it in shadow first` };
    // PO-1: a paused engine would run nothing after Pepe stops - resume it on the site first
    if (engs[e].paused) return { ok: false, code: "paused", error: `${e} is paused on the site - resume it first (/admin/economy or tools/policy-backend.js resume)` };
  }
  if (b.cfg) await C.putCfg(b.cfg);
  const h = b.handover && typeof b.handover === "object" ? b.handover : {};
  const handed = [];
  const { tx } = require("../dbUtils");
  await tx(async () => {
    for (const e of engines) {
      const x = h[e] || {};
      for (const p of (Array.isArray(x.done) ? x.done : []).slice(0, 400)) {
        const period = String(p.period || p || "");
        if (!PERIOD_RE.test(period)) continue;
        const r = await C.run(e, period);
        if (isDone(r)) continue;
        await C.putRun(e, period, { state: "handed", via: "pepe", boundary: p.boundary === undefined ? null : Number(p.boundary),
                                    result: p.result || { incentives_after: p.incentives_after ?? null, boundary: p.boundary ?? null } });
        handed.push(`${e}:${period}`);
      }
      const armed = x.armed_at !== undefined && x.armed_at !== null ? Number(x.armed_at) : C.nowS();
      await C.setMode(e, "live", { by: String(b.actor || "pepe").slice(0, 60), via: "cutover", note: `cutover ${key}`, armedAt: armed });
    }
  });
  const out = { ok: true, key, engines, handed, at: Date.now() };
  await C.setMeta(`cutover:${key}`, out);
  log(`CUTOVER ${key}: ${engines.join(", ")} live on the site (${handed.length} period(s) Pepe ran recorded as handed)`);
  return out;
}

async function rollback(b) {
  await C.init();
  const key = String(b.key || "");
  if (!KEY_RE.test(key)) return { ok: false, code: "bad_key", error: "bad key" };
  const prev = await C.meta(`rollback:${key}`);
  if (prev) return Object.assign({ dup: true }, prev, { effects: await C.effectsOpen(500) });
  const engines = (Array.isArray(b.engines) ? b.engines : []).map(String).filter((e) => C.ENGINES.includes(e));
  const to = b.to === "off" ? "off" : "shadow";
  const engs = await C.engines();
  const { getQuery } = require("../dbUtils");
  for (const e of engines) {
    if (engs[e].mode !== "live") return { ok: false, code: "not_live", error: `${e} isn't live here` };
    const moving = (await getQuery("SELECT key FROM policy_runs WHERE engine = ? AND state = 'moving'", [e]))[0];
    if (moving) return { ok: false, code: "busy", error: `${moving.key} is running - try again in a moment` };
  }
  const ran = {};
  for (const e of engines) {
    const cut = (await getQuery("SELECT MAX(updated) AS t FROM policy_engines WHERE engine = ?", [e]))[0];
    ran[e] = (await getQuery("SELECT period, state, boundary, result FROM policy_runs WHERE engine = ? AND via = 'site' AND state = 'done' ORDER BY created", [e]))
      .map((r) => ({ period: r.period, boundary: r.boundary, result: C.parse(r.result, null) }));
    await C.setMode(e, to, { by: String(b.actor || "pepe").slice(0, 60), via: "rollback", note: `rollback ${key}`, armedAt: engs[e].armed_at });
    void cut;
  }
  const out = { ok: true, key, engines, to, ran, at: Date.now() };
  await C.setMeta(`rollback:${key}`, out);
  log(`ROLLBACK ${key}: ${engines.join(", ")} back to Pepe (site mode ${to})`);
  return Object.assign({}, out, { effects: await C.effectsOpen(500) });
}

// ── the pause (PO-1, T3) ──
/**
 * Pause / resume engines - the owner's kill switch for a site engine, which works with Pepe down. ONE dbUtils.tx: the flag, the
 * policy_audit row, an admin_audit row ("policy.pause" / "policy.resume"); on resume the CURRENT period (D-18) that the pause
 * recorded missed (or whose boundary fell inside the pause) may run again, flagged late - an older one stays missed. After the
 * commit every site admin is told (opsalerts: inbox + Telegram). `who` = {by (name), auditId (admin_audit's admin_id: the
 * account, or "cli:<actor>"), via ("admin" | "cli")}. -> [{engine, paused, was, unchanged?, released?}]
 */
async function setPause(list, paused, { by, auditId, via, note = null }) {
  await C.init();
  const engines = (Array.isArray(list) ? list : [list]).map(String);
  for (const e of engines) if (!C.ENGINES.includes(e)) throw Object.assign(new Error(`no engine ${e}`), { status: 400 });
  const AA = require("../adminaudit");
  await AA.init();                                   // its table outside the transaction (it is created lazily)
  const { tx, runQuery } = require("../dbUtils");
  const nowS = C.nowS();
  const hour = await S.hour();
  const out = await tx(async () => {
    const cur = await C.engines();
    const res = [];
    for (const e of engines) {
      const was = !!cur[e].paused;
      if (was === !!paused) { res.push({ engine: e, paused: was, was, unchanged: true }); continue; }
      await C.putPaused(e, !!paused, { by, note });
      await C.audit({ by, via, engine: e, old: was ? "paused" : "running", new: paused ? "paused" : "running", note });
      await AA.record({ userId: String(auditId || "cli"), username: by }, paused ? "policy.pause" : "policy.resume", null, { engine: e, mode: cur[e].mode }, note);
      const released = [];
      if (!paused && cur[e].mode === "live") {
        // D-18: only the CURRENT period may still run - the one the pause recorded missed, or whose boundary the pause covered
        const pausedAtS = Number(cur[e].paused_at || 0) / 1000;
        const armed = Number(cur[e].armed_at || 0);
        const periods = e === "treasury" ? [[E.epochId(nowS, hour), E.weekStart(nowS, hour)], [E.dayId(nowS, hour), E.dayStart(nowS, hour)]]
          : e === "monetary" ? [[E.dayId(nowS, hour), E.dayStart(nowS, hour)]] : [];
        for (const [p, bnd] of periods) {
          if (!armed || bnd < armed || bnd > nowS) continue;                   // never due here (armed after it) / not begun
          const r = await C.run(e, p);
          if (isDone(r)) continue;
          const pausedMiss = r && r.state === "missed" && (r.result || {}).missed === "paused";
          if (r && r.state === "missed" && !pausedMiss) continue;              // missed for another reason: stays missed
          if (pausedMiss) await runQuery("DELETE FROM policy_runs WHERE key = ?", [C.runKey(e, p)]);
          if (pausedMiss || (pausedAtS && bnd >= pausedAtS)) {
            await C.setMeta(lateKey(e, p), { why: "paused", paused_at: cur[e].paused_at, paused_by: cur[e].paused_by, resumed_at: Date.now() });
            released.push(p);
          }
        }
      }
      res.push({ engine: e, paused: !!paused, was, released });
    }
    return res;
  });
  const changed = out.filter((x) => !x.unchanged);
  if (changed.length) {
    log(`${paused ? "PAUSED" : "RESUMED"} ${changed.map((x) => x.engine).join(", ")} by ${by} (${via})${note ? ": " + note : ""}`);
    try {
      await require("../opsalerts").alert({ source: "policy", ref: `${paused ? "pause" : "resume"}:${changed.map((x) => x.engine).join("+")}:${Date.now()}`,
                                            title: `Policy engine ${changed.map((x) => x.engine).join(", ")} ${paused ? "PAUSED" : "resumed"} by ${by}`,
                                            body: `${paused ? "Nothing runs for it on the site until it is resumed; a live engine's due periods are recorded missed (D-18)." : "Only the current period may still run (late); older ones stay missed (D-18)."}${note ? "\nNote: " + note : ""}\nVia: ${via}.` });
    } catch (e) { console.error("[policy] pause alert:", e.message); }
  }
  return out;
}

// ── views ──
async function lastSim(engine) {
  const { getQuery } = require("../dbUtils");
  const r = (await getQuery(`SELECT key, mode, period, engine_diff, input_diff, total_diff, ok, boundary_ts, truncated, whitelisted, blocking, updated FROM policy_sims
                             WHERE engine = ? ORDER BY updated DESC LIMIT 1`, [engine]))[0];
  if (!r) return null;
  const parts = (v) => { const x = C.parse(v, null); return Array.isArray(x) ? { plan: x, inputs: [], decision: [] } : x; };
  return { key: r.key, mode: r.mode, period: r.period, ok: r.ok === null ? null : !!r.ok, updated: r.updated, boundary: r.boundary_ts !== null && r.boundary_ts !== undefined,
           truncated: !!r.truncated, whitelisted: parts(r.whitelisted), blocking: parts(r.blocking),
           engine_diff: C.parse(r.engine_diff, null), input_diff: C.parse(r.input_diff, null), total_diff: C.parse(r.total_diff, null) };
}
function nextRun(engine, nowS, src) {
  const hour = S.hourOf(src.consts);
  if (engine === "burn") {
    const every = Math.max(1, Math.trunc(Number((src.burn_cfg || {}).accrual_every_min) || 5)) * 60;
    return (Math.floor(nowS / every) + 1) * every;
  }
  const day = E.dayStart(nowS, hour) + 86400;
  if (engine === "treasury") return { daily: day, epoch: E.weekStart(nowS, hour) + 7 * 86400 };
  return day;
}
async function view() {
  await C.init();
  const { getQuery } = require("../dbUtils");
  const engs = await C.engines();
  const src = await S.read();
  const nowS = C.nowS();
  const out = [];
  for (const e of C.ENGINES) {
    const last = (await getQuery("SELECT key, period, state, via, error, created, done FROM policy_runs WHERE engine = ? ORDER BY created DESC LIMIT 1", [e]))[0] || null;
    out.push(Object.assign({}, engs[e], { paused: !!engs[e].paused, last_run: last, next_run: nextRun(e, nowS, src), last_diff: await lastSim(e) }));
  }
  // Pepe's participation day vs this site's (time zone check: the activity rewards read the day by it)
  let tzOk = null;
  if (Array.isArray(src.local_check) && src.local_check.length === 2) tzOk = G.localDay(Number(src.local_check[0]), src.tz || S.TZ_DEFAULT) === src.local_check[1];
  return { engines: out, retired: C.RETIRED, stays: C.STAYS, lease: await C.leaseInfo(), cfg_age_s: Math.round(await S.age()), tz_ok: tzOk,
           flags: Object.keys(src.flags || {}).length ? src.flags : null, now: nowS, test_clock: C._testOffset() ? { offset_ms: C._testOffset() } : null,
           effects_open: (await getQuery("SELECT COUNT(*) AS n FROM policy_effects WHERE acked_at IS NULL"))[0].n,
           audit: await getQuery("SELECT ts, by, via, engine, old, new, note FROM policy_audit ORDER BY id DESC LIMIT 30"),
           runs: await getQuery("SELECT key, engine, period, state, via, error, created, done FROM policy_runs ORDER BY created DESC LIMIT 30"),
           missed: await getQuery("SELECT key, engine, period, error, created FROM policy_runs WHERE state = 'missed' ORDER BY created DESC LIMIT 20"),
           whitelist: WHITELIST.map((w) => ({ on: w.on || "plan", engine: w.engine, kind: w.kind, field: w.field, mode: w.mode || null, monday: !!w.monday,
                                              why: w.why, test: w.test })),
           sims: (await getQuery("SELECT key, mode, engine, period, ok, boundary_ts, updated FROM policy_sims ORDER BY updated DESC LIMIT 30")) };
}
async function botState() {
  await C.init();
  const engs = await C.engines();
  return { ok: true, engines: Object.fromEntries(Object.entries(engs).map(([k, v]) => [k, { mode: v.mode, armed_at: v.armed_at, paused: !!v.paused }])),
           effects: await C.effectsOpen(200), lease: await C.leaseInfo(), cfg_age_s: Math.round(await S.age()), now: C.nowS() };
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  C.init().catch((e) => console.error("[policy] init:", e.message));
  const express = require("express");
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e && e.status) return res.status(e.status).json({ ok: false, error: e.message });
      console.error("[policy] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  // the reports and the config carry Pepe's inputs (vault book, participation rows): their own body limit (index.js skips them)
  const big = express.json({ limit: "16mb" });
  app.post("/api/policy/bot/state", bot(() => botState()));
  app.post("/api/policy/bot/config", big, bot(async (b) => ({ ok: true, cfg_at: (await C.putCfg(b.cfg)) ? Date.now() : null })));
  app.post("/api/policy/bot/boundary", bot((b) => boundary(b)));
  app.post("/api/policy/bot/report", big, bot((b) => report(b)));
  app.post("/api/policy/bot/ack", bot(async (b) => ({ ok: true, acked: await C.ack(b.keys) })));
  app.post("/api/policy/admin/cutover", big, bot((b) => cutover(b)));
  require("./gscale").register(app, { isBotToken, addUser });      // Q11: the activity-scaled guarantee's series + admin card
  app.post("/api/policy/admin/rollback", bot((b) => rollback(b)));
  if (process.env.STAGING) {
    app.post("/api/policy/admin/test-clock", bot(async (b) => ({ ok: true, offset_ms: await C.setTestClock(b.at === undefined ? null : b.at) })));
    app.post("/api/policy/admin/tick", bot(async (b) => {
      const tag = b.tag === undefined || b.tag === null ? null : String(b.tag);
      if (tag !== null && !TAG_RE.test(tag)) return { ok: false, error: "bad tag" };
      const at = b.at === undefined ? C.nowS() : Number(b.at);
      const only = Array.isArray(b.engines) ? b.engines.map(String) : null;
      return { ok: true, at, ran: await pass(at, { tag, only }), view: await view() };
    }));
    app.post("/api/policy/admin/inspect", bot(async (b) => {
      const { getQuery } = require("../dbUtils");
      if (b.sim) return { ok: true, sim: (await getQuery("SELECT * FROM policy_sims WHERE key = ?", [String(b.sim)]))[0] || null };
      if (b.run) return { ok: true, run: await C.run(String(b.engine || ""), String(b.run)) };
      return { ok: true, view: await view() };
    }));
  }

  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await require("../dbUtils").getQuery("SELECT class, username, userId FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!require("../siteperms").can(row, "econ.telemetry_policy")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/policy", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try { res.json(Object.assign({ ok: true }, await view())); } catch (e) { console.error("[policy] view:", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/admin/policy/mode", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("../middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    // PO-0b (D-6): an engine's mode is a Pepe OWNER's (class + the owner role on the linked chat login); reading stays Admins'
    const SR = require("../staffroles");
    if (!(await SR.ownerOf(me, "econ.telemetry_policy"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    const b = req.body || {};
    const engine = String(b.engine || ""), m = String(b.mode || "");
    if (!C.ENGINES.includes(engine) || !["off", "dry", "shadow"].includes(m)) return res.status(400).json({ ok: false, error: "Pick an engine and off / dry / shadow (live is Pepe's cutover)." });
    const cur = (await C.engines())[engine];
    if (cur.mode === "live") return res.status(409).json({ ok: false, error: "That engine runs on the site now - hand it back from Pepe (!econ engines rollback) first." });
    try {
      res.json(Object.assign({ ok: true }, await C.setMode(engine, m, { by: me.username, byId: me.userId, via: "admin", note: String(b.note || "").slice(0, 200) || null })));
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "failed" }); }
  });
  // PO-1 (T3): pause / resume an engine - a Pepe OWNER's, with the password step-up (the /admin/economy nonce + the account's
  // password); the VPS shell has tools/policy-backend.js pause|resume (no role needed)
  app.post("/api/admin/policy/pause", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const me = await admin(req, res);
    if (!me) return;
    // plan §8: step-up + CSRF + same-site fetch (PO-1 review: the card's x-csrf-token is checked, as on the sibling step-up routes)
    if (req.get("X-Requested-With") !== "fetch" || !require("../middleware/authGuard").sameSite(req)
        || !require("../pepecontrol").csrfOk(me.username, req.get("x-csrf-token"))) {
      return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    }
    const SR = require("../staffroles");
    if (!(await SR.ownerOf(me, "econ.telemetry_policy"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR.OWNER_ONLY });
    const b = req.body || {};
    const engine = String(b.engine || "");
    const list = engine === "all" ? C.ENGINES.slice() : [engine];
    if (!list.every((e) => C.ENGINES.includes(e))) return res.status(400).json({ ok: false, error: "Pick an engine (or all)." });
    if (typeof b.pause !== "boolean") return res.status(400).json({ ok: false, error: "Say pause or resume." });
    const note = String(b.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (b.pause && note.length < 3) return res.status(400).json({ ok: false, error: "Say why in the note - every pause is logged and every admin is told." });
    try { await require("../econstore").stepUp(me, b); } catch (e) { return res.status(e.status || 403).json({ ok: false, code: e.code || null, error: e.message }); }
    try {
      res.json({ ok: true, engines: await setPause(list, b.pause, { by: me.username, auditId: me.userId, via: "admin", note: note || null }) });
    } catch (e) { console.error("[policy] pause:", e); res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "failed" }); }
  });

  const iv = setInterval(() => loop().catch(() => {}), PASS_MS);
  if (iv.unref) iv.unref();
}

module.exports = { register, pass, loop, boundary, report, cutover, rollback, setPause, view, botState, diff, diffCapped, applyWhitelist, decisionDiff, planOf, kindOf,
                   clockInfo, cutoffPending, cutoffWait, monetaryGuarantee, burnWindow, WHITELIST, DIFF_CAP, LATE_GRACE_S, OVERDUE_ALERT_S, BURN_SETTLE_S, BURN_BACKFILL_DAYS,
                   MISSED_DAYS, MISSED_WEEKS,
                   // tests: forget what THIS process remembers (the waits logged, the sweeps done, the seen marks written) - a "restart"
                   _resetPassClock: () => { waitLogged.clear(); overdueSeen.clear(); swept.clear(); seenDone.clear(); } };
