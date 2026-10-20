// policy/cfgspec.js — PO-2 of the economy policy -> site plan ("Phase 6", plan section 2.2): the economy's policy settings as
// ONE spec - every key the site's policy config store (policy/config.js, table policy_cfg) holds, with its unit, bounds, when a
// change applies and whether a policy engine reads it - and Pepe's rules for reading, checking and changing them, ported from
// pepe_econcfg.py (SPEC, parse_value, valid_value, validate, _ec_change, fmt_value) so the site and Pepe answer the same
// (test/policy-config-vectors.test.js replays camfrog-bot tools/gen_econcfg_vectors.py: 0 differences). A pure module: no
// database, no site state.
//
// What it covers (sections):
//   the 69 econ_cfg keys (pepe_econcfg.SPEC, in Pepe's order; their sections treasury .. waterfall, Python kinds int / cap /
//     bool / enum / pct; the five ALIASES are ONE key here: house_hard_floor = sink vault_house_min (HOUSE_MIN_CASH), mm_target =
//     vault_mm_min_target, casino_floor = heist_vault_min, casino_cap = heist_vault_cap, budget_launchpad =
//     econ_launchpad_cfg.weekly_cap - the alias name is accepted on input)
//   the ECONOMY rows of Pepe's sink-rate table (pepe_econcfg.ECON_SINK_KEYS, plan section 5): staking / bank / loans / fees /
//     casino_vault, stored in Pepe's units (a fraction stays a fraction: vault_ceil_apr 0.25 = 25%); vault_ceil_cushion and
//     vault_auto_staker_cap are on / off switches (D-7); the v1 knobs vault_dividend / vault_house_target / vault_bank_min_target
//     are read-only "legacy" (D-9)
//   burn (pepe_burn burn_cfg), flags (econ_layers -> layers, econ_treasury -> tr_live, econ_activity_pads -> ap_on), routing
//     (pat_routes, D-19) and system (the epoch hour, the vaults' minimum move, the participation skip list and time zone:
//     read-only, changed only by a deploy migration)
// Not here: Pepe's dead knobs (D-9: stake_apr_*, stake_topup*, automint, vault_share_reserve, his lotto price / pot share -
// archived in the H1 blob only), the Phase 4b flags (D-1, mirrored read-only), derived state (targets, fl_room, credit, flows -
// T16, PO-4) and game rules (prices, rakes, faucet amounts).
//
// Units (D-7): pct (a percent: 25 = 25%), fraction (0.25 = 25%; always SHOWN as %, and chat input must spell the % -
// "!econ set vault_ceil_apr 25%" - a bare number is refused with "add %"; the web field is a %-labelled number), pat, days,
// count, bool, enum, mult (x), minutes, text, list, routes. `applies`: now | next_period (plan 2.2 "Timing"); `engine_input`:
// a policy engine (treasury / monetary / burn) or the capital cut-off reads it - frozen from 03:40 UTC until that day's runs
// settle (policy/config.js runWindow).
"use strict";
const { pyRoundN } = require("./pymath");

const AMOUNT_MAX = 10000000000;
const UNLIMITED = -1;
const BUDGET_MAX = 50000000;
const BUDGET_TOTAL_MAX = 100000000;
const GROUPS = ["welcome", "levelup", "achievements", "misc", "royalties", "roomgames", "turf", "season", "launchpad", "activity"];
const CUSHION_KEEP_DAYS = 30;

// ── Python's number / text semantics (the messages are Pepe's, word for word) ──
/** f"{int(n):,}" */
const fmtInt = (n) => String(Math.trunc(Number(n)) || 0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
function sciParts(x) {
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x);
  return { sign: m[1], digits: m[2] + (m[3] || ""), exp: parseInt(m[4], 10) };
}
/** repr(float) - the shortest digits that round-trip, Python's layout (exponent below 1e-4 / from 1e16, "x.0"). */
function pyFloatRepr(x) {
  x = Number(x);
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const { sign, digits, exp } = sciParts(x.toExponential());
  if (exp < -4 || exp >= 16) return sign + (digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits) + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  if (exp >= 0) {
    const ip = digits.slice(0, exp + 1).padEnd(exp + 1, "0"), fp = digits.slice(exp + 1);
    return sign + ip + "." + (fp || "0");
  }
  return sign + "0." + "0".repeat(-exp - 1) + digits;
}
/** f"{x:g}" (six significant digits, trailing zeros dropped). */
function pyG(x) {
  x = Number(x);
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  const { sign, digits, exp } = sciParts(x.toExponential(5));
  const strip = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
  if (exp < -4 || exp >= 6) return sign + strip(digits[0] + "." + digits.slice(1)) + "e" + (exp < 0 ? "-" : "+") + String(Math.abs(exp)).padStart(2, "0");
  return strip(Math.abs(x).toFixed(Math.max(0, 5 - exp))).replace(/^/, sign);
}
/** repr(str): single quotes unless the text has one and no double quote. */
function pyStrRepr(s) {
  s = String(s);
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").replace(new RegExp(q, "g"), "\\" + q).replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + q;
}
/** str(v) of a JSON value as Python would print it (an integral JSON number reads as an int). */
function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (Array.isArray(v)) return "[" + v.map(pyReprAny).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => pyStrRepr(k) + ": " + pyReprAny(x)).join(", ") + "}";
  return String(v);
}
const pyReprAny = (v) => (typeof v === "string" ? pyStrRepr(v) : pyStr(v));
const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?)(?:[eE][+-]?\d(?:_?\d)*)?$/;
/** float(s) for a string: undefined when Python would raise. */
function pyFloatStr(s) {
  const t = String(s).trim();
  const low = t.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(low)) return low.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(low)) return NaN;
  if (!FLOAT_RE.test(t)) return undefined;
  return Number(t.replace(/_/g, ""));
}
const isNum = (v) => typeof v === "number";
const isInt = (v) => typeof v === "number" && Number.isInteger(v);

// ── the spec ──
const SPEC = Object.create(null);
const ORDER = [];
function add(key, o) {
  SPEC[key] = Object.assign({ key, section: "misc", label: key, default: null, min: 0, max: AMOUNT_MAX, kind: "int", choices: null, unit: "pat", suffix: "",
                              applies: "now", engine_input: false, readonly: false, aliases: [], py: false, sink: null }, o);
  ORDER.push(key);
}
const GRANT_LABEL = { welcome: "welcome grants", levelup: "level-ups", achievements: "achievements", misc: "connect bonus / codes / platform rewards",
                      royalties: "pad owner royalties", roomgames: "room games (raffle, top mic, pictionary, !beg)", turf: "turf income",
                      season: "turf season prize match", launchpad: "pad launchpad (launch grants, owner match, newcomer welcome)",
                      activity: "activity rewards (that day's active players, chat + mic)" };
const BUDGETS = { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000, royalties: 300000, roomgames: 3500000, turf: 500000,
                  season: 2000000, launchpad: 1000000, activity: 0 };
const UNCAPPABLE = new Set(["launchpad", "activity"]);
const PACED = new Set(["roomgames", "turf", "activity"]);

// pepe_econcfg.SPEC - Pepe's order, labels, defaults, bounds and kinds (py: true = vectors cover it)
const P = (key, section, label, dflt, o = {}) => add(key, Object.assign({ section, label, default: dflt, py: true }, o));
const NEXT = { applies: "next_period", engine_input: true };
P("house_target", "treasury", "House target", 15000000, NEXT);
P("house_hard_floor", "treasury", "House hard floor (on hand)", 5000000, { max: 100000000, sink: "vault_house_min", aliases: ["vault_house_min"], engine_input: true });
P("bank_target", "treasury", "Bank target (minimum)", 2000000, NEXT);
P("bank_hard_floor", "treasury", "Bank hard floor (on hand)", 1000000);
P("bank_lent_mult_pct", "treasury", "Bank target: % of the peak lent out", 200, Object.assign({ max: 1000, unit: "pct", suffix: "%" }, NEXT));
P("bank_peak_days", "treasury", "Bank target: peak window", 30, Object.assign({ min: 1, max: 365, unit: "days", suffix: "days" }, NEXT));
P("mm_target", "treasury", "Market Maker target (minimum)", 1000000, Object.assign({ max: 1000000000, sink: "vault_mm_min_target", aliases: ["vault_mm_min_target"] }, NEXT));
P("mm_hard_floor", "treasury", "Market Maker hard floor (on hand)", 500000);
P("fedloan_cap", "fedloans", "Fed liquidity loans cap (outstanding)", 10000000);
P("fortknox_floor", "vaults", "Fort Knox floor", 2000000, NEXT);
P("fortknox_cap", "vaults", "Fort Knox cap, fixed mode (overflow -> incentives)", 15000000, NEXT);
P("casino_floor", "vaults", "Casino vault floor", 2000000, Object.assign({ max: 100000000, sink: "heist_vault_min", aliases: ["heist_vault_min"] }, NEXT));
P("casino_cap", "vaults", "Casino vault cap, fixed mode (overflow -> incentives)", 10000000, Object.assign({ max: 1000000000, sink: "heist_vault_cap", aliases: ["heist_vault_cap"] }, NEXT));
P("heist_cap_mode", "vaults", "Fort Knox / Casino caps: fixed amounts or % of the weekly incentive budget", "pct", Object.assign({ kind: "enum", choices: ["pct", "fixed"], unit: "enum" }, NEXT));
P("fortknox_cap_pct", "vaults", "Fort Knox cap: % of the weekly incentive budget (pct mode)", 60.0, Object.assign({ max: 1000, kind: "pct", unit: "pct", suffix: "%" }, NEXT));
P("casino_cap_pct", "vaults", "Casino vault cap: % of the weekly incentive budget (pct mode)", 40.0, Object.assign({ max: 1000, kind: "pct", unit: "pct", suffix: "%" }, NEXT));
for (const g of GROUPS) {
  const label = GRANT_LABEL[g] || g;
  if (g === "launchpad") P("budget_launchpad", "budgets", label, 1000000, { max: BUDGET_MAX, suffix: "PAT/week", aliases: ["launchpad_weekly_cap"], engine_input: true });
  else if (UNCAPPABLE.has(g)) P("budget_" + g, "budgets", label, BUDGETS[g], { max: BUDGET_MAX, suffix: "PAT/week", engine_input: true });
  else P("budget_" + g, "budgets", label, BUDGETS[g], { max: BUDGET_MAX, suffix: "PAT/week", kind: "cap", engine_input: true });
  P("pace_" + g, "budgets", label + ": pacing", PACED.has(g) ? 7 : 0, { max: 7, unit: "days", suffix: "days (0 = off)", engine_input: true });
}
P("fed_floor", "band", "Fed floor (mints back up to it at the daily tick)", 25000000, NEXT);
P("fed_ceiling", "band", "Fed ceiling (the excess is released at the daily tick)", 150000000, NEXT);
P("fed_floor_mint_daily", "band", "Fed floor mint: most per day", 5000000, NEXT);
P("fed_ceiling_action", "band", "Above the ceiling, the excess is", "burn", Object.assign({ kind: "enum", choices: ["burn", "incentives"], unit: "enum" }, NEXT));
P("incentive_guarantee", "band", "Weekly incentive guarantee (Fed tops incentives up to the weekly budgets)", true, Object.assign({ kind: "bool", unit: "bool" }, NEXT));
P("incentive_guarantee_target", "band", "Weekly guarantee: the Fed tops incentives up to (0 = the sum of the budgets)", 0, Object.assign({ max: BUDGET_TOTAL_MAX, suffix: "PAT/week" }, NEXT));
P("guarantee_scaled", "band", "Weekly guarantee target scales with the week's gated pad-payout participants", false, Object.assign({ kind: "bool", unit: "bool" }, NEXT));
P("guarantee_base", "band", "Scaled guarantee: base target (at the reference participation)", 25000000, Object.assign({ min: 1, max: BUDGET_TOTAL_MAX, suffix: "PAT/week" }, NEXT));
P("guarantee_min", "band", "Scaled guarantee: lowest target", 15000000, Object.assign({ min: 1, max: BUDGET_TOTAL_MAX, suffix: "PAT/week" }, NEXT));
P("guarantee_max", "band", "Scaled guarantee: highest target", 40000000, Object.assign({ min: 1, max: BUDGET_TOTAL_MAX, suffix: "PAT/week" }, NEXT));
P("guarantee_smooth_weeks", "band", "Scaled guarantee: smoothing (mean of the last N weekly targets)", 3, Object.assign({ min: 1, max: 8, unit: "count", suffix: "weeks" }, NEXT));
P("guarantee_ref_weeks", "band", "Scaled guarantee: reference = median of the first N weeks of payouts", 4, Object.assign({ min: 1, max: 12, unit: "count", suffix: "weeks" }, NEXT));
P("issuance_to_guarantee", "issuance", "Issuance reaches players: the week's guarantee target grows by the issuance minted since the last epoch (and so does the activity group's budget)", true, Object.assign({ kind: "bool", unit: "bool" }, NEXT));
P("activity_rewards", "issuance", "Daily activity rewards to the day's active players (paid from the incentive budget's 'activity' group)", false, Object.assign({ kind: "bool", unit: "bool" }, NEXT));
P("issuance_mode", "issuance", "Organic issuance", "off", Object.assign({ kind: "enum", choices: ["off", "pct", "fixed"], unit: "enum" }, NEXT));
P("issuance_pct_month", "issuance", "Issuance: % of total supply per month", 1.0, Object.assign({ max: 10, kind: "pct", unit: "pct", suffix: "%/month" }, NEXT));
P("issuance_fixed_month", "issuance", "Issuance: PAT per month", 10000000, Object.assign({ max: 1000000000, suffix: "PAT/month" }, NEXT));
P("issuance_activity_scaling", "issuance", "Issuance scales 0.5x-1.5x with today's active players", true, Object.assign({ kind: "bool", unit: "bool" }, NEXT));
for (const [src, label, dflt] of [["issuance", "organic issuance", UNLIMITED], ["floor", "Fed floor mints", 30000000], ["loan", "loans / flash liquidity", UNLIMITED],
                                  ["restore", "archived-account restores", UNLIMITED], ["total", "all capped sources", UNLIMITED]]) {
  P("mintcap_" + src, "mintcaps", "Monthly mint cap: " + label, dflt, { kind: "cap", suffix: "PAT/month", engine_input: true });
}
for (const [v, label] of [["bank", "Bank (player loans)"], ["house", "House (payouts)"], ["mm", "Market maker (seeds, payouts)"]]) {
  P("flash_" + v, "flash", "Fed flash liquidity: " + label, true, { kind: "bool", unit: "bool" });
}
P("grant_weekly_cap", "grants", "Staff PAT grants: weekly cap (paid from incentives)", UNLIMITED, { kind: "cap", suffix: "PAT/week" });
P("donation_rate", "donation", "Donations: PAT minted per $1", 500000, { min: 1, max: 1000000000, suffix: "PAT/$" });
P("donation_bonus_pct", "donation", "Donations: extra % minted into incentives", 20.0, { max: 100, kind: "pct", unit: "pct", suffix: "%" });
P("staker_share_pct", "waterfall", "Waterfall: stakers' share of the surplus", 20.0, Object.assign({ max: 100, kind: "pct", unit: "pct", suffix: "%" }, NEXT));
P("fed_split_pct", "waterfall", "Waterfall: the Fed's share of the rest while below its target", 50.0, Object.assign({ max: 100, kind: "pct", unit: "pct", suffix: "%" }, NEXT));
// D-8: the site's default is prod's (0 = no cap; Pepe's code default is 25)
P("wf_staker_cap_pct", "waterfall", "Waterfall: stakers' bonus cap (APR on staked value, 0 = no cap)", 0.0, Object.assign({ max: 100, kind: "pct", unit: "pct", suffix: "% APR" }, NEXT));
P("room_vault_cap", "waterfall", "Pad vault cap (overflow -> Fort Knox)", 50000000);
const ECON_KEYS = ORDER.slice();          // the 69 econ_cfg keys, Pepe's order

// the economy sink rates (frida-bot SINK_RATES rows; Pepe clamps a panel value into [0, max] and keeps it as a float)
const K = (key, section, label, dflt, o = {}) => add(key, Object.assign({ section, label, default: dflt, sink: key }, o));
const FR = (max, o = {}) => Object.assign({ kind: "num", unit: "fraction", min: 0, max }, o);
// D-8: no daily ceiling by default (prod runs 0 since 2026-10-19; Pepe's code default is 0.25)
K("vault_ceil_apr", "staking", "Vaults: daily ceiling on stakers' share-price gains (APR, 0 = off)", 0.0, FR(5.0, NEXT));
K("vault_ceil_cushion", "staking", "Vaults: protocol cushion on losing days", false, Object.assign({ kind: "bool", unit: "bool" }, NEXT));
K("vault_ceil_cushion_days", "staking", "Vaults: protocol cushion window", 8, Object.assign({ kind: "num", unit: "days", suffix: "days", max: 30 }, NEXT));
K("vault_auto_staker_cap", "staking", "Vaults: Auto deposits obey the staker limit", false, { kind: "bool", unit: "bool" });
K("vault_floor_apr", "staking", "Vaults: stakers' yield floor (APR; only with the Reserve top-up on)", 0.0, FR(1.0, NEXT));
K("vault_topup", "staking", "Vaults: Reserve top-up to the floor (0 = off, 1 = on)", 0, Object.assign({ max: 1, unit: "count" }, NEXT));
K("vault_topup_max", "staking", "Vaults: max Reserve top-up per vault per day", 25000, Object.assign({ max: 10000000 }, NEXT));
K("vault_staker_max", "staking", "Vaults: most of a vault stakers may own", 0.5, FR(1.0));
K("auto_bank_min", "staking", "Auto: Bank at least (share of the Auto mix)", 0.40, FR(1.0));
K("auto_house_max", "staking", "Auto: House at most (share of the Auto mix)", 0.35, FR(1.0));
K("auto_mm_max", "staking", "Auto: Market maker at most (share of the Auto mix)", 0.25, FR(1.0));
K("vault_target_mult", "staking", "Vaults: Bank / Market maker target (x lent out / committed)", 1.5, Object.assign({ kind: "num", unit: "mult", suffix: "x", max: 10 }, NEXT));
K("bank_default_days", "bank", "Bank: days late before a loan defaults", 30, { max: 365, unit: "days", suffix: "days" });
K("bank_insurance", "bank", "Bank: Reserve insurance per 30 days", 50000000, { max: 1000000000 });
K("rloan_enabled", "loans", "Reserve loans: on (1) / off (0)", 1, { max: 1, unit: "count" });
K("rloan_rate_week", "loans", "Reserve loans: interest per week", 0.03, FR(1.0));
K("rloan_base", "loans", "Reserve loans: base instant limit", 10000, { max: 10000000 });
K("rloan_per_level", "loans", "Reserve loans: instant limit per level", 2000, { max: 1000000 });
K("rloan_max_auto", "loans", "Reserve loans: biggest instant loan", 250000, { max: 100000000 });
K("rloan_max_days", "loans", "Reserve loans: longest term", 30, { max: 365, unit: "days", suffix: "days" });
K("rloan_book", "loans", "Reserve loans: most of the Reserve lent out at once", 0.25, FR(1.0, { aliases: ["rloan_book_share"] }));
K("fee_wager_pct", "fees", "Fee: wager (% of the pot)", 5, { max: 50, unit: "pct", suffix: "%" });
K("fee_market_pct", "fees", "Fee: prediction market (% of the losing pool)", 5, { max: 50, unit: "pct", suffix: "%" });
K("fee_loan_penalty_pct", "fees", "Fee: loan late penalty (% per day)", 2, { max: 20, unit: "pct", suffix: "%/day" });
K("heist_vault_share", "casino_vault", "Casino vault: share of House revenue that refills it", 0.15, FR(1.0, { applies: "next_period" }));
K("vault_dividend", "legacy", "Vaults (v1): protocol dividend to the Reserve (0/1) - read while the treasury is off", 1, { max: 1, unit: "count", readonly: true });
K("vault_house_target", "legacy", "Vaults (v1): House target size", 20000000, { readonly: true });
K("vault_bank_min_target", "legacy", "Vaults (v1): Bank minimum target", 5000000, { max: 1000000000, readonly: true });
const SINK_KEYS = ["vault_ceil_apr", "vault_ceil_cushion", "vault_ceil_cushion_days", "vault_auto_staker_cap", "vault_floor_apr", "vault_topup", "vault_topup_max",
                   "vault_staker_max", "vault_house_min", "auto_bank_min", "auto_house_max", "auto_mm_max", "vault_target_mult", "vault_mm_min_target",
                   "bank_default_days", "bank_insurance", "rloan_enabled", "rloan_rate_week", "rloan_base", "rloan_per_level", "rloan_max_auto",
                   "rloan_max_days", "rloan_book", "fee_wager_pct", "fee_market_pct", "fee_loan_penalty_pct", "heist_vault_share", "heist_vault_cap",
                   "heist_vault_min", "vault_dividend", "vault_house_target", "vault_bank_min_target"];   // = pepe_econcfg.ECON_SINK_KEYS

// burn (pepe_burn BURN_DEFAULTS / _clean_burn_cfg): stored under burn_<field>
const BURN_FIELDS = { mode: "burn_mode", per_burn_max: "burn_per_burn_max", daily_max: "burn_daily_max", accrual_every_min: "burn_accrual_every_min",
                      announce: "burn_announce", announce_gap_min: "burn_announce_gap_min", announce_min: "burn_announce_min" };
const B = (key, label, dflt, o) => add(key, Object.assign({ section: "burn", label, default: dflt, engine_input: true }, o));
B("burn_mode", "Burn reserve mode (accrual: burns what it holds at the next tick; batch: an owner burns by hand)", "accrual", { kind: "enum", choices: ["accrual", "batch"], unit: "enum" });
B("burn_per_burn_max", "Burn: most per burn", 5000000, {});
B("burn_daily_max", "Burn: most per day", 20000000, {});
B("burn_accrual_every_min", "Burn: accrual burns at most every", 5, { min: 1, max: 1440, unit: "minutes", suffix: "min" });
B("burn_announce", "Burn: announce burns in chat", true, { kind: "bool", unit: "bool", engine_input: false });
B("burn_announce_gap_min", "Burn: at most one announcement every", 15, { max: 1440, unit: "minutes", suffix: "min", engine_input: false });
B("burn_announce_min", "Burn: announce burns of at least", 1000, { engine_input: false });

// flags (pepe_policyinputs.flags)
const FLAG_KEYS = { layers: "econ_layers", tr_live: "econ_treasury", ap_on: "econ_activity_pads" };
add("layers", { section: "flags", label: "Economy layers (Fed, Fort Knox, the incentive budget)", default: false, kind: "bool", unit: "bool", engine_input: true, aliases: ["econ_layers"] });
add("tr_live", { section: "flags", label: "Treasury (the Monday waterfall + the daily release)", default: false, kind: "bool", unit: "bool", engine_input: true, aliases: ["econ_treasury"] });
add("ap_on", { section: "flags", label: "Activity -> pad vaults", default: false, kind: "bool", unit: "bool", engine_input: true, aliases: ["econ_activity_pads"] });

// routing (D-19): Pepe's pat_routes overrides {flow: [[dest, pct], ...]} - a flow not in it uses its catalog default
add("pat_routes", { section: "routing", label: "PAT Routing (overrides; a flow not listed uses its default)", default: {}, kind: "routes", unit: "routes", max: null, min: null });

// system (read-only: a deploy migration changes them)
add("epoch_hour", { section: "system", label: "The policy periods' cut-off hour (UTC)", default: 4, max: 23, unit: "count", suffix: "h UTC", readonly: true, engine_input: true });
add("vault_min_move", { section: "system", label: "Vaults: smallest move", default: 1000, readonly: true, engine_input: true });
add("skip", { section: "system", label: "Logins left out of participation", default: [], kind: "list", unit: "list", readonly: true, engine_input: true, min: null, max: null });
add("tz", { section: "system", label: "The participation day's time zone", default: "America/New_York", kind: "str", unit: "text", readonly: true, engine_input: true, min: null, max: null });

const KEYS = ORDER.slice();
const ALIAS = Object.create(null);
for (const k of KEYS) for (const a of SPEC[k].aliases) ALIAS[a] = k;
const SECTIONS = [["treasury", "Treasury targets"], ["fedloans", "Fed loans"], ["vaults", "Vault floors and caps"], ["budgets", "Weekly budgets and pacing"],
                  ["band", "Fed band and guarantee"], ["issuance", "Issuance"], ["mintcaps", "Mint caps"], ["flash", "Flash liquidity"], ["grants", "Grants"],
                  ["donation", "Donations"], ["waterfall", "Waterfall"], ["staking", "Staking and vaults"], ["bank", "Bank"], ["loans", "Reserve loans"],
                  ["fees", "Fees"], ["casino_vault", "Casino vault"], ["burn", "Burn"], ["flags", "Flags"], ["routing", "PAT Routing"],
                  ["system", "System (read-only)"], ["legacy", "Legacy v1 (read-only)"]];
// pepe_econcfg.PAIRS: floor <= target / floor <= cap (the whole config)
const PAIRS = [["house_hard_floor", "house_target"], ["bank_hard_floor", "bank_target"], ["mm_hard_floor", "mm_target"], ["fortknox_floor", "fortknox_cap"],
               ["casino_floor", "casino_cap"], ["fed_floor", "fed_ceiling"], ["guarantee_min", "guarantee_base"], ["guarantee_base", "guarantee_max"]];

/** The canonical key for an input name (an alias, or a different case when `lower`), or null. */
function resolveKey(name, { lower = false } = {}) {
  const k = lower ? String(name || "").trim().toLowerCase() : String(name || "");
  if (SPEC[k]) return k;
  return ALIAS[k] || null;
}
const defaultOf = (k) => { const d = SPEC[k].default; return d && typeof d === "object" ? JSON.parse(JSON.stringify(d)) : d; };
function defaults() { const o = {}; for (const k of KEYS) o[k] = defaultOf(k); return o; }

// ── parsing (pepe_econcfg.parse_amount / parse_value) ──
function parseAmount(v) {
  if (typeof v === "boolean") return null;
  if (isNum(v)) return Number.isInteger(v) ? v : null;
  if (v === null || v === undefined || typeof v === "object") return null;
  let s = String(v || "").trim().toLowerCase().replace(/,/g, "").replace(/_/g, "");
  let mult = 1;
  if (s.endsWith("m")) { mult = 1000000; s = s.slice(0, -1); } else if (s.endsWith("k")) { mult = 1000; s = s.slice(0, -1); }
  const f0 = pyFloatStr(s);
  if (f0 === undefined) return null;
  const f = f0 * mult;
  if (f !== f || Math.abs(f) > 1e15) return null;
  const n = pyRoundN(f, 0) || 0;
  return Math.abs(f - n) < 1e-6 ? n : null;
}
const UNLIMITED_WORDS = ["unlimited", "none", "inf", "infinite", "nocap", "no-cap", "∞"];
const ON_WORDS = ["on", "true", "yes", "1", "enabled"], OFF_WORDS = ["off", "false", "no", "0", "disabled"];
/** parse_value(sp, v): one key's typed value from text / JSON, or null (Pepe's kinds; the site's num / list / str / routes). */
function parseValue(sp, v) {
  const kind = sp.kind;
  if (kind === "int") return parseAmount(v);
  if (kind === "cap") {
    if (typeof v === "boolean" || v === null || v === undefined) return null;
    if (typeof v === "string" && UNLIMITED_WORDS.includes(v.trim().toLowerCase())) return UNLIMITED;
    if (isNum(v) && v < 0) return v === UNLIMITED ? UNLIMITED : null;
    if (typeof v === "string" && v.trim() === "-1") return UNLIMITED;
    return parseAmount(v);
  }
  if (kind === "bool") {
    if (typeof v === "boolean") return v;
    if (isInt(v) && (v === 0 || v === 1)) return v === 1;
    if (v !== null && v !== undefined && typeof v === "object") return null;
    const t = pyStr(v === null || v === undefined ? "" : v).trim().toLowerCase();
    if (ON_WORDS.includes(t)) return true;
    if (OFF_WORDS.includes(t)) return false;
    return null;
  }
  if (kind === "enum") {
    if (v !== null && v !== undefined && typeof v === "object") return null;
    const t = pyStr(v === null || v === undefined ? "" : v).trim().toLowerCase();
    return (sp.choices || []).includes(t) ? t : null;
  }
  if (kind === "pct") {
    if (typeof v === "boolean" || v === null || v === undefined || typeof v === "object") return null;
    let f;
    if (isNum(v)) f = v;
    else { f = pyFloatStr(String(v).trim().replace(/%+$/, "")); if (f === undefined) return null; }
    if (f !== f || Math.abs(f) > 1e9) return null;
    return pyRoundN(f, 2) || 0;
  }
  if (kind === "num") {
    if (typeof v === "boolean" || v === null || v === undefined || typeof v === "object") return null;
    const f = isNum(v) ? v : pyFloatStr(String(v));
    if (f === undefined || !Number.isFinite(f)) return null;
    return f || 0;
  }
  if (kind === "list") return Array.isArray(v) && v.every((x) => typeof x === "string") ? v.map(String) : null;
  if (kind === "str") return typeof v === "string" ? v : null;
  if (kind === "routes") return cleanRoutesShape(v);
  return null;
}
/** The input form a key takes from a person (D-7): a FRACTION key's value comes as a percent - from chat it must spell the % ("25%"
 *  -> 0.25; a bare "25" is refused: "add %"), from the web field it is a %-labelled number (25 -> 0.25). Every other key parses as
 *  Pepe does. -> {ok, value} | {ok: false, error}. via: chat | web | raw (a stored value: mirror, import, migration). */
function parseInput(key, v, { via = "raw" } = {}) {
  const sp = SPEC[key];
  if (sp.unit === "fraction" && via !== "raw") {
    let pctNum;
    if (via === "chat") {
      const t = typeof v === "string" ? v.trim() : isNum(v) ? String(v) : "";
      if (!/%\s*$/.test(t)) return { ok: false, error: `${key}: '${pyStr(v)}' needs a % (it is a percentage - e.g. ${key} 25%) - add %` };
      pctNum = pyFloatStr(t.replace(/%+\s*$/, "").trim());
    } else {
      pctNum = isNum(v) ? v : typeof v === "string" ? pyFloatStr(v.trim().replace(/%+$/, "")) : undefined;
    }
    if (pctNum === undefined || !Number.isFinite(pctNum)) return { ok: false, error: `${key}: '${pyStr(v)}' isn't a percentage` };
    return { ok: true, value: pyRoundN(pctNum / 100, 10) || 0 };
  }
  const n = parseValue(sp, v);
  if (n === null) return { ok: false, error: `${key}: '${pyStr(v)}' isn't ` + KIND_WORD(sp) };
  return { ok: true, value: n };
}
const KIND_WORD = (sp) => ({ int: "a whole number", cap: "a whole number or unlimited", bool: "on or off", pct: "a percentage",
                             enum: "one of " + (sp.choices || []).join("|"), num: "a number", list: "a list of logins", str: "text",
                             routes: "a routing table" })[sp.kind] || "valid";

// ── routing tables (the shape; pepe_routes._clean_routes' catalog rules in checkRoutes) ──
function cleanRoutesShape(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const out = {};
  for (const [flow, shares] of Object.entries(x)) {
    if (!/^[A-Za-z0-9_:.-]{1,64}$/.test(flow) || !Array.isArray(shares)) return null;
    const list = [];
    for (const s of shares) {
      if (!Array.isArray(s) || s.length !== 2 || typeof s[0] !== "string" || !isNum(Number(s[1])) || !Number.isFinite(Number(s[1]))) return null;
      list.push([String(s[0]).slice(0, 80), Number(s[1])]);
    }
    out[flow] = list;
  }
  return out;
}
const MAX_SHARES = 3;
const VAULT_DESTS = ["jackpot", "reserve", "stakers", "heist", "fortknox", "incentives", "mm", "bank"];
const TREASURY_DESTS = ["mm", "bank"];
const HOLD_FLOWS = ["room_owner_hold"];
const INCENTIVE_INCOME_FLOWS = ["auto_escrow_expired"];
const WEBSITE_INCENTIVE_FLOWS = ["levelup", "new_account", "connect_bonus", "redeem_codes", "platform_rewards", "achievements", "room_owner"];
/** pepe_routes._clean_routes as far as Pepe's pushed catalog ({routes: {flow: {vault_only, readonly, payout, room, website?, rv?}},
 *  dests: [[dest, label]]}) tells: known flow, not read-only, at most 3 shares, 0 < pct <= 100 (two decimals), total <= 100,
 *  destinations the flow may use. -> [errors]. No catalog: the shape only. */
function checkRoutes(routes, catalog) {
  const errs = [];
  const flows = catalog && catalog.routes && typeof catalog.routes === "object" ? catalog.routes : null;
  const dests = catalog && Array.isArray(catalog.dests) ? new Set(catalog.dests.map((d) => String((d || [])[0]))) : null;
  for (const [flow, shares] of Object.entries(routes || {})) {
    const meta = flows ? flows[flow] : {};
    if (!meta) { errs.push(`pat_routes: unknown flow '${flow}'`); continue; }
    if (meta.readonly) { errs.push(`pat_routes: ${flow} is read-only`); continue; }
    if (shares.length > MAX_SHARES) { errs.push(`pat_routes: ${flow} has more than ${MAX_SHARES} shares`); continue; }
    let total = 0;
    for (const [dest, pct0] of shares) {
      const pct = pyRoundN(pct0, 2);
      if (pct <= 0) continue;
      const vaultOnly = meta.vault_only || meta.payout;
      const roomFlow = !!(meta.room || meta.rv || meta.room_flow);
      const bad = (dests && !dests.has(dest)) || (vaultOnly && !VAULT_DESTS.includes(dest)) || (meta.payout && dest === "stakers")
        || (TREASURY_DESTS.includes(dest) && (meta.payout || HOLD_FLOWS.includes(flow))) || (dest === "room_owner" && !meta.room) || pct > 100
        || (dest === "room" && !roomFlow)
        || (dest === "incentives" && !meta.payout && !HOLD_FLOWS.includes(flow) && !INCENTIVE_INCOME_FLOWS.includes(flow))
        || (dest === "fortknox" && meta.website) || (dest === "incentives" && meta.website && !WEBSITE_INCENTIVE_FLOWS.includes(flow));
      if (bad) { errs.push(`pat_routes: ${flow} can't send ${pyG(pct)}% to ${dest}`); break; }
      total += pct;
    }
    if (total > 100.0001) errs.push(`pat_routes: ${flow} adds up to ${pyG(total)}% (at most 100)`);
  }
  return errs;
}

// ── checking (pepe_econcfg.valid_value / validate) ──
function validValue(sp, v) {
  const kind = sp.kind;
  if (kind === "int" || kind === "cap") {
    if (!isInt(v)) return false;
    return (kind === "cap" && v === UNLIMITED) || (sp.min <= v && v <= sp.max);
  }
  if (kind === "bool") return typeof v === "boolean";
  if (kind === "enum") return (sp.choices || []).includes(v);
  if (kind === "pct" || kind === "num") return isNum(v) && Number.isFinite(v) && sp.min <= v && v <= sp.max;
  if (kind === "list") return Array.isArray(v) && v.every((x) => typeof x === "string");
  if (kind === "str") return typeof v === "string";
  if (kind === "routes") return cleanRoutesShape(v) !== null;
  return false;
}
function keyError(k, sp, v) {
  const kind = sp.kind;
  if (kind === "int" || kind === "cap") {
    if (!isInt(v)) return `${k} must be a whole number` + (kind === "cap" ? " or unlimited" : "");
    return `${k} must be ${fmtInt(sp.min)}..${fmtInt(sp.max)}` + (kind === "cap" ? " or unlimited" : "") + ` (got ${fmtInt(v)})`;
  }
  const want = { bool: "on or off", enum: (sp.choices || []).join(" | "), pct: `a % from ${pyG(sp.min)} to ${pyG(sp.max)}`,
                 num: sp.unit === "fraction" ? `${pyG(sp.min * 100)}%..${pyG(sp.max * 100)}%` : `a number from ${pyG(sp.min)} to ${pyG(sp.max)}`,
                 list: "a list of logins", str: "text", routes: "a routing table" }[kind] || "valid";
  const got = kind === "pct" && isNum(v) ? pyFloatRepr(v) : pyReprAny(v === undefined ? null : v);
  return `${k} must be ${want} (got ${got})`;
}
/** A full config -> [errors] ([] = fine). Every key in bounds first (Pepe's keys in his order, then the site's); then
 *  pepe_econcfg's cross-checks (floor <= target / cap, the weekly budgets' total, the guarantee target); then the routing table
 *  against Pepe's catalog (when one is given). */
function validate(cfg, { catalog = null } = {}) {
  const errs = [];
  for (const k of KEYS) {
    const sp = SPEC[k];
    const v = cfg[k];
    if (!validValue(sp, v)) errs.push(keyError(k, sp, v));
  }
  if (errs.length) return errs;
  for (const [lo, hi] of PAIRS) if (cfg[lo] > cfg[hi]) errs.push(`${lo} (${fmtInt(cfg[lo])}) can't be above ${hi} (${fmtInt(cfg[hi])})`);
  const tot = GROUPS.reduce((t, g) => t + Math.max(0, cfg["budget_" + g]), 0);
  if (tot > BUDGET_TOTAL_MAX) errs.push(`the weekly budgets add up to ${fmtInt(tot)} - more than ${fmtInt(BUDGET_TOTAL_MAX)} a week`);
  const gt = cfg.incentive_guarantee_target || 0;
  if (gt && gt < tot) {
    errs.push(`incentive_guarantee_target (${fmtInt(gt)}) can't be below the weekly budgets' total (${fmtInt(tot)}) - ` +
              "raise it, lower a budget_<group>, or set it to 0 (= the budgets' total)");
  }
  if (catalog) errs.push(...checkRoutes(cfg.pat_routes, catalog));
  return errs;
}

// ── showing (pepe_econcfg.fmt_value; a fraction as %) ──
function fmtValue(sp, v) {
  const kind = sp.kind;
  if (kind === "cap") return Math.trunc(v) === UNLIMITED ? "unlimited" : fmtInt(v);
  if (kind === "bool") return v ? "on" : "off";
  if (kind === "enum") return String(v);
  if (kind === "pct") return pyG(v) + "%";
  if (kind === "num") {
    if (sp.unit === "fraction") return pyG(pyRoundN(Number(v) * 100, 8)) + "%";
    if (sp.unit === "mult") return pyG(v) + "x";
    return pyG(v);
  }
  if (kind === "list") return (v || []).join(", ") || "(none)";
  if (kind === "str") return String(v);
  if (kind === "routes") return Object.keys(v || {}).length + " override(s)";
  return fmtInt(v);
}
const same = (a, b) => {
  if (isNum(a) && isNum(b)) return a === b;
  if (a && b && typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
};

/**
 * pepe_econcfg._ec_change: changes = {key: value | null (null / "default" / "reset" = back to the default)}, all-or-nothing.
 * `cur` = the whole current config. -> {ok, msg, errs, diff: [[key, old, new]], next}. Messages are Pepe's, word for word.
 * opts.via: how values are read (parseInput: chat / web need the % for a fraction key; raw = as stored); opts.readonly: refuse
 * the read-only keys (system / legacy) - a person can't change them, a migration can; opts.catalog: check the routing table.
 */
function change(cur, changes, { via = "raw", readonly = false, catalog = null } = {}) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) {
    return { ok: false, msg: "nothing to change", errs: ["nothing to change"], diff: [] };
  }
  const nw = Object.assign({}, cur);
  const errs = [];
  for (const [k, v] of Object.entries(changes)) {
    if (!SPEC[k]) { errs.push(`unknown key '${k}'`); continue; }
    if (readonly && SPEC[k].readonly) { errs.push(`${k} is read-only (a deploy migration changes it)`); continue; }
    if (v === null || v === undefined || (typeof v === "string" && ["default", "reset"].includes(v.trim().toLowerCase()))) { nw[k] = defaultOf(k); continue; }
    if (SPEC[k].kind === "routes" && via !== "raw") {
      // a routing edit names the flows it changes ({flow: shares | null}); the others keep their overrides
      const part = v && typeof v === "object" && !Array.isArray(v) ? v : null;
      if (!part) { errs.push(`${k}: '${pyStr(v)}' isn't a routing table`); continue; }
      const next = Object.assign({}, cur[k] || {});
      let bad = false;
      for (const [flow, shares] of Object.entries(part)) {
        if (shares === null) { delete next[flow]; continue; }
        const one = cleanRoutesShape({ [flow]: shares });
        if (!one) { errs.push(`${k}: the shares for '${flow}' aren't [[destination, percent], ...]`); bad = true; break; }
        next[flow] = one[flow];
      }
      if (!bad) nw[k] = next;
      continue;
    }
    const p = parseInput(k, v, { via });
    if (!p.ok) { errs.push(p.error); continue; }
    nw[k] = p.value;
  }
  const all = errs.length ? errs : validate(nw, { catalog });
  if (all.length) return { ok: false, msg: "nothing changed: " + all.join("; "), errs: all, diff: [] };
  const diff = [];
  for (const k of KEYS) if (!same(nw[k], cur[k])) diff.push([k, cur[k], nw[k]]);
  if (!diff.length) return { ok: true, msg: "no change (already set)", errs: [], diff, next: nw };
  const what = diff.map(([k, o, n]) => `${k} ${o === undefined ? "(none)" : fmtValue(SPEC[k], o)} -> ${fmtValue(SPEC[k], n)}`).join(", ");
  return { ok: true, msg: "saved: " + what, errs: [], diff, next: nw };
}

// ── what each reader sees (the push's shape, from a site config) ──
// pepe_policyinputs.consts: the constant -> the site key it reads
const CONST_MAP = { VAULT_MIN_MOVE: "vault_min_move", VAULT_CEIL_APR: "vault_ceil_apr", VAULT_EPOCH_UTC_HOUR: "epoch_hour", HOUSE_MIN_CASH: "house_hard_floor",
                    VAULT_MM_MIN_TARGET: "mm_target", VAULT_TARGET_MULT: "vault_target_mult", HEIST_VAULT_MIN: "casino_floor", HEIST_VAULT_CAP: "casino_cap" };
const has = (c, k) => c && Object.prototype.hasOwnProperty.call(c, k) && c[k] !== undefined && c[k] !== null;
const int = (x) => Math.trunc(Number(x)) || 0;
const flt = (x) => Number(x) + 0;
const cushionDays = (d) => { const x = Number(d); return !Number.isFinite(x) || x < 0 ? 8 : Math.min(x, CUSHION_KEEP_DAYS); };
/** Pepe's _ec_all (every econ_cfg key) from a site config. Missing keys are left out. */
function econView(c) { const o = {}; for (const k of ECON_KEYS) if (has(c, k)) o[k] = c[k]; return o; }
function constsView(c) { const o = {}; for (const [n, k] of Object.entries(CONST_MAP)) if (has(c, k)) o[n] = c[k]; return o; }
function flagsView(c) { const o = {}; for (const k of Object.keys(FLAG_KEYS)) if (has(c, k)) o[k] = !!c[k]; return o; }
function burnView(c) { const o = {}; for (const [f, k] of Object.entries(BURN_FIELDS)) if (has(c, k)) o[f] = c[k]; return o; }
/** The capital cluster's push fields (pepe_capitalstore._cap_cfg) a site config decides - each as Pepe derives it there. */
const CAPITAL_MAP = {
  ceil_apr: [["vault_ceil_apr"], (c) => { const x = Number(c.vault_ceil_apr); return Number.isFinite(x) && x > 0 ? x : 0; }],   // _vault_ceil_apr
  ceil_cushion: [["vault_ceil_cushion"], (c) => (c.vault_ceil_cushion ? 1 : 0)],
  ceil_cushion_days: [["vault_ceil_cushion_days"], (c) => cushionDays(c.vault_ceil_cushion_days)],
  auto_staker_cap: [["vault_auto_staker_cap"], (c) => (c.vault_auto_staker_cap ? 1 : 0)],
  floor_apr: [["vault_floor_apr"], (c) => flt(c.vault_floor_apr)],
  topup: [["vault_topup"], (c) => int(c.vault_topup)],
  topup_max_day: [["vault_topup_max"], (c) => int(c.vault_topup_max)],
  staker_max: [["vault_staker_max"], (c) => flt(c.vault_staker_max)],
  house_min_cash: [["house_hard_floor"], (c) => int(c.house_hard_floor)],
  auto_bank_min: [["auto_bank_min"], (c) => flt(c.auto_bank_min)],
  auto_house_max: [["auto_house_max"], (c) => flt(c.auto_house_max)],
  auto_mm_max: [["auto_mm_max"], (c) => flt(c.auto_mm_max)],
  bank_default_days: [["bank_default_days"], (c) => int(c.bank_default_days)],
  bank_insurance_cap: [["bank_insurance"], (c) => int(c.bank_insurance)],
  rloan_enabled: [["rloan_enabled"], (c) => int(c.rloan_enabled)],
  rloan_rate_week: [["rloan_rate_week"], (c) => flt(c.rloan_rate_week)],
  rloan_base: [["rloan_base"], (c) => int(c.rloan_base)],
  rloan_per_level: [["rloan_per_level"], (c) => int(c.rloan_per_level)],
  rloan_max_auto: [["rloan_max_auto"], (c) => int(c.rloan_max_auto)],
  rloan_max_days: [["rloan_max_days"], (c) => int(c.rloan_max_days)],
  rloan_book_share: [["rloan_book"], (c) => flt(c.rloan_book)],
  penalty_pct: [["fee_loan_penalty_pct"], (c) => int(c.fee_loan_penalty_pct)],
  dividend: [["vault_dividend"], (c) => int(c.vault_dividend)],
  epoch_hour: [["epoch_hour"], (c) => int(c.epoch_hour)],
  min_move: [["vault_min_move"], (c) => int(c.vault_min_move)],
  // round(_tr_staker_cap() x 100, 4): _share clamps the percent's fraction into [0, 1]
  wf_staker_cap_pct: [["wf_staker_cap_pct"], (c) => pyRoundN(Math.max(0, Math.min(1, flt(c.wf_staker_cap_pct) / 100)) * 100, 4)],
  layers: [["layers"], (c) => !!c.layers],
  tr_live: [["tr_live"], (c) => !!c.tr_live],
  "flash.bank": [["layers", "flash_bank"], (c) => !!(c.layers && c.flash_bank)],          // _mo_flash_on: the layers AND the switch
  "flash.mm": [["layers", "flash_mm"], (c) => !!(c.layers && c.flash_mm)],
  "heist_settings.share": [["heist_vault_share"], (c) => flt(c.heist_vault_share)],
  "heist_settings.cap": [["casino_cap"], (c) => int(c.casino_cap)],
  "heist_settings.min": [["casino_floor"], (c) => int(c.casino_floor)],
};
/** {field: value} of the capital fields (dotted for nested ones) a site config has every input for; `only` limits the fields. */
function capitalView(c, only = null) {
  const o = {};
  for (const [f, [needs, fn]] of Object.entries(CAPITAL_MAP)) {
    if (only && !only.includes(f)) continue;
    if (needs.every((k) => has(c, k))) o[f] = fn(c);
  }
  return o;
}
// the consumers' fields (plan PO-2 "consumer dual read")
const CUTOFF_FIELDS = ["ceil_apr", "ceil_cushion", "ceil_cushion_days", "auto_staker_cap", "staker_max", "house_min_cash", "floor_apr", "topup", "topup_max_day",
                       "dividend", "tr_live", "layers"];
const RESERVE_FIELDS = ["rloan_enabled", "rloan_rate_week", "rloan_base", "rloan_per_level", "rloan_max_auto", "rloan_max_days", "rloan_book_share", "penalty_pct",
                        "bank_default_days", "bank_insurance_cap", "layers", "flash.bank"];
/** funding.js's monetary block (pepe_monetary._mo_site_state) - its CONFIG fields (the Fed loan room, the budget week and the Fed's
 *  balance are derived state: they stay Pepe's until PO-4); null while the layers are off (Pepe sends none then). */
function monetaryView(c) {
  if (!has(c, "layers")) return undefined;
  if (!c.layers) return null;
  const o = {};
  const put = (f, keys, fn) => { if (keys.every((k) => has(c, k))) o[f] = fn(); };
  put("flash.house", ["flash_house"], () => !!c.flash_house);
  put("flash.bank", ["flash_bank"], () => !!c.flash_bank);
  put("flash.mm", ["flash_mm"], () => !!c.flash_mm);
  put("house_hard_floor", ["house_hard_floor"], () => int(c.house_hard_floor));
  put("donation.rate", ["donation_rate"], () => int(c.donation_rate));
  put("donation.bonus_pct", ["donation_bonus_pct"], () => flt(c.donation_bonus_pct));
  put("grant_weekly_cap", ["grant_weekly_cap"], () => int(c.grant_weekly_cap));
  put("band.floor", ["fed_floor"], () => int(c.fed_floor));
  put("band.ceiling", ["fed_ceiling"], () => int(c.fed_ceiling));
  return o;
}
/** Read a dotted field ("flash.bank") from an object. */
function getPath(o, f) {
  let x = o;
  for (const p of String(f).split(".")) { if (!x || typeof x !== "object") return undefined; x = x[p]; }
  return x;
}
function setPath(o, f, v) {
  const parts = String(f).split(".");
  let x = o;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!x[parts[i]] || typeof x[parts[i]] !== "object") x[parts[i]] = {};
    x = x[parts[i]];
  }
  x[parts[parts.length - 1]] = v;
}
/** Are a pushed value and the site's the same (numbers to 1e-9 relative; lists / objects by content)? */
function equalish(a, b) {
  if (isNum(a) && isNum(b)) return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equalish(x, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && equalish(a[k], b[k]));
  }
  return a === b;
}

/** Canonical JSON (sorted keys) - the config's sha. */
function canon(v) {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return JSON.stringify(v === undefined ? null : v);
}

module.exports = { SPEC, KEYS, ECON_KEYS, SINK_KEYS, ALIAS, SECTIONS, PAIRS, GROUPS, BURN_FIELDS, FLAG_KEYS, CONST_MAP, CAPITAL_MAP, CUTOFF_FIELDS, RESERVE_FIELDS,
                   AMOUNT_MAX, UNLIMITED, BUDGET_MAX, BUDGET_TOTAL_MAX, resolveKey, defaults, defaultOf, parseAmount, parseValue, parseInput, validValue, validate,
                   keyError, checkRoutes, cleanRoutesShape, fmtValue, change, econView, constsView, flagsView, burnView, capitalView, monetaryView, getPath, setPath,
                   equalish, canon, fmtInt, pyG, pyFloatRepr, pyStr, pyFloatStr };
