// policy/source.js — PO-1 of the economy policy -> site plan ("Phase 6", T14): the ONE place every reader of the economy's
// policy settings gets them from. Before this file each reader opened Pepe's policy push (policy_meta "cfg", POST
// /api/policy/bot/config) itself - the scheduler's clock (flags, VAULT_EPOCH_UTC_HOUR), the burn pass (burn_cfg,
// burn_inflight), the engines' inputs (econ_cfg, consts, flags, skip, tz, his journals), the Fed's cfgNow, the staking card's
// weekly cap - so retiring a push field could silently stop an epoch. Now they read here, and PO-10 can only remove a push
// field once a test proves no reader of it is left (the empty-push live pass).
//
// What it answers (read(), one snapshot; the helpers below read one part):
//   econ_cfg     Pepe's EFFECTIVE econ_cfg (pepe_econcfg._ec_all: every key, defaults included); the site's econ_cfg overrides
//                (econstore) stand in only while he never pushed one - config() below
//   consts       his system constants (VAULT_EPOCH_UTC_HOUR, HOUSE_MIN_CASH, HEIST_VAULT_MIN/CAP, ...)
//   flags        layers / tr_live / ap_on (econ_layers, econ_treasury, econ_activity_pads)
//   burn_cfg     his burn settings (mode accrual | batch, accrual_every_min, ...); burn_inflight: his pending burns
//   skip, tz     the logins left out of participation; the participation day's time zone
//   journal      the weekly epochs he ran; days_done: the daily releases he ran; mo_days_done: the monetary days he ran;
//                local_check: his participation day, for the site's tz check
// WHERE FROM (PO-2): policy_ownership.cfg decides. While it is "pepe" (mirror mode, until the H1 hand-over) every value is
// Pepe's push - exactly what the readers used before - and policy/config.js compares it with the site's store (the dual read,
// consumer "policy.source"). Once the site owns the config ("site"), econ_cfg / consts / flags / burn_cfg / skip / tz come from
// policy_cfg (a missing key throws E_CFG_MISSING: the engine defers, never a code default); his journals, days_done,
// burn_inflight and bot_version stay his push (they are not config). `from` says which ("push" | "site").
"use strict";
const C = require("./core");

const TZ_DEFAULT = "America/New_York";
const EPOCH_HOUR_DEFAULT = 4;

/** Who owns the policy config: "pepe" (his push; the site mirrors it) | "cutting" (frozen for the hand-over) | "site". */
async function owner() {
  try { return await require("./config").owner("cfg"); } catch (e) { return "pepe"; }
}

/** Pepe's last policy push as stored (or {}). Only this module (and core.js, which stores it) touches it: core's reader is
 *  named _pushForSource, and test/policy.test.js fails if any other file calls it. */
async function push() { return (await C._pushForSource()) || {}; }
/** PO-2: the push exactly as stored (null: never pushed) - for the config mirror only (policy/config.js backfill copies it into
 *  policy_cfg at start); every READER uses read(). */
async function rawPush() { return (await C._pushForSource()) || null; }

const intOr = (v, d) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? n : d; };
const objOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const listOr = (v) => (Array.isArray(v) ? v : []);

/** Everything at once (one read of the push, then the config store's view of it). */
async function read() {
  const p = await push();
  const ec = p.econ_cfg && typeof p.econ_cfg === "object" && Object.keys(p.econ_cfg).length ? p.econ_cfg : null;
  const s = { from: "push", owner: "pepe", at: p.at === undefined ? null : p.at, econ_cfg: ec, consts: objOr(p.consts), flags: objOr(p.flags),
              burn_cfg: objOr(p.burn_cfg), burn_inflight: Math.max(0, intOr(p.burn_inflight, 0)), skip: listOr(p.skip), tz: p.tz || TZ_DEFAULT,
              journal: listOr(p.journal), days_done: listOr(p.days_done), mo_days_done: listOr(p.mo_days_done),
              local_check: Array.isArray(p.local_check) ? p.local_check : null, bot_version: p.bot_version || "" };
  return require("./config").sourceView(s);
}

/** The engines' config (the shape policy/gather.config() always had): {push: the snapshot, cfg, consts, flags}. Pepe's
 *  EFFECTIVE values are the truth his own engines use (every key, defaults included); the site's econ_cfg overrides table only
 *  stands in when he never pushed them. Site-owned (PO-2, after H1): policy_cfg's values, every key present. */
async function config() {
  const s = await read();
  let cfg;
  if (s.econ_cfg) cfg = Object.assign({}, s.econ_cfg);
  else {
    let over = {};
    try { over = (await require("../econstore").getSettings()).econ_cfg || {}; } catch (e) { over = {}; }
    cfg = Object.assign({}, require("./engines").DEFAULTS, over);
  }
  return { push: s, cfg, consts: s.consts, flags: s.flags };
}

/** The epoch hour (UTC) the periods are cut at: consts.VAULT_EPOCH_UTC_HOUR, else 4. */
const hourOf = (consts) => {
  const v = (consts || {}).VAULT_EPOCH_UTC_HOUR;
  return v === undefined || v === null ? EPOCH_HOUR_DEFAULT : intOr(v, EPOCH_HOUR_DEFAULT);
};
async function hour() { return hourOf((await read()).consts); }
async function flags() { return (await read()).flags; }
/** Pepe's econ_cfg as he pushed it (null: never pushed) - e.g. the staking card's wf_staker_cap_pct. Site-owned: policy_cfg's. */
async function econCfg() { return (await read()).econ_cfg; }
/** {cfg, inflight}: the burn settings and the PAT already being burned (Pepe's pending burns; the site computes its own from
 *  H2a / PO-10). */
async function burn() { const s = await read(); return { cfg: s.burn_cfg, inflight: s.burn_inflight }; }
async function age() { return C.cfgAge(); }

module.exports = { owner, read, rawPush, config, hour, hourOf, flags, econCfg, burn, age, TZ_DEFAULT, EPOCH_HOUR_DEFAULT };
