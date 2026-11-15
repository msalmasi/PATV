// Single-zero roulette arithmetic. All amounts are whole PAT.
"use strict";
const { positions, red: RED } = require("./rlbets");
const WHEEL = Object.freeze([
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22,
  18, 29, 7, 28, 12, 35, 3, 26,
]);
function color(n) {
  return n === 0 ? "green" : RED.includes(n) ? "red" : "black";
}
function returnOf(bet, stake, pocket) {
  return bet.nums.includes(pocket) ? stake * (bet.odds + 1) : 0;
}
function lossVector(lines) {
  const L = Array(37).fill(0);
  let total = 0;
  for (const line of lines)
    for (const bet of line.bets) {
      total += bet.amount;
      for (const p of bet.nums) L[p] += (bet.odds + 1) * bet.amount;
    }
  return L.map((value) => value - total);
}
function worst(L) {
  return Math.max(...L);
}
function maxMore(L, bet, cap) {
  return Math.max(0, Math.floor(Math.min(...bet.nums.map((p) => cap - L[p])) / bet.odds));
}
function removeOk(L, lines, cap) {
  const removed = lossVector(Array.isArray(lines) ? lines : [lines]);
  return worst(L.map((value, i) => value - removed[i])) <= Math.max(cap, worst(L));
}
function settle(lines, pocket) {
  const result = Object.create(null);
  for (const { uid, bets } of lines) {
    const rec = result[uid] || (result[uid] = { staked: 0, returned: 0, net: 0, wins: 0 });
    for (const bet of bets) {
      const returned = returnOf(bet, bet.amount, pocket);
      rec.staked += bet.amount;
      rec.returned += returned;
      rec.net += returned - bet.amount;
      if (returned) rec.wins++;
    }
  }
  return result;
}
module.exports = { WHEEL, RED, positions, color, returnOf, lossVector, worst, maxMore, removeOk, settle };
