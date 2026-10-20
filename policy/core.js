// policy/core.js — Phase 4 of the backend migration: the store of the site's policy scheduler (docs/policy-engines-cutover-runbook.md).
//
// ONE scheduler owns the economy's clock-driven policy engines once they are cut over (policy/scheduler.js):
//   treasury   the Monday 04:00 UTC surplus waterfall + the daily 04:00 release      (pepe_treasury._tr_tick)
//   monetary   the daily Fed band (floor mint / ceiling release), the Monday guarantee, issuance, the activity rewards
//                                                                                     (pepe_monetary._mo_tick)
//   burn       the burn reserve's accrual burn                                        (pepe_burn._burn_tick)
// Each engine has a MODE here: off | dry (compute and record what WOULD move) | shadow (compute alongside Pepe and diff his
// plan every period) | live (the site runs it; Pepe's switch for it is on and he doesn't). Every change is audit-logged.
//
//   policy_engines   engine PK, mode, armed_at (s: periods whose boundary is before it are never run), updated, by, note;
//                    PO-1: paused (0/1) - the owner's PAUSE (policy/scheduler.setPause): a paused engine runs nothing (a live
//                    one's due periods are recorded missed "paused"), its mode unchanged; paused_by / paused_at (ms) /
//                    pause_note: who last paused or resumed it, when, why (every change is in policy_audit + admin_audit)
//   policy_runs      key PK "<engine>:<period>" - the DONE-KEY of a live run (one per period, ever): state moving|done|failed|
//                    handed (a period Pepe ran, recorded at the cutover so the site never runs it again), inputs, plan, result
//   policy_sims      key PK "<mode>:<engine>:<period>" - dry runs and shadow comparisons (site plan, Pepe's report, the diffs);
//                    PO-1: site_boundary_inputs / site_boundary_plan / boundary_ts - the site's snapshot at the period's
//                    BOUNDARY (POST /api/policy/bot/boundary, before Pepe moves a leg; written once, never overwritten), the
//                    comparison's basis; truncated (a diff hit its cap); whitelisted (the informational diffs excused)
//   policy_effects   key PK - what Pepe mirrors into his own books (a mint record, a loan repayment, a budget spend, the day /
//                    epoch records, a burn, a cap notice); acked by him; the site never needs the ack to stay correct (it
//                    overlays its own effects on Pepe's pushed docs by content, policy/gather.js)
//   policy_mints     key PK - the Fed mints the site made (floor / issuance), the authority for the caps until Pepe's doc has them
//   policy_lease     name PK, holder, expires - one scheduler process at a time (a restart / a second process waits it out)
//   policy_meta      cfg (Pepe's config push), test clock (staging only), catch-up cap
//   policy_audit     every mode change / cutover / rollback (who, from, to, why)
// PAT moves only through pools.js (keyed legs: the SAME keys Pepe's legs use, so the two can never both move one), the
// capital share book (capital/vaults.protocol, keyed like Pepe's booking) and the ledger, each run in ONE dbUtils.tx.
"use strict";
const crypto = require("crypto");
const os = require("os");
const { runQuery, getQuery } = require("../dbUtils");

const ENGINES = ["treasury", "monetary", "burn"];
const MODES = ["off", "dry", "shadow", "live"];
// what Phase 4 does NOT run as an engine, and why (the admin card shows it)
const RETIRED = {
  automint: "retired: dead under the economy layers (pepe_layers._layers_no_mint refuses every automint since E-1; prod has econ_layers on)",
  wheel_cut: "retired: removed in 1.99pk (the House keeps 100% of wheel turnover)",
  casino_feed: "retired: a no-op under the live treasury (feed 0, overflow in the daily release, no Reserve top-up); v1 stays Pepe's",
  layers_recovery: "subsumed: every site run is one transaction keyed by its period (nothing half-done to finish); Pepe keeps his for his own Fed ops",
};
const STAYS = {
  room_payouts: "stays in Pepe: the E-4 recipe, activity -> pads and profile vaults score Camfrog observations (anti-AFK chat, speech-verified mic, convoys)",
  launchpad: "stays in Pepe: grants are paid after an admin review on the site; the momentum is already the site's",
  fed_ops: "P4-1: admin mint / fund / fedloan / flash / donation mints are events on the site's fed/service.js (one writer for the journal and the mint caps) once the Fed events backend is live; Pepe's commands are its thin client",
};
const LEASE_MS = 90 * 1000;
const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;

const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS policy_engines (engine TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'off', armed_at REAL, updated INTEGER, by TEXT, note TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_runs (key TEXT PRIMARY KEY, engine TEXT NOT NULL, period TEXT NOT NULL, state TEXT NOT NULL,
        boundary REAL, via TEXT, inputs TEXT, plan TEXT, result TEXT, error TEXT, created INTEGER, done INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS policy_runs_engine ON policy_runs (engine, created)");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_sims (key TEXT PRIMARY KEY, mode TEXT NOT NULL, engine TEXT NOT NULL, period TEXT NOT NULL,
        site_inputs TEXT, site_plan TEXT, pepe_inputs TEXT, pepe_plan TEXT, replay_plan TEXT, engine_diff TEXT, input_diff TEXT, total_diff TEXT,
        ok INTEGER, created INTEGER, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS policy_sims_engine ON policy_sims (engine, updated)");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_effects (key TEXT PRIMARY KEY, engine TEXT, period TEXT, kind TEXT NOT NULL, data TEXT NOT NULL,
        created INTEGER NOT NULL, acked_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS policy_effects_open ON policy_effects (acked_at, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS policy_mints (key TEXT PRIMARY KEY, rec TEXT NOT NULL, ts REAL, created INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS policy_lease (name TEXT PRIMARY KEY, holder TEXT, expires INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS policy_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, by TEXT, via TEXT, engine TEXT,
        old TEXT, new TEXT, note TEXT)`);
      // PO-1: the pause (policy_engines) and the boundary snapshot / diff cap (policy_sims) on tables that already exist on prod
      // (literal statements: test/fixtures/schemascan.js reads every ADD COLUMN for the account-merge coverage check)
      const pe = await columnsOf("policy_engines");
      if (!pe.has("paused")) await runQuery("ALTER TABLE policy_engines ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
      if (!pe.has("paused_by")) await runQuery("ALTER TABLE policy_engines ADD COLUMN paused_by TEXT");
      if (!pe.has("paused_at")) await runQuery("ALTER TABLE policy_engines ADD COLUMN paused_at INTEGER");
      if (!pe.has("pause_note")) await runQuery("ALTER TABLE policy_engines ADD COLUMN pause_note TEXT");
      const ps = await columnsOf("policy_sims");
      if (!ps.has("site_boundary_inputs")) await runQuery("ALTER TABLE policy_sims ADD COLUMN site_boundary_inputs TEXT");
      if (!ps.has("site_boundary_plan")) await runQuery("ALTER TABLE policy_sims ADD COLUMN site_boundary_plan TEXT");
      if (!ps.has("boundary_ts")) await runQuery("ALTER TABLE policy_sims ADD COLUMN boundary_ts REAL");
      if (!ps.has("truncated")) await runQuery("ALTER TABLE policy_sims ADD COLUMN truncated INTEGER");
      if (!ps.has("whitelisted")) await runQuery("ALTER TABLE policy_sims ADD COLUMN whitelisted TEXT");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** The column names a table has now. */
async function columnsOf(table) {
  return new Set((await getQuery(`PRAGMA table_info(${table})`)).map((c) => c.name));
}

// ── meta ──
async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM policy_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
async function setMeta(key, v) {
  await init();
  return runQuery("INSERT INTO policy_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, J(v)]);
}

// ── the clock: real time, or (staging only) a test clock the rehearsal sets ──
let clockFn = () => Date.now();
let testOffsetMs = 0;
const nowMs = () => clockFn() + testOffsetMs;
const nowS = () => nowMs() / 1000;
function _setClock(fn) { clockFn = fn || (() => Date.now()); }
async function loadTestClock() {
  if (!process.env.STAGING) { testOffsetMs = 0; return 0; }
  const t = await meta("test_clock");
  testOffsetMs = t && Number.isFinite(Number(t.offset_ms)) ? Number(t.offset_ms) : 0;
  return testOffsetMs;
}
async function setTestClock(atS) {
  if (!process.env.STAGING) throw Object.assign(new Error("the test clock exists only on staging"), { status: 403 });
  const off = atS === null || atS === undefined ? 0 : Math.round(Number(atS) * 1000 - clockFn());
  await setMeta("test_clock", { offset_ms: off, at: atS || null, set: Date.now() });
  testOffsetMs = off;
  return off;
}

// ── engines and modes ──
async function engines() {
  await init();
  const rows = await getQuery("SELECT * FROM policy_engines");
  const out = {};
  for (const e of ENGINES) out[e] = { engine: e, mode: "off", armed_at: null, updated: null, by: null, note: null, paused: 0, paused_by: null, paused_at: null, pause_note: null };
  for (const r of rows) if (out[r.engine]) out[r.engine] = Object.assign(r, { paused: r.paused ? 1 : 0 });
  return out;
}
/** PO-1: the pause flag of one engine (in the caller's transaction; policy/scheduler.setPause audits and alerts). A row that
 *  doesn't exist yet is created with mode "off" - the pause never changes the mode. */
async function putPaused(engine, paused, { by = null, note = null } = {}) {
  await init();
  if (!ENGINES.includes(engine)) throw Object.assign(new Error("no such engine"), { status: 400 });
  const t = Date.now();
  await runQuery(`INSERT INTO policy_engines (engine, mode, armed_at, updated, by, note, paused, paused_by, paused_at, pause_note)
                  VALUES (?, 'off', NULL, ?, NULL, NULL, ?, ?, ?, ?)
                  ON CONFLICT(engine) DO UPDATE SET paused = excluded.paused, paused_by = excluded.paused_by, paused_at = excluded.paused_at,
                    pause_note = excluded.pause_note`,
                 [engine, t, paused ? 1 : 0, str(by, 60), t, str(note, 300)]);
}
async function mode(engine) { return ((await engines())[engine] || {}).mode || "off"; }
async function setMode(engine, m, { by = "admin", byId = null, via = "admin", note = null, armedAt } = {}) {
  await init();
  if (!ENGINES.includes(engine)) throw Object.assign(new Error("no such engine"), { status: 400 });
  if (!MODES.includes(m)) throw Object.assign(new Error("no such mode"), { status: 400 });
  const cur = (await engines())[engine];
  const armed = armedAt !== undefined ? armedAt : (cur.mode === "off" && m !== "off" ? nowS() : cur.armed_at);
  await runQuery(`INSERT INTO policy_engines (engine, mode, armed_at, updated, by, note) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(engine) DO UPDATE SET mode = excluded.mode, armed_at = excluded.armed_at, updated = excluded.updated,
                  by = excluded.by, note = excluded.note`, [engine, m, armed, Date.now(), str(by, 60), str(note, 300)]);
  await audit({ by, byId, via, engine, old: cur.mode, new: m, note });
  return { engine, mode: m, was: cur.mode, armed_at: armed };
}
async function audit({ by, byId = null, via, engine, old, new: nw, note }) {
  await init();
  await runQuery("INSERT INTO policy_audit (ts, by, via, engine, old, new, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [Date.now(), str(by, 60), str(via, 20), str(engine, 20), str(typeof old === "string" ? old : J(old), 300),
                  str(typeof nw === "string" ? nw : J(nw), 300), str(note, 500)]);
  // an admin's change also lands in the site-wide admin audit (adminaudit.js, action "policy.mode")
  if (byId) {
    try { await require("../adminaudit").record({ userId: String(byId), username: by }, "policy.mode", null, { engine, from: old, to: nw }, note); }
    catch (e) { console.error("[policy] admin audit:", e.message); }
  }
}

// ── the lease ──
async function acquireLease(name = "scheduler") {
  await init();
  const t = Date.now();
  const r = await runQuery(`INSERT INTO policy_lease (name, holder, expires) VALUES (?, ?, ?)
                            ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires = excluded.expires
                            WHERE policy_lease.expires < ? OR policy_lease.holder = excluded.holder`, [name, HOLDER, t + LEASE_MS, t]);
  return !!(r && r.changes === 1);
}
async function releaseLease(name = "scheduler") {
  await init();
  await runQuery("UPDATE policy_lease SET expires = 0 WHERE name = ? AND holder = ?", [name, HOLDER]);
}
async function leaseInfo(name = "scheduler") {
  await init();
  return (await getQuery("SELECT * FROM policy_lease WHERE name = ?", [name]))[0] || null;
}

// ── runs (done-keys) ──
const runKey = (engine, period) => `${engine}:${period}`;
async function run(engine, period) {
  const r = (await getQuery("SELECT * FROM policy_runs WHERE key = ?", [runKey(engine, period)]))[0];
  return r ? Object.assign(r, { inputs: parse(r.inputs, null), plan: parse(r.plan, null), result: parse(r.result, null) }) : null;
}
async function putRun(engine, period, { state, boundary = null, via = "site", inputs, plan, result, error = null }) {
  const t = Date.now();
  await runQuery(`INSERT INTO policy_runs (key, engine, period, state, boundary, via, inputs, plan, result, error, created, done)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET state = excluded.state, boundary = COALESCE(excluded.boundary, policy_runs.boundary),
                    via = excluded.via, inputs = COALESCE(excluded.inputs, policy_runs.inputs), plan = COALESCE(excluded.plan, policy_runs.plan),
                    result = COALESCE(excluded.result, policy_runs.result), error = excluded.error, done = excluded.done`,
                 [runKey(engine, period), engine, period, state, boundary, via, inputs === undefined ? null : J(inputs),
                  plan === undefined ? null : J(plan), result === undefined ? null : J(result), str(error, 500), t,
                  state === "done" || state === "handed" ? t : null]);
}
async function runs(engine, limit = 30) {
  await init();
  return (await getQuery("SELECT key, engine, period, state, boundary, via, error, created, done FROM policy_runs WHERE engine = ? ORDER BY created DESC LIMIT ?",
                         [engine, limit]));
}

// ── effects for Pepe's books ──
async function effect(key, { engine, period, kind, data }) {
  await runQuery("INSERT OR IGNORE INTO policy_effects (key, engine, period, kind, data, created) VALUES (?, ?, ?, ?, ?, ?)",
                 [key, engine, period, kind, J(data), Date.now()]);
}
async function effectsOpen(limit = 200) {
  await init();
  return (await getQuery("SELECT key, engine, period, kind, data, created FROM policy_effects WHERE acked_at IS NULL ORDER BY created, rowid LIMIT ?", [limit]))
    .map((r) => Object.assign(r, { data: parse(r.data, {}) }));
}
async function effectsAll(engine, kinds) {
  await init();
  const rows = await getQuery(`SELECT key, engine, period, kind, data, created, acked_at FROM policy_effects WHERE kind IN (${kinds.map(() => "?").join(",")})
                               ${engine ? "AND engine = ?" : ""} ORDER BY created, rowid`, engine ? [...kinds, engine] : kinds);
  return rows.map((r) => Object.assign(r, { data: parse(r.data, {}) }));
}
async function ack(keys) {
  await init();
  let n = 0;
  const t = Date.now();
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 500)) {
    const r = await runQuery("UPDATE policy_effects SET acked_at = ? WHERE key = ? AND acked_at IS NULL", [t, String(k)]);
    n += (r && r.changes) || 0;
  }
  return n;
}

// ── Pepe's config push (his constants, effective econ_cfg, flags, journals of the periods he ran) ──
async function cfg() { return (await meta("cfg")) || null; }
async function putCfg(c) {
  if (!c || typeof c !== "object") return null;
  const v = Object.assign({}, c, { at: Date.now() / 1000 });
  await setMeta("cfg", v);
  return v;
}
async function cfgAge() {
  const c = await cfg();
  return c && c.at ? Date.now() / 1000 - Number(c.at) : Infinity;
}

module.exports = { init, meta, setMeta, nowMs, nowS, _setClock, loadTestClock, setTestClock, engines, mode, setMode, putPaused, audit, acquireLease,
                   releaseLease, leaseInfo, runKey, run, putRun, runs, effect, effectsOpen, effectsAll, ack, cfg, putCfg, cfgAge, ENGINES,
                   MODES, RETIRED, STAYS, HOLDER, J, parse, str, _testOffset: () => testOffsetMs };
