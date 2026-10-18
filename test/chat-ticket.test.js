// 1.99acf chatticket.js: v1 chat tickets (the chat design §2.2). Off by default (503) and off with a missing or unusable key
// (never logged); with a key: a live sign-in session + a same-origin fetch, the claims exactly §2.2's set (exp = iat + 300,
// sid = sessions.id[:32]), an EdDSA signature that verifies against the JWKS (current + previous kid), a revoked session ->
// 401, an archived account -> 403, the rate limit, legacy ids (E_LEGACY_ID, or uuidv5 with CHAT_GENESIS_NS); and
// tools/chat-ticket-key.js (a new 0600 file, never stdout, never overwrite, prints no private key).
//   node --test test/chat-ticket.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-ticket-test-"));
process.chdir(dir);
delete process.env.STAGING;
for (const k of ["CHAT_TICKET_KEY", "CHAT_TICKET_KID", "CHAT_TICKET_PREV_PUB", "CHAT_TICKET_PREV_KID", "CHAT_GENESIS_NS", "HUB_V1_URL"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "sessions"));
const CT = require(path.join(repo, "chatticket"));
const HO = require(path.join(repo, "huboutbox"));

const ANN = "7d3c0b1e-1111-4a2b-8c3d-0123456789ab";
const BOB = "2b9f1c4d-2222-4e5f-9a6b-abcdefabcdef";
const OLD = "rh-legacy-row-1";
const printed = [];
for (const k of ["log", "error", "warn"]) { const o = console[k]; console[k] = (...a) => { printed.push(a.map(String).join(" ")); return o.apply(console, a); }; }

const b64 = (k) => k.export({ format: "der", type: "pkcs8" }).toString("base64");
const pair = () => crypto.generateKeyPairSync("ed25519");
let base, server;
const fakeReq = { get: (h) => (h === "user-agent" ? "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" : "") };
async function cookieFor(userId) {
  const { sid, id } = await S.create(fakeReq, userId, "password");
  return { cookie: jwt.sign({ userId, username: userId, class: "pleb", sid }, process.env.SECRET_KEY), id };
}
const ticket = (c, extra = {}) => fetch(base + "/api/chat/ticket", { method: "POST",
  headers: Object.assign({ cookie: c ? "jwt=" + c : "", origin: base, "x-requested-with": "fetch", "content-type": "application/json" }, extra), body: "{}" });
const decode = (tok) => tok.split(".").slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString()));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb', level INTEGER DEFAULT 0,
                  email TEXT, isEmailVerified INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, password, class, level, camfrogUsername) VALUES (?, 'ann', 'x', 'Staff', 7, 'AnnCF')", [ANN]);
  await runQuery("INSERT INTO users (userId, username, password, class, level) VALUES (?, 'bob', 'x', 'pleb', 2)", [BOB]);
  await runQuery("INSERT INTO users (userId, username, password, class, level) VALUES (?, 'oldie', 'x', 'pleb', 1)", [OLD]);
  await S.init(); await HO.init();
  const app = express();
  app.use(cookieParser());
  app.use(S.gate);
  app.use(express.json());
  const addUser = (req, res, next) => {          // index.js addUser, condensed: the (still valid) cookie's user
    req.user = null;
    const tok = req.cookies.jwt;
    if (tok) { try { req.user = jwt.verify(tok, process.env.SECRET_KEY); } catch (e) { req.user = null; } }
    next();
  };
  CT.register(app, { addUser });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("off by default: no key -> 503 E_FEATURE_OFF and no JWKS; an unusable key is off too and never logged", async () => {
  CT._reload();
  const { cookie } = await cookieFor(ANN);
  let r = await ticket(cookie);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { ok: false, code: "E_FEATURE_OFF" });
  assert.equal((await fetch(base + "/.well-known/patv-jwks.json")).status, 404);
  process.env.CHAT_TICKET_KEY = "bm90LWEta2V5LWF0LWFsbC1zZWNyZXQtdmFsdWU=";
  process.env.CHAT_TICKET_KID = "v1-2026-10";
  CT._reload();
  assert.equal(CT.status().key, false);
  assert.ok(printed.some((l) => /CHAT_TICKET_KEY/.test(l)), "one log line names the variable");
  assert.ok(!printed.join("\n").includes(process.env.CHAT_TICKET_KEY), "never its value");
  // a real key but the switch off: still 503 - though the JWKS is served so the hub can fetch it first
  process.env.CHAT_TICKET_KEY = b64(pair().privateKey);
  CT._reload();
  assert.equal((await ticket(cookie)).status, 503);
  assert.equal((await fetch(base + "/.well-known/patv-jwks.json")).status, 200);
  // tickets need the revocation feed and the heartbeat: the switch alone can't be turned on, and a row forced past that
  // (an admin script) still doesn't mint - a sign-out has to reach the hub before its resume credential outlives it
  await assert.rejects(HO.setSettings({ tickets: true }), (e) => e.code === "tickets_need" && e.status === 409);
  await assert.rejects(HO.setSettings({ tickets: true, sessions: true }), (e) => e.code === "tickets_need", "the heartbeat too");
  await runQuery("INSERT INTO hubseam_settings (key, value) VALUES ('tickets', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  await HO.reloadSettings();
  assert.equal(HO.on("tickets"), true);
  let r2 = await ticket(cookie);
  assert.equal(r2.status, 503, "tickets on, sessions + heartbeat off: no ticket");
  assert.deepEqual(await r2.json(), { ok: false, code: "E_FEATURE_OFF" });
  assert.equal(CT.status().on, false, "the page shows tickets as off");
  await runQuery("UPDATE hubseam_settings SET value = 'false' WHERE key = 'tickets'");
  await HO.reloadSettings();
});

let CUR, PREV;
test("with a key: session + same-origin fetch required; the claims are exactly §2.2's; the signature verifies against the JWKS", async () => {
  CUR = pair(); PREV = pair();
  process.env.CHAT_TICKET_KEY = b64(CUR.privateKey);
  process.env.CHAT_TICKET_KID = "v1-2026-10";
  process.env.CHAT_TICKET_PREV_PUB = PREV.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  process.env.CHAT_TICKET_PREV_KID = "v1-2026-09";
  CT._reload();
  await HO.setSettings({ tickets: true, sessions: true, heartbeat: true });
  const { cookie, id } = await cookieFor(ANN);
  assert.equal((await ticket(null)).status, 401, "signed out");
  assert.equal((await ticket(cookie, { "x-requested-with": "" })).status, 403, "no X-Requested-With");
  assert.equal((await ticket(cookie, { origin: "https://evil.example" })).status, 403, "another origin");
  const r = await ticket(cookie);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.kid, "v1-2026-10");
  const [hdr, claims] = decode(j.token);
  assert.deepEqual(hdr, { alg: "EdDSA", typ: "JWT", kid: "v1-2026-10" });
  assert.deepEqual(Object.keys(claims).sort(), ["aud", "cls", "exp", "iat", "iss", "kid", "lvl", "nsfw", "pp", "scp", "sid", "sub", "ver"]);
  assert.equal(claims.iss, "patv-v1");
  assert.equal(claims.aud, "patv-rt");
  assert.equal(claims.sub, ANN);
  assert.equal(claims.sid, id.slice(0, 32));
  assert.equal(claims.exp, claims.iat + 300);
  assert.equal(j.exp, claims.exp);
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
  assert.equal(claims.cls, "staff");
  assert.equal(claims.ver, true, "a linked chat login is a proven identity");
  assert.equal(claims.lvl, 7);
  assert.equal(claims.nsfw, false);
  assert.deepEqual(claims.scp, ["chat"]);
  assert.equal(claims.pp, "web");
  assert.equal(claims.kid, "v1-2026-10");
  // the JWKS: current + previous; the ticket verifies with the current one only
  const jw = await fetch(base + "/.well-known/patv-jwks.json");
  assert.equal(jw.headers.get("cache-control"), "public, max-age=300");
  const set = await jw.json();
  assert.deepEqual(set.keys.map((k) => [k.kid, k.kty, k.crv, k.alg, k.use]), [["v1-2026-10", "OKP", "Ed25519", "EdDSA", "sig"], ["v1-2026-09", "OKP", "Ed25519", "EdDSA", "sig"]]);
  const parts = j.token.split(".");
  const pub = (kid) => crypto.createPublicKey({ key: set.keys.find((k) => k.kid === kid), format: "jwk" });
  assert.equal(crypto.verify(null, Buffer.from(parts[0] + "." + parts[1]), pub("v1-2026-10"), Buffer.from(parts[2], "base64url")), true);
  assert.equal(crypto.verify(null, Buffer.from(parts[0] + "." + parts[1]), pub("v1-2026-09"), Buffer.from(parts[2], "base64url")), false);
  assert.ok(!set.keys.some((k) => "d" in k), "never a private part");
  assert.ok(!printed.join("\n").includes(j.token), "the token is never logged");
  assert.equal(CT.status().minted_today, 1);
  assert.deepEqual(CT.kids(), ["v1-2026-10", "v1-2026-09"]);
});

test("a revoked session -> 401; an archived account -> 403", async () => {
  const { cookie, id } = await cookieFor(BOB);
  assert.equal((await ticket(cookie)).status, 200);
  await S.revoke(BOB, id, "signed out");
  assert.equal((await ticket(cookie)).status, 401, "the session is gone");
  const c2 = await cookieFor(BOB);
  await runQuery("UPDATE users SET archived_at = 1 WHERE userId = ?", [BOB]);
  const r = await ticket(c2.cookie);
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, "E_ARCHIVED");
  await runQuery("UPDATE users SET archived_at = NULL WHERE userId = ?", [BOB]);
});

test("rate limit: 20 a minute per session -> 429 with Retry-After", async () => {
  const { cookie } = await cookieFor(BOB);
  for (let i = 0; i < 20; i++) assert.equal((await ticket(cookie)).status, 200, "ticket " + (i + 1));
  const r = await ticket(cookie);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, "E_RATE");
  assert.ok(Number(r.headers.get("retry-after")) > 0);
});

test("a legacy (non-UUID) account id: E_LEGACY_ID, or uuidv5 in the genesis namespace when it is set", async () => {
  const { cookie } = await cookieFor(OLD);
  let r = await ticket(cookie);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "E_LEGACY_ID");
  process.env.CHAT_GENESIS_NS = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
  r = await ticket(cookie);
  assert.equal(r.status, 200);
  const [, claims] = decode((await r.json()).token);
  assert.equal(claims.sub, require("uuid").v5(OLD, process.env.CHAT_GENESIS_NS));
  delete process.env.CHAT_GENESIS_NS;
});

test("tools/chat-ticket-key.js: a new 0600 file, never stdout, never overwrite, no private key printed; --prev-from rotates", () => {
  const tool = path.join(repo, "tools", "chat-ticket-key.js");
  const run = (...args) => spawnSync(process.execPath, [tool, ...args], { cwd: dir, encoding: "utf8" });
  const f1 = path.join(dir, "k1.env"), f2 = path.join(dir, "k2.env");
  let r = run("--out", f1, "--kid", "v1stg-2026-10");
  assert.equal(r.status, 0, r.stderr);
  const env1 = require(tool).readEnvFile(f1);
  assert.deepEqual(Object.keys(env1), ["CHAT_TICKET_KEY", "CHAT_TICKET_KID"]);
  assert.equal(env1.CHAT_TICKET_KID, "v1stg-2026-10");
  assert.ok(!r.stdout.includes(env1.CHAT_TICKET_KEY) && /kid v1stg-2026-10 {2}x [A-Za-z0-9_-]{43}/.test(r.stdout), r.stdout);
  if (process.platform !== "win32") assert.equal(fs.statSync(f1).mode & 0o777, 0o600);
  assert.equal(run("--out", f1).status, 2, "refuses to overwrite");
  assert.equal(run("--out", "-").status, 2, "refuses stdout");
  assert.equal(run("--out", path.join(dir, "k3.env"), "--kid", "bad kid!").status, 2);
  r = run("--out", f2, "--kid", "v1stg-2026-11", "--prev-from", f1);
  assert.equal(r.status, 0, r.stderr);
  const env2 = require(tool).readEnvFile(f2);
  assert.deepEqual(Object.keys(env2), ["CHAT_TICKET_KEY", "CHAT_TICKET_KID", "CHAT_TICKET_PREV_PUB", "CHAT_TICKET_PREV_KID"]);
  assert.equal(env2.CHAT_TICKET_PREV_KID, "v1stg-2026-10");
  assert.ok(!r.stdout.includes(env2.CHAT_TICKET_KEY) && !r.stdout.includes(env1.CHAT_TICKET_KEY));
  // the site loads what the tool wrote: the JWKS lists both kids
  Object.assign(process.env, env2);
  CT._reload();
  assert.deepEqual(CT.jwks().keys.map((k) => k.kid), ["v1stg-2026-11", "v1stg-2026-10"]);
});
