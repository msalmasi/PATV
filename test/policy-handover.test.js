// PO-2 (economy policy -> site plan, "Phase 6", plan sections 5 / 6.2): the site's half of the config hand-over (policy/handover.js).
//   * every step is a Pepe owner's (the actor's role on the site), with the bot token; other features aren't ready yet
//   * freeze -> a chunked upload keyed by the export's sha256 -> commit: the bytes' sha checked (a mismatch is refused and the
//     chunks dropped), the payload checked (every key, valid, the whole config valid), then ONE transaction - the values, Pepe's
//     change log (original ts / who), his ceiling log, the verify record - that writes ZERO money rows; a rerun answers dup
//   * an export bigger than the site's 100 KB JSON parser goes through the chunk route's own limit
//   * cutover only with that key imported and unchanged; the site then owns the config; rollback in reverse order hands back
//     the site's values and its change log since the flip
//   * review of PO-2: verify.ok only when the import equals what the readers use (the values at the freeze + Pepe's pushes as
//     each consumer reads them); the cutover refuses a difference unless `force` names exactly those keys; a rollback is two
//     steps - the site keeps the config (edits 423) until Pepe's pushes carry the values handed back, then confirms (or cancels);
//     the money guard sums the balances too; Telegram / another via is refused on every step; begin / commit / rollback are an
//     owner's; the budget before the config
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-handover.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-handover-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const C = require(path.join(repo, "policy", "core"));
const PC = require(path.join(repo, "policy", "config"));
const H = require(path.join(repo, "policy", "handover"));
const S = require(path.join(repo, "policy", "cfgspec"));
const FX = require("./fixtures/policycfg");
require(path.join(repo, "opsalerts")).alert = async () => ({ admins: 0 });

const M = FX.M;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE pool_moves (key TEXT PRIMARY KEY, amount INTEGER)");
  await runQuery("CREATE TABLE supply_history (day TEXT PRIMARY KEY, ts INTEGER, total INTEGER)");
  for (const d of ["2026-10-18", "2026-10-19", "2026-10-20"]) await runQuery("INSERT INTO supply_history (day, ts, total) VALUES (?, 1, 1)", [d]);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t1', 'u', 'x', 5)");
  await runQuery("INSERT INTO users (userId, username, points_balance) VALUES ('u_alice', 'alice', 1000)");
  await runQuery("INSERT INTO pool_moves (key, amount) VALUES ('m1', 5), ('m2', 6)");
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1), ('admin_cf', 'admin', 1)");
  const app = express();
  // index.js: the chunk route parses its own (bigger) body - the site-wide parser skips it
  app.use((req, res, next) => (req.path === "/api/policy/bot/handover/chunk" ? next() : express.json()(req, res, next)));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  require(path.join(repo, "econstore")).register(app, deps);
  require(path.join(repo, "policy", "scheduler")).register(app, deps);
  PC.register(app, deps);
  H.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
  // the mirror holds Pepe's config (his pushes)
  assert.equal((await post("/api/policy/bot/config", { cfg: FX.policyPush() })).body.ok, true);
  assert.equal((await post("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog() })).body.ok, true);
  const snap = await PC.snapshot({ fresh: true });
  assert.deepEqual(S.KEYS.filter((k) => !(k in snap.cfg)), []);
});
test.after(() => server && server.close());

const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** Pepe's export (PO-3 builds it): every key at Pepe's effective value - here the mirror's, with two of his edits. */
async function exportOf(over = {}) {
  const cfg = Object.assign({}, (await PC.snapshot({ fresh: true })).cfg, { fed_floor: 50 * M, wf_staker_cap_pct: 0.0 }, over.cfg || {});
  for (const k of over.drop || []) delete cfg[k];
  const p = { v: 1, feature: "cfg", at: 1792500000, by: "owner_cf", bot_version: "1.99adq", cfg,
              log: [{ ts: 1792400000, by: "foamy1111", via: "chat", key: "wf_staker_cap_pct", old: 25, new: 0 },
                    { ts: 1792450000, by: "owner_cf", via: "panel-sink", key: "vault_ceil_cushion_days", old: 7, new: 8 }],
              ceil_log: [{ ts: 1792300000, ceil_apr: 0.25, ceil_cushion: 0, ceil_cushion_days: 8 }, { ts: 1792350000, ceil_apr: 0.0, ceil_cushion: 0, ceil_cushion_days: 8 }],
              archive: { stake_apr_min: 0.05, automint: 0 }, filler: over.filler || "" };
  const buf = Buffer.from(JSON.stringify(p), "utf8");
  return { p, buf, key: sha(buf) };
}
async function upload(buf, key, n, { actor = "owner_cf" } = {}) {
  const size = Math.ceil(buf.length / n);
  const b = await post("/api/policy/bot/handover/begin", { feature: "cfg", key, size: buf.length, chunks: n, actor });
  if (!b.body.ok) return b;
  for (let i = 0; i < n; i++) {
    const r = await post("/api/policy/bot/handover/chunk", { key, idx: i, data: buf.subarray(i * size, (i + 1) * size).toString("base64") });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  }
  return b;
}

test("every step is a Pepe owner's (the actor's role here); the upload can't start before the freeze; other features aren't ready", async () => {
  const { buf, key } = await exportOf();
  let r = await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "admin_cf", on: true });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "owner_only");
  r = await post("/api/policy/bot/handover/freeze", { password: "nope", feature: "cfg", actor: "owner_cf", on: true });
  assert.equal(r.status, 403);
  r = await post("/api/policy/bot/handover/begin", { feature: "cfg", key, size: buf.length, chunks: 1, actor: "admin_cf" });
  assert.equal(r.status, 403, "begin is an owner's");
  assert.equal(r.body.code, "owner_only");
  r = await post("/api/policy/bot/handover/begin", { feature: "cfg", key, size: buf.length, chunks: 1, actor: "owner_cf" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "not_frozen");
  // never from Telegram; the steps are chat commands
  r = await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: true, via: "telegram" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "telegram");
  r = await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: true, via: "web" });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "bad_via");
  assert.equal((await PC.ownership()).cfg.owner, "pepe", "nothing frozen");
  r = await post("/api/policy/bot/handover/freeze", { feature: "budget", actor: "owner_cf", on: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "not_ready");
  r = await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "Owner_CF", on: true, note: "H1 rehearsal" });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.owner, "cutting");
  assert.equal((await PC.ownership()).cfg.owner, "cutting");
  assert.equal((await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: true })).body.dup, true);
  // frozen: the mirror stops (Pepe's push writes nothing), edits are 423
  const rev = (await PC.snapshot({ fresh: true })).rev;
  await post("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: 1 } }) });
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev);
  await assert.rejects(PC.edit({ changes: { donation_rate: 2 }, via: "chat", actor: "owner_cf", baseRev: rev }), (e) => e.status === 423);
  // the freeze kept the values every reader used at that moment (an import is compared with them)
  const fz = await C.meta("cfg_freeze");
  assert.equal(fz.rev, rev);
  assert.equal(fz.cfg.donation_rate, 500000);
  await post("/api/policy/bot/config", { cfg: FX.policyPush() });             // (his push back in line)
});

test("a chunked upload -> commit: sha checked, payload checked, ONE transaction, zero money rows, Pepe's logs imported; a rerun is dup", async () => {
  const { p, buf, key } = await exportOf();
  const money0 = await H.moneyCounts();
  const rev0 = (await PC.snapshot({ fresh: true })).rev;
  const b = await upload(buf, key, 3);
  assert.equal(b.body.state, "receiving");
  // the same chunk again is a no-op; other bytes under its index are refused
  const size = Math.ceil(buf.length / 3);
  assert.equal((await post("/api/policy/bot/handover/chunk", { key, idx: 1, data: buf.subarray(size, 2 * size).toString("base64") })).body.dup, true);
  const bad = await post("/api/policy/bot/handover/chunk", { key, idx: 1, data: Buffer.from("other bytes").toString("base64") });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, "chunk_differs");
  // a begin again resumes (the chunks it has)
  assert.deepEqual((await post("/api/policy/bot/handover/begin", { feature: "cfg", key, size: buf.length, chunks: 3, actor: "owner_cf" })).body.have, [0, 1, 2]);
  let r = await post("/api/policy/bot/handover/commit", { key, actor: "admin_cf" });
  assert.equal(r.status, 403, "the commit is an owner's");
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev0, "nothing imported");
  r = await post("/api/policy/bot/handover/commit", { key, actor: "owner_cf" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = r.body.verify;
  assert.equal(v.keys, S.KEYS.length);
  assert.equal(v.digest, v.site_digest, "the site and Pepe print the same digest");
  assert.deepEqual(v.mismatched, []);
  assert.equal(v.changed, 1, "fed_floor (50M) was the only difference from the mirror");
  // review of PO-2: imported as sent, but NOT ok - the readers use 25M today (the freeze's value, Pepe's push)
  assert.equal(v.ok, false);
  assert.equal(v.base, "freeze");
  assert.deepEqual(v.changed_keys, ["fed_floor"]);
  assert.deepEqual(v.differs, ["fed_floor"]);
  assert.ok(v.readers.some((d) => d.consumer === "policy.source" && d.field === "econ_cfg.fed_floor" && d.push === String(25 * M) && d.site === String(50 * M)),
            JSON.stringify(v.readers));
  assert.ok(Object.values(v.money_sums).length && Object.values(v.money_sums).every((n) => n === 0), JSON.stringify(v.money_sums));
  assert.equal(v.rev, rev0 + 1);
  assert.deepEqual(Object.values(v.money_rows), Object.values(v.money_rows).map(() => 0));
  assert.ok("transactions" in v.money_rows && "pool_moves" in v.money_rows);
  assert.deepEqual(await H.moneyCounts(), money0, "zero money rows");
  assert.equal(v.log_imported, 2);
  assert.equal(v.ceil_log_imported, 2);
  assert.deepEqual(v.supply, { last_day: "2026-10-20", days: 3, gap_free: true });
  assert.deepEqual(v.archived, ["stake_apr_min", "automint"]);
  const snap = await PC.snapshot({ fresh: true });
  for (const k of S.KEYS) assert.equal(S.canon(snap.cfg[k]), S.canon(p.cfg[k]), k);
  assert.equal(snap.meta.fed_floor.via, "import");
  assert.equal(snap.meta.fed_floor.by, "owner_cf");
  const lg = await getQuery("SELECT ts, actor, via, key, old, new, note FROM policy_cfg_log WHERE via = 'import' AND rev = 0 ORDER BY ts");
  assert.deepEqual(lg.map((x) => [x.ts, x.actor, x.key, x.old, x.new, x.note]),
                   [[1792400000000, "foamy1111", "wf_staker_cap_pct", "25", "0", "on Pepe via chat"], [1792450000000, "owner_cf", "vault_ceil_cushion_days", "7", "8", "on Pepe via panel-sink"]]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM capital_ceil_log WHERE via = 'import'"))[0].n, 2);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_handover_chunks"))[0].n, 0, "the chunks are dropped once imported");
  // a rerun answers dup (nothing written twice)
  const again = await post("/api/policy/bot/handover/commit", { key, actor: "owner_cf" });
  assert.equal(again.body.dup, true);
  assert.equal(again.body.verify.digest, v.digest);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_cfg_log WHERE via = 'import' AND rev = 0"))[0].n, 2);
  // two commits racing on the same upload: one imports, the other answers dup (one import audited)
  const race = await exportOf({ cfg: { donation_rate: 512345 } });
  await upload(race.buf, race.key, 1);
  const [ra, rb] = await Promise.all([H.commit({ key: race.key, actor: "owner_cf" }), H.commit({ key: race.key, actor: "owner_cf" })]);
  assert.equal([ra, rb].filter((x) => x.dup || (x.verify && x.verify.dup)).length, 1, JSON.stringify([ra, rb]).slice(0, 300));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'policy.handover' AND detail LIKE ?", [`%${race.key}%`]))[0].n, 1);
  const ver = (await post("/api/policy/bot/handover/verify", { key: race.key })).body;
  assert.equal(ver.now.equal, true);
  assert.equal(ver.now.owner, "cutting");
  const aud = await getQuery("SELECT admin_id, detail FROM admin_audit WHERE action = 'policy.handover' ORDER BY id");
  assert.ok(aud.some((x) => x.admin_id === "chat:owner_cf" && /"step":"import"/.test(x.detail)));
});

test("a sha mismatch is refused and its chunks dropped; a payload missing a key or holding an invalid one is refused - nothing imported", async () => {
  const rev0 = (await PC.snapshot({ fresh: true })).rev;
  const good = await exportOf({ cfg: { donation_rate: 777 } });
  const other = Buffer.from(good.buf.toString("utf8").replace("777", "778"), "utf8");
  await upload(other, good.key, 2);                                 // the key says one thing, the bytes another
  let r = await post("/api/policy/bot/handover/commit", { key: good.key, actor: "owner_cf" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "sha_mismatch");
  assert.equal((await getQuery("SELECT state FROM policy_handovers WHERE key = ?", [good.key]))[0].state, "bad_sha");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_handover_chunks WHERE key = ?", [good.key]))[0].n, 0);
  const miss = await exportOf({ drop: ["fed_ceiling"] });
  await upload(miss.buf, miss.key, 1);
  r = await post("/api/policy/bot/handover/commit", { key: miss.key, actor: "owner_cf" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /missing 1 key\(s\): fed_ceiling/);
  const inv = await exportOf({ cfg: { fed_floor: 200 * M } });
  await upload(inv.buf, inv.key, 1);
  r = await post("/api/policy/bot/handover/commit", { key: inv.key, actor: "owner_cf" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /fed_floor \(200,000,000\) can't be above fed_ceiling/);
  const unk = await exportOf({ cfg: { stake_apr_min: 0.05 } });
  await upload(unk.buf, unk.key, 1);
  r = await post("/api/policy/bot/handover/commit", { key: unk.key, actor: "owner_cf" });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown key\(s\).*stake_apr_min/);
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev0, "nothing imported");
  // the uploaded export is the good one again: imported
  await upload(good.buf, good.key, 2);
  r = await post("/api/policy/bot/handover/commit", { key: good.key, actor: "owner_cf" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal((await PC.snapshot({ fresh: true })).cfg.donation_rate, 777);
});

test("the zero-money-rows guard: an import that would write one money row rolls back whole - nothing imported", async () => {
  const rev0 = (await PC.snapshot({ fresh: true })).rev;
  const x = await exportOf({ cfg: { donation_rate: 888 } });
  await upload(x.buf, x.key, 1);
  const real = PC.writeChanges;
  PC.writeChanges = async (...a) => { const r = await real(...a); await runQuery("INSERT INTO pool_moves (key, amount) VALUES ('sneaky', 1)"); return r; };
  try {
    const r = await post("/api/policy/bot/handover/commit", { key: x.key, actor: "owner_cf" });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "money_rows");
    assert.match(r.body.error, /pool_moves/);
  } finally { PC.writeChanges = real; }
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev0, "the values rolled back with it");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pool_moves WHERE key = 'sneaky'"))[0].n, 0);
  assert.equal((await getQuery("SELECT state FROM policy_handovers WHERE key = ?", [x.key]))[0].state, "receiving", "not imported: it can be committed again");
  const r = await post("/api/policy/bot/handover/commit", { key: x.key, actor: "owner_cf" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal((await PC.snapshot({ fresh: true })).cfg.donation_rate, 888);
  // review of PO-2: a balance UPDATE writes no row - the balances are summed too: an import that moves one rolls back whole
  const z = await exportOf({ cfg: { donation_rate: 889 } });
  await upload(z.buf, z.key, 1);
  PC.writeChanges = async (...a) => { const r = await real(...a); await runQuery("UPDATE users SET points_balance = points_balance + 5 WHERE userId = 'u_alice'"); return r; };
  try {
    const r = await post("/api/policy/bot/handover/commit", { key: z.key, actor: "owner_cf" });
    assert.equal(r.status, 500);
    assert.equal(r.body.code, "money_rows");
    assert.match(r.body.error, /moved balances \(users\.points_balance\)/);
  } finally { PC.writeChanges = real; }
  assert.equal((await getQuery("SELECT points_balance FROM users WHERE userId = 'u_alice'"))[0].points_balance, 1000);
  assert.equal((await PC.snapshot({ fresh: true })).cfg.donation_rate, 888, "the values rolled back with it");
  // back to the values the next tests expect
  const y = await exportOf({ cfg: { donation_rate: 777 } });
  await upload(y.buf, y.key, 1);
  assert.equal((await post("/api/policy/bot/handover/commit", { key: y.key, actor: "owner_cf" })).body.ok, true);
});

test("an export bigger than the site's 100 KB parser goes through the chunk route's own limit", async () => {
  const big = await exportOf({ filler: "x".repeat(700 * 1024) });
  assert.ok(big.buf.length > 700 * 1024);
  await upload(big.buf, big.key, 2);                                // ~480 KB of base64 per chunk
  const r = await post("/api/policy/bot/handover/commit", { key: big.key, actor: "owner_cf" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const huge = await post("/api/policy/bot/handover/chunk", { key: big.key, idx: 0, data: "A".repeat(H.CHUNK_MAX + 4) });
  assert.equal(huge.status, 400);
});

test("cutover: only an imported key, only while frozen and unchanged, and only when it is what the readers use - or the owner names the keys", async () => {
  // the latest import is the big one (same values): the site equals it
  const latest = (await getQuery("SELECT key FROM policy_handovers WHERE state = 'imported' ORDER BY imported_at DESC LIMIT 1"))[0].key;
  let r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: "f".repeat(64), actor: "owner_cf" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "not_imported");
  // an import whose values the site no longer holds (an older one with other values) is refused
  const first = (await getQuery("SELECT key FROM policy_handovers WHERE state = 'imported' ORDER BY imported_at LIMIT 1"))[0].key;
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: first, actor: "owner_cf" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "changed_since");
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "admin_cf" });
  assert.equal(r.status, 403);
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf", via: "telegram" });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, "telegram");
  // review of PO-2: the import holds fed_floor 50M and donation_rate 888 - the readers use 25M and 500,000 today (the freeze's
  // values, Pepe's push): the flip would switch them silently - refused, the keys listed
  const ver = (await post("/api/policy/bot/handover/verify", { key: latest })).body;
  assert.equal(ver.now.equal, true);
  assert.equal(ver.now.ready, false);
  assert.deepEqual(ver.now.differs, ["donation_rate", "fed_floor"]);
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "differs");
  assert.deepEqual(r.body.differs, ["donation_rate", "fed_floor"]);
  assert.ok(r.body.readers.some((d) => d.consumer === "policy.source" && d.field === "econ_cfg.donation_rate"));
  // a force must name exactly those keys (aliases resolve to the key)
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf", force: ["fed_floor"] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "force_mismatch");
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf", force: ["fed_floor", "donation_rate", "fed_ceiling"] });
  assert.equal(r.body.code, "force_mismatch");
  assert.equal((await PC.ownership()).cfg.owner, "cutting", "still frozen");
  // Pepe pushes the values he exported: the readers' view now equals the import - but the freeze's values still differ (the
  // mirror never had them) - the owner names them
  const imp = (await PC.snapshot({ fresh: true })).cfg;
  await post("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: imp.donation_rate, fed_floor: 50 * M } }) });
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf" });
  assert.equal(r.body.code, "differs");
  assert.deepEqual(r.body.differs, ["donation_rate", "fed_floor"], "the freeze's values");
  assert.deepEqual(r.body.readers, [], "his push agrees now: " + JSON.stringify(r.body.readers));
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf", force: ["fed_floor", "donation_rate"] });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.owner, "site");
  assert.deepEqual(r.body.forced, ["donation_rate", "fed_floor"]);
  assert.equal((await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: latest, actor: "owner_cf" })).body.dup, true);
  const own = (await PC.ownership()).cfg;
  assert.equal(own.owner, "site");
  assert.equal(own.handover_key, latest);
  const aud = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'policy.handover' AND detail LIKE '%\"step\":\"cutover\"%'"))[0];
  assert.deepEqual(JSON.parse(aud.detail).forced, ["donation_rate", "fed_floor"], "the forced keys are audited");
  // the site is the writer now: an edit, then Pepe's push is ignored
  const snap = await PC.snapshot({ fresh: true });
  const e = await PC.edit({ changes: { donation_rate: "600k" }, via: "chat", actor: "owner_cf", baseRev: snap.rev });
  assert.equal(e.ok, true);
  await post("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: 5 } }) });
  assert.equal((await PC.snapshot({ fresh: true })).cfg.donation_rate, 600000);
  assert.equal((await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: true })).status, 409, "a site-owned feature isn't frozen - it's rolled back");
});

test("rollback, step 1: reverse order, an owner's; the site KEEPS the config (edits 423) and hands its values back", async () => {
  // the budget before the config; the engines before the config
  await tx(async () => { await PC.putOwner("budget", "site", { by: "test" }); });
  let r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "order");
  assert.match(r.body.error, /budget/);
  await tx(async () => { await PC.putOwner("budget", "pepe", { by: "test" }); });
  await C.setMode("treasury", "live", { by: "test" });
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "order");
  await C.setMode("treasury", "shadow", { by: "test" });
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "admin_cf" });
  assert.equal(r.status, 403, "an owner's");
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", via: "telegram" });
  assert.equal(r.status, 403);
  assert.equal((await PC.ownership()).cfg.return_sha, null);
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.phase, "returning");
  assert.equal(r.body.owner, "site", "the site keeps it until Pepe confirms");
  const snap = await PC.snapshot({ fresh: true });
  assert.equal(r.body.rev, snap.rev);
  assert.equal(r.body.sha, snap.sha);
  assert.equal(r.body.cfg.donation_rate, 600000);
  assert.deepEqual(r.body.log.map((x) => [x.via, x.key, x.new]), [["chat", "donation_rate", "600000"]]);
  const own = (await PC.ownership()).cfg;
  assert.equal(own.owner, "site");
  assert.equal(own.return_sha, snap.sha);
  // the readers keep the site's values; every edit is 423
  assert.equal((await require(path.join(repo, "policy", "source")).read()).econ_cfg.donation_rate, 600000);
  await assert.rejects(PC.edit({ changes: { donation_rate: 1 }, via: "chat", actor: "owner_cf", baseRev: snap.rev }), (e) => e.status === 423 && e.code === "returning");
  // the same step again answers the same values (dup); a cancel gives the config back to the site's edits
  assert.equal((await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf" })).body.dup, true);
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", cancel: true });
  assert.equal(r.body.cancelled, true);
  assert.equal((await PC.ownership()).cfg.return_sha, null);
  const e = await PC.edit({ changes: { donation_rate: "610k" }, via: "chat", actor: "owner_cf", baseRev: snap.rev });
  assert.equal(e.ok, true, "edits again after the cancel");
  // a routing change on the site (Pepe's pushed table is ignored while the site owns the config)
  const e2 = await PC.edit({ changes: { pat_routes: { raffle: [["incentives", 50], ["reserve", 50]] } }, via: "web", actor: "own (owner_cf)", baseRev: e.rev, note: "split it" });
  assert.equal(e2.ok, true, JSON.stringify(e2));
});

test("rollback, step 2: confirmed only with the sha handed back and once Pepe's pushes carry those values; then Pepe owns it", async () => {
  let r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: "a".repeat(64) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "not_returning", "step 1 first");
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf" });
  assert.equal(r.body.phase, "returning");
  const handed = r.body;
  assert.equal(handed.cfg.donation_rate, 610000);
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: "a".repeat(64) });
  assert.equal(r.body.code, "sha_differs");
  // an engine went live on the site since step 1: the config still goes back last
  await C.setMode("treasury", "live", { by: "test" });
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: handed.sha });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "order");
  await C.setMode("treasury", "shadow", { by: "test" });
  // Pepe hasn't pushed since step 1: not yet
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: handed.sha });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "push_behind");
  assert.deepEqual(r.body.behind, ["policy"]);
  // he pushes, but his push still carries his own (pre-H1) values: not yet - the readers would switch to them
  await new Promise((res) => setTimeout(res, 5));
  await post("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: 500000, fed_floor: 50 * M } }) });
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: handed.sha });
  assert.equal(r.body.code, "push_behind");
  assert.deepEqual(r.body.differs, ["donation_rate"]);
  assert.equal((await PC.ownership()).cfg.owner, "site", "the site still owns it - its readers keep its values");
  assert.equal((await require(path.join(repo, "policy", "source")).read()).econ_cfg.donation_rate, 610000);
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: handed.sha, force: ["fed_floor"] });
  assert.equal(r.body.code, "force_mismatch");
  // he wrote the values back and pushed them: confirmed - Pepe owns the config, the site mirrors him again
  await post("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: 610000, fed_floor: 50 * M } }) });
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: handed.sha });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.owner, "pepe");
  const own = (await PC.ownership()).cfg;
  assert.equal(own.owner, "pepe");
  assert.equal(own.return_sha, null);
  assert.equal((await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor: "owner_cf", confirm_sha: handed.sha })).body.dup, true);
  // econstore's routing table (the routing readers' while Pepe owns the config) = the routes handed back
  assert.deepEqual(handed.cfg.pat_routes.raffle, [["incentives", 50], ["reserve", 50]]);
  assert.deepEqual(JSON.parse((await getQuery("SELECT shares FROM pat_routes WHERE flow = 'raffle'"))[0].shares), [["incentives", 50], ["reserve", 50]]);
  assert.equal((await getQuery("SELECT via FROM pat_routes_log WHERE flow = 'raffle' ORDER BY id DESC LIMIT 1"))[0].via, "rollback");
  assert.deepEqual((await require(path.join(repo, "econstore")).getSettings()).pat_routes.raffle, [["incentives", 50], ["reserve", 50]]);
  const steps = (await getQuery("SELECT detail FROM admin_audit WHERE action = 'policy.handover' ORDER BY id")).map((x) => JSON.parse(x.detail).step);
  assert.deepEqual(steps.filter((x) => /^rollback/.test(x)), ["rollback", "rollback_cancel", "rollback", "rollback_confirm"]);
  // Pepe owns it again: the site mirrors him
  await post("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: 550000, fed_floor: 50 * M } }) });
  assert.equal((await PC.snapshot({ fresh: true })).cfg.donation_rate, 550000);
});

test("review of the owner answers (H13): an upload committed after the freeze was lifted is refused inside the import's transaction - nothing imported", async () => {
  assert.equal((await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: true })).body.owner, "cutting");
  const x = await exportOf({ filler: "h13" });
  assert.equal((await upload(x.buf, x.key, 2)).body.ok, true);
  assert.equal((await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: false })).body.owner, "pepe");
  const rev0 = (await PC.snapshot({ fresh: true })).rev;
  const r = await post("/api/policy/bot/handover/commit", { key: x.key, actor: "owner_cf" });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "not_frozen");
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev0, "nothing imported");
  assert.equal((await PC.ownership()).cfg.owner, "pepe");
});

test("a clean hand-over: an export equal to the freeze's values and Pepe's pushes is ok as is - the cutover needs no force (and refuses one)", async () => {
  // Pepe owns it again (the rollback above): freeze, export his values (the mirror's), import, cut over
  assert.equal((await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor: "owner_cf", on: true })).body.owner, "cutting");
  const x = await exportOf();
  await upload(x.buf, x.key, 2);
  const r = await post("/api/policy/bot/handover/commit", { key: x.key, actor: "owner_cf" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.verify.ok, true, JSON.stringify(r.body.verify));
  assert.deepEqual(r.body.verify.differs, []);
  assert.equal(r.body.verify.changed, 0);
  let c = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: x.key, actor: "owner_cf", force: ["fed_floor"] });
  assert.equal(c.status, 409);
  assert.equal(c.body.code, "force_mismatch", "nothing to force");
  c = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: x.key, actor: "owner_cf" });
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.deepEqual(c.body.forced, []);
});
