// PO-4 (economy policy -> site plan, "Phase 6"): the site's derived state, weekly staking audit / digest and /staking records replay
// Pepe's REAL Python (camfrog-bot tools/gen_derived_vectors.py -> test/fixtures/policy-derived-vectors.json.gz, byte-identical with
// the bot's ci/fixtures/ copy; its sha256 pinned here AND in camfrog-bot derived_vectors_test.py), 0 differences:
//   A derived  policy/derived.js derive: the vault targets (v2 while the treasury is live, else the v1 rule), fl_room, credit, the
//              flows since the last cut-off, the bank lent / peak, the treasury targets with force
//   B p31      policy/digest.js p31Base (pepe_treasury._tr_conservation_base, the pools on the site)
//   C audit    policy/digest.js auditRecord / auditNotice / digestOf (pepe_treasury._tr_audit / _tr_digest)
//   D public   capital/vaults.js publicRecord (pepe_treasury._tr_public_records) + engines.trackOf = Pepe's _tr_track
// Numbers compare by value, object keys unordered, arrays ordered - but the audit's "stash X ... holds no stake there" group (a
// Python set) compares as a multiset. Coverage asserts keep the fixture honest.
//   PEPE_BOT_DIR=<camfrog-bot checkout> also compares the bot's copy byte for byte.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-derived-vectors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const repo = path.resolve(__dirname, "..");
const E = require(path.join(repo, "policy", "engines"));
const D = require(path.join(repo, "policy", "derived"));
const DG = require(path.join(repo, "policy", "digest"));
const V = require(path.join(repo, "capital", "vaults"));

const FIX = path.join(__dirname, "fixtures", "policy-derived-vectors.json.gz");
// Update together with camfrog-bot's copy (ci/fixtures/policy-derived-vectors.json.gz) and its pin (derived_vectors_test.py PIN):
// python tools/gen_derived_vectors.py ci/fixtures/policy-derived-vectors.json.gz prints the new sha.
const PIN = "29d133747e2f1e2d772fcf1d9063daed7b4b9aa863f913ac916d7d35a22e7e43";
const RAW = fs.readFileSync(FIX);
const data = JSON.parse(zlib.gunzipSync(RAW).toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

/** Deep equality, numbers by value, object keys unordered, arrays ordered. */
function same(a, b, where, diffs) {
  if (typeof a === "number" && typeof b === "number") { if (a !== b) diffs.push(`${where}: ${a} !== ${b}`); return; }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { if (a !== b) diffs.push(`${where}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); return; }
  if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(`${where}: array vs object`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${where}: length ${a.length} !== ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) same(a[i], b[i], `${where}[${i}]`, diffs);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) same(a[k], b[k], `${where}.${k}`, diffs);
}
const NO_STAKE = / but holds no stake there$/;
/** The problems with each run of the set-order group sorted (Python iterates set(paid) - set(st) in hash order). */
function canonProblems(list) {
  const out = [];
  let run = [];
  for (const p of list) {
    if (NO_STAKE.test(p)) { run.push(p); continue; }
    if (run.length) { out.push(...run.sort()); run = []; }
    out.push(p);
  }
  if (run.length) out.push(...run.sort());
  return out;
}

test("the fixture is the pinned version, byte-identical with the bot's copy", () => {
  assert.equal(sha(RAW), PIN, "regenerate + re-pin BOTH repos after a change (camfrog-bot tools/gen_derived_vectors.py)");
  assert.equal(RAW[0], 0x1f, "gzip");
  assert.equal(RAW.readUInt32LE(4), 0, "gzip mtime 0");
  const bot = process.env.PEPE_BOT_DIR;
  if (bot) {
    const p = path.join(bot, "ci", "fixtures", "policy-derived-vectors.json.gz");
    assert.ok(fs.existsSync(p), `the bot's copy at ${p}`);
    assert.equal(sha(fs.readFileSync(p)), PIN, "the bot's copy is byte-identical");
  }
  assert.equal(data.tz, "America/New_York");
  assert.deepEqual(D.CREDIT_W, data.credit_w, "CREDIT_W = Pepe's pepe_credit.CREDIT_W");
  assert.deepEqual(D.VAULT_NAMES, data.consts.VAULT_NAMES);
  assert.deepEqual(DG.TR_WEEKLY_POOLS, data.consts.TR_WEEKLY_POOLS);
  assert.deepEqual(DG.TR_DAILY_POOLS, data.consts.TR_DAILY_POOLS);
  assert.equal(D.FEDLOAN_CAP, data.consts.FEDLOAN_CAP);
  assert.deepEqual(DG.TR_VAULT_LABEL, data.consts.TR_VAULT_LABEL);
});

test("A derived: targets, fl_room, credit, flows, bank lent / peak = Pepe's (pepe_vaults / pepe_monetary / pepe_credit)", () => {
  const bad = [];
  const cov = { above: 0, v1: 0, zero: 0, edge: 0, flows: 0, skip: 0, dst: 0 };
  for (const [i, c] of data.derived.entries()) {
    const inp = c.inputs, x = c.expected;
    const got = D.derive(inp);
    const diffs = [];
    same(got.targets, x.targets, `case ${i} targets`, diffs);
    same(got.fl_room, x.fl_room, `case ${i} fl_room`, diffs);
    same(got.flash_room, x.fl_room, `case ${i} flash_room`, diffs);
    same(got.credit, x.credit, `case ${i} credit`, diffs);
    same(got.flows, x.flows, `case ${i} flows`, diffs);
    same(got.diag.bank_lent, x.diag.bank_lent, `case ${i} bank_lent`, diffs);
    same(got.diag.bank_peak, x.diag.bank_peak, `case ${i} bank_peak`, diffs);
    same(got.diag.tr_live, x.diag.tr_live, `case ${i} tr_live`, diffs);
    for (const v of D.VAULT_NAMES) same(E.target(inp, E.C(inp), v, inp.now), x.diag.tr_target[v], `case ${i} tr_target(force).${v}`, diffs);
    if (diffs.length) bad.push(diffs.slice(0, 6).join("\n"));
    const c0 = E.C(inp);
    if (got.diag.tr_live && x.targets.bank > c0.int("bank_target", 2000000)) cov.above++;
    if (!got.diag.tr_live) cov.v1++;
    if (x.fl_room === 0) cov.zero++;
    const cut = inp.now - c0.int("bank_peak_days", 30) * 86400;
    cov.edge += (inp.bank_lent || []).filter(([t]) => Math.abs(Number(t) - cut) <= 1).length;
    if (Object.keys(x.flows).length) cov.flows++;
    if (Object.values(inp.ledger.days).some((d) => Object.values(d).some((v) => v && typeof v === "object"
        && Object.values(v).some((s) => s && Object.keys(s).some((w) => w.startsWith("vault ")))))) cov.skip++;
    if (["2026-11-01", "2027-03-14"].includes(D.localDate(inp.since, inp.tz))) cov.dst++;
  }
  assert.equal(bad.length, 0, `${bad.length} of ${data.derived.length} derived cases differ:\n${bad.slice(0, 5).join("\n---\n")}`);
  assert.ok(cov.above >= 150, `bank target above bank_target: ${cov.above}`);
  assert.ok(cov.v1 >= 100, `the v1 rule: ${cov.v1}`);
  assert.ok(cov.zero >= 50, `fl_room clamped at 0: ${cov.zero}`);
  assert.ok(cov.edge >= 30, `samples on the cutoff edge: ${cov.edge}`);
  assert.ok(cov.flows >= 200 && cov.skip >= 20 && cov.dst >= 20, `flows ${cov.flows}, 'vault ' skips ${cov.skip}, DST day0s ${cov.dst}`);
});

test("A derived: the raw book gives the inputs' bank NAV and seeds (Pepe's loan / market filters)", () => {
  let n = 0;
  for (const c of data.derived) {
    let out = 0;
    for (const ln of c.raw.loans) {
      if (ln.funded_by === "bank" && ["funding", "active"].includes(ln.status) && !ln.insured && !ln.written_off) out += Math.max(0, Math.trunc(ln.principal) - Math.trunc(ln.paid || 0));
    }
    assert.equal(c.inputs.pools.bank + out, c.inputs.bank_nav);
    let seeds = 0;
    for (const m of c.raw.markets) if (m.seed_from === "mm" && m.model === "lmsr" && ["open", "closed", "settling"].includes(m.status) && !m.paid_out) seeds += Math.trunc(m.seed || 0);
    assert.equal(seeds, c.inputs.mm_seeds);
    n += c.raw.loans.length + c.raw.markets.length;
  }
  assert.ok(n > 500, `${n} loans + markets`);
});

test("B p31: the conservation base (House + the pools the legs touch + the stash legs that landed) = Pepe's", () => {
  const bad = [];
  for (const [i, c] of data.p31.entries()) {
    const got = DG.p31Base(c.inputs.balances, c.inputs.rec, c.inputs.pools);
    if (got !== c.expected) bad.push(`case ${i}: ${got} !== ${c.expected}`);
  }
  assert.equal(bad.length, 0, bad.slice(0, 5).join("\n"));
  assert.ok(data.p31.some((c) => c.inputs.pools && c.inputs.pools.includes("fortknox")) && data.p31.some((c) => !c.inputs.pools));
});

test("C audit: the audit, the admins' notice and the digest = Pepe's _tr_audit / _tr_digest", () => {
  const bad = [];
  const kinds = { never_landed: /never landed/, refused: /refused by the site/, legs_vs_surplus: /: the legs move /, legs_vs_plan: /the stakers' legs paid/,
                  over_cap: /more than min\(/, per_stash: /its share is/, no_stake: NO_STAKE, took: /to land \(/, no_notice: /got no payout notice/ };
  const cov = Object.fromEntries(Object.keys(kinds).map((k) => [k, 0]));
  let digests = 0, alines = 0, cut = 0, hot = 0, fb = 0, notices = 0;
  for (const [i, c] of data.audit.entries()) {
    const { rec, inputs, aline, now } = c.inputs;
    const x = c.expected;
    const a = DG.auditRecord(rec, { stakers: (v, p, b, lb, d) => E.stakers(inputs, v, p, b, lb, d), lastBoundary: E.lastBoundaryOf(inputs, rec.epoch), now });
    const diffs = [];
    same(canonProblems(a.problems), canonProblems(x.audit.problems), `case ${i} problems`, diffs);
    same(a.info, x.audit.info, `case ${i} info`, diffs);
    same(a.bind, x.audit.bind, `case ${i} bind`, diffs);
    const n = DG.auditNotice(rec.epoch, a.problems);
    if (!x.notice) { if (n) diffs.push(`case ${i}: a notice Pepe didn't send`); } else {
      notices++;
      if (!n) diffs.push(`case ${i}: no notice`); else {
        if (n.title !== x.notice.title) diffs.push(`case ${i} notice title: ${n.title} !== ${x.notice.title}`);
        if (n.text !== x.notice.text && !DG.matchAudit(rec.epoch, a.problems, { title: x.notice.title, body: x.notice.text })) diffs.push(`case ${i} notice text:\n${n.text}\n${x.notice.text}`);
        assert.equal(x.notice.kind, "admin"); assert.equal(x.notice.link, "/admin/economy"); assert.equal(x.notice.ref, `wf-audit:${rec.epoch}`);
      }
    }
    const dg = DG.digestOf(rec, aline);
    if (!x.digest) { if (dg) diffs.push(`case ${i}: a digest Pepe didn't send`); } else {
      digests++;
      if (aline) alines++;
      if (DG.cpLen(x.digest.text) >= 590 || (aline && x.digest.text.includes("…" + aline))) cut++;
      if (x.digest.text.includes("⚠ the payout alone")) hot++;
      if (x.digest.text.includes(" Capped at ")) fb++;
      if (!dg) diffs.push(`case ${i}: no digest`); else {
        if (dg.title !== x.digest.title) diffs.push(`case ${i} digest title: ${dg.title} !== ${x.digest.title}`);
        if (dg.text !== x.digest.text) diffs.push(`case ${i} digest text:\n${dg.text}\n${x.digest.text}`);
        assert.equal(x.digest.ref, `wf-digest:${rec.epoch}`);
        // matchDigest: Pepe's body (with his aline) against the site's rendering (whose own aline is "")
        assert.ok(DG.matchDigest((al) => DG.digestOf(rec, al), DG.storedBody(x.digest.text)), `case ${i}: matchDigest`);
      }
    }
    if (diffs.length) bad.push(diffs.slice(0, 6).join("\n"));
    for (const [k, re] of Object.entries(kinds)) if (x.audit.problems.some((p) => re.test(p))) cov[k]++;
  }
  assert.equal(bad.length, 0, `${bad.length} of ${data.audit.length} audit cases differ:\n${bad.slice(0, 4).join("\n---\n")}`);
  for (const [k, n] of Object.entries(cov)) assert.ok(n >= 10, `problem kind ${k}: ${n} case(s)`);
  assert.ok(notices >= 50, `notices ${notices}`);
  assert.ok(digests >= 100 && alines >= 20 && cut >= 10 && hot >= 1 && fb >= 1, `digests ${digests}, with an aline ${alines}, cut ${cut}, hot ${hot}, fallback ${fb}`);
});

test("D public: the /staking records = Pepe's _tr_public_records; engines.trackOf = his _tr_track", () => {
  const bad = [];
  let checks = 0;
  for (const [i, c] of data.public.entries()) {
    const recs = c.inputs.records.slice().sort((a, b) => Number(a.plan.boundary || 0) - Number(b.plan.boundary || 0)).slice(-8);
    const got = recs.map((r) => V.publicRecord(r.plan, r.track, r.done === undefined ? null : r.done, r.state));
    const diffs = [];
    same(got, c.expected, `case ${i}`, diffs);
    const tc = c.inputs.track_check;
    if (tc) { checks++; same(E.trackOf(tc.inputs, tc.plan), tc.track, `case ${i} trackOf`, diffs); }
    if (diffs.length) bad.push(diffs.slice(0, 6).join("\n"));
  }
  assert.equal(bad.length, 0, `${bad.length} of ${data.public.length} public cases differ:\n${bad.slice(0, 4).join("\n---\n")}`);
  assert.ok(checks >= 100, `trackOf checks ${checks}`);
  assert.ok(data.public.some((c) => c.inputs.records.length > 8), "a journal longer than the 8 kept");
});
