// Helper for the PO-2 tests (not a test itself): Pepe's pushes as he builds them, consistent with each other.
//   policyPush(over)   POST /api/policy/bot/config's cfg: econ_cfg (pepe_econcfg._ec_all - Pepe's defaults from the vectors file),
//                      sink (pepe_econcfg._ec_sink_snapshot: floats), consts, flags, burn_cfg, skip, tz, his journals
//   capitalPush(over)  POST /api/capital/bot/config's cfg (pepe_capitalstore._cap_cfg)
//   routes / catalog   POST /api/econ/settings/put's pat_routes overrides + the routing catalog
//   monetary(over)     the funding sync's monetary block (pepe_monetary._mo_site_state)
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const V = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "policy-config-vectors.json.gz"))).toString("utf8"));
const M = 1000000;
const SINK = {
  vault_ceil_apr: 0.0, vault_ceil_cushion: 0.0, vault_ceil_cushion_days: 8.0, vault_auto_staker_cap: 0.0, vault_floor_apr: 0.0, vault_topup: 0.0,
  vault_topup_max: 25000.0, vault_staker_max: 0.5, vault_house_min: 5000000.0, auto_bank_min: 0.4, auto_house_max: 0.35, auto_mm_max: 0.25,
  vault_target_mult: 1.5, vault_mm_min_target: 1000000.0, bank_default_days: 30.0, bank_insurance: 10000000.0, rloan_enabled: 1.0, rloan_rate_week: 0.03,
  rloan_base: 10000.0, rloan_per_level: 2000.0, rloan_max_auto: 250000.0, rloan_max_days: 30.0, rloan_book: 0.25, fee_wager_pct: 5.0, fee_market_pct: 5.0,
  fee_loan_penalty_pct: 2.0, heist_vault_share: 0.15, heist_vault_cap: 10000000.0, heist_vault_min: 2000000.0, vault_dividend: 1.0,
  vault_house_target: 20000000.0, vault_bank_min_target: 5000000.0,
};
const CONSTS = { VAULT_MIN_MOVE: 1000, VAULT_CEIL_APR: 0.0, VAULT_EPOCH_UTC_HOUR: 4, HOUSE_MIN_CASH: 5000000.0, VAULT_MM_MIN_TARGET: 1000000.0,
                 VAULT_TARGET_MULT: 1.5, HEIST_VAULT_MIN: 2000000.0, HEIST_VAULT_CAP: 10000000.0 };
const BURN = { mode: "accrual", per_burn_max: 5000000, daily_max: 20000000, accrual_every_min: 5, announce: true, announce_gap_min: 15, announce_min: 1000 };
const clone = (x) => JSON.parse(JSON.stringify(x));
function policyPush(over = {}) {
  const p = { econ_cfg: clone(V.defaults), sink: clone(SINK), consts: clone(CONSTS), flags: { layers: true, tr_live: true, ap_on: false }, burn_cfg: clone(BURN),
              burn_inflight: 0, skip: ["bot", "drama1", "mod", "pepefrog", "playersbot", "room", "server", "someone", "you"], tz: "America/New_York",
              journal: [], days_done: [], mo_days_done: [], bot_version: "1.99adm" };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && p[k] && typeof p[k] === "object" && !Array.isArray(p[k])) p[k] = Object.assign(p[k], v);
    else p[k] = v;
  }
  return p;
}
function capitalPush(over = {}) {
  const c = {
    min_trade: 500, settle_grace: 604800, max_secs: 2592000, max_open: 5, loan_min: 1000, rloan_enabled: 1, rloan_rate_week: 0.03, rloan_base: 10000,
    rloan_per_level: 2000, rloan_max_auto: 250000, rloan_max_days: 30, rloan_book_share: 0.25, rloan_max_open: 1, penalty_pct: 2, penalty_cap_pct: 50,
    collect_every: 600, loan_max_borrowed: 5, vaults_enabled: 1, ceil_apr: 0.0, floor_apr: 0.0, topup: 0, topup_max_day: 25000, staker_max: 0.5,
    house_min_cash: 5000000, auto_bank_min: 0.4, auto_house_max: 0.35, auto_mm_max: 0.25, bank_default_days: 30, bank_insurance_cap: 10000000, min_move: 1000,
    epoch_hour: 4, dividend: 1, apr_min_cover: 0.9, ceil_cushion: 0, ceil_cushion_days: 8.0, auto_staker_cap: 0, layers: true, tr_live: true,
    targets: { house: 15 * M, bank: 2 * M, mm: 1 * M }, flash: { bank: true, mm: true, room: 3 * M }, fl_room: 3 * M,
    heist_settings: { share: 0.15, cap: 10 * M, min: 2 * M }, lotto_pot: 0, waterfall: [], wf_staker_cap_pct: 0.0,
  };
  return Object.assign(c, over);
}
const routes = () => ({ raffle: [["incentives", 100]], cmd_song: [["reserve", 80], ["room_owner", 10]] });
const catalog = () => ({
  routes: { raffle: { group: "Room games", label: "Raffle", default: [["incentives", 100]], vault_only: true, readonly: false, payout: true, room: false },
            cmd_song: { group: "Commands", label: "!song", default: [["reserve", 90], ["room_owner", 10]], vault_only: false, readonly: false, payout: false, room: true },
            wheel: { group: "Casino", label: "Wheel", default: [["jackpot", 100]], vault_only: true, readonly: true, payout: false, room: false },
            wager_fee: { group: "Casino", label: "Wager fee", default: [["jackpot", 100]], vault_only: true, readonly: false, payout: false, room: false } },
  dests: [["jackpot", "Casino jackpot"], ["reserve", "Fed"], ["fortknox", "Fort Knox"], ["incentives", "Incentives"], ["stakers", "Stakers"],
          ["heist", "Casino vault"], ["mm", "MM"], ["bank", "Bank"], ["room_owner", "Pad owner"], ["room", "Pad vault"]],
});
function monetary(over = {}) {
  return Object.assign({ flash: { house: true, bank: true, mm: true }, fedloan_room: 3 * M, house_hard_floor: 5 * M, donation: { rate: 500000, bonus_pct: 20.0 },
                         grant_weekly_cap: -1, week_start: 1760918400, band: { fed: 60 * M, floor: 25 * M, ceiling: 150 * M } }, over);
}

module.exports = { V, M, SINK, CONSTS, BURN, policyPush, capitalPush, routes, catalog, monetary, clone };
