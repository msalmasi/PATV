// 1.99ou Phase 2: PAT bounties on the site (escrow/bounties.js + escrow/games.js + bounties.js's page routes).
//   * the per-game import: refused while website bounty actions still wait for Pepe (bounty_actions pending/claimed), every
//     pot hold checked against the ledger, mid-step ("paying") records refused; the display table gets the records
//   * create / add / claim / resolve (Pepe's split: fee = pot * 5 // 100 routed by "bounty_fee", the rest even, the remainder to
//     the first hunter) / cancel / void / reject / dispute / the deadline; keyed acts; events for Pepe
//   * Pepe the verifier: spec_put / check_put (stale claims refused), auto-resolve only for a VERIFIED claim
//   * the website: /bounties/:id/:kind runs on the engine (no bounty_actions row), the old claim endpoint hands out nothing,
//     /act cmd=bounty creates here; rollback hands the records back
//   NODE_PATH=G:/PATV/node_modules node --test test/escrow-bounties.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-bt-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "escrow", "games"));
const E = require(path.join(repo, "escrow", "bounties"));
const B = require(path.join(repo, "bounties"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const actor = (login, username, extra = {}) => Object.assign({ login, username, admin: false, room: "Lab", via: "room" }, extra);
const PEPE = actor("pepebot", null, { pepe: true });
const act = (verb, a, args, idem) => post("/api/escrow/bot/act", { game: "bounties", verb, actor: a, args, idem });
/** a website form post as a signed-in user -> the ?msg= it redirects with */
async function web(userId, p, form) {
  const r = await fetch(base + p, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "x-user": userId }, body: JSON.stringify(form || {}) });
  const loc = r.headers.get("location") || "";
  return decodeURIComponent((/msg=([^&]*)/.exec(loc) || [])[1] || "");
}
const display = async (id) => {
  const r = (await getQuery("SELECT data FROM bounties WHERE id = ?", [id]))[0];
  return r ? JSON.parse(r.data) : null;
};

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf, cls] of [["u1", "ann", 50000, "ann_cf", "pleb"], ["u2", "bob", 50000, "bob_cf", "pleb"], ["u3", "carol", 0, "carol_cf", "pleb"],
                                        ["u4", "adm", 0, "boss", "Admin"], ["u5", "web", 9000, null, "pleb"], ["u6", "dan", 20000, "dan_cf", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', ?, ?, ?)", [id, name, b, cf, cls]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 1000000)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await require(path.join(repo, "funding")).init();
  await P.init();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => { if (req.get("x-user")) req.user = { userId: req.get("x-user") }; next(); } };
  P.register(app, deps);
  L.register(app, deps);
  G.register(app, deps);
  B.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // Phase 1 + the ledger: pools live, the escrow ledger imported with one bounty pot hold (h12, BT4)
  await P._setMeta("live", true);
  P._forgetLive();
  await P.move({ key: "seed-pools", legs: [["reserve", 100000], ["fortknox", 10]], flow: "test", kind: "admin" });
  await L.setMeta("enabled", true);
  const holds = [{ id: "h12", ref: "BT4", user: "ann", nick: "ann_cf", amount: 1500 }, { id: "h13", ref: "BT4", user: "dan", nick: "dan_cf", amount: 500 }];
  const payload = JSON.stringify({ v: 1, source: "pepe", holds, seq: 13, supply: [{ key: "escrow:holds", label: "h", amount: 2000 }] });
  const r = await post("/api/escrow/admin/import", { key: "ec-bt-1", payload, digest: sha(payload), totals: { sum: 2000, count: 2, per_kind: { BT: 2000 } } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});
test.after(() => server && server.close());

const T0 = nowS() - 3600;
const EXPORT = {
  v: 1, source: "pepe", seq: 4,
  bounties: [{ id: 4, creator: "ann_cf", task: "kick tricon when he mentions pokemon", room: "Lab", status: "open", created: T0, deadline: T0 + 7 * 86400,
               pot: [{ hid: "h12", nick: "ann_cf", amount: 1500, user: "ann" }, { hid: "h13", nick: "dan_cf", amount: 500, user: "dan" }],
               claims: { bob_cf: { ts: T0 + 60, note: "did it https://clip.example/x", evidence: { text: "did it", links: ["https://clip.example/x"] } } },
               spec: { v: 1, action: "kick", target: "tricon", trigger: { type: "any_said", who: "tricon", match: "pokemon", semantic: true, window_s: 300 }, room: "any" },
               spec_src: "llm", users: { creator: "ann" } }],
};
function pack(x, key, totals) {
  const payload = JSON.stringify(x);
  return { game: "bounties", key, payload, digest: sha(payload), totals };
}

test("import: refused while website actions wait for Pepe; every pot hold checked; mid-step refused; then live", async () => {
  await L.setMeta("enabled:bounties", true);
  // the old queue: a pending website action blocks the cutover
  await runQuery(`INSERT INTO bounty_actions (bounty_id, user_id, username, kind, status, created, updated) VALUES (4, 'u2', 'bob', 'claim', 'pending', ?, ?)`, [Date.now(), Date.now()]);
  assert.equal((await post("/api/escrow/admin/game-import", pack(EXPORT, "gc-bt-1", { sum: 2000, count: 1 }))).body.code, "E_BUSY");
  await runQuery("UPDATE bounty_actions SET status = 'done'");
  const paying = JSON.parse(JSON.stringify(EXPORT));
  paying.bounties[0].status = "paying";
  assert.equal((await post("/api/escrow/admin/game-import", pack(paying, "gc-bt-2", { sum: 2000, count: 1 }))).body.code, "E_BUSY");
  const wrong = JSON.parse(JSON.stringify(EXPORT));
  wrong.bounties[0].pot[1].amount = 600;
  assert.equal((await post("/api/escrow/admin/game-import", pack(wrong, "gc-bt-3", { sum: 2100, count: 1 }))).body.code, "E_HOLDS");
  assert.equal((await post("/api/escrow/admin/game-import", pack(EXPORT, "gc-bt-4", { sum: 1999, count: 1 }))).body.code, "E_TOTALS");
  const r = await post("/api/escrow/admin/game-import", pack(EXPORT, "gc-bt-5", { sum: 2000, count: 1 }));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.sum, 2000);
  assert.equal(await G.gameLive("bounties"), true);
  const d = await display(4);
  assert.equal(d.status, "open");
  assert.equal(d.claims[0].nick, "bob_cf");
  assert.match(d.verify.text, /a kick of tricon by the claimant within 5 min after tricon mentions 'pokemon'/);
  // Pepe's late snapshot no longer overwrites the table
  const s = await post("/api/bounties/sync", { bounties: [{ id: 4, creator: "x", task: "stale", status: "cancelled", pot: [], claims: [] }] });
  assert.equal(s.body.live, true);
  assert.equal((await display(4)).status, "open");
});

test("create / add from chat: holds, keyed, dup + limits + Pepe's texts; events", async () => {
  const a0 = await bal("u1");
  assert.equal((await act("create", actor("ann_cf", "ann"), { task: "sing a song", amount: 999, secs: 3600 }, "idem-c0")).body.code, "min");
  assert.equal((await act("create", actor("ann_cf", "ann"), { task: "sing", amount: 1000, secs: 31 * 86400 }, "idem-c0b")).body.error, "The longest a bounty can run is 30d.");
  const poor = await act("create", actor("carol_cf", "carol"), { task: "sing a song", amount: 1000, secs: 3600 }, "idem-c0c");
  assert.equal(poor.body.error, "Couldn't post the bounty — that needs PAT 1,000 and carol_cf has 0.");
  const c = await act("create", actor("ann_cf", "ann"), { task: "sing a song on mic", amount: 2000, secs: 3600, room: "Lab", said: "pepe-bt-said01" }, "idem-c1");
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.ref, "BT5");
  assert.equal(await bal("u1"), a0 - 2000);
  assert.equal((await act("create", actor("ann_cf", "ann"), { task: "sing a song on mic", amount: 2000, secs: 3600 }, "idem-c1")).body.dup, true);
  assert.equal(await bal("u1"), a0 - 2000);
  assert.equal((await act("create", actor("ann_cf", "ann"), { task: "Sing a song on mic.", amount: 2000, secs: 3600 }, "idem-c2")).body.code, "dup");
  const add = await act("add", actor("bob_cf", "bob"), { ref: "BT5", amount: 1001 }, "idem-a1");
  assert.equal(add.body.ok, true);
  assert.equal(add.body.total, 3001);
  assert.equal((await act("add", actor("bob_cf", "bob"), { ref: "BT5", amount: 99 }, "idem-a2")).body.error, "Chip in at least PAT 100.");
  assert.equal((await act("add", actor("bob_cf", "bob"), { ref: "BT99", amount: 500 }, "idem-a3")).body.error, "No bounty BT99.");
  const rec = await G.load("bounties", 5);
  assert.deepEqual(rec.pot.map((p) => [p.nick, p.amount, p.user]), [["ann_cf", 2000, "ann"], ["bob_cf", 1001, "bob"]]);
  const ev = await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["bounties"] });
  const kinds = ev.body.events.map((e) => e.kind);
  assert.deepEqual(kinds, ["created", "add"]);
  assert.equal(ev.body.events[0].data.tok, c.body.tok);
  assert.equal(ev.body.events[0].data.said, "pepe-bt-said01");          // Pepe announces his own call once
  assert.equal(ev.body.events[1].data.said, undefined);
  assert.equal(ev.body.events[1].data.amount, 1001);
  assert.equal((await display(5)).pot.length, 2);
});

test("claims: not your own, not on yourself, re-claim keeps a dispute; Pepe's check_put (stale refused); auto-resolve only when verified", async () => {
  assert.equal((await act("claim", actor("ann_cf", "ann"), { ref: "BT4" }, "idem-cl0")).body.error, "You can't claim your own bounty.");
  assert.equal((await act("claim", actor("tricon", null), { ref: "BT4" }, "idem-cl1")).body.error, "You can't collect a bounty on yourself.");
  const cl = await act("claim", actor("dan_cf", "dan"), { ref: "BT4", note: "kicked him", evidence: { text: "kicked him", links: ["https://snap.example/abc"] } }, "idem-cl2");
  assert.equal(cl.body.ok, true, JSON.stringify(cl.body));
  const c = (await G.load("bounties", 4)).claims.dan_cf;
  assert.deepEqual(c.evidence.links, ["https://snap.example/abc"]);
  // Pepe's verdict is written back; a stale ts is refused; only Pepe may write it
  assert.equal((await act("check_put", actor("dan_cf", "dan"), { ref: "BT4", nick: "dan_cf", ts: c.ts, check: { state: "verified" } }, "idem-ck0")).body.code, "not_pepe");
  assert.equal((await act("check_put", PEPE, { ref: "BT4", nick: "dan_cf", ts: c.ts - 1, check: { state: "verified" } }, "idem-ck1")).body.code, "stale");
  // bob's claim matched only by meaning: creator must confirm - an auto-resolve for him is refused
  const ckb = await act("check_put", PEPE, { ref: "BT4", nick: "bob_cf", ts: T0 + 60, check: { state: "creator", how: "semantic", lines: ["l1"], why: "by meaning" } }, "idem-ck2");
  assert.equal(ckb.body.ok, true, JSON.stringify(ckb.body));
  assert.equal((await act("resolve", PEPE, { ref: "BT4", hunters: ["bob_cf"], auto: true }, "idem-r0")).body.code, "not_verified");
  assert.equal((await act("resolve", PEPE, { ref: "BT4", hunters: ["dan_cf"] }, "idem-r0b")).body.code, "not_creator");
  const ck = await act("check_put", PEPE, { ref: "BT4", nick: "dan_cf", ts: c.ts, check: { state: "verified", how: "exact", lines: ["12:00 dan kicked tricon"], why: "" } }, "idem-ck3");
  assert.equal(ck.body.ok, true);
  assert.equal((await display(4)).claims.find((x) => x.nick === "dan_cf").check.state, "verified");
  // the auto-award: pot 2000, fee 100 routed by bounty_fee (Pepe's shares), 1900 to dan
  await post("/api/escrow/bot/fee-plans", { plans: { k: 1, shares: { bounty_fee: [["reserve", 50], ["fortknox", 50]] } } });
  const d0 = await bal("u6"), r0 = (await P.balances()).reserve, fk0 = (await P.balances()).fortknox;
  const r = await act("resolve", PEPE, { ref: "BT4", hunters: ["dan_cf"], auto: true }, "idem-r1");
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.paid, 1900);
  assert.equal(await bal("u6"), d0 + 1900);
  assert.equal((await P.balances()).reserve, r0 + 50);
  assert.equal((await P.balances()).fortknox, fk0 + 50);
  const rec = await G.load("bounties", 4);
  assert.equal(rec.status, "resolved");
  assert.equal(rec.resolved_by, "Pepe (verified)");
  assert.equal((await display(4)).auto, true);
  assert.equal((await act("resolve", actor("ann_cf", "ann"), { ref: "BT4", hunters: ["dan_cf"] }, "idem-r2")).body.error, "Bounty BT4 is resolved.");
});

test("resolve by the creator: Pepe's split (remainder to the first hunter), rejection cleared; reject / dispute rules", async () => {
  // BT5: ann 2000 + bob 1001 = 3001 -> fee 150 (3001*5//100), 2851 over 3 hunters: 950 each, +1 to the first
  for (const [who, u] of [["carol_cf", "carol"], ["dan_cf", "dan"], ["bob_cf", "bob"]]) {
    assert.equal((await act("claim", actor(who, u), { ref: "BT5", note: "me" }, `idem-cl5-${who}`)).body.ok, true);
  }
  assert.equal((await act("reject", actor("bob_cf", "bob"), { ref: "BT5", hunter: "carol_cf" }, "idem-rj0")).body.code, "not_creator");
  const rj = await act("reject", actor("ann_cf", "ann"), { ref: "BT5", hunter: "@Carol_CF", why: "no proof" }, "idem-rj1");
  assert.equal(rj.body.ok, true, JSON.stringify(rj.body));
  assert.equal(rj.body.final, false);
  // dan wasn't rejected and it's not 12 h yet
  assert.match((await act("dispute", actor("dan_cf", "dan"), { ref: "BT5" }, "idem-dp0")).body.error, /^Give ann_cf a chance first — you can dispute once they reject it, or [0-9]+h from now/);
  const dp = await act("dispute", actor("carol_cf", "carol"), { ref: "BT5", why: "I did it" }, "idem-dp1");
  assert.equal(dp.body.ok, true);
  assert.equal((await act("dispute", actor("carol_cf", "carol"), { ref: "BT5" }, "idem-dp2")).body.error, "Your claim on BT5 is already with the admins.");
  assert.equal((await act("reject", actor("ann_cf", "ann"), { ref: "BT5", hunter: "carol_cf" }, "idem-rj2")).body.error, "carol_cf's claim on BT5 is with the admins now.");
  assert.equal((await act("resolve", actor("ann_cf", "ann"), { ref: "BT5", hunters: ["zed"] }, "idem-r50")).body.error, "zed hasn't claimed BT5 — they need to !bounty claim BT5 first.");
  assert.equal((await act("resolve", actor("ann_cf", "ann"), { ref: "BT5", hunters: ["ann_cf"] }, "idem-r51")).body.error, "The creator can't collect their own bounty.");
  const c0 = await bal("u3"), d0 = await bal("u6"), b0 = await bal("u2"), h0 = (await P.balances()).reserve;
  const r = await act("resolve", actor("ann_cf", "ann"), { ref: "BT5", hunters: ["@carol_cf", "dan_cf", "bob_cf", "dan_cf"] }, "idem-r52");
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.fee, 150);
  assert.equal(await bal("u3"), c0 + 951);
  assert.equal(await bal("u6"), d0 + 950);
  assert.equal(await bal("u2"), b0 + 950);
  assert.equal((await P.balances()).reserve, h0 + 75);
  const rec = await G.load("bounties", 5);
  assert.deepEqual(rec.hunters, ["carol_cf", "dan_cf", "bob_cf"]);
  assert.equal(rec.claims.carol_cf.rejected, undefined);
  const ev = (await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["bounties"] })).body.events;
  const res = ev.find((e) => e.kind === "resolved" && e.data.ref === "BT5");
  assert.deepEqual([res.data.paid, res.data.each, res.data.fee, res.data.by], [2851, 950, 150, "ann_cf"]);
});

test("cancel / void / the deadline refund every hold; spec_put respects a hand-set spec", async () => {
  const a0 = await bal("u1"), b0 = await bal("u2");
  await act("create", actor("ann_cf", "ann"), { task: "make tricon laugh", amount: 1000, secs: 3600 }, "idem-c6");
  await act("add", actor("bob_cf", "bob"), { ref: "BT6", amount: 300 }, "idem-a6");
  // !bounty verify BT6 off by the creator, then Pepe's (late) auto spec doesn't overwrite it
  assert.equal((await act("spec_put", actor("ann_cf", "ann"), { ref: "BT6", spec: null, src: "cleared", set: true }, "idem-sp0")).body.ok, true);
  const late = await act("spec_put", PEPE, { ref: "BT6", spec: { v: 1, action: "say", phrase: "haha" }, src: "llm", text: "the claimant saying 'haha'" }, "idem-sp1");
  assert.equal(late.body.skipped, true);
  assert.equal((await G.load("bounties", 6)).spec, null);
  assert.equal((await act("spec_put", actor("bob_cf", "bob"), { ref: "BT6", spec: null, set: true }, "idem-sp2")).body.code, "not_creator");
  assert.equal((await act("cancel", actor("bob_cf", "bob"), { ref: "BT6" }, "idem-x0")).body.error, "Only ann_cf can cancel BT6.");
  assert.equal((await act("void", actor("ann_cf", "ann"), { ref: "BT6" }, "idem-x1")).body.error, "Admin only.");
  const x = await act("cancel", actor("ann_cf", "ann"), { ref: "BT6" }, "idem-x2");
  assert.equal(x.body.ok, true);
  assert.equal(await bal("u1"), a0);
  assert.equal(await bal("u2"), b0);
  assert.equal((await act("cancel", actor("ann_cf", "ann"), { ref: "BT6" }, "idem-x3")).body.error, "BT6 is already cancelled.");
  // void by an admin
  await act("create", actor("ann_cf", "ann"), { task: "void me", amount: 1000, secs: 3600 }, "idem-c7");
  const v = await act("void", actor("boss", "adm", { admin: true }), { ref: "BT7" }, "idem-x4");
  assert.equal(v.body.ok, true);
  assert.equal(await bal("u1"), a0);
  // the deadline: the site tick refunds everyone
  await act("create", actor("ann_cf", "ann"), { task: "too slow", amount: 1000, secs: 3600 }, "idem-c8");
  await act("add", actor("dan_cf", "dan"), { ref: "BT8", amount: 200 }, "idem-a8");
  const d0 = await bal("u6");
  const b8 = await G.load("bounties", 8);
  b8.deadline = 1;
  await G.save("bounties", b8);
  assert.equal((await act("claim", actor("bob_cf", "bob"), { ref: "BT8" }, "idem-cl8")).body.error, "Bounty BT8 is expired.");
  await G.tick();
  assert.equal((await G.load("bounties", 8)).status, "expired");
  assert.equal(await bal("u1"), a0);
  assert.equal(await bal("u6"), d0 + 200);
  const kinds = (await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["bounties"] })).body.events.map((e) => e.kind);
  assert.ok(kinds.includes("cancelled") && kinds.includes("expired") && kinds.includes("spec"));
});

test("the website: the bounty page's forms run on the engine (no queued action), /act creates here, the old claim endpoint hands out nothing", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM bounty_actions"))[0].n;
  const msg = await G.fromForm("u2", "bounty", ["kick", "plantbaked", "5k", "by 2d"], "form-bt-0001");
  assert.match(msg, /Bounty BT9 is up: PAT 5,000 for "kick plantbaked" \(2d\)/);
  assert.equal((await G.load("bounties", 9)).creator, "bob_cf");
  assert.match(await web("u1", "/bounties/9/add", { amount: "1,000" }), /Added PAT 1,000 to BT9/);
  assert.match(await web("u1", "/bounties/9/add", { amount: "50" }), /Chip in at least 100 PAT/);       // the page's own check, as before
  assert.match(await web("u5", "/bounties/9/claim", { note: "done", evidence: "https://clip.example/9" }), /Claim sent/);
  const c = (await G.load("bounties", 9)).claims.web;
  assert.equal(c.web, true);
  assert.deepEqual(c.evidence.links, ["https://clip.example/9"]);
  assert.match(await web("u2", "/bounties/9/reject", { hunter: "web", note: "nope" }), /Rejected web's claim/);
  assert.match(await web("u5", "/bounties/9/dispute", { note: "really" }), /Sent to the admins/);
  const w0 = await bal("u5");
  assert.match(await web("u4", "/bounties/9/resolve", { hunters: ["web"] }), /BT9 paid: web collect PAT 5,700/);
  assert.equal(await bal("u5"), w0 + 5700);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bounty_actions"))[0].n, before);
  // a row that somehow got queued is answered, nothing is handed to Pepe
  await runQuery(`INSERT INTO bounty_actions (bounty_id, user_id, username, kind, status, created, updated) VALUES (9, 'u2', 'bob', 'add', 'pending', ?, ?)`, [Date.now(), Date.now()]);
  const cl = await post("/api/bounties/actions/claim", {});
  assert.deepEqual(cl.body.actions, []);
  assert.equal((await getQuery("SELECT status FROM bounty_actions ORDER BY id DESC LIMIT 1"))[0].status, "failed");
});

test("rollback hands the records back (keyed); the engine stops", async () => {
  await act("create", actor("ann_cf", "ann"), { task: "stays open", amount: 1000, secs: 3600 }, "idem-c10");
  const rb = await post("/api/escrow/admin/game-rollback", { game: "bounties", key: "gr-bt-1" });
  assert.equal(rb.body.ok, true, JSON.stringify(rb.body));
  assert.deepEqual(rb.body.records.filter((r) => r.status === "open").map((r) => r.id), [10]);
  assert.equal(rb.body.count, 1);
  assert.equal(rb.body.sum, 1000);
  const r10 = rb.body.records.find((r) => r.id === 10);
  assert.equal(r10.status, "open");
  assert.equal(r10.pot[0].user, "ann");
  assert.equal((await post("/api/escrow/admin/game-rollback", { game: "bounties", key: "gr-bt-1" })).body.dup, true);
  assert.equal(await G.gameLive("bounties"), false);
  assert.equal((await act("add", actor("bob_cf", "bob"), { ref: "BT10", amount: 500 }, "idem-a10")).body.code, "not_live");
  assert.equal(await G.fromForm("u2", "bounty", ["kick", "x", "5k"], "form-bt-0002"), null);
});

test("parse + describe helpers match Pepe", () => {
  assert.deepEqual(E.parseCreate(["kick tricon when he mentions pokemon", "10,000", "by 2d"]), { secs: 172800, amount: 10000, task: "kick tricon when he mentions pokemon" });
  assert.deepEqual(E.parseCreate(["kick", "plantbaked", "1000"]), { secs: 604800, amount: 1000, task: "kick plantbaked" });
  assert.equal(E.fmtSecs(30 * 86400), "30d");
  assert.equal(E.fmtSecs(90000), "1d 1h");
  assert.equal(E.describeSpec({ action: "say", phrase: "hi", who: null, semantic: false, room: "any" }), "the claimant saying 'hi' in room chat");
  assert.deepEqual(E.evidenceOf("see https://a.b/c). ok"), { text: "see https://a.b/c). ok", links: ["https://a.b/c"] });
});
