// Credit score (1.99bg, credit.js): the same factor math as Pepe's pepe_credit.py (shared vectors with
// camfrog-bot/credit_test.py), bands, explanations, the loans-sync cleaning, and the wallet's lookup.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "credit-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const credit = require(path.join(repo, "credit"));
const wallet = require(path.join(repo, "wallet"));

const H = (o) => Object.assign({ on_time: 0, late_repaid: 0, defaults: 0, late_now: 0, collections: 0, open_debt: 0, open_loans: 0, forgiven: 0 }, o || {});
const score = (h, lv, age) => credit.creditScore(null, H(h), lv, age);
const pts = (cs, key) => (cs.factors.find((f) => f.key === key) || {}).points;

test("factor math matches Pepe's (shared vectors)", () => {
  assert.strictEqual(score({}, 0, null).score, 600);
  assert.strictEqual(score({}, 0, null).band, "Fair");
  assert.ok(score({}, 0, null).thin);
  assert.strictEqual(score({}, 1, 0).score, 583);
  const a = score({ on_time: 3 }, 12, 200);
  assert.strictEqual(a.score, 721);
  assert.strictEqual(a.band, "Good");
  assert.strictEqual(a.factors[0].key, "on_time");
  assert.strictEqual(score({ on_time: 20 }).factors[0].points, 160);
  assert.strictEqual(score({ late_repaid: 9 }).factors[0].points, -150);
  const d = score({ defaults: 1, late_repaid: 1, collections: 1 }, 4, 40);
  assert.strictEqual(d.score, 462);
  assert.strictEqual(d.band, "Poor");
  assert.strictEqual(score({ defaults: 5, late_now: 4, collections: 9, open_debt: 1e7, open_loans: 4 }, 0, 1).score, 300);
  const top = score({ on_time: 10 }, 40, 900);
  assert.strictEqual(top.score, 850);
  assert.strictEqual(top.band, "Excellent");
});

test("debt load, account age, level", () => {
  for (const [debt, lv, p] of [[0, 5, 20], [10000, 5, 10], [20000, 5, 0], [40000, 5, -30], [40001, 5, -60], [20000, 0, -30], [25000, 0, -60]]) {
    assert.strictEqual(pts(score({ open_debt: debt, open_loans: debt ? 1 : 0 }, lv), "debt"), p, `debt ${debt} Lv ${lv}`);
  }
  for (const [age, p] of [[0, -20], [6, -20], [7, 0], [29, 0], [30, 10], [89, 10], [90, 25], [364, 25], [365, 40]]) {
    assert.strictEqual(pts(score({}, 0, age), "age"), p, `age ${age}`);
  }
  assert.strictEqual(pts(score({}, 0, null), "age"), undefined);
  assert.strictEqual(pts(score({}, 50), "level"), 60);
});

test("bands and labels", () => {
  for (const [s, b] of [[850, "Excellent"], [800, "Excellent"], [799, "Very good"], [740, "Very good"], [739, "Good"], [670, "Good"],
    [669, "Fair"], [580, "Fair"], [579, "Poor"], [300, "Poor"]]) assert.strictEqual(credit.band(s), b);
  const a = score({ on_time: 3, open_debt: 30000, open_loans: 1 }, 5, 1);
  assert.deepStrictEqual(a.factors.map((f) => f.label), ["3 loans repaid on time", "owes PAT 30,000 (1.5x their level capacity of 20,000)",
    "account 1 day old", "level 5"]);
});

test("synced weights are cleaned; Pepe's weights drive the score", () => {
  const w = credit.cleanWeights({ base: 600, on_time: "x", debt: [[1, 5]], bands: "nope", age: [[1, 2, 3]] });
  assert.strictEqual(w.base, 600);
  assert.strictEqual(w.on_time, 20);                     // malformed -> default
  assert.deepStrictEqual(w.debt, [[1, 5]]);
  assert.strictEqual(w.bands, credit.DEFAULT_W.bands);
  assert.strictEqual(w.age, credit.DEFAULT_W.age);
  assert.strictEqual(credit.creditScore({ base: 600 }, H(), 0, null).score, 620);
});

test("loans sync keeps per-borrower history + weights; forCamfrog applies level and age", () => {
  const snap = wallet.cleanLoans({
    loans: [], requests: [{ id: 3, nick: "Dave", amount: 500000, term: 604800, status: "pending", credit: 640, credit_band: "Fair" }],
    reserve: { base: 10000, per_level: 2000, max_auto: 250000, room: 1e6, enabled: true, credit: { base: 580, capacity_base: 10000, capacity_per_level: 2000 },
      limits: { alice: { repaid: 3, lates: 0, open: 0, late: false, credit: { on_time: 3, junk: 9, open_debt: -5 } } } },
  });
  assert.deepStrictEqual(snap.reserve.limits.alice.credit, H({ on_time: 3 }));
  assert.strictEqual(snap.requests[0].credit, 640);
  assert.strictEqual(snap.requests[0].credit_band, "Fair");
  const created = new Date(Date.now() - 200 * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const cs = credit.forCamfrog(snap.reserve, "Alice", { level: 12, created_at: created });
  assert.strictEqual(cs.score, 721);
  // someone with no history: a thin file
  assert.strictEqual(credit.forCamfrog(snap.reserve, "nobody", { level: 0, created_at: null }).score, 600);
  assert.strictEqual(credit.ageDays("2026-10-01 00:00:00", Date.parse("2026-10-06T12:00:00Z")), 5);
  assert.strictEqual(credit.ageDays(null), null);
  // the limit is unchanged by the score
  assert.strictEqual(wallet.reserveLimit(snap.reserve, "alice", 12).limit, 59500);
});
