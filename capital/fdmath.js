// capital/fdmath.js — exp() and log() that give the SAME double as Pepe's pepe_fdmath.py (FreeBSD msun / fdlibm).
//
// Math.exp / Math.log are whatever the engine ships (V8: an fdlibm port today, but nothing promises it), and Pepe's
// Python used the platform C library (Windows UCRT), which differs in the last bit about once in two hundred calls. The
// market maths must match to the bit across the cutover, so both sides run THIS algorithm, written out operation by
// operation with only IEEE +, -, *, / on doubles (identical in Python and JavaScript). Ported from FreeBSD e_exp.c / e_log.c.
"use strict";

const buf = new ArrayBuffer(8);
const f64 = new Float64Array(buf);
const i32 = new Int32Array(buf);          // little endian: [0] = low word, [1] = high word (signed)
const u32 = new Uint32Array(buf);
const words = (x) => { f64[0] = x; return [i32[1], u32[0]]; };
function fromWords(hi, lo) { i32[1] = hi | 0; u32[0] = lo >>> 0; return f64[0]; }

const E = 2.718281828459045;
const HUGE = 1.0e+300;
const TWOM1000 = 9.33263618503218878990e-302;
const O_THRESHOLD = 7.09782712893383973096e+02;
const U_THRESHOLD = -7.45133219101941108420e+02;
const LN2HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
const LN2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const HALF = [0.5, -0.5];
const INVLN2 = 1.44269504088896338700e+00;
const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03, P3 = 6.61375632143793436117e-05,
      P4 = -1.65339022054652515390e-06, P5 = 4.13813679705723846039e-08;
const TWO1023 = 8.98846567431158e+307;

function exp(x) {
  x = Number(x);
  let [hx, lx] = words(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0.0, lo = 0.0, k = 0;
  if (hx >= 0x40862E42) {
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | lx) !== 0) return x + x;
      return xsb === 0 ? x : 0.0;
    }
    if (x > O_THRESHOLD) return Infinity;
    if (x < U_THRESHOLD) return 0.0;
  }
  if (hx > 0x3fd62e42) {
    if (hx < 0x3FF0A2B2) {
      if (x === 1.0) return E;
      hi = x - LN2HI[xsb];
      lo = LN2LO[xsb];
      k = 1 - xsb - xsb;
    } else {
      k = Math.trunc(INVLN2 * x + HALF[xsb]);
      const t = k;
      hi = x - t * LN2HI[0];
      lo = t * LN2LO[0];
    }
    x = hi - lo;
  } else if (hx < 0x3e300000) {
    if (HUGE + x > 1.0) return 1.0 + x;
  } else {
    k = 0;
  }
  const t = x * x;
  const twopk = k >= -1021 ? fromWords(0x3ff00000 + (k << 20), 0) : fromWords(0x3ff00000 + ((k + 1000) << 20), 0);
  const c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
  if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
  const y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
  if (k >= -1021) {
    if (k === 1024) return y * 2.0 * TWO1023;
    return y * twopk;
  }
  return y * twopk * TWOM1000;
}

const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10, TWO54 = 1.80143985094819840000e+16;
const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01, LG4 = 2.222219843214978396e-01,
      LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;

function log(x) {
  x = Number(x);
  let [hx, lx] = words(x);
  let k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54;
    x *= TWO54;
    hx = words(x)[0];
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  const lw = words(x)[1];
  x = fromWords(hx | (i ^ 0x3ff00000), lw);
  k += (i >> 20);
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0.0) {
      if (k === 0) return 0.0;
      const dk = k;
      return dk * LN2_HI + dk * LN2_LO;
    }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    const dk = k;
    return dk * LN2_HI - ((R - dk * LN2_LO) - f);
  }
  const s = f / (2.0 + f);
  const dk = k;
  const z = s * s;
  i = hx - 0x6147a;
  const w = z * z;
  const j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * LN2_HI - ((hfsq - (s * (hfsq + R) + dk * LN2_LO)) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * LN2_HI - ((s * (f - R) - dk * LN2_LO) - f);
}

module.exports = { exp, log };
