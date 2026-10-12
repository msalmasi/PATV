// 1.99uc: /admin/oracle - the admins' view of the AI judge's proposals (oracleadmin.js + oracle.js admin functions).
//   * admins only (page, JSON, actions); actions need same-site + X-Requested-With
//   * the list's filters (status / kind / dates), the summary tiles, the detail view (timeline, disputes, actions)
//   * every action: keyed (the same key answers the stored result, once), audited, refused when it can't apply,
//     and a settle can't happen twice (a real escrow pool settled by an admin; the window's tick never settles it again)
//   * everything Pepe / a disputer wrote is escaped; evidence links are http(s) only
// No wall-clock assumptions: windows are set relative to Date.now() and dates are fixed in the past.
//   NODE_PATH=G:/PATV/node_modules node --test test/oracle-admin.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-admin-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "escrow", "games"));
const O = require(path.join(repo, "oracle"));
const OA = require(path.join(repo, "oracleadmin"));

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const bal = async (id) => Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b);
const actor = (login, username, extra = {}) => Object.assign({ login, username, admin: false, room: "Lab", via: "room" }, extra);
let n = 0;
const act = (verb, a, args) => G.act("pools", { verb, actor: a, args, idem: `idem-oa-${++n}` });
const idem = () => crypto.randomUUID();
const BOSS = { userId: "u9", username: "boss", camfrogUsername: "boss_cf" };
const DAY = 86400000;
const D = (s) => Date.parse(s + "T12:00:00Z");

// stub resolvers for the kinds this test doesn't run a real engine for (a market the site owns, one Pepe owns, a wager)
const calls = [];
let marketOwner = "site";
O.registerResolver("market", {
  owner: async (ref) => (ref === "M70" ? "pepe" : marketOwner), decidable: async () => true,
  settle: async (ref, outcome, key, pepeLogin, a) => { calls.push({ ref, outcome, key, admin: !!(a && a.admin), login: a && a.login }); return { ok: true, ref }; },
});
O.registerResolver("wager", {
  owner: async () => "site", decidable: async () => true,
  settle: async (ref, outcome, key, pepeLogin, a) => { calls.push({ ref, outcome, key, admin: !!(a && a.admin) }); return { ok: true, ref }; },
});

let ref, base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  for (const [id, name, b, cf, cls] of [["u1", "ann", 100000, "ann_cf", "pleb"], ["u2", "bob", 100000, "bob_cf", "pleb"], ["u3", "carol", 100000, "carol_cf", "pleb"],
                                         ["u9", "boss", 0, "boss_cf", "Admin"], ["u8", "helper", 0, null, "Staff"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', ?, ?, ?)", [id, name, b, cf, cls]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 1000000)");
  await require(path.join(repo, "funding")).init();
  await P.init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const deps = { isBotToken: (t) => t === "bot", addUser };
  P.register(app, deps);
  L.register(app, deps);
  G.register(app, deps);
  O.register(app, deps);
  OA.register(app, deps);
  await P._setMeta("live", true);
  P._forgetLive();
  await P.move({ key: "seed-pools", legs: [["reserve", 100000], ["mm", 10]], flow: "test", kind: "admin" });
  await L.setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", holds: [], seq: 1, supply: [] });
  assert.equal((await L.importFromPepe({ key: "ec-oa-0001", payload, digest: sha(payload), totals: { sum: 0, count: 0, per_kind: {} } })).ok, true);
  await L.setMeta("enabled:pools", true);
  const empty = JSON.stringify({ v: 1, source: "pepe", pools: [], seq: 1 });
  assert.equal((await G.importGame({ game: "pools", key: "gc-oa-1", payload: empty, digest: sha(empty), totals: { sum: 0, count: 0 } })).ok, true);
  const c = await act("create", actor("ann_cf", "ann"), { question: "Will the admin page work?", ai_judge: true, pepe: "PepeBot", secs: 3600 });
  assert.equal(c.ok, true, JSON.stringify(c));
  ref = c.ref;
  assert.equal((await act("bet", actor("ann_cf", "ann"), { ref, option: "yes", amount: 2000 })).ok, true);
  assert.equal((await act("bet", actor("bob_cf", "bob"), { ref, option: "no", amount: 3000 })).ok, true);
  await O.setMeta("enabled", true);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

const PROP = (key, extra = {}) => Object.assign({ key, kind: "pool", outcome: "yes", raw: "yes", result: "yes", confidence: 0.9, reason: "the logs say so",
  evidence: { text: "x" }, window_s: 3600, need_disputes: 2, pepe_login: "PepeBot" }, extra);
const setRow = (key, cols) => runQuery(`UPDATE oracle_proposals SET ${Object.keys(cols).map((c) => c + " = ?").join(", ")} WHERE key = ?`, [...Object.values(cols), key]);
const get = (url, who, headers = {}) => fetch(base + url, { redirect: "manual", headers: Object.assign(who ? { "x-test-user": who } : {}, headers) });
const post = (url, who, body, headers = {}) => fetch(base + url, { method: "POST", redirect: "manual", body: JSON.stringify(body),
  headers: Object.assign({ "Content-Type": "application/json", "X-Requested-With": "fetch" }, who ? { "x-test-user": who } : {}, headers) });

test("seed: proposals of every kind and state on fixed dates", async () => {
  // a site-owned pool, in its window (the real escrow pool)
  await O.propose(PROP("aj:pool:1:1", { ref, evidence: { text: "see https://example.com/a?b=1&c=<x> and javascript:alert(1) <script>alert('ev')</script>",
                                                         price: { source: "coinbase", symbol: "BTC", note: "<b>bold</b>" } },
                                         reason: 'He said "yes" <img src=x onerror=alert(1)>' }));
  await setRow("aj:pool:1:1", { created: D("2026-01-10"), until: Date.now() + DAY });
  // site-owned markets
  await O.propose(PROP("aj:market:60:1", { kind: "market", ref: "M60", outcome: "no", result: "no" }));
  await setRow("aj:market:60:1", { created: D("2026-01-05"), until: Date.now() + DAY });
  await O.propose(PROP("aj:market:61:1", { kind: "market", ref: "M61", outcome: "yes" }));
  await setRow("aj:market:61:1", { created: D("2026-01-06"), state: "failed", until: Date.now() - DAY, settle_result: JSON.stringify({ ok: false, error: "boom" }) });
  // Pepe-owned market, proposed and one disputed
  await O.propose(PROP("aj:market:70:1", { kind: "market", ref: "M70", outcome: "yes" }));
  await setRow("aj:market:70:1", { created: D("2026-01-07"), until: Date.now() + DAY });
  // a wager (site), settled long ago by the window
  await O.propose(PROP("aj:wager:5:1", { kind: "wager", ref: "W5", outcome: "ann_cf", result: "ann", need_disputes: 1 }));
  await setRow("aj:wager:5:1", { created: D("2025-12-20"), state: "settled", settled_at: D("2025-12-21"), until: D("2025-12-21") });
  // a due one
  await O.propose(PROP("aj:wager:6:1", { kind: "wager", ref: "W6", outcome: "bob_cf", need_disputes: 1 }));
  await setRow("aj:wager:6:1", { created: D("2025-12-22"), state: "due", until: D("2025-12-23") });
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM oracle_proposals"))[0].c, 6);
});

test("non-admins are refused: the page, the JSON and the actions", async () => {
  for (const who of [null, "u1", "u8"]) {
    const r = await get("/admin/oracle", who);
    assert.equal(r.status, 302, "page for " + who);
    assert.equal(r.headers.get("location"), "/login");
    assert.equal((await get("/api/admin/oracle/list", who)).status, 403);
    assert.equal((await get("/api/admin/oracle/proposal?key=aj:pool:1:1", who)).status, 403);
    const a = await post("/api/admin/oracle/act", who, { key: "aj:pool:1:1", action: "extend", minutes: 30, idem: idem() });
    assert.equal(a.status, 403);
  }
  assert.equal((await get("/admin/oracle", "u9")).status, 200);
  // an admin, but cross-site or without the fetch header
  assert.equal((await post("/api/admin/oracle/act", "u9", { key: "aj:pool:1:1", action: "extend", minutes: 30, idem: idem() }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/api/admin/oracle/act", "u9", { key: "aj:pool:1:1", action: "extend", minutes: 30, idem: idem() }, { "X-Requested-With": "" })).status, 403);
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM oracle_admin_actions"))[0].c, 0, "nothing ran");
});

test("the list: newest first, status / kind / date filters, the summary tiles", async () => {
  const keys = async (q) => (await O.adminList(q)).items.map((i) => i.key);
  assert.deepEqual(await keys({}), ["aj:pool:1:1", "aj:market:70:1", "aj:market:61:1", "aj:market:60:1", "aj:wager:6:1", "aj:wager:5:1"]);
  assert.deepEqual(await keys({ status: "window" }), ["aj:pool:1:1", "aj:market:70:1", "aj:market:60:1"]);
  assert.deepEqual(await keys({ status: "failed" }), ["aj:market:61:1"]);
  assert.deepEqual(await keys({ status: "due" }), ["aj:wager:6:1"]);
  assert.deepEqual(await keys({ status: "settled" }), ["aj:wager:5:1"]);
  assert.deepEqual(await keys({ kind: "wager" }), ["aj:wager:6:1", "aj:wager:5:1"]);
  assert.deepEqual(await keys({ kind: "market", status: "window" }), ["aj:market:70:1", "aj:market:60:1"]);
  assert.deepEqual(await keys({ from: "2026-01-06", to: "2026-01-07" }), ["aj:market:70:1", "aj:market:61:1"]);
  assert.deepEqual(await keys({ to: "2025-12-31" }), ["aj:wager:6:1", "aj:wager:5:1"]);
  assert.deepEqual(await keys({ status: "bogus", kind: "bogus", from: "nope" }), await keys({}), "bad filters are ignored");
  const page1 = await O.adminList({ limit: 2 });
  assert.equal(page1.more, true);
  assert.deepEqual((await O.adminList({ limit: 2, before: page1.next })).items.map((i) => i.key), ["aj:market:61:1", "aj:market:60:1"]);
  const w = (await O.adminList({ kind: "wager" })).items[1];
  assert.deepEqual([w.final_outcome, w.decided.by], ["ann_cf", "window"], "an older settled row: the outcome and the window as the settler");
  const s = await O.adminSummary();
  assert.deepEqual([s.window, s.disputed, s.due, s.failed], [3, 0, 1, 1]);
  // the HTTP list and the page with a filter
  const j = await (await get("/api/admin/oracle/list?status=window&kind=market", "u9")).json();
  assert.deepEqual(j.items.map((i) => i.key), ["aj:market:70:1", "aj:market:60:1"]);
  const html = await (await get("/admin/oracle?status=failed", "u9")).text();
  assert.match(html, /M61/);
  assert.doesNotMatch(html, /href="\/markets\/60"/, "filtered out");
  assert.match(html, /aria-current="page"/, "in the admin shell, its section marked");
});

test("the detail view escapes everything Pepe and the disputers wrote; evidence links are http(s) only", async () => {
  assert.equal((await O.dispute({ kind: "pool", ref, login: "ann_cf", why: "<img src=x onerror=alert(2)> wrong" })).n, 1);
  const html = await (await get("/admin/oracle?key=" + encodeURIComponent("aj:pool:1:1"), "u9")).text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<b>bold<\/b>/);
  assert.match(html, /&lt;script&gt;alert\(&#39;ev&#39;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt; wrong/, "the dispute's claim");
  assert.match(html, /He said &quot;yes&quot; &lt;img/, "the rationale");
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=" rel="noopener noreferrer nofollow ugc" target="_blank">/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /Exchange price check/, "the evidence parts are labelled");
  assert.match(html, /id="timeline"/);
  assert.match(html, /Dispute filed/);
  assert.match(html, /data-oa-action="reject_dispute" data-login="ann_cf"/);
  assert.equal(OA.linkify('a "b" https://x.y/"onmouseover=1'), 'a &quot;b&quot; <a href="https://x.y/" rel="noopener noreferrer nofollow ugc" target="_blank">https://x.y/</a>&quot;onmouseover=1');
  assert.equal(OA.evidenceHtml(null), "");
  const d = await O.adminDetail("aj:pool:1:1");
  assert.equal(d.can.owner, "site");
  assert.deepEqual([d.can.uphold.ok, d.can.override.ok, d.can.void.ok, d.can.extend.ok, d.can.reject_dispute.ok, d.can.reask.ok, d.can.reask.why],
                   [true, true, true, true, true, false, "no_caps"]);
  assert.equal((await get("/admin/oracle?key=nope", "u9")).status, 404);
});

test("extend: keyed (the same key once), audited, only while in the window", async () => {
  const before = (await O.adminDetail("aj:pool:1:1")).until;
  const k = idem();
  const r1 = await O.adminAct(BOSS, { key: "aj:pool:1:1", action: "extend", minutes: 30, idem: k });
  assert.equal(r1.until, before + 30 * 60000);
  const r2 = await O.adminAct(BOSS, { key: "aj:pool:1:1", action: "extend", minutes: 30, idem: k });
  assert.equal(r2.already, true);
  assert.equal((await O.adminDetail("aj:pool:1:1")).until, before + 30 * 60000, "extended once");
  await assert.rejects(O.adminAct(BOSS, { key: "aj:pool:1:1", action: "uphold", idem: k }), (e) => e.code === "E_IDEM_REUSED");
  await assert.rejects(O.adminAct(BOSS, { key: "aj:pool:1:1", action: "extend", minutes: 1, idem: idem() }), (e) => e.code === "E_BAD_MINUTES");
  await assert.rejects(O.adminAct(BOSS, { key: "aj:pool:1:1", action: "extend", minutes: 30, idem: "x" }), (e) => e.code === "E_BAD_IDEM");
  await assert.rejects(O.adminAct(BOSS, { key: "aj:market:61:1", action: "extend", minutes: 30, idem: idem() }), (e) => e.code === "E_STATE");
  const audit = await getQuery("SELECT * FROM admin_audit WHERE action = 'oracle.extend'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].admin_name, "boss");
  assert.equal(JSON.parse(audit[0].detail).key, "aj:pool:1:1");
  assert.ok((await O.feed(0)).events.some((e) => e.event === "extended" && e.data.idem === k));
});

test("reject a dispute: the escalated call goes back into its window; keyed", async () => {
  assert.equal((await O.dispute({ kind: "pool", ref, login: "bob_cf", why: "no" })).state, "disputed");
  await setRow("aj:pool:1:1", { until: Date.now() - 1000 });          // the window was already over
  const k = idem();
  const r = await O.adminAct(BOSS, { key: "aj:pool:1:1", action: "reject_dispute", login: "BOB_CF", reason: "he bet the other way", idem: k });
  assert.deepEqual([r.state, r.reopened, r.active], ["proposed", true, 1]);
  assert.ok(r.until >= Date.now() + 14 * 60000, "reopened for at least 15 minutes");
  assert.equal((await O.adminAct(BOSS, { key: "aj:pool:1:1", action: "reject_dispute", login: "bob_cf", idem: k })).already, true);
  await assert.rejects(O.adminAct(BOSS, { key: "aj:pool:1:1", action: "reject_dispute", login: "bob_cf", idem: idem() }), (e) => e.code === "E_NO_DISPUTE");
  assert.equal((await O.dispute({ kind: "pool", ref, login: "bob_cf" })).code, "already", "a rejected disputer can't file again");
  const d = await O.adminDetail("aj:pool:1:1");
  assert.equal(d.disputes.find((x) => x.login === "bob_cf").rejected.by, "boss");
  assert.deepEqual([d.n_disputes, d.n_active], [2, 1]);
  assert.ok(d.timeline.some((e) => e.ev === "dispute_rejected"));
  const html = await (await get("/admin/oracle?key=" + encodeURIComponent("aj:pool:1:1"), "u9")).text();
  assert.match(html, /Rejected by boss/);
});

test("uphold (settle now) on a site-owned pool: the real escrow settle, as the admin, once - the tick never settles it again", async () => {
  const a0 = await bal("u1");
  const k = idem();
  const res = await (await post("/api/admin/oracle/act", "u9", { key: "aj:pool:1:1", action: "uphold", reason: "checked the logs", idem: k })).json();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.state, "settled");
  const paid = (await bal("u1")) - a0;
  assert.ok(paid > 0, "the winner was paid");
  const rec = await G.load("pools", Number(ref.slice(1)));
  assert.deepEqual([rec.status, rec.result, rec.settled_by], ["settled", "yes", "boss_cf"]);
  const again = await (await post("/api/admin/oracle/act", "u9", { key: "aj:pool:1:1", action: "uphold", idem: k })).json();
  assert.equal(again.already, true, "the same click again answers the stored result");
  const other = await post("/api/admin/oracle/act", "u9", { key: "aj:pool:1:1", action: "override", outcome: "no", reason: "second thoughts", idem: idem() });
  assert.equal(other.status, 409, "a settled call can't be settled again");
  await setRow("aj:pool:1:1", { until: Date.now() - 1 });
  assert.deepEqual(await O.tick(), [], "the window's tick leaves it alone");
  assert.equal((await bal("u1")) - a0, paid, "paid once");
  const d = await O.adminDetail("aj:pool:1:1");
  assert.deepEqual([d.state, d.final_outcome, d.decided.by, d.decided.name, d.admin_reason], ["settled", "yes", "admin", "boss", "checked the logs"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM admin_audit WHERE action = 'oracle.uphold'"))[0].c, 1);
});

test("override: a different outcome, reason required, as the admin, keyed; void sends the void outcome", async () => {
  await assert.rejects(O.adminAct(BOSS, { key: "aj:market:60:1", action: "override", outcome: "yes", idem: idem() }), (e) => e.code === "E_NEED_REASON");
  await assert.rejects(O.adminAct(BOSS, { key: "aj:market:60:1", action: "override", outcome: "no", reason: "same thing", idem: idem() }), (e) => e.code === "E_SAME");
  await assert.rejects(O.adminAct(BOSS, { key: "aj:market:60:1", action: "override", outcome: "void x", reason: "use void", idem: idem() }), (e) => e.code === "E_USE_VOID");
  const k = idem();
  calls.length = 0;
  const r = await O.adminAct(BOSS, { key: "aj:market:60:1", action: "override", outcome: "yes", reason: "the source says yes", idem: k });
  assert.deepEqual([r.state, r.outcome], ["overridden", "yes"]);
  assert.equal((await O.adminAct(BOSS, { key: "aj:market:60:1", action: "override", outcome: "yes", reason: "the source says yes", idem: k })).already, true);
  assert.equal(calls.length, 1, "settled once");
  assert.deepEqual([calls[0].ref, calls[0].outcome, calls[0].admin, calls[0].login], ["M60", "yes", true, "boss_cf"]);
  assert.ok(calls[0].key.startsWith("aj:market:60:1:adm:"), "keyed by the click");
  const ev = (await O.feed(0)).events.filter((e) => e.key === "aj:market:60:1" && e.event === "settled");
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].data.override, ev[0].data.judge_outcome], [true, "no"]);
  assert.equal((await O.adminList({ status: "overridden" })).items[0].key, "aj:market:60:1");
  // a failed call can be settled by hand too; void
  calls.length = 0;
  const v = await O.adminAct(BOSS, { key: "aj:market:61:1", action: "void", reason: "the question was broken", idem: idem() });
  assert.deepEqual([v.state, v.outcome], ["overridden", "void the question was broken"]);
  assert.deepEqual(calls.map((c) => c.outcome), ["void the question was broken"]);
  assert.equal((await O.adminDetail("aj:market:61:1")).timeline.some((e) => e.ev === "voided"), true);
});

test("Pepe-owned: settle now turns it due on the feed; override / void are refused (he settles with his own copy)", async () => {
  let d = await O.adminDetail("aj:market:70:1");
  assert.deepEqual([d.can.owner, d.can.uphold.ok, d.can.override.ok, d.can.override.why], ["pepe", true, false, "pepe_owned"]);
  await assert.rejects(O.adminAct(BOSS, { key: "aj:market:70:1", action: "void", reason: "nope nope", idem: idem() }), (e) => e.code === "E_PEPE_OWNED");
  const r = await O.adminAct(BOSS, { key: "aj:market:70:1", action: "uphold", idem: idem() });
  assert.equal(r.state, "due");
  const due = (await O.feed(0)).events.filter((e) => e.key === "aj:market:70:1" && e.event === "due");
  assert.equal(due.length, 1);
  assert.equal(due[0].data.outcome, "yes");
  assert.equal((await O.settled({ key: "aj:market:70:1", ok: true })).state, "settled");
  d = await O.adminDetail("aj:market:70:1");
  assert.deepEqual([d.final_outcome, d.decided.by, d.decided.name], ["yes", "admin", "boss"], "the admin who called it, Pepe settled it");
  assert.equal((await O.settled({ key: "aj:market:70:1", ok: true })).already, true);
});

test("re-ask: only while Pepe's reader handles it; supersedes the call with a reask event", async () => {
  await O.propose(PROP("aj:wager:7:1", { kind: "wager", ref: "W7", outcome: "ann_cf", need_disputes: 1 }));
  await assert.rejects(O.adminAct(BOSS, { key: "aj:wager:7:1", action: "reask", idem: idem() }), (e) => e.code === "E_NO_CAPS");
  await O.noteCaps(["reask"]);
  const k = idem();
  const r = await O.adminAct(BOSS, { key: "aj:wager:7:1", action: "reask", reason: "new info", idem: k });
  assert.equal(r.state, "superseded");
  const ev = (await O.feed(0)).events.filter((e) => e.key === "aj:wager:7:1" && e.event === "reask");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].data.by, "boss");
  assert.equal((await O.adminAct(BOSS, { key: "aj:wager:7:1", action: "reask", idem: k })).already, true);
  await assert.rejects(O.adminAct(BOSS, { key: "aj:wager:7:1", action: "reask", idem: idem() }), (e) => e.code === "E_STATE");
  // the feed route records the caps Pepe sends
  const f = await (await fetch(base + "/api/oracle/bot/feed", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "bot", after: 0, caps: ["reask"] }) })).json();
  assert.equal(f.ok, true);
  assert.equal((await O.adminList({ status: "superseded" })).items.some((i) => i.key === "aj:wager:7:1"), true);
});

test("a dispute on a call an admin already decided is refused (it never re-opens a settled call)", async () => {
  assert.equal((await O.dispute({ kind: "market", ref: "M60", login: "x", checked: true })).code, "no_proposal");
  assert.equal((await O.adminDetail("aj:market:60:1")).state, "overridden");
});
