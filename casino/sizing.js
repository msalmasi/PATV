// Hold'em sizing grammar. Pure: amounts are raise-TO totals, never PAT transfers.
(function () {
  "use strict";
  const USAGE = "use min, all, pot, half, 75%, 3bb, +2bb, 2x or an amount (1k).";
  function parseSize(text, turn, bb, pot) {
    const s = String(text == null ? "" : text).trim().toLowerCase().replace(/,/g, "");
    if (!turn || ![turn.min_to, turn.max_to, turn.current_bet, turn.to_call, bb, pot].every(Number.isFinite) || bb <= 0 || turn.max_to < 0) return { error: USAGE };
    let to, m;
    if (s === "min") to = turn.min_to;
    else if (["max", "all", "allin"].includes(s)) to = turn.max_to;
    else if (s === "pot" || s === "half") to = turn.current_bet + Math.round((pot + turn.to_call) * (s === "half" ? 0.5 : 1));
    else if ((m = /^(\d+(?:\.\d+)?)%$/.exec(s))) to = turn.current_bet + Math.round((pot + turn.to_call) * Number(m[1]) / 100);
    else if ((m = /^(\+?)(\d+(?:\.\d+)?)bb$/.exec(s))) to = (m[1] ? turn.current_bet : 0) + Number(m[2]) * bb;
    else if ((m = /^(\d+(?:\.\d+)?)x$/.exec(s))) to = Number(m[1]) * turn.current_bet;
    else if ((m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s))) to = Math.trunc(Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1000000 : 1));
    else return { error: USAGE };
    if (!Number.isSafeInteger(Math.round(to))) return { error: USAGE };
    return { to: Math.max(Math.min(turn.min_to, turn.max_to), Math.min(turn.max_to, Math.round(to))) };
  }
  function presetTo(kind, turn, bb, pot) { return parseSize(kind, turn, bb, pot); }
  if (typeof module !== "undefined" && module.exports) module.exports = { parseSize, presetTo };
  else window.CZ.sizing = { parseSize, presetTo };
})();
