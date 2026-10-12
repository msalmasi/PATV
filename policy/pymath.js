// policy/pymath.js — Python's number semantics the policy engines need, with no other dependency (policy/engines.js stays
// a pure module: no database, no site state). pyRoundN is capital/vaults.js's, the same code.
"use strict";

/** Python round(x, n): the exact value rounded half-even to n decimals, then the nearest double. */
function pyRoundN(x, n) {
  x = Number(x);
  if (!Number.isFinite(x) || x === 0) return x;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e2;
  if (exp === 0) e2 = -1074; else { mant |= 1n << 52n; e2 = exp - 1075; }
  let num = mant * 10n ** BigInt(n), den = 1n;
  if (e2 >= 0) num <<= BigInt(e2); else den <<= BigInt(-e2);
  let q = num / den;
  const r = num - q * den;
  if (2n * r > den || (2n * r === den && q % 2n === 1n)) q += 1n;
  return Number(`${sign < 0n ? "-" : ""}${q}e-${n}`);
}

module.exports = { pyRoundN };
