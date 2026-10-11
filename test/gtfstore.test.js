// 1.99nq: Grand Theft Frogger's persistent data on the site (gtfstore.js) behind the GTF backend switch, the heist minimap
// feed (gtf.js /api/gtf/bot/board + /api/gtf/board + the /gtf page), and the 🛒 heist-shop achievements' catalog.
//   * the import: off unless enabled (staging default on), digest + totals checked, verified backup, idempotent, a
//     different export refused while live, totals re-checked from the tables
//   * Pepe's keyed batches: idempotent by key, every record gets a rev, a tombstone, refused when not live
//   * state since a rev (Pepe's pull), the way back (release: frozen copy, the export + sha256 + totals, idempotent),
//     a fresh import after a release replaces the archive; avatar seeds follow the sheets
//   * shop history from the wallet ledger (for Pepe's quiet backfill)
//   * the board: cleaned, stored, stale after 5 min; /gtf renders the minimap with it
//   * the catalog: 13 shop achievements with badge art, en.json strings and their own /achievements group
//   NODE_PATH=G:/PATV/node_modules node --test test/gtfstore.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gtfstore-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const G = require(path.join(repo, "gtfstore"));
const GTF = require(path.join(repo, "gtf"));

const EXPORT = {
  v: 1,
  sheets: {
    alice: { stats: { str: 12 }, class: "Burglar", heists: 7, loot: 120000, items: { lockpick: 3 }, gear: ["armor"], avatar_seed: 12345, heat_val: 40 },
    bob: { stats: { str: 9 }, class: "Muscle", heists: 1, loot: 0, avatar_seed: 777 },
  },
  pvp: { alice: { wins: 5, losses: 2, net: 30000 }, bob: { wins: 2, losses: 5, net: -30000 } },
  lore: [{ who: "alice", amount: 90000, date: "2026-10-01", job: "the PAT Casino" }],
};
const TOTALS = { sheets: "2", pvp: "2", lore: "1", loot: "120000", heists: "8", duel_wins: "7", duel_losses: "7" };
// the wire shape: every record as Pepe's own JSON text (never re-serialized by JS - his numbers can pass 2^53)
const map = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
const T = (obj) => ({ v: 1, sheets: map(obj.sheets, (x) => JSON.stringify(x)), pvp: map(obj.pvp, (x) => JSON.stringify(x)), lore: JSON.stringify(obj.lore) });
const pack = (obj, extra = {}) => {
  const t = T(obj);
  const payload = JSON.stringify(t);
  return { payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), totals: G.totalsOf(t), ...extra };
};

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json(), cc: r.headers.get("cache-control") }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  for (const [id, name, cf] of [["u1", "ann", "Ann_CF"], ["u2", "bo", "bob"], ["u3", "nolink", null]]) {
    await runQuery("INSERT INTO users (userId, username, password, camfrogUsername) VALUES (?, ?, 'x', ?)", [id, name, cf]);
  }
  let n = 0;
  for (const [uid, type, pts] of [["u1", "heist-gear", -15000], ["u1", "heist-gear", -1000], ["u1", "heist-buyin", -5000], ["u2", "heist-gear", -100000],
                                  ["u3", "heist-gear", -3000], ["u1", "heist-gear", 500]]) {
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", ["t" + (++n), uid, type, pts]);
  }
  const app = express();
  app.use(express.json());
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  G.register(app, deps);
  GTF.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("off by default on prod: no import, nothing live, writes refused", async () => {
  assert.equal(await G.enabled(), false);
  const r = await post("/api/gtf/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_FEATURE_OFF");
  assert.equal((await post("/api/gtf/bot/put", { password: "bot", key: "gs-early-1", records: [{ kind: "sheet", id: "x", json: "{}" }] })).body.code, "E_NOT_LIVE");
  assert.equal((await post("/api/gtf/bot/status", { password: "nope" })).status, 403, "bot token only");
  const st = (await post("/api/gtf/bot/status", { password: "bot" })).body;
  assert.deepEqual([st.enabled, st.live], [false, false]);
});

test("the import: digest + totals checked, verified backup, idempotent, a different export refused", async () => {
  process.env.STAGING = "1";
  assert.equal(await G.enabled(), true, "on by default on staging");
  assert.equal((await post("/api/gtf/bot/import", { password: "bot", ...pack(EXPORT, { digest: "0".repeat(64) }) })).status, 400);
  assert.equal((await post("/api/gtf/bot/import", { password: "bot", ...pack(EXPORT, { totals: { ...TOTALS, loot: "1" } }) })).status, 400);
  const bad = JSON.stringify({ v: 1, sheets: { a: { loot: 1 } }, pvp: {}, lore: [] });     // objects, not texts
  assert.equal((await post("/api/gtf/bot/import", { password: "bot", payload: bad, digest: crypto.createHash("sha256").update(bad).digest("hex"), totals: TOTALS })).status, 400, "shape checked");
  const r = await post("/api/gtf/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.totals, TOTALS);
  assert.ok(r.body.backup && fs.existsSync(r.body.backup), "a backup file exists");
  assert.equal(await G.live(), true);
  const again = await post("/api/gtf/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(again.body.already, true, "the same export again = already");
  const other = await post("/api/gtf/bot/import", { password: "bot", ...pack({ ...EXPORT, lore: [] }) });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "E_ALREADY");
  assert.deepEqual(G.totalsOf(await G.exportObject()), TOTALS, "the tables hold exactly the export");
  const seed = (await getQuery("SELECT seed FROM cosmetic_avatar_seeds WHERE camfrog = 'alice'"))[0];
  assert.equal(seed.seed, 12345, "avatar seeds follow the sheets");
  assert.deepEqual(await G.sheetOf("ALICE"), EXPORT.sheets.alice, "sheet reads for the website");
});

test("Pepe's keyed batches: idempotent, revs, tombstones, bad records refused", async () => {
  const rev0 = (await G.status()).rev;
  const body = { password: "bot", key: "gs-batch-0001", records: [
    { kind: "sheet", id: "alice", json: JSON.stringify({ ...EXPORT.sheets.alice, loot: 125000, avatar_seed: 999 }) },
    { kind: "pvp", id: "carl", json: JSON.stringify({ wins: 1, losses: 0, net: 500 }) },
  ] };
  const a = await post("/api/gtf/bot/put", body);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.deepEqual([a.body.rev, a.body.n], [rev0 + 2, 2]);
  const b = await post("/api/gtf/bot/put", body);
  assert.equal(b.body.dup, true, "the same key again: the first answer, nothing written twice");
  assert.equal((await G.status()).rev, rev0 + 2);
  assert.equal((await G.record("sheet", "alice")).loot, 125000);
  assert.equal((await getQuery("SELECT seed FROM cosmetic_avatar_seeds WHERE camfrog = 'alice'"))[0].seed, 999);
  assert.equal((await post("/api/gtf/bot/put", { password: "bot", key: "gs-bad-0001", records: [{ kind: "gang", id: "x", json: "{}" }] })).status, 400, "only GTF kinds");
  assert.equal((await post("/api/gtf/bot/put", { password: "bot", key: "gs-bad-0002", records: [{ kind: "lore", id: "x", json: "[]" }] })).status, 400);
  assert.equal((await post("/api/gtf/bot/put", { password: "bot", key: "gs-bad-0003", records: [{ kind: "sheet", id: "x", json: "[1]" }] })).status, 400, "a sheet is an object");
  assert.equal((await post("/api/gtf/bot/put", { password: "bot", key: "bad", records: [] })).status, 400, "key format");
  await post("/api/gtf/bot/put", { password: "bot", key: "gs-tomb-0001", records: [{ kind: "pvp", id: "carl", json: null }] });
  assert.equal(await G.record("pvp", "carl"), null, "a tombstone hides the record");
  const s = (await post("/api/gtf/bot/state", { password: "bot", since_rev: rev0 })).body;
  assert.deepEqual(s.records.map((r) => [r.kind, r.id, r.json === null]), [["sheet", "alice", false], ["pvp", "carl", true]], "pull: changes after a rev, oldest first");
  assert.equal(s.live, true);
});

test("the way back: release freezes the site's copy and hands back the export; a fresh import replaces the archive", async () => {
  const r = await post("/api/gtf/bot/release", { password: "bot", by: "pepe" });
  assert.equal(r.status, 200);
  assert.equal(crypto.createHash("sha256").update(r.body.payload, "utf8").digest("hex"), r.body.digest, "digest of the payload");
  const obj = JSON.parse(r.body.payload);
  assert.equal(JSON.parse(obj.sheets.alice).loot, 125000);
  assert.ok(!obj.pvp.carl, "tombstones aren't exported");
  assert.deepEqual(r.body.totals, G.totalsOf(obj));
  assert.equal(await G.live(), false, "released = not live");
  assert.equal((await post("/api/gtf/bot/put", { password: "bot", key: "gs-after-0001", records: [{ kind: "pvp", id: "x", json: "{}" }] })).body.code, "E_NOT_LIVE");
  assert.equal(await G.sheetOf("alice"), null, "the website stops reading a released copy");
  const again = await post("/api/gtf/bot/release", { password: "bot" });
  assert.equal(again.body.digest, r.body.digest, "release is idempotent");
  const fresh = { sheets: { zed: { loot: 1, heists: 2 } }, pvp: {}, lore: [] };
  const imp = await post("/api/gtf/bot/import", { password: "bot", ...pack(fresh) });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  assert.deepEqual(Object.keys((await G.exportObject()).sheets), ["zed"], "the archive was replaced (a backup was taken first)");
  assert.equal(await G.live(), true);
});

test("numbers past 2^53 survive exactly: stored as Pepe's text, totals in BigInt (staging's sandbox loot)", async () => {
  // "the way back" test above left a fresh live import ("zed"); release it so a new import can run
  await post("/api/gtf/bot/release", { password: "bot" });
  const big = '{"heists":3,"loot":28862561789771469}';
  const t = { v: 1, sheets: { big, small: '{"heists":1,"loot":1.75}' }, pvp: { p: '{"losses":9007199254740993,"wins":2}' }, lore: "[]" };
  const payload = JSON.stringify(t);
  const totals = G.totalsOf(t);
  assert.deepEqual(totals, { sheets: "2", pvp: "1", lore: "0", loot: "28862561789771470", heists: "4", duel_wins: "2", duel_losses: "9007199254740993" });
  const imp = await post("/api/gtf/bot/import", { password: "bot", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), totals });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const st = (await post("/api/gtf/bot/state", { password: "bot", since_rev: 0 })).body;
  assert.equal(st.records.find((r) => r.id === "big").json, big, "the exact text comes back");
  const rel = (await post("/api/gtf/bot/release", { password: "bot" })).body;
  assert.equal(JSON.parse(rel.payload).sheets.big, big);
  assert.equal(rel.totals.duel_losses, "9007199254740993");
  assert.deepEqual(G.topInts('{"a":{"loot":5},"loot":-7,"s":"\\"loot\\":9"}', ["loot"]), { loot: -7n }, "top level only, strings skipped");
});

test("admin switch: admins only, same-site fetch only", async () => {
  // the route needs a user; this test app's addUser lets nobody in
  const r = await post("/api/admin/gtf-backend", { on: false });
  assert.equal(r.status, 401);
});

test("shop history: heist-gear debits per linked Camfrog login", async () => {
  const rows = (await post("/api/gtf/bot/shop-history", { password: "bot" })).body.rows;
  const by = Object.fromEntries(rows.map((r) => [r.login, r]));
  assert.deepEqual(by.ann_cf, { login: "ann_cf", buys: 2, spent: 16000 }, "buy-ins and refunds don't count");
  assert.deepEqual(by.bob, { login: "bob", buys: 1, spent: 100000 });
  assert.equal(rows.length, 2, "unlinked accounts are left out");
});

test("the minimap board: cleaned, stored, stale after 5 min; /gtf renders it", async () => {
  GTF._resetBoard();
  assert.equal((await get("/api/gtf/board")).body.board, null);
  const now = Math.floor(Date.now() / 1000);
  const board = {
    jobs: [
      { job: "casino", name: "PAT Casino", emoji: "🎰", buyin: 5000, rounds: 9, heat: 70, cooldown: 7200, ready_at: now + 3600,
        vault: { name: "Casino vault", emoji: "🎰", balance: 2500000 }, min_vault: 100000, door_dc: 25, open: false, why: null,
        last: { at: now - 600, outcome: "cracked", amount: 420000, crew: 3 }, evil: "<script>" },
      { job: "store", name: "Corner Store<img src=x>", emoji: "🏪", buyin: 250, rounds: 5, heat: 10, last: { outcome: "pwned" } },
      { job: "BAD JOB", name: "x" },
    ],
    running: { job: "store", phase: "running", round: 2, rounds: 5, crew: 2, room: "PepeLab" },
    heat_max: 100,
  };
  assert.equal((await post("/api/gtf/bot/board", { password: "nope", board })).status, 403);
  assert.equal((await post("/api/gtf/bot/board", { password: "bot", board })).status, 200);
  const g = await get("/api/gtf/board");
  assert.equal(g.cc, "no-store");
  assert.equal(g.body.stale, false);
  assert.deepEqual(g.body.board.jobs.map((j) => j.job), ["casino", "store"], "a bad job id is dropped");
  assert.equal(g.body.board.jobs[0].evil, undefined, "unknown fields dropped");
  assert.equal(g.body.board.jobs[1].last, null, "unknown outcome dropped");
  assert.equal(g.body.board.running.crew, 2);
  GTF._resetBoard();
  assert.equal((await get("/api/gtf/board")).body.board.jobs.length, 2, "kept in the table across a restart");
  await runQuery("UPDATE gtf_board SET updated = ?", [Date.now() - 6 * 60e3]);
  GTF._resetBoard();
  assert.equal((await get("/api/gtf/board")).body.stale, true, "stale after 5 min");
  const html = await ejs.renderFile(path.join(repo, "views", "gtf.ejs"), { user: null, links: GTF.LINKS, sheet: null, board: await GTF.boardView() },
                                    { root: path.join(repo, "views") });
  assert.match(html, /id="gtfMap"/);
  assert.match(html, /HEIST MINIMAP/);
  assert.match(html, /"Casino vault"/, "the board ships with the page (first paint without a fetch)");
  assert.doesNotMatch(html, /Corner Store<img/, "names can't break out of the inline JSON");
  assert.match(html, /\\u003cimg/);
  const empty = await ejs.renderFile(path.join(repo, "views", "gtf.ejs"), { user: null, links: GTF.LINKS, sheet: null, board: null },
                                     { root: path.join(repo, "views") });
  assert.match(empty, /No live data yet/);
});

test("catalog: 13 heist-shop achievements with art, en.json strings, rewards in line, their own group", async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "achievements.json"), "utf8")).achievements;
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const shop = cat.filter((a) => /^cf_(shop|kit)_/.test(a.id));
  assert.equal(shop.length, 13);
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const TIER = { common: [1000, 10000, 2000, 20000], uncommon: [3000, 25000, 5000, 50000], rare: [8000, 80000, 15000, 150000], legendary: [25000, 300000, 25000, 300000] };
  for (const a of shop) {
    assert.equal(a.side, "bot", a.id);
    assert.ok(fs.existsSync(path.join(repo, "public", "img", "badges", "ach", a.id + ".png")), "badge art " + a.id);
    assert.equal(en["ach.n." + a.id], esc(a.name));
    assert.equal(en["ach.d." + a.id], esc(a.desc));
    const [xlo, plo, xhi, phi] = TIER[a.tier];
    assert.ok(a.xp >= xlo && a.xp <= xhi && a.pat >= plo && a.pat <= phi, `${a.id} reward in its tier's band`);
  }
  assert.ok(en["ach.group.shop"]);
  const view = fs.readFileSync(path.join(repo, "views", "achievements.ejs"), "utf8");
  assert.match(view, /\['shop', t\('ach\.group\.shop'\), \["cf_shop_","cf_kit_"\]\]/);
  for (const k of Object.keys(en).filter((k) => k.startsWith("gtf.mm."))) assert.ok(en[k], k);
});
