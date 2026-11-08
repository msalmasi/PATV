// h22 phase 2 (1.99??): the seating rules of a scheduled multi-table tournament (casino/mttseat.js) - pure; the blind planner proven on JSON
// copies of the REAL engine (casino/hmengine.js, unchanged): the seating draw, the start split, the blind plan (busts in every position,
// moves out, arrivals, heads-up), balancing, breaking and the final table condition. Vectors: test/fixtures/mtt-seat-vectors.json.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(require("os").tmpdir(), "casino-mtt-pure-")));     // (tourney.js loads the database module)
const SEAT = require(path.join(repo, "casino", "mttseat"));
const H = require(path.join(repo, "casino", "hmengine"));
const VEC = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "mtt-seat-vectors.json"), "utf8"));

const deck = () => { const d = []; for (const a of "23456789TJQKA") for (const b of "shdc") d.push(a + b); return d; };
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pickOne = (a) => a[Math.floor(rnd() * a.length)];

test("drawOrder: deterministic, independent of the input order, recomputable from the revealed seed (sha256(seed) = the commitment)", () => {
  const s = "ab".repeat(32);
  const ids = ["u3:1", "u1:1", "u2:2", "u9:1", "u4:1"];
  const a = SEAT.drawOrder(s, "start", ids);
  assert.deepEqual(SEAT.drawOrder(s, "start", ids.slice().reverse()), a, "the input order never matters (sorted first)");
  assert.deepEqual(SEAT.drawOrder(s, "start", ids), a);
  assert.notDeepEqual(SEAT.drawOrder(s, "final", ids), a, "another label, another draw");
  assert.deepEqual(a.slice().sort(), ids.slice().sort(), "a permutation");
  assert.equal(SEAT.commitOf(s), crypto.createHash("sha256").update(Buffer.from(s, "hex")).digest("hex"));
  for (const v of VEC.draws) assert.deepEqual(SEAT.drawOrder(v.seed, v.label, v.ids), v.order, `pinned draw ${v.label}`);
  // the algorithm, re-implemented here from the published description (a verifier would do the same)
  const verify = (seedHex, label, list) => {
    const arr = list.slice().sort();
    for (let i = arr.length - 1; i >= 1; i--) {
      const m = i + 1, lim = Math.floor(2 ** 48 / m) * m;
      let x = crypto.createHmac("sha256", Buffer.from(seedHex, "hex")).update(`${label}:${i}`).digest().readUIntBE(0, 6);
      for (let k = 1; x >= lim; k++) x = crypto.createHmac("sha256", Buffer.from(seedHex, "hex")).update(`${label}:${i}:${k}`).digest().readUIntBE(0, 6);
      const j = x % m;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  assert.deepEqual(verify(s, "start", ids), a);
});

test("drawOrder: unbiased - over 100,000 draws of 9 every position is as likely for each entrant (chi-square)", () => {
  const ids = Array.from({ length: 9 }, (_, i) => "p" + i);
  const s = "5a".repeat(32);
  const cnt = Array.from({ length: 9 }, () => new Array(9).fill(0));
  const N = 100000;
  for (let n = 0; n < N; n++) {
    const o = SEAT.drawOrder(s, "draw:" + n, ids);
    o.forEach((id, pos) => { cnt[Number(id.slice(1))][pos]++; });
  }
  for (let i = 0; i < 9; i++) {
    const exp = N / 9;
    const chi = cnt[i].reduce((t, c) => t + ((c - exp) ** 2) / exp, 0);
    assert.ok(chi < 26.12, `entrant ${i}: chi-square ${chi.toFixed(2)} (8 df, p = 0.001 bound 26.12)`);
  }
});

test("start seating: E = 2..500 at 6- and 9-handed - ceil(E/size) tables, counts within one, none above the size", () => {
  for (const size of [6, 9]) {
    for (let E = 2; E <= 500; E++) {
      const order = Array.from({ length: E }, (_, i) => "u" + i);
      const t = SEAT.startSplit(order, size);
      assert.equal(t.length, Math.ceil(E / size), `E=${E} size=${size}`);
      const c = t.map((x) => x.length);
      assert.ok(Math.max(...c) - Math.min(...c) <= 1 && Math.max(...c) <= size, `E=${E} size=${size}: ${c}`);
      assert.equal(c.reduce((a, b) => a + b, 0), E);
    }
  }
});

/** a table on the REAL engine: each hand applies the plan, deals (H.startHand), records who posted what, then ends at once */
function realTable(keys) {
  const t = H.newTable({ sb: 10, bb: 20 });
  for (const k of keys) H.sit(t, k, k, 1000);
  return { t, last: null, log: [] };
}
function deal(tab, arrivals) {
  const { t } = tab;
  const ring = H.seatedWithChips(t);
  const pl = SEAT.blindPlan(ring, tab.last, arrivals || []);
  for (const a of arrivals || []) H.sit(t, a, a, 1000);
  t.seats = pl.ring.concat(t.seats.filter((k) => !pl.ring.includes(k)));
  t.button = pl.fresh ? (tab.last ? t.button : null) : pl.button;
  const sb0 = t.sb;
  if (pl.deadSb) t.sb = 0;
  const ev = H.startHand(t, deck());
  t.sb = sb0;
  const sbEv = ev.find((x) => x.t === "blind" && x.kind === "SB");
  const rec = { button: t.button, sb_key: t.sb_key, bb_key: t.bb_key, order: t.players.slice(), dead: !!pl.deadSb, sbPaid: sbEv ? sbEv.amount : 0, arrivals: (arrivals || []).slice(), n: t.players.length };
  t.hand_active = false;
  tab.last = { bb_key: rec.bb_key, sb_key: rec.sb_key, order: rec.order, button: rec.button };
  tab.log.push(rec);
  return rec;
}
const out = (tab, k) => { tab.t.chips[k] = 0; H.stand(tab.t, k); };

test("blind plan - the probes: the big blind busts (the next seat posts it, no skip), the small blind busts, the button busts 3-handed (heads-up, no BB twice)", () => {
  // 6-max: A btn, B SB, C BB; C busts -> D is the next big blind (not E), B's small blind is dead (B posted it last hand)
  let tab = realTable(["A", "B", "C", "D", "E", "F"]);
  tab.t.button = "F";
  let h1 = deal(tab);
  assert.deepEqual([h1.button, h1.sb_key, h1.bb_key], ["A", "B", "C"]);
  out(tab, "C");
  let h2 = deal(tab);
  assert.equal(h2.bb_key, "D", "the big blind moves forward one seat: D, never a skip to E");
  assert.equal(h2.sb_key, "B");
  assert.ok(h2.dead && h2.sbPaid === 0, "B posted the small blind last hand - this one is dead (0)");
  let h3 = deal(tab);
  assert.equal(h3.bb_key, "E");
  assert.ok(!h3.dead);
  // B (the small blind) busts: C (the big blind) posts the small blind next, D the big blind
  tab = realTable(["A", "B", "C", "D", "E", "F"]);
  tab.t.button = "F";
  h1 = deal(tab);
  out(tab, "B");
  h2 = deal(tab);
  assert.deepEqual([h2.sb_key, h2.bb_key], ["C", "D"]);
  assert.ok(!h2.dead);
  // 3-handed, A (the button) busts: heads-up - B (last hand's SB) posts the big blind, C (last hand's BB) is the button / small blind
  tab = realTable(["A", "B", "C"]);
  tab.t.button = "C";
  h1 = deal(tab);
  assert.deepEqual([h1.button, h1.sb_key, h1.bb_key], ["A", "B", "C"]);
  out(tab, "A");
  h2 = deal(tab);
  assert.equal(h2.bb_key, "B", "never the big blind twice in a row heads-up");
  assert.equal(h2.sb_key, "C");
  assert.equal(h2.button, "C", "heads-up: the button posts the small blind");
  h3 = deal(tab);
  assert.equal(h3.bb_key, "C");
  for (const v of VEC.plans) assert.deepEqual(SEAT.blindPlan(v.ring, v.last, v.arrivals), v.plan, `pinned plan ${v.name}`);
});

test("blind plan - arrivals: the first arrival is the next big blind, the second the hand after; an arrival never posts the small blind first", () => {
  const tab = realTable(["A", "B", "C", "D"]);
  tab.t.button = "D";
  deal(tab);                                       // btn A, SB B, BB C
  const h = deal(tab, ["X", "Y"]);
  assert.equal(h.bb_key, "X");
  const h2 = deal(tab);
  assert.equal(h2.bb_key, "Y");
  const h3 = deal(tab);
  assert.equal(h3.bb_key, "D", "then the seat that was next (D)");
  assert.ok(![h.sb_key, h2.sb_key].includes("Y") && h.sb_key !== "X");
});

test("blind plan - property: random busts (BB / SB / button / elsewhere), moves out, 1-3 arrivals and heads-up, n = 2..9, dealt by the real engine", () => {
  let checked = 0;
  for (let run = 0; run < 400; run++) {
    const n0 = 2 + Math.floor(rnd() * 8);
    let next = 0;
    const fresh = () => "p" + (next++);
    const tab = realTable(Array.from({ length: n0 }, fresh));
    tab.t.button = tab.t.seats[tab.t.seats.length - 1];
    let prev = deal(tab), stable = [];
    for (let step = 0; step < 40; step++) {
      const ring = H.seatedWithChips(tab.t);
      let event = rnd();
      const arrivals = [];
      if (event < 0.18 && ring.length > 2) out(tab, prev.bb_key);
      else if (event < 0.30 && ring.length > 2) out(tab, prev.sb_key);
      else if (event < 0.40 && ring.length > 2) out(tab, prev.button);
      else if (event < 0.50 && ring.length > 2) out(tab, pickOne(ring));
      else if (event < 0.62 && ring.length < 7) { const m = 1 + Math.floor(rnd() * 3); for (let i = 0; i < m && ring.length + i < 9; i++) arrivals.push(fresh()); }
      else event = 1;
      const present = H.seatedWithChips(tab.t);
      const h = deal(tab, arrivals);
      checked++;
      // the big blind moves forward one seat (the first still here after last hand's BB), unless an arrival takes it
      const ord = prev.order, bi = ord.indexOf(prev.bb_key);
      let nbb = null;
      for (let o = 1; o <= ord.length && nbb === null; o++) { const k = ord[(bi + o) % ord.length]; if (present.includes(k)) nbb = k; }
      if (arrivals.length) {
        assert.equal(h.bb_key, arrivals[0], `run ${run}: the first arrival is the big blind`);
      } else if (h.n === 2) {
        if (present.includes(prev.bb_key)) assert.notEqual(h.bb_key, prev.bb_key, `run ${run}: heads-up, never the big blind twice in a row`);
        if (nbb !== null && nbb !== prev.bb_key) assert.equal(h.bb_key, nbb, `run ${run}: heads-up, the big blind still moves forward`);
      } else if (nbb !== null) {
        assert.equal(h.bb_key, nbb, `run ${run} step ${step}: the big blind moves forward one seat`);
      }
      if (arrivals.length) for (const a of arrivals) assert.notEqual(h.sb_key, a, "an arrival never posts the small blind first");
      // the small blind twice in a row only as a dead small blind (0)
      if (h.sb_key === prev.sb_key && h.n >= 3 && prev.n >= 3) assert.ok(h.dead && h.sbPaid === 0, `run ${run}: the SB twice in a row is dead`);
      if (h.dead) assert.equal(h.sbPaid, 0);
      // an orbit with nobody arriving / leaving: every player posts the big blind exactly once
      if (event === 1 && !arrivals.length && h.n >= 3) stable.push(h); else stable = [h];
      if (stable.length > h.n) {
        const win = stable.slice(-h.n).map((x) => x.bb_key);
        assert.equal(new Set(win).size, h.n, `run ${run}: one big blind each per orbit (${win})`);
      }
      prev = h;
      if (H.seatedWithChips(tab.t).length < 2) break;
    }
  }
  assert.ok(checked > 5000, `${checked} hands checked`);
});

test("upcoming big blinds = repeated plans on simulated hands; bbOrder starts at the next big blind", () => {
  const ring = ["A", "B", "C", "D", "E"];
  const last = { bb_key: "C", sb_key: "B", order: ring.slice(), button: "A" };
  assert.deepEqual(SEAT.upcomingBB(ring, last, 5), ["D", "E", "A", "B", "C"]);
  assert.deepEqual(SEAT.bbOrder(ring, last), ["D", "E", "A", "B", "C"]);
  assert.deepEqual(SEAT.bbOrder(["A", "B", "D", "E"], last), ["D", "E", "A", "B"], "C left: D is still next");
});

const tbl = (no, seated, o) => Object.assign({ no, state: "live", final: false, opened_level: null, seated, inbound: 0 }, o || {});

test("balancing: only a fullest table gives, only when the tables differ by 2+; the target is the shortest (ties: the lowest number); transit counts", () => {
  let lay = [tbl(1, 9), tbl(2, 7), tbl(3, 7)];
  assert.equal(SEAT.balanceTarget(lay, 1), 2, "9 vs 7: the fullest gives to the shortest, the lowest number on a tie");
  assert.equal(SEAT.balanceTarget(lay, 2), null, "not the fullest");
  lay = [tbl(1, 8), tbl(2, 7), tbl(3, 7)];
  assert.equal(SEAT.balanceTarget(lay, 1), null, "within one player");
  lay = [tbl(1, 9), tbl(2, 6, { inbound: 2 }), tbl(3, 7)];
  assert.equal(SEAT.balanceTarget(lay, 1), 3, "inbound transit counts as effective players (2: 8, 3: 7)");
  lay = [tbl(1, 9), tbl(2, 5, { state: "breaking" }), tbl(3, 7)];
  assert.equal(SEAT.balanceTarget(lay, 1), 3, "never a breaking table");
  lay = [tbl(1, 9), tbl(2, 5, { final: true }), tbl(3, 7)];
  assert.equal(SEAT.balanceTarget(lay, 1), 3, "never the final table");
  // the mover: the next big blind (engine-verified), never a player who just arrived
  const tab = realTable(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
  tab.t.button = "I";
  const h = deal(tab);
  const order = SEAT.bbOrder(H.seatedWithChips(tab.t), tab.last);
  const h2 = deal(tab);
  assert.equal(order[0], h2.bb_key, "the mover is who would be big blind next");
  void h;
});

test("breaking: the condition (slack while late registration is open, none after), the breaker (fewest, ties the highest number, not one opened < 2 levels ago while late reg is open), the assignment", () => {
  const lay = [tbl(1, 7), tbl(2, 6), tbl(3, 6)];
  assert.equal(SEAT.shouldBreak(19, lay, 9, 0), false, "19 > 2 x 9");
  assert.equal(SEAT.shouldBreak(18, lay, 9, 0), true);
  assert.equal(SEAT.shouldBreak(18, lay, 9, 3), false, "with the late-registration slack: 18 > 18 - 3");
  assert.equal(SEAT.shouldBreak(15, lay, 9, 3), true);
  assert.equal(SEAT.breaker(lay, { lateOpen: false, level: 5 }), 3, "fewest, ties the highest number");
  const lay2 = [tbl(1, 7), tbl(2, 6), tbl(3, 6, { opened_level: 4 })];
  assert.equal(SEAT.breaker(lay2, { lateOpen: true, level: 5 }), 2, "never a table opened in the last 2 levels while late reg is open");
  assert.equal(SEAT.breaker(lay2, { lateOpen: false, level: 5 }), 3, "after late reg closes the TDA rule applies unchanged");
  const plan = SEAT.assignBreak(["x1", "x2", "x3", "x4", "x5", "x6"], [tbl(1, 7), tbl(2, 6), tbl(3, 6, { state: "breaking" })], 3);
  assert.deepEqual(plan, [["x1", 2], ["x2", 1], ["x3", 2], ["x4", 1], ["x5", 2], ["x6", 1]], "each to the fewest, ties the lowest number");
  // late seating: the fewest (ties lowest); every candidate full -> a breaking table with room is un-marked; else a new table
  assert.deepEqual(SEAT.lateTarget([tbl(1, 8), tbl(2, 7), tbl(3, 7)], 9), { no: 2 });
  assert.deepEqual(SEAT.lateTarget([tbl(1, 9), tbl(2, 9), tbl(3, 6, { state: "breaking" })], 9), { unbreak: 3 });
  assert.deepEqual(SEAT.lateTarget([tbl(1, 9), tbl(2, 9)], 9), { open: true });
});

test("the final table: late registration closed, everyone fits one table, more than one live table", () => {
  assert.equal(SEAT.finalDue(false, 9, [tbl(1, 5), tbl(2, 4)], 9), true);
  assert.equal(SEAT.finalDue(true, 9, [tbl(1, 5), tbl(2, 4)], 9), false, "not while late registration is open");
  assert.equal(SEAT.finalDue(false, 10, [tbl(1, 5), tbl(2, 5)], 9), false);
  assert.equal(SEAT.finalDue(false, 6, [tbl(1, 6), tbl(2, 0, { state: "closed" })], 9), false, "one live table: final in place, not a new one");
});
