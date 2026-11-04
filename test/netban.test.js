// 1.99?? padppl: network bans (netban.js) - dark until switched on; keyed codes, never addresses; enforced at sign-up, sign-in and posting.
//   - OFF (the default): nothing recorded, nothing refused
//   - the code: HMAC keyed from SECRET_KEY (HKDF), IPv4 as is, IPv6 by its /64; only the trusted proxy's headers count, never a direct socket
//   - "this account's recent networks" catches the NEXT account from the same network (sign-up, sign-in, posting), site-wide or one pad
//   - a typed IP is stored only as its code; a range is a rule matched in memory; Staff and a ban's exempt accounts pass
//   - admins see how many OTHER accounts share an account's networks (names only) - every look logged with its reason
//   node --test test/netban.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "netban-")));
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const NB = require(path.join(repo, "netban"));

const U = {};
const ADM = { userId: "adm-0001", username: "boss", class: "Admin" };
let base, server;
// a request as it reaches the app: the socket is the local proxy (loopback), the address in CF-Connecting-IP
const req = (ip, { direct = false } = {}) => ({ socket: { remoteAddress: direct ? "203.0.113.200" : "127.0.0.1" }, get: (k) => (k.toLowerCase() === "cf-connecting-ip" ? ip : "") });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, archived_at INTEGER)`);
  for (const [k, id, name, cls] of [["har", "har-0001", "tricon", "pleb"], ["har2", "har-0002", "tricon2", "pleb"], ["mom", "mom-0001", "housemate", "pleb"],
                                    ["staff", "stf-0001", "staffer", "Staff"], ["adm", "adm-0001", "boss", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cls]);
    U[k] = { userId: id, username: name, class: cls };
  }
  await NB.init();
  // a small app with the gate the site puts in front of its write routes (index.js) - here for POST /api/feed/posts
  const app = express();
  app.use(express.json());
  app.use(async (rq, rs, next) => {
    if (rq.method !== "POST" || !NB.isOn()) return next();
    rq.user = U[rq.get("x-test-user")] || null;
    const why = await NB.refusal(rq, { user: rq.user });
    if (why) return rs.status(403).json({ ok: false, code: "network", error: why });
    if (rq.user) await NB.note(rq.user.userId, rq, "post");
    next();
  });
  app.post("/api/feed/posts", (rq, rs) => rs.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
const postAs = (u, ip) => fetch(base + "/api/feed/posts", { method: "POST", headers: { "content-type": "application/json", "x-test-user": u, "cf-connecting-ip": ip }, body: "{}" })
  .then(async (r) => ({ status: r.status, d: await r.json() }));

test("off (the default): nothing recorded, nothing refused", async () => {
  assert.equal(NB.isOn(), false);
  await NB.note("har-0001", req("198.51.100.7"), "signin");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM net_seen"))[0].n, 0);
  assert.equal(await NB.refusal(req("198.51.100.7"), {}), null);
  await assert.rejects(NB.banAccountNets(ADM, "har-0001", {}), (e) => e.status === 409);
});

test("the code: keyed with SECRET_KEY, IPv4 as is, IPv6 by its /64; never a raw address at rest; a direct socket never counts", async () => {
  await NB.setOn(ADM, true);
  const h4 = NB.netHash("198.51.100.7");
  assert.match(h4, /^[0-9a-f]{32}$/);
  assert.equal(NB.netHash("2001:db8:1:2:aaaa::1"), NB.netHash("2001:db8:1:2:bbbb::9"), "one /64 = one network");
  assert.notEqual(NB.netHash("2001:db8:1:2::1"), NB.netHash("2001:db8:1:3::1"));
  assert.notEqual(h4, require("crypto").createHash("sha256").update("198.51.100.7").digest("hex").slice(0, 32), "not a plain hash anyone can rebuild");
  await NB.note("har-0001", req("198.51.100.7"), "signin");
  await NB.note("har-0001", req("198.51.100.7", { direct: true }), "session");
  const rows = await getQuery("SELECT * FROM net_seen");
  assert.equal(rows.length, 1, "the direct socket wasn't recorded");
  assert.doesNotMatch(JSON.stringify(rows), /198\.51\.100\.7/, "no raw address anywhere in the row");
  assert.equal(rows[0].kinds & NB.KIND.signin, NB.KIND.signin);
  // another secret -> another code (a database alone can't be matched against guesses)
  const was = process.env.SECRET_KEY; process.env.SECRET_KEY = "another"; NB._resetKey();
  assert.notEqual(NB.netHash("198.51.100.7"), h4);
  process.env.SECRET_KEY = was; NB._resetKey();
  assert.equal(NB.netHash("198.51.100.7"), h4);
});

test("an account's recent networks: the harasser's NEXT account is refused at sign-up, sign-in and posting; others on other networks pass", async () => {
  const r = await NB.banAccountNets(ADM, "har-0001", { scope: "site", reason: "harassment", days: 7 });
  assert.equal(r.networks, 1);
  const why = await NB.refusal(req("198.51.100.7"), {});
  assert.equal(why, NB.REFUSAL);
  assert.doesNotMatch(why, /\d+\.\d+/, "the refusal never names an address");
  // sign-up (no account yet) and sign-in (sessions.signIn asks refusal(req, {user}))
  assert.equal(await NB.refusal(req("198.51.100.7"), { user: U.har2 }), NB.REFUSAL, "the second account, from the same network");
  const S = require(path.join(repo, "sessions"));
  await assert.rejects(S.signIn(req("198.51.100.7"), { cookie() {} }, U.har2, "password"), (e) => e.status === 403 && e.code === "network");
  // posting through the gate
  assert.equal((await postAs("har2", "198.51.100.7")).status, 403);
  assert.equal((await postAs("har2", "192.0.2.50")).status, 200, "another network");
  // Staff pass every network ban
  assert.equal(await NB.refusal(req("198.51.100.7"), { user: U.staff }), null);
  // the audit names the account the ban came from
  const a = await getQuery("SELECT target_id, detail FROM admin_audit WHERE action = 'net_ban' AND target_id = 'har-0001'");
  assert.equal(a.length, 1);
  assert.doesNotMatch(a[0].detail, /198\.51/);
});

test("admins: who shares these networks (names only, logged with the reason); an exempt account passes", async () => {
  await NB.note("mom-0001", req("198.51.100.7"), "signin");
  const s = await NB.shared(ADM, "har-0001", { reason: "ban sheet" });
  assert.deepEqual(s, { on: true, networks: 1, shared: 1 });
  await assert.rejects(NB.sharedDetail(ADM, "har-0001", ""), (e) => e.status === 400, "a reason every time");
  const d = await NB.sharedDetail(ADM, "har-0001", "harassment report #12");
  assert.deepEqual(d.shared.map((x) => x.username), ["housemate"]);
  assert.doesNotMatch(JSON.stringify(d), /[0-9a-f]{32}|198\.51/, "never a code or an address");
  const views = await getQuery("SELECT admin_id, subject_id, reason FROM net_views ORDER BY id");
  assert.deepEqual(views.map((v) => v.reason), ["ban sheet", "harassment report #12"]);
  await assert.rejects(NB.shared(U.staff, "har-0001"), (e) => e.status === 403, "Admins only");
  // the housemate is let through this ban
  const ban = (await getQuery("SELECT id FROM net_bans WHERE from_user = 'har-0001'"))[0];
  await runQuery("INSERT INTO net_ban_exempt (ban_id, user_id) VALUES (?, 'mom-0001')", [ban.id]);
  await NB.reload();
  assert.equal(await NB.refusal(req("198.51.100.7"), { user: U.mom }), null);
  assert.equal(await NB.refusal(req("198.51.100.7"), { user: U.har2 }), NB.REFUSAL);
  await NB.lift(ADM, ban.id);
  assert.equal(await NB.refusal(req("198.51.100.7"), {}), null, "lifted");
});

test("a typed IP (stored as its code only), a range (a rule), and a pad-scope ban that applies in that pad only", async () => {
  await NB.banTyped(ADM, { ip: "192.0.2.77", reason: "x", days: 1 });
  const row = (await getQuery("SELECT * FROM net_bans WHERE lifted_at IS NULL ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(row.cidr, null); assert.equal(row.net_hash, NB.netHash("192.0.2.77"));
  assert.doesNotMatch(JSON.stringify(row), /192\.0\.2\.77/);
  assert.equal(await NB.refusal(req("192.0.2.77"), {}), NB.REFUSAL);
  await NB.banTyped(ADM, { cidr: "203.0.113.0/24", reason: "proxy farm", days: 1 });
  assert.equal(await NB.refusal(req("203.0.113.45"), {}), NB.REFUSAL);
  assert.equal(await NB.refusal(req("203.0.114.45"), {}), null);
  await NB.banTyped(ADM, { cidr: "2001:db8:abcd::/48", days: 1 });
  assert.equal(await NB.refusal(req("2001:db8:abcd:12::5"), {}), NB.REFUSAL);
  await assert.rejects(NB.banTyped(ADM, { cidr: "10.0.0.0/4" }), (e) => e.status === 400, "too wide");
  await assert.rejects(NB.banTyped(ADM, { ip: "not an ip" }), (e) => e.status === 400);
  for (const b of await NB.listBans(ADM)) await NB.lift(ADM, b.id);
  await NB.banTyped(ADM, { ip: "192.0.2.88", scope: "pad", roomId: "drama_central", days: 1 });
  assert.equal(await NB.refusal(req("192.0.2.88"), { roomId: "drama_central" }), NB.REFUSAL);
  assert.equal(await NB.refusal(req("192.0.2.88"), { roomId: "another_pad" }), null, "pad scope: that pad only");
  assert.equal(await NB.refusal(req("192.0.2.88"), {}), null, "not a site-wide refusal (sign-up, sign-in)");
});

test("retention: codes go 90 days after their last use; the switch off stops recording again", async () => {
  const t0 = Date.now();
  NB._setClock(() => t0 + 91 * 86400e3);
  await NB.sweep();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM net_seen"))[0].n, 0);
  NB._setClock(() => Date.now());
  await NB.setOn(ADM, false);
  await NB.note("har-0001", req("198.51.100.7"), "signin");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM net_seen"))[0].n, 0);
});

// ── 1.99?? padppl review fixes ──
test("review: one /64 is ONE code however it is spelled, and a compressed zero run never leaks interface bits into it", async () => {
  assert.equal(NB.netOf("2001:db8:1::5"), "2001:db8:1:0::/64");
  assert.equal(NB.netOf("2001:db8:1:0:abcd::5"), "2001:db8:1:0::/64");
  assert.equal(NB.netHash("2001:db8:1::5"), NB.netHash("2001:db8:1:0:abcd::5"), "the reviewer's pair: one network");
  assert.equal(NB.netOf("2001:db8::1:2:3:4"), "2001:db8:0:0::/64", "only the first half - the privacy-address bits are dropped");
  assert.equal(NB.netHash("2001:db8::1:2:3:4"), NB.netHash("2001:db8::9:9:9:9"), "a harasser rotating privacy addresses stays on one code");
  assert.equal(NB.netOf("[2001:DB8:1::5]"), "2001:db8:1:0::/64");
  assert.equal(NB.netOf("::ffff:198.51.100.7"), "198.51.100.7", "a v4-mapped address is its IPv4");
  assert.equal(NB.netOf("nonsense"), null);
});

test("review: a member caught on a shared network is let through (exempt) without lifting the ban; 'which bans hit them'; one row per account ban", async () => {
  await NB.setOn(ADM, true);
  await NB.note("har-0001", req("203.0.113.9"), "signin");
  await NB.note("har-0001", req("203.0.113.10"), "signin");
  await NB.note("mom-0001", req("203.0.113.9"), "signin");
  const r = await NB.banAccountNets(ADM, "har-0001", { scope: "site", reason: "again", days: 7 });
  assert.ok(r.networks >= 2);
  const list = (await NB.listBans(ADM)).filter((b) => b.kind === "account" && b.reason === "again");
  assert.equal(list.length, 1, "an account's networks are ONE row");
  assert.ok(list[0].ids.length >= 2 && list[0].n === list[0].ids.length);
  assert.equal(await NB.refusal(req("203.0.113.9"), { user: U.mom }), NB.REFUSAL);
  await assert.rejects(NB.hitting(ADM, "mom-0001", ""), (e) => e.status === 400, "a reason every time");
  const hit = await NB.hitting(ADM, "mom-0001", "support ticket 7");
  assert.ok(hit.length >= 1 && hit.every((b) => b.from === "tricon"));
  assert.doesNotMatch(JSON.stringify(hit), /[0-9a-f]{32}|203\.0/, "never a code or an address");
  const ex = await NB.exempt(ADM, "mom-0001", [], "support ticket 7");
  assert.ok(ex.n >= 1);
  assert.equal(await NB.refusal(req("203.0.113.9"), { user: U.mom }), null, "let through");
  assert.equal(await NB.refusal(req("203.0.113.9"), { user: U.har2 }), NB.REFUSAL, "the ban still stands for everyone else");
  assert.equal((await NB.hitting(ADM, "mom-0001", "check")).length, 0);
  await NB.lift(ADM, list[0].ids);
  assert.equal(await NB.refusal(req("203.0.113.10"), {}), null, "the whole row lifted at once");
});

test("review: sign-in is gated where the account is known (staff / exempt pass a password form); sign-up refused before the account exists", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const gate = idx.slice(idx.indexOf("const NB_ROUTES_ = ["), idx.indexOf("app.use(async (req, res, next) => {", idx.indexOf("const NB_ROUTES_ = [")));
  assert.doesNotMatch(gate, /\/login|\/register/, "no /login or /register in the write-route gate");
  for (const p of ["/api/feed/posts", "/api/feed/posts/p1/comments", "/api/feed/comments/c1/edit", "/api/stories/s1/reply", "/api/messages/uploads", "/api/messages/groups",
                   "/api/messages/c/x/rename", "/api/rooms/drama/camclip", "/api/rooms/drama/micclip", "/api/rooms/drama/pepe", "/api/rooms/drama/stage/cam", "/api/stage/book", "/api/feed/aigen/start"]) {
    const routes = new Function("return " + gate.slice(gate.indexOf("["), gate.lastIndexOf("]") + 1))();
    assert.ok(routes.some((r) => r[0].test(p)), p + " is covered");
  }
  assert.match(fs.readFileSync(path.join(repo, "user.controller.js"), "utf8"), /a network ban \(netban\.js\) refuses a new account here, on the form with its message/);
  assert.equal((idx.match(/const nbWhy_ = await require\("\.\/netban"\)\.newAccountRefusal\(req\);\r?\n\s+if \(nbWhy_\) return oauthFail\(req, res, nbWhy_\);/g) || []).length, 2, "Twitch + Discord: before the account is made");
  assert.match(fs.readFileSync(path.join(repo, "netban.js"), "utf8"), /app\.post\("\/api\/admin\/nets"/, "the look is a POST (the reason never in a URL)");
});
