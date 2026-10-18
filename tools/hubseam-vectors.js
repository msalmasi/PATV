#!/usr/bin/env node
// tools/hubseam-vectors.js — the shared signing vectors of the v1 seam (1.99ach; seam plan §5.1), checked or regenerated from
// hubsign.js, the reference implementation.
//
//   node tools/hubseam-vectors.js            check: every computed field of test/fixtures/hubseam-sign-vectors.json is what
//                                            hubsign.js computes, and every negative vector is refused with its code (exit 1
//                                            otherwise)
//   node tools/hubseam-vectors.js --write    rewrite the computed fields (body_sha256, base, headers of the positive vectors;
//                                            the hidden_h hashes) - deterministic: same inputs, same bytes
//
// The file is byte-identical in the hub repo (services/rooms/test/fixtures/) and pinned by sha256 in both repos' tests: after
// --write, copy it to the hub and update both pins (test/hubsign.test.js here, test/seam-sign.test.ts there). The keys in it
// are test values, used nowhere else. Prints names and codes only.
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("../hubsign");
const H = require("../hubhidden");

const FILE = path.join(__dirname, "..", "test", "fixtures", "hubseam-sign-vectors.json");

function compute(v) {
  const before = JSON.stringify(v);
  for (const p of v.positive) {
    p.body_sha256 = S.bodyHash(p.body);
    p.base = S._base({ keyId: p.key_id, method: p.method, path: p.path, ts: p.ts, nonce: p.nonce, body: p.body });
    p.headers = S.sign({ method: p.method, path: p.path, body: p.body, keyId: p.key_id, key: v.keys[p.key_id], ts: p.ts, nonce: p.nonce });
  }
  // negative vectors: their headers are what a sender signed (`signed_as`: the key id and the key whose secret signs - they
  // differ for "another key under the right id"; method / path / body / ts / nonce as signed when they differ from what
  // arrives), then optionally relabelled (`relabel`: the X-PATV-Key-Id sent instead) and overridden (`override`: header ->
  // value, null = dropped), so each one fails for exactly its own reason
  for (const n of v.negative) {
    const s = n.signed_as;
    if (!s) continue;
    const h = S.sign({ method: s.method || n.method, path: s.path || n.path, body: s.body != null ? s.body : n.body, keyId: s.key_id,
                       key: v.keys[s.key || s.key_id], ts: s.ts, nonce: s.nonce });
    if (s.relabel) h[S.HEADERS.id] = s.relabel;
    for (const [k, x] of Object.entries(s.override || {})) { if (x == null) delete h[k]; else h[k] = x; }
    n.headers = h;
  }
  for (const h of v.hidden_h) {
    h.login_valid = H.loginHash(h.input) != null;
    h.h = h.login_valid ? H.loginHash(h.input) : /^u:/.test(h.input) ? H.hash(h.input) : null;
  }
  return JSON.stringify(v) !== before;
}

function check(v) {
  const bad = [];
  for (const p of v.positive) {
    S._reset();
    const dir = p.direction === "hub->v1" ? "hub" : "v1";
    const keys = Object.fromEntries(Object.entries(v.keys).filter(([id]) => S.keyIdOk(id, dir, p.receiver_env)));
    const r = S.verifyFrom({ dir, env: p.receiver_env, method: p.method, path: p.path, body: p.body, headers: p.headers, keys, now: p.now_s * 1000 });
    if (!r.ok) bad.push(`${p.name}: ${r.error}`);
  }
  for (const n of v.negative) {
    S._reset();
    const keys = Object.fromEntries(n.receiver_keys.map((id) => [id, v.keys[id]]));
    const r = S.verifyFrom({ dir: n.receiver_keys[0].split("-")[0], env: n.receiver_env, method: n.method, path: n.path, body: n.body, headers: n.headers,
                             keys, now: n.now_s * 1000 });
    if (r.ok || r.error !== n.error) bad.push(`${n.name}: ${r.ok ? "accepted" : r.error} (want ${n.error})`);
  }
  return bad;
}

if (require.main === module) {
  const raw = fs.readFileSync(FILE, "utf8");
  const v = JSON.parse(raw);
  const changed = compute(v);
  const bad = check(v);
  if (bad.length) { for (const b of bad) console.error("vector: " + b); process.exit(1); }
  if (process.argv.includes("--write")) {
    const next = JSON.stringify(v, null, 2) + "\n";
    if (next !== raw) { fs.writeFileSync(FILE, next); console.log("hubseam-sign-vectors.json rewritten - copy it to the hub repo and update both pins"); }
    else console.log("hubseam-sign-vectors.json is up to date");
  } else if (changed) {
    console.error("hubseam-sign-vectors.json is stale: run node tools/hubseam-vectors.js --write");
    process.exit(1);
  } else {
    console.log(`hubseam-sign-vectors.json: ${v.positive.length} positive, ${v.negative.length} negative vectors - all agree with hubsign.js`);
  }
}

module.exports = { compute, check, FILE };
