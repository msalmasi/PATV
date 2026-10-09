// Offline tests for 1.99gd/ge: a graceful stop (shutdown.js). pm2 restarts the site with SIGINT; the open long-polls
// (Pepe's /api/pepe/help/pull + /api/pepe/imagesafety/pull) must be ANSWERED (no work), not cut - a cut one is an
// nginx 502 ("upstream prematurely closed connection") that staging Pepe's router read as "site down".
//   * stop(): a waiting help / imagesafety long-poll returns [] at once; a new one doesn't wait; servers stop
//     accepting; the exit hooks (the DB close) run after the grace period, then exit
//   * dbUtils no longer exits on its own SIGINT handler (it registers an exit hook instead)
//   NODE_PATH=G:/PATV/node_modules node --test test/shutdown.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shutdown-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const SHUTDOWN = require(path.join(repo, "shutdown"));
const HELP = require(path.join(repo, "help"));
const ISF = require(path.join(repo, "imagesafety"));

test("dbUtils closes the DB through shutdown.js, not its own exiting SIGINT handler", () => {
  const src = fs.readFileSync(path.join(repo, "dbUtils.js"), "utf8");
  assert.ok(!/process\.on\(\s*['"]SIGINT/.test(src), "no process.on('SIGINT') in dbUtils");
  assert.match(src, /require\('\.\/shutdown'\)\.onExit/);
});

test("stop(): open long-polls answer at once, new ones don't wait, servers close, exit after the grace period", async () => {
  let exited = null;
  SHUTDOWN._setExit((code) => { if (exited === null) exited = { code, at: Date.now() }; });
  const closed = [];
  SHUTDOWN.addServer({ close() { closed.push("s"); } });

  // the real /api/pepe/help/pull route (AI answers on), so the drained answer's retry hint is checked too
  await HELP.setConfig({ ai: true });
  const app = require("express")();
  HELP.register(app, { addUser: (req, res, next) => next(), isBotToken: (t) => t === "bot", clientIp: () => "10.0.0.1" });
  const srv = app.listen(0);
  const base = "http://127.0.0.1:" + srv.address().port;
  const pullRoute = () => fetch(base + "/api/pepe/help/pull", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot", wait: 8 }) }).then(async (r) => ({ status: r.status, json: await r.json() }));

  const t0 = Date.now();
  const routePoll = pullRoute();
  const helpPoll = HELP.pull(8000);
  const isfPoll = ISF.pull(8000);
  await new Promise((r) => setTimeout(r, 50));
  SHUTDOWN.stop("SIGINT");
  const [h, i] = await Promise.all([helpPoll, isfPoll]);
  assert.deepEqual(h, []);
  assert.deepEqual(i, []);
  assert.ok(Date.now() - t0 < 1000, "drained long-polls answer at once, not after the 8 s wait");
  assert.equal(SHUTDOWN.isDraining(), true);
  assert.deepEqual(closed, ["s"], "the servers stop accepting");
  const rp = await routePoll;
  assert.equal(rp.status, 200);
  assert.deepEqual(rp.json.jobs, []);
  assert.equal(rp.json.retry, true, "the drained route answer says: pull again in a few s");
  assert.equal(rp.json.idle, 5);
  const late = await pullRoute();
  assert.equal(late.status, 200);
  assert.equal(late.json.retry, true, "a pull while stopping gets the retry hint at once");
  srv.close();

  const t1 = Date.now();
  assert.deepEqual(await HELP.pull(8000), [], "a long-poll that arrives while stopping doesn't wait");
  assert.ok(Date.now() - t1 < 500);

  assert.equal(exited, null, "not gone before the grace period (the drained answers get written)");
  for (let n = 0; n < 40 && exited === null; n++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(exited, "exits once the exit hooks (DB close) are done");
  assert.equal(exited.code, 0);
});

test("a real long-poll over HTTP gets a 200 when the site stops mid-wait", async () => {
  SHUTDOWN._reset();
  let exited = false;
  SHUTDOWN._setExit(() => { exited = true; });
  const srv = http.createServer(async (req, res) => {
    const jobs = await HELP.pull(8000);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, enabled: true, jobs }));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  SHUTDOWN.addServer(srv);
  const { port } = srv.address();
  const got = new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/pepe/help/pull" }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on("error", reject);
    req.end("{}");
  });
  await new Promise((r) => setTimeout(r, 100));
  SHUTDOWN.stop("SIGINT");
  const r = await got;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, enabled: true, jobs: [] });
  for (let n = 0; n < 40 && !exited; n++) await new Promise((res) => setTimeout(res, 50));
  assert.ok(exited);
});
