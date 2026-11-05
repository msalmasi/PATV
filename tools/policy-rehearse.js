// H2a forced-leg kit. Disposable staging copies only; setup and undo conserve PAT.
// Scheduler mint/burn results are evidence, never reversed by a compensating mint.
"use strict";
const fs = require("fs");
const path = require("path");
const LEGS = ["floor", "guarantee", "ceiling", "burn", "overflow"];
function refuse(message) { throw new Error(message); }
function guard(db, env = process.env) {
  if (env.PATV_ENV !== "staging" || env.STAGING !== "1") refuse("PATV_ENV=staging and STAGING=1 required");
  if (!db || !fs.existsSync(db)) refuse("existing database required");
  const resolved = fs.realpathSync(db);
  // A separate, explicitly named rehearsal directory is required even on staging.
  // Resolve links first so an alias cannot point this at the deployed database.
  const parts = resolved.replace(/\\/g, "/").split("/");
  if (parts.some((p) => /^(?:(?:prod(?:uction)?|live)(?:[-_.].*)?|PATV)$/i.test(p)) ||
      !parts.some((p) => /^policy-rehearsal-[a-z0-9_-]+$/i.test(p)) || path.basename(resolved) !== "myapp.db") {
    refuse("database must be a disposable policy-rehearsal-<id>/myapp.db, outside production paths");
  }
  return resolved;
}
function valid(o) {
  if (!/^[a-z0-9]{1,8}$/.test(o.tag || "")) refuse("tag: 1-8 lowercase letters/digits required");
  if (!LEGS.includes(o.leg)) refuse("leg: " + LEGS.join("|"));
  if (!Number.isFinite(o.at) || o.at <= 0) refuse("explicit UTC --at required");
}
function targets(leg, inp) {
  const E = require("../policy/engines"), c = E.C(inp), b = inp.pools;
  if (leg === "floor") return { reserve: Math.max(0, Number(c.raw("fed_floor")) - 1) };
  if (leg === "ceiling") return { reserve: Number(c.raw("fed_ceiling")) + 1000000 };
  if (leg === "guarantee") return { incentives: 0 };
  if (leg === "burn") return { burn: Number(b.burn || 0) + 250000 };
  return { fortknox: E.heistCap(inp, c, "fortknox", inp.now) + 1000000 };
}
// Only these system pools supply synthetic setup. No wallets, House, escrow or pots.
function transfers(before, wanted) {
  const b = Object.assign({}, before), out = [];
  for (const [dst, target] of Object.entries(wanted)) {
    if (!Number.isSafeInteger(target) || target < 0) refuse("unsafe target");
    const change = target - Number(b[dst] || 0);
    if (change < 0) {
      const sink = dst === "reserve" ? "incentives" : "reserve";
      out.push([dst, change], [sink, -change]); b[dst] = target; b[sink] = Number(b[sink] || 0) - change;
    } else {
      let left = change;
      for (const src of ["reserve", "incentives", "fortknox", "mm", "bank"]) {
        if (src === dst || Object.hasOwn(wanted, src)) continue;
        const n = Math.min(left, Number(b[src] || 0));
        if (n > 0) { out.push([src, -n], [dst, n]); b[src] -= n; b[dst] = Number(b[dst] || 0) + n; left -= n; }
        if (!left) break;
      }
      if (left) refuse("insufficient system PAT for forced state; use a different disposable copy");
    }
  }
  const merged = new Map();
  for (const [p, n] of out) merged.set(p, (merged.get(p) || 0) + n);
  return [...merged].filter(([, n]) => n).sort((a, z) => a[1] - z[1]);
}
function reached(leg, plan) {
  return leg === "floor" ? plan.floor_mint > 0 : leg === "guarantee" ? plan.guarantee_paid > 0 :
    leg === "ceiling" ? plan.excess > 0 : leg === "overflow" ? plan.overflow > 0 : plan.amount > 0;
}
async function inputs(o) {
  const G = require("../policy/gather"), SCH = require("../policy/scheduler");
  const info = await SCH.clockInfo(o.at, o.tag);
  if (o.leg === "guarantee" && info.db !== info.eb) refuse("guarantee requires a test-clock Monday");
  return o.leg === "overflow" ? G.daily(o.at, info.did) : G.monetary(o.at, info.did, o.leg === "guarantee");
}
function plan(o, inp) {
  const E = require("../policy/engines");
  return o.leg === "overflow" ? E.planDaily(inp) : E.planMonetary(inp);
}
async function setup(o) {
  valid(o);
  const D = require("../dbUtils"), C = require("../policy/core"), P = require("../pools");
  await C.init(); await P.init();
  const key = `rehearse:${o.tag}:${o.leg}`;
  return D.tx(async () => {
    const old = await C.meta(key);
    if (old) {
      if (old.at !== o.at) refuse("tag already bound to another clock");
      return Object.assign({}, old, { dup: true });
    }
    const before = await P.balances(), inp = await inputs(o), wanted = targets(o.leg, inp);
    const legs = transfers(before, wanted);
    const result = legs.length ? await P.move({ key, legs, flow: "policy_rehearsal", why: "forced " + o.leg, via: "staging", terminal: true }) : { ok: true };
    const after = await P.balances();
    let preview = null;
    if (result.ok) {
      if (o.leg === "burn") {
        const burn = await require("../policy/source").burn();
        preview = { amount: Math.max(0, Number(after.burn || 0) - burn.inflight), mode: burn.cfg.mode };
        if (preview.mode !== "accrual") refuse("burn requires existing accrual mode; transaction undone");
      } else preview = plan(o, await inputs(o));
      if (!reached(o.leg, preview)) refuse("configuration/journal prevents the requested leg; transaction undone; do not change policy to force it");
    }
    const record = { key, leg: o.leg, tag: o.tag, at: o.at, before, after, legs, result, preview, undone: false };
    await C.setMeta(key, record);
    return record;
  });
}
async function undo(o) {
  valid(o);
  const D = require("../dbUtils"), C = require("../policy/core"), P = require("../pools");
  return D.tx(async () => {
    const key = `rehearse:${o.tag}:${o.leg}`, r = await C.meta(key);
    if (!r || r.at !== o.at) refuse("no matching setup");
    if (r.undone) return { ok: true, dup: true };
    if (!r.result.ok) return { ok: false, refused: true };
    if (JSON.stringify(await P.balances()) !== JSON.stringify(r.after)) refuse("balances changed since setup; restore disposable copy, never reverse a real mint/burn");
    const legs = r.legs.map(([p, n]) => [p, -n]).sort((a, b) => a[1] - b[1]);
    const result = legs.length ? await P.move({ key: key + ":undo", legs, kind: "rollback", flow: "policy_rehearsal", why: "undo synthetic setup", via: "staging", terminal: true }) : { ok: true };
    if (!result.ok) return result;
    const b = await P.balances();
    for (const p of new Set([...Object.keys(b), ...Object.keys(r.before)])) if (Number(b[p] || 0) !== Number(r.before[p] || 0)) refuse("undo balance mismatch");
    await C.setMeta(key, Object.assign({}, r, { undone: true }));
    return { ok: true, restored: b };
  });
}
async function inspect(o) {
  const { getQuery } = require("../dbUtils");
  const suffix = "%" + o.tag;
  const hasFed = (await getQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fed_records'")).length;
  return {
    runs: await getQuery("SELECT * FROM policy_runs WHERE period LIKE ? ORDER BY key", [suffix]),
    comparisons: await getQuery("SELECT engine, period, site_plan, pepe_plan, engine_diff, input_diff, total_diff, blocking, ok FROM policy_sims WHERE period LIKE ? ORDER BY key", [suffix]),
    effects: await getQuery("SELECT * FROM policy_effects WHERE period LIKE ? ORDER BY key", [suffix]),
    mints: await getQuery("SELECT * FROM policy_mints WHERE key LIKE ? ORDER BY key", [suffix]),
    fed_records: hasFed ? await getQuery("SELECT * FROM fed_records WHERE key LIKE ? ORDER BY key", [suffix]) : [],
    moves: await getQuery("SELECT key, kind, net, legs, result FROM pool_moves WHERE key LIKE ? OR key LIKE ? OR key IN (SELECT key FROM policy_effects WHERE period LIKE ?) ORDER BY rowid", ["rehearse:" + o.tag + ":%", "%" + o.tag + "%", suffix]),
  };
}
async function tick(o) {
  valid(o);
  const C = require("../policy/core"), SCH = require("../policy/scheduler"), D = require("../dbUtils");
  const r = await C.meta(`rehearse:${o.tag}:${o.leg}`);
  if (!r || !r.result.ok || r.undone || r.at !== o.at) refuse("active matching setup required");
  const engine = o.leg === "overflow" ? "treasury" : o.leg === "burn" ? "burn" : "monetary";
  const prior = await C.meta("test_clock");
  try {
    await D.tx(() => C.setTestClock(o.at));
    const ran = await SCH.pass(o.at, { tag: o.tag, only: [engine] });
    return { ran, evidence: await inspect(o), note: "Missing Pepe report or ok != 1 is NOT a rehearsal pass. No mode was changed." };
  } finally {
    await D.tx(() => C.setMeta("test_clock", prior || { offset_ms: 0, at: null }));
    await C.loadTestClock();
  }
}
async function main(argv) {
  const command = argv.shift(), o = {};
  for (const a of argv) { const m = /^--(db|leg|tag|at)=(.+)$/.exec(a); if (!m) refuse("unknown option"); o[m[1]] = m[2]; }
  const db = guard(o.db);
  if (!["setup", "undo", "tick", "inspect"].includes(command)) refuse("command: setup|undo|tick|inspect");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(o.at || "")) refuse("--at must be an explicit UTC ISO timestamp ending Z");
  o.at = Date.parse(o.at) / 1000; valid(o);
  process.chdir(path.dirname(db));
  // No module that opens SQLite may load before guard() and chdir().
  const D = require("../dbUtils");
  try {
    const tables = new Set((await D.getQuery("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name));
    for (const t of ["users", "pools", "policy_engines", "policy_runs", "policy_sims"]) if (!tables.has(t)) refuse("not an initialized staging copy: missing " + t);
    console.log(JSON.stringify(await ({ setup, undo, tick, inspect })[command](o), null, 2));
  } finally { await new Promise((resolve, reject) => D.db.close((e) => e ? reject(e) : resolve())); }
}
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error("REFUSED: " + e.message); process.exitCode = 1; });
module.exports = { guard, valid, targets, transfers, reached, setup, undo, tick, inspect };
