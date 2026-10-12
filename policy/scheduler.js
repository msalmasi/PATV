// policy/scheduler.js — Phase 4 of the backend migration: ONE site scheduler for the economy's policy engines (the treasury's
// Monday waterfall + daily release, the monetary day, the burn accrual). docs/policy-engines-cutover-runbook.md.
//
// THE CLOCK. Every 15 s the process that holds the lease (policy_lease "scheduler", 90 s, renewed each pass: a restart or a
// second process never runs a pass alongside it) looks at each engine's period NOW - exactly the rules of Pepe's ticks:
//   treasury   (econ_layers + econ_treasury on) the week "W<Monday>" when its 04:00 UTC boundary is after the engine was
//              armed and it hasn't run; then the day "D<date>" likewise (the epoch first, as _tr_tick)
//   monetary   (econ_layers on) the day "D<date>"; on the Monday the epoch settles it waits for the epoch (12 h at most, then
//              runs without the guarantee) and for the daily release (1 h at most), as _mo_tick
//   burn       (accrual mode) one burn per accrual_every_min slot "A<slot>"
// Only the CURRENT period runs (catch-up cap: a pass after an outage runs today's / this week's once; an older missed period is
// logged as "missed" and never run - Pepe's armed_at rule, which never runs a past day either).
//
// MODES (policy_engines): off · dry (plan and record what WOULD move: policy_sims "dry:<engine>:<period>") · shadow (the same,
// and Pepe's own run is compared: POST /api/policy/bot/report {engine, period, inputs, plan} -> the ENGINE diff = this site's
// plan on Pepe's inputs vs his plan (must be empty: the port), the INPUTS diff = this site's inputs vs his, the TOTAL diff =
// this site's plan on its own inputs vs his) · live (this site runs it - policy/apply.js - and Pepe doesn't: only through the
// cutover handshake, never from the admin page).
//
// Bot routes (bot token, POST):
//   /api/policy/bot/state    -> {engines, effects (his books' updates not acked yet), lease, cfg_age}
//   /api/policy/bot/config   {cfg}   Pepe's constants, effective econ_cfg, flags, his journals (every 5 min and at start)
//   /api/policy/bot/report   {engine, period, inputs, plan}   shadow: his run, compared
//   /api/policy/bot/ack      {keys}  effects he applied
//   /api/policy/admin/cutover  {key, engines, handover, actor}   shadow -> live for those engines (idempotent by key)
//   /api/policy/admin/rollback {key, engines, actor, to}         live -> shadow (default) or off; answers the periods this
//                                                                site ran and every effect Pepe hasn't applied (idempotent)
//   /api/policy/admin/test-clock {at}   STAGING only: the scheduler's clock jumps to `at` (s) - nothing else moves
//   /api/policy/admin/tick {at, tag, engines}  STAGING only: one pass at `at` with period ids "<id>-<tag>" (the rehearsal)
// Admin (signed in, class Admin): GET /api/admin/policy · POST /api/admin/policy/mode {engine, mode, note} (off / dry / shadow).
"use strict";
const C = require("./core");
const E = require("./engines");
const G = require("./gather");
const A = require("./apply");

const PASS_MS = 15000;
const RETRY_FAILED_S = 300;
const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,120}$/;
const TAG_RE = /^[a-z0-9]{1,8}$/;
const log = (m) => console.log(`[policy] ${m}`);

// ── what is due ──
async function clockInfo(nowS, tag) {
  const push = (await C.cfg()) || {};
  const hour = Math.trunc(Number(((push.consts || {}).VAULT_EPOCH_UTC_HOUR) ?? 4));
  const sfx = tag ? `-${tag}` : "";
  return { push, flags: push.flags || {}, hour, eid: E.epochId(nowS, hour) + sfx, eb: E.weekStart(nowS, hour), did: E.dayId(nowS, hour) + sfx,
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

/** The catch-up cap: only the current period runs; an earlier one that never ran (the site was down through it) is logged. */
async function markMissed(engine, period, boundary, armed) {
  if (!armed || boundary < armed) return;
  const r = await C.run(engine, period);
  if (r) return;
  await C.putRun(engine, period, { state: "missed", boundary, via: "site", error: "the site was down through this period - not run late (catch-up cap 1)" });
  log(`${engine} ${period}: MISSED (not run late)`);
}

async function treasuryPass(nowS, info, eng, out) {
  if (!info.flags.layers || !info.flags.tr_live) return;
  const armed = Number(eng.armed_at || 0);
  if (!armed) return;
  if (eng.mode === "live" && !info.sfx) {
    await markMissed("treasury", E.epochId(info.eb - 7 * 86400, info.hour), info.eb - 7 * 86400, armed);
    await markMissed("treasury", E.dayId(info.db - 86400, info.hour), info.db - 86400, armed);
  }
  for (const [period, boundary, kind] of [[info.eid, info.eb, "epoch"], [info.did, info.db, "daily"]]) {
    if (boundary < armed) continue;
    if (eng.mode === "live") {
      if (!(await runnable("treasury", period))) continue;
      try {
        const r = kind === "epoch" ? await A.runTreasuryEpoch(period, nowS) : await A.runTreasuryDaily(period, nowS);
        if (!r.already) { out.push(`treasury ${period}`); log(`treasury ${period}: ran (${kind})`); }
      } catch (e) { await failed("treasury", period, e); }
    } else if (eng.mode === "dry" || eng.mode === "shadow") {
      if (await simExists(eng.mode, "treasury", period)) continue;
      const inputs = kind === "epoch" ? await G.epoch(nowS, period) : await G.daily(nowS, period);
      const plan = kind === "epoch" ? E.planEpoch(inputs) : E.planDaily(inputs);
      await sim(eng.mode, "treasury", period, inputs, plan);
      out.push(`${eng.mode} treasury ${period}`);
    }
  }
}

async function monetaryGuarantee(nowS, info, push) {
  const c = Object.assign({}, E.DEFAULTS, (await G.config()).cfg || {});
  let guarantee = false;
  const trLive = !!info.flags.tr_live;
  if (c.incentive_guarantee && trLive && Math.trunc(info.eb) === Math.trunc(info.db)) {
    const j = (await G.journal(push)).find((r) => r.eid === info.eid) || {};
    if (j.state !== "done") {
      if (nowS - info.db < E.GUARANTEE_WAIT) return { wait: "the epoch" };
      log(`${info.did}: epoch ${info.eid} still not settled - running without the guarantee`);
    } else guarantee = true;
  }
  if (trLive && !(await G.dailyDone(push, info.did)) && nowS - info.db < 3600) return { wait: "the daily release" };
  return { guarantee };
}
async function monetaryPass(nowS, info, eng, out) {
  if (!info.flags.layers) return;
  const armed = Number(eng.armed_at || 0);
  if (!armed || info.db < armed) return;
  if (eng.mode === "live") {
    if (!info.sfx) await markMissed("monetary", E.dayId(info.db - 86400, info.hour), info.db - 86400, armed);
    if (!(await runnable("monetary", info.did))) return;
    const g = await monetaryGuarantee(nowS, info, info.push);
    if (g.wait) return;
    try {
      const r = await A.runMonetary(info.did, nowS, g.guarantee);
      if (!r.already) { out.push(`monetary ${info.did}`); log(`monetary ${info.did}: ran${g.guarantee ? " (with the guarantee)" : ""}`); }
    } catch (e) { await failed("monetary", info.did, e); }
  } else if (eng.mode === "dry" || eng.mode === "shadow") {
    if (await simExists(eng.mode, "monetary", info.did)) return;
    const g = await monetaryGuarantee(nowS, info, info.push);
    if (g.wait) return;
    const inputs = await G.monetary(nowS, info.did, g.guarantee);
    const plan = E.planMonetary(inputs);
    const a = plan.activity || {};
    plan._activity_payouts = a.amount > 0 ? E.planActivity(inputs, a.local_day, a.amount) : [];
    await sim(eng.mode, "monetary", info.did, inputs, plan);
    out.push(`${eng.mode} monetary ${info.did}`);
  }
}

async function burnPass(nowS, info, eng, out) {
  const bc = info.push.burn_cfg || {};
  if (bc.mode !== "accrual") return;
  if (!(await require("../pools").live())) return;
  const every = Math.max(1, Math.trunc(Number(bc.accrual_every_min) || 5)) * 60;
  const period = `A${Math.floor(nowS / every)}${info.sfx}`;
  if (eng.mode === "live") {
    if (!(await runnable("burn", period))) return;
    try {
      const r = await A.runBurn(period, nowS, { inflight: info.push.burn_inflight || 0 });
      if (r.amount) { out.push(`burn ${period} ${r.amount}`); log(`burned ${r.amount} PAT (${r.id})`); }
    } catch (e) { await failed("burn", period, e); }
  } else if (eng.mode === "dry" || eng.mode === "shadow") {
    if (await simExists(eng.mode, "burn", period)) return;
    const bal = await require("../pools").balance("burn");
    const amt = Math.max(0, bal - Math.max(0, Math.trunc(Number(info.push.burn_inflight) || 0)));
    if (amt > 0) { await sim(eng.mode, "burn", period, { balance: bal, inflight: info.push.burn_inflight || 0 }, { amount: amt }); out.push(`${eng.mode} burn ${period}`); }
  }
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
  if ((!only || only.includes("treasury")) && engs.treasury.mode !== "off") await treasuryPass(nowS, info, engs.treasury, out);
  if ((!only || only.includes("monetary")) && engs.monetary.mode !== "off") await monetaryPass(nowS, info, engs.monetary, out);
  if ((!only || only.includes("burn")) && engs.burn.mode !== "off") await burnPass(nowS, info, engs.burn, out);
  if (out.some((x) => !/^(dry|shadow) /.test(x))) await recordSupply();
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

// ── shadow: Pepe's report ──
function diff(a, b, where = "", out = [], depth = 0) {
  if (out.length >= 40) return out;
  if (typeof a === "number" && typeof b === "number") { if (a !== b) out.push(`${where}: site ${a} / pepe ${b}`); return out; }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (a !== b && !(a === undefined && b === null) && !(a === null && b === undefined)) out.push(`${where}: site ${JSON.stringify(a)} / pepe ${JSON.stringify(b)}`.slice(0, 300));
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) { out.push(`${where}: shape`); return out; }
    if (a.length !== b.length) out.push(`${where}: ${a.length} items / pepe ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${where}[${i}]`, out, depth + 1);
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], where ? `${where}.${k}` : k, out, depth + 1);
  return out;
}
function planOf(engine, inputs) {
  if (inputs.kind === "epoch") return E.planEpoch(inputs);
  if (inputs.kind === "daily") return E.planDaily(inputs);
  if (inputs.kind === "monetary") {
    const p = E.planMonetary(inputs);
    const a = p.activity || {};
    p._activity_payouts = a.amount > 0 ? E.planActivity(inputs, a.local_day, a.amount) : [];
    return p;
  }
  throw new Error("unknown inputs kind");
}
const INPUT_SKIP = new Set(["now", "kind"]);
function inputDiff(site, pepe) {
  const a = {}, b = {};
  for (const k of Object.keys(pepe || {})) if (!INPUT_SKIP.has(k)) { a[k] = (site || {})[k]; b[k] = pepe[k]; }
  return diff(a, b);
}
async function report(b) {
  await C.init();
  const engine = String(b.engine || "");
  const period = String(b.period || "");
  if (!C.ENGINES.includes(engine) || !/^[A-Za-z0-9-]{2,40}$/.test(period)) return { ok: false, error: "bad report" };
  const inputs = b.inputs && typeof b.inputs === "object" ? b.inputs : null;
  const plan = b.plan && typeof b.plan === "object" ? b.plan : null;
  if (!inputs || !plan) return { ok: false, error: "no inputs / plan" };
  const replay = planOf(engine, inputs);
  const engineDiff = diff(replay, plan);
  // this site's own view of the same moment (Pepe reports BEFORE his legs move)
  let siteInputs = null, sitePlan = null, inDiff = [], totDiff = [];
  try {
    const nowS = Number(inputs.now);
    if (inputs.kind === "epoch") siteInputs = await G.epoch(nowS, inputs.eid);
    else if (inputs.kind === "daily") siteInputs = await G.daily(nowS, inputs.did);
    else siteInputs = await G.monetary(nowS, inputs.did, inputs.guarantee);
    sitePlan = planOf(engine, siteInputs);
    inDiff = inputDiff(siteInputs, inputs);
    totDiff = diff(sitePlan, plan);
  } catch (e) { inDiff = [`site gather failed: ${e.message}`]; }
  const { runQuery } = require("../dbUtils");
  const key = `shadow:${engine}:${period}`;
  const t = Date.now();
  await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, site_inputs, site_plan, pepe_inputs, pepe_plan, replay_plan, engine_diff, input_diff,
                  total_diff, ok, created, updated) VALUES (?, 'shadow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET site_inputs = excluded.site_inputs, site_plan = excluded.site_plan, pepe_inputs = excluded.pepe_inputs,
                    pepe_plan = excluded.pepe_plan, replay_plan = excluded.replay_plan, engine_diff = excluded.engine_diff, input_diff = excluded.input_diff,
                    total_diff = excluded.total_diff, ok = excluded.ok, updated = excluded.updated`,
                 [key, engine, period, JSON.stringify(siteInputs), JSON.stringify(sitePlan), JSON.stringify(inputs), JSON.stringify(plan), JSON.stringify(replay),
                  JSON.stringify(engineDiff), JSON.stringify(inDiff), JSON.stringify(totDiff), engineDiff.length ? 0 : 1, t, t]);
  const msg = `shadow ${engine} ${period}: engine diff ${engineDiff.length}, inputs diff ${inDiff.length}, total diff ${totDiff.length}`;
  if (engineDiff.length || totDiff.length) console.warn(`[policy] ${msg}: ${[...engineDiff, ...totDiff].slice(0, 6).join(" | ")}`); else log(msg);
  return { ok: true, engine_diff: engineDiff, input_diff: inDiff, total_diff: totDiff };
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
        if (!/^[A-Za-z0-9-]{2,40}$/.test(period)) continue;
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

// ── views ──
async function lastSim(engine) {
  const { getQuery } = require("../dbUtils");
  const r = (await getQuery("SELECT key, mode, period, engine_diff, input_diff, total_diff, ok, updated FROM policy_sims WHERE engine = ? ORDER BY updated DESC LIMIT 1", [engine]))[0];
  if (!r) return null;
  return { key: r.key, mode: r.mode, period: r.period, ok: r.ok === null ? null : !!r.ok, updated: r.updated,
           engine_diff: C.parse(r.engine_diff, null), input_diff: C.parse(r.input_diff, null), total_diff: C.parse(r.total_diff, null) };
}
function nextRun(engine, nowS, push) {
  const hour = Math.trunc(Number(((push.consts || {}).VAULT_EPOCH_UTC_HOUR) ?? 4));
  if (engine === "burn") {
    const every = Math.max(1, Math.trunc(Number((push.burn_cfg || {}).accrual_every_min) || 5)) * 60;
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
  const push = (await C.cfg()) || {};
  const nowS = C.nowS();
  const out = [];
  for (const e of C.ENGINES) {
    const last = (await getQuery("SELECT key, period, state, via, error, created, done FROM policy_runs WHERE engine = ? ORDER BY created DESC LIMIT 1", [e]))[0] || null;
    out.push(Object.assign({}, engs[e], { last_run: last, next_run: nextRun(e, nowS, push), last_diff: await lastSim(e) }));
  }
  // Pepe's participation day vs this site's (time zone check: the activity rewards read the day by it)
  let tzOk = null;
  if (Array.isArray(push.local_check) && push.local_check.length === 2) tzOk = G.localDay(Number(push.local_check[0]), push.tz || "America/New_York") === push.local_check[1];
  return { engines: out, retired: C.RETIRED, stays: C.STAYS, lease: await C.leaseInfo(), cfg_age_s: Math.round(await C.cfgAge()), tz_ok: tzOk,
           flags: push.flags || null, now: nowS, test_clock: C._testOffset() ? { offset_ms: C._testOffset() } : null,
           effects_open: (await getQuery("SELECT COUNT(*) AS n FROM policy_effects WHERE acked_at IS NULL"))[0].n,
           audit: await getQuery("SELECT ts, by, via, engine, old, new, note FROM policy_audit ORDER BY id DESC LIMIT 30"),
           runs: await getQuery("SELECT key, engine, period, state, via, error, created, done FROM policy_runs ORDER BY created DESC LIMIT 30"),
           sims: (await getQuery("SELECT key, mode, engine, period, ok, updated FROM policy_sims ORDER BY updated DESC LIMIT 30")) };
}
async function botState() {
  await C.init();
  const engs = await C.engines();
  return { ok: true, engines: Object.fromEntries(Object.entries(engs).map(([k, v]) => [k, { mode: v.mode, armed_at: v.armed_at }])),
           effects: await C.effectsOpen(200), lease: await C.leaseInfo(), cfg_age_s: Math.round(await C.cfgAge()), now: C.nowS() };
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
  app.post("/api/policy/bot/report", big, bot((b) => report(b)));
  app.post("/api/policy/bot/ack", bot(async (b) => ({ ok: true, acked: await C.ack(b.keys) })));
  app.post("/api/policy/admin/cutover", big, bot((b) => cutover(b)));
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
    if (!row || row.class !== "Admin") { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
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
    const b = req.body || {};
    const engine = String(b.engine || ""), m = String(b.mode || "");
    if (!C.ENGINES.includes(engine) || !["off", "dry", "shadow"].includes(m)) return res.status(400).json({ ok: false, error: "Pick an engine and off / dry / shadow (live is Pepe's cutover)." });
    const cur = (await C.engines())[engine];
    if (cur.mode === "live") return res.status(409).json({ ok: false, error: "That engine runs on the site now - hand it back from Pepe (!econ engines rollback) first." });
    try {
      res.json(Object.assign({ ok: true }, await C.setMode(engine, m, { by: me.username, byId: me.userId, via: "admin", note: String(b.note || "").slice(0, 200) || null })));
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "failed" }); }
  });

  const iv = setInterval(() => loop().catch(() => {}), PASS_MS);
  if (iv.unref) iv.unref();
}

module.exports = { register, pass, loop, report, cutover, rollback, view, botState, diff, planOf, clockInfo };
