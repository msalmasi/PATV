// policy/config.js — PO-2 of the economy policy -> site plan ("Phase 6", plan sections 2.1 / 2.2 / 3 PO-2): the site's policy
// config store. ONE store (policy_cfg) replaces the four copies the site keeps today (econstore's 10-row econ_cfg mirror, the
// econ_cfg / consts / flags / burn_cfg / skip / tz of Pepe's policy push, the knob keys of capital_meta.cfg, the funding sync's
// monetary block). The spec - units, bounds, aliases, when a change applies, whether an engine reads it, Pepe's validation - is
// policy/cfgspec.js.
//
// It ships in MIRROR mode (policy_ownership.cfg = "pepe"): Pepe is still the writer. Every push he makes is normalised into
// policy_cfg (by "pepe", via "mirror"): POST /api/policy/bot/config (econ_cfg, the economy sink rates, consts, flags, burn_cfg,
// skip, tz), /api/capital/bot/config (the capital knobs), /api/econ/settings/put (PAT Routing) and the funding sync's monetary
// block. A key that more than one push carries is written from its BEST source (cfgspec order: Pepe's own effective value first,
// derived copies last) while that source is fresh (25 h); the others are cross-checked (diffReport "disagree").
// Each CONSUMER then reads both (the dual read, T2): it computes its values from policy_cfg AND from the push, keeps USING THE
// PUSH, and every difference is logged (policy_cfg_dualread: day, consumer, key, push value, site value, how often) with a
// per-day check count (policy_cfg_dualcheck) - the H1 gate is "no difference on any daily cut-off 10-31..11-04 nor the Monday
// 11-02 epoch". Consumers: capital.cutoff (vaults.epoch), capital.reserve (the loan terms), fed.cfgNow, funding.monetary,
// policy.source (every engine reader).
//
// After H1 (dormant until policy_ownership.cfg = "site", which only the hand-over's cutover sets - policy/handover.js):
//   * every reader uses policy_cfg (capitalCfg / sourceView / monetaryFor overlay it); a key missing then is never filled with a
//     code default - the reader throws E_CFG_MISSING (the engine defers that period) and the owners are alerted
//   * Fed ops ignore Pepe's per-op econ_cfg and must carry cfg_rev = the current rev (fed/service.js: 409 with the values)
//   * funding's monetary block is computed here (its config fields; the Fed loan room / budget week / Fed balance stay derived)
//   * capital_ceil_log is written on every ceiling-key change
//   * edits: /admin/economy (owner + password step-up + CSRF + base_rev + a note) and Pepe's chat (POST /api/policy/bot/cfg/set,
//     a Pepe owner, never Telegram); engine-input keys are frozen from 03:40 UTC until that day's runs settle (423), everything
//     while the feature is frozen for a hand-over or paused (423); a stale base_rev is 409 with the saved values
//
// Tables:
//   policy_cfg            key PK, value (JSON, the stored unit), rev (the rev that last wrote it), updated (ms), by, via, src
//   policy_cfg_rev        id = 1, rev, sha (sha256 of the whole config, canonical JSON), updated
//   policy_cfg_log        id, rev, ts (ms), actor_user_id, actor, via (web | chat | mirror | import | migration | cli), key, old, new, note
//   policy_cfg_seed       (migration, key) PK, value, ts - what each deploy migration seeded (MIGRATIONS below)
//   policy_cfg_dualread   (day, consumer, key, push, site) PK, n, first_ts, last_ts - every consumer difference
//   policy_cfg_dualcheck  (day, consumer) PK, checks, diffs, first_ts, last_ts - how often each consumer compared
//   policy_ownership      feature PK (cfg | budget | staking_ops | loans_desk), owner (pepe | cutting | site), paused, paused_by,
//                         paused_at, note, since, handover_key, by
//   policy_handovers / policy_handover_chunks   the chunked hand-over imports (policy/handover.js)
//   capital_ceil_log      id, ts, rev, ceil_apr, ceil_cushion, ceil_cushion_days, by, via - the ceiling rule over time (from H1)
// policy_meta (policy/core.js) keeps cfg_src (every push path's last value / seen / changed), cfg_mirror_days and cfg_pepe_rev.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx, inTx } = require("../dbUtils");
const S = require("./cfgspec");
const C = require("./core");

const FEATURES = ["cfg", "budget", "staking_ops", "loans_desk"];
const OWNERS = ["pepe", "cutting", "site"];
const CACHE_MS = 2000;
const SRC_STALE_MS = 25 * 3600 * 1000;      // a push source not seen for this long no longer decides its keys
const SETTLE_MS = 10 * 60 * 1000;           // two sources disagree only once both pushed again 10 min after the newer change
const WINDOW_LEAD_S = 20 * 60;              // engine-input keys freeze from 20 min before the epoch hour (03:40 UTC)
const DUAL_FLUSH_MS = 15000;
const MIRROR_DAYS_KEEP = 21;
const LOG_KEEP = 20000;                     // the mirror's own log rows kept (a person's / import / migration rows are never pruned)
let logKeep = LOG_KEEP;
// A release that adds a SPEC key appends a migration that seeds a REVIEWED value (plan 2.2 "No silent defaults"): applied once
// at start, only to keys policy_cfg doesn't have, logged (policy_cfg_seed + policy_cfg_log via "migration"). Preflight and the
// boot check fail loudly on a key that is still missing.
const MIGRATIONS = [];

let clock = () => Date.now();
const nowMs = () => clock();
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s === null || s === undefined) return d; try { return JSON.parse(s); } catch (e) { return d; } };
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const cfgSha = (cfg) => sha256(S.canon(cfg));

class Refuse extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || null; }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await C.init();
      await runQuery("CREATE TABLE IF NOT EXISTS policy_cfg (key TEXT PRIMARY KEY, value TEXT NOT NULL, rev INTEGER NOT NULL, updated INTEGER, by TEXT, via TEXT, src TEXT)");
      await runQuery("CREATE TABLE IF NOT EXISTS policy_cfg_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL, sha TEXT, updated INTEGER)");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_cfg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, rev INTEGER, ts INTEGER, actor_user_id TEXT, actor TEXT,
        via TEXT, key TEXT, old TEXT, new TEXT, note TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS policy_cfg_log_key ON policy_cfg_log (key, id)");
      await runQuery("CREATE INDEX IF NOT EXISTS policy_cfg_log_via ON policy_cfg_log (via, id)");
      await runQuery("CREATE TABLE IF NOT EXISTS policy_cfg_seed (migration TEXT NOT NULL, key TEXT NOT NULL, value TEXT, ts INTEGER, PRIMARY KEY (migration, key))");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_cfg_dualread (day TEXT NOT NULL, consumer TEXT NOT NULL, key TEXT NOT NULL, push TEXT NOT NULL,
        site TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, first_ts INTEGER, last_ts INTEGER, PRIMARY KEY (day, consumer, key, push, site))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_cfg_dualcheck (day TEXT NOT NULL, consumer TEXT NOT NULL, checks INTEGER NOT NULL DEFAULT 0,
        diffs INTEGER NOT NULL DEFAULT 0, first_ts INTEGER, last_ts INTEGER, PRIMARY KEY (day, consumer))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_ownership (feature TEXT PRIMARY KEY, owner TEXT NOT NULL DEFAULT 'pepe', paused INTEGER NOT NULL DEFAULT 0,
        paused_by TEXT, paused_at INTEGER, note TEXT, since INTEGER, handover_key TEXT, by TEXT, return_sha TEXT, return_at INTEGER)`);
      // review of PO-2: a rollback is two steps (policy/handover.js) - `return_sha` = the sha handed back while Pepe writes it
      const oc = new Set((await getQuery("PRAGMA table_info(policy_ownership)")).map((c) => c.name));
      if (!oc.has("return_sha")) await runQuery("ALTER TABLE policy_ownership ADD COLUMN return_sha TEXT");
      if (!oc.has("return_at")) await runQuery("ALTER TABLE policy_ownership ADD COLUMN return_at INTEGER");
      await runQuery(`CREATE TABLE IF NOT EXISTS policy_handovers (key TEXT PRIMARY KEY, feature TEXT NOT NULL, state TEXT NOT NULL, size INTEGER, chunks INTEGER,
        blob TEXT, imported_at INTEGER, verify TEXT, by TEXT, created INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS policy_handover_chunks (key TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (key, idx))");
      await runQuery(`CREATE TABLE IF NOT EXISTS capital_ceil_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, rev INTEGER, ceil_apr REAL, ceil_cushion INTEGER,
        ceil_cushion_days REAL, by TEXT, via TEXT)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── ownership + pause (plan 2.3) ──
async function ownership() {
  await init();
  const out = {};
  for (const f of FEATURES) {
    out[f] = { feature: f, owner: "pepe", paused: 0, paused_by: null, paused_at: null, note: null, since: null, handover_key: null, by: null, return_sha: null, return_at: null };
  }
  for (const r of await getQuery("SELECT * FROM policy_ownership")) if (out[r.feature]) out[r.feature] = Object.assign(out[r.feature], r, { paused: r.paused ? 1 : 0 });
  return out;
}
/** In the caller's transaction: the feature's owner (pepe | cutting | site). A change of owner clears a pending return. */
async function putOwner(feature, owner, { by = null, handoverKey, note } = {}) {
  if (!FEATURES.includes(feature) || !OWNERS.includes(owner)) throw new Refuse(400, "bad_feature", "no such feature / owner");
  const t = nowMs();
  ownerChanging = true;                    // until the next committed read: no reader may guess the owner from memory
  await runQuery(`INSERT INTO policy_ownership (feature, owner, since, handover_key, by, note) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(feature) DO UPDATE SET owner = excluded.owner, since = excluded.since,
                    handover_key = COALESCE(excluded.handover_key, policy_ownership.handover_key), by = excluded.by,
                    note = COALESCE(excluded.note, policy_ownership.note), return_sha = NULL, return_at = NULL`,
                 [feature, owner, t, handoverKey === undefined ? null : handoverKey, str(by, 60), note === undefined ? null : str(note, 300)]);
  forget();
}
/** In the caller's transaction: a site-owned feature being handed back (the sha Pepe writes back) - or the return cancelled (null).
 *  While it is set every edit is 423 and the readers keep the site's values (policy/handover.js rollback). */
async function putReturning(feature, sha, { by = null, note } = {}) {
  if (!FEATURES.includes(feature)) throw new Refuse(400, "bad_feature", "no such feature");
  await runQuery(`INSERT INTO policy_ownership (feature, owner, return_sha, return_at, by, note) VALUES (?, 'pepe', ?, ?, ?, ?)
                  ON CONFLICT(feature) DO UPDATE SET return_sha = excluded.return_sha, return_at = excluded.return_at, by = excluded.by,
                    note = COALESCE(excluded.note, policy_ownership.note)`,
                 [feature, sha || null, sha ? nowMs() : null, str(by, 60), note === undefined ? null : str(note, 300)]);
  forget();
}
async function owner(feature = "cfg") { return (await snapshot()).own[feature].owner; }

/**
 * Pause / resume features (T3): ONE transaction - the flags, policy_audit, admin_audit ("policy.feature_pause" / "_resume") -
 * then every site admin is told. A paused cfg answers 423 on every edit (the readers keep reading). -> [{feature, paused, unchanged}]
 */
async function setPause(features, paused, { by, auditId = null, via = "admin", note = null } = {}) {
  await init();
  for (const f of features) if (!FEATURES.includes(f)) throw new Refuse(400, "bad_feature", `no such feature: ${f} (one of ${FEATURES.join(", ")})`);
  const t = nowMs();
  const res = await tx(async () => {
    const out = [];
    const own = await ownership();
    for (const f of features) {
      if (!!own[f].paused === !!paused) { out.push({ feature: f, paused: !!paused, unchanged: true }); continue; }
      await runQuery(`INSERT INTO policy_ownership (feature, owner, paused, paused_by, paused_at, note) VALUES (?, 'pepe', ?, ?, ?, ?)
                      ON CONFLICT(feature) DO UPDATE SET paused = excluded.paused, paused_by = excluded.paused_by, paused_at = excluded.paused_at,
                        note = excluded.note`, [f, paused ? 1 : 0, str(by, 60), t, str(note, 300)]);
      await C.audit({ by, via, engine: "feature:" + f, old: own[f].paused ? "paused" : "running", new: paused ? "paused" : "running", note });
      if (auditId) {
        await require("../adminaudit").record({ userId: String(auditId), username: by }, paused ? "policy.feature_pause" : "policy.feature_resume", null,
                                                { feature: f, owner: own[f].owner, via }, note);
      }
      out.push({ feature: f, paused: !!paused });
    }
    return out;
  });
  forget();
  const changed = res.filter((r) => !r.unchanged);
  if (changed.length) {
    try {
      await require("../opsalerts").alert({ source: "policy", ref: `feature-${paused ? "pause" : "resume"}:${changed.map((r) => r.feature).join(",")}:${t}`,
        title: `Economy ${changed.map((r) => r.feature).join(", ")} ${paused ? "PAUSED" : "resumed"} by ${by}`,
        body: (note ? `Why: ${note}\n` : "") + (paused ? "Edits of the economy settings are refused while it is paused (423); nothing else changes." : "Edits are taken again.") });
    } catch (e) { console.error("[policycfg] pause alert:", e.message); }
  }
  return res;
}

// ── the store: one snapshot, cached for 2 s outside transactions ──
// Review of PO-2: outside a transaction a snapshot is read IN ONE OF ITS OWN on the chain (dbUtils.tx), like the 1.99adl stash /
// pool move_status (settledMoveStatus): queued behind every transaction already open or waiting, so it sees committed rows only.
// A plain read on the shared connection could see an OPEN edit / mirror / import transaction's rows - and a rev that its
// rollback then takes back and the next real write reuses with other values. Inside a transaction it is that transaction's view.
let cache = null;          // the 2 s cache (dropped by forget())
let lastSnap = null;       // the last COMMITTED snapshot read outside a transaction (never dropped: funding's sync reader)
let gen = 0;               // bumped by forget(): a read that started before a change is returned but never cached
let ownerChanging = true;  // true until the first committed read, and again from a putOwner() until the next one
const forget = () => { cache = null; gen++; };
/** The owner of the config as last READ (committed), or null when it isn't known: never read yet, or being changed (putOwner). */
const ownerHint = () => (ownerChanging || !lastSnap ? null : lastSnap.own.cfg.owner);
async function load() {
  try { return await loadOnce(); } catch (e) {
    // the tables were created inside a transaction that rolled back (a first use inside one): create them again
    if (!/no such table/i.test(String(e && e.message))) throw e;
    ready = null;
    return loadOnce();
  }
}
async function loadOnce() {
  await init();
  const r = (await getQuery("SELECT rev, sha, updated FROM policy_cfg_rev WHERE id = 1"))[0] || { rev: 0, sha: null, updated: null };
  const cfg = {}, meta = {};
  for (const row of await getQuery("SELECT key, value, rev, updated, by, via, src FROM policy_cfg")) {
    if (!S.SPEC[row.key]) continue;                     // a key a later release dropped: kept in the table, never read
    const v = parse(row.value, undefined);
    if (v === undefined) continue;
    cfg[row.key] = v;
    meta[row.key] = { rev: row.rev, updated: row.updated, by: row.by, via: row.via, src: row.src };
  }
  return { at: nowMs(), rev: Number(r.rev) || 0, sha: r.sha || null, updated: r.updated || null, cfg, meta, own: await ownership() };
}
/** The whole store {rev, sha, cfg: {key: value}, meta: {key: {rev, updated, by, via, src}}, own: ownership()}. Inside a transaction
 *  it is always read fresh (it may be the edit's own transaction); outside, committed rows in a transaction of its own, cached
 *  for 2 s. */
async function snapshot({ fresh = false } = {}) {
  if (inTx()) return load();
  if (!fresh && cache && nowMs() - cache.at < CACHE_MS) return cache;
  await init();                                       // the tables first, outside the read's transaction
  const g = gen;
  const s = await tx(() => load());
  if (g === gen) {
    cache = s;
    lastSnap = s;
    ownerChanging = false;
  }
  return s;
}
/** The last committed snapshot this process read (sync callers: funding.js) - null before the first. */
const cached = () => lastSnap;
async function refresh() { forget(); return snapshot(); }
/** A reader's snapshot (review of PO-2: never an auto-fallback). When the store can't be read: while the push is the config's
 *  source (Pepe owns it or it is frozen for the hand-over - the owner as last read) -> null, the reader keeps the push; when the
 *  site owns it or the owner isn't known -> throws E_CFG_UNREADABLE (the reader defers; the owners are alerted). */
async function readerSnap(where) {
  try { return await snapshot(); } catch (e) {
    const h = ownerHint();
    if (h === "pepe" || h === "cutting") return null;
    throw unreadableErr(where, e);
  }
}

/** In the caller's transaction: write the changed keys (one new rev), their log rows, the sha; the admin audit row; the ceiling log
 *  (site-owned only). diff = [[key, old, new]]. -> {rev, sha} */
async function writeChanges(diff, { by, actorUserId = null, via, note = null, src = null, snap, notes = {} }) {
  const t = nowMs();
  const rev = snap.rev + 1;
  const next = Object.assign({}, snap.cfg);
  for (const [k, o, n] of diff) {
    next[k] = n;
    await runQuery(`INSERT INTO policy_cfg (key, value, rev, updated, by, via, src) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value, rev = excluded.rev, updated = excluded.updated, by = excluded.by,
                      via = excluded.via, src = excluded.src`, [k, S.canon(n), rev, t, str(by, 60), str(via, 20), str((src && src[k]) || via, 120)]);
    await runQuery("INSERT INTO policy_cfg_log (rev, ts, actor_user_id, actor, via, key, old, new, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                   [rev, t, str(actorUserId, 64), str(by, 60), str(via, 20), k, o === undefined ? null : S.canon(o), S.canon(n), str(notes[k] || note, 300)]);
  }
  const sha = cfgSha(next);
  await runQuery(`INSERT INTO policy_cfg_rev (id, rev, sha, updated) VALUES (1, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, sha = excluded.sha, updated = excluded.updated`, [rev, sha, t]);
  // the ceiling rule over time (Pepe's vaults.json ceil_log until H1; the site's once it owns the knobs)
  if (snap.own.cfg.owner === "site" && diff.some(([k]) => ["vault_ceil_apr", "vault_ceil_cushion", "vault_ceil_cushion_days"].includes(k))) {
    const cv = S.capitalView(next, ["ceil_apr", "ceil_cushion", "ceil_cushion_days"]);
    await runQuery("INSERT INTO capital_ceil_log (ts, rev, ceil_apr, ceil_cushion, ceil_cushion_days, by, via) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [t, rev, cv.ceil_apr === undefined ? null : cv.ceil_apr, cv.ceil_cushion === undefined ? null : cv.ceil_cushion,
                    cv.ceil_cushion_days === undefined ? null : cv.ceil_cushion_days, str(by, 60), str(via, 20)]);
  }
  if (via === "web" || via === "chat" || via === "cli") {
    await require("../adminaudit").record({ userId: String(actorUserId || `${via}:${by}`).slice(0, 64), username: by }, "policy.cfg", null,
                                          { rev, changes: diff.map(([k, o, n]) => ({ key: k, old: o === undefined ? null : o, new: n })), via }, note);
  }
  // only the mirror's own rows are pruned (review of PO-2): a person's edit, the imported history, a migration are kept for good
  await runQuery(`DELETE FROM policy_cfg_log WHERE via = 'mirror' AND id <= (SELECT id FROM policy_cfg_log WHERE via = 'mirror' ORDER BY id DESC LIMIT 1 OFFSET ${logKeep})`);
  return { rev, sha };
}

// ── the mirror: Pepe's pushes -> policy_cfg (by "pepe", via "mirror") while he owns the config ──
// Every place a push carries a key: [push kind, block, path, site key, value -> site value]. The ORDER of a key's places is its
// source priority: Pepe's own stored / effective value first (the policy push's econ_cfg, sink, flags, burn_cfg, skip, tz), then
// the capital push, then consts, then the funding sync - derived copies (a value Pepe already transformed, e.g. flash = layers AND
// the switch) are never a source, only a dual-read comparison.
const toBool = (x) => (typeof x === "boolean" ? x : Math.trunc(Number(x) || 0) > 0);
const SOURCES = [];
for (const k of S.ECON_KEYS) SOURCES.push(["policy", "econ_cfg", "econ_cfg." + k, k, null]);
for (const sk of S.SINK_KEYS) {
  const k = S.resolveKey(sk);
  if (!k) continue;
  SOURCES.push(["policy", "sink", "sink." + sk, k, S.SPEC[k].kind === "bool" ? toBool : null]);
}
for (const f of Object.keys(S.FLAG_KEYS)) SOURCES.push(["policy", "flags", "flags." + f, f, (x) => !!x]);
for (const [f, k] of Object.entries(S.BURN_FIELDS)) SOURCES.push(["policy", "burn_cfg", "burn_cfg." + f, k, null]);
SOURCES.push(["policy", "skip", "skip", "skip", (x) => (Array.isArray(x) ? x.map(String).sort() : x)]);
SOURCES.push(["policy", "tz", "tz", "tz", null]);
for (const [f, k, fn] of [["ceil_apr", "vault_ceil_apr"], ["ceil_cushion", "vault_ceil_cushion", toBool], ["ceil_cushion_days", "vault_ceil_cushion_days"],
                          ["auto_staker_cap", "vault_auto_staker_cap", toBool], ["floor_apr", "vault_floor_apr"], ["topup", "vault_topup"],
                          ["topup_max_day", "vault_topup_max"], ["staker_max", "vault_staker_max"], ["house_min_cash", "house_hard_floor"],
                          ["auto_bank_min", "auto_bank_min"], ["auto_house_max", "auto_house_max"], ["auto_mm_max", "auto_mm_max"],
                          ["bank_default_days", "bank_default_days"], ["bank_insurance_cap", "bank_insurance"], ["rloan_enabled", "rloan_enabled"],
                          ["rloan_rate_week", "rloan_rate_week"], ["rloan_base", "rloan_base"], ["rloan_per_level", "rloan_per_level"],
                          ["rloan_max_auto", "rloan_max_auto"], ["rloan_max_days", "rloan_max_days"], ["rloan_book_share", "rloan_book"],
                          ["penalty_pct", "fee_loan_penalty_pct"], ["dividend", "vault_dividend"], ["epoch_hour", "epoch_hour"], ["min_move", "vault_min_move"],
                          ["layers", "layers", (x) => !!x], ["tr_live", "tr_live", (x) => !!x], ["heist_settings.share", "heist_vault_share"],
                          ["heist_settings.cap", "casino_cap"], ["heist_settings.min", "casino_floor"]]) {
  SOURCES.push(["capital", "capital", f, k, fn || null]);
}
for (const [n, k] of Object.entries(S.CONST_MAP)) SOURCES.push(["policy", "consts", "consts." + n, k, null]);
for (const [f, k] of [["house_hard_floor", "house_hard_floor"], ["donation.rate", "donation_rate"], ["donation.bonus_pct", "donation_bonus_pct"],
                      ["grant_weekly_cap", "grant_weekly_cap"], ["band.floor", "fed_floor"], ["band.ceiling", "fed_ceiling"]]) {
  SOURCES.push(["funding", "monetary", "monetary." + f, k, null]);
}
SOURCES.push(["econ", "pat_routes", "pat_routes", "pat_routes", null]);
const PATH = (s) => s[0] + ":" + s[2];
const BY_KEY = {};
for (const s of SOURCES) (BY_KEY[s[3]] = BY_KEY[s[3]] || []).push(PATH(s));
const KINDS = ["policy", "capital", "econ", "funding"];

/** What one push carries: {paths: Map(path -> {key, value}), unknown: [names the site's spec doesn't know]}. */
function extract(kind, body) {
  const b = body && typeof body === "object" ? body : {};
  const paths = new Map();
  for (const s of SOURCES) {
    if (s[0] !== kind) continue;
    const v = S.getPath(b, s[2]);
    if (v === undefined || v === null) continue;
    paths.set(PATH(s), { key: s[3], value: s[4] ? s[4](v) : v });
  }
  const unknown = [];
  if (kind === "policy") {
    const known = (block, list) => { for (const n of Object.keys(b[block] && typeof b[block] === "object" ? b[block] : {})) if (!list.includes(n)) unknown.push(`${block}.${n}`); };
    known("econ_cfg", S.ECON_KEYS);
    known("sink", S.SINK_KEYS);
    known("consts", Object.keys(S.CONST_MAP));
    known("flags", Object.keys(S.FLAG_KEYS));
    known("burn_cfg", Object.keys(S.BURN_FIELDS));
  }
  return { paths, unknown };
}
/** The path that decides `key` now: the first of its places whose push was seen in the last 25 h. */
function bestPath(key, src, t) {
  for (const p of BY_KEY[key] || []) {
    const r = src.paths[p];
    if (r && t - Number(r.seen || 0) <= SRC_STALE_MS) return p;
  }
  return null;
}
const emptySrc = () => ({ paths: {}, kinds: {}, unknown: {} });

/**
 * One push from Pepe -> the mirror (never throws: a push is never refused because of it). kind: policy | capital | econ | funding;
 * opts.at (ms): when the push was taken (a stored copy replayed at start). Writes only while Pepe owns the config; the source record
 * (seen / changed per path) is kept either way. -> {mirrored, changed, rev} | null
 */
async function mirror(kind, body, { at } = {}) {
  try {
    if (!KINDS.includes(kind) || !body || typeof body !== "object") return null;
    await init();
    const { paths, unknown } = extract(kind, body);
    const t = Number.isFinite(Number(at)) && Number(at) > 0 ? Math.min(Number(at), nowMs()) : nowMs();
    const out = await tx(async () => {
      const src = Object.assign(emptySrc(), (await C.meta("cfg_src")) || {});
      if (Number(src.kinds[kind] || 0) > t) return { mirrored: false, changed: 0, stale: true };   // an older copy than one already taken
      for (const [p, { key, value }] of paths) {
        const c = S.canon(value);
        const r = src.paths[p];
        if (!r || r.c !== c) src.paths[p] = { k: key, v: value, c, seen: t, changed: t };
        else r.seen = t;
      }
      src.kinds[kind] = t;
      if (kind === "policy") src.unknown.policy = unknown.slice(0, 200);
      const snap = await load();
      let changed = 0, rev = snap.rev;
      if (snap.own.cfg.owner === "pepe") {
        const diff = [], srcOf = {}, notes = {};
        const touched = new Set([...paths.values()].map((x) => x.key));
        for (const key of touched) {
          const best = bestPath(key, src, t);
          if (!best || !paths.has(best)) continue;
          const v = paths.get(best).value;
          if (key in snap.cfg && S.canon(snap.cfg[key]) === S.canon(v)) {
            if ((snap.meta[key] || {}).src !== best) await runQuery("UPDATE policy_cfg SET src = ? WHERE key = ?", [best, key]);
            continue;
          }
          diff.push([key, snap.cfg[key], v]);
          srcOf[key] = best;
          notes[key] = await pepeSaid(key, v);
        }
        if (diff.length) {
          const order = new Map(S.KEYS.map((k, i) => [k, i]));
          diff.sort((a, b) => order.get(a[0]) - order.get(b[0]));
          rev = (await writeChanges(diff, { by: "pepe", via: "mirror", src: srcOf, snap, notes })).rev;
          changed = diff.length;
        }
      }
      await C.setMeta("cfg_src", src);
      await noteMirrorDay(t, changed);
      return { mirrored: snap.own.cfg.owner === "pepe", changed, rev };
    });
    if (out && out.changed) forget();
    return out;
  } catch (e) {
    console.error(`[policycfg] mirror ${kind}:`, e.message);
    return null;
  }
}
/** Who changed it on Pepe's side (his econ_cfg_log, pushed with PAT Routing) - the mirror's log note. */
async function pepeSaid(key, value) {
  try {
    const sp = S.SPEC[key];
    const names = [key].concat(sp.sink && sp.sink !== key ? [sp.sink] : []);
    const r = (await getQuery(`SELECT ts, by, via, new FROM econ_cfg_log WHERE key IN (${names.map(() => "?").join(",")}) ORDER BY id DESC LIMIT 1`, names))[0];
    if (r && S.equalish(parse(r.new, null), value)) return `on Pepe: ${r.by || "?"} via ${r.via || "?"} at ${new Date(Number(r.ts)).toISOString().slice(0, 16)}Z`;
  } catch (e) { /* no econ_cfg_log table (a bare test database) */ }
  return null;
}
async function noteMirrorDay(t, changed) {
  const days = (await C.meta("cfg_mirror_days")) || {};
  const d = utcDay(t);
  const x = days[d] || { pushes: 0, changes: 0, checked_at: 0, max: null, last: null };
  x.pushes++;
  x.changes += changed;
  days[d] = x;
  for (const k of Object.keys(days).sort().slice(0, -MIRROR_DAYS_KEEP)) delete days[k];
  await C.setMeta("cfg_mirror_days", days);
}
/** The stored copies of Pepe's last pushes, mirrored once at start (so a fresh deploy has a full mirror before his next push). */
async function backfill() {
  try {
    const pol = await require("./source").rawPush();            // T14: the push is read only through policy/source.js
    if (pol && pol.at) await mirror("policy", pol, { at: Number(pol.at) * 1000 });
  } catch (e) { console.error("[policycfg] backfill policy:", e.message); }
  try {
    const cap = await require("../capital/core").meta("cfg");
    if (cap && cap.at) await mirror("capital", cap, { at: Number(cap.at) * 1000 });
  } catch (e) { console.error("[policycfg] backfill capital:", e.message); }
  try {
    const ES = require("../econstore");
    await ES.init();
    const rows = await getQuery("SELECT MAX(updated) AS t, COUNT(*) AS n FROM pat_routes");
    const s = await ES.getSettings();
    const t = Number((rows[0] || {}).t) || 0;
    if (t || Object.keys(s.pat_routes || {}).length) await mirror("econ", { pat_routes: s.pat_routes }, { at: t || 1 });
  } catch (e) { console.error("[policycfg] backfill routes:", e.message); }
}

// ── the diff report: keys present on one side only, validation disagreements, sources that disagree ──
async function routesCatalog() {
  try { return parse(((await getQuery("SELECT data FROM econ_catalog WHERE id = 1"))[0] || {}).data, null); } catch (e) { return null; }
}
async function diffReport() {
  await init();
  const snap = await snapshot({ fresh: true });
  const src = Object.assign(emptySrc(), (await C.meta("cfg_src")) || {});
  const t = nowMs();
  const missing = S.KEYS.filter((k) => !(k in snap.cfg));
  const unknown = Object.entries(src.unknown || {}).flatMap(([kind, list]) => (list || []).map((p) => `${kind}:${p}`));
  const invalid = [];
  for (const [k, v] of Object.entries(snap.cfg)) if (!S.validValue(S.SPEC[k], v)) invalid.push({ key: k, error: S.keyError(k, S.SPEC[k], v) });
  const catalog = await routesCatalog();
  const whole = missing.length || invalid.length ? [] : S.validate(snap.cfg, { catalog });
  const disagree = [], pending = [];
  for (const key of S.KEYS) {
    const live = (BY_KEY[key] || []).map((p) => [p, src.paths[p]]).filter(([, r]) => r && t - Number(r.seen || 0) <= SRC_STALE_MS);
    if (live.length < 2) continue;
    const [p0, r0] = live[0];
    for (const [p1, r1] of live.slice(1)) {
      if (S.equalish(r0.v, r1.v)) continue;
      const item = { key, a: { path: p0, value: r0.v, seen: r0.seen }, b: { path: p1, value: r1.v, seen: r1.seen } };
      if (Math.min(r0.seen, r1.seen) >= Math.max(r0.changed, r1.changed) + SETTLE_MS) disagree.push(item); else pending.push(item);
    }
  }
  const sources = {};
  for (const k of KINDS) {
    const seen = Number(src.kinds[k] || 0);
    // PAT Routing is pushed only when it changes (pepe_poolstore._ps_settings_push): its age says nothing
    sources[k] = { seen: seen || null, age_s: seen ? Math.round((t - seen) / 1000) : null, stale: k !== "econ" && !!seen && t - seen > SRC_STALE_MS };
  }
  const counts = { missing: missing.length, unknown: unknown.length, invalid: invalid.length, whole: whole.length, disagree: disagree.length };
  return { at: t, owner: snap.own.cfg.owner, rev: snap.rev, sha: snap.sha, counts, empty: Object.values(counts).every((n) => n === 0),
           missing, unknown, invalid, whole, disagree, pending, sources };
}
/** The day's mirror evidence (H1 gate 1): the diff report's counts, kept per UTC day (the worst and the last) at most every 10 min. */
async function checkMirrorDay({ force = false } = {}) {
  const t = nowMs();
  const d = utcDay(t);
  const had = ((await C.meta("cfg_mirror_days")) || {})[d] || {};
  if (!force && t - Number(had.checked_at || 0) < 10 * 60 * 1000) return had;
  const r = await diffReport();
  // the day's record is read and written in one transaction (a mirror counting a push meanwhile isn't lost)
  return tx(async () => {
    const days = (await C.meta("cfg_mirror_days")) || {};
    const x = days[d] || { pushes: 0, changes: 0, checked_at: 0, max: null, last: null };
    x.checked_at = t;
    x.last = r.counts;
    x.max = x.max ? Object.fromEntries(Object.keys(r.counts).map((k) => [k, Math.max(Number(x.max[k]) || 0, r.counts[k])])) : r.counts;
    days[d] = x;
    await C.setMeta("cfg_mirror_days", days);
    return x;
  });
}

// ── the dual read (T2): every consumer's push value vs the site value ──
const dualBuf = new Map(), checkBuf = new Map();
function compareFields(pushObj, siteObj, fields) {
  const out = [];
  for (const f of fields) {
    const p = S.getPath(pushObj, f);
    const s = siteObj ? siteObj[f] : undefined;
    if (p === undefined && s === undefined) continue;
    if (!S.equalish(p, s)) out.push({ field: f, push: p === undefined ? null : p, site: s === undefined ? null : s });
  }
  return out;
}
/** Buffer one comparison (written by flushDual - never on the consumer's own path, never inside its transaction). */
function noteDual(consumer, diffs) {
  const t = nowMs();
  const day = utcDay(t);
  const ck = day + "|" + consumer;
  const c = checkBuf.get(ck) || { k: ck, day, consumer, checks: 0, diffs: 0, first: t, last: t };
  c.checks++;
  c.diffs += diffs.length;
  c.last = t;
  checkBuf.set(ck, c);
  for (const d of diffs) {
    const push = S.canon(d.push), site = S.canon(d.site);
    const k = [day, consumer, d.field, push, site].join("|");
    const x = dualBuf.get(k) || { k, day, consumer, key: d.field, push, site, n: 0, first: t, last: t };
    x.n++;
    x.last = t;
    dualBuf.set(k, x);
  }
  if (diffs.length && !warned.has(consumer + day)) {
    warned.add(consumer + day);
    console.warn(`[policycfg] dual read ${consumer}: ${diffs.length} difference(s) - ${diffs.slice(0, 4).map((d) => `${d.field} push ${S.canon(d.push)} / site ${S.canon(d.site)}`).join("; ")}`);
  }
}
const warned = new Set();
let flushing = null;
/** Put rows a failed flush took back into the buffers, merged with what arrived meanwhile (review of PO-2: the H1 gate 2 evidence
 *  is never dropped on a failed write). */
function restoreDual(rows, checks) {
  for (const x of rows) {
    const y = dualBuf.get(x.k);
    if (!y) { dualBuf.set(x.k, x); continue; }
    y.n += x.n;
    y.first = Math.min(y.first, x.first);
    y.last = Math.max(y.last, x.last);
  }
  for (const c of checks) {
    const y = checkBuf.get(c.k);
    if (!y) { checkBuf.set(c.k, c); continue; }
    y.checks += c.checks;
    y.diffs += c.diffs;
    y.first = Math.min(y.first, c.first);
    y.last = Math.max(y.last, c.last);
  }
}
/** Write the buffered comparisons (every 15 s, right after the capital cut-off and each scheduler pass, and when the site starts
 *  to stop). A failed write puts them back for the next flush. -> rows written */
async function flushDual() {
  if (inTx()) return 0;
  if (flushing) return flushing;
  if (!dualBuf.size && !checkBuf.size) return 0;
  const rows = [...dualBuf.values()], checks = [...checkBuf.values()];
  dualBuf.clear();
  checkBuf.clear();
  flushing = (async () => {
    await init();
    await tx(async () => {
      for (const x of rows) {
        await runQuery(`INSERT INTO policy_cfg_dualread (day, consumer, key, push, site, n, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(day, consumer, key, push, site) DO UPDATE SET n = policy_cfg_dualread.n + excluded.n, last_ts = excluded.last_ts`,
                       [x.day, x.consumer.slice(0, 40), x.key.slice(0, 80), x.push.slice(0, 2000), x.site.slice(0, 2000), x.n, x.first, x.last]);
      }
      for (const c of checks) {
        await runQuery(`INSERT INTO policy_cfg_dualcheck (day, consumer, checks, diffs, first_ts, last_ts) VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(day, consumer) DO UPDATE SET checks = policy_cfg_dualcheck.checks + excluded.checks,
                          diffs = policy_cfg_dualcheck.diffs + excluded.diffs, last_ts = excluded.last_ts`,
                       [c.day, c.consumer.slice(0, 40), c.checks, c.diffs, c.first, c.last]);
      }
    });
    return rows.length + checks.length;
  })().catch((e) => {
    console.error(`[policycfg] dual read flush (${rows.length + checks.length} row(s) kept for the next one):`, e.message);
    restoreDual(rows, checks);
    return 0;
  }).finally(() => { flushing = null; });
  return flushing;
}

// ── a key missing once the site owns the config: never a code default - defer + alert ──
const alerted = new Map();
function missingErr(where, keys) {
  const e = new Refuse(503, "E_CFG_MISSING", `the economy settings are missing ${keys.length} key(s) (${keys.slice(0, 8).join(", ")}) - ${where} is deferred, no default is used`);
  e.missing = keys;
  const sig = where + ":" + keys.join(",");
  const last = alerted.get(sig) || 0;
  if (nowMs() - last > 3600e3) {
    alerted.set(sig, nowMs());
    console.error(`[policycfg] ${e.message}`);
    Promise.resolve().then(() => require("../opsalerts").alert({ source: "policy", ref: `cfg-missing:${sig}`.slice(0, 80),
      title: `Economy settings missing ${keys.length} key(s) - ${where} deferred`,
      body: `Missing: ${keys.join(", ")}. The site owns the config and never uses a code default: add the keys with a deploy migration (policy/config.js MIGRATIONS).` }))
      .catch((x) => console.error("[policycfg] missing alert:", x.message));
  }
  return e;
}
const need = (cfg, keys) => keys.filter((k) => !(k in cfg));
/** The store can't be read while the site owns the config (or the owner isn't known): the reader defers - never Pepe's push. */
function unreadableErr(where, cause) {
  const e = new Refuse(503, "E_CFG_UNREADABLE", `the economy settings can't be read (${String((cause && cause.message) || cause).slice(0, 160)}) - ${where} is deferred, Pepe's values are not used`);
  const sig = "unreadable:" + where;
  const last = alerted.get(sig) || 0;
  if (nowMs() - last > 3600e3) {
    alerted.set(sig, nowMs());
    console.error(`[policycfg] ${e.message}`);
    Promise.resolve().then(() => require("../opsalerts").alert({ source: "policy", ref: `cfg-unreadable:${where}`.slice(0, 80),
      title: `Economy settings unreadable - ${where} deferred`,
      body: `${e.message}. The site owns the economy settings (or their owner couldn't be read): nothing falls back to Pepe's push.` }))
      .catch((x) => console.error("[policycfg] unreadable alert:", x.message));
  }
  return e;
}

/** E_CFG_UNREADABLE / E_CFG_MISSING: the economy settings can't be used - a reader that catches errors to fall back must rethrow
 *  these (the PAT move defers; never a default). */
const isCfgErr = (e) => !!(e && (e.code === "E_CFG_UNREADABLE" || e.code === "E_CFG_MISSING"));

// ── the consumers ──
/** capital/core.cfg(): Pepe's pushed capital config `out` (DEFAULT_CFG + his push). Site-owned: its knob fields come from
 *  policy_cfg; mirror: the consumer's fields are compared (the push is used). */
async function capitalCfg(out, consumer = null, { pushed = true } = {}) {
  const snap = await readerSnap("the capital settings");
  if (!snap) return out;                              // Pepe's config (mirror / frozen) and the store unreadable: his push, unchanged
  if (snap.own.cfg.owner === "site") {
    const keys = [...new Set(Object.values(S.CAPITAL_MAP).flatMap(([n]) => n))];
    const miss = need(snap.cfg, keys);
    if (miss.length) throw missingErr("the capital settings", miss);
    const o = Object.assign({}, out, { flash: Object.assign({}, out.flash || {}), heist_settings: Object.assign({}, out.heist_settings || {}) });
    for (const [f, v] of Object.entries(S.capitalView(snap.cfg))) S.setPath(o, f, v);
    o.cfg_rev = snap.rev;
    return o;
  }
  if (consumer && pushed && Object.keys(snap.cfg).length) {
    const fields = consumer === "capital.cutoff" ? S.CUTOFF_FIELDS : consumer === "capital.reserve" ? S.RESERVE_FIELDS : Object.keys(S.CAPITAL_MAP);
    noteDual(consumer, compareFields(out, S.capitalView(snap.cfg, fields), fields));
  }
  return out;
}
const SOURCE_FIELDS = [...S.ECON_KEYS.map((k) => "econ_cfg." + k), ...Object.keys(S.CONST_MAP).map((n) => "consts." + n),
                       ...Object.keys(S.FLAG_KEYS).map((f) => "flags." + f), ...Object.keys(S.BURN_FIELDS).map((f) => "burn_cfg." + f), "skip", "tz"];
const SOURCE_KEYS = [...new Set([...S.ECON_KEYS, ...Object.values(S.CONST_MAP), ...Object.keys(S.FLAG_KEYS), ...Object.values(S.BURN_FIELDS), "skip", "tz"])];
function sourceSite(cfg) {
  const o = {};
  for (const [k, v] of Object.entries(S.econView(cfg))) o["econ_cfg." + k] = v;
  for (const [k, v] of Object.entries(S.constsView(cfg))) o["consts." + k] = v;
  for (const [k, v] of Object.entries(S.flagsView(cfg))) o["flags." + k] = v;
  for (const [k, v] of Object.entries(S.burnView(cfg))) o["burn_cfg." + k] = v;
  if ("skip" in cfg) o.skip = (cfg.skip || []).slice().sort();
  if ("tz" in cfg) o.tz = cfg.tz;
  return o;
}
/** policy/source.js's snapshot `s` (Pepe's push). Site-owned: econ_cfg / consts / flags / burn_cfg / skip / tz from policy_cfg
 *  (his journals, days_done, burn_inflight and bot_version stay his - they are not config); mirror: compared. */
async function sourceView(s) {
  const snap = await readerSnap("the policy engines' settings");
  if (!snap) return s;
  if (snap.own.cfg.owner === "site") {
    const miss = need(snap.cfg, SOURCE_KEYS);
    if (miss.length) throw missingErr("the policy engines' settings", miss);
    return Object.assign({}, s, { from: "site", owner: "site", rev: snap.rev, econ_cfg: S.econView(snap.cfg), consts: S.constsView(snap.cfg), flags: S.flagsView(snap.cfg),
                                  burn_cfg: S.burnView(snap.cfg), skip: snap.cfg.skip.slice(), tz: snap.cfg.tz });
  }
  if (s && s.at !== null && s.at !== undefined && Object.keys(snap.cfg).length) {
    const push = Object.assign({}, s, { skip: Array.isArray(s.skip) ? s.skip.slice().sort() : s.skip });
    const fields = SOURCE_FIELDS.filter((f) => !(f.startsWith("econ_cfg.") && !s.econ_cfg));
    noteDual("policy.source", compareFields(push, sourceSite(snap.cfg), fields));
  }
  return snap.own.cfg.owner === s.owner ? s : Object.assign({}, s, { owner: snap.own.cfg.owner });
}
/** fed/service.cfgNow's config (DEFAULTS + the engines' config + Pepe's per-op override): compared with the site's while Pepe owns
 *  it (T2: the per-op econ_cfg wins today - a difference here is exactly that). */
async function fedDual(cfg) {
  const snap = await readerSnap("the Fed's settings");
  if (!snap || snap.own.cfg.owner === "site" || !Object.keys(snap.cfg).length) return;
  const site = S.econView(snap.cfg);
  noteDual("fed.cfgNow", compareFields(cfg, site, S.ECON_KEYS.filter((k) => k in cfg || k in site)));
}
const MONETARY_FIELDS = ["flash.house", "flash.bank", "flash.mm", "house_hard_floor", "donation.rate", "donation.bonus_pct", "grant_weekly_cap", "band.floor", "band.ceiling"];
/** funding.js's monetary block (sync: the last committed snapshot this process read). m = funding.cleanMonetary(push) | null;
 *  prev = the block funding uses now (restored from funding_state at start).
 *  Mirror (Pepe owns the config, or it is frozen for the hand-over): Pepe's block is used, and compared.
 *  Site-owned: its config fields from policy_cfg (tagged cfg_rev). Review of PO-2 - never Pepe's block once the site owns them: a
 *  missing key keeps the last block the site computed (and alerts); while the owner isn't known (no committed read yet, or the
 *  owner being changed) the last site block stands, else `prev` when the site built it, else Pepe's - and a refresh re-applies
 *  the block the moment the owner turns out to be the site. */
const MONETARY_KEYS = ["layers", "flash_house", "flash_bank", "flash_mm", "house_hard_floor", "donation_rate", "donation_bonus_pct", "grant_weekly_cap", "fed_floor", "fed_ceiling"];
let lastSiteMonetary;      // {rev, block} - the last block the site computed while it owned the config (undefined: none)
let monetaryKick = null;
function monetaryFor(m, prev) {
  const snap = lastSnap;
  const own = ownerHint();
  const siteOwnBlock = () => (lastSiteMonetary ? lastSiteMonetary.block : prev && typeof prev === "object" && prev.cfg_rev !== undefined ? prev : undefined);
  if (!snap || own === null) {
    // the owner isn't known: read it, and re-apply once it is the site's (no Pepe sync needed)
    if (!monetaryKick) {
      monetaryKick = refresh().then((s) => {
        if (s.own.cfg.owner === "site") { try { require("../funding").reapplyPolicy(); } catch (e) { /* funding not loaded */ } }
      }).catch(() => {}).finally(() => { monetaryKick = null; });
    }
    const b = siteOwnBlock();
    return b !== undefined ? b : m;
  }
  if (own === "site") {
    try {
      const miss = need(snap.cfg, MONETARY_KEYS);
      if (miss.length) {
        missingErr("the funding monetary block", miss);
        const b = siteOwnBlock();
        if (b !== undefined) return b;
        return null;                                // never computed by the site: no block (flash off) until the keys are back
      }
      const v = S.monetaryView(snap.cfg);
      if (v === null) { lastSiteMonetary = { rev: snap.rev, block: null }; return null; }
      const o = m ? JSON.parse(JSON.stringify(m)) : { flash: {}, fedloan_room: 0, house_hard_floor: 0, donation: {}, grant_weekly_cap: -1, week_start: 0, band: null };
      if (!o.band) o.band = { fed: null, floor: null, ceiling: null };
      const ignored = [];
      for (const [f, x] of Object.entries(v)) {
        if (m && !S.equalish(S.getPath(m, f), x)) ignored.push(`${f} ${S.canon(S.getPath(m, f))}`);
        S.setPath(o, f, x);
      }
      o.cfg_rev = snap.rev;
      if (ignored.length && !warned.has("funding-ignored:" + ignored.join(","))) {
        warned.add("funding-ignored:" + ignored.join(","));
        console.log(`[funding] ignored pepe ${ignored.join(", ")} (the site owns the economy settings, rev ${snap.rev})`);
      }
      lastSiteMonetary = { rev: snap.rev, block: o };
      return o;
    } catch (e) {
      console.error("[policycfg] monetary block:", e.message);
      const b = siteOwnBlock();
      return b !== undefined ? b : null;
    }
  }
  lastSiteMonetary = undefined;                       // Pepe's config again: a later site period starts from its own block
  if (Object.keys(snap.cfg).length && "layers" in snap.cfg) {
    const v = S.monetaryView(snap.cfg);
    const pushOn = !!m, siteOn = v !== null;
    // Pepe sends no block while his layers are off; the site's view is null then too
    if (pushOn !== siteOn) noteDual("funding.monetary", [{ field: "monetary", push: pushOn ? "on" : null, site: siteOn ? "on" : null }]);
    else if (!pushOn) noteDual("funding.monetary", []);
    else noteDual("funding.monetary", compareFields(m, v, MONETARY_FIELDS));
  }
  return m;
}

// ── the hand-over's reader check (review of PO-2) ──
const tableExists = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const MONETARY_KEY_OF = { "flash.house": ["flash_house"], "flash.bank": ["flash_bank"], "flash.mm": ["flash_mm"], house_hard_floor: ["house_hard_floor"],
                          "donation.rate": ["donation_rate"], "donation.bonus_pct": ["donation_bonus_pct"], grant_weekly_cap: ["grant_weekly_cap"],
                          "band.floor": ["fed_floor"], "band.ceiling": ["fed_ceiling"], monetary: ["layers"] };
function sourceKeysOf(field) {
  const i = field.indexOf(".");
  const blk = i < 0 ? field : field.slice(0, i), name = i < 0 ? null : field.slice(i + 1);
  if (blk === "econ_cfg" || blk === "flags") return [name];
  if (blk === "consts") return [S.CONST_MAP[name]];
  if (blk === "burn_cfg") return [S.BURN_FIELDS[name]];
  return [field];
}
/**
 * A whole config `cfg` (an import, or the store being handed back) against what every READER uses today - Pepe's pushes, as the
 * consumers' dual read compares them: policy.source (econ_cfg - the Fed's cfgNow reads the same -, consts, flags, burn_cfg, skip,
 * tz), capital (capital/core.cfg(): the cut-off's and the loan desk's knobs, its defaults under his capital push), funding.monetary
 * (his last sync's block) and - opts.routes - PAT Routing (econstore's table). The H1 cutover is refused on any difference unless
 * the owner names the keys (policy/handover.js); a rollback is confirmed only once his pushes carry the values handed back.
 * -> {diffs: [{consumer, field, push, site, keys: [the site keys it comes from]}], keys: [every such key, sorted], seen: {kind: ms}}
 */
async function pushCheck(cfg, { routes = true } = {}) {
  const diffs = [];
  const add = (consumer, list, keysOf) => { for (const d of list) diffs.push(Object.assign({ consumer }, d, { keys: (keysOf(d.field) || [d.field]).filter(Boolean) })); };
  const s = await require("./source").pushView();
  if (s.at !== null && s.at !== undefined) {
    const push = Object.assign({}, s, { skip: Array.isArray(s.skip) ? s.skip.slice().sort() : s.skip });
    const fields = SOURCE_FIELDS.filter((f) => !(f.startsWith("econ_cfg.") && !s.econ_cfg));
    add("policy.source", compareFields(push, sourceSite(cfg), fields), sourceKeysOf);
  }
  // read raw (no module init: this runs inside the hand-over's transaction, where a first CREATE TABLE would roll back with it)
  const capRow = (await tableExists("capital_meta")) ? (await getQuery("SELECT value FROM capital_meta WHERE key = 'cfg'"))[0] : null;
  const c = (capRow && parse(capRow.value, null)) || {};
  if (c.at) {
    const D = require("../capital/core").DEFAULT_CFG;
    const out = Object.assign({}, D, c);
    out.flash = Object.assign({}, D.flash, c.flash || {});
    const fields = Object.keys(S.CAPITAL_MAP);
    add("capital", compareFields(out, S.capitalView(cfg, fields), fields), (f) => (S.CAPITAL_MAP[f] || [[f]])[0]);
  }
  // funding's last live sync - only if funding runs in this process (a sync needs it; loading it here would create its tables)
  const fundMod = require.cache[require.resolve("../funding")];
  const m = fundMod && fundMod.exports && typeof fundMod.exports.pushedMonetary === "function" ? fundMod.exports.pushedMonetary() : undefined;
  if (m !== undefined) {
    const v = S.monetaryView(cfg);
    const siteOn = v !== null && v !== undefined;
    if (!!m !== siteOn) add("funding.monetary", [{ field: "monetary", push: m ? "on" : null, site: siteOn ? "on" : null }], (f) => MONETARY_KEY_OF[f]);
    else if (m) add("funding.monetary", compareFields(m, v, MONETARY_FIELDS), (f) => MONETARY_KEY_OF[f]);
  }
  if (routes) {
    const table = {};
    if (await tableExists("pat_routes")) for (const r of await getQuery("SELECT flow, shares FROM pat_routes")) table[r.flow] = parse(r.shares, []);
    if (!S.equalish(table, cfg.pat_routes || {})) add("econstore.routes", [{ field: "pat_routes", push: table, site: cfg.pat_routes || {} }], () => ["pat_routes"]);
  }
  const src = Object.assign(emptySrc(), (await C.meta("cfg_src")) || {});
  return { diffs, keys: [...new Set(diffs.flatMap((d) => d.keys))].sort(), seen: Object.assign({}, src.kinds) };
}

// ── the run window (T22): engine-input keys frozen from 03:40 UTC until that UTC day's runs settle ──
const ymd = (s) => new Date(Math.floor(s) * 1000).toISOString().slice(0, 10);
/** -> {open, from, boundary, waiting: ["treasury:D...", ...]} for `nowS` (the scheduler's clock). A run is settled when it is
 *  done / handed / missed here or Pepe's push lists it done; an engine whose flag is off expects no run.
 *  Review of PO-2: the site's own daily CAPITAL CUT-OFF (capital/service.js, 04:00 UTC) reads the staking keys (the ceiling, the
 *  cushion, the Auto cap, ...) - whenever the vaults run on the site, the window also waits for the cut-off of this boundary
 *  (the vaults' next_epoch past it), and an OVERDUE cut-off (next_epoch already passed) freezes them at any hour. */
async function capitalWait(nowS, boundary) {
  try {
    if (!(await tableExists("capital_meta"))) return null;         // capital never ran on this site (and no init inside an edit's tx)
    const V = require("../capital/vaults");
    if (!(await V.live())) return null;
    const next = Number((await V.load()).next_epoch || 0);
    if (next > boundary || (nowS < boundary - WINDOW_LEAD_S && next > nowS)) return null;
    return `capital:cutoff ${ymd(next > 0 ? next : boundary)}`;
  } catch (e) {
    return "capital:cutoff (unreadable)";
  }
}
async function runWindow(nowS, snap) {
  snap = snap || await snapshot();
  const hour = Number.isInteger(snap.cfg.epoch_hour) ? snap.cfg.epoch_hour : 4;
  const boundary = Math.floor(nowS / 86400) * 86400 + hour * 3600;
  const from = boundary - WINDOW_LEAD_S;
  if (nowS < from) {
    const cw = await capitalWait(nowS, boundary);
    return { open: !!cw, from, boundary, waiting: cw ? [cw] : [] };
  }
  let push = {};
  try { push = await require("./source").read(); } catch (e) { push = {}; }
  const flags = Object.assign({}, push.flags || {}, S.flagsView(snap.cfg));
  const did = "D" + ymd(boundary), eid = "W" + ymd(boundary);
  const monday = new Date(boundary * 1000).getUTCDay() === 1;
  const want = [];
  if (flags.tr_live) { if (monday) want.push(["treasury", eid]); want.push(["treasury", did]); }
  if (flags.layers) want.push(["monetary", did]);
  const waiting = [];
  for (const [e, p] of want) {
    const r = await C.run(e, p);
    if (r && ["done", "handed", "missed"].includes(r.state)) continue;
    if (e === "treasury" && /^D/.test(p) && (push.days_done || []).includes(p)) continue;
    if (e === "treasury" && /^W/.test(p) && (push.journal || []).some((j) => j && j.eid === p && j.state === "done")) continue;
    if (e === "monetary" && (push.mo_days_done || []).includes(p)) continue;
    waiting.push(`${e}:${p}`);
  }
  const cw = await capitalWait(nowS, boundary);
  if (cw) waiting.push(cw);
  return { open: waiting.length > 0, from, boundary, waiting };
}

// ── edits (site-owned only): /admin/economy and Pepe's chat ──
/**
 * Change keys. changes = {key or alias: value | null ("default")}; via web (a fraction key's number is a percent) | chat (Pepe's
 * text; a fraction key must spell the %); actor = the site username / Pepe login; baseRev = the rev the editor saw (stale: 409
 * with the saved values). ONE transaction: the ownership, pause, rev, run window and whole-config checks, the rows, the log, the
 * admin audit (and the ceiling log). -> {ok, unchanged?, rev, sha, msg, changed: [{key, old, new, applies}]}; refusals throw Refuse.
 */
async function edit({ changes, via, actor, actorUserId = null, baseRev, note = null } = {}) {
  await init();
  if (via === "telegram") throw new Refuse(403, "telegram", "The economy settings are never changed from Telegram.");
  if (via !== "web" && via !== "chat" && via !== "cli") throw new Refuse(400, "bad_via", "via must be web or chat");
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) throw new Refuse(400, "nothing", "nothing to change");
  const ch = {};
  for (const [k0, v] of Object.entries(changes)) ch[S.resolveKey(k0, { lower: via === "chat" }) || (via === "chat" ? String(k0).toLowerCase() : String(k0))] = v;
  const out = await tx(async () => {
    const snap = await load();
    const own = snap.own.cfg;
    if (own.owner === "cutting") throw new Refuse(423, "frozen", "The economy settings are frozen for the hand-over - nothing changed.");
    if (own.owner !== "site") throw new Refuse(409, "mirror", "The economy settings are still Pepe's (the site mirrors them until the hand-over) - change them on Pepe. Nothing changed here.");
    if (own.paused) throw new Refuse(423, "paused", `The economy settings are paused${own.paused_by ? " by " + own.paused_by : ""}${own.note ? " (" + own.note + ")" : ""} - nothing changed.`);
    if (own.return_sha) throw new Refuse(423, "returning", "The economy settings are being handed back to Pepe (he writes the site's values back) - nothing changed.");
    if (baseRev === undefined || baseRev === null || Number(baseRev) !== snap.rev) {
      const saved = {};
      for (const k of Object.keys(ch)) if (S.SPEC[k]) saved[k] = snap.cfg[k] === undefined ? null : snap.cfg[k];
      throw new Refuse(409, "stale_rev", `The settings changed since you loaded them (now rev ${snap.rev}) - nothing changed; look again.`, { rev: snap.rev, sha: snap.sha, saved });
    }
    const miss = S.KEYS.filter((k) => !(k in snap.cfg));
    if (miss.length) throw missingErr("an edit", miss);
    const catalog = "pat_routes" in ch ? await routesCatalog() : null;
    const r = S.change(snap.cfg, ch, { via: via === "cli" ? "web" : via, readonly: true, catalog });
    if (!r.ok) throw new Refuse(400, "invalid", r.msg, { errors: r.errs });
    if (!r.diff.length) return { ok: true, unchanged: true, rev: snap.rev, sha: snap.sha, msg: r.msg, changed: [] };
    const frozen = r.diff.filter(([k]) => S.SPEC[k].engine_input).map(([k]) => k);
    if (frozen.length) {
      const win = await runWindow(C.nowS(), snap);
      if (win.open) {
        throw new Refuse(423, "run_window", `${frozen.join(", ")} ${frozen.length > 1 ? "feed" : "feeds"} today's policy runs - frozen from ${new Date(win.from * 1000).toISOString().slice(11, 16)} UTC until they're done (waiting: ${win.waiting.join(", ")}). Nothing changed.`,
                         { window: win, keys: frozen });
      }
    }
    const w = await writeChanges(r.diff, { by: actor || "?", actorUserId, via, note, snap });
    return { ok: true, rev: w.rev, sha: w.sha, msg: r.msg, changed: r.diff.map(([k, o, n]) => ({ key: k, old: o === undefined ? null : o, new: n, applies: S.SPEC[k].applies })) };
  });
  forget();
  if (out.changed && out.changed.length) {
    await refresh().catch(() => {});
    try { require("../funding").reapplyPolicy(); } catch (e) { /* funding not loaded (a bare test) */ }
  }
  return out;
}

// ── migration seeding (plan 2.2) + the boot check ──
async function applyMigrations(list = MIGRATIONS) {
  await init();
  let seeded = 0;
  for (const m of list) {
    if (!m || !m.id || !m.seeds) continue;
    const n = await tx(async () => {
      const snap = await load();
      const done = new Set((await getQuery("SELECT key FROM policy_cfg_seed WHERE migration = ?", [m.id])).map((r) => r.key));
      const diff = [];
      for (const [k, v] of Object.entries(m.seeds)) {
        if (!S.SPEC[k] || done.has(k) || k in snap.cfg) continue;
        if (!S.validValue(S.SPEC[k], v)) throw new Error(`migration ${m.id}: ${S.keyError(k, S.SPEC[k], v)}`);
        diff.push([k, undefined, v]);
      }
      if (!diff.length) return 0;
      await writeChanges(diff, { by: "migration " + m.id, via: "migration", note: m.note || null, snap });
      for (const [k, , v] of diff) await runQuery("INSERT OR IGNORE INTO policy_cfg_seed (migration, key, value, ts) VALUES (?, ?, ?, ?)", [m.id, k, S.canon(v), nowMs()]);
      return diff.length;
    });
    if (n) console.log(`[policycfg] migration ${m.id}: seeded ${n} key(s)`);
    seeded += n;
  }
  forget();
  return seeded;
}
/** Start: migrations, then - when the site owns the config - every SPEC key must be there (loud + an alert otherwise). */
async function bootCheck() {
  await applyMigrations();
  const snap = await refresh();
  const miss = S.KEYS.filter((k) => !(k in snap.cfg));
  if (snap.own.cfg.owner === "site" && miss.length) missingErr("start-up", miss);
  return { owner: snap.own.cfg.owner, missing: miss };
}

// ── views ──
const specHash = () => sha256(S.canon(S.KEYS.map((k) => { const s = S.SPEC[k]; return [k, s.kind, s.unit, s.min, s.max, s.choices, s.readonly]; })));
/** Pepe's pull (PO-3: every 60 s and at each engine tick). Review of PO-2: answered in ONE transaction of its own on the chain -
 *  committed rows only, in order (queued behind every transaction that reached the site before it; settledMoveStatus' rule) -
 *  and "unchanged" only when BOTH the rev and the sha Pepe holds are the current ones (have=<rev>&sha=<sha>): a rev is never
 *  trusted alone. */
async function botCfg(have, haveSha) {
  await init();
  const given = have !== undefined && have !== null && have !== "";
  return tx(async () => {
    const snap = await load();
    const out = { ok: true, owner: snap.own.cfg.owner, paused: !!snap.own.cfg.paused, returning: snap.own.cfg.return_sha || null, rev: snap.rev, sha: snap.sha,
                  spec_hash: specHash() };
    if (given) await C.setMeta("cfg_pepe_rev", { rev: Number(have), sha: haveSha ? String(haveSha).slice(0, 64) : null, at: nowMs() });
    if (given && Number(have) === snap.rev && typeof haveSha === "string" && haveSha && haveSha === snap.sha) return Object.assign(out, { unchanged: true });
    out.cfg = snap.cfg;
    out.log_tail = await getQuery("SELECT rev, ts, actor, via, key, old, new, note FROM policy_cfg_log ORDER BY id DESC LIMIT 20");
    return out;
  });
}
async function logRows({ key = null, actor = null, via = null, limit = 100 } = {}) {
  await init();
  const where = [], args = [];
  if (key) { where.push("key = ?"); args.push(String(key)); }
  if (actor) { const a = String(actor); where.push("(actor = ? OR actor LIKE ? ESCAPE '!')"); args.push(a, a.replace(/[!%_]/g, (c) => "!" + c) + " (%"); }
  if (via) { where.push("via = ?"); args.push(String(via)); }
  args.push(Math.max(1, Math.min(500, Math.trunc(Number(limit)) || 100)));
  return getQuery(`SELECT id, rev, ts, actor, via, key, old, new, note FROM policy_cfg_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, args);
}
async function dualSummary(days = 7) {
  await init();
  await flushDual();
  const since = utcDay(nowMs() - (days - 1) * 86400e3);
  return { checks: await getQuery("SELECT day, consumer, checks, diffs, first_ts, last_ts FROM policy_cfg_dualcheck WHERE day >= ? ORDER BY day DESC, consumer", [since]),
           diffs: await getQuery("SELECT day, consumer, key, push, site, n, first_ts, last_ts FROM policy_cfg_dualread WHERE day >= ? ORDER BY last_ts DESC LIMIT 200", [since]) };
}
async function adminView() {
  await init();
  const snap = await snapshot({ fresh: true });
  const diff = await diffReport();
  await checkMirrorDay().catch(() => null);
  const keys = S.KEYS.map((k) => {
    const sp = S.SPEC[k];
    const has = k in snap.cfg;
    const m = snap.meta[k] || {};
    return { key: k, section: sp.section, label: sp.label, unit: sp.unit, suffix: sp.suffix, kind: sp.kind, choices: sp.choices, min: sp.min, max: sp.max,
             applies: sp.applies, engine_input: sp.engine_input, readonly: sp.readonly, aliases: sp.aliases, value: has ? snap.cfg[k] : null, present: has,
             shown: has ? S.fmtValue(sp, snap.cfg[k]) : null, default: sp.default, default_shown: S.fmtValue(sp, sp.default),
             last: has ? { rev: m.rev, by: m.by, via: m.via, ts: m.updated, src: m.src } : null };
  });
  return { ok: true, owner: snap.own.cfg.owner, own: snap.own, rev: snap.rev, sha: snap.sha, spec_hash: specHash(), sections: S.SECTIONS, keys, diff,
           dual: await dualSummary(7), mirror_days: (await C.meta("cfg_mirror_days")) || {}, window: await runWindow(C.nowS(), snap),
           pepe_rev: await C.meta("cfg_pepe_rev"), log: await logRows({ limit: 40 }),
           ceil_log: await getQuery("SELECT ts, rev, ceil_apr, ceil_cushion, ceil_cushion_days, by, via FROM capital_ceil_log ORDER BY id DESC LIMIT 10") };
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().then(() => bootCheck()).then(async (bc) => {
    await backfill();
    if (bc.owner === "site") { try { require("../funding").reapplyPolicy(); } catch (e) { /* funding not loaded */ } }
  }).catch((e) => console.error("[policycfg] init:", e.message));
  const iv = setInterval(() => { flushDual().catch(() => {}); refresh().catch(() => {}); checkMirrorDay().catch(() => {}); }, DUAL_FLUSH_MS);
  if (iv.unref) iv.unref();
  // review of PO-2: a restart (a deploy) writes the buffered comparisons first - the drain gives them its grace before the DB closes
  try { require("../shutdown").onDrain(() => { flushDual().catch(() => {}); }); } catch (e) { /* no shutdown module (a bare test) */ }
  const SR = () => require("../staffroles");
  const answer = (res, e) => {
    if (e instanceof Refuse || (e && e.status && e.code)) return res.status(e.status).json(Object.assign({ ok: false, code: e.code, error: e.message }, e.extra || {}));
    console.error("[policycfg]", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  };
  const botTok = (req) => (req.body && typeof req.body.password === "string" ? req.body.password : req.get("x-bot-token") || "");
  const botRead = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!isBotToken(botTok(req))) return res.status(403).json({ ok: false, error: "unauthorized" });
    const q = req.method === "GET" ? req.query : (req.body || {});
    try { res.json(await botCfg(q.have, typeof q.sha === "string" ? q.sha : undefined)); } catch (e) { answer(res, e); }
  };
  app.get("/api/policy/bot/cfg", botRead);
  app.post("/api/policy/bot/cfg", botRead);
  // Pepe's chat: !econ set (PO-3 writes through here once the site owns the config). A Pepe OWNER by role (pinned, PO-0b); never Telegram.
  // Review of PO-2: this route IS the chat path - via is always "chat" (the D-7 "%" rule, the log, the audit); a caller naming
  // anything else (web / cli: other rules, another trail) is refused, Telegram with 403.
  app.post("/api/policy/bot/cfg/set", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      const via = b.via === undefined || b.via === null || b.via === "" ? "chat" : String(b.via);
      if (via === "telegram") throw new Refuse(403, "telegram", "The economy settings are never changed from Telegram.");
      if (via !== "chat") throw new Refuse(400, "bad_via", "Pepe's route changes the settings as chat only (via chat).");
      const actor = String(b.actor || "").trim().toLowerCase().slice(0, 60);
      if (!actor || (await SR().roleOf(actor)) !== "owner") throw new Refuse(403, "owner_only", "Only a Pepe owner changes the economy settings.");
      res.json(await edit({ changes: b.changes, via: "chat", actor, actorUserId: `chat:${actor}`, baseRev: b.base_rev, note: b.note ? String(b.note).slice(0, 300) : null }));
    } catch (e) { answer(res, e); }
  });

  const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  const viewer = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT class, username, userId, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!require("../siteperms").can(row, "econ.telemetry_policy")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/policy/cfg", noStore, addUser, async (req, res) => {
    const me = await viewer(req, res);
    if (!me) return;
    try {
      const v = await adminView();
      v.can_edit = v.owner === "site" && !v.own.cfg.return_sha && !!(await SR().ownerOf(me, "econ.telemetry_policy"));
      res.json(v);
    } catch (e) { answer(res, e); }
  });
  app.get("/api/admin/policy/cfg/log", noStore, addUser, async (req, res) => {
    if (!(await viewer(req, res))) return;
    try { res.json({ ok: true, rows: await logRows({ key: req.query.key || null, actor: req.query.actor || null, via: req.query.via || null, limit: req.query.limit }) }); }
    catch (e) { answer(res, e); }
  });
  // the owner's web edit: the class + Pepe's owner role (fresh), the /admin/economy password step-up, CSRF + same-site fetch, base_rev, a note
  app.post("/api/admin/policy/cfg", noStore, addUser, async (req, res) => {
    const me = await viewer(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("../middleware/authGuard").sameSite(req)
        || !require("../pepecontrol").csrfOk(me.username, req.get("x-csrf-token"))) {
      return res.status(403).json({ ok: false, code: "cross_site", error: "Security check failed - reload the page." });
    }
    if (!(await SR().ownerOf(me, "econ.telemetry_policy"))) return res.status(403).json({ ok: false, code: "owner_only", error: SR().OWNER_ONLY });
    const b = req.body || {};
    const note = String(b.note || "").replace(/\s+/g, " ").trim().slice(0, 300);
    if (note.length < 3) return res.status(400).json({ ok: false, code: "note", error: "Say why in the note - every change is logged with it." });
    if (!b.changes || typeof b.changes !== "object" || Array.isArray(b.changes) || !Object.keys(b.changes).length) return res.status(400).json({ ok: false, code: "nothing", error: "Nothing to change." });
    try { await require("../econstore").stepUp(me, b); } catch (e) { return res.status(e.status || 403).json({ ok: false, code: e.code || null, error: e.message }); }
    // plan section 8: the actor is the site username + the linked chat login (the owner role is on that login)
    const actor = me.camfrogUsername ? `${me.username} (${String(me.camfrogUsername).trim().toLowerCase()})` : me.username;
    try { res.json(await edit({ changes: b.changes, via: "web", actor, actorUserId: me.userId, baseRev: b.base_rev, note })); }
    catch (e) { answer(res, e); }
  });
}

module.exports = { init, register, ownership, owner, putOwner, putReturning, ownerHint, setPause, snapshot, readerSnap, cached, refresh, forget, load, writeChanges,
                   mirror, backfill, extract, diffReport, checkMirrorDay, noteDual, flushDual, compareFields, capitalCfg, sourceView, fedDual, monetaryFor, pushCheck,
                   runWindow, edit, applyMigrations, bootCheck, botCfg, logRows, dualSummary, adminView, routesCatalog, specHash, cfgSha, missingErr, unreadableErr, isCfgErr,
                   Refuse, FEATURES, OWNERS, MIGRATIONS, SOURCES, BY_KEY, SRC_STALE_MS, SETTLE_MS, WINDOW_LEAD_S, LOG_KEEP,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); },
                   _setLogKeep: (n) => { logKeep = n === undefined ? LOG_KEEP : n; },
                   _dualPending: () => ({ rows: dualBuf.size, checks: checkBuf.size }),
                   // tests: what a restart forgets (the buffers, the warnings, every snapshot, the owner as last read, the site's last block)
                   _resetMemory: () => { dualBuf.clear(); checkBuf.clear(); warned.clear(); alerted.clear(); cache = null; lastSnap = null; ownerChanging = true;
                                         lastSiteMonetary = undefined; gen++; } };
