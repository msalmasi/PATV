// 1.99cf: the site listens on loopback only (listen.js) and only believes proxy headers from loopback
// (middleware/authGuard.js clientAddr / clientIp, used by rate limits, the welcome-bonus dedupe and contentaudit).
//   NODE_PATH=G:/PATV/node_modules node --test test/bind-clientip.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const express = require("express");

const repo = path.resolve(__dirname, "..");
const guard = require(path.join(repo, "middleware", "authGuard"));
const { listen, bindHost } = require(path.join(repo, "listen"));

const fake = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, get: (h) => headers[String(h).toLowerCase()] });
const CF = { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 192.0.2.50" };

test("clientIp: proxy headers count only when the TCP peer is loopback (nginx on this box)", () => {
  for (const lo of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.53"]) {
    assert.deepEqual(guard.clientAddr(fake(lo, CF)), { ip: "203.0.113.9", via: "cf" }, lo);
  }
  // no CF header: the LAST X-Forwarded-For hop (what nginx appended), never the client-written first one
  assert.deepEqual(guard.clientAddr(fake("127.0.0.1", { "x-forwarded-for": "6.6.6.6, 192.0.2.50" })), { ip: "192.0.2.50", via: "xff" });
  assert.deepEqual(guard.clientAddr(fake("127.0.0.1", {})), { ip: "127.0.0.1", via: "direct" });
  // a direct caller can't pick its own IP
  for (const ext of ["192.0.2.77", "::ffff:192.0.2.77", "2001:db8::1", "10.0.0.5", "128.0.0.1"]) {
    assert.deepEqual(guard.clientAddr(fake(ext, CF)), { ip: ext, via: "direct" }, ext);
    assert.equal(guard.clientIp(fake(ext, CF)), ext);
  }
  assert.equal(guard.clientIp({ socket: {}, get: () => "1.2.3.4" }), "?", "no socket address: unknown, headers ignored");
  assert.equal(guard.isLoopback("::1"), true);
  assert.equal(guard.isLoopback("127.0.0.1.evil"), false);
});

test("contentaudit: via / country come from trusted headers only", () => {
  const audit = require(path.join(repo, "contentaudit"));
  const viaNginx = audit.fromRequest(fake("127.0.0.1", { ...CF, "cf-ipcountry": "NZ" }));
  assert.equal(viaNginx.ip, "203.0.113.9"); assert.equal(viaNginx.via, "cf"); assert.equal(viaNginx.country, "NZ");
  const direct = audit.fromRequest(fake("192.0.2.77", { ...CF, "cf-ipcountry": "NZ" }));
  assert.equal(direct.ip, "192.0.2.77"); assert.equal(direct.via, "direct"); assert.equal(direct.country, null);
});

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return null;
}
const tryGet = (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.status, (e) => "refused");

test("listen: 127.0.0.1 (+ [::1]) by default, not the other interfaces; BIND_HOST overrides", async () => {
  const saved = process.env.BIND_HOST;
  delete process.env.BIND_HOST;
  try {
    assert.equal(bindHost(), "127.0.0.1");
    const app = express();
    app.get("/healthz", (req, res) => res.json({ ok: true, peer: req.socket.remoteAddress }));
    const servers = await new Promise((ok) => { const s = listen(app, 0, "test", () => ok(s)); });
    await new Promise((r) => setTimeout(r, 100));       // the [::1] companion starts after the main one
    const port = servers[0].address().port;
    assert.equal(servers[0].address().address, "127.0.0.1");
    assert.equal(await tryGet(`http://127.0.0.1:${port}/healthz`), 200);
    if (servers[1] && servers[1].listening) assert.equal(await tryGet(`http://[::1]:${port}/healthz`), 200);
    const lan = lanAddress();
    if (lan) assert.equal(await tryGet(`http://${lan}:${port}/healthz`), "refused", "not reachable on " + "the LAN address");
    for (const s of servers) s.close();
    process.env.BIND_HOST = "0.0.0.0";
    assert.equal(bindHost(), "0.0.0.0");
    const s2 = await new Promise((ok) => { const s = listen(app, 0, "test", () => ok(s)); });
    assert.equal(s2.length, 1, "no [::1] companion when BIND_HOST is explicit");
    assert.equal(s2[0].address().address, "0.0.0.0");
    s2[0].close();
  } finally {
    if (saved === undefined) delete process.env.BIND_HOST; else process.env.BIND_HOST = saved;
  }
});

test("index.js and server.js listen through listen.js (no bare app.listen on all interfaces)", () => {
  const fs = require("fs");
  for (const f of ["index.js", "server.js"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    assert.match(src, /require\(["']\.\/listen["']\)\.listen\(app,/, f);
    assert.doesNotMatch(src, /^\s*app\.listen\(/m, f);
  }
});
