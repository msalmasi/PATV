// goldwheel.js — the gold (personal) wheel's daily spin limit, in one place (1.99fj).
//
//   limit = 100 + 25 x level + extra_daily_spins        per UTC day, no cap
//
// extra_daily_spins is what the shop's "+100 Daily Gold Spins" (spinboost100) adds, 100 a copy.
// The wheel is negative EV at every level and pot size, so more spins are a PAT sink, not a faucet.
// Used by the spin endpoint (enforcement), /api/u/:username/wheel/spins-left (the counter) and the
// /wheel rules text. The public wheel and Pepe's !spin cooldowns are separate and unchanged.
"use strict";

const GOLD_BASE = 100;
const GOLD_PER_LEVEL = 25;

function goldDailyLimit(level, extraDailySpins) {
  const lvl = Math.max(0, Math.floor(Number(level) || 0));
  const extra = Math.max(0, Math.floor(Number(extraDailySpins) || 0));
  return GOLD_BASE + GOLD_PER_LEVEL * lvl + extra;
}

module.exports = { GOLD_BASE, GOLD_PER_LEVEL, goldDailyLimit };
