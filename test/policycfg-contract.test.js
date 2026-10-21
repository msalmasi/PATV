// PO-3 (economy policy -> site plan, "Phase 6"): the contract of Pepe's economy-settings thin client, pinned by the SHARED fixture
// test/fixtures/policycfg-contract.json - byte-identical in camfrog-bot (ci/fixtures/policycfg-contract.json, written by Pepe's
// REAL code: tools/gen_policycfg_contract.py), its sha256 pinned here AND in the bot's policycfg_contract_test.py. This test feeds
// Pepe's exact bodies through the real routes (econstore, policy/scheduler, policy/config, policy/handover, capital/service):
//   * the pin (PEPE_BOT_DIR=<a camfrog-bot checkout> also compares the bot's copy byte for byte)
//   * the mirror of his three pushes (policy config, capital config, PAT Routing + catalog): every SPEC key present, the keys Pepe
//     exports ARE the site's keys, the diff report empty - prod's fight_rake -> room override valid with his catalog
//   * item 2 of the 2026-10-21 build: checkRoutes, fed only Pepe's catalog, answers like his _clean_routes for EVERY flow x
//     destination (a room-vault share needs rv or a v2 room flow - room alone, e.g. sponsor, isn't enough); an older catalog
//     without room_flow keeps the old reading
//   * the pull: have + sha -> unchanged only when both are current
//   * H1: freeze (via chat) -> his export uploaded in his chunk size -> verify ok (no changed key, no reader difference) ->
//     cutover without force; a chat write-through (an owner, never Telegram); an owner's web edit
//   * the rollback: step 1 hands back exactly the values Pepe's fixture expects; the confirm waits for his pushes (push_behind),
//     then his pushes after the write-back confirm it with no difference (no force)
//   NODE_PATH=G:/PATV/node_modules node --test test/policycfg-contract.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const FIXTURE = path.join(__dirname, "fixtures", "policycfg-contract.json");
// Update together with camfrog-bot's copy (ci/fixtures/policycfg-contract.json) and its pin (policycfg_contract_test.py PIN):
// python tools/gen_policycfg_contract.py --site <this checkout> prints the new sha.
const PIN = "4b8877a46bdbe4fc52155bcb0aeb94d72f1f3e7c589d890f522d8727edf5d693";
const RAW = fs.readFileSync(FIXTURE);
const FX = JSON.parse(RAW.toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policycfg-contract-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const C = require(path.join(repo, "policy", "core"));
const PC = require(path.join(repo, "policy", "config"));
const S = require(path.join(repo, "policy", "cfgspec"));
require(path.join(repo, "opsalerts")).alert = async () => ({ admins: 0 });

// Tuesday of the fixture's day, 15:00 UTC: that day's runs are done (Pepe's push says so) - no run window
let clockMs = Date.parse(FX.day + "T15:00:00Z");
PC._setClock(() => clockMs);
C._setClock(() => clockMs);
const tick = (s = 60) => { clockMs += s * 1000; };

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" },
                                            body: JSON.stringify(Object.assign({ password: FX.token }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const pushAll = async (pushes) => {
  assert.equal((await post("/api/policy/bot/config", { cfg: pushes.policy })).body.ok, true);
  tick(1);
  assert.equal((await post("/api/capital/bot/config", { cfg: pushes.capital })).body.ok, true);
  tick(1);
  assert.equal((await post("/api/econ/settings/put", pushes.econ)).body.ok, true);
  tick(1);
};
const canonEq = (a, b) => S.canon(a) === S.canon(b);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES (?, 'owner', 1), (?, 'admin', 1)", [FX.owner, FX.admin]);
  const app = express();
  // index.js: the chunk route parses its own (bigger) body - the site-wide parser skips it
  app.use((req, res, next) => (req.path === "/api/policy/bot/handover/chunk" ? next() : express.json({ limit: "5mb" })(req, res, next)));
  const deps = { isBotToken: (t) => t === FX.token, addUser: (req, res, next) => next() };
  require(path.join(repo, "econstore")).register(app, deps);
  require(path.join(repo, "policy", "scheduler")).register(app, deps);
  PC.register(app, deps);
  require(path.join(repo, "policy", "handover")).register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
});
test.after(() => server && server.close());

test("the shared fixture is the pinned version (a change on one side fails until the other is updated)", () => {
  assert.equal(sha(RAW), PIN, "test/fixtures/policycfg-contract.json changed: copy it to camfrog-bot's ci/fixtures/ and re-pin BOTH tests");
  assert.equal(RAW.includes(Buffer.from("\r\n")), false, "LF line ends (.gitattributes: text eol=lf)");
  assert.equal(FX.contract, "po3-1");
  const other = process.env.PEPE_BOT_DIR;            // optional: a camfrog-bot checkout - the copies must be byte-identical
  if (other) assert.equal(sha(fs.readFileSync(path.join(other, "ci", "fixtures", "policycfg-contract.json"))), PIN, "the bot's copy");
  // the export inside it is what its key says (the hand-over's key IS the sha256 of these bytes)
  const buf = Buffer.from(FX.export.text, "utf8");
  assert.equal(buf.length, FX.export.size);
  assert.equal(sha(buf), FX.export.key);
});

test("the mirror of Pepe's three pushes: every key, his export's keys are the site's, the diff report empty", async () => {
  await pushAll(FX.pushes);
  const snap = await PC.snapshot({ fresh: true });
  assert.deepEqual(S.KEYS.filter((k) => !(k in snap.cfg)), [], "every SPEC key is mirrored");
  assert.deepEqual(FX.site_keys, [...S.KEYS].sort(), "Pepe exports exactly the site's keys (no more, no fewer)");
  assert.deepEqual(snap.cfg.pat_routes, FX.pushes.econ.pat_routes, "prod's fight_rake -> room override is mirrored");
  const d = await PC.diffReport();
  assert.deepEqual(d.counts, { missing: 0, unknown: 0, invalid: 0, whole: 0, disagree: 0 }, JSON.stringify({ whole: d.whole, invalid: d.invalid, unknown: d.unknown }));
  assert.deepEqual(d.whole, [], "his routing is valid with his own catalog (checkRoutes)");
});

test("item 2: checkRoutes fed by Pepe's catalog answers like his _clean_routes for every flow x destination, both ways", () => {
  const catalog = FX.pushes.econ.catalog;
  const flows = Object.keys(FX.routes.keep);
  assert.ok(flows.length > 40 && FX.routes.dests.includes("room"), "the whole catalog");
  const siteOnly = [], pepeOnly = [];
  for (const flow of flows) {
    for (const dest of FX.routes.dests) {
      const site = S.checkRoutes({ [flow]: [[dest, 50]] }, catalog).length === 0;
      const pepe = FX.routes.keep[flow].includes(dest);
      if (site && !pepe) siteOnly.push(`${flow}->${dest}`);
      if (pepe && !site) pepeOnly.push(`${flow}->${dest}`);
    }
  }
  assert.deepEqual(pepeOnly, [], "a route Pepe keeps never reads invalid here (the mirror's whole-config check)");
  assert.deepEqual(siteOnly, [], "a route Pepe refuses is refused here too (the site owns the settings after H1)");
  // the room vault: rv (the rakes) or a v2 room flow - a flow flagged `room` alone (the pad owner's cut) may not send there
  assert.equal(catalog.routes.sponsor.room, true);
  assert.deepEqual(S.checkRoutes({ sponsor: [["room", 50]] }, catalog), ["pat_routes: sponsor can't send 50% to room"]);
  assert.deepEqual(S.checkRoutes({ fight_rake: [["room", 60]] }, catalog), [], "prod's override");
  // an older Pepe's catalog (no room_flow / rv on its rows): the old reading, so his room routes aren't refused wholesale
  const old = { routes: {}, dests: catalog.dests };
  for (const [f, m] of Object.entries(catalog.routes)) { const x = Object.assign({}, m); delete x.room_flow; delete x.rv; old.routes[f] = x; }
  assert.deepEqual(S.checkRoutes({ sponsor: [["room", 50]] }, old), [], "without room_flow a room flow keeps the old reading");
});

test("the pull: unchanged only when BOTH the rev and the sha Pepe holds are current", async () => {
  const snap = await PC.snapshot({ fresh: true });
  let r = await post("/api/policy/bot/cfg", { have: null, sha: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.owner, "pepe");
  assert.ok(canonEq(r.body.cfg, snap.cfg), "the first pull carries every value");
  r = await post("/api/policy/bot/cfg", { have: snap.rev, sha: snap.sha });
  assert.deepEqual([r.body.unchanged, r.body.cfg], [true, undefined]);
  r = await post("/api/policy/bot/cfg", { have: snap.rev });
  assert.equal(r.body.unchanged, undefined, "a rev alone is never trusted");
  assert.ok(r.body.cfg);
  r = await post("/api/policy/bot/cfg", { have: snap.rev, sha: "0".repeat(64) });
  assert.equal(r.body.unchanged, undefined);
});

test("H1 with Pepe's own export: freeze (chat) -> his chunks -> verify ok -> cutover without force; then his write-through", async () => {
  const actor = FX.owner;
  let r = await post("/api/policy/bot/handover/freeze", { feature: "cfg", actor, via: "chat", on: true });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const buf = Buffer.from(FX.export.text, "utf8");
  const n = Math.max(1, Math.ceil(buf.length / FX.export_chunk));
  r = await post("/api/policy/bot/handover/begin", { feature: "cfg", key: FX.export.key, size: buf.length, chunks: n, actor, via: "chat" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  for (let i = 0; i < n; i++) {
    const c = await post("/api/policy/bot/handover/chunk", { key: FX.export.key, idx: i, data: buf.subarray(i * FX.export_chunk, (i + 1) * FX.export_chunk).toString("base64") });
    assert.equal(c.body.ok, true, JSON.stringify(c.body));
  }
  r = await post("/api/policy/bot/handover/commit", { key: FX.export.key, actor, via: "chat" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const v = r.body.verify;
  assert.deepEqual([v.ok, v.changed, v.mismatched, v.changed_keys, v.differs], [true, 0, [], [], []],
                   "Pepe's export equals the mirror of his pushes and what every reader uses: " + JSON.stringify(v.readers));
  assert.deepEqual(v.money_rows, Object.fromEntries(Object.keys(v.money_rows).map((k) => [k, 0])), "no money row");
  assert.equal(v.log_imported, JSON.parse(FX.export.text).log.length);
  r = await post("/api/policy/bot/handover/cutover", { feature: "cfg", key: FX.export.key, actor, via: "chat" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.forced, [], "no force needed");
  assert.equal((await PC.ownership()).cfg.owner, "site");
  tick();
  // his !econ set, written through: an owner, base_rev = the rev he just pulled; Telegram never
  const pull = (await post("/api/policy/bot/cfg", { have: null, sha: null })).body;
  assert.equal(pull.owner, "site");
  r = await post("/api/policy/bot/cfg/set", Object.assign({}, FX.chat_set.request, { via: "telegram", base_rev: pull.rev }));
  assert.deepEqual([r.status, r.body.code], [403, "telegram"]);
  r = await post("/api/policy/bot/cfg/set", Object.assign({}, FX.chat_set.request, { actor: FX.admin, base_rev: pull.rev }));
  assert.deepEqual([r.status, r.body.code], [403, "owner_only"]);
  r = await post("/api/policy/bot/cfg/set", Object.assign({}, FX.chat_set.request, { base_rev: pull.rev - 1 }));
  assert.deepEqual([r.status, r.body.code], [409, "stale_rev"], "a stale base rev changes nothing");
  r = await post("/api/policy/bot/cfg/set", Object.assign({}, FX.chat_set.request, { base_rev: pull.rev }));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed.map((x) => x.key).sort(), Object.keys(FX.chat_set.stored).sort());
  const snap = await PC.snapshot({ fresh: true });
  for (const [k, val] of Object.entries(FX.chat_set.stored)) assert.ok(canonEq(snap.cfg[k], val), `${k}: ${S.canon(snap.cfg[k])} vs ${S.canon(val)}`);
  tick();
  // an owner's web edit on /admin/economy#policy (prod's fight_rake override back to its default)
  const w = await PC.edit({ changes: FX.chat_set.web_edit.changes, via: "web", actor: "own (" + FX.owner + ")", actorUserId: "u_own",
                            baseRev: snap.rev, note: FX.chat_set.web_edit.note });
  assert.equal(w.ok, true, JSON.stringify(w));
});

test("the rollback: step 1 hands back what Pepe expects; the confirm waits for his pushes, then his write-back confirms it (no force)", async () => {
  const actor = FX.owner;
  tick();
  let r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor, via: "chat" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  const differ = S.KEYS.filter((k) => !canonEq(r.body.cfg[k], FX.rollback.cfg[k]));
  assert.deepEqual(differ, [], "the values handed back are the fixture's rollback.cfg (Pepe's write-back is tested on those)");
  assert.ok(r.body.log.length >= Object.keys(FX.chat_set.stored).length, "the change log since the flip comes back too");
  const shaBack = r.body.sha;
  tick();
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor, via: "chat", confirm_sha: shaBack });
  assert.deepEqual([r.status, r.body.code], [409, "push_behind"], "his pushes haven't come since step 1");
  assert.ok(Array.isArray(r.body.behind) && r.body.behind.includes("policy"));
  // Pepe wrote the values back and pushes (the fixture's rollback.pushes are his builders after _pcf_write_back)
  await pushAll(FX.rollback.pushes);
  r = await post("/api/policy/bot/handover/rollback", { feature: "cfg", actor, via: "chat", confirm_sha: shaBack });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.forced, [], "no reader difference - no force");
  assert.equal((await PC.ownership()).cfg.owner, "pepe");
  // and the mirror takes his pushes again: nothing moves (the store is what he pushes)
  const rev = (await PC.snapshot({ fresh: true })).rev;
  tick();
  await pushAll(FX.rollback.pushes);
  assert.equal((await PC.snapshot({ fresh: true })).rev, rev, "his pushes after the rollback equal the store - no new rev");
  const d = await PC.diffReport();
  assert.deepEqual(d.counts, { missing: 0, unknown: 0, invalid: 0, whole: 0, disagree: 0 }, JSON.stringify(d.whole));
});
