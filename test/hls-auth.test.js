// Offline tests for 1.99gk hlsauth.js: nginx auth_request for RTMP-slot HLS (/hls/...) on Approved pads.
//   the decision matrix (stream kinds x pad levels x viewers x token / IP / cookie), the loopback-only route,
//   speed (no DB per segment: the stream -> pad lookup happens once per stream), cache flushes on access changes,
//   and the player keeping ?pt= on every VHS request (stage-player.js withPt).
//   NODE_PATH=G:/PATV/node_modules node --test test/hls-auth.test.js      (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hlsauth-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const jwt = require("jsonwebtoken");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const S = require(path.join(repo, "mainstage"));
const HA = require(path.join(repo, "hlsauth"));

const PUB = "pub.Room", MEM = "mem.Room", APP = "app.Room";
const STREAM = { pub: "stage-00000000000000a1", mem: "stage-00000000000000a2", app: "stage-00000000000000a3", appEnded: "stage-00000000000000a4" };
const U = {};
async function mkUser(name, cls = "pleb") {
  const id = "u_" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cls]);
  return { userId: id, username: name, class: cls };
}
const cookieOf = (u) => "foo=bar; jwt=" + jwt.sign({ userId: u.userId, username: u.username }, process.env.SECRET_KEY);
const uriOf = (stream, file = ".m3u8", q = "") => "/hls/" + stream + file + (q ? "?" + q : "");
const ptq = (u, stream) => "pt=" + encodeURIComponent(PA.readToken(u.userId, stream));
let ipN = 0;
const freshIp = () => "203.0.113." + (++ipN);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  U.owner = await mkUser("padowner");
  U.admin = await mkUser("siteadmin", "Admin");
  U.staff = await mkUser("sitestaff", "Staff");
  U.member = await mkUser("plainmember");
  U.approved = await mkUser("invitee");
  await rooms.init();
  for (const [id, t] of [[PUB, "Open"], [MEM, "Lounge"], [APP, "Garden"]]) {
    await rooms.addRoom(id, t, "test");
    await rooms.setOwner(id, "padowner", "test");
  }
  await PA.init();
  await PA.setLevel(U.owner, await rooms.get(PUB), "public");
  await PA.setLevel(U.owner, await rooms.get(APP), "approved");
  await PA.request(U.approved, await rooms.get(APP), "hi");
  await PA.decide(U.owner, await rooms.get(APP), U.approved.userId, true);
  await S.init();
  const now = Date.now();
  const slot = (id, stream, room, status) => runQuery(`INSERT INTO stage_slots (id, userId, username, status, created, max_minutes, price_per_min, held, stream, room_id)
      VALUES (?, ?, 'streamer', ?, ?, 30, 0, 0, ?, ?)`, [id, U.owner.userId, status, now, stream, room]);
  await slot("s1", STREAM.pub, PUB, "active");
  await slot("s2", STREAM.mem, MEM, "active");
  await slot("s3", STREAM.app, APP, "active");
  await slot("s4", STREAM.appEnded, APP, "ended");
  const app = express();
  HA.register(app);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

const decide = (o) => HA.decide(o).then((d) => d.ok);

test("not Approved / not ours: open as before (no token, no login)", async () => {
  const ip = freshIp();
  assert.equal(await decide({ uri: "/hls/broadcast.m3u8", ip }), true, "Pepe's stream (nginx never asks, but if it did)");
  assert.equal(await decide({ uri: "/hls/broadcast-123.ts", ip }), true);
  assert.equal(await decide({ uri: uriOf(STREAM.pub), ip }), true, "Public pad");
  assert.equal(await decide({ uri: uriOf(STREAM.pub, "-7.ts"), ip }), true);
  assert.equal(await decide({ uri: uriOf(STREAM.mem), ip }), true, "Members pad (the stage stream was public there before)");
  assert.equal(await decide({ uri: uriOf("stage-ffffffffffffffff"), ip }), true, "a name no slot ever had");
  assert.equal(await decide({ uri: "/hls/staging/" + "stg-00000000000000a3.m3u8", ip }), false, "the other site's prefix: a misroute is refused");
});

test("Approved pad: refused without a token / login, playlists AND segments", async () => {
  for (const f of [".m3u8", "-1.ts", "-123456.ts"]) {
    assert.equal(await decide({ uri: uriOf(STREAM.app, f), ip: freshIp() }), false, f);
    assert.equal(await decide({ uri: uriOf(STREAM.app, f, "pt=r1.123.abc.def"), ip: freshIp() }), false, "junk token " + f);
  }
  assert.equal(await decide({ uri: uriOf(STREAM.appEnded), ip: freshIp() }), false, "an ENDED slot's leftovers stay locked");
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", ptq(U.approved, STREAM.pub)), ip: freshIp() }), false, "a token for another stream");
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", ptq(U.member, STREAM.app)), ip: freshIp() }), false, "a signed token for an outsider");
  assert.equal(await decide({ uri: uriOf(STREAM.app), ip: freshIp(), cookie: cookieOf(U.member) }), false, "an outsider's login");
  assert.equal(await decide({ uri: uriOf(STREAM.app), ip: freshIp(), cookie: "jwt=" + jwt.sign({ userId: U.owner.userId }, "wrong-secret") }), false, "a forged login");
  const old = "pt=" + encodeURIComponent(PA.readToken(U.approved.userId, STREAM.app, Date.now() - 3 * 24 * 3600e3));
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", old), ip: freshIp() }), false, "an expired token");
});

test("Approved pad: a member's token, then the same IP's segments; owner / admin / staff tokens; logins", async () => {
  const ip = freshIp();
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", ptq(U.approved, STREAM.app)), ip }), true, "member token on the playlist");
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-5.ts"), ip }), true, "same IP, segment without the query");
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-5.ts"), ip: freshIp() }), false, "another IP without one");
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-6.ts", ptq(U.approved, STREAM.app)), ip: freshIp() }), true, "a segment carrying the token (the player hook)");
  for (const v of ["owner", "admin", "staff"]) {
    assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", ptq(U[v], STREAM.app)), ip: freshIp() }), true, v + " token");
  }
  for (const v of ["approved", "owner", "admin", "staff"]) {
    const ip2 = freshIp();
    assert.equal(await decide({ uri: uriOf(STREAM.app, "-9.ts"), ip: ip2, cookie: cookieOf(U[v]) }), true, v + " login cookie");
    assert.equal(await decide({ uri: uriOf(STREAM.app, "-10.ts"), ip: ip2 }), true, v + ": the login remembered the IP");
  }
});

test("access changes take effect at once (decision cache + remembered IPs are flushed)", async () => {
  const ip = freshIp(), q = ptq(U.approved, STREAM.app);
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", q), ip }), true);
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-1.ts"), ip }), true);
  await PA.remove(U.owner, await rooms.get(APP), U.approved.userId);
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", q), ip }), false, "removed: the cached allow is gone");
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-1.ts"), ip }), false, "...and the remembered IP");
  assert.equal(await decide({ uri: uriOf(STREAM.app), ip, cookie: cookieOf(U.approved) }), false, "...and the login");
  await runQuery("UPDATE pad_members SET status = 'approved' WHERE room_id = ? AND user_id = ?", [APP, U.approved.userId]);
  await PA.load(); HA.flush();
  assert.equal(await decide({ uri: uriOf(STREAM.app, ".m3u8", q), ip }), true, "re-approved");
  // the pad goes Public: open for everyone
  await PA.setLevel(U.owner, await rooms.get(APP), "public");
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-3.ts"), ip: freshIp() }), true, "Public now");
  await PA.setLevel(U.owner, await rooms.get(APP), "approved");
  assert.equal(await decide({ uri: uriOf(STREAM.app, "-3.ts"), ip: freshIp() }), false, "Approved again");
});

test("speed: no DB per segment (one stream -> pad lookup), thousands of checks in well under a second", async () => {
  HA._reset();
  const ip = freshIp(), q = ptq(U.approved, STREAM.app);
  const t0 = process.hrtime.bigint();
  const N = 3000;
  for (let i = 0; i < N; i++) {
    await HA.decide({ uri: uriOf(STREAM.app, "-" + i + ".ts", q), ip });
    await HA.decide({ uri: uriOf(STREAM.pub, "-" + i + ".ts"), ip });
    await HA.decide({ uri: uriOf(STREAM.app, "-" + i + ".ts"), ip: "198.51.100.9", cookie: cookieOf(U.owner) });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(HA.stats.db, 2, "one stage_slots lookup per stream, then memory only");
  assert.ok(HA.stats.cached >= 2 * N - 10, "repeat viewers hit the decision cache");
  assert.ok(ms / (3 * N) < 0.5, `per check ${(ms / (3 * N)).toFixed(4)} ms`);
  // concurrent first requests for a new stream share ONE lookup
  HA._reset();
  await Promise.all(Array.from({ length: 50 }, (_, i) => HA.decide({ uri: uriOf(STREAM.mem, "-" + i + ".ts"), ip })));
  assert.equal(HA.stats.db, 1);
});

test("the route: loopback-only, no proxy headers; 200/403 with no body; a DB failure is a 500 (nginx fails closed)", async () => {
  const hit = (headers) => fetch(base + "/api/stage/hls-auth", { headers });
  let r = await hit({ "x-original-uri": uriOf(STREAM.app), "x-hls-client-ip": freshIp() });
  assert.equal(r.status, 403);
  assert.equal(await r.text(), "");
  r = await hit({ "x-original-uri": uriOf(STREAM.app, ".m3u8", ptq(U.approved, STREAM.app)), "x-hls-client-ip": freshIp() });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-hls-auth"), "token");
  r = await hit({ "x-original-uri": uriOf(STREAM.app), "x-hls-client-ip": freshIp(), cookie: cookieOf(U.admin) });
  assert.equal(r.status, 200, "login cookie via the Cookie header");
  r = await hit({ "x-original-uri": uriOf(STREAM.pub), "x-hls-client-ip": freshIp() });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("set-cookie"), null, "no session cookie (registered before the session middleware)");
  // through the public proxy (it always sets these): refused even for an open stream
  for (const h of ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
    r = await hit({ "x-original-uri": uriOf(STREAM.pub), [h]: "1.2.3.4" });
    assert.equal(r.status, 403, h);
  }
  HA._reset();
  const orig = HA.roomOf;
  await runQuery("ALTER TABLE stage_slots RENAME TO stage_slots_x");
  try {
    r = await hit({ "x-original-uri": uriOf(STREAM.app), "x-hls-client-ip": freshIp() });
    assert.equal(r.status, 500, "lookup failed -> 500 -> nginx refuses");
  } finally {
    await runQuery("ALTER TABLE stage_slots_x RENAME TO stage_slots");
    assert.equal(HA.roomOf, orig);
  }
});

test("index.js registers the route before the session middleware", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const a = src.indexOf('require("./hlsauth").register(app)'), b = src.indexOf("app.use(cookieParser("), c = src.indexOf("session({");
  assert.ok(a > 0 && a < b && a < c);
});

// ── the player (stage-player.js) ──
function playerApi() {
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-player.js"), "utf8");
  const ctx = { window: {}, Math, Number, Infinity, String, encodeURIComponent, decodeURIComponent };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.window.PATVStage._pt;
}

test("stage-player.js puts the stream's ?pt= back on every VHS request (child playlists, segments) and keeps it on retries", () => {
  const P = playerApi();
  const tok = "r1.1800000000000.dV9pbnZpdGVl.abcdefghijklmnopqrstuvwxyz012345";
  P.notePt("https://publicaccess.tv/hls/" + STREAM.app + ".m3u8?pt=" + encodeURIComponent(tok));
  assert.equal(P.withPt("https://publicaccess.tv/hls/" + STREAM.app + "-17.ts"), "https://publicaccess.tv/hls/" + STREAM.app + "-17.ts?pt=" + encodeURIComponent(tok));
  assert.equal(P.withPt("https://stream.publicaccess.tv/" + STREAM.app + "/video1_stream.m3u8?_HLS_msn=4"),
    "https://stream.publicaccess.tv/" + STREAM.app + "/video1_stream.m3u8?_HLS_msn=4&pt=" + encodeURIComponent(tok), "MediaMTX child playlist");
  const has = "https://publicaccess.tv/hls/" + STREAM.app + ".m3u8?pt=x";
  assert.equal(P.withPt(has), has, "idempotent (both hooks may run)");
  assert.equal(P.withPt("https://publicaccess.tv/hls/broadcast-3.ts"), "https://publicaccess.tv/hls/broadcast-3.ts", "other streams untouched");
  assert.equal(P.withPt("https://publicaccess.tv/hls/" + STREAM.pub + "-3.ts"), "https://publicaccess.tv/hls/" + STREAM.pub + "-3.ts", "no token for that stream");
  // the retry's cache-buster no longer glues "?r=" onto a URL that already has a query (it corrupted the token)
  assert.equal(P.addQ("https://x/hls/a.m3u8?pt=T", "r=1"), "https://x/hls/a.m3u8?pt=T&r=1");
  assert.equal(P.addQ("https://x/hls/broadcast.m3u8", "r=1"), "https://x/hls/broadcast.m3u8?r=1");
  const src = fs.readFileSync(path.join(repo, "public", "js", "stage-player.js"), "utf8");
  assert.ok(!src.includes("SRC + '?r='"));
  for (const v of ["home.ejs", "room.ejs"]) assert.match(fs.readFileSync(path.join(repo, "views", v), "utf8"), /stage-player\.js\?v=8/);
});

test("deploy/hls-auth: broadcast bypasses auth_request; slot paths are gated; staging routes to :3100", () => {
  const dir = path.join(repo, "deploy", "hls-auth");
  const snip = fs.readFileSync(path.join(dir, "patv-hls.conf"), "utf8");
  const http = fs.readFileSync(path.join(dir, "patv-hls-auth-upstreams.conf"), "utf8");
  const blocks = snip.split(/\n(?=\s*location )/);
  const bc = blocks.find((b) => /location ~ "\^\/hls\/broadcast/.test(b));
  assert.ok(bc && !/auth_request/.test(bc), "broadcast has its own location without auth_request");
  assert.ok(snip.indexOf('location ~ "^/hls/broadcast') < snip.indexOf('location ~ "^/hls/staging/'), "broadcast first (regex order)");
  assert.ok(snip.indexOf('location ~ "^/hls/staging/') < snip.indexOf('location ~ "^/hls/.*'), "staging before the prod catch");
  const stg = blocks.find((b) => /location ~ "\^\/hls\/staging\//.test(b));
  assert.match(stg, /auth_request \/_hls_auth_staging;/);
  const prod = blocks.find((b) => /location ~ "\^\/hls\/\.\*/.test(b) || /location ~ "\^\/hls\/\[\^/.test(b));
  assert.match(prod, /auth_request \/_hls_auth;/);
  assert.match(snip, /location = \/_hls_auth \{[^}]*internal;[^}]*proxy_pass http:\/\/patv_hls_auth_prod\/api\/stage\/hls-auth;/);
  assert.match(snip, /location = \/_hls_auth_staging \{[^}]*internal;[^}]*proxy_pass http:\/\/patv_hls_auth_staging\/api\/stage\/hls-auth;/);
  for (const h of ["X-Forwarded-For", "X-Real-IP", "CF-Connecting-IP"]) assert.match(snip, new RegExp("proxy_set_header " + h + ' "";'));
  assert.match(http, /server 127\.0\.0\.1:3000/);
  assert.match(http, /server 127\.0\.0\.1:3100/);
  // the regexes match what they should
  const re = (b) => new RegExp(/location ~ "([^"]+)"/.exec(b)[1]);
  assert.ok(re(bc).test("/hls/broadcast.m3u8") && re(bc).test("/hls/broadcast-16607.ts"));
  assert.ok(!re(bc).test("/hls/" + STREAM.app + ".m3u8"));
  assert.ok(re(stg).test("/hls/staging/stg-0123456789abcdef.m3u8") && re(stg).test("/hls/staging/stg-0123456789abcdef-4.ts"));
  assert.ok(re(prod).test("/hls/stage-0123456789abcdef.m3u8") && re(prod).test("/hls/stage-0123456789abcdef-4.ts"));
  assert.ok(!re(prod).test("/hls/broadcast.m3u8"));
});
