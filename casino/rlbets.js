// Single-zero roulette positions and grammar, shared by the site and the chip controls.
(function (root, factory) {
  if (typeof module === "object" && module.exports)
    module.exports = factory(function () {
      return require("../public/js/patamount");
    });
  else
    root.PATVRlBets = factory(function () {
      return root.PATVAmount;
    });
})(typeof self !== "undefined" ? self : this, function (getAmount) {
  "use strict";
  var red = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  var positions = Object.create(null),
    aliases = Object.create(null);
  function range(first, last) {
    var out = [];
    for (var n = first; n <= last; n++) out.push(n);
    return out;
  }
  function add(kind, nums, name) {
    var token = name || nums.join("-");
    positions[token] = Object.freeze({
      kind: kind,
      nums: Object.freeze(nums),
      odds: 36 / nums.length - 1,
      token: token,
    });
    return token;
  }
  var numbers = range(1, 36),
    row,
    col,
    n,
    start;
  for (n = 0; n <= 36; n++) add("straight", [n]);
  for (n = 1; n <= 36; n++) {
    if (n <= 33) add("split", [n, n + 3]);
    if (n % 3 !== 0) add("split", [n, n + 1]);
    if (n <= 32 && n % 3 !== 0) add("corner", [n, n + 1, n + 3, n + 4]);
  }
  for (n = 1; n <= 3; n++) add("split", [0, n]);
  add("trio", [0, 1, 2]);
  add("trio", [0, 2, 3]);
  add("first_four", [0, 1, 2, 3]);
  for (row = 0; row < 12; row++) {
    start = row * 3 + 1;
    var street = add("street", range(start, start + 2));
    var line = row < 11 ? add("line", range(start, start + 5)) : null;
    for (n = start; n < start + 3; n++) {
      aliases["st" + n] = street;
      if (line) aliases["ln" + n] = line;
    }
  }
  for (col = 1; col <= 3; col++) {
    var dozen = add("dozen", range(12 * (col - 1) + 1, 12 * col), "d" + col);
    aliases[["1st12", "2nd12", "3rd12"][col - 1]] = dozen;
    aliases[12 * (col - 1) + 1 + "-" + 12 * col] = dozen;
    aliases["col" + col] = add(
      "column",
      numbers.filter(function (i) {
        return ((i - 1) % 3) + 1 === col;
      }),
      "c" + col,
    );
  }
  add("red", red, "red");
  add(
    "black",
    numbers.filter(function (i) {
      return red.indexOf(i) < 0;
    }),
    "black",
  );
  add(
    "even",
    numbers.filter(function (i) {
      return i % 2 === 0;
    }),
    "even",
  );
  add(
    "odd",
    numbers.filter(function (i) {
      return i % 2 !== 0;
    }),
    "odd",
  );
  add("low", range(1, 18), "low");
  add("high", range(19, 36), "high");
  aliases["1-18"] = "low";
  aliases["19-36"] = "high";
  aliases["🔴"] = "red";
  aliases["⚫"] = "black";
  function token(bet) {
    if (bet.token && positions[bet.token]) return bet.token;
    if (["dozen", "column"].indexOf(bet.kind) >= 0)
      return bet.kind === "dozen" ? "d" + (Math.floor((bet.nums[0] - 1) / 12) + 1) : "c" + bet.nums[0];
    if (positions[bet.kind]) return bet.kind;
    return bet.nums.join("-");
  }
  function lookup(raw) {
    if (positions[aliases[raw] || raw]) return positions[aliases[raw] || raw];
    if (!/^(?:0|[1-9]\d?)(?:-(?:0|[1-9]\d?)){1,5}$/.test(raw)) return null;
    return (
      positions[
        raw
          .split("-")
          .map(Number)
          .sort(function (a, b) {
            return a - b;
          })
          .join("-")
      ] || null
    );
  }
  function refusal(error, hint) {
    return { ok: false, error: error, hint: hint };
  }
  function parse(text, options) {
    options = options || {};
    var cap = options.maxPairs === 20 ? 20 : 6,
      minimum = options.minBet == null ? 100 : options.minBet;
    var normalized = String(text || "")
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[–—/]/g, "-");
    if (!normalized || (cap === 6 && normalized.length > 160) || normalized.length > 800)
      return refusal("Bet line is empty or too long.", "Use a bet followed by its amount.");
    var parts = normalized.split(/\s+/),
      merged = Object.create(null),
      bets = [];
    if (parts.length > 2 * cap)
      return refusal("Too many bets in one line.", "Use up to " + cap + " bet and amount pairs.");
    for (var i = 0; i < parts.length; i += 2) {
      var word = parts[i],
        amountWord = parts[i + 1];
      var choices = word.indexOf(",") < 0 ? [word] : word.split(",");
      if (
        choices.length > 8 ||
        (choices.length > 1 &&
          !choices.every(function (v) {
            return /^(?:0|[1-9]\d?)$/.test(v) && Number(v) <= 36;
          }))
      )
        return refusal("Invalid list: " + word, "Use 2 to 8 numbers from 0 to 36.");
      for (var j = 0; j < choices.length; j++) {
        var spot = lookup(choices[j]);
        if (!spot) {
          if (/(^|-)00($|-)/.test(word)) return refusal("This wheel has a single zero.", "Use 0.");
          if (getAmount().parse(word) > 36 && amountWord && lookup(amountWord))
            return refusal("The bet comes first.", amountWord + " " + word);
          var first = Number(word.split("-")[0]);
          if (word.indexOf("-") >= 0 && Number.isInteger(first) && first >= 0 && first <= 36) {
            var splits = Object.keys(positions).filter(function (k) {
              var p = positions[k];
              return p.kind === "split" && p.nums.indexOf(first) >= 0;
            });
            return refusal(
              "Invalid combination: " + word,
              "Splits on " + first + ": " + splits.join(", ") + ".",
            );
          }
          return refusal(
            "Unknown bet: " + word,
            "Try a number, split, street, corner, line, dozen, column, red, black, odd, even, low or high.",
          );
        }
        if (amountWord == null) return refusal("How much on " + word + "?", word + " " + minimum);
        var amount = getAmount().parse(amountWord);
        if (!Number.isSafeInteger(amount) || amount < minimum) {
          var split = lookup(word + "-" + amountWord);
          return refusal(
            "The minimum is " + minimum + " whole PAT per position.",
            split && split.kind === "split"
              ? "For the split, " + split.token + " " + minimum + "."
              : word + " " + minimum,
          );
        }
        if (!merged[spot.token]) {
          merged[spot.token] = {
            kind: spot.kind,
            nums: spot.nums,
            odds: spot.odds,
            amount: 0,
            token: spot.token,
          };
          bets.push(merged[spot.token]);
        }
        if (!Number.isSafeInteger(merged[spot.token].amount + amount))
          return refusal("Amount too large.", "Try a smaller amount.");
        merged[spot.token].amount += amount;
      }
    }
    return { ok: true, bets: bets };
  }
  return { parse: parse, token: token, positions: Object.freeze(positions), red: Object.freeze(red) };
});
